// 예시 데이터 모드의 업무 원장 — 서버(office_business_read/write) 없이 이 브라우저에 거래처·거래·청구를 담는다(spec8 규칙 3: 예시 모드에서 화면이 다 돌아야 한다).
// 견적·계약 → 전자서명 → 거래 '계약' 흐름을 서버 없이 보여 주려고 만들었다. 규칙은 deal-model.js·office_business_write와 같게(단계는 장부에서 계산).
// 모든 사람·회사·번호는 가상이다. createBusinessClient와 같은 모양(subscribe·getSnapshot·refresh·mutate·call·report)을 돌려준다.
import { vatOf } from './deal-model.js';

const DAY = 86400000;
const iso = (t) => new Date(t).toISOString();
const fail = (message) => Object.assign(new Error(message), { code: message });
const uid = () => globalThis.crypto.randomUUID();
const kstDay = (t) => new Date(Date.parse(t) + 9 * 3600e3).toISOString().slice(0, 10);
const SETTINGS = { enabled: ['customers', 'catalog', 'orders', 'inventory', 'payments', 'analytics'], dashboards: [], performance: {}, version: 1 };

/** 예시 원장의 고정 id — 공간마다 다르다. 문서함 예시(files/sample.js)도 이 id로 거래처를 가리킨다(예시 거래처는 이 원장 하나 — 분리 검수 LOW 5) */
export const sampleId = (space, n) => `00000000-0000-4000-8000-${space === 'me' ? '1' : space === 'lean-studio' ? '2' : '3'}${String(n).padStart(11, '0')}`;

/** 공간별 첫 데이터 — 견적(초안) 하나, 계약 하나, 계산서 발행 하나, 입금 완료 하나 */
export function seedBusiness(space, now = Date.now()) {
  const C = (id, name, extra) => ({ id, name, email: '', notes: '', ceo: '', biz_no: '', manager: '', phone: '', address: '', account: '', category: 'customer', status: 'active', redacted: ['account', 'biz_no'], version: 1, created_at: iso(now - 40 * DAY), archived_at: null, ...extra });
  const id = (n) => sampleId(space, n);
  const customers = [
    C(id(1), '한빛코퍼레이션', { ceo: '이한빛', biz_no: '000-00-10001', manager: '박서준', phone: '010-0000-1001', email: 'sj.park@hanbit.example', address: '서울특별시 강남구 예시대로 100, 5층' }),
    C(id(2), '주식회사 오름', { ceo: '정오름', biz_no: '000-00-10002', manager: '김하늘', phone: '010-0000-1002', email: 'sky@orum.example', address: '경기도 성남시 분당구 예시로 20' }),
    C(id(3), '새벽베이커리', { ceo: '최새벽', biz_no: '', manager: '최새벽', phone: '010-0000-1003', email: 'dawn@bakery.example', address: '' }),
  ];
  const items = [
    { id: id(11), name: 'AI 업무 자동화 구축', kind: 'service', sku: 'SVC-AUTO', price: 3000000, stock: 0, reserved: 0, version: 1 },
    { id: id(12), name: '실무자 교육(1일)', kind: 'service', sku: 'SVC-EDU', price: 800000, stock: 0, reserved: 0, version: 1 },
    { id: id(13), name: '운영 지원(월)', kind: 'service', sku: 'SVC-OPS', price: 500000, stock: 0, reserved: 0, version: 1 },
  ];
  const O = (n, customer, title, extra) => ({ id: id(20 + n), customer_id: customer, title, status: 'draft', created_at: iso(now - (30 - n * 5) * DAY), confirmed_at: null, cancelled_at: null, redacted: [], source: null, referrer_customer_id: null, referrer_name: '', owners: [], due_on: null, ...extra });
  // 입금 예정일(14차): 계약 거래는 열흘 뒤, 계산서를 낸 새벽베이커리 거래는 닷새 지남(입금 지연 예시), 입금 끝난 거래는 지난 날짜
  const orders = [
    O(1, id(1), '한빛 AI 자동화 프로그램 구축', {}),
    O(2, id(2), '오름 업무 자동화 2건 + 교육', { status: 'confirmed', confirmed_at: iso(now - 12 * DAY), source: 'referral', due_on: kstDay(iso(now + 10 * DAY)) }),
    O(3, id(3), '새벽베이커리 주문 자동화', { status: 'confirmed', confirmed_at: iso(now - 20 * DAY), source: 'inbound', due_on: kstDay(iso(now - 5 * DAY)) }),
    O(4, id(2), '오름 9월 운영 지원', { status: 'confirmed', confirmed_at: iso(now - 28 * DAY), source: 'returning', due_on: kstDay(iso(now - 22 * DAY)) }),
  ];
  const L = (n, order, item, quantity, unit) => ({ id: id(40 + n), order_id: order, item_id: item.id, name: item.name, kind: item.kind, quantity, unit_price: unit, fulfilled: 0, returned: 0, tax_type: 'taxable', vat: vatOf(quantity * unit, 'taxable') });
  const lines = [L(1, id(21), items[0], 1, 3000000), L(2, id(21), items[1], 2, 800000), L(3, id(22), items[0], 2, 3000000), L(4, id(22), items[1], 1, 800000), L(5, id(23), items[0], 1, 2500000), L(6, id(24), items[2], 1, 500000)];
  const E = (n, order, kind, amount, at, supply = null, vat = null) => ({ id: id(60 + n), order_id: order, kind, amount, at: iso(at), note: '', supply, vat });
  const entries = [E(1, id(23), 'invoice', 2750000, now - 15 * DAY, 2500000, 250000), E(2, id(24), 'invoice', 550000, now - 25 * DAY, 500000, 50000), E(3, id(24), 'payment', 550000, now - 20 * DAY)];
  const A = (order, kind, at, amount = null) => ({ id: uid(), order_id: order, kind, at: iso(at), actor: null, amount, note: '' });
  const activity = [
    ...orders.map((o) => A(o.id, 'quote', Date.parse(o.created_at))),
    ...orders.filter((o) => o.confirmed_at).map((o) => A(o.id, 'contract', Date.parse(o.confirmed_at))),
    ...entries.map((e) => A(e.order_id, e.kind, Date.parse(e.at), e.amount)),
  ];
  return { customers, items, orders, lines, entries, movements: [], links: [], activity, settings: { ...SETTINGS }, can_write: true, can_manage: true };
}

