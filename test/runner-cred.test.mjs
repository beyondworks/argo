// 러너 자격 저장 검증 회귀 테스트 — 형식이 다른 OAuth 값이 저장을 통과해 모든 턴이
// 401로만 드러나던 실사용 사고(2026-07-18, 92자 비접두사 값) 재발 방지.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { mkdtemp, stubRunnerToolDirs } from './helpers/tmp.mjs';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 임시 ARGO_ROOT — WS_ROOT는 모듈 로드 시 고정되므로 import보다 먼저 심는다(실데이터 미접촉)
// 임시 HOME — runnerCredEnv가 ~/.argo/*-home-*에 auth.json(평문 키)을 시드하므로 실 홈 오염 차단
// (검수 F4 실측: 테스트 더미 키가 개발자 실 홈에 생성됐다). homedir()는 POSIX에선 $HOME,
// Windows에선 %USERPROFILE% — 둘 다 심어야 전 플랫폼 격리.
process.env.HOME = process.env.USERPROFILE = await mkdtemp(join(tmpdir(), 'argo-credhome-'));
process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-credtest-'));
// 러너 관리본 스텁 — 아래 saveRunnerCred들이 워밍업으로 codex/gemini CLI(~360MB)를 이 격리
// 홈에 매 실행 내려받지 않게 조달을 존재 확인 단계에서 끊는다(이 파일은 CLI를 실행하지 않는다).
await stubRunnerToolDirs();
const { oauthFormatError, RUNNER_AUTH, startRunnerWebAuth, runnerStatus, saveRunnerCred, runnerCredEnv } = await import('../src/runners.mjs');

test('RUNNER_AUTH: claude OAuth 접두사 규격 고정', () => {
  assert.equal(RUNNER_AUTH.claude.oauthPrefix, 'sk-ant-oat01-', 'CLAUDE_CODE_OAUTH_TOKEN 접두사');
  assert.equal(RUNNER_AUTH.codex.oauthPrefix, undefined, 'codex oauth는 JSON blob — 접두사 검사 비대상');
  assert.equal(RUNNER_AUTH.gemini.oauthPrefix, undefined, 'gemini oauth는 JSON blob — 접두사 검사 비대상');
});

test('oauthFormatError: 형식이 다른 값은 안내와 함께 거절', () => {
  // 실사고 재현 — 92자 비접두사 랜덤 문자열(웹 브리지 산출물/중간 인증 코드류)
  const bogus = 'LHT4Hwfn1V'.repeat(9) + 'ab';
  const ko = oauthFormatError('claude', bogus, 'ko');
  assert.ok(ko, '비접두사 값은 거절');
  assert.ok(ko.includes('sk-ant-oat01-'), '올바른 접두사를 안내');
  assert.ok(ko.includes('setup-token'), '발급 명령을 안내');
  assert.ok(ko.includes('인증 코드'), '중간 단계 코드 오인을 짚어준다');
  const en = oauthFormatError('claude', bogus, 'en');
  assert.ok(en.includes('sk-ant-oat01-') && en.includes('setup-token'), '영어 안내 동등');
  assert.ok(!/[가-힣]/.test(en), '영어 모드에 한국어 미노출(i18n 절대규칙)');
});

test('oauthFormatError: 올바른 토큰·비대상 러너는 통과(null)', () => {
  assert.equal(oauthFormatError('claude', 'sk-ant-oat01-abc123', 'ko'), null, '정상 토큰 통과');
  assert.equal(oauthFormatError('claude', '  sk-ant-oat01-abc123  ', 'ko'), null, '공백 트림 후 판정');
  assert.equal(oauthFormatError('codex', '{"tokens":{}}', 'ko'), null, '접두사 규격 없는 러너는 검사 안 함');
  assert.equal(oauthFormatError('glm', 'anything', 'ko'), null);
});

test('oauthFormatError: sk-ant-(API키)를 OAuth 자리에 넣은 경우도 잡는다', () => {
  // apikey 접두사(sk-ant-)만 있고 oat01이 아니면 OAuth 토큰이 아니다 — 키/토큰 혼동 방어
  assert.ok(oauthFormatError('claude', 'sk-ant-api03-xxxx', 'ko'), 'API 키는 OAuth 자리에서 거절');
});

