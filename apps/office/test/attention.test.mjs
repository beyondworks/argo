// 18차 3번 — 홈 '챙길 것' 집계(business/attention-model.js)와 거래 쪽 계산 재사용(deal-model.js attentionOf)
import test from 'node:test';
import assert from 'node:assert/strict';
import { attentionRows } from '../src/business/attention-model.js';
import { attentionOf } from '../src/business/deal-model.js';

const base = '/o/acme';

// 이유: 급한 것부터(마감 지남 → 오늘 마감 → 결재 → 입금 지연 → 계산서 미발행), 0인 줄은 빼서 챙길 것만 남긴다
test('줄 순서와 0 빼기', () => {
  const { rows, pending } = attentionRows({ due: { overdue: 2, today: 0 }, approvals: 3, biz: { overdue: 1, uninvoiced: 0 } }, base);
  assert.deepEqual(rows.map((x) => [x.key, x.n]), [['overdue', 2], ['approvals', 3], ['late', 1]]);
  assert.equal(pending, false);
});

// 이유: 줄을 누르면 그 화면에서 같은 것만 보이게 — 할 일은 기한 거르기, 거래는 거래처 탭의 같은 보기(입금 지연·계산서 미발행)
test('누르면 갈 주소: 거르기 조건이 걸린 주소', () => {
  const { rows } = attentionRows({ due: { overdue: 1, today: 1 }, approvals: 1, biz: { overdue: 1, uninvoiced: 1 } }, base);
  assert.deepEqual(Object.fromEntries(rows.map((x) => [x.key, x.to])), {
    overdue: '/o/acme/tasks?due=overdue', today: '/o/acme/tasks?due=today', approvals: '/o/acme/approvals',
    late: '/o/acme/business/customers?view=overdue', uninvoiced: '/o/acme/business/customers?view=uninvoiced',
  });
  assert.deepEqual(Object.fromEntries(rows.map((x) => [x.key, x.tone])), { overdue: 'danger', today: 'warn', approvals: 'warn', late: 'danger', uninvoiced: 'warn' }, '늦은 것은 빨강 배지, 나머지는 주의 배지(색 막대 없음)');
});

// 이유: 모두 0이면 "챙길 것이 없습니다" 한 줄 — 단, 할 일·거래를 아직 읽는 중이면 그렇게 말하지 않는다(모르는 것을 없다고 하지 않게)
test('모두 0·읽는 중', () => {
  assert.deepEqual(attentionRows({ due: { overdue: 0, today: 0 }, approvals: 0, biz: { overdue: 0, uninvoiced: 0 } }, base), { rows: [], pending: false, taskFail: false });
  assert.equal(attentionRows({ due: null, approvals: 0, biz: null }, base).pending, true, '할 일을 아직 안 읽음');
  assert.equal(attentionRows({ due: { overdue: 0, today: 0 }, approvals: 0, biz: null, bizPending: true }, base).pending, true, '거래를 읽는 중');
  const off = attentionRows({ due: { overdue: 0, today: 0 }, approvals: 2, biz: null }, base);
  assert.deepEqual(off.rows.map((x) => x.key), ['approvals'], '업무 정보가 없거나 거래처를 꺼 두면 입금·계산서 줄은 없다');
  assert.equal(off.pending, false);
});

// 이유: 입금 지연·계산서 미발행은 거래처 탭 '챙길 것'과 같은 계산을 쓴다(같은 화면 두 곳의 숫자가 다르면 안 된다) — 보관한 거래처의 거래는 빼고, 입금 예정일이 지났는데 다 못 받은 거래만 지연
test('거래 수: 거래처 탭 챙길 것과 같은 계산', () => {
  const data = {
    customers: [{ id: 'c1', name: 'A' }, { id: 'c2', name: 'B', archived_at: '2026-10-01T00:00:00Z' }],
    orders: [
      { id: 'o1', customer_id: 'c1', status: 'confirmed', confirmed_at: '2026-09-01T00:00:00Z', due_on: '2026-09-30' },
      { id: 'o2', customer_id: 'c1', status: 'confirmed', confirmed_at: '2026-09-01T00:00:00Z' },
      { id: 'o3', customer_id: 'c2', status: 'confirmed', confirmed_at: '2026-09-01T00:00:00Z', due_on: '2026-09-01' },
    ],
    lines: [{ id: 'l1', order_id: 'o1', quantity: 1, returned: 0, unit_price: 1000, vat: 100 }, { id: 'l2', order_id: 'o2', quantity: 1, returned: 0, unit_price: 500, vat: 50 }, { id: 'l3', order_id: 'o3', quantity: 1, returned: 0, unit_price: 700, vat: 70 }],
    entries: [{ id: 'e1', order_id: 'o1', kind: 'invoice', amount: 1100 }],
  };
  const { counts } = attentionOf(data, '2026-10-04');
  const { rows } = attentionRows({ due: { overdue: 0, today: 0 }, approvals: 0, biz: counts }, base);
  assert.deepEqual(rows.map((x) => [x.key, x.n]), [['late', 1], ['uninvoiced', 1]]);
});