const orderAmounts = (st, orderId) => {
  const own = st.lines.filter((l) => l.order_id === orderId);
  const supply = own.reduce((n, l) => n + (l.quantity - l.returned) * l.unit_price, 0);
  const vat = own.reduce((n, l) => n + Math.floor(Number(l.vat || 0) * (l.quantity - l.returned) / l.quantity), 0);
  const sum = (k) => st.entries.filter((e) => e.order_id === orderId && e.kind === k).reduce((n, e) => n + e.amount, 0);
  const invoiced = sum('invoice') - sum('credit'), paid = sum('payment') - sum('refund');
  return { supply, vat, total: supply + vat, invoiced, paid };
};
/** 날짜만 오면 오늘은 지금, 지난 날은 한국 정오(office_business_at과 같다) */
const atOf = (v, now) => {
  if (!v) return iso(now);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) { const t = Date.parse(v); if (!Number.isFinite(t)) throw fail('business_dates'); return iso(t); }
  if (v === kstDay(iso(now))) return iso(now);
  return new Date(`${v}T12:00:00+09:00`).toISOString();
};
const intIn = (v, lo, hi) => { const n = Number(v); if (!Number.isSafeInteger(n) || n < lo || n > hi) throw fail('business_number'); return n; };
/** 입금 예정일 — 'YYYY-MM-DD'(2000~2100년) 또는 비움(office_business_due와 같다) */
const dueOf = (v) => {
  if (v == null) return null;
  const t = typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? Date.parse(`${v}T00:00:00Z`) : NaN;
  if (!Number.isFinite(t) || new Date(t).toISOString().slice(0, 10) !== v || v < '2000-01-01' || v > '2100-12-31') throw fail('business_due');
  return v;
};
const CATEGORIES = ['customer', 'partner', 'supplier', 'other'];
const EDIT_KINDS = ['retitle', 'move', 'reprice', 'due'];
const grossOf = (lines) => lines.reduce((n, l) => n + l.quantity * l.unit_price + Number(l.vat || 0), 0);
const find = (list, id) => { const row = list.find((x) => x.id === id); if (!row) throw fail('business_not_found'); return row; };