test('claude 웹 브리지 철회: webConnect 내림 + 브리지 시작 경로 폐쇄', () => {
  // 구세대 엔드포인트 교환이 러너가 거절하는 비 oat01 토큰을 저장하던 사고(2026-07-18) — 재개방 방지
  assert.ok(!RUNNER_AUTH.claude.webConnect, 'claude 웹 브리지는 철회 상태여야 한다');
  assert.deepEqual(startRunnerWebAuth('claude'), { ok: false, reason: 'unsupported' }, '브리지 시작이 거절된다');
  assert.equal(startRunnerWebAuth('codex').ok, true, 'codex 브리지는 유지(벤더 공개 OAuth)');
});

test('runnerStatus: 저장된 무효 형식 oauth 토큰에 invalid 표시(재연결 필요 신호)', async () => {
  const ws = 'credco';
  await mkdir(join(process.env.ARGO_ROOT, ws), { recursive: true });
  await saveRunnerCred(ws, 'claude', 'oauth', 'LHT4-bridge-artifact-not-a-token');
  let st = await runnerStatus(ws);
  assert.equal(st.claude.company.connected, true, '연결 표시는 유지(마스킹 값 존재)');
  assert.equal(st.claude.company.invalid, true, '무효 형식이면 재연결 필요 신호');
  await saveRunnerCred(ws, 'claude', 'oauth', 'sk-ant-oat01-valid-form');
  st = await runnerStatus(ws);
  assert.ok(!st.claude.company.invalid, '정상 형식은 invalid 없음');
  await saveRunnerCred(ws, 'claude', 'apikey', 'sk-ant-api03-xxxx');
  st = await runnerStatus(ws);
  assert.ok(!st.claude.company.invalid, 'apikey 타입은 oauth 형식 검사 비대상');
});

test('runnerStatus: cli 플래그 — 외부 CLI 러너만 true(카드 정직 표기의 서버 판정)', async () => {
  // 크루 도구(쪽지·루틴·위임)는 SDK 러너 전용(chat.mjs hasTools:false) — UI가 이 플래그로만
  // "미지원" 표기를 판정한다. 클라 하드코딩 표류('Claude Code' 명판 실사고 2026-07-20 계열) 방지.
  const st = await runnerStatus('credco');
  for (const id of ['codex', 'gemini', 'antigravity']) assert.equal(st[id].cli, true, `${id}=CLI 러너`);
  for (const id of ['claude', 'glm', 'kimi', 'openrouter']) assert.equal(st[id].cli, false, `${id}=SDK 계열`);
});

test('extractSetupToken: PTY 출력(ANSI 혼입)에서 최종 토큰만 추출', async () => {
  const { extractSetupToken } = await import('../src/runners.mjs');
  const pty = '\x1b[2J\x1b[1;1HOpening browser to sign in…\n\x1b[32m✓\x1b[0m Token created:\n  sk-ant-oat01-AbC123_def-4567890XYZ\n';
  assert.equal(extractSetupToken(pty), 'sk-ant-oat01-AbC123_def-4567890XYZ', 'ANSI 제거 후 토큰 추출');
  assert.equal(extractSetupToken('Opening browser… waiting'), null, '토큰 없으면 null');
  assert.equal(extractSetupToken('sk-ant-api03-notoauth-1234567890abcdef'), null, 'API 키 형식은 미매치');
  assert.equal(extractSetupToken(null), null, 'null 안전');
});

