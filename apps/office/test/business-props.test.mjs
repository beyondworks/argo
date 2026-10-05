// 거래·거래처 보강(오피스 14차 트랙 B) — 화면 규칙(deal-model.js)과 예시 원장(sample-business.js)이 서버 order.update·customer.archive와 같은 규칙인지.
// 서버 쪽은 test/office-business-props-pg.test.mjs(PG 드릴)가 잠근다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  overdueDays, customerSummary, attentionOf, filterCustomers, CUSTOMER_VIEWS, linkedDeals, amountEditable, lineInUse, orderUpdate, editForm, tasksMentioning, kstToday, dealAmounts,
} from '../src/business/deal-model.js';
import { seedBusiness, applyBusiness, upgradeSample, loadSample } from '../src/business/sample-business.js';
import { BUSINESS_UI_DICT } from '../src/business/ui-i18n.js';
import { BUSINESS_DICT } from '../src/business/i18n.js';

const TODAY = '2026-10-04';
const line = (order, extra = {}) => ({ id: `l-${order}`, order_id: order, item_id: 'svc', quantity: 1, returned: 0, fulfilled: 0, unit_price: 1000000, vat: 100000, tax_type: 'taxable', ...extra });
const ord = (id, extra = {}) => ({ id, customer_id: 'c1', title: id, status: 'confirmed', created_at: '2026-09-01', confirmed_at: '2026-09-02', due_on: null, ...extra });
const inv = (order, amount = 1100000) => ({ order_id: order, kind: 'invoice', amount, vat: 100000 });
const pay = (order, amount = 1100000) => ({ order_id: order, kind: 'payment', amount });

test('입금 지연 일수: 예정일이 지났고 입금이 다 되지 않았을 때만(견적·계약도 센다), 입금 완료·취소·예정일 없음·오늘·앞날은 0', () => {
  const at = (o, entries = []) => overdueDays(o, dealAmounts(o, [line(o.id)], entries), TODAY);
  assert.equal(at(ord('a', { due_on: '2026-09-29' }), [inv('a')]), 5, '계산서 발행 뒤 닷새 지남');
  assert.equal(at(ord('b', { due_on: '2026-09-29', status: 'draft', confirmed_at: null })), 5, '견적도 센다(인트라넷: 입금 완료·취소 빼고 전부)');
  assert.equal(at(ord('c', { due_on: '2026-09-29' }), [inv('c'), pay('c', 500000)]), 5, '나눠 받았어도 다 받지 않았으면 지연');
  assert.equal(at(ord('d', { due_on: '2026-09-29' }), [inv('d'), pay('d')]), 0, '입금 완료');
  assert.equal(at(ord('e', { due_on: '2026-09-29', status: 'cancelled' })), 0, '취소');
  assert.equal(at(ord('f', { due_on: TODAY })), 0, '오늘이 예정일이면 아직 아니다');
  assert.equal(at(ord('g', { due_on: '2026-10-30' })), 0);
  assert.equal(at(ord('h')), 0, '예정일 없음');
  assert.equal(at(ord('i', { due_on: '2025-10-04' })), 365, '해를 넘겨도 날 수로');
});

test('거래처 요약: 받은 돈 합계(환불 뺌·취소 제외), 진행 중 금액 = 아직 받지 않은 돈, 단계별 건수, 입금 지연은 오래된 순', () => {
  const data = {
    orders: [ord('q', { status: 'draft', confirmed_at: null }), ord('k'), ord('v', { due_on: '2026-10-01' }), ord('p', { due_on: '2026-09-20' }), ord('x', { status: 'cancelled' }), ord('w', { due_on: '2026-09-01' }), ord('other', { customer_id: 'c2' })],
    lines: ['q', 'k', 'v', 'p', 'x', 'w', 'other'].map((o) => line(o)),
    entries: [inv('v'), pay('v', 300000), inv('p'), pay('p'), { order_id: 'p', kind: 'refund', amount: 100000 }, inv('w'), inv('other'), pay('other')],
  };
  const s = customerSummary('c1', data, TODAY);
  assert.equal(s.paid, 300000 + 1100000 - 100000);
  assert.deepEqual(s.byStage, { quote: 1, contract: 1, invoice: 3 });
  assert.equal(s.open, 1100000 + 1100000 + (1100000 - 300000) + (1100000 - 1000000) + 1100000, '견적·계약은 합계 전부, 계산서 발행은 남은 돈만');
  assert.deepEqual(s.overdue.map((d) => [d.order.id, d.late]), [['w', 33], ['p', 14], ['v', 3]]);
});

