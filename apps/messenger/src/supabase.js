// Supabase 직결 — 메신저는 Argo Next 서버를 거치지 않는다(설계: 조직·채널·메시지는 클라우드 정본, RLS가 경계).
// 서버는 두 갈래(부록 L): 기본 = 빌드 env(VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY, Argo 클라우드) /
// 회사 서버 = 이 기기에 저장한 프로필(server-profile.mjs, 로그인 화면 "회사 서버")이 있으면 그것이 우선.
// 프로필을 바꾸면 클라이언트를 새로 만들어야 하므로 화면은 저장 뒤 새로고침한다.
import { createClient } from '@supabase/supabase-js';
import { readProfile } from './server-profile.mjs';

const profile = readProfile(typeof localStorage !== 'undefined' ? localStorage : null);
export const customServer = !!profile;
export const SB_URL = profile?.url ?? import.meta.env.VITE_SUPABASE_URL;
export const SB_ANON = profile?.anon ?? import.meta.env.VITE_SUPABASE_ANON_KEY;
export const configured = !!(SB_URL && SB_ANON);
export const supabase = configured ? createClient(SB_URL, SB_ANON, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false } }) : null;

/** 오류를 던지는 얇은 래퍼 — 화면은 메시지만 보여 준다(값·토큰은 절대 안 싣는다). */
export async function q(p) { const { data, error } = await p; if (error) throw new Error(error.message); return data; }
