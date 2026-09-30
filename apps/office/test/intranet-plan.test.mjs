import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeCustomers, resolveDates, planMigration, expectedTotals, UNASSIGNED } from '../scripts/intranet-plan.mjs';

const cust = (id, company, extra = {}) => ({ id, company, manager: null, phone: null, email: null, category: '고객', status: '활성', notes: null, address: null, account: null, ...extra });
const deal = (id, customerId, status, extra = {}) => ({ id, title: `거래 ${id}`, customerId, status, supply: 10000000, vat: 1000000, total: 11000000, quoteDate: null, contractDate: null, invoiceDate: null, paidDate: null, notes: '', created: '2026-08-12T15:23:00.000Z', ...extra });

// 유건 9/29: 회사명이 중복이면 하나로 합친다
test('거래처 합치기: 공백·대소문자만 다른 회사명은 하나로, 빈 칸은 채우고 서로 다른 값은 메모에 남긴다', () => {
  const { customers, idToKey } = mergeCustomers([cust('a', '비욘드 웍스', { phone: '010-1', category: '협력사', status: '보류' }), cust('b', '비욘드웍스', { phone: '010-2', email: 'x@y.test' }), cust('c', 'Other')]);
  assert.equal(customers.length, 2);
  const b = customers.find((c) => c.name === '비욘드 웍스');
  assert.deepEqual([b.phone, b.email, b.category, b.status], ['010-1', 'x@y.test', 'partner', 'hold']);
  assert.match(b.notes, /phone: 010-2/);
  assert.equal(idToKey.get('a'), idToKey.get('b'));
  assert.deepEqual(b.redacted, ['account', 'biz_no'], '계좌·사업자번호는 처음부터 가린다');
});

test('날짜: 비어 있으면 앞 단계 날짜, 첫 단계는 뒤 단계 중 가장 이른 날짜(없으면 노션 생성일의 한국 날짜), 채운 단계는 표시', () => {
  assert.deepEqual(resolveDates({ quoteDate: '2026-07-01', contractDate: null, invoiceDate: '2026-07-10', paidDate: null }, ['quote', 'contract', 'invoice', 'paid']),
    { dates: { quote: '2026-07-01', contract: '2026-07-01', invoice: '2026-07-10', paid: '2026-07-10' }, estimated: ['contract', 'paid'] });
  assert.deepEqual(resolveDates({ quoteDate: null, contractDate: null, invoiceDate: '2026-07-10', paidDate: '2026-07-20' }, ['quote', 'contract', 'invoice', 'paid']).dates.quote, '2026-07-10');
  assert.deepEqual(resolveDates({ created: '2026-08-12T15:23:00.000Z' }, ['quote']).dates.quote, '2026-08-13', 'UTC 15:23 = 한국 8/13');
  assert.deepEqual(resolveDates({ quoteDate: '2026-07-10', contractDate: '2026-07-01' }, ['quote', 'contract']), { dates: { quote: '2026-07-10', contract: '2026-07-10' }, estimated: ['contract'] }, '앞 단계보다 이른 날짜는 앞 단계로');
});

test('계획: 상태별 단계, 과세 구분, 거래처 미지정, 메모, 취소 날짜 — 공용 단계 목록은 바뀌지 않는다', () => {
  const plan = planMigration({
    customers: [cust('a', 'A사')],
    deals: [
      deal('1', 'a', '입금완료', { quoteDate: '2026-07-01', notes: '비고' }),
      deal('2', null, '계약', { vat: 0, supply: 5000, total: 5000, quoteDate: '2026-07-02' }),
      deal('3', 'a', '취소', { quoteDate: '2026-07-03', contractDate: '2026-07-04' }),
      deal('4', 'a', '취소', { quoteDate: '2026-07-05' }),
    ],
  });
  const [d1, d2, d3, d4] = plan.deals;
  assert.deepEqual(d1.stages, ['quote', 'contract', 'invoice', 'paid']);
  assert.equal(d1.taxType, 'taxable'); assert.match(d1.memo.join('\n'), /비고/); assert.match(d1.memo.join('\n'), /추정한 날짜: 계약일 2026-07-01/);
  assert.equal(d2.taxType, 'exempt'); assert.match(d2.memo.join('\n'), /과세 구분/);
  assert.equal(plan.customers.find((c) => c.key === d2.customerKey).name, UNASSIGNED);
  assert.deepEqual([d3.cancelled, d3.stages, d3.dates.cancel], [true, ['quote', 'contract'], '2026-07-04']);
  assert.deepEqual([d4.stages, d4.dates.cancel], [['quote'], '2026-07-05'], '앞 취소 거래의 계약 단계가 새지 않는다');
  assert.equal(JSON.stringify(plan).includes('notion'), false, '원본 링크는 옮기지 않는다');
});

test('원본 합계가 공급가액+세액과 다르면 메모로 남긴다(분리 검수 LOW)', () => {
  const plan = planMigration({ customers: [cust('a', 'A')], deals: [deal('1', 'a', '계약', { total: 11000500 }), deal('2', 'a', '계약')] });
  assert.equal(plan.deals[0].totalMismatch, true); assert.match(plan.deals[0].memo.join('\n'), /원본 합계 11000500원/);
  assert.equal(plan.deals[1].totalMismatch, false);
});

test('대조 합계: 취소는 빠지고, 매출은 공급가액·청구와 입금은 부가세 포함', () => {
  const plan = planMigration({ customers: [cust('a', 'A')], deals: [deal('1', 'a', '입금완료'), deal('2', 'a', '계약'), deal('3', 'a', '취소')] });
  assert.deepEqual(expectedTotals(plan), { customers: 1, deals: 3, cancelled: 1, sales: 20000000, invoiced: 11000000, paid: 11000000, vat: 1000000 });
});
