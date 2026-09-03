// 기능 라우트 오류 문구 표시 언어 — 공통 가드(#333 L5)의 기능 라우트 확장 후속.
// 잠그는 것:
//  ① apiError — ko 문구는 v0.1.52 출하 프로덕션 문자열 그대로(바이트 동일 = 회귀 0), en은 리터럴
//     고정 + 무한글, errorCode·status 동봉, 미등록 코드는 fail-loud(throw).
//  ② recover 오입력 판별 — openDekWithKek의 코드 오입력 throw가 E2EE_BAD_CODE 코드를 실어,
//     라우트가 문자열 매칭 없이 표시 언어로 다시 그린다(행동 — 옳은 코드는 여전히 열린다).
//  ③ e2ee 라우트 배선(소스) — apiError 코드 실존·전 코드 사용·언어 인자 필수·쿠키 실판독.
//     라우트 실호출은 currentUser의 cookies()가 요청 스코프 밖에서 throw라 불가(connector-catalog
//     프로브 실측 관례) — 소스 배선으로 잠근다.
//  ④ 이관 ko 문구의 사전 밖 재등장 금지 — app/ 전체 error: 리터럴 트립와이어(auth-guard-lang 관례).
//  ⑤ companies GET 실호출 — 프리셋 표시 언어 = ?lang 1순위 · argo-lang 쿠키 폴백 · 무단서 ko.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-apimsg-')); // 워크스페이스 임포트보다 먼저
// AUTH off — companies GET 실호출(⑤)이 가드를 지나 프리셋 본문을 관측하기 위해(마켓 라우트 관례).
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

const { API_MSG, apiError } = await import('../app/apimsg.mjs');
const { generateRecoveryCode, deriveRecoveryKek, wrapDekWithKek, openDekWithKek } = await import('../src/e2ee.mjs');

// ── ① apiError 행동 ──────────────────────────────────────────────────────────
// 기대표는 사전(API_MSG)과 독립적으로 고정한다 — 사전을 되비추면 동어반복이라 게이트가 아니다.
// ko는 변경 전 라우트가 실제로 내리던 v0.1.52 프로덕션 문자열(인접 행동 핀 — 바이트 동일해야 회귀 0).
const EXPECT = {
  e2ee_session_required: { status: 401, ko: '기기 연동 세션이 필요합니다 — Argo 앱에서 로그인해 주세요', en: 'A linked device session is required — sign in from the Argo app' },
  e2ee_already_on_this: { status: 400, ko: '이미 이 기기에서 켜져 있습니다', en: 'Already enabled on this device' },
  e2ee_already_on_other: { status: 409, ko: '이미 다른 기기에서 켜져 있습니다 — 그 기기에서 이 기기를 승인해 주세요', en: 'Already enabled on another device — approve this device from that device' },
  e2ee_plan_required: { status: 403, ko: '종단간 암호화는 동기화가 도는 상태(Pro·체험)에서 켤 수 있습니다', en: 'End-to-end encryption can be turned on while sync is active (Pro or trial)' },
  e2ee_no_key_here: { status: 400, ko: '이 기기에 열쇠가 없습니다 — 열쇠 보유 기기에서 승인해 주세요', en: 'This device holds no key — approve from a device that has the key' },
  e2ee_approve_target_required: { status: 400, ko: '승인할 기기를 지정해 주세요', en: 'Specify a device to approve' },
  e2ee_target_pubkey_missing: { status: 404, ko: '대상 기기의 공개키가 없습니다(앱 업데이트·로그인 확인)', en: 'The target device has no public key (check for app updates and sign-in)' },
  e2ee_retry_later: { status: 429, ko: '잠시 후 다시 시도해 주세요', en: 'Please try again shortly' },
  e2ee_already_has_key: { status: 400, ko: '이미 이 기기에 열쇠가 있습니다', en: 'This device already has the key' },
  e2ee_no_recovery: { status: 404, ko: '복구 코드가 설정돼 있지 않습니다', en: 'No recovery code is set up' },
  e2ee_bad_recovery_code: { status: 400, ko: '복구 코드가 맞지 않습니다', en: 'The recovery code is incorrect' },
  e2ee_revoke_target_required: { status: 400, ko: '제거할 기기를 지정해 주세요', en: 'Specify a device to remove' },
  e2ee_revoke_self: { status: 400, ko: '이 기기 자신은 제거할 수 없습니다', en: 'This device cannot remove itself' },
  e2ee_unknown_action: { status: 400, ko: '알 수 없는 action', en: 'Unknown action' },
  // 회의실 게이트(#395) — 세 라우트(새 회의·전환·마치기)가 같은 코드로 응답. 문구는 #393 DELETE 핀(/진행 중|still speaking/)을 잇는다
  room_busy: { status: 409, ko: '발언이 진행 중입니다 — 끝난 뒤 다시 시도해 주세요.', en: 'A crew is still speaking — try again after it finishes.' },
};

