// 러너 견고화 P0 회귀 테스트 (2026-08-31 유건 제보 "Grok·Gemini API Error: 400")
// 세 겹: ① SDK가 벤더 오류를 성공 답변으로 삼키는 경로 차단(isSdkErrorReply + chat 배선)
//        ② 만료+갱신실패 자격의 턴 전 게이트(grokExpired + runnerCredEnv throw)
//        ③ 인증류 실패의 사용자 언어 안내(runnerAuthNotice + 표면 배선)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 임시 ARGO_ROOT·HOME — 실데이터·실홈 미접촉(runner-cred.test.mjs와 같은 격리 계약)
process.env.HOME = process.env.USERPROFILE = await mkdtemp(join(tmpdir(), 'argo-p0home-'));
process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-p0test-'));
const { isSdkErrorReply, isSwallowedSdkError, runnerAuthNotice, saveRunnerCred, runnerCredEnv } = await import('../src/runners.mjs');
const { grokExpired, GROK_REFRESH_MARGIN_MS } = await import('../src/runners/grok.mjs');

// ── ① isSdkErrorReply — 엄격판 계약 ──────────────────────────────────────
test('isSdkErrorReply: 실측 원문(xAI 400)을 잡는다', () => {
  // 2026-08-31 가짜 자격 + 실배관 재현에서 SDK result.result로 받은 문자열 그대로
  const real = 'API Error: 400 {"code":"invalid-argument","error":"Incorrect API key provided. You can obtain an API key from https://console.x.ai."}';
  assert.equal(isSdkErrorReply(real), true);
  assert.equal(isSdkErrorReply(`  \n${real}`), true, '선행 공백·개행은 trim 후 판정');
  assert.equal(isSdkErrorReply('API Error: 529 overloaded'), true, '상태코드 무관 — 삼킴 일반형');
});
test('isSdkErrorReply: 정상 답변·오류 인용 답변은 잡지 않는다', () => {
  assert.equal(isSdkErrorReply('보고서 초안입니다.'), false);
  assert.equal(isSdkErrorReply("사용자가 'API Error: 400'을 만나면 재연결을 안내하세요."), false, '산문 중간 인용');
  assert.equal(isSdkErrorReply('API Error: 원인 불명'), false, '상태코드 없는 유사 문구');
  assert.equal(isSdkErrorReply(''), false);
  assert.equal(isSdkErrorReply(null), false);
});

// ── ①-b isSwallowedSdkError — 종합 판정(status 신호 합류, #372 검수 NIT 실측 반영) ──
test('isSwallowedSdkError: api_error_status ≥ 400이면 문구 형식이 달라도 잡는다 (실측: 가짜 grok 자격에서 400 실림)', () => {
  assert.equal(isSwallowedSdkError(true, 400, 'API Error: 400 {...}'), true, '실측 조합');
  assert.equal(isSwallowedSdkError(true, 400, '형식이 다른 벤더 오류 원문'), true, 'status 신호 단독으로 잡음 — 문구 폴백의 미탐 봉합');
  assert.equal(isSwallowedSdkError(true, 0, 'API Error: 529 overloaded'), true, 'status 없는(구버전 SDK) 폴백 = 문구 엄격판');
  assert.equal(isSwallowedSdkError(true, null, '정상 답변입니다.'), false, '둘 다 아니면 통과');
  assert.equal(isSwallowedSdkError(false, 400, 'API Error: 400 …'), false, 'is_error 거짓이면 항상 통과 — 오류 인용 답변 보호');
  assert.equal(isSwallowedSdkError(true, 399, '정상'), false, '400 미만 status는 신호 아님');
});

// ── ② grokExpired — 만료 실판정 ─────────────────────────────────────────
test('grokExpired: 만료/유효/구형 판정', () => {
  const now = 1_756_000_000_000;
  const mk = (exp, rt = true) => JSON.stringify({ access_token: 'a', ...(rt ? { refresh_token: 'r' } : {}), expires_at: exp });
  assert.equal(grokExpired(mk(now - 1), now), true, '만료 시각 경과 = 만료');
  assert.equal(grokExpired(mk(now + 60_000), now), false, '아직 유효(갱신 여유 창과 무관)');
  assert.equal(grokExpired('raw-legacy-token', now), false, '구형(생 토큰)은 판정 불가 = 통과');
  assert.equal(grokExpired(JSON.stringify({ access_token: 'a' }), now), false, 'expires_at 없는 값 통과');
  // 여유 창(needsRefresh)과 실만료의 경계가 다름을 고정 — 창 안이지만 미만료면 게이트 비대상
  assert.equal(grokExpired(mk(now + GROK_REFRESH_MARGIN_MS - 1), now), false);
});

