// 거래 단계·금액(유건 9/29). 단계는 따로 저장하지 않고 장부에서 계산한다 — DB(office_business_write)와 같은 규칙.
//   견적 = 작성 중, 계약 = 확정·청구 없음, 계산서 발행 = 청구 있음·입금 덜 됨, 입금 완료 = 합계만큼 청구·입금, 취소 = 취소 거래
// 매출은 공급가액, 청구·입금·받을 돈은 부가세 포함.

export const STAGES = ['quote', 'contract', 'invoice', 'paid'];

export function dealAmounts(order, lines, entries) {
  const own = lines.filter((line) => line.order_id === order.id);
  const supply = own.reduce((sum, line) => sum + (line.quantity - line.returned) * line.unit_price, 0);
  const vat = own.reduce((sum, line) => sum + Math.floor(Number(line.vat || 0) * (line.quantity - line.returned) / line.quantity), 0);
  const mine = entries.filter((entry) => entry.order_id === order.id);
  const sum = (kind, field = 'amount') => mine.filter((entry) => entry.kind === kind).reduce((n, entry) => n + Number(entry[field] || 0), 0);
  const invoiced = sum('invoice') - sum('credit'), paid = sum('payment') - sum('refund');
  return { supply, vat, total: supply + vat, invoiced, invoicedVat: sum('invoice', 'vat') - sum('credit', 'vat'), paid, receivable: invoiced - paid };
}

export function dealStage(order, amounts) {
  if (order.status === 'cancelled') return 'cancelled';
  if (order.status === 'draft') return 'quote';
  if (amounts.invoiced <= 0) return 'contract';
  return amounts.total > 0 && amounts.invoiced >= amounts.total && amounts.paid >= amounts.invoiced ? 'paid' : 'invoice';
}

/** 다음 단계로 넘기는 동작 — 버튼 하나가 실제 장부 동작 하나다 */
export function nextStep(order, amounts) {
  const stage = dealStage(order, amounts);
  if (stage === 'quote') return { stage, to: 'contract', action: 'order.confirm', payload: { id: order.id } };
  if (stage === 'contract') return { stage, to: 'invoice', action: 'entry.create', payload: { order_id: order.id, kind: 'invoice', amount: amounts.total - amounts.invoiced, note: '' } };
  if (stage === 'invoice' && amounts.invoiced < amounts.total) return { stage, to: 'invoice', action: 'entry.create', payload: { order_id: order.id, kind: 'invoice', amount: amounts.total - amounts.invoiced, note: '' } };
  if (stage === 'invoice') return { stage, to: 'paid', action: 'entry.create', payload: { order_id: order.id, kind: 'payment', amount: amounts.invoiced - amounts.paid, note: '' } };
  return null;
}

/** 한 단계 되돌리기 — 장부를 지우지 않고 반대 기록(청구 취소·환불)을 남긴다 */
export function revertStep(order, amounts) {
  const stage = dealStage(order, amounts);
  if (stage === 'contract') return { stage, to: 'quote', action: 'order.reopen', payload: { id: order.id } };
  if (stage === 'invoice' && amounts.paid > 0) return { stage, to: 'invoice', action: 'entry.create', payload: { order_id: order.id, kind: 'refund', amount: amounts.paid, note: '' } };
  if (stage === 'invoice') return { stage, to: 'contract', action: 'entry.create', payload: { order_id: order.id, kind: 'credit', amount: amounts.invoiced, note: '' } };
  if (stage === 'paid') return { stage, to: 'invoice', action: 'entry.create', payload: { order_id: order.id, kind: 'refund', amount: amounts.paid, note: '' } };
  return null;
}

/** 취소는 견적·계약·계산서 발행(입금 전)에서만 — 서버가 남은 청구를 취소한다 */
export const canCancel = (order, amounts) => ['quote', 'contract', 'invoice'].includes(dealStage(order, amounts)) && amounts.paid <= 0;