/** 장부 동작 하나(제자리 수정) → { id } */
const ACTIONS = ['customer.save', 'item.save', 'stock.receive', 'order.create', 'link.remove', 'redact.set', 'redact.bulk', 'settings.save', 'order.confirm', 'order.reopen', 'order.cancel', 'entry.create', 'link.add', 'order.source', 'line.fulfill', 'line.return', 'line.tax', 'order.update', 'customer.archive'];
export function applyBusiness(st, action, p, now = Date.now()) {
  if (!ACTIONS.includes(action)) throw fail('business_action');
  const act = (order, kind, at, amount = null, note = '') => st.activity.push({ id: uid(), order_id: order, kind, at, actor: null, amount, note });
  if (action === 'customer.save') {
    if (!String(p.name ?? '').trim() || (p.category !== undefined && !CATEGORIES.includes(p.category))) throw fail('business_input');
    const fields = ['email', 'notes', 'ceo', 'biz_no', 'manager', 'phone', 'address', 'account', 'category', 'status'];
    if (p.id) { const c = find(st.customers, p.id); if (p.version != null && c.version !== p.version) throw fail('business_version_conflict'); Object.assign(c, { name: p.name.trim(), ...Object.fromEntries(fields.filter((k) => p[k] !== undefined).map((k) => [k, p[k]])), version: c.version + 1 }); return { id: c.id }; }
    const c = { id: uid(), name: p.name.trim(), email: '', notes: '', ceo: '', biz_no: '', manager: '', phone: '', address: '', account: '', category: 'customer', status: 'active', ...Object.fromEntries(fields.filter((k) => p[k] !== undefined).map((k) => [k, p[k]])), redacted: p.redacted ?? [], version: 1, created_at: iso(now), archived_at: null };
    st.customers.push(c); return { id: c.id };
  }
  if (action === 'item.save') {
    if (!String(p.name ?? '').trim() || !['service', 'product'].includes(p.kind)) throw fail('business_input');
    const price = intIn(p.price, 0, 1e12);
    if (p.id) { const it = find(st.items, p.id); Object.assign(it, { name: p.name.trim(), kind: p.kind, sku: p.sku ?? '', price, version: it.version + 1 }); return { id: it.id }; }
    const it = { id: uid(), name: p.name.trim(), kind: p.kind, sku: p.sku ?? '', price, stock: 0, reserved: 0, version: 1 }; st.items.push(it); return { id: it.id };
  }
  if (action === 'stock.receive') { const it = find(st.items, p.item_id); if (it.kind !== 'product') throw fail('business_product_only'); const q = intIn(p.quantity, 1, 1e6); it.stock += q; st.movements.push({ id: uid(), item_id: it.id, order_id: null, line_id: null, kind: 'receive', quantity: q, book_amount: 0, at: iso(now), note: p.note ?? '' }); return { id: it.id }; }
  if (action === 'order.create') {
    if (!String(p.title ?? '').trim() || !Array.isArray(p.lines) || !p.lines.length || p.lines.length > 100) throw fail('business_input');
    if (find(st.customers, p.customer_id).archived_at) throw fail('business_customer_archived'); // 보관한 거래처로는 새 거래를 만들지 않는다(14차)
    const o = { id: uid(), customer_id: p.customer_id, title: p.title.trim(), status: 'draft', created_at: iso(now), confirmed_at: null, cancelled_at: null, redacted: [], source: null, referrer_customer_id: null, referrer_name: '', owners: [], due_on: dueOf(p.due_on) };
    const lines = p.lines.map((l) => { const it = find(st.items, l.item_id); const q = intIn(l.quantity, 1, 1e6), u = intIn(l.unit_price, 0, 1e12), tax = ['taxable', 'zero', 'exempt'].includes(l.tax_type) ? l.tax_type : 'taxable'; return { id: uid(), order_id: o.id, item_id: it.id, name: it.name, kind: it.kind, quantity: q, unit_price: u, fulfilled: 0, returned: 0, tax_type: tax, vat: vatOf(q * u, tax) }; });
    st.orders.push(o); st.lines.push(...lines); act(o.id, 'quote', o.created_at); return { id: o.id };
  }
  if (action === 'link.remove') { const i = st.links.findIndex((l) => l.id === p.id); if (i < 0) throw fail('business_not_found'); st.links.splice(i, 1); return { id: p.id }; }
  if (action === 'redact.set' || action === 'redact.bulk') {
    for (const r of action === 'redact.bulk' ? p.items ?? [] : [p]) { const row = find(r.entity === 'order' ? st.orders : st.customers, r.id); const set = new Set(row.redacted ?? []); if (r.on) set.add(r.field); else set.delete(r.field); row.redacted = [...set]; }
    return { id: null };
  }
  if (action === 'settings.save') { st.settings = { ...st.settings, ...p, version: (st.settings.version ?? 1) + 1 }; return { id: null }; }
  if (action === 'customer.archive') { // 보관·되살리기 — 지우지 않고 보관 시각만, 이미 그 상태면 그대로(하나라도 틀리면 하나도 바꾸지 않는다)
    if (!Array.isArray(p.ids) || !p.ids.length || p.ids.length > 500 || typeof p.on !== 'boolean') throw fail('business_input');
    const rows = [...new Set(p.ids)].map((id) => find(st.customers, id));
    for (const c of rows) { if (p.on && !c.archived_at) c.archived_at = iso(now); else if (!p.on && c.archived_at) c.archived_at = null; }
    return { id: rows[0].id };
  }
  if (action === 'order.update') return updateOrder(st, p, now, act);
  // 거래 단위 동작
  const line = ['line.fulfill', 'line.return', 'line.tax'].includes(action) ? find(st.lines, p.id) : null;
  const ord = find(st.orders, line ? line.order_id : p.order_id ?? p.id);
  const amounts = orderAmounts(st, ord.id);
  if (action === 'order.confirm') {
    if (ord.status !== 'draft') throw fail('business_order_state');
    const at = atOf(p.at, now);
    if (at < ord.created_at) throw fail('business_dates');
    for (const l of st.lines.filter((x) => x.order_id === ord.id && x.kind === 'product')) { const it = find(st.items, l.item_id); if (it.stock - it.reserved < l.quantity) throw fail('business_insufficient_stock'); it.reserved += l.quantity; }
    Object.assign(ord, { status: 'confirmed', confirmed_at: at }); act(ord.id, 'contract', at); return { id: ord.id };
  }
  if (action === 'order.reopen') {
    if (ord.status !== 'confirmed' || amounts.invoiced > 0 || st.entries.some((e) => e.order_id === ord.id)) throw fail('business_order_state');
    for (const l of st.lines.filter((x) => x.order_id === ord.id && x.kind === 'product')) find(st.items, l.item_id).reserved -= l.quantity;
    Object.assign(ord, { status: 'draft', confirmed_at: null }); act(ord.id, 'reopen', iso(now)); return { id: ord.id };
  }
  if (action === 'order.cancel') {
    if (ord.status === 'cancelled' || amounts.paid > 0) throw fail('business_order_state');
    const at = atOf(p.at, now);
    if (amounts.invoiced > 0) st.entries.push({ id: uid(), order_id: ord.id, kind: 'credit', amount: amounts.invoiced, at, note: '', supply: null, vat: null });
    Object.assign(ord, { status: 'cancelled', cancelled_at: at }); act(ord.id, 'cancel', at); return { id: ord.id };
  }
  if (action === 'entry.create') {
    if (ord.status !== 'confirmed') throw fail('business_order_state');
    const max = { invoice: amounts.total - amounts.invoiced, credit: amounts.invoiced, payment: amounts.invoiced - amounts.paid, refund: amounts.paid }[p.kind];
    if (max === undefined) throw fail('business_input');
    const amount = intIn(p.amount, 1, 1e12);
    if (amount > max) throw fail('business_amount_exceeds_balance');
    const at = atOf(p.at, now);
    const split = ['invoice', 'credit'].includes(p.kind) && amounts.total ? Math.round(amount * amounts.supply / amounts.total) : null;
    const e = { id: uid(), order_id: ord.id, kind: p.kind, amount, at, note: p.note ?? '', supply: split, vat: split == null ? null : amount - split };
    st.entries.push(e); act(ord.id, p.kind, at, amount); return { id: e.id };
  }
  if (action === 'link.add') {
    if (!['page', 'mail', 'file', 'note'].includes(p.kind) || (p.kind === 'note' ? !String(p.body ?? '').trim() : !String(p.ref ?? '').trim())) throw fail('business_input');
    const l = { id: uid(), order_id: ord.id, kind: p.kind, ref: p.ref ?? '', title: p.title ?? '', body: p.body ?? '', created_at: iso(now), created_by: null };
    st.links.push(l); return { id: l.id };
  }
  if (action === 'order.source') { Object.assign(ord, { source: p.source ?? null, referrer_customer_id: p.referrer_customer_id ?? null, referrer_name: p.referrer_name ?? '' }); return { id: ord.id }; }
  if (action === 'line.fulfill') { const q = intIn(p.quantity, 1, line.quantity - line.fulfilled); line.fulfilled += q; if (line.kind === 'product') { const it = find(st.items, line.item_id); it.stock -= q; it.reserved -= q; } return { id: line.id }; }
  if (action === 'line.return') { const q = intIn(p.quantity, 1, line.fulfilled - line.returned); line.returned += q; find(st.items, line.item_id).stock += q; return { id: line.id }; }
  if (action === 'line.tax') { line.tax_type = p.tax_type; line.vat = vatOf(line.quantity * line.unit_price, p.tax_type); return { id: line.id }; }
  throw fail('business_action');
}

