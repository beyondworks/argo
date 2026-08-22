// 러너 대체 실행 실패 맥락 — "Codex를 골랐는데 왜 Claude 에러?"(실사용 신고) 방지 회귀 테스트.
import { RUNNERS } from '../src/runners/catalog.mjs'; // 표시명은 카탈로그가 단일 진실(브랜딩 변경에 테스트가 끌려가지 않게)
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { fallbackErrorPrefix } = await import('../src/chat.mjs');

test('fallbackErrorPrefix: 대체 실행일 때만 맥락 프리픽스를 만든다', () => {
  assert.equal(fallbackErrorPrefix(false, 'codex', 'claude', 'ko'), '', '폴백이 아니면 빈 문자열(에러 원문 유지)');
  const ko = fallbackErrorPrefix(true, 'codex', 'claude', 'ko');
  assert.ok(ko.includes('Codex') && ko.includes(RUNNERS.claude.name), '지정·대체 러너 표시명 포함');
  assert.ok(ko.includes('대체 실행'), '대체 사실 명시');
  const en = fallbackErrorPrefix(true, 'codex', 'claude', 'en');
  assert.ok(en.includes('Codex') && en.includes(RUNNERS.claude.name) && en.includes('instead'), '영어 모드 문구');
  assert.ok(!en.match(/[가-힣]/), '영어 모드에 한국어 미노출(i18n 절대규칙)');
});

test('fallbackErrorPrefix: 미등록 러너 id는 id 그대로 표기(크래시 없음)', () => {
  const s = fallbackErrorPrefix(true, 'unknown-x', 'claude', 'ko');
  assert.ok(s.includes('unknown-x'), '표시명 없으면 id 원문');
});

/* ── 인증 제외 폴백의 정직 사유 — Grok 실사용 제보(2026-08-06): 연결 직후 401 → 자가치유 폴백이
   "이 기기에 연결돼 있지 않아"(거짓) / 러너 소진 시 "하나도 연결돼 있지 않습니다"(거짓)를 냈다.
   두 증상("클로드 러너로 뜬다"·"러너 없음")의 뿌리 = 제외 사유를 미연결로 뭉갠 문구. ── */
test('fallbackErrorPrefix(excluded): 사유가 "미연결"이 아니라 "인증 오류"로 나온다', () => {
  const ko = fallbackErrorPrefix(true, 'grok', 'claude', 'ko', { excluded: true });
  assert.ok(ko.includes('연결돼 있지만') && ko.includes('인증 오류'), '연결 사실 + 진짜 사유');
  assert.ok(!ko.includes('연결돼 있지 않아'), '거짓 사유(미연결) 미노출');
  const en = fallbackErrorPrefix(true, 'grok', 'claude', 'en', { excluded: true });
  assert.ok(en.includes('authentication error') && !en.match(/[가-힣]/), '영어 모드 + 한국어 미노출');
  // 기본값(excluded 미전달)은 기존 문구 그대로 — 진짜 미연결 폴백의 회귀 없음
  assert.ok(fallbackErrorPrefix(true, 'grok', 'claude', 'ko').includes('연결돼 있지 않아'));
});

test('authExcludedNoRunnerMsg: 러너 소진 문구가 "연결돼 있음+인증 오류"를 사실대로 말한다', async () => {
  const { authExcludedNoRunnerMsg } = await import('../src/runners.mjs');
  const ko = authExcludedNoRunnerMsg(['grok'], 'ko');
  assert.ok(ko.includes('Grok') && ko.includes('연결돼 있지만') && ko.includes('인증 오류'), '표시명+사실 사유');
  assert.ok(!ko.includes('하나도 연결돼 있지 않습니다'), '거짓 총부정 미노출');
  const en = authExcludedNoRunnerMsg(['grok', 'claude'], 'en');
  assert.ok(en.includes(`Grok/${RUNNERS.claude.name}`) && !en.match(/[가-힣]/), '복수 러너 병기 + 영어 모드');
});

test('배선: chat·oneshot 러너 소진 분기가 제외 목록을 먼저 본다(공허 통과 방지 앵커)', async () => {
  const { readFile } = await import('node:fs/promises');
  const chat = await readFile(new URL('../src/chat.mjs', import.meta.url), 'utf8');
  const oneshot = await readFile(new URL('../src/oneshot.mjs', import.meta.url), 'utf8');
  assert.ok(/__excludeRunners\?\.length\)\s*throw new Error\(authExcludedNoRunnerMsg/.test(chat), 'chat 배선');
  assert.ok(/__exclude\?\.length\)\s*throw new Error\(authExcludedNoRunnerMsg/.test(oneshot), 'oneshot 배선');
  assert.ok(/excluded:\s*wantExcluded/.test(chat), '에러 프리픽스에 제외 사유 전달');
});
