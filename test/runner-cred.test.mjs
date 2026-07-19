// 러너 자격 저장 검증 회귀 테스트 — 형식이 다른 OAuth 값이 저장을 통과해 모든 턴이
// 401로만 드러나던 실사용 사고(2026-07-18, 92자 비접두사 값) 재발 방지.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 임시 ARGO_ROOT — WS_ROOT는 모듈 로드 시 고정되므로 import보다 먼저 심는다(실데이터 미접촉)
process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-credtest-'));
const { oauthFormatError, RUNNER_AUTH, startRunnerWebAuth, runnerStatus, saveRunnerCred } = await import('../src/runners.mjs');

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

test('startClaudeSetupToken: 호스팅 워커에선 spawn 없이 거절', async () => {
  const { startClaudeSetupToken } = await import('../src/runners.mjs');
  const prev = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'crown-test';
  try {
    assert.deepEqual(await startClaudeSetupToken('credco'), { ok: false, reason: 'hosted' }, '서비스 키 환경 = 호스팅 — 로컬 전용 기능 차단');
  } finally {
    if (prev === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = prev;
  }
});