test('챙길 것: 보관한 거래처는 빼고 계산서 미발행(계약 단계)·입금 지연을 거래처별로, 목록 거르기와 같은 기준', () => {
  const data = {
    customers: [{ id: 'c1', name: '가' }, { id: 'c2', name: '나' }, { id: 'c3', name: '다', archived_at: '2026-10-01T00:00:00Z' }, { id: 'c4', name: '라' }],
    orders: [ord('k1'), ord('k2'), ord('k3', { customer_id: 'c3' }), ord('late', { customer_id: 'c2', due_on: '2026-09-30' }), ord('paid', { customer_id: 'c4', due_on: '2026-09-01' })],
    lines: ['k1', 'k2', 'k3', 'late', 'paid'].map((o) => line(o)),
    entries: [inv('late'), inv('paid'), pay('paid')],
  };
  const a = attentionOf(data, TODAY);
  assert.deepEqual(a.counts, { uninvoiced: 2, overdue: 1 });
  assert.deepEqual([...a.uninvoiced.keys()], ['c1']);
  assert.deepEqual(a.overdue.get('c2').map((d) => d.late), [4]);
  const names = (view, missing) => filterCustomers(data.customers, view, a, missing).map((c) => c.name);
  assert.deepEqual(names('all'), ['가', '나', '라'], '전체는 보관한 곳을 뺀다');
  assert.deepEqual(names('archived'), ['다']);
  assert.deepEqual(names('uninvoiced'), ['가']);
  assert.deepEqual(names('overdue'), ['나']);
  assert.deepEqual(names('nobizcert', null), [], '문서함을 아직 못 읽었으면 비운다');
  assert.deepEqual(names('nobizcert', new Set(['c2', 'c3'])), ['나'], '보관한 곳은 사업자등록증 없음에서도 뺀다');
  assert.deepEqual(CUSTOMER_VIEWS, ['all', 'uninvoiced', 'nobizcert', 'overdue', 'archived']);
  assert.deepEqual(linkedDeals(['c1', 'c3'], { ...data, orders: [...data.orders, ord('gone', { status: 'cancelled' })], lines: [...data.lines, line('gone')] }), { count: 3, total: 3300000 }, '보관 확인 창: 취소 거래는 세지 않는다');
});

test('금액을 고칠 수 있나: 견적 단계일 때만(계약 금액은 성과 기록에 들어간다) — 재고 기록이 걸린 줄은 빼거나 바꿀 수 없다', () => {
  const data = { lines: [line('a'), line('b', { fulfilled: 1 }), line('c')], entries: [{ order_id: 'c', kind: 'credit', amount: 1 }], movements: [{ line_id: 'l-a' }] };
  assert.equal(amountEditable(ord('a', { status: 'draft' })), true, '견적');
  assert.equal(amountEditable(ord('a', { status: 'confirmed' })), false, '계약했으면 청구 전이라도 잠근다');
  assert.equal(amountEditable(ord('a', { status: 'draft' }), [{ order_id: 'a', kind: 'contract' }, { order_id: 'a', kind: 'reopen' }]), false, '견적으로 되돌린 거래도 잠근다 — 다시 계약하면 잠근 달 성과가 바뀐다');
  assert.equal(amountEditable(ord('a', { status: 'draft' }), [{ order_id: 'z', kind: 'contract' }]), true, '다른 거래의 계약 기록은 상관없다');
  assert.equal(amountEditable(ord('b', { status: 'confirmed' })), false, '납품 기록');
  assert.equal(amountEditable(ord('c', { status: 'confirmed' })), false, '청구 취소(감액) 기록');
  assert.equal(amountEditable(ord('a', { status: 'cancelled' })), false);
  assert.equal(lineInUse('l-a', data), true); assert.equal(lineInUse('l-c', data), false); assert.equal(lineInUse(undefined, data), false);
});

