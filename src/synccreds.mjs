// 동기화 자격의 단일 출처 — env(자가 호스팅) 우선, 없으면 페어링으로 받은 파일.
// 파일은 WS_ROOT/.sync-credentials.json — 회사 폴더 밖(동기화 엔진이 회사 디렉토리만 걷으므로
// 클라우드로 복제되지 않는 기기 로컬 상태)이고, 서비스 키를 담으므로 0600으로 잠근다.
// epoch: 저장 시 증가 — sync.mjs 클라이언트·secretbox 파생 키가 캐시를 재구축하는 신호.
import { readFileSync } from 'node:fs';
import { mkdir, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { WS_ROOT } from './workspace.mjs';

const FILE = '.sync-credentials.json';
let cache = null; // { root, creds }
let epoch = 0;

export const credsEpoch = () => epoch;

/** {url, key, owner}|null. env가 파일보다 항상 우선(기존 자가 호스팅 동작 불변). */
export function loadSyncCreds({ root = WS_ROOT, env = process.env } = {}) {
  if (env.NEXT_PUBLIC_SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
    return { url: env.NEXT_PUBLIC_SUPABASE_URL, key: env.SUPABASE_SERVICE_ROLE_KEY, owner: env.ARGO_SYNC_OWNER || null };
  }
  if (cache && cache.root === root) return cache.creds;
  let creds = null;
  try {
    const { url, key, owner } = JSON.parse(readFileSync(join(root, FILE), 'utf8'));
    if (url && key) creds = { url, key, owner: owner || null };
  } catch { /* 파일 없음/손상 → 자격 없음 */ }
  cache = { root, creds };
  return creds;
}

/** 페어링 수신 자격 저장(0600) + 캐시 무효화. */
export async function saveSyncCreds({ url, key, owner }, { root = WS_ROOT } = {}) {
  if (!url || !key || !owner) throw new Error('저장할 자격 누락 (url/key/owner)');
  await mkdir(root, { recursive: true });
  const f = join(root, FILE);
  await writeFile(f, JSON.stringify({ url, key, owner }, null, 2));
  await chmod(f, 0o600);
  cache = null;
  epoch++;
}