test('apiError — ko 문구는 기존 프로덕션 문자열 그대로 + 상태코드 + errorCode 동봉', async () => {
  assert.deepEqual(Object.keys(API_MSG).sort(), Object.keys(EXPECT).sort(), '사전 코드 집합 = 기대표(누락·잉여 즉시 노출)');
  for (const [code, exp] of Object.entries(EXPECT)) {
    const res = apiError(code, 'ko');
    assert.equal(res.status, exp.status, `${code} 상태코드`);
    const body = await res.json();
    assert.equal(body.error, exp.ko, `${code} ko 문구 회귀 0`);
    assert.equal(body.errorCode, code, `${code} errorCode 동봉`);
  }
});

test('apiError — en 문구 리터럴 고정, 미지원 언어값·미지정은 ko 폴백', async () => {
  for (const [code, exp] of Object.entries(EXPECT)) {
    const body = await apiError(code, 'en').json();
    assert.equal(body.error, exp.en, `${code} en 문구`);
    assert.ok(!/[가-힣]/.test(body.error), `${code} en에 한글 없음`);
    assert.equal(body.errorCode, code);
  }
  assert.equal((await apiError('e2ee_retry_later', 'de').json()).error, EXPECT.e2ee_retry_later.ko, '미지원 값 = ko');
  assert.equal((await apiError('e2ee_retry_later', undefined).json()).error, EXPECT.e2ee_retry_later.ko, '언어 미지정 = ko(기존 행동)');
});

test('apiError — 미등록 코드는 조용한 오문구 대신 throw(오타 fail-loud)', () => {
  assert.throws(() => apiError('no_such_code', 'ko'));
});

// ── ② recover 오입력 판별(행동) ──────────────────────────────────────────────
test('openDekWithKek — 코드 오입력은 E2EE_BAD_CODE 코드를 싣고, 옳은 코드는 여전히 열린다', async () => {
  const code = generateRecoveryCode();
  const salt = randomBytes(16).toString('base64');
  const kek = deriveRecoveryKek(code, salt);
  const dek = randomBytes(32);
  const wrap = wrapDekWithKek(kek, dek);
  assert.deepEqual(openDekWithKek(kek, wrap), dek, '인접 핀 — 옳은 코드 개봉은 그대로 동작');
  const wrongKek = deriveRecoveryKek(generateRecoveryCode(), salt); // 다른 코드 = 오입력
  try {
    openDekWithKek(wrongKek, wrap);
    assert.fail('오입력이 열리면 안 된다');
  } catch (e) {
    assert.equal(e.code, 'E2EE_BAD_CODE', '라우트가 문자열 매칭 없이 판별할 기계 코드');
    assert.equal(e.message, '복구 코드가 맞지 않습니다', 'ko 원문 유지(코드 없는 소비자 회귀 0)');
  }
});

// ── ③ e2ee 라우트 배선(소스 — 실호출 불가 자리의 보조 잠금) ──────────────────
test('배선 — e2ee 라우트: apiError 코드 실존·전 코드 사용·언어 인자 필수·쿠키 실판독·오입력 판별', async () => {
  const src = await readFile(new URL('../app/api/me/e2ee/route.js', import.meta.url), 'utf8');
  const used = new Set();
  // 호출부 전 형태 강제 — 인자 누락뿐 아니라 상수화(`, 'ko')`)도 그 갈래만 영구 한국어 고정이다
  // (분리 검수 MEDIUM-1 변이 실증: 상수화가 한 인자 금지 스캔을 그대로 통과했다. 호출부 단위
  // 게이트 교훈의 재적중 — 게이트는 함수가 아니라 호출부 형태로 잠근다).
  const calls = [...src.matchAll(/apiError\([^)]*\)/g)];
  assert.ok(calls.length > 0, 'apiError 호출이 하나도 없다 — 전환 자체가 풀린 것');
  for (const m of calls) {
    const shape = m[0].match(/^apiError\('([a-z0-9_]+)', lang\)$/);
    assert.ok(shape, `호출 형태 위반(코드 리터럴 + lang 변수만 허용): ${m[0]}`);
    assert.ok(shape[1] in API_MSG, `미등록 코드 '${shape[1]}' (오타 = 해당 갈래 500)`);
    used.add(shape[1]);
  }
  // e2ee_ 접두 코드만 이 라우트의 책임 — 다른 기능 라우트의 코드(room_busy 등)는 각자 테스트가 배선을 잠근다
  for (const code of Object.keys(API_MSG).filter((c) => c.startsWith('e2ee_'))) {
    assert.ok(used.has(code), `사전의 ${code}가 라우트에 배선되지 않음 — 그 갈래는 미번역 잔존`);
  }
  assert.match(src, /langFromCookieHeader\(req\.headers\.get\('cookie'\)\)/, 'argo-lang 쿠키를 읽지 않는다(상수화 변이)');
  assert.match(src, /e2\?\.code === 'E2EE_BAD_CODE'/, 'recover 오입력을 코드로 판별하지 않는다(문자열 매칭·원문 통과 변이)');
});

