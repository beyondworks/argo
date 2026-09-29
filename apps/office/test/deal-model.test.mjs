import test from 'node:test';
import assert from 'node:assert/strict';
import { dealAmounts, dealStage, nextStep, revertStep, canCancel, vatOf } from '../src/business/deal-model.js';

const order = (status = 'confirmed') => ({ id: 'o', status, created_at: '2026-07-01', confirmed_at: status === 'draft' ? null : '2026-07-02' });
const line = { order_id: 'o', quantity: 1, returned: 0, unit_price: 10000000, vat: 1000000 };
const e = (kind, amount, vat) => ({ order_id: 'o', kind, amount, vat });
const run = (o, entries) => { const a = dealAmounts(o, [line], entries); return { a, stage: dealStage(o, a), next: nextStep(o, a), back: revertStep(o, a) }; };

// 유건 9/29: 업무가 진행되는 순서대로, 처리 또는 완료를 누르면 다음 단계로 넘어간다(칸반)
test('단계 흐름: 견적 → 계약 → 계산서 발행 → 입금 완료, 버튼 하나가 장부 동작 하나', () => {
  let r = run(order('draft'), []);
  assert.deepEqual([r.stage, r.next.action, r.next.to], ['quote', 'order.confirm', 'contract']);
  r = run(order(), []);
  assert.deepEqual([r.stage, r.next.action, r.next.payload.kind, r.next.payload.amount], ['contract', 'entry.create', 'invoice', 11000000], '청구는 부가세 포함 합계');
  r = run(order(), [e('invoice', 11000000, 1000000)]);
  assert.deepEqual([r.stage, r.next.payload.kind, r.next.payload.amount], ['invoice', 'payment', 11000000]);
  r = run(order(), [e('invoice', 11000000, 1000000), e('payment', 5000000)]);
  assert.deepEqual([r.stage, r.next.payload.amount, r.a.receivable], ['invoice', 6000000, 6000000], '나눠 받으면 잔액만큼');
  r = run(order(), [e('invoice', 11000000, 1000000), e('payment', 11000000)]);
  assert.deepEqual([r.stage, r.next], ['paid', null]);
  assert.equal(run(order('cancelled'), []).stage, 'cancelled');
});

test('되돌리기: 반대 기록(청구 감액·환불)으로 한 단계 — 장부는 지우지 않는다', () => {
  assert.deepEqual(run(order(), []).back.action, 'order.reopen');
  assert.deepEqual(run(order(), [e('invoice', 11000000, 1000000)]).back.payload, { order_id: 'o', kind: 'credit', amount: 11000000, note: '' });
  assert.deepEqual(run(order(), [e('invoice', 11000000, 1000000), e('payment', 11000000)]).back.payload.kind, 'refund');
  assert.equal(run(order('draft'), []).back, null);
});

test('금액: 매출은 공급가액, 합계·청구·미수금은 부가세 포함 · 취소는 입금 전까지만', () => {
  const { a } = run(order(), [e('invoice', 11000000, 1000000), e('payment', 1)]);
  assert.deepEqual([a.supply, a.vat, a.total, a.invoicedVat, a.receivable], [10000000, 1000000, 11000000, 1000000, 10999999]);
  assert.equal(canCancel(order(), a), false);
  assert.equal(canCancel(order(), dealAmounts(order(), [line], [e('invoice', 11000000, 1000000)])), true);
  assert.deepEqual([vatOf(10000005, 'taxable'), vatOf(5000, 'exempt'), vatOf(5000, 'zero')], [1000000, 0, 0]);
});
