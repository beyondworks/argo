import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitEnvelope } from '../app/c/[ws]/crew/[slug]/envelope.mjs';

test('인트라넷 페이지 컨텍스트 봉투 — 본문은 그대로, 컨텍스트는 접힌 첨부', () => {
  const r = splitEnvelope('견적 확인해줘\n\n---\n[현재 페이지 컨텍스트] 견적서 · /quotes/12\n합계 1,200,000원\n품목 A');
  assert.equal(r.main, '견적 확인해줘');
  assert.deepEqual(r.parts, [{ label: '현재 페이지 컨텍스트', text: '견적서 · /quotes/12\n합계 1,200,000원\n품목 A' }]);
});

test('[최근 대화]+[지시] 구획 — 지시가 본문', () => {
  const r = splitEnvelope('[최근 대화]\nA: 안녕\nB: 네\n\n[지시]\n회신 초안 써줘');
  assert.equal(r.main, '회신 초안 써줘');
  assert.deepEqual(r.parts.map((p) => p.label), ['최근 대화']);
  assert.equal(r.parts[0].text, 'A: 안녕\nB: 네');
});

test('봉투 아님 — 평범한 대괄호는 건드리지 않는다', () => {
  assert.equal(splitEnvelope('[긴급] 오늘 회의 취소'), null);
  assert.equal(splitEnvelope(''), null);
});