test('extractSetupToken: PTY 80칸 줄바꿈으로 감싸인 토큰 복원 — 절단 저장 실사고 재발 방지(2026-07-19)', async () => {
  const { extractSetupToken, extractSetupTokenCandidates } = await import('../src/runners.mjs');
  // 실사고 재현 조건 — 108자 토큰이 PTY 기본 80칸에서 두 줄로 갈라진다
  const full = `sk-ant-oat01-${'A'.repeat(95)}`;
  const wrapped = `${full.slice(0, 80)}\n${full.slice(80)}\n\n다음 단계 안내…\n`;
  assert.equal(extractSetupToken(wrapped), full, '줄바꿈 접합으로 108자 전체 복원(이전엔 80자 절단 저장 → 연결됨인데 전 호출 401)');
  // 접합이 토큰 뒤 텍스트를 흡수하는 엣지 — 원본 후보가 함께 남아 저장 전 HTTP 검증이 고른다
  const absorbing = `${full}\nDone\n`;
  const cands = extractSetupTokenCandidates(absorbing);
  assert.ok(cands.includes(full), '흡수 엣지에서도 온전한 원본 후보 유지');
  // CRLF 줄바꿈(맥 PTY)도 동일
  assert.equal(extractSetupToken(`${full.slice(0, 80)}\r\n${full.slice(80)}\n`), full, 'CRLF 접합');
});

test('bundledClaudeCli: 내장 SDK CLI 폴백 — 초보자 원클릭의 전제(설치 0)', async (t) => {
  const { bundledClaudeCli } = await import('../src/runners.mjs');
  const p = await bundledClaudeCli();
  if (process.platform === 'darwin') {
    assert.ok(p && p.endsWith('/claude'), '맥에선 SDK 네이티브 claude 바이너리가 잡혀야 한다(stage-sidecar 3.4 보장)');
  } else {
    assert.ok(p === null || typeof p === 'string', '타 플랫폼 — null 허용(수동 붙여넣기 안내로 폴백)');
  }
});

