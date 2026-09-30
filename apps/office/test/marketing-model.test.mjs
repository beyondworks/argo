import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultPeriod, periodOrders } from '../src/business/dashboard-model.js';
import { campaignCards, effectOf, linkedTotals } from '../src/business/marketing-model.js';

test('all business surfaces select the same local calendar month with UTC report boundaries', () => {
  const date = new Date(2026, 8, 28, 0, 15);
  assert.deepEqual(defaultPeriod(date), { from: '2026-09-01', to: '2026-09-28', customer: null });
});

// 마케팅은 캠페인 카드 한 장씩(유건 9/29 "비전문가도 쓰게") — 보고서가 없는 캠페인도 0으로 카드가 나온다
test('campaign cards keep every campaign, merge period numbers and put active first', () => {
  const campaigns = [
    { id: 'old', name: '지난 전단지', status: 'archived', starts_on: '2026-01-01' },
    { id: 'b', name: '네이버', status: 'active', starts_on: '2026-08-01' },
    { id: 'c', name: '인스타', status: 'active', starts_on: '2026-09-01' },
    { id: 'p', name: '블로그', status: 'paused', starts_on: '2026-09-10' },
  ];
  const cards = campaignCards(campaigns, [{ id: 'b', spend: 1000, orders: 2, sales: 3000, paid: 1000 }, { id: null, orders: 3, sales: 500 }]);
  assert.deepEqual(cards.map((card) => card.id), ['c', 'b', 'p', 'old']);
  assert.deepEqual(cards.find((card) => card.id === 'b').stats, { spend: 1000, orders: 2, sales: 3000, paid: 1000 });
  assert.deepEqual(cards.find((card) => card.id === 'c').stats, { spend: 0, orders: 0, sales: 0, paid: 0 });
  assert.deepEqual(campaignCards([], null), []);
});

// 효과는 숫자 비율 대신 문장으로 — 광고비가 없으면 나눗셈을 하지 않는다
test('effect of a campaign reads as times of spend, or says what is missing', () => {
  assert.deepEqual(effectOf({ spend: 1000, sales: 3200 }), { kind: 'times', times: 3.2 });
  assert.deepEqual(effectOf({ spend: 1000, sales: 400 }), { kind: 'less' }); // 광고비보다 적으면 배수 대신 문장으로 — '0배'가 나오지 않게(분리 검수 LOW5)
  assert.deepEqual(effectOf({ spend: 100000, sales: 3000 }), { kind: 'less' });
  assert.deepEqual(effectOf({ spend: 1000, sales: 1000 }), { kind: 'times', times: 1 });
  assert.deepEqual(effectOf({ spend: 1000, sales: 0 }), { kind: 'noSales' });
  assert.deepEqual(effectOf({ spend: 0, sales: 5000 }), { kind: 'noSpend' });
  assert.deepEqual(effectOf({ spend: 0, sales: 0 }), { kind: 'empty' });
  assert.deepEqual(effectOf({ spend: 1000, sales: -300 }), { kind: 'noSales' }); // 환불로 음수가 되어도 "배"로 말하지 않는다
});

// 광고로 들어온 합계는 연결된 캠페인만(경로 모름은 따로 한 줄)
test('linked totals exclude deals that are not linked to a campaign', () => {
  const totals = linkedTotals([{ id: 'a', spend: 100, orders: 1, sales: 900, paid: 0 }, { id: 'b', spend: 50, orders: 1, sales: 100, paid: 100 }, { id: null, spend: 0, orders: 4, sales: 7000, paid: 7000 }]);
  assert.deepEqual(totals, { spend: 150, orders: 2, sales: 1000, paid: 100 });
});

// 분석의 거래 목록은 이 기간에 금액이 움직인 거래만(유건 9/29 — 기간 밖 ₩0 거래가 줄줄이 섞여 읽기 어려웠다)
test('period deal list drops deals whose every amount is zero in the period', () => {
  const rows = [{ id: 'a', sales: 0, invoiced: 0, paid: 0, receivable: 0 }, { id: 'b', sales: 100, invoiced: 0, paid: 0, receivable: 0 }, { id: 'c', sales: 0, invoiced: 0, paid: 0, receivable: 50 }, { id: 'd', sales: -30, invoiced: 0, paid: 0, receivable: 0 }];
  assert.deepEqual(periodOrders(rows).map((row) => row.id), ['b', 'c', 'd']);
  assert.deepEqual(periodOrders(undefined), []);
});
