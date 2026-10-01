import test from 'node:test';
import assert from 'node:assert/strict';
import { dealAmounts, dealStage, nextStep, revertStep, canCancel, vatOf, groupDeals, dealMonth, sortCustomers } from '../src/business/deal-model.js';

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

// 유건 9/30: 거래 '묶기' — 진행 상황(기본)·거래처·담당자·월. 칸이 틀리면 거래가 엉뚱한 곳에 보이거나 사라진다
const deal = (id, patch = {}, stage = 'contract') => ({ order: { id, customer_id: 'c1', owners: [], confirmed_at: null, ...patch }, stage });
test('묶기: 진행 상황은 네 칸이 늘 있다(빈 칸 포함), 모르는 묶기 값도 진행 상황', () => {
  const lanes = groupDeals([deal('a', {}, 'paid')], 'stage');
  assert.deepEqual(lanes.map((l) => [l.key, l.deals.length]), [['quote', 0], ['contract', 0], ['invoice', 0], ['paid', 1]]);
  assert.deepEqual(groupDeals([], 'nope').map((l) => l.key), ['quote', 'contract', 'invoice', 'paid']);
});
test('묶기: 거래처는 이름순(가나다), 담당자는 공동 담당이면 각자의 칸에·없으면 맨 끝 칸', () => {
  const names = { c1: '나래', c2: '가온', u1: '홍길동', u2: '김영희', none: '' };
  const deals = [deal('a', { customer_id: 'c1', owners: ['u1', 'u2'] }), deal('b', { customer_id: 'c2' }), deal('c', { customer_id: 'c1', owners: ['u1', 'u1'] })];
  assert.deepEqual(groupDeals(deals, 'customer', (k) => names[k]).map((l) => [l.key, l.deals.map((d) => d.order.id)]), [['c2', ['b']], ['c1', ['a', 'c']]]);
  assert.deepEqual(groupDeals(deals, 'owner', (k) => names[k]).map((l) => [l.key, l.deals.map((d) => d.order.id)]), [['u2', ['a']], ['u1', ['a', 'c']], ['none', ['b']]], '같은 사람이 두 번 적혀도 한 번만');
});
test('묶기: 월은 한국 날짜의 계약일 기준, 최근 달부터, 계약 전(견적)은 맨 끝', () => {
  assert.equal(dealMonth({ confirmed_at: '2026-08-31T15:30:00Z' }), '2026-09', 'UTC 8/31 15:30 = 한국 9/1');
  assert.equal(dealMonth({ confirmed_at: null }), null);
  const deals = [deal('a', { confirmed_at: '2026-07-10T00:00:00Z' }), deal('q', {}, 'quote'), deal('b', { confirmed_at: '2026-09-02T00:00:00Z' })];
  assert.deepEqual(groupDeals(deals, 'month').map((l) => [l.key, l.deals.map((d) => d.order.id)]), [['2026-09', ['b']], ['2026-07', ['a']], ['none', ['q']]]);
});

// 유건 9/30: 거래처 정렬 드롭다운 — 이름순·거래 건수순·최근 등록순
test('거래처 정렬: 이름순, 건수 많은 곳부터(같으면 이름순), 최근 등록순(등록일 없으면 뒤)', () => {
  const customers = [{ id: '1', name: '다온', created_at: '2026-09-01T00:00:00Z' }, { id: '2', name: '가람' }, { id: '3', name: '나무', created_at: '2026-09-20T00:00:00Z' }];
  const orders = [{ customer_id: '3' }, { customer_id: '1' }, { customer_id: '1' }];
  assert.deepEqual(sortCustomers(customers, orders, 'name').map((c) => c.name), ['가람', '나무', '다온']);
  assert.deepEqual(sortCustomers(customers, orders, 'deals').map((c) => c.name), ['다온', '나무', '가람']);
  assert.deepEqual(sortCustomers(customers, orders, 'recent').map((c) => c.name), ['나무', '다온', '가람']);
  assert.deepEqual(customers.map((c) => c.id), ['1', '2', '3'], '원본 배열은 그대로');
});