test('startClaudeSetupToken: 원클릭은 데스크톱 번들(ARGO_STANDALONE)에서만 — 상주/웹은 manual', async () => {
  const { startClaudeSetupToken } = await import('../src/runners.mjs');
  const prevStd = process.env.ARGO_STANDALONE;
  const prevKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'crown-test'; // 있든 없든 판정과 무관해야 한다
  try {
    // 비-standalone(상주/웹/dev) → manual 안내(스피너 함정 방지). 서비스 키 유무와 무관.
    delete process.env.ARGO_STANDALONE;
    assert.deepEqual(await startClaudeSetupToken('credco'), { ok: false, reason: 'manual' }, '비-standalone = 붙여넣기 안내');
    process.env.ARGO_STANDALONE = '0';
    assert.deepEqual(await startClaudeSetupToken('credco'), { ok: false, reason: 'manual' }, "ARGO_STANDALONE=0 = 붙여넣기 안내");
    // 벨트: standalone=1이어도 ARGO_TENANT_OWNER(다중테넌트 호스팅)면 하드 차단 — 런타임에 실수로
    // ARGO_STANDALONE=1이 들어가도 원격에서 원클릭이 재개방되지 않게(검수 LOW).
    process.env.ARGO_STANDALONE = '1';
    process.env.ARGO_TENANT_OWNER = 'acct-1';
    assert.deepEqual(await startClaudeSetupToken('credco'), { ok: false, reason: 'manual' }, 'standalone=1이어도 ARGO_TENANT_OWNER면 하드 차단(벨트)');
    delete process.env.ARGO_TENANT_OWNER;
    // standalone(데스크톱 번들, 테넌트 아님) → 게이트 통과 + 재클릭=재시작 계약(busy 거절 폐지 —
    // 승인 없이 브라우저를 닫으면 10분 타임아웃까지 재시도가 전부 막히던 실사용 신고 2026-07-20).
    // 이전 'running' 시도는 cancel되고 새 세대가 슬롯을 인수해야 한다.
    // 실제 브라우저 hang 방지: CLAUDE_CLI를 부재 경로로 → spawn된 script가 즉시 실패 종료(승인 대기 없음).
    if (process.platform === 'win32') {
      // win32는 원클릭 자체가 미지원(script(1) 부재) — 게이트 통과 대신 unsupported-platform 정직 반환이
      // 계약이다(runners.mjs의 win32 조기 반환·smoke-fresh-device.mjs의 win32 스킵과 동일 근거).
      assert.deepEqual(await startClaudeSetupToken('credco-std'), { ok: false, reason: 'unsupported-platform' },
        'win32 standalone = 미지원 플랫폼 정직 반환');
    } else {
      let cancelled = 0;
      (globalThis.__argoSetupToken ??= {})['credco-std'] = { status: 'running', ts: Date.now(), gen: 7, cancel: () => { cancelled += 1; } };
      const prevCli = process.env.CLAUDE_CLI;
      process.env.CLAUDE_CLI = '/nonexistent/argo-test-claude';
      try {
        const r = await startClaudeSetupToken('credco-std');
        assert.equal(r.ok, true, 'standalone = 게이트 통과(새 시도 시작)');
        assert.equal(cancelled, 1, '이전 running 시도는 cancel — 재클릭=재시작');
        assert.equal(globalThis.__argoSetupToken['credco-std'].gen, 8, '새 세대가 슬롯 인수(구시도 결과는 gen 가드로 무시)');
      } finally {
        if (prevCli === undefined) delete process.env.CLAUDE_CLI; else process.env.CLAUDE_CLI = prevCli;
        delete globalThis.__argoSetupToken['credco-std']; // 폐기 — 늦은 commit은 gen 가드가 버린다
      }
    }
  } finally {
    delete process.env.ARGO_TENANT_OWNER;
    if (prevStd === undefined) delete process.env.ARGO_STANDALONE; else process.env.ARGO_STANDALONE = prevStd;
    if (prevKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = prevKey;
  }
});

// verifyRunnerCred 저장 전 실검증 — 상태코드만 보던 구멍으로 무효 자격이 '연결됨'으로 저장되던
// 실사고 클래스 재발 방지(2026-07-20 실측: gemini 무효=HTTP 400 API_KEY_INVALID, glm 무효=HTTP 200 바디 401).
// fetch를 모킹해 실측 응답 형태를 재현한다(네트워크·실키 미접촉). 유효 키 오거절 없음이 최우선 검증.
function mockFetchOnce(fn) {
  const real = globalThis.fetch;
  globalThis.fetch = fn;
  return () => { globalThis.fetch = real; };
}

test('verifyRunnerCred: Gemini 무효 키(HTTP 400 API_KEY_INVALID)를 무효로 판정 — 상태코드 구멍', async () => {
  const { verifyRunnerCred } = await import('../src/runners.mjs');
  let restore = mockFetchOnce(async () => new Response(JSON.stringify({ error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] } }), { status: 400 }));
  try {
    assert.deepEqual(await verifyRunnerCred('gemini', 'apikey', 'bogus'), { ok: false }, '400 API_KEY_INVALID = 무효(이전엔 ok:true로 거짓 통과)');
  } finally { restore(); }
  restore = mockFetchOnce(async () => new Response(JSON.stringify({ models: [{ name: 'models/gemini-2.5-pro' }] }), { status: 200 }));
  try {
    assert.deepEqual(await verifyRunnerCred('gemini', 'apikey', 'good'), { ok: true }, '200 = 유효 키(오거절 없음)');
  } finally { restore(); }
  restore = mockFetchOnce(async () => new Response(JSON.stringify({ error: { code: 400, message: 'Invalid pageSize value', status: 'INVALID_ARGUMENT' } }), { status: 400 }));
  try {
    assert.deepEqual(await verifyRunnerCred('gemini', 'apikey', 'good'), { ok: null }, '키와 무관한 400은 키 탓 아님 → ok:null(관용 저장)');
  } finally { restore(); }
});