test('거래 고치기 보낼 값: 바뀐 칸만, 같은 값이면 null — 그대로 둔 줄은 저장된 세액을 같이 보낸다(이관 세액 지키기)', () => {
  const o = ord('o', { title: '원래', due_on: '2026-10-30' });
  const lines = [line('o', { id: 'l1', vat: 99999 }), line('o', { id: 'l2', unit_price: 500, vat: 0, tax_type: 'exempt' }), line('z', { id: 'other' })];
  const form = editForm(o, lines);
  assert.deepEqual(form.lines.map((l) => [l.id, l.keepVat]), [['l1', true], ['l2', true]], '다른 거래의 줄은 들어오지 않는다');
  assert.equal(orderUpdate(o, lines, form), null);
  assert.equal(orderUpdate(o, lines, { ...form, title: '  원래 ' }), null, '앞뒤 빈칸만 다르면 같은 건명');
  assert.deepEqual(orderUpdate(o, lines, { ...form, title: '새 건명', due_on: '' }), { id: 'o', title: '새 건명', due_on: null }, '날짜를 비우면 null');
  assert.deepEqual(orderUpdate(o, lines, { ...form, customer_id: 'c9' }), { id: 'o', customer_id: 'c9' });
  const changed = orderUpdate(o, lines, { ...form, lines: [{ ...form.lines[0], quantity: '2' }, form.lines[1]] });
  assert.deepEqual(changed.lines, [{ id: 'l1', item_id: 'svc', quantity: 2, unit_price: 1000000, tax_type: 'taxable' }, { id: 'l2', item_id: 'svc', quantity: 1, unit_price: 500, tax_type: 'exempt', vat: 0 }], '고친 줄은 세액을 다시 계산하게 빼고, 그대로 둔 줄은 세액을 함께');
  assert.deepEqual(orderUpdate(o, lines, { ...form, lines: [form.lines[0]] }).lines.map((l) => l.id), ['l1'], '줄을 빼면 남은 줄만');
  assert.equal(orderUpdate(o, lines, { ...form, lines: [...form.lines, { item_id: 'svc', quantity: 1, unit_price: 1 }] }).lines.length, 3, '새 줄');
  assert.equal(orderUpdate(o, lines, { ...form, lines: null }), null, '금액을 고칠 수 없는 거래는 줄을 보내지 않는다');
});

test('이름이 든 할 일: 제목·메모에서(NFC), 취소한 일은 빼고, 두 글자보다 짧은 이름은 맞추지 않는다', () => {
  const nfd = '한빛'.normalize('NFD');
  const tasks = [{ id: 1, title: `${nfd} 견적 회신` }, { id: 2, title: '세금 자료', note: '한빛코퍼레이션 담당자에게' }, { id: 3, title: '한빛 미팅', cancelled_at: '2026-10-01' }, { id: 4, title: '다른 일' }];
  assert.deepEqual(tasksMentioning(tasks, '한빛').map((x) => x.id), [1, 2]);
  assert.deepEqual(tasksMentioning(tasks, '한'), []);
  assert.deepEqual(tasksMentioning(tasks, ''), []);
});

test('오늘 한국 날짜: UTC 15시 이후는 다음 날', () => {
  assert.equal(kstToday(Date.parse('2026-10-03T15:00:00Z')), '2026-10-04');
  assert.equal(kstToday(Date.parse('2026-10-03T14:59:00Z')), '2026-10-03');
});

/* ── 예시 원장(5400 예시 서버 화면이 쓰는 것) — 서버와 같은 규칙 ── */
const NOW = Date.parse('2026-10-04T03:00:00Z');
const fresh = () => seedBusiness('beyondworks', NOW);
const throws = (fn, code) => assert.throws(fn, { message: code });

test('예시 원장 씨앗: 입금 예정일이 있고, 새벽베이커리 거래는 입금 지연 5일 · 예전 저장본에는 새 칸을 채운다', () => {
  const st = fresh();
  const bakery = st.orders.find((o) => o.title.includes('새벽'));
  assert.equal(overdueDays(bakery, dealAmounts(bakery, st.lines, st.entries), kstToday(NOW)), 5);
  assert.ok(st.customers.every((c) => c.archived_at === null));
  const old = JSON.parse(JSON.stringify(st));
  old.orders.forEach((o) => delete o.due_on); old.customers.forEach((c) => delete c.archived_at);
  assert.equal(upgradeSample(old, 'beyondworks', NOW), true);
  assert.deepEqual(old.orders.map((o) => o.due_on), st.orders.map((o) => o.due_on));
  assert.equal(upgradeSample(old, 'beyondworks', NOW), false, '이미 채운 원장은 그대로');
  const store = new Map([['argo-office-sample-business:beyondworks', JSON.stringify({ ...old, orders: old.orders.map(({ due_on, ...o }) => o) })]]);
  const loaded = loadSample({ getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) }, 'beyondworks');
  assert.ok(loaded.orders.every((o) => 'due_on' in o));
  assert.ok(JSON.parse(store.get('argo-office-sample-business:beyondworks')).orders.every((o) => 'due_on' in o), '채운 원장을 다시 저장한다');
});