/** 단계에 들어간 날짜(기록에서) — 카드에 보여 준다 */
export function stageDate(order, activity) {
  const mine = activity.filter((a) => a.order_id === order.id);
  const last = (kinds) => mine.filter((a) => kinds.includes(a.kind)).map((a) => a.at).sort().at(-1) ?? null;
  return { quote: order.created_at, contract: order.confirmed_at, invoice: last(['invoice']), paid: last(['payment']), cancelled: order.cancelled_at };
}

/** 과세 10% 원 미만 절사(서버 office_business_vat와 같다) */
export const vatOf = (supply, taxType) => (taxType === 'taxable' ? Math.floor(Number(supply) / 10) : 0);

/** 한국 날짜의 달(YYYY-MM) — 분석과 같은 기준: 계약(확정)일. 아직 계약 전(견적)이면 null */
export const dealMonth = (order) => (order.confirmed_at ? new Date(Date.parse(order.confirmed_at) + 9 * 3600e3).toISOString().slice(0, 7) : null);

/** 거래 묶기(유건 9/30) — 진행 상황(기본)·거래처·담당자·월. deals: [{ order, amounts, stage }](취소 거래는 빼고 넘긴다).
 *  진행 상황은 네 칸이 늘 있고, 나머지는 있는 값만 — 거래처·담당자는 이름순, 월은 최근 달부터, 값이 없는 칸('none')은 맨 끝.
 *  공동 담당 거래는 담당자마다의 칸에 하나씩 놓인다(성과 기록이 공동 담당을 각자에게 남기는 것과 같다). 반환 [{ key, deals }] */
export const DEAL_GROUPS = ['stage', 'customer', 'owner', 'month'];
export function groupDeals(deals, by, name = (key) => key) {
  if (!DEAL_GROUPS.includes(by) || by === 'stage') return STAGES.map((key) => ({ key, deals: deals.filter((d) => d.stage === key) }));
  const lanes = new Map();
  const put = (key, deal) => { if (!lanes.has(key)) lanes.set(key, []); lanes.get(key).push(deal); };
  for (const deal of deals) {
    if (by === 'customer') put(deal.order.customer_id ?? 'none', deal);
    else if (by === 'month') put(dealMonth(deal.order) ?? 'none', deal);
    else if (deal.order.owners?.length) new Set(deal.order.owners).forEach((owner) => put(owner, deal));
    else put('none', deal);
  }
  const order = (a, b) => (a === 'none') - (b === 'none') || (by === 'month' ? b.localeCompare(a) : String(name(a)).localeCompare(String(name(b)), 'ko') || a.localeCompare(b));
  return [...lanes.keys()].sort(order).map((key) => ({ key, deals: lanes.get(key) }));
}

// ── 14차 트랙 B: 입금 예정일·입금 지연·거래처 요약·챙길 것·거래 고치기(서버 order.update와 같은 규칙) ──

/** 오늘 한국 날짜(YYYY-MM-DD) */
export const kstToday = (now = Date.now()) => new Date(now + 9 * 3600e3).toISOString().slice(0, 10);
const dayNo = (d) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 86400e3;

/** 입금 지연 일수 — 입금이 다 되지 않았고(입금 완료·취소 제외, 견적·계약도 센다 — 인트라넷과 같다) 입금 예정일이 오늘보다 앞이면 지난 날 수, 아니면 0 */
export function overdueDays(order, amounts, today = kstToday()) {
  if (!order.due_on) return 0;
  const stage = dealStage(order, amounts);
  if (stage === 'paid' || stage === 'cancelled') return 0;
  return Math.max(0, dayNo(today) - dayNo(String(order.due_on).slice(0, 10)));
}