/** 거래 고치기(office_business_write 'order.update'와 같은 규칙) — 건명·거래처·입금 예정일은 언제든, 금액(줄)은 견적 단계까지(계약 금액이 성과 기록에 들어가므로). 바뀐 칸만 쓰고, 고친 내용은 이전 값과 함께 기록(거래마다 200번까지).
 *  검사를 모두 마친 뒤에 바꾼다 — 중간에 거절되면 원장이 반쯤 바뀌지 않게 */
function updateOrder(st, p, now, act) {
  const ord = find(st.orders, p.id);
  let title = ord.title, customer = ord.customer_id, due = ord.due_on ?? null, next = null;
  if ('title' in p) { if (typeof p.title !== 'string' || !p.title.trim() || p.title.trim().length > 200) throw fail('business_input'); title = p.title.trim(); }
  if ('due_on' in p) due = dueOf(p.due_on);
  if ('customer_id' in p) {
    if (typeof p.customer_id !== 'string') throw fail('business_input');
    const c = find(st.customers, p.customer_id);
    if (c.id !== ord.customer_id && c.archived_at) throw fail('business_customer_archived');
    customer = c.id;
  }
  const mine = st.lines.filter((l) => l.order_id === ord.id);
  if ('lines' in p) {
    if (!Array.isArray(p.lines) || !p.lines.length || p.lines.length > 100) throw fail('business_input');
    let total = 0; const seen = new Set();
    const norm = p.lines.map((l) => {
      const it = find(st.items, l.item_id), q = intIn(l.quantity, 1, 1e6), u = intIn(l.unit_price, 0, 1e12), tax = l.tax_type ?? 'taxable';
      if (!['taxable', 'zero', 'exempt'].includes(tax)) throw fail('business_input');
      const vat = l.vat != null ? intIn(l.vat, 0, 1e12) : vatOf(q * u, tax);
      if ((tax !== 'taxable' && vat !== 0) || vat > vatOf(q * u, 'taxable') + 10) throw fail('business_input');
      total += q * u + vat; if (total > 1e12) throw fail('business_total_limit');
      if (l.id) { if (!mine.some((x) => x.id === l.id)) throw fail('business_not_found'); if (seen.has(l.id)) throw fail('business_input'); seen.add(l.id); }
      return { id: l.id ?? null, item: it, quantity: q, unit_price: u, tax_type: tax, vat };
    });
    const changed = norm.length !== mine.length || norm.some((l) => { const o = l.id && mine.find((x) => x.id === l.id); return !o || o.item_id !== l.item.id || o.quantity !== l.quantity || o.unit_price !== l.unit_price || o.tax_type !== l.tax_type || o.vat !== l.vat; });
    if (changed) {
      if (ord.status !== 'draft' || st.activity.some((a) => a.order_id === ord.id && a.kind === 'contract')) throw fail('business_amount_locked'); // 계약한 적이 있는 거래·취소한 거래는 금액을 고치지 않는다(서버와 같다)
      next = norm;
    }
  }
  const logs = (title !== ord.title) + (customer !== ord.customer_id) + (next ? 1 : 0) + (due !== (ord.due_on ?? null) && !!ord.due_on);
  if (logs && st.activity.filter((a) => a.order_id === ord.id && EDIT_KINDS.includes(a.kind)).length + logs > 200) throw fail('business_edit_limit');
  if (next) { // 견적으로 되돌린 거래는 지난 재고 기록이 줄을 가리킨다 — 그 줄은 빼거나 다른 상품으로 바꾸지 않는다(재고는 계약할 때 잡으므로 견적 줄을 고쳐도 그대로)
    const used = (id) => st.movements.some((m) => m.line_id === id);
    for (const o of mine) if (!next.some((l) => l.id === o.id) && used(o.id)) throw fail('business_line_in_use');
    for (const l of next) { const o = l.id && mine.find((x) => x.id === l.id); if (o && o.item_id !== l.item.id && used(o.id)) throw fail('business_line_in_use'); }
  }
  // ── 여기서부터 바꾼다 ──
  if (next) {
    const before = grossOf(mine);
    st.lines = st.lines.filter((x) => x.order_id !== ord.id || next.some((l) => l.id === x.id));
    for (const l of next) {
      const row = l.id && st.lines.find((x) => x.id === l.id);
      if (row) Object.assign(row, { name: row.item_id === l.item.id ? row.name : l.item.name, item_id: l.item.id, kind: l.item.kind, quantity: l.quantity, unit_price: l.unit_price, tax_type: l.tax_type, vat: l.vat });
      else st.lines.push({ id: uid(), order_id: ord.id, item_id: l.item.id, name: l.item.name, kind: l.item.kind, quantity: l.quantity, unit_price: l.unit_price, fulfilled: 0, returned: 0, tax_type: l.tax_type, vat: l.vat });
    }
    act(ord.id, 'reprice', iso(now), grossOf(st.lines.filter((l) => l.order_id === ord.id)), String(before));
  }
  if (title !== ord.title) act(ord.id, 'retitle', iso(now), null, ord.title);
  if (customer !== ord.customer_id) act(ord.id, 'move', iso(now), null, st.customers.find((c) => c.id === ord.customer_id)?.name ?? '');
  if (due !== (ord.due_on ?? null) && ord.due_on) act(ord.id, 'due', iso(now), null, ord.due_on);
  Object.assign(ord, { title, customer_id: customer, due_on: due });
  return { id: ord.id };
}