// ── ④ 이관 ko 문구의 사전 밖 재등장 금지 — auth-guard-lang 트립와이어와 같은 관례 ──
test('배선 — 이관 e2ee ko 문구가 error: 리터럴로 재등장하면 red', async () => {
  const appDir = fileURLToPath(new URL('../app/', import.meta.url));
  const entries = await readdir(appDir, { recursive: true, withFileTypes: true });
  const files = entries.filter((e) => e.isFile() && /\.(mjs|js|jsx)$/.test(e.name))
    .map((e) => join(e.parentPath, e.name));
  // 프리픽스 앵커(error: 직후 시작) — apimsg.mjs의 ko: 정의부와 타 문구의 부분 포함(예: feedback의
  // '저장에 실패했습니다. 잠시 후…')은 걸리지 않는다.
  const banned = new RegExp(`error:\\s*['"\`](${[
    '기기 연동 세션이 필요합니다', '이미 이 기기에서 켜져 있습니다', '이미 다른 기기에서 켜져 있습니다',
    '종단간 암호화는 동기화가 도는', '이 기기에 열쇠가 없습니다', '승인할 기기를 지정해',
    '대상 기기의 공개키가 없습니다', '잠시 후 다시 시도해 주세요', '이미 이 기기에 열쇠가 있습니다',
    '복구 코드가 설정돼 있지 않습니다', '복구 코드가 맞지 않습니다', '제거할 기기를 지정해',
    '이 기기 자신은 제거할 수 없습니다', '알 수 없는 action',
  ].join('|')})`);
  for (const f of files) {
    const m = (await readFile(f, 'utf8')).match(banned);
    assert.equal(m, null, `${f}: e2ee 문구 하드코딩 재등장 — apiError로 합류할 것: ${m?.[0] ?? ''}`);
  }
});

// ── ⑤ companies GET 실호출 — 프리셋 표시 언어 (리졸브 훅 = connector-catalog ⑧ 관례) ──
const { register } = await import('node:module');
register(new URL('./helpers/next-esm-resolve.mjs', import.meta.url));
const companiesRoute = await import('../app/api/companies/route.js');
const getPresets = async (qs = '', headers = {}) => {
  const res = await companiesRoute.GET(new Request(`http://127.0.0.1/api/companies${qs}`, { headers }));
  assert.equal(res.status, 200);
  return (await res.json()).presets;
};
const hasKo = (ps) => ps.some((p) => /[가-힣]/.test(p.label + p.desc));

test('companies GET — 프리셋 표시 언어: ?lang 1순위, 부재 시 argo-lang 쿠키 폴백, 무단서는 ko', async () => {
  const bare = await getPresets();
  assert.ok(bare.length >= 3, '프리셋이 내려온다');
  assert.equal(bare[0].label, '크리에이터', '무단서 = ko(기존 행동 바이트 핀)');
  const cookieEn = await getPresets('', { cookie: 'argo-lang=en' });
  assert.ok(!hasKo(cookieEn), `en 쿠키 = 영어 프리셋(검수 실측 표면): ${JSON.stringify(cookieEn)}`);
  assert.equal(cookieEn[0].label, 'Creator');
  assert.ok(!hasKo(await getPresets('?lang=en')), '?lang=en = 영어(기존 행동 유지)');
  assert.ok(hasKo(await getPresets('?lang=ko', { cookie: 'argo-lang=en' })), '?lang=ko가 쿠키 en보다 우선(화면 UI 언어 1순위)');
  assert.ok(hasKo(await getPresets('?lang=de', { cookie: 'argo-lang=ko' })), '무효 ?lang은 버리고 쿠키(ko)로');
});