/** 거래처 한 곳의 요약(거래처 카드) — 받은 돈 합계(환불 뺌, 취소 제외), 진행 중 금액(입금 완료 전 거래의 아직 받지 않은 돈)·단계별 건수, 입금 지연(오래된 순). 금액은 부가세 포함 */
export function customerSummary(customerId, data, today = kstToday()) {
  const deals = data.orders.filter((o) => o.customer_id === customerId).map((order) => {
    const amounts = dealAmounts(order, data.lines, data.entries);
    return { order, amounts, stage: dealStage(order, amounts), late: overdueDays(order, amounts, today) };
  });
  const live = deals.filter((d) => d.stage !== 'cancelled'), open = live.filter((d) => d.stage !== 'paid');
  return {
    deals,
    paid: live.reduce((n, d) => n + d.amounts.paid, 0),
    open: open.reduce((n, d) => n + Math.max(0, d.amounts.total - d.amounts.paid), 0),
    byStage: Object.fromEntries(['quote', 'contract', 'invoice'].map((s) => [s, open.filter((d) => d.stage === s).length])),
    overdue: open.filter((d) => d.late > 0).sort((a, b) => b.late - a.late),
  };
}

/** '챙길 것'(거래처 탭 위) — 보관하지 않은 거래처의 계산서 미발행(계약 단계) 거래·입금 지연 거래를 거래처별로. 반환 { uninvoiced: Map(거래처 → 거래들), overdue: Map(거래처 → 거래들, 오래된 순), counts } */
export function attentionOf(data, today = kstToday()) {
  const live = new Set(data.customers.filter((c) => !c.archived_at).map((c) => c.id));
  const uninvoiced = new Map(), overdue = new Map();
  const put = (m, k, v) => { if (!m.has(k)) m.set(k, []); m.get(k).push(v); };
  for (const order of data.orders) {
    if (!live.has(order.customer_id)) continue;
    const amounts = dealAmounts(order, data.lines, data.entries), stage = dealStage(order, amounts), late = overdueDays(order, amounts, today);
    if (stage === 'contract') put(uninvoiced, order.customer_id, { order, amounts });
    if (late > 0) put(overdue, order.customer_id, { order, amounts, late });
  }
  for (const list of overdue.values()) list.sort((a, b) => b.late - a.late);
  const total = (m) => [...m.values()].reduce((n, l) => n + l.length, 0);
  return { uninvoiced, overdue, counts: { uninvoiced: total(uninvoiced), overdue: total(overdue) } };
}

/** 거래처 목록 거르기 — 전체(보관 제외)·계산서 미발행·사업자등록증 없음(missing = 거래처 id 묶음, 아직 모르면 null)·입금 지연·보관함 */
export const CUSTOMER_VIEWS = ['all', 'uninvoiced', 'nobizcert', 'overdue', 'archived'];
export function filterCustomers(customers, view, attention, missing = null) {
  if (view === 'archived') return customers.filter((c) => c.archived_at);
  const live = customers.filter((c) => !c.archived_at);
  if (view === 'uninvoiced') return live.filter((c) => attention.uninvoiced.has(c.id));
  if (view === 'overdue') return live.filter((c) => attention.overdue.has(c.id));
  if (view === 'nobizcert') return missing ? live.filter((c) => missing.has(c.id)) : [];
  return live;
}

/** 보관 확인 창의 숫자 — 고른 거래처에 연결된 거래(취소 제외) 수와 합계(부가세 포함) */
export function linkedDeals(ids, data) {
  const set = new Set(ids);
  const live = data.orders.filter((o) => set.has(o.customer_id) && o.status !== 'cancelled');
  return { count: live.length, total: live.reduce((n, o) => n + dealAmounts(o, data.lines, data.entries).total, 0) };
}

