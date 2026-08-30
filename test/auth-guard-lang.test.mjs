// 공통 가드(인증 계층) 오류 응답의 표시 언어 — #322 분리 검수 후속 L5.
// 잠그는 것: ① ko 문구는 기존 프로덕션 문자열 그대로(회귀 0) ② argo-lang=en 쿠키면 영어로 그린다
// ③ errorCode 동봉(#322 커넥터 재렌더와 같은 계약) ④ csrfDenied 통과·차단 행동(기존엔 라이브
// curl로만 검증되던 것을 순수 계층 추출로 노드에서 잠금) ⑤ tenantDenied 판정 스코프.
// auth.mjs 본체는 next/headers top-import라 여기서 못 연다(레포 관례) — 순수 계층(authmsg.mjs)을
// 행동으로 잠그고, guardCompany 쪽 배선(코드명 오타·갈래 누락)은 소스 배선 검사로 보조한다
// (connector-catalog ⑧과 같은 관례 — 라우트 실호출이 원리적으로 불가한 자리의 보조 잠금).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// tenantDenied·AUTH_ON은 모듈 로드 시 env를 읽는다 — 임포트 전에 세팅(테넌트 활성 + 인증 on 상태로 잠근다)
process.env.ARGO_TENANT_OWNER = 'tenant-uid-1';
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://fake.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'fake-anon-key';
const { authError, langFromCookieHeader, csrfDenied, tenantDenied, AUTH_ON } =
  await import('../app/authmsg.mjs');

// 기대표는 사전(MSG)과 독립적으로 여기 고정한다 — 사전을 되비추면 동어반복이라 게이트가 아니다.
// ko 문구는 변경 전 auth.mjs가 실제로 내리던 프로덕션 문자열(인접 행동 핀 — 바이트 동일해야 회귀 0).
// en도 리터럴로 고정한다(분리 검수 LOW: 성질 검사만으론 en 오염이 green).
const EXPECT = {
  auth_required: { status: 401, ko: '로그인이 필요합니다', en: 'Sign in to continue' },
  cross_origin: { status: 403, ko: '교차 출처 요청은 허용되지 않습니다', en: 'Cross-origin requests are not allowed' },
  tenant_only: { status: 403, ko: '이 서버는 다른 계정 전용입니다', en: 'This server is dedicated to another account' },
  company_not_found: { status: 404, ko: '회사를 찾을 수 없습니다', en: 'Company not found' },
  company_linked: { status: 403, ko: '이 회사는 계정에 연결되어 있습니다 — 로그인해 주세요', en: 'This company is linked to an account — please sign in' },
  company_forbidden: { status: 403, ko: '이 회사에 접근할 권한이 없습니다', en: 'You do not have access to this company' },
};

test('authError — ko 문구는 기존 프로덕션 문자열 그대로 + 상태코드 + errorCode 동봉', async () => {
  assert.equal(AUTH_ON, true, '전제: 인증 on 상태에서 잠근다');
  for (const [code, exp] of Object.entries(EXPECT)) {
    const res = authError(code, 'ko');
    assert.equal(res.status, exp.status, `${code} 상태코드`);
    const body = await res.json();
    assert.equal(body.error, exp.ko, `${code} ko 문구 회귀 0`);
    assert.equal(body.errorCode, code, `${code} errorCode 동봉`);
  }
});

test('authError — en 문구 리터럴 고정, 미지원 언어값은 ko 폴백', async () => {
  for (const [code, exp] of Object.entries(EXPECT)) {
    const body = await authError(code, 'en').json();
    assert.equal(body.error, exp.en, `${code} en 문구`);
    assert.ok(!/[가-힣]/.test(body.error), `${code} en에 한글 없음`);
    assert.equal(body.errorCode, code);
  }
  assert.equal((await authError('auth_required', 'de').json()).error, EXPECT.auth_required.ko, '미지원 값 = ko');
  assert.equal((await authError('auth_required', undefined).json()).error, EXPECT.auth_required.ko, '언어 미지정 = ko(기존 행동)');
});

test('authError — 미등록 코드는 조용한 오문구 대신 throw(오타 fail-loud, deny 경로라 fail-closed)', () => {
  assert.throws(() => authError('no_such_code', 'ko'));
});

