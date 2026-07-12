// 세션 게이트 — 인증 on(SUPABASE env 존재)일 때만 동작. off면 전부 통과(로컬 1인 모드).
// 역할: ① 세션 쿠키 갱신 ② 미로그인 차단(페이지 → /login, API → 401). 소유권은 라우트의 guardCompany가 맡는다.
import { NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';

const URL_ENV = process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY_ENV = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export async function middleware(req) {
  if (!URL_ENV || !KEY_ENV) return NextResponse.next();
  let res = NextResponse.next({ request: req });
  const supabase = createServerClient(URL_ENV, KEY_ENV, {
    cookies: {
      getAll: () => req.cookies.getAll(),
      setAll: (list) => { for (const { name, value, options } of list) res.cookies.set(name, value, options); },
    },
  });
  const { data: { user } } = await supabase.auth.getUser();
  const p = req.nextUrl.pathname;
  const isPublic = p === '/login' || p.startsWith('/auth');
  if (!user && !isPublic) {
    if (p.startsWith('/api')) return NextResponse.json({ error: '로그인이 필요합니다' }, { status: 401 });
    return NextResponse.redirect(new URL('/login', req.url));
  }
  if (user && p === '/login') return NextResponse.redirect(new URL('/', req.url));
  return res;
}

export const config = {
  // 정적 자산 제외 — 나머지 전부 게이트
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon.svg).*)'],
};