test('verifyRunnerCred: GLM 무효 키(HTTP 200 + 바디 code:401)를 무효로 판정 — 200바디 구멍', async () => {
  const { verifyRunnerCred } = await import('../src/runners.mjs');
  let restore = mockFetchOnce(async () => new Response(JSON.stringify({ code: 401, msg: 'token expired or incorrect', success: false }), { status: 200 }));
  try {
    assert.deepEqual(await verifyRunnerCred('glm', 'apikey', 'bogus'), { ok: false }, 'HTTP 200 바디 401 = 무효(이전엔 ok:true로 거짓 통과)');
  } finally { restore(); }
  restore = mockFetchOnce(async () => new Response('unauthorized', { status: 401 }));
  try {
    assert.deepEqual(await verifyRunnerCred('glm', 'apikey', 'bogus'), { ok: false }, '진짜 HTTP 401도 무효');
  } finally { restore(); }
  restore = mockFetchOnce(async () => new Response(JSON.stringify({ data: [{ type: 'model', id: 'glm-4.6' }], has_more: false }), { status: 200 }));
  try {
    assert.deepEqual(await verifyRunnerCred('glm', 'apikey', 'good'), { ok: true }, '정상 models 바디 = 유효(success·code 없음 → 오거절 없음)');
  } finally { restore(); }
  // 유효 키인데 비인증 실패(레이트리밋·계정정지)를 z.ai가 HTTP 200 {code:비401,success:false}로 줄 때,
  // success:false만 보고 무효로 몰면 유효 키를 거절한다 — code(401/403)일 때만 무효(검수 HIGH 회귀 방지).
  restore = mockFetchOnce(async () => new Response(JSON.stringify({ code: 1305, msg: 'concurrency rate limit reached', success: false }), { status: 200 }));
  try {
    const r = await verifyRunnerCred('glm', 'apikey', 'valid-but-ratelimited');
    assert.notEqual(r.ok, false, '비인증 200 에러(레이트리밋 등)는 유효 키를 거절하지 않는다(success:false 오탐 방지)');
  } finally { restore(); }
});

test('verifyRunnerCred: Grok 무효 키(HTTP 400 Incorrect API key)를 무효로 판정 — 400 구멍(세 번째)', async () => {
  const { verifyRunnerCred } = await import('../src/runners.mjs');
  // xAI는 잘못된 키에 400 {"code":"invalid-argument","error":"Incorrect API key provided..."}를 준다(실측 2026-08-26).
  // 401만 거부하던 구멍으로 "not even a key"까지 통과했다 — gemini(400)·glm(200바디)와 같은 계열.
  let restore = mockFetchOnce(async () => new Response(JSON.stringify({ code: 'invalid-argument', error: 'Incorrect API key provided. You can obtain an API key from https://console.x.ai.' }), { status: 400 }));
  try {
    assert.deepEqual(await verifyRunnerCred('grok', 'apikey', 'not even a key'), { ok: false }, '400 Incorrect API key = 무효(이전엔 ok:true 거짓 통과)');
  } finally { restore(); }
  // 모델 미존재(키는 유효)는 거절하면 안 된다 — xAI가 모델을 키보다 먼저 검사한다
  restore = mockFetchOnce(async () => new Response(JSON.stringify({ code: 'invalid-argument', error: 'Model not found: grok-nope' }), { status: 400 }));
  try {
    assert.deepEqual(await verifyRunnerCred('grok', 'apikey', 'valid-key'), { ok: true }, 'Model not found(400)는 키 무효 아님 → 유효 키 오거절 방지');
  } finally { restore(); }
  // 빈 토큰 = 401 unauthenticated도 무효
  restore = mockFetchOnce(async () => new Response(JSON.stringify({ code: 'unauthenticated:bad-credentials' }), { status: 401 }));
  try {
    assert.deepEqual(await verifyRunnerCred('grok', 'apikey', 'x'), { ok: false }, '401 bad credentials = 무효');
  } finally { restore(); }
  // 정상 200 응답은 유효
  restore = mockFetchOnce(async () => new Response(JSON.stringify({ id: 'msg_1', type: 'message', content: [{ type: 'text', text: 'hi' }] }), { status: 200 }));
  try {
    assert.deepEqual(await verifyRunnerCred('grok', 'apikey', 'good'), { ok: true }, '200 = 유효 키(오거절 없음)');
  } finally { restore(); }
});

test('AUTH_ERR_RE: grok의 xAI 400 문구가 채팅 자가치유(러너 교체)를 발동시킨다 — 러너 중립성', async () => {
  const { AUTH_ERR_RE } = await import('../src/chat.mjs');
  // 실사고 2026-08-26: 이 문구가 정규식에 안 걸려 grok만 채팅 자가치유 미발동(다른 러너 있어도 턴 사망)
  assert.ok(AUTH_ERR_RE.test('Grok: API Error: 400 {"code":"invalid-argument","error":"Incorrect API key provided..."}'), 'Incorrect API key가 매치돼야 러너 교체 발동');
  assert.ok(AUTH_ERR_RE.test('bad credentials'), 'bad credentials 매치');
  // 상태코드 전체(\b400\b)를 넣지 않았음을 회귀로 잠근다 — 모델 미존재·요청오류까지 교체로 오분류 금지
  assert.ok(!AUTH_ERR_RE.test('Model not found: grok-4.9'), '모델 미존재(400)는 인증 실패가 아니다 — 러너 교체 금지');
  assert.ok(!AUTH_ERR_RE.test('invalid request content: system'), '요청 형식 오류도 인증 실패 아님');
});