/** 기간 보고(office_business_report와 같은 모양) */
export function reportBusiness(st, { from, to, customer = null }) {
  const orders = st.orders.filter((o) => !customer || o.customer_id === customer);
  const events = [];
  for (const o of orders) {
    const own = st.lines.filter((l) => l.order_id === o.id);
    if (o.confirmed_at) own.forEach((l) => events.push({ order: o, day: kstDay(o.confirmed_at), kind: l.kind, sales: l.quantity * l.unit_price, invoiced: 0, paid: 0, vat: 0 }));
    if (o.cancelled_at && o.confirmed_at) own.forEach((l) => events.push({ order: o, day: kstDay(o.cancelled_at), kind: l.kind, sales: -l.quantity * l.unit_price, invoiced: 0, paid: 0, vat: 0 }));
    for (const e of st.entries.filter((x) => x.order_id === o.id)) events.push({ order: o, day: kstDay(e.at), kind: null, sales: 0, invoiced: e.kind === 'invoice' ? e.amount : e.kind === 'credit' ? -e.amount : 0, paid: e.kind === 'payment' ? e.amount : e.kind === 'refund' ? -e.amount : 0, vat: e.kind === 'invoice' ? e.vat ?? 0 : e.kind === 'credit' ? -(e.vat ?? 0) : 0 });
  }
  const period = events.filter((e) => e.day >= from && e.day <= to);
  const sum = (rows, k) => rows.reduce((n, r) => n + r[k], 0);
  const group = (rows, key) => { const m = new Map(); rows.forEach((r) => { const k = key(r); m.set(k, [...(m.get(k) ?? []), r]); }); return m; };
  return {
    metrics: { sales: sum(period, 'sales'), invoiced: sum(period, 'invoiced'), paid: sum(period, 'paid'), receivable: events.filter((e) => e.day <= to).reduce((n, e) => n + e.invoiced - e.paid, 0), vat: sum(period, 'vat') },
    daily: [...group(period, (e) => e.day)].map(([date, rows]) => ({ date, sales: sum(rows, 'sales'), invoiced: sum(rows, 'invoiced'), paid: sum(rows, 'paid'), vat: sum(rows, 'vat') })).sort((a, b) => a.date.localeCompare(b.date)),
    sources: [...group(period, (e) => e.order.source ?? 'unknown')].map(([source, rows]) => ({ source, sales: sum(rows, 'sales') })).sort((a, b) => b.sales - a.sales),
    mix: [...group(period.filter((e) => e.kind), (e) => e.kind)].map(([kind, rows]) => ({ kind, amount: sum(rows, 'sales') })),
    orders: [...group(events.filter((e) => e.day <= to), (e) => e.order.id)].map(([id, rows]) => ({ id, title: rows[0].order.title, customer_id: rows[0].order.customer_id, sales: sum(rows.filter((r) => r.day >= from), 'sales'), invoiced: sum(rows.filter((r) => r.day >= from), 'invoiced'), paid: sum(rows.filter((r) => r.day >= from), 'paid'), receivable: sum(rows, 'invoiced') - sum(rows, 'paid') })),
  };
}