test('langFromCookieHeader — argo-lang 쿠키만 정확히 읽는다', () => {
  assert.equal(langFromCookieHeader('argo-lang=en'), 'en');
  assert.equal(langFromCookieHeader('a=b; argo-lang=en; c=d'), 'en', '중간 위치');
  assert.equal(langFromCookieHeader('a=b;argo-lang=en'), 'en', '공백 없는 구분자');
  assert.equal(langFromCookieHeader('argo-guest=1; argo-lang=en'), 'en', '형제 argo-* 쿠키와 공존');
  assert.equal(langFromCookieHeader('argo-lang=ko'), 'ko');
  assert.equal(langFromCookieHeader(''), 'ko', '빈 헤더 = ko');
  assert.equal(langFromCookieHeader(null), 'ko', '무헤더 = ko');
  assert.equal(langFromCookieHeader('argo-lang=de'), 'ko', '미지원 값은 ko 폴백');
  assert.equal(langFromCookieHeader('xargo-lang=en'), 'ko', '이름 부분일치 오독 금지');
  // 다른 두 판독기(next/headers·미들웨어 req.cookies)와 의미 정렬 — 중복은 마지막 채택, 값 무트림
  assert.equal(langFromCookieHeader('argo-lang=ko; argo-lang=en'), 'en', '중복 쿠키 = 마지막 값');
  assert.equal(langFromCookieHeader('argo-lang=en; argo-lang=ko'), 'ko', '중복 쿠키 = 마지막 값(역방향)');
  assert.equal(langFromCookieHeader('argo-lang= en'), 'ko', '값 앞 공백 무트림(타 판독기와 동일)');
});

const fakeReq = (h = {}) => ({ headers: new Headers(h) });

test('csrfDenied — same-origin·none·헤더 부재는 통과(기존 행동 핀)', () => {
  assert.equal(csrfDenied(fakeReq({ 'sec-fetch-site': 'same-origin' })), null, '우리 페이지의 fetch');
  assert.equal(csrfDenied(fakeReq({ 'sec-fetch-site': 'none' })), null, '주소창·북마크');
  assert.equal(csrfDenied(fakeReq()), null, '비브라우저(curl)는 CSRF 대상 아님');
});

test('csrfDenied — cross-site·same-site는 403, 문구는 표시 언어 쿠키를 따른다', async () => {
  const ko = csrfDenied(fakeReq({ 'sec-fetch-site': 'cross-site' }));
  assert.equal(ko.status, 403);
  const koBody = await ko.json();
  assert.equal(koBody.error, EXPECT.cross_origin.ko, '무쿠키 = ko(기존 행동)');
  assert.equal(koBody.errorCode, 'cross_origin');
  assert.equal(csrfDenied(fakeReq({ 'sec-fetch-site': 'same-site' }))?.status, 403, '서브도메인도 차단(기존 행동 핀)');
  const enBody = await csrfDenied(fakeReq({ 'sec-fetch-site': 'cross-site', cookie: 'argo-lang=en' })).json();
  assert.ok(!/[가-힣]/.test(enBody.error), `en 쿠키 = 영어 문구: ${enBody.error}`);
  assert.equal(enBody.errorCode, 'cross_origin');
});

test('tenantDenied — 테넌트 불일치만 403, 언어 인자를 반영한다', async () => {
  assert.equal(tenantDenied(null), null, '무사용자 = 통과(로그인 가드는 각자 몫)');
  assert.equal(tenantDenied({ id: 'tenant-uid-1' }), null, '주인 계정 통과');
  const ko = tenantDenied({ id: 'intruder' });
  assert.equal(ko.status, 403);
  assert.equal((await ko.json()).error, EXPECT.tenant_only.ko, '언어 미지정 = ko(기존 소비자 계약 유지)');
  const enBody = await tenantDenied({ id: 'intruder' }, 'en').json();
  assert.ok(!/[가-힣]/.test(enBody.error), 'en 인자 = 영어 문구');
  assert.equal(enBody.errorCode, 'tenant_only');
});

