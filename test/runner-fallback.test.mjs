// 러너 대체 실행 실패 맥락 — "Codex를 골랐는데 왜 Claude 에러?"(실사용 신고) 방지 회귀 테스트.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { fallbackErrorPrefix } = await import('../src/chat.mjs');

test('fallbackErrorPrefix: 대체 실행일 때만 맥락 프리픽스를 만든다', () => {
  assert.equal(fallbackErrorPrefix(false, 'codex', 'claude', 'ko'), '', '폴백이 아니면 빈 문자열(에러 원문 유지)');
  const ko = fallbackErrorPrefix(true, 'codex', 'claude', 'ko');
  assert.ok(ko.includes('Codex') && ko.includes('Claude Code'), '지정·대체 러너 표시명 포함');
  assert.ok(ko.includes('대체 실행'), '대체 사실 명시');
  const en = fallbackErrorPrefix(true, 'codex', 'claude', 'en');
  assert.ok(en.includes('Codex') && en.includes('Claude Code') && en.includes('instead'), '영어 모드 문구');
  assert.ok(!en.match(/[가-힣]/), '영어 모드에 한국어 미노출(i18n 절대규칙)');
});

test('fallbackErrorPrefix: 미등록 러너 id는 id 그대로 표기(크래시 없음)', () => {
  const s = fallbackErrorPrefix(true, 'unknown-x', 'claude', 'ko');
  assert.ok(s.includes('unknown-x'), '표시명 없으면 id 원문');
});
