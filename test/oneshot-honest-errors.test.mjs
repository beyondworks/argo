// 원샷 실패의 정직 표면 — 2026-08-26 실사고(곰대장 제보) 앵커.
//  ① 상표 정정: SDK 배관 오류의 "Claude Code returned an error result"가 실제 러너명으로 바뀐다
//     (Grok의 xAI 400이 Claude 오류로 보여 진단이 엉뚱한 곳을 봤다 — 러너 중립성 규칙)
//  ② 최종 실패 문구는 시도한 러너 **전부**의 원인을 나열한다(마지막 하나만 보이면 앞 원인이 증발)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrubSdkBrand } from '../src/runners.mjs';
import { formatOneShotFailure } from '../src/oneshot.mjs';

test('scrubSdkBrand — 타 러너의 SDK 오류에서 Claude 상표를 실제 러너명으로', () => {
  const raw = 'Claude Code returned an error result: API Error: 400 {"code":"invalid-argument","error":"Invalid request content: x"}';
  const out = scrubSdkBrand('grok', raw);
  assert.ok(out.startsWith('Grok 러너 오류: API Error: 400'), out);
  assert.ok(!/Claude Code/.test(out), '상표 잔존');
  assert.equal(scrubSdkBrand('claude', raw).startsWith('Claude 러너 오류:'), true, 'claude도 제품명이 아니라 러너명으로');
  assert.equal(scrubSdkBrand('grok', 'plain vendor message'), 'plain vendor message', '상표 없는 문구는 무변경');
});

test('formatOneShotFailure — 러너별 원인 전부 나열, 대장이 비면 마지막 오류로 폴백', () => {
  const failures = [
    { runner: 'codex', msg: '러너 실행 실패 (exit 1): usage limit' },
    { runner: 'grok', msg: 'Grok 러너 오류: API Error: 400 invalid-argument' },
  ];
  const ko = formatOneShotFailure(failures, 'grok', new Error('x'), 'ko');
  assert.ok(ko.includes('Codex:') && ko.includes('Grok:'), ko);
  assert.ok(ko.includes('러너별 원인'), ko);
  const en = formatOneShotFailure([], 'grok', new Error('Claude Code returned an error result: boom'), 'en');
  assert.ok(en.includes('Grok 러너 오류: boom') || en.includes('Grok:'), en);
});
