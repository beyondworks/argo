// 러너 자격 저장 검증 회귀 테스트 — 형식이 다른 OAuth 값이 저장을 통과해 모든 턴이
// 401로만 드러나던 실사용 사고(2026-07-18, 92자 비접두사 값) 재발 방지.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { oauthFormatError, RUNNER_AUTH } = await import('../src/runners.mjs');

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