const KEY = (space) => `argo-office-sample-business:${space}`;
/** 저장소 — 브라우저는 localStorage, 테스트는 Map 같은 것 */
export function loadSample(storage, space) {
  try {
    const raw = storage.getItem(KEY(space));
    if (raw) { const st = JSON.parse(raw); if (upgradeSample(st, space)) saveSample(storage, space, st); return st; }
  } catch { /* 깨진 값은 새로 */ }
  return seedBusiness(space);
}
/** 14차 이전에 저장한 예시 원장에 새 칸을 채운다 — 씨앗과 같은 id의 거래는 씨앗의 입금 예정일, 나머지는 비움. 바꿨으면 true */
export function upgradeSample(st, space, now = Date.now()) {
  const orders = (st.orders ?? []).filter((o) => !('due_on' in o)), customers = (st.customers ?? []).filter((c) => !('archived_at' in c));
  if (!orders.length && !customers.length) return false;
  const seed = seedBusiness(space, now);
  for (const o of orders) o.due_on = seed.orders.find((s) => s.id === o.id)?.due_on ?? null;
  for (const c of customers) c.archived_at = null;
  return true;
}
export function saveSample(storage, space, st) { try { storage.setItem(KEY(space), JSON.stringify(st)); } catch { /* 용량·사생활 창 — 이 탭에서만 유지 */ } }