test('배선 — app/·middleware의 authError 코드명이 사전에 실존 + guardCompany 네 갈래 코드가 실제로 쓰인다', async () => {
  const appDir = fileURLToPath(new URL('../app/', import.meta.url));
  const entries = await readdir(appDir, { recursive: true, withFileTypes: true });
  const files = entries.filter((e) => e.isFile() && /\.(mjs|js|jsx)$/.test(e.name))
    .map((e) => join(e.parentPath, e.name));
  // 미들웨어는 app/ 밖(레포 루트) — 라우트보다 먼저 401을 응답하는 주 노출면이라 반드시 포함
  // (실사고 이 작업 자체: app/만 훑어 middleware.js:78을 놓쳤다 — 격리 E2E가 잡음)
  files.push(fileURLToPath(new URL('../middleware.js', import.meta.url)));
  const known = Object.keys(EXPECT);
  const used = new Set();
  for (const f of files) {
    const src = await readFile(f, 'utf8');
    for (const m of src.matchAll(/authError\(\s*'([a-z_]+)'/g)) {
      assert.ok(known.includes(m[1]), `${f}: 미등록 코드 '${m[1]}' (오타 = deny 경로 500)`);
      used.add(m[1]);
    }
    // 언어 인자 없는 호출 금지 — 호출부 하나가 lang을 빠뜨리면 그 자리만 ko 고정(분리 검수 HIGH 변이 실증)
    const oneArg = src.match(/authError\(\s*'[a-z_]+'\s*\)/);
    assert.equal(oneArg, null, `${f}: 언어 인자 없는 authError 호출 ${oneArg?.[0] ?? ''}`);
    // 언어 인자 리터럴 금지 — `, 'ko')` 상수화도 그 자리만 영구 한국어 고정이다(후속 이관 분리 검수
    // MEDIUM-2: requestLang→langFromCookieHeader 교체 호출부가 한 인자 스캔 밖에 있었다. apiError
    // 호출부 형태 게이트와 같은 강도로 tenantDenied까지 함께 잠근다).
    const litLang = src.match(/authError\(\s*'[a-z_]+'\s*,\s*['"`]/);
    assert.equal(litLang, null, `${f}: 언어 인자가 리터럴인 authError 호출 ${litLang?.[0] ?? ''}`);
    const litTenant = src.match(/tenantDenied\([^)]*,\s*['"`]/);
    assert.equal(litTenant, null, `${f}: 언어 인자가 리터럴인 tenantDenied 호출 ${litTenant?.[0] ?? ''}`);
  }
  // guardCompany의 네 갈래가 전부 배선돼 있어야 한다 — 하나라도 빠지면 그 갈래는 미번역 잔존
  for (const code of ['auth_required', 'company_not_found', 'company_linked', 'company_forbidden']) {
    assert.ok(used.has(code), `가드 배선에 ${code} 없음`);
  }
});

// ── 언어 전달 경로 배선 잠금 — 분리 검수 HIGH: 사전만 잠그면 전달로(판독·미러) 변이가 전부 green.
// 라우트·미들웨어·프로바이더는 next 런타임이라 노드에서 실호출 불가 → 소스 배선으로 잠근다(레포 관례).
// 각 단언은 검수가 green을 실증한 변이 하나에 대응한다(requestLang 상수화·미들웨어 상수화·미러 삭제).
test('배선 — 언어 전달로: requestLang·미들웨어의 argo-lang 실판독 + i18n 쿠키 미러', async () => {
  const src = (rel) => readFile(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
  const auth = await src('../app/auth.mjs');
  assert.match(auth, /store\.get\('argo-lang'\)/, "requestLang이 argo-lang 쿠키를 읽지 않는다(상수화 변이)");
  const mw = await src('../middleware.js');
  assert.match(mw, /req\.cookies\.get\('argo-lang'\)/, '미들웨어 401이 argo-lang 쿠키를 읽지 않는다(상수화 변이)');
  const i18n = await src('../app/i18n.jsx');
  assert.match(i18n, /useEffect\(\(\)\s*=>\s*\{\s*mirrorLangCookie\(lang\);?\s*\},\s*\[lang\]\)/,
    'i18n Provider의 lang→쿠키 미러 이펙트가 없다(미러 삭제 변이 — 쿠키가 영영 안 생긴다)');
});

// 가드 계급 ko 문구가 사전 밖에서 재등장하면 red — 이번 작업에서 구현자가 middleware.js를 놓쳤던
// 실수의 재발 방지(하드코딩 401/403이 다시 생기면 en 사용자에게 한국어가 샌다).
test('배선 — 가드 ko 문구의 사전 밖 재등장 금지 (error: 리터럴)', async () => {
  const appDir = fileURLToPath(new URL('../app/', import.meta.url));
  const entries = await readdir(appDir, { recursive: true, withFileTypes: true });
  const files = entries.filter((e) => e.isFile() && /\.(mjs|js|jsx)$/.test(e.name))
    .map((e) => join(e.parentPath, e.name));
  files.push(fileURLToPath(new URL('../middleware.js', import.meta.url)));
  const banned = /error:\s*['"`](로그인이 필요합니다|교차 출처 요청은 허용되지 않습니다|이 서버는 다른 계정 전용입니다|회사를 찾을 수 없습니다|이 회사는 계정에 연결되어|이 회사에 접근할 권한이 없습니다)/;
  for (const f of files) {
    const m = (await readFile(f, 'utf8')).match(banned);
    assert.equal(m, null, `${f}: 가드 문구 하드코딩 재등장 — authError로 합류할 것: ${m?.[0] ?? ''}`);
  }
});
