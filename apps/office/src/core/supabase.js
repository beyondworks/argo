// Supabase 연결 — 메신저와 같은 프로젝트·같은 계정(RLS가 경계). 첫 화면 무게를 지키려고 라이브러리는 필요할 때 불러온다.
// 주소·공개 키는 빌드 env(VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY) — 없으면 예시 데이터 모드로 돈다.
import { isDesktop } from './platform.js';
import { localPasswordAllowed } from './desktop-auth-policy.js';
export const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const URL_ = supabaseUrl;
const ANON = import.meta.env.VITE_SUPABASE_ANON_KEY;
export const configured = !!(URL_ && ANON);
/** 로컬 개발 스택에서만 이메일·비밀번호 로그인을 연다(운영은 OAuth만 — 메신저와 같은 규칙) */
export const devPasswordLogin = localPasswordAllowed({ configured, dev: import.meta.env.DEV, review: import.meta.env.VITE_OFFICE_REVIEW, url: URL_ });

/** 서버에서 켜진 로그인 방식({ google: true, … }). 못 읽으면 null — 그때는 버튼을 다 보인다.
 *  꺼진 방식을 누르면 인증 서버의 오류 JSON 화면으로 떨어진다(9/27 실측: 로컬 스택은 이메일만 켜짐). */
export async function authProviders() {
  if (!configured) return null;
  try {
    const r = await fetch(`${URL_}/auth/v1/settings`, { headers: { apikey: ANON } });
    return r.ok ? ((await r.json()).external ?? null) : null;
  } catch { return null; }
}

let client = null;
export async function getClient() {
  if (!configured) return null;
  if (!client) {
    const { createClient } = await import('@supabase/supabase-js');
    client = createClient(URL_, ANON, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: !isDesktop(), flowType: 'pkce' } });
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
