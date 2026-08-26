// 원샷 실패의 정직 표면 — 2026-08-26 실사고(곰대장 제보) 앵커.
//  ① 상표 정정: "Claude Code returned an error result"를 지우고 실제 러너명을 단다(이름: 원문 —
//     언어 중립, i18n은 상위 문구 담당). 잔여 "Claude Code" 언급도 비클로드 러너면 러너명으로(레거시 흡수).
//  ② 최종 실패 문구는 시도한 러너 **전부**의 원인을 나열한다(마지막 하나만 보이면 앞 원인이 증발)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrubSdkBrand } from '../src/runners.mjs';
import { formatOneShotFailure } from '../src/oneshot.mjs';

test('scrubSdkBrand — 상표 제거 + 러너명 접두, 잔여 Claude Code 언급 치환', () => {
  const raw = 'Claude Code returned an error result: API Error: 400 {"code":"invalid-argument","error":"Invalid request content: x"}';
  const out = scrubSdkBrand('grok', raw);
  assert.equal(out.startsWith('Grok: API Error: 400'), true, out);
  assert.doesNotMatch(out, /Claude Code/, '상표 잔존');
  assert.equal(scrubSdkBrand('claude', raw).startsWith('Claude: API Error'), true, 'claude도 제품명이 아니라 러너명 접두');
  assert.equal(scrubSdkBrand('grok', 'Claude Code process exited with code 1'), 'Grok process exited with code 1', '일반 언급 치환(레거시 흡수)');
  assert.equal(scrubSdkBrand('grok', 'plain vendor message'), 'plain vendor message', '상표 없는 문구는 무변경');
});

test('formatOneShotFailure — 러너별 원인 전부, 이름 중복 금지, 폴백에도 상표 없음', () => {
  const failures = [
    { runner: 'codex', msg: '러너 실행 실패 (exit 1): usage limit' },
    { runner: 'grok', msg: 'Grok: API Error: 400 invalid-argument' }, // scrub이 이미 이름을 단 형태
  ];
  const ko = formatOneShotFailure(failures, 'grok', new Error('x'), 'ko');
  assert.match(ko, /러너별 원인/);
  assert.match(ko, /Codex: 러너 실행 실패/);
  assert.match(ko, /Grok: API Error/);
  assert.doesNotMatch(ko, /Grok: Grok:/, '러너명 중복(검수 M2)');
  const en = formatOneShotFailure([], 'grok', new Error('Claude Code returned an error result: boom'), 'en');
  assert.match(en, /Grok: boom/); // 폴백 경로도 scrub을 탄다 — 상표가 남으면 red(검수 M6: || 단언 금지)
  assert.doesNotMatch(en, /Claude Code/);
});