// ── ② runnerCredEnv 게이트 행동 — 만료+갱신실패는 턴 전에 throw ──────────
test('runnerCredEnv(grok oauth): 만료+갱신실패 자격은 authExpired로 턴 전 차단', async (t) => {
  const ws = 'p0gate';
  await mkdir(join(process.env.ARGO_ROOT, ws), { recursive: true });
  // 갱신이 네트워크를 타지 못하게 fetch를 실패로 스텁(실호출 0 보장)
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('offline-stub'); };
  t.after(() => { globalThis.fetch = realFetch; });
  // 만료 + refresh_token 보유(갱신 시도 경로) — 갱신 실패 → 게이트
  await saveRunnerCred(ws, 'grok', 'oauth', JSON.stringify({ access_token: 'dead', refresh_token: 'r', expires_at: Date.now() - 60_000 }));
  await assert.rejects(() => runnerCredEnv(ws, 'grok'), (e) => e.authExpired === 'grok', '만료+갱신실패 = authExpired throw');
  // 만료 + refresh_token 없음(갱신 불가) — 역시 게이트
  await saveRunnerCred(ws, 'grok', 'oauth', JSON.stringify({ access_token: 'dead', expires_at: Date.now() - 60_000 }));
  await assert.rejects(() => runnerCredEnv(ws, 'grok'), (e) => e.authExpired === 'grok', '만료+갱신불가 = authExpired throw');
});
test('runnerCredEnv(grok oauth): 유효 토큰·구형 토큰은 기존과 동일하게 통과(회귀 0)', async () => {
  const ws = 'p0pass';
  await mkdir(join(process.env.ARGO_ROOT, ws), { recursive: true });
  await saveRunnerCred(ws, 'grok', 'oauth', JSON.stringify({ access_token: 'alive', refresh_token: 'r', expires_at: Date.now() + 3_600_000 }));
  const cred = await runnerCredEnv(ws, 'grok');
  assert.equal(cred.env.ANTHROPIC_AUTH_TOKEN, 'alive', '유효 토큰은 그대로 실림');
  await saveRunnerCred(ws, 'grok', 'oauth', 'raw-legacy-token');
  const legacy = await runnerCredEnv(ws, 'grok');
  assert.equal(legacy.env.ANTHROPIC_AUTH_TOKEN, 'raw-legacy-token', '구형(만료시각 미상)은 관용 통과');
});

// ── ③ runnerAuthNotice — 사용자 언어 안내 ────────────────────────────────
test('runnerAuthNotice: ko/en 두 언어 + 러너 이름 + 행동 지시', () => {
  const ko = runnerAuthNotice('ko', 'grok');
  assert.ok(ko.includes('Grok') && ko.includes('설정') && ko.includes('AI 연결'), 'ko: 이름+경로 안내');
  const en = runnerAuthNotice('en', 'grok');
  assert.ok(en.includes('Grok') && en.includes('Settings'), 'en: 이름+경로 안내');
  assert.ok(!/[가-힣]/.test(en), '영어 모드에 한국어 미노출(i18n 절대규칙)');
  assert.ok(runnerAuthNotice('ko', 'unknown-x').includes('unknown-x'), '미등록 러너는 id 그대로(fail-loud 완화형)');
});