test('verifyRunnerCred: 정상 401 러너(kimi·codex·claude apikey)는 회귀 없음', async () => {
  const { verifyRunnerCred } = await import('../src/runners.mjs');
  let restore = mockFetchOnce(async () => new Response('unauthorized', { status: 401 }));
  try {
    assert.deepEqual(await verifyRunnerCred('kimi', 'apikey', 'x'), { ok: false }, 'kimi 401 무효');
    assert.deepEqual(await verifyRunnerCred('codex', 'apikey', 'x'), { ok: false }, 'codex 401 무효');
    assert.deepEqual(await verifyRunnerCred('claude', 'apikey', 'x'), { ok: false }, 'claude apikey 401 무효');
  } finally { restore(); }
  restore = mockFetchOnce(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
  try {
    assert.deepEqual(await verifyRunnerCred('kimi', 'apikey', 'x'), { ok: true }, 'kimi 200 유효');
  } finally { restore(); }
});

/* ── OAuth 연결 시 API키 명시 소거 — 호스트 env 키가 OAuth를 누르지 않게(claude 대칭, 신고 2026-07-24) ── */
test('runnerCredEnv: codex OAuth는 OPENAI_API_KEY를 빈 값으로 소거(호스트 키 우선 차단)', async () => {
  const WS = 'credenv-codex';
  await mkdir(join(process.env.ARGO_ROOT, WS), { recursive: true });
  // codex OAuth 자격 = auth.json JSON blob(형식 무관, 저장만) — 회사 스코프 저장
  await saveRunnerCred(WS, 'codex', 'oauth', JSON.stringify({ tokens: { access_token: 'x' } }));
  const r = await runnerCredEnv(WS, 'codex');
  assert.equal(r.env.OPENAI_API_KEY, '', 'codex OAuth는 OPENAI_API_KEY를 빈 값으로 덮어 OAuth(auth.json)를 보장');
  assert.ok(r.home && r.home.includes('codex-home'), '격리 CODEX_HOME 반환');
});

test('runnerCredEnv: gemini OAuth는 GEMINI/GOOGLE_API_KEY를 빈 값으로 소거', async () => {
  const WS = 'credenv-gemini';
  await mkdir(join(process.env.ARGO_ROOT, WS), { recursive: true });
  await saveRunnerCred(WS, 'gemini', 'oauth', JSON.stringify({ access_token: 'x', refresh_token: 'y' }));
  const r = await runnerCredEnv(WS, 'gemini');
  assert.equal(r.env.GEMINI_API_KEY, '', 'GEMINI_API_KEY 소거');
  assert.equal(r.env.GOOGLE_API_KEY, '', 'GOOGLE_API_KEY 소거');
  assert.equal(r.authType, 'oauth-personal', 'OAuth 인증 방식 고정');
});

// codex CLI(0.144 실측)는 env OPENAI_API_KEY를 더는 인정하지 않는다 — env 주입 시 저장 검증만 통과하고
// 모든 턴이 "Missing bearer or basic authentication in header" 401이었다(실사용 신고 2026-07-26).
// 실측 대조: env 가짜키 → Missing bearer(키 미전달) / auth.json 가짜키 → Incorrect API key(키 전달됨).
test('runnerCredEnv: codex API키 모드는 격리 홈의 auth.json으로 — env 주입은 CLI가 무시한다', async () => {
  const WS = 'credenv-codex-key';
  await mkdir(join(process.env.ARGO_ROOT, WS), { recursive: true });
  await saveRunnerCred(WS, 'codex', 'apikey', 'sk-testkey123456');
  const r = await runnerCredEnv(WS, 'codex');
  assert.ok(r.home && r.home.includes('codex-home'), '격리 CODEX_HOME 반환(env 주입 경로는 죽은 계약)');
  const auth = JSON.parse(await readFile(join(r.home, 'auth.json'), 'utf8'));
  assert.equal(auth.OPENAI_API_KEY, 'sk-testkey123456', 'auth.json에 API 키가 실려야 CLI가 헤더에 붙인다');
  assert.equal(auth.tokens, null, 'apikey 모드는 tokens 없음(codex auth.json 형식)');
  assert.equal(r.env.OPENAI_API_KEY, '', '호스트 env 키가 회사 auth.json을 누르지 않게 소거');
});

// 마커 없는 잔재(옛 OAuth auth.json이 rm 실패로 남은 경우)를 apikey가 '채택'하면 새 키가 영영
// 기록되지 않고 옛 자격으로 돌면서 UI만 "연결됨"이 된다(검수 F1 — 2026-07-20 "죽은 자격" 계열).
// adopt는 CLI가 회전시키는 oauth 토큰 보존용이지, 갱신될 게 없는 apikey엔 해당 없다.
test('runnerCredEnv: 마커 없는 옛 auth.json 잔재를 apikey가 채택하지 않는다', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX 경로 테스트');
  const WS = 'credenv-codex-stale';
  await mkdir(join(process.env.ARGO_ROOT, WS), { recursive: true });
  await saveRunnerCred(WS, 'codex', 'apikey', 'sk-freshkey333333');
  // rm 실패로 잔재가 남은 상황 재현 — 마커 없이 옛 OAuth auth.json만 존재
  const home = join(process.env.HOME, '.argo', `codex-home-${WS}`);
  await mkdir(home, { recursive: true });
  await writeFile(join(home, 'auth.json'), JSON.stringify({ tokens: { access_token: 'STALE-OAUTH' } }));
  const r = await runnerCredEnv(WS, 'codex');
  const auth = JSON.parse(await readFile(join(r.home, 'auth.json'), 'utf8'));
  assert.equal(auth.OPENAI_API_KEY, 'sk-freshkey333333', '잔재를 채택해 새 키가 기록되지 않았다');
});

