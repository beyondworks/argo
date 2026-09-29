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
