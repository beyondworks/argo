// 인증 계층 — env가 있으면 켜지고, 없으면 로컬 1인 모드 그대로(회귀 0)라는 게이트가 원칙.
// 코어(src/*.mjs)는 인증을 모른다 — 요청 문맥(쿠키)이 필요한 이 계층은 라우트/미들웨어에서만 임포트한다.
// env: NEXT_PUBLIC_SUPABASE_URL · NEXT_PUBLIC_SUPABASE_ANON_KEY (.env.local 또는 배포 env — 값 평문 기록 금지)
import { readFile } from 'node:fs/promises';
import { writeJsonAtomic } from '../src/jsonstore.mjs';
import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';
import { paths } from '../src/workspace.mjs';
import { loadDeviceSession } from '../src/devicesession.mjs';
import { AUTH_ON, TENANT, authError, tenantDenied } from './authmsg.mjs';

// 요청 스코프가 필요 없는 판정·응답 조립(authError·CSRF·테넌트·표시 언어)은 authmsg.mjs로 내렸다 —
// next/headers 없는 순수 계층이라 node --test로 행동을 잠근다. 라우트의 임포트 표면은 그대로 유지.
export { AUTH_ON, authError, langFromCookieHeader, csrfDenied, tenantDenied } from './authmsg.mjs';

// 기기 세션 쓰기 경로 공통 게이트 — 미들웨어(middleware.js)의 LOCAL_HOST_RE와 동일 정규식이나
// 여긴 Node 런타임 라우트 전용(middleware.js는 edge 번들이라 fs 딸린 이 파일을 import하지 않는다 — 자체 정의 유지).
// X-Forwarded-Host는 신뢰하지 않는다(host 헤더만 검사) — 원격이 이 헤더를 위조해 루프백을 가장할 수 있어서다.
export const isLoopbackHost = (host) => /^(127\.0\.0\.1|localhost|\[::1\]|::1)(:\d+)?$/.test(host || '');

/** 요청의 표시 언어(argo-lang 쿠키 — i18n Provider가 localStorage 값을 미러). 가드 오류 문구를
    사용자 화면 언어로 내리기 위한 것. 쿠키 없음(구버전 클라이언트·curl·게이트웨이)·요청 스코프 밖은 ko. */
export async function requestLang() {
  try {
    const store = await cookies();
    return store.get('argo-lang')?.value === 'en' ? 'en' : 'ko';
  } catch { return 'ko'; }
}

/** 현재 로그인 사용자. 인증 off = 로컬 1인 모드('local'). 인증 on + 미로그인 = null.
    순서 계약(2026-08-06): **쿠키 세션 > 기기 세션 > 게스트.** 같은 순서를 쓰는 소비자:
    me/billing·me/billing/portal(accessToken)·feedback — 갈리면 인가와 토큰 조달이 다른 계정이
    된다(분리 검수 HIGH: 포털 링크 오발급). 이 순서가 실제로 갈리는 곳은 **비루프백 노출 구성**
    (ARGO_HOST=0.0.0.0 등)이다 — 쿠키 로그인 사용자 B가 기기 주인 A로 해석되던 것을 닫는다.
    루프백(데스크톱·상주)에서는 sb-* 세션 쿠키가 애초에 생성되지 않는다(auth/callback·confirm이
    기기 연동 모드에서 setAll 무동작 — 기기 파일이 단일 소유자). 그래서 로컬의 "다른 계정으로
    로그인" 증상 해소는 이 순서가 아니라 **로그인 시 기기 재바인딩**(callback의 saveDeviceSession
    덮어쓰기)의 결과다 — 이전 주인은 이 기기에서 로그아웃되며, 재바인딩 확인 관문은 별도 과제.
    데스크톱 앱 웹뷰는 sb-* 쿠키가 없어 기존처럼 기기 세션으로 떨어진다(회귀 0). */
export async function currentUser() {
  if (!AUTH_ON) return { id: 'local', email: '' };
  const store = await cookies();
  // sb-* 쿠키가 있을 때만 GoTrue 왕복 — 무쿠키 요청(데스크톱 다수)이 매번 ~160ms를 내지 않게
  // (미들웨어 지름길과 같은 근거 2026-07-24). 만료·무효 쿠키면 user null → 기기 세션 폴백.
  if (store.getAll().some((c) => c.name.startsWith('sb-'))) {
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      { cookies: { getAll: () => store.getAll(), setAll: () => { /* 라우트에서는 세션 갱신 안 함 — 미들웨어 담당 */ } } },
    );
    const { data: { user } } = await supabase.auth.getUser();
    if (user) return { id: user.id, email: user.email ?? '' };
  }
  // 기기 연동 모드 — 쿠키 세션이 없을 때 이 기기가 귀속된 계정(로그인=연동). 워커(TENANT)는 쿠키 경로 전용.
  if (!TENANT) {
    const dev = loadDeviceSession();
    if (dev) return { id: dev.user.id, email: dev.user.email };
  }
  // 게스트(로컬 전용) 폴백 — 실로그인(기기 세션·쿠키 세션)이 전부 없을 때만. 로컬 모드와 같은 신원.
  // 파일이 권한의 근거(gueststate), 쿠키는 미들웨어 UX 게이트일 뿐 — 기기 세션 모델과 같은 계약.
  if (!TENANT) {
    const { guestModeOn } = await import('../src/gueststate.mjs'); // 동적 — edge 번들 오염 방지 관례
    if (guestModeOn()) return { id: 'local', email: '' };
  }
  return null;
}

/** 회사 소유권 가드 — 위반 시 Response를 돌려준다(핸들러가 그대로 return). 통과 시 null.
    레거시 회사(ownerId 없음 — 로컬 시절 생성)는 아무에게나 귀속되지 않는다. 로컬→클라우드 이행을 위해
    ARGO_ADOPT_OWNER(이메일)와 현재 사용자 이메일이 일치할 때만 최초 소유자로 귀속한다 — 그 외엔 403. */
export async function guardCompany(wsId) {
  const user = await currentUser();
  const lang = await requestLang(); // 거부 문구는 사용자 화면 언어로 (test/auth-guard-lang.test.mjs)
  if (!user) return authError('auth_required', lang);
  if (!AUTH_ON) return null;
  const td = tenantDenied(user, lang); if (td) return td; // 테넌트 바인딩 — 소유권 검사보다 먼저
  let meta;
  try {
    meta = JSON.parse(await readFile(paths(wsId).company, 'utf8'));
  } catch {
    return authError('company_not_found', lang);
  }
  // 게스트(로컬 전용) — 주인 없는(로컬 생성) 회사만 접근. 계정 귀속 회사는 로그인해야 열린다.
  if (user.id === 'local') {
    return meta.ownerId ? authError('company_linked', lang) : null;
  }
  if (!meta.ownerId) {
    const adopt = process.env.ARGO_ADOPT_OWNER?.trim().toLowerCase();
    if (adopt && user.email && adopt === user.email.trim().toLowerCase()) {
      await writeJsonAtomic(paths(wsId).company, { ...meta, ownerId: user.id });
      return null;
    }
    return authError('company_forbidden', lang);
  }
  if (meta.ownerId !== user.id) {
    return authError('company_forbidden', lang);
  }
  return null;
}
