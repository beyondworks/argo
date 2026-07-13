// 매직링크·OAuth 복귀 지점 — 코드를 세션 쿠키로 교환하고 홈으로 보낸다.
import { NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { publicUrl } from '../../http-origin.mjs';

export async function GET(req) {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const providerErr = url.searchParams.get('error_description') || url.searchParams.get('error');
  const fail = (msg) => NextResponse.redirect(publicUrl(req, `/login?error=${encodeURIComponent(String(msg).slice(0, 120))}`));
  // 실패를 조용히 삼키지 않는다 — /login?error= 로 보내 화면에 노출(진단 가능하게)
  if (providerErr) return fail(providerErr);
  if (!code || !process.env.NEXT_PUBLIC_SUPABASE_URL) return fail('no_code');
  const res = NextResponse.redirect(publicUrl(req, '/'));
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll: () => req.cookies.getAll(),
        setAll: (list) => { for (const { name, value, options } of list) res.cookies.set(name, value, options); },
      },
    },
  );
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) return fail(error.message);
  return res;
}
