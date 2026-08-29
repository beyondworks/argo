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
const EXPECT = {
  auth_required: { status: 401, ko: '로그인이 필요합니다' },
  cross_origin: { status: 403, ko: '교차 출처 요청은 허용되지 않습니다' },
  tenant_only: { status: 403, ko: '이 서버는 다른 계정 전용입니다' },
  company_not_found: { status: 404, ko: '회사를 찾을 수 없습니다' },
  company_linked: { status: 403, ko: '이 회사는 계정에 연결되어 있습니다 — 로그인해 주세요' },
  company_forbidden: { status: 403, ko: '이 회사에 접근할 권한이 없습니다' },
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

test('authError — en은 한글 없는 별도 문구로 그린다, 미지원 언어값은 ko 폴백', async () => {
  for (const [code, exp] of Object.entries(EXPECT)) {
    const body = await authError(code, 'en').json();
    assert.ok(body.error.length > 0, `${code} en 문구 존재`);
    assert.notEqual(body.error, exp.ko, `${code} en ≠ ko`);
    assert.ok(!/[가-힣]/.test(body.error), `${code} en에 한글 없음: ${body.error}`);
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
  }
  // guardCompany의 네 갈래가 전부 배선돼 있어야 한다 — 하나라도 빠지면 그 갈래는 미번역 잔존
  for (const code of ['auth_required', 'company_not_found', 'company_linked', 'company_forbidden']) {
    assert.ok(used.has(code), `가드 배선에 ${code} 없음`);
  }
});
