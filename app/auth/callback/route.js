// 매직링크·OAuth 복귀 지점 — 코드를 세션 쿠키로 교환하고 홈으로 보낸다.
import { NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';

export async function GET(req) {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const res = NextResponse.redirect(new URL('/', req.url));
  if (!code || !process.env.NEXT_PUBLIC_SUPABASE_URL) return res;
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
  await supabase.auth.exchangeCodeForSession(code).catch(() => {});
  return res;
}