test('예시 원장 거래 고치기: 건명은 언제든, 금액은 견적 단계까지, 같은 값은 기록 없이, 고친 기록에 이전 값', () => {
  const st = fresh();
  const draft = st.orders.find((o) => o.status === 'draft'), billed = st.orders.find((o) => st.entries.some((e) => e.order_id === o.id && e.kind === 'invoice'));
  const mine = (o) => st.lines.filter((l) => l.order_id === o.id);
  const n = st.activity.length;
  applyBusiness(st, 'order.update', { id: draft.id, title: draft.title, due_on: null, lines: mine(draft).map((l) => ({ id: l.id, item_id: l.item_id, quantity: l.quantity, unit_price: l.unit_price, tax_type: l.tax_type })) }, NOW);
  assert.equal(st.activity.length, n, '같은 값은 기록하지 않는다');
  const before = mine(draft).reduce((s, l) => s + l.quantity * l.unit_price + l.vat, 0);
  applyBusiness(st, 'order.update', { id: draft.id, lines: [{ id: mine(draft)[0].id, item_id: mine(draft)[0].item_id, quantity: 2, unit_price: 100 }] }, NOW);
  assert.deepEqual(mine(draft).map((l) => [l.quantity, l.unit_price, l.vat]), [[2, 100, 20]]);
  assert.deepEqual(st.activity.filter((a) => a.order_id === draft.id && a.kind === 'reprice').map((a) => [a.amount, a.note]), [[220, String(before)]]);
  throws(() => applyBusiness(st, 'order.update', { id: billed.id, lines: [{ item_id: mine(billed)[0].item_id, quantity: 1, unit_price: 1 }] }, NOW), 'business_amount_locked');
  // 계약만 하고 청구 전인 거래도 금액은 잠근다(성과 기록의 계약 금액이 바뀌지 않게) — 건명은 고친다
  applyBusiness(st, 'order.confirm', { id: draft.id }, NOW);
  const contracted = mine(draft).map((l) => [l.quantity, l.unit_price, l.vat]);
  throws(() => applyBusiness(st, 'order.update', { id: draft.id, lines: [{ id: mine(draft)[0].id, item_id: mine(draft)[0].item_id, quantity: 3, unit_price: 100 }] }, NOW), 'business_amount_locked');
  assert.deepEqual(mine(draft).map((l) => [l.quantity, l.unit_price, l.vat]), contracted);
  applyBusiness(st, 'order.update', { id: draft.id, title: '계약 뒤 새 건명' }, NOW);
  assert.equal(draft.title, '계약 뒤 새 건명');
  applyBusiness(st, 'order.update', { id: billed.id, title: '청구 뒤 새 건명', due_on: '2026-10-20' }, NOW);
  assert.equal(billed.title, '청구 뒤 새 건명');
  assert.deepEqual(st.activity.filter((a) => a.order_id === billed.id && ['retitle', 'due'].includes(a.kind)).map((a) => a.kind), ['retitle', 'due'], '이미 있던 예정일을 바꾸면 기록');
  throws(() => applyBusiness(st, 'order.update', { id: draft.id, due_on: '2026-13-01' }, NOW), 'business_due');
  throws(() => applyBusiness(st, 'order.update', { id: draft.id, title: ' ' }, NOW), 'business_input');
  throws(() => applyBusiness(st, 'order.update', { id: draft.id, customer_id: null }, NOW), 'business_input');
});

