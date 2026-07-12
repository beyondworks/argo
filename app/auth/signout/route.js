// 로그아웃 — 세션 쿠키 제거 후 로그인 화면으로.
import { NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';

export async function POST(req) {
  const res = NextResponse.redirect(new URL('/login', req.url), { status: 303 });
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL) return NextResponse.redirect(new URL('/', req.url), { status: 303 });
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
  await supabase.auth.signOut().catch(() => {});
  return res;
}
