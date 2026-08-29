// 인증 계층의 순수 부분 — 가드 오류 응답(문구·상태·코드) 조립과 CSRF·테넌트 판정.
// auth.mjs가 next/headers를 top-import해 node --test에서 못 열리므로, 요청 스코프가 필요 없는
// 부분을 이 파일로 내려 행동을 테스트로 잠근다(runners-route·recent-turns와 같은 관례,
// test/auth-guard-lang.test.mjs). 라우트는 기존처럼 auth.mjs에서 임포트한다(재수출).
//
// 오류 문구는 표시 언어(ko|en)로 그려 내리고 errorCode를 함께 싣는다(#322 커넥터 카드와 같은
// 재렌더 계약). error 필드의 사람 문구는 유지 — 기존 소비자(프론트 setError·구버전 앱·로그)의
// 계약 그대로이고, 쿠키 없는 요청(구버전 클라이언트·curl·게이트웨이)은 오늘과 동일하게 ko를 받는다.

export const AUTH_ON = !!(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);

// code: { status, ko, en } — 가드가 내리는 사용자향 오류의 전부. 새 코드는 두 언어 모두 등록(다국어 상시 규칙).
const MSG = {
  auth_required: { status: 401, ko: '로그인이 필요합니다', en: 'Sign in to continue' },
  cross_origin: { status: 403, ko: '교차 출처 요청은 허용되지 않습니다', en: 'Cross-origin requests are not allowed' },
  tenant_only: { status: 403, ko: '이 서버는 다른 계정 전용입니다', en: 'This server is dedicated to another account' },
  company_not_found: { status: 404, ko: '회사를 찾을 수 없습니다', en: 'Company not found' },
  company_linked: { status: 403, ko: '이 회사는 계정에 연결되어 있습니다 — 로그인해 주세요', en: 'This company is linked to an account — please sign in' },
  company_forbidden: { status: 403, ko: '이 회사에 접근할 권한이 없습니다', en: 'You do not have access to this company' },
};

/** 가드 공통 오류 응답. lang은 ko|en(그 외 값·미지정은 ko). 미등록 코드는 throw —
    오타가 조용히 빈 문구로 새는 대신 fail-loud(deny 경로라 fail-closed, 배선 테스트가 선제로 잡는다). */
export function authError(code, lang) {
  const m = MSG[code];
  if (!m) throw new Error(`authError: 미등록 코드 ${code}`);
  return Response.json({ error: lang === 'en' ? m.en : m.ko, errorCode: code }, { status: m.status });
}

/** Cookie 헤더에서 표시 언어. 클라이언트(i18n Provider)가 localStorage의 argo-lang을 쿠키로
    미러한다 — localStorage는 요청에 실리지 않아 쿠키가 서버로 가는 유일한 전달로다(값은 ko|en뿐).
    판독 의미는 다른 두 판독기(auth.mjs requestLang의 next/headers·미들웨어 req.cookies)와 정렬:
    같은 이름 중복이면 마지막 값 채택, 값은 무트림 정확 일치(분리 검수 LOW — 판독기 간 갈림 봉합). */
export function langFromCookieHeader(header) {
  let last = null;
  for (const m of (header || '').matchAll(/(?:^|;\s*)argo-lang=([^;]*)/g)) last = m[1];
  return last === 'en' ? 'en' : 'ko';
}

// CSRF 가드 — 브라우저가 붙이는 Sec-Fetch-Site만 검사한다. 로컬 서버를 띄운 채 악성 웹페이지를 열면
// simple POST(preflight 없음)로 로컬 상태변경 라우트를 때릴 수 있는데, Host 검사는 그걸 못 막는다(브라우저가
// 실 타깃으로 Host를 채우므로 루프백 통과). 크로스사이트 요청엔 브라우저가 Sec-Fetch-Site: cross-site를 붙인다.
// same-origin(우리 페이지의 fetch)·none(주소창/북마크)만 허용. 헤더 부재(비브라우저·curl)는 CSRF 대상이 아니라 통과.
export function csrfDenied(req) {
  const sfs = req.headers.get('sec-fetch-site');
  if (sfs && sfs !== 'same-origin' && sfs !== 'none') {
    return authError('cross_origin', langFromCookieHeader(req.headers.get('cookie')));
  }
  return null;
}

// 테넌트 바인딩 — 클라우드 워커는 인스턴스 1대 = 계정 1개(microVM 격리 설계).
// ARGO_TENANT_OWNER(Supabase user id)가 설정되면 그 계정 외 요청을 전부 거부한다.
// 로컬/공용 모드(미설정)는 무영향. 인증 off면 의미 없으므로 함께 무시한다.
export const TENANT = process.env.ARGO_TENANT_OWNER?.trim() || null; // currentUser(auth.mjs)의 기기·게스트 폴백 게이트도 사용
export function tenantDenied(user, lang) {
  if (!TENANT || !AUTH_ON || !user) return null;
  if (user.id !== TENANT) return authError('tenant_only', lang);
  return null;
}
