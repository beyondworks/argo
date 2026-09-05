// 가짜 계정 키 확보 — 회사 데이터 전체 봉투(v2)가 기본 켜짐(2026-09-06)이라, EXCLUDE·sync가 도는 테스트는
// 실환경처럼 계정 키가 있어야 한다(미확보 = 암호화 대상 전체가 그 사이클 불가시 보류). accountkey.mjs 캐시에만 넣는다.
import { ensureAccountKey, clearAccountKey } from '../../src/accountkey.mjs';

export const fakeKeySb = (b64) => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { key_b64: b64 }, error: null }) }) }) }) });

/** 키를 캐시에 넣고, 되돌리는 함수를 돌려준다(test.after에서 호출). */
export async function useFakeAccountKey(seed = 7, owner = 'owner-test') {
  clearAccountKey();
  await ensureAccountKey(fakeKeySb(Buffer.alloc(32, seed).toString('base64')), owner);
  return clearAccountKey;
}