// 연결 해제 후에도 auth.json에 평문 키가 남으면, env 주입 시절엔 없던 디스크 노출이 새로 생긴 것이다(검수 F2).
test('clearRunnerCred: 연결 해제 시 격리 홈(평문 키 auth.json 포함)이 삭제된다', async () => {
  const WS = 'credenv-codex-clear';
  await mkdir(join(process.env.ARGO_ROOT, WS), { recursive: true });
  await saveRunnerCred(WS, 'codex', 'apikey', 'sk-secretkey444444');
  const r = await runnerCredEnv(WS, 'codex'); // auth.json 시드
  assert.ok(existsSync(join(r.home, 'auth.json')));
  const { clearRunnerCred } = await import('../src/runners.mjs');
  await clearRunnerCred(WS, 'codex');
  assert.equal(existsSync(r.home), false, '해제 후에도 평문 키 파일이 디스크에 남았다');
});

test('runnerCredEnv: codex 키 교체(재연결) 시 auth.json이 새 키로 재시드된다', async () => {
  const WS = 'credenv-codex-rot';
  await mkdir(join(process.env.ARGO_ROOT, WS), { recursive: true });
  await saveRunnerCred(WS, 'codex', 'apikey', 'sk-oldkey111111');
  const r1 = await runnerCredEnv(WS, 'codex');
  assert.equal(JSON.parse(await readFile(join(r1.home, 'auth.json'), 'utf8')).OPENAI_API_KEY, 'sk-oldkey111111');
  await saveRunnerCred(WS, 'codex', 'apikey', 'sk-newkey222222'); // 재연결 — 격리 홈 리셋 + 재시드 경로
  const r2 = await runnerCredEnv(WS, 'codex');
  assert.equal(JSON.parse(await readFile(join(r2.home, 'auth.json'), 'utf8')).OPENAI_API_KEY, 'sk-newkey222222',
    '옛 키가 남으면 재연결해도 401이 계속된다');
});