// ── 배선 구간 불변식 — chat.mjs가 세 겹을 실제로 소비하는가 ─────────────
// (JSX/거대 함수는 소스 구간으로만 잠근다 — 행동 재현은 가짜 자격 + 실배관 수동 재현이 담당,
//  PR 본문에 재현 로그 기재. 소스 핀은 처방 삭제·역행 변이를 문다.)
const chatSrc = await readFile(new URL('../src/chat.mjs', import.meta.url), 'utf8');
test('chat.mjs 배선: result.is_error 포착 → 삼킴 게이트 throw', () => {
  assert.match(chatSrc, /if \(msg\.subtype === 'success'\) \{ reply = msg\.result; resultIsError = !!msg\.is_error; resultApiErrStatus = Number\(msg\.api_error_status\) \|\| 0; \}/, 'is_error·api_error_status 포착');
  assert.match(chatSrc, /else if \(isSwallowedSdkError\(resultIsError, resultApiErrStatus, reply\)\) \{\s*\n\s*throw new Error\(String\(reply\)\.trim\(\)\.slice\(0, 600\)\);/, '루프 후 삼킴 게이트(종합 판정)');
  assert.match(chatSrc, /if \(!aborted && isSwallowedSdkError\(resultIsError, resultApiErrStatus, reply\) && !isSdkErrorReply\(String\(e\?\.message \|\| e\)\)\) \{\s*\n\s*e = Object\.assign\(new Error\(String\(reply\)\.trim\(\)\.slice\(0, 600\)\), \{ cause: e \}\);/, 'catch 머리 삼킴 보정(이터레이션 후사망 순서·종합 판정)');
});
test('chat.mjs 배선: 표면 번역 — authExpired 대체 + AUTH_ERR_RE 원문 보존 덧붙임', () => {
  assert.match(chatSrc, /e\?\.authExpired\s*\n?\s*\? Object\.assign\(new Error\(runnerAuthNotice\(lang, e\.authExpired\)\), \{ authError: true, cause: e \}\)/, 'authExpired = 안내로 대체');
  assert.match(chatSrc, /AUTH_ERR_RE\.test\(eMsg\) && !e\?\.credit && !e\?\.authError\)\s*\n?\s*\? Object\.assign\(new Error\(`\$\{eMsg\.slice\(0, 300\)\}\\n\\n\$\{runnerAuthNotice\(lang, runner\)\}`\)/, 'AUTH_ERR_RE = 원문+안내 덧붙임');
});

test('chat.mjs 배선: sdkEnvFor(자격 게이트)가 catch 관할 try 안에 있다', () => {
  // 게이트 throw가 try 밖이면 자가치유·번역 미발동으로 원문이 표면화된다(격리 서버 실측 2026-08-31).
  // 순서 불변식: abortReg 늦은대입 선언 → try 시작 → sdkEnvFor 호출.
  const decl = chatSrc.indexOf('let abortReg = null;');
  const call = chatSrc.indexOf('await sdkEnvFor(wsId, runner)');
  assert.ok(decl > 0 && call > decl, 'sdkEnvFor 호출이 abortReg 선언 뒤(=try 블록 안 재배치 상태)');
  const between = chatSrc.slice(decl, call);
  assert.ok(/\btry \{/.test(between), '선언과 호출 사이에 try 시작이 존재(호출이 try 안)');
  // catch·finally는 옵셔널 참조 — 등록 전 실패 시 ReferenceError/TypeError 재발 방지
  assert.match(chatSrc, /let aborted = !!abortReg\?\.wasAborted\(\);/);
  assert.match(chatSrc, /abortReg\?\.release\(\);/);
});

test('chat.mjs 배선: 표면 번역 분기 순서 — authExpired가 AUTH_ERR_RE보다 먼저 (검수 fail-open 봉합)', () => {
  // 순서만 뒤집어도(문구 보존) 사용자에게 내부 영문 원문이 노출된다(검수 하네스 실측) —
  // 낱개 문자열 핀은 순서를 못 지키므로 인덱스 비교로 잠근다.
  const surfStart = chatSrc.indexOf('const surfaced =');
  const surf = chatSrc.slice(surfStart, surfStart + 900);
  const iExpired = surf.indexOf('e?.authExpired');
  const iAuthRe = surf.indexOf('AUTH_ERR_RE.test(eMsg)');
  assert.ok(iExpired > 0 && iAuthRe > 0 && iExpired < iAuthRe, 'authExpired 분기가 AUTH_ERR_RE 분기보다 앞');
  // 재귀 자가치유의 안내 누적 방지 — 이미 authError면 재부착 금지(검수 LOW)
  assert.match(surf, /&& !e\?\.credit && !e\?\.authError\)/, '누적 방지 항');
});

test('oneshot.mjs 배선: SDK 삼킴 승격 대칭 (검수 MEDIUM — 크루 카드·기억 오염 경로)', async () => {
  const src = await readFile(new URL('../src/oneshot.mjs', import.meta.url), 'utf8');
  assert.match(src, /\{ text = msg\.result; isErr = !!msg\.is_error; apiErrSt = Number\(msg\.api_error_status\) \|\| 0; \}/, 'is_error·api_error_status 포착');
  assert.match(src, /if \(isSwallowedSdkError\(isErr, apiErrSt, text\)\) throw new Error\(String\(text\)\.trim\(\)\.slice\(0, 600\)\);/, '승격 게이트(종합 판정)');
});

test('creds.mjs 배선: 만료 게이트의 경합 재독 재판정 (검수 LOW — 병렬 턴 오안내 방지)', async () => {
  const src = await readFile(new URL('../src/runners/creds.mjs', import.meta.url), 'utf8');
  const gate = src.slice(src.indexOf('if (grokExpired(cur))'), src.indexOf("tok = grokAccessToken(cur);"));
  assert.match(gate, /loadSecrets\(wsId\)/, '던지기 전 디스크 재독');
  assert.match(gate, /!grokExpired\(fresh\)/, '재독본 재판정');
});
