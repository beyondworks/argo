// 1:1 화면 회의실 발언 카드 — 프롬프트 원문 대신 사장의 마지막 발언만(제보 2026-09-27 "구구절절 올라오게 하지 말라").
import test from 'node:test';
import assert from 'node:assert/strict';
import { viaSummary } from '../app/c/[ws]/crew/[slug]/via-summary.mjs';

const prompt = `지금 회의실에 있다 — 사장과 동료 크루가 함께 보는 방이다.

## 회의 대화 (최근)
사장: 첫 안건
페퍼: 의견
사장: @슈리 BM 어떻게 잡을까?
울프: 사장: 이라고 인용

## 지시
사장의 마지막 발언에 "슈리"로서 답하라.`;

test('회의실 발언은 사장의 마지막 발언만', () => {
  assert.equal(viaSummary('room', prompt), '@슈리 BM 어떻게 잡을까?');
});
test('회의 대화 절이 없으면 첫 줄 폴백', () => {
  assert.equal(viaSummary('room', '\n한 줄\n둘째'), '한 줄');
});
test('다른 배달 지시는 원문 그대로(카드가 두 줄로 접는다)', () => {
  assert.equal(viaSummary('crewmail', prompt), prompt);
});