/** 금액(줄)을 고칠 수 있나 — 견적 단계일 때만(서버 business_amount_locked와 같다). 계약 금액은 성과 기록에 들어가므로 계약한 거래부터는 청구·청구 취소로 기록한다 */
export const amountEditable = (order, activity = []) => order.status === 'draft' && !activity.some((a) => a.order_id === order.id && a.kind === 'contract'); // 견적으로 되돌린 거래도 잠긴다(다시 계약하면 잠근 달 성과가 바뀐다)
/** 재고 기록이 걸린 줄 — 빼거나 다른 상품으로 바꿀 수 없다(서버 business_line_in_use) */
export const lineInUse = (lineId, data) => !!lineId && (data.movements ?? []).some((m) => m.line_id === lineId);

/** 거래 수정 창의 처음 값 — 줄은 저장된 세액을 그대로 들고 시작한다(keepVat: 고치기 전까지 그 세액으로 합계를 보여 준다) */
export const editForm = (order, lines) => ({
  id: order.id, title: order.title, customer_id: order.customer_id, due_on: order.due_on ?? '',
  lines: lines.filter((l) => l.order_id === order.id).map((l) => ({ id: l.id, item_id: l.item_id, quantity: l.quantity, unit_price: l.unit_price, tax_type: l.tax_type ?? 'taxable', vat: l.vat, keepVat: true })),
});

/** 거래 고치기 보낼 값 — 바뀐 칸만 담는다(같은 값은 보내지 않는다). 그대로 둔 줄은 원래 세액을 같이 보내 직접 정한 세액(이관 값)을 지킨다. 바뀐 것이 없으면 null */
export function orderUpdate(order, oldLines, form) {
  const out = { id: order.id };
  const title = String(form.title ?? '').trim();
  if (title !== order.title) out.title = title;
  if (form.customer_id && form.customer_id !== order.customer_id) out.customer_id = form.customer_id;
  const due = form.due_on || null;
  if (due !== (order.due_on ?? null)) out.due_on = due;
  if (form.lines) {
    const mine = oldLines.filter((l) => l.order_id === order.id);
    const lines = form.lines.map((l) => {
      const row = { ...(l.id ? { id: l.id } : {}), item_id: l.item_id, quantity: Number(l.quantity), unit_price: Number(l.unit_price), tax_type: l.tax_type ?? 'taxable' };
      const old = l.id && mine.find((x) => x.id === l.id);
      return old && old.item_id === row.item_id && old.quantity === row.quantity && old.unit_price === row.unit_price && old.tax_type === row.tax_type ? { ...row, vat: old.vat } : row;
    });
    const same = lines.length === mine.length && lines.every((l) => l.vat !== undefined);
    if (!same) out.lines = lines;
  }
  return Object.keys(out).length > 1 ? out : null;
}

/** 이 거래처 이름이 제목·메모에 든 할 일(인트라넷 거래처 허브 '진행' 탭과 같은 이름 맞추기, NFC). 두 글자보다 짧은 이름은 맞추지 않는다(거의 모든 할 일에 걸린다) */
export function tasksMentioning(tasks, name) {
  const key = String(name ?? '').normalize('NFC').trim();
  if (key.length < 2) return [];
  return tasks.filter((x) => !x.cancelled_at && `${x.title ?? ''} ${x.note ?? ''}`.normalize('NFC').includes(key));
}

/** 거래처 정렬(유건 9/30) — 이름순·거래 건수순(많은 곳부터, 거래처 카드의 '관련 거래' 수와 같다)·최근 등록순(등록일이 없으면 이름순) */
export const CUSTOMER_SORTS = ['name', 'deals', 'recent'];
export function sortCustomers(customers, orders, by) {
  const count = new Map();
  for (const order of orders) count.set(order.customer_id, (count.get(order.customer_id) ?? 0) + 1);
  const byName = (a, b) => String(a.name).localeCompare(String(b.name), 'ko') || String(a.id).localeCompare(String(b.id));
  const rows = customers.slice();
  if (by === 'deals') return rows.sort((a, b) => (count.get(b.id) ?? 0) - (count.get(a.id) ?? 0) || byName(a, b));
  if (by === 'recent') return rows.sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')) || byName(a, b));
  return rows.sort(byName);
}
