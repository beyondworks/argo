// Supabase 직결 — 메신저는 Argo Next 서버를 거치지 않는다(설계: 조직·채널·메시지는 클라우드 정본, RLS가 경계).
// 값은 .env.local(미커밋)의 VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY. 없으면 화면이 설정 안내를 그린다.
import { createClient } from '@supabase/supabase-js';

export const SB_URL = import.meta.env.VITE_SUPABASE_URL;
export const SB_ANON = import.meta.env.VITE_SUPABASE_ANON_KEY;
export const configured = !!(SB_URL && SB_ANON);
export const supabase = configured ? createClient(SB_URL, SB_ANON, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false } }) : null;

/** 오류를 던지는 얇은 래퍼 — 화면은 메시지만 보여 준다(값·토큰은 절대 안 싣는다). */
export async function q(p) { const { data, error } = await p; if (error) throw new Error(error.message); return data; }
