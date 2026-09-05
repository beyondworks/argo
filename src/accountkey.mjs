// 계정 키 — 크레덴셜 봉투(v2)의 계정별 루트 키. account_keys 테이블에서 get-or-create.
// 호출자는 sync 사이클: 자신의 supabase 클라이언트(서비스 롤 or 세션 JWT+RLS)를 주입한다.
// secretbox는 동기 함수라 여기 캐시를 읽는다 — 키 확보 전에는 cryptoOn()이 false로 떨어져
// 크레덴셜만 동기화에서 빠지고(기존 EXCLUDE 경로), 다음 사이클에 자연 회복된다.
import { randomBytes } from 'node:crypto';

let cached = null;   // Buffer | null
let cachedOwner = '';
let lastError = '';  // 마지막 확보 실패 사유(표면화용 — #436 검수 HIGH-2: 키 없으면 push·pull이 전부 멈추는데 신호가 없었다)
/** 마지막 계정 키 확보 실패 사유('' = 정상). sync 상태 카드가 싣는다. */
export const accountKeyError = () => lastError;

/** 동기 캐시 접근 — secretbox 전용. */
export const accountKey = () => cached;

export function clearAccountKey() {
  cached = null;
  cachedOwner = '';
}

async function fetchKey(sb, ownerId) {
  const { data, error } = await sb.from('account_keys').select('key_b64').eq('user_id', ownerId).maybeSingle();
  if (error) throw new Error(`계정 키 조회 실패: ${error.message}`);
  return data?.key_b64 ?? null;
}

/** get-or-create + 캐시. 실패는 throw하지 않고 null(호출자는 warn 후 진행 — 크레덴셜만 이번 사이클 제외). */
export async function ensureAccountKey(sb, ownerId) {
  if (!ownerId) { return null; }
  if (cached && cachedOwner === ownerId) return cached;
  try {
    let b64 = await fetchKey(sb, ownerId);
    if (!b64) {
      const fresh = randomBytes(32).toString('base64');
      const { error } = await sb.from('account_keys').insert({ user_id: ownerId, key_b64: fresh });
      if (!error) b64 = fresh;
      else if (error.code === '23505') b64 = await fetchKey(sb, ownerId); // 경합 — 승자 키 채택
      else throw new Error(`계정 키 생성 실패: ${error.message}`);
    }
    if (!b64) { lastError = '계정 키 경합 재조회도 비어 있음'; console.warn('[argo] 계정 키 경합 재조회도 비어 있음 — 다음 사이클 재시도'); return null; }
    cached = Buffer.from(b64, 'base64');
    cachedOwner = ownerId; lastError = '';
    return cached;
  } catch (e) {
    lastError = String(e?.message ?? e).slice(0, 160);
    console.warn('[argo] 계정 키 확보 실패 — 이번 사이클 암호화 대상(기본: 회사 데이터 전체) 동기화 보류:', e.message);
    return null;
  }
}