/** 예시 모드 업무 클라이언트 — 화면(useBusiness)이 서버 클라이언트 대신 쓴다 */
export function createSampleBusinessClient({ storage, space, now = () => Date.now(), people = [] }) {
  let snapshot = { data: null, loading: false, busy: false, error: null, uncertain: false, scopeKey: `sample:${space}` };
  const listeners = new Set();
  const emit = (patch) => { snapshot = { ...snapshot, ...patch }; listeners.forEach((fn) => fn()); };
  const refresh = async () => { const data = loadSample(storage, space); emit({ data, loading: false, error: null }); return data; };
  const mutate = async (action, payload) => {
    const st = structuredClone(loadSample(storage, space));
    emit({ busy: true });
    try {
      const result = applyBusiness(st, action, JSON.parse(JSON.stringify(payload ?? {})), now());
      saveSample(storage, space, st);
      emit({ data: st, busy: false, error: null });
      globalThis.dispatchEvent?.(new Event('office:biz-refresh'));
      globalThis.dispatchEvent?.(new CustomEvent('office:biz-written', { detail: action })); // 예시 모드도 같은 사건(core/biz-events.js, OFC-10)
      return result;
    } catch (error) { emit({ busy: false }); throw error; }
  };
  return {
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    getSnapshot: () => snapshot,
    refresh, mutate, retryPending: refresh,
    call: async (fn) => { if (fn === 'office_org_people') return people; throw fail('business_action'); },
    report: async (filters) => reportBusiness(loadSample(storage, space), filters),
    invalidate: () => {},
  };
}
