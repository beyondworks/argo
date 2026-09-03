// 세션 게이트 — 인증 on(SUPABASE env 존재)일 때만 동작. off면 전부 통과(로컬 1인 모드).
// 역할: ① 세션 쿠키 갱신 ② 미로그인 차단(페이지 → /login, API → 401). 소유권은 라우트의 guardCompany가 맡는다.
import { NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { publicUrl } from './app/http-origin.mjs';
// authmsg.mjs는 next/headers·fs 무의존 순수 모듈이라 edge 번들에서도 안전(auth.mjs와 달리 임포트 가능).
// 401 문구·errorCode를 라우트 가드와 한 사전에서 그린다 — 여기가 라우트보다 먼저 응답하는 주 노출면
// (실측 2026-07-28: 미들웨어 401이 라우트 선행).
import { authError } from './app/authmsg.mjs';

const URL_ENV = process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY_ENV = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

const LOCAL_HOST_RE = /^(127\.0\.0\.1|localhost|\[::1\]|::1)(:\d+)?$/;
// 휴대폰 페어링(LAN 리스너 경유, 비루프백 Host) — 마커 쿠키는 UX 게이트, 토큰 검증은 라우트 currentUser
// (src/mobile-pairs.mjs mobileAccess)가 한다(기기·게스트 마커와 같은 계약). 페어링 진입점과 ping은 쿠키
// 이전 호출이라 공개. DNS 리바인딩 공격 오리진에는 이 쿠키가 실리지 않으므로 아래 421·401은 그대로 선다.
// 루프백 Host에서는 이 분기가 아예 돌지 않는다 — 데스크톱·상주 경로 불변.
// 마커는 토큰 원문(32바이트 hex)이라 형태가 고정이다 — 형태 밖 값은 마커로 치지 않는다(임의 문자열로 미들웨어 층을
// 통째로 비활성시키던 표면 제거, 분리 검수 M-2). 진위는 라우트가 파일 대조로 판정한다.
const MOBILE_PUBLIC = (p) => p === '/m/pair' || p === '/m/home' || p === '/api/mobile/pair' || p === '/api/ping';
const mobilePass = (req) => /^[0-9a-f]{64}$/.test(req.cookies.get('argo-mobile')?.value || '') || MOBILE_PUBLIC(req.nextUrl.pathname);

export async function middleware(req) {
  // 로컬 무인증 모드(Supabase env 없음)에서는 Host가 반드시 루프백이어야 한다 —
  // 원격 악성 사이트가 DNS 리바인딩으로 127.0.0.1을 자기 도메인에 붙여 로컬 API를 호출하는 것을 차단.
  // 클라우드(인증 on, 리버스 프록시 뒤)에는 적용하지 않는다.
  if (!URL_ENV || !KEY_ENV) {
    const host = req.headers.get('host') || '';
    if (!LOCAL_HOST_RE.test(host)) {
      if (mobilePass(req)) return NextResponse.next();
      return NextResponse.json({ error: 'invalid host' }, { status: 421 });
    }
    return NextResponse.next();
  }
  // 휴대폰 지름길(비루프백 한정·워커 제외) — 위 기기/게스트 지름길과 같은 계약. 세션 조회 없이 통과.
  if (!process.env.ARGO_TENANT_OWNER?.trim()
    && !LOCAL_HOST_RE.test(req.headers.get('host') || '')
    && mobilePass(req)) {
    return NextResponse.next();
  }
  // 기기/게스트 마커 지름길(루프백 한정) — 세션 조회(GoTrue 네트워크 왕복)보다 먼저 본다. 로컬 모드가
  // 요청마다 원격 인증에 의존하면 그 지연·장애가 전 화면 지연으로 번진다(실측 2026-07-24: 왕복 ~160ms).
  // 마커는 UX 게이트일 뿐 권한은 라우트(currentUser/guardCompany)가 검증한다는 기존 계약 그대로.
  // sb-* 세션 쿠키가 있으면 지름길을 타지 않는다 — 실세션의 갱신·/login 리다이렉트 의미를 아래 기존
  // 경로가 그대로 처리한다(아래 블록들은 만료 세션 폴백용으로 유지 — 중복이 아니라 회귀 0 보장).
  if (!process.env.ARGO_TENANT_OWNER?.trim()
    && LOCAL_HOST_RE.test(req.headers.get('host') || '')
    && !req.cookies.getAll().some((c) => c.name.startsWith('sb-'))) {
    // 기기 마커도 /login은 가로채지 않는다 — 홈으로 튕기면 "로그인 버튼이 안 눌린다"가 되고,
    // 다른 계정의 쿠키 세션이 영원히 성립 못 해 모든 화면이 기기 주인 신원으로 고정된다
    // (주인의 Pro 플랜이 남에게 보이던 실측 결함 2026-08-05~06). 실세션의 /login 홈 리다이렉트는
    // 아래 `if (user && p === '/login')`이 그대로 담당한다.
    if (req.cookies.get('argo-device')?.value === '1' && req.nextUrl.pathname !== '/login') {
      return NextResponse.next();
    }
    // 게스트는 /login을 지름길로 가로채지 않는다 — 나중 로그인(클레임 귀속) 경로 보존.
    if (req.cookies.get('argo-guest')?.value === '1' && req.nextUrl.pathname !== '/login') {
      return NextResponse.next();
    }
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
  // /api/billing/webhook — 호출 주체가 레몬스퀴지 서버(세션 없음). 인증은 라우트 자체의
  // HMAC 서명 검증(fail-closed)이 담당한다 — 미들웨어가 막으면 결제 이벤트가 영영 도달 못 한다
  // (상주 스모크 실측 2026-07-28: 미들웨어 401 '로그인이 필요합니다'가 라우트보다 먼저 응답).
  const isPublic = p === '/login' || p === '/legal' || ((p === '/m/pair' || p === '/m/home') && !process.env.ARGO_TENANT_OWNER?.trim()) || p === '/api/ping' || p === '/api/billing/webhook' || p.startsWith('/auth') || p.startsWith('/api/auth/pair') || p.startsWith('/api/device/');
  // 기기 연동 모드 — 마커 쿠키는 UX 게이트(리다이렉트 회피)일 뿐, 권한은 라우트 currentUser(기기 파일)가 검증.
  // 루프백 한정: 원격에서 마커만 들고 오는 요청은 통과시키지 않는다. 워커(TENANT)는 이 분기 없음.
  if (!process.env.ARGO_TENANT_OWNER?.trim() && req.cookies.get('argo-device')?.value === '1') {
    const host = req.headers.get('host') || '';
    // /login 미가로채기 — 위 지름길 블록과 같은 근거(계정 전환 경로 보존, 2026-08-06)
    // ⚠ 여기서 res가 아니라 next()를 반환하므로 이 경로는 세션 쿠키 갱신분을 버린다 — 루프백은
    // 세션 쿠키가 없어 무해하나, 기기 마커+세션 쿠키가 공존하는 구성이 생기면 그 세션은 액세스
    // 토큰 만료와 함께 죽는다(분리 검수 2026-08-06 지적 — 그때는 res 반환으로 바꿀 것).
    if (LOCAL_HOST_RE.test(host) && req.nextUrl.pathname !== '/login') {
      return NextResponse.next();
    }
  }
  // 게스트(로컬 전용) 마커 — 기기 마커와 같은 계약(쿠키=UX 게이트, 권한은 라우트의 currentUser/guardCompany).
  // 루프백 한정. /login은 게스트도 접근 가능해야 한다(나중 로그인 → 클레임 경로) — 리다이렉트 없음.
  const isGuest = !process.env.ARGO_TENANT_OWNER?.trim()
    && req.cookies.get('argo-guest')?.value === '1'
    && LOCAL_HOST_RE.test(req.headers.get('host') || '');
  if (!user && !isPublic && !isGuest) {
    if (p.startsWith('/api')) return authError('auth_required', req.cookies.get('argo-lang')?.value === 'en' ? 'en' : 'ko');
    return NextResponse.redirect(publicUrl(req, '/login'));
  }
  if (user && p === '/login') return NextResponse.redirect(publicUrl(req, '/'));
  return res;
}

export const config = {
  // 정적 자산 제외 — 나머지 전부 게이트.
  // fonts/ — 자체 호스팅 폰트(public/fonts). 게이트에 걸리면 /login 자체가 폰트 없이 뜬다
  // (307 → HTML 본문이라 OTS 파싱 실패, 검수 실측 2026-07-26). 공개 정적 자산이라 제외해도 무해.
  matcher: ['/((?!_next/static|_next/image|fonts/|favicon.ico|icon.svg).*)'],
};
