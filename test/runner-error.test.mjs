// A0 러너 에러 원인 분류(apiError) 회귀 테스트 — 핫패스 상호작용 보호.
// 핵심 불변식: apiError가 CLI 미발견(ENOENT)만 새로 분기하고, 인증·게이트 모델 에러 텍스트는
// 절대 덮어쓰지 않는다(그래야 chat.mjs의 AUTH_ERR_RE 자가치유·GATED_MODEL_ERR_RE 강등이 그대로 동작).
import test from 'node:test';
import assert from 'node:assert/strict';
import { apiError } from '../src/runners.mjs';

// chat.mjs의 정규식 정본과 동일 — apiError 출력이 이들과 매칭되는지로 상호작용 보존을 검증한다.
const AUTH_ERR_RE = /not logged in|run \/login|invalid api key|invalid authentication|authentication[_ ]error|api[_ ]?key[_ ]?(?:not valid|invalid)|token (?:is )?(?:expired|revoked|invalid|incorrect)|\b401\b/i;
const GATED_MODEL_ERR_RE = /requested entity was not found|NOT_FOUND|PERMISSION_DENIED/i;

test('apiError: 스폰 ENOENT → CLI 미발견(PATH/설치) 원인 안내', () => {
  const m = apiError({ code: 'ENOENT', stderr: 'spawn codex ENOENT' }).message;
  assert.match(m, /CLI를 찾지 못했습니다|CLI not found/i);
});

test('apiError: 셸 command not found도 CLI 미발견으로 분류', () => {
  const m = apiError({ code: 127, stderr: 'gemini: command not found' }).message;
  assert.match(m, /CLI를 찾지 못했습니다|CLI not found/i);
});

test('apiError: 인증 실패 텍스트 보존 → AUTH_ERR_RE 자가치유 유지', () => {
  const m = apiError({ code: 1, stderr: '{"message":"invalid api key"}' }).message;
  assert.match(m, AUTH_ERR_RE, '자가치유 재시도가 트리거되려면 인증 문구가 보존돼야 한다');
});

test('apiError: 게이트 모델 에러 보존 → GATED_MODEL_ERR_RE 강등 유지(ENOENT 오분류 금지)', () => {
  const m = apiError({ code: 1, stderr: 'error: Requested entity was not found.' }).message;
  assert.match(m, GATED_MODEL_ERR_RE, '강등 재시도가 트리거되려면 게이트 문구가 보존돼야 한다');
  assert.doesNotMatch(m, /CLI를 찾지 못했습니다/, '"not found"를 CLI 미발견으로 오분류하면 안 된다');
});

test('apiError: gemini IneligibleTier 번역 유지', () => {
  const m = apiError({ code: 1, stderr: 'IneligibleTierError: no longer supported for Gemini Code Assist' }).message;
  assert.match(m, /API 키|API key/i);
});

test('apiError: 그 외 실패는 벤더 message 추출(제네릭 폴백)', () => {
  const m = apiError({ code: 1, stderr: '{"message":"rate limit exceeded"}' }).message;
  assert.match(m, /rate limit exceeded/);
});
