// 세션 게이트 — 인증 on(SUPABASE env 존재)일 때만 동작. off면 전부 통과(로컬 1인 모드).
// 역할: ① 세션 쿠키 갱신 ② 미로그인 차단(페이지 → /login, API → 401). 소유권은 라우트의 guardCompany가 맡는다.
import { NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { publicUrl } from './app/http-origin.mjs';

const URL_ENV = process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY_ENV = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

const LOCAL_HOST_RE = /^(127\.0\.0\.1|localhost|\[::1\]|::1)(:\d+)?$/;

export async function middleware(req) {
  // 로컬 무인증 모드(Supabase env 없음)에서는 Host가 반드시 루프백이어야 한다 —
  // 원격 악성 사이트가 DNS 리바인딩으로 127.0.0.1을 자기 도메인에 붙여 로컬 API를 호출하는 것을 차단.
  // 클라우드(인증 on, 리버스 프록시 뒤)에는 적용하지 않는다.
  if (!URL_ENV || !KEY_ENV) {
    const host = req.headers.get('host') || '';
    if (!LOCAL_HOST_RE.test(host)) {
      return NextResponse.json({ error: 'invalid host' }, { status: 421 });
    }
    return NextResponse.next();
  }
  let res = NextResponse.next({ request: req });
  const supabase = createServerClient(URL_ENV, KEY_ENV, {
    cookies: {
      getAll: () => req.cookies.getAll(),
      setAll: (list) => { for (const { name, value, options } of list) res.cookies.set(name, value, options); },
    },
  });
  const { data: { user } } = await supabase.auth.getUser();
  const p = req.nextUrl.pathname;
  // /api/auth/pair* — 앱 로그인 브리지는 세션 이전에 호출되므로 공개(코드 단명·1회 소비로 보호)
  // /api/device/* — 기기 로그인/링크 자체가 세션을 만드는 진입점이라 공개(라우트 내부에서 검증)
  // /api/ping — 데스크톱 셸·부트 페이지의 신원 마커(비밀 없음). 세션 이전(부팅 중) 호출이라 공개 필수 —
  //   게이트에 걸리면 auth-on 출하 빌드에서 401 → 부트가 영원히 대기(검수 CRITICAL 2026-07-20).
  const isPublic = p === '/login' || p === '/legal' || p === '/api/ping' || p.startsWith('/auth') || p.startsWith('/api/auth/pair') || p.startsWith('/api/device/');
  // 기기 연동 모드 — 마커 쿠키는 UX 게이트(리다이렉트 회피)일 뿐, 권한은 라우트 currentUser(기기 파일)가 검증.
  // 루프백 한정: 원격에서 마커만 들고 오는 요청은 통과시키지 않는다. 워커(TENANT)는 이 분기 없음.
  if (!process.env.ARGO_TENANT_OWNER?.trim() && req.cookies.get('argo-device')?.value === '1') {
    const host = req.headers.get('host') || '';
    if (LOCAL_HOST_RE.test(host)) {
      if (req.nextUrl.pathname === '/login') return NextResponse.redirect(publicUrl(req, '/'));
      return NextResponse.next();
    }
  }
  if (!user && !isPublic) {
    if (p.startsWith('/api')) return NextResponse.json({ error: '로그인이 필요합니다' }, { status: 401 });
    return NextResponse.redirect(publicUrl(req, '/login'));
  }
  if (user && p === '/login') return NextResponse.redirect(publicUrl(req, '/'));
  return res;
}

export const config = {
  // 정적 자산 제외 — 나머지 전부 게이트
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon.svg).*)'],
};
