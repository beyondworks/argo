// 동기화 자격의 단일 출처 — env(자가 호스팅) 우선, 없으면 페어링으로 받은 파일.
// 파일은 WS_ROOT/.sync-credentials.json — 회사 폴더 밖(동기화 엔진이 회사 디렉토리만 걷으므로
// 클라우드로 복제되지 않는 기기 로컬 상태)이고, 서비스 키를 담으므로 0600으로 잠근다.
// epoch: 저장 시 증가 — sync.mjs 클라이언트·secretbox 파생 키가 캐시를 재구축하는 신호.
//
// 저장은 원자적 — 같은 디렉토리에 .tmp- 접두사 임시 파일을 mode 0600으로 생성 시점부터 잠그고
// rename으로 교체한다(rename은 임시 파일의 모드를 보존 → 사후 chmod 불필요). writeFile 후
// 별도 chmod를 하면 두 호출 사이에 서비스 키 파일이 기본 모드(0644)로 노출되는 창이 생기고,
// 중간에 크래시하면 잘린 JSON이 남는다 — 둘 다 이 방식으로 막는다.
import { readFileSync } from 'node:fs';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { WS_ROOT } from './workspace.mjs';

const FILE = '.sync-credentials.json';
let cache = null; // { root, creds }
let epoch = 0;
let tmpSeq = 0; // Math.random 금지 — pid+시각+카운터로 동일 프로세스 내 tmp 충돌만 피하면 충분

export const credsEpoch = () => epoch;

/** {url, key, owner}|null. env가 파일보다 항상 우선(기존 자가 호스팅 동작 불변). */
export function loadSyncCreds({ root = WS_ROOT, env = process.env } = {}) {
  if (env.NEXT_PUBLIC_SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
    return { url: env.NEXT_PUBLIC_SUPABASE_URL, key: env.SUPABASE_SERVICE_ROLE_KEY, owner: env.ARGO_SYNC_OWNER || null };
  }
  if (cache && cache.root === root) return cache.creds;
  const f = join(root, FILE);
  let creds = null;
  let raw = null;
  try {
    raw = readFileSync(f, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn(`[synccreds] 자격 파일 읽기 실패: ${f}`);
  }
  if (raw != null) {
    try {
      const { url, key, owner } = JSON.parse(raw);
      if (url && key) creds = { url, key, owner: owner || null };
    } catch {
      // 파일은 있는데 손상 — 조용히 삼키지 않는다(시크릿 값은 절대 로그하지 않음)
      console.warn(`[synccreds] 자격 파일 파싱 실패(손상): ${f}`);
    }
  }
  cache = { root, creds };
  return creds;
}

/** 페어링 수신 자격 저장 — tmp 파일을 생성 시점부터 0600으로 쓰고 rename으로 원자 교체 + 캐시 무효화. */
export async function saveSyncCreds({ url, key, owner }, { root = WS_ROOT } = {}) {
  if (!url || !key || !owner) throw new Error('저장할 자격 누락 (url/key/owner)');
  await mkdir(root, { recursive: true });
  const f = join(root, FILE);
  const tmp = join(root, `.tmp-${FILE}-${process.pid}-${Date.now().toString(36)}-${tmpSeq++}`);
  await writeFile(tmp, JSON.stringify({ url, key, owner }, null, 2), { mode: 0o600 });
  await rename(tmp, f);
  cache = null;
  epoch++;
}
