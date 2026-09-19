// D50(2026-09-19): 가린 동안 토큰 갱신이 네트워크 오류로 실패하면 supabase-js는 세션 없음으로 보고 요청을 익명 키로 보낸다.
// RLS 아래 익명 조회는 오류 없이 빈 결과라 채널 목록이 통째로 사라지고, 쓰기는 "row-level security" 원문으로 실패했다(로컬 스택 재현).
// 이 기기에 저장된 로그인이 있는데 익명 키로 나가려는 데이터 요청은 보내지 않고 알아볼 수 있는 오류로 멈춘다 — 로그아웃 상태(저장 없음)·
// 인증 요청(/auth/v1/)은 그대로 통과. 갱신이 되살아나면 같은 요청이 사용자 토큰으로 다시 나간다.
export const SESSION_REFRESHING = 'msgr_session_refreshing';
export function guardAnonFetch({ anonKey, hasStoredSession, fetchImpl = (...a) => fetch(...a) }) {
  return async (input, init = {}) => {
    const url = String(input?.url ?? input);
    const auth = new Headers(init.headers ?? input?.headers).get('authorization');
    if (anonKey && auth === `Bearer ${anonKey}` && !url.includes('/auth/v1/') && hasStoredSession()) throw new TypeError(SESSION_REFRESHING);
    return fetchImpl(input, init);
  };
}
