// Supabase 연결 — 메신저와 같은 프로젝트·같은 계정(RLS가 경계). 첫 화면 무게를 지키려고 라이브러리는 필요할 때 불러온다.
// 주소·공개 키는 빌드 env(VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY) — 없으면 예시 데이터 모드로 돈다.
const URL_ = import.meta.env.VITE_SUPABASE_URL;
const ANON = import.meta.env.VITE_SUPABASE_ANON_KEY;
export const configured = !!(URL_ && ANON);
/** 로컬 개발 스택에서만 이메일·비밀번호 로그인을 연다(운영은 OAuth만 — 메신저와 같은 규칙) */
export const devPasswordLogin = configured && import.meta.env.DEV && /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(URL_);

let client = null;
export async function getClient() {
  if (!configured) return null;
  if (!client) {
    const { createClient } = await import('@supabase/supabase-js');
    client = createClient(URL_, ANON, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' } });
  }
  return client;
}

/** 오류를 보낼 목록 규칙으로 가른다 — 권한·형식 거절은 다시 해도 안 되므로 영구(transient=false), 나머지(네트워크 등)는 재시도 */
export function classify(error) {
  const code = String(error?.code ?? '');
  const conflict = /version_conflict/.test(error?.message ?? ''); // 다른 기기가 먼저 저장 — 다시 보내도 같다, 화면에서 사람이 고른다
  const permanent = conflict || code === '42501' || code.startsWith('22') || code.startsWith('23') || code === 'PGRST301' || /row-level security|permission denied/i.test(error?.message ?? '');
  return Object.assign(new Error(error?.message ?? 'request failed'), { transient: !permanent, code, conflict });
}