test('예시 원장 보관: 여러 곳을 한 번에, 하나라도 틀리면 그대로, 보관한 곳으로는 새 거래·옮기기 거절, 분류 4종', () => {
  const st = fresh();
  const [a, b, c] = st.customers, item = st.items[0], deal = st.orders.find((o) => o.customer_id === b.id);
  throws(() => applyBusiness(st, 'customer.archive', { ids: [a.id, 'missing'], on: true }, NOW), 'business_not_found');
  assert.equal(a.archived_at, null, '틀린 id가 섞이면 하나도 바꾸지 않는다');
  applyBusiness(st, 'customer.archive', { ids: [a.id, c.id], on: true }, NOW);
  assert.ok(a.archived_at && c.archived_at);
  throws(() => applyBusiness(st, 'order.create', { title: 'x', customer_id: a.id, lines: [{ item_id: item.id, quantity: 1, unit_price: 1 }] }, NOW), 'business_customer_archived');
  throws(() => applyBusiness(st, 'order.update', { id: deal.id, customer_id: a.id }, NOW), 'business_customer_archived');
  const at = a.archived_at;
  applyBusiness(st, 'customer.archive', { ids: [a.id], on: true }, NOW + 1000);
  assert.equal(a.archived_at, at, '이미 보관한 곳은 다시 쓰지 않는다');
  applyBusiness(st, 'customer.archive', { ids: [a.id], on: false }, NOW);
  applyBusiness(st, 'order.update', { id: deal.id, customer_id: a.id }, NOW);
  assert.equal(st.activity.filter((x) => x.order_id === deal.id && x.kind === 'move').at(-1).note, b.name);
  throws(() => applyBusiness(st, 'customer.archive', { ids: [], on: true }, NOW), 'business_input');
  applyBusiness(st, 'customer.save', { name: '공급처', category: 'supplier' }, NOW);
  applyBusiness(st, 'customer.save', { name: '기타처', category: 'other' }, NOW);
  throws(() => applyBusiness(st, 'customer.save', { name: 'x', category: 'vendor' }, NOW), 'business_input');
  applyBusiness(st, 'order.create', { title: '예정일', customer_id: b.id, due_on: '2026-11-01', lines: [{ item_id: item.id, quantity: 1, unit_price: 1 }] }, NOW);
  assert.equal(st.orders.at(-1).due_on, '2026-11-01');
});

test('예시 원장 기록 상한: 고친 기록은 거래마다 200번까지', () => {
  const st = fresh(), o = st.orders[0];
  for (let i = 0; i < 199; i++) st.activity.push({ id: `x${i}`, order_id: o.id, kind: 'retitle', at: '2026-10-01T00:00:00Z', note: '' });
  applyBusiness(st, 'order.update', { id: o.id, title: '200번째' }, NOW);
  throws(() => applyBusiness(st, 'order.update', { id: o.id, title: '201번째' }, NOW), 'business_edit_limit');
  assert.equal(o.title, '200번째');
});

test('사전: 14차 화면 글자는 한국어·영어 둘 다 있다', () => {
  const dict = { ...BUSINESS_DICT, ...BUSINESS_UI_DICT };
  const files = ['BusinessPage.jsx', 'Cards.jsx', 'DealBoard.jsx', 'CustomerAttention.jsx', 'CustomerLinks.jsx', 'OrderLines.jsx'].map((f) => readFileSync(new URL(`../src/business/${f}`, import.meta.url), 'utf8')).join('\n');
  const used = new Set([...files.matchAll(/label\('([\w.]+)'\)/g)].map((m) => `bizui.${m[1]}`).concat([...files.matchAll(/t\('((?:bizui|biz)\.[\w.]+)'/g)].map((m) => m[1])));
  for (const k of CUSTOMER_VIEWS) used.add(`bizui.cview.${k}`);
  for (const k of ['uninvoiced', 'nobizcert', 'overdue']) { used.add(`bizui.attn.${k}`); used.add(`bizui.attn.${k}Hint`); }
  for (const k of ['customer', 'partner', 'supplier', 'other']) used.add(`bizui.category.${k}`);
  for (const k of ['retitle', 'move', 'reprice', 'due']) used.add(`bizui.act.${k}`);
  for (const k of ['amountLocked', 'lineInUse', 'archived', 'editLimit', 'due']) used.add(`biz.error.${k}`);
  for (const k of used) {
    if (k.startsWith('biz.') && !k.startsWith('biz.error.') && !(k in dict)) continue; // 첫 화면 사전(core/i18n.js)에 있는 몇 개(biz.loading 등)
    assert.ok(Array.isArray(dict[k]) && dict[k][0] && dict[k][1], `사전에 없음: ${k}`);
  }
});
