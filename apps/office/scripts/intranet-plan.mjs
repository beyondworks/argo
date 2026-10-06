// 인트라넷 → 오피스 업무 이관 계획(유건 9/29). DB 없이 순수 변환만 — 실행은 intranet-migrate.mjs가 오피스 업무 기능(RPC)으로 한다.
// 이관이지 불러오기가 아니다: 인트라넷 원본 링크·페이지 id는 옮기지 않는다.

const CATEGORY = { 고객: 'customer', 협력사: 'partner', 공급사: 'supplier', 기타: 'other' }; // 14차: 공급사·기타도 그대로(예전에는 '고객'으로 바뀌었다)
const STATUS = { 활성: 'active', 보류: 'hold', 종료: 'closed' };
// 계좌·사업자번호는 처음부터 가린다(우클릭으로 해제)
export const DEFAULT_REDACTED = ['account', 'biz_no'];
export const UNASSIGNED = '(거래처 미지정)';
// 인트라넷 상태 → 오피스 단계 동작(견적 → 계약 → 계산서 발행 → 입금 완료, 취소는 따로)
const STAGES = { 견적: ['quote'], 계약: ['quote', 'contract'], 계산서발행: ['quote', 'contract', 'invoice'], 입금완료: ['quote', 'contract', 'invoice', 'paid'], 취소: ['quote'] };
const STAGE_FIELD = { quote: 'quoteDate', contract: 'contractDate', invoice: 'invoiceDate', paid: 'paidDate' };
const STAGE_LABEL = { quote: '견적일', contract: '계약일', invoice: '계산서발행일', paid: '입금일' };

const nameKey = (s) => String(s ?? '').normalize('NFC').replace(/\s+/g, '').toLowerCase();
const day = (s) => (s ? String(s).slice(0, 10) : null);
const kstDay = (iso) => (iso ? new Date(Date.parse(iso) + 9 * 3600e3).toISOString().slice(0, 10) : null);
const text = (s) => String(s ?? '').trim();
/** 오피스 입금 예정일로 받는 날짜인가(office_business_due와 같다: YYYY-MM-DD, 2000~2100년) */
const validDay = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s && s >= '2000-01-01' && s <= '2100-12-31';

/** 같은 회사명(공백·대소문자 무시)은 하나로 합친다. 빈 칸은 먼저 나온 값을 뒤의 값으로 채우고, 서로 다른 값은 메모에 남긴다 */
export function mergeCustomers(rows) {
  const byKey = new Map(), idToKey = new Map();
  for (const r of rows) {
    const key = nameKey(r.company) || nameKey(UNASSIGNED);
    idToKey.set(r.id, key);
    const next = {
      name: text(r.company) || UNASSIGNED, email: text(r.email), manager: text(r.manager), phone: text(r.phone), address: text(r.address),
      account: text(r.account), category: CATEGORY[text(r.category)] ?? 'customer', status: STATUS[text(r.status)] ?? 'active', notes: text(r.notes),
    };
    const cur = byKey.get(key);
    if (!cur) { byKey.set(key, { key, ...next, ceo: '', biz_no: '', redacted: DEFAULT_REDACTED }); continue; }
    for (const f of ['email', 'manager', 'phone', 'address', 'account']) {
      if (!cur[f]) cur[f] = next[f];
      else if (next[f] && next[f] !== cur[f]) cur.notes = [cur.notes, `${f}: ${next[f]}`].filter(Boolean).join('\n'); // 서로 다른 값은 버리지 않는다
    }
    if (next.notes && next.notes !== cur.notes) cur.notes = [cur.notes, next.notes].filter(Boolean).join('\n');
  }
  return { customers: [...byKey.values()], idToKey };
}

/** 단계마다 날짜를 정한다. 비어 있으면 앞 단계 날짜로 채우고(첫 단계는 뒤 단계 중 가장 이른 날짜, 없으면 노션 생성일), 채운 단계를 기록한다 */
export function resolveDates(deal, stages) {
  const known = Object.fromEntries(stages.map((s) => [s, day(deal[STAGE_FIELD[s]])]));
  const out = {}, estimated = [];
  let prev = null;
  stages.forEach((s, i) => {
    let d = known[s];
    if (d && prev && d < prev) { d = prev; estimated.push(s); } // 앞 단계보다 이른 날짜는 앞 단계 날짜로
    if (!d) {
      d = i === 0 ? (stages.slice(1).map((x) => known[x]).filter(Boolean).sort()[0] ?? kstDay(deal.created)) : prev;
      estimated.push(s);
    }
    out[s] = d; prev = d;
  });
  return { dates: out, estimated };
}

/** 이관 계획: 거래처(합침)·거래(단계·날짜·금액·메모). 실행기는 이 순서대로 오피스 기능을 호출한다 */
export function planMigration({ customers, deals }) {
  const merged = mergeCustomers(customers);
  const list = [...merged.customers];
  const plans = deals.map((d) => {
    let customerKey = merged.idToKey.get(d.customerId);
    if (!customerKey) {
      customerKey = nameKey(UNASSIGNED);
      if (!list.some((c) => c.key === customerKey)) list.push({ key: customerKey, name: UNASSIGNED, email: '', manager: '', phone: '', address: '', account: '', category: 'customer', status: 'active', notes: '', ceo: '', biz_no: '', redacted: DEFAULT_REDACTED });
    }
    const status = text(d.status) || '견적';
    const stages = [...(STAGES[status] ?? STAGES.견적)]; // 복사 — 취소 거래가 계약 단계를 더해도 공용 목록은 그대로
    const { dates, estimated } = resolveDates(d, stages);
    const total = Math.round(Number(d.total ?? 0));
    const vat = Math.round(Number(d.vat ?? 0));
    const supply = d.supply != null ? Math.round(Number(d.supply)) : total - vat;
    const taxType = vat > 0 ? 'taxable' : 'exempt';
    // 입금예정일(14차) — 날짜 부분만. 날짜로 읽을 수 없는 값은 옮기지 않고 메모에 남긴다(서버가 거절해 이관이 멈추지 않게)
    const dueRaw = text(d.dueDate), dueOn = validDay(day(dueRaw)) ? day(dueRaw) : null;
    const memo = [
      text(d.notes),
      vat === 0 && supply > 0 ? '부가세 0원으로 이관됨 — 과세 구분(면세·영세율) 확인 필요' : '',
      estimated.length ? `추정한 날짜: ${estimated.map((s) => `${STAGE_LABEL[s]} ${dates[s]}`).join(', ')}` : '',
      d.total != null && Math.round(Number(d.total)) !== supply + vat ? `원본 합계 ${Math.round(Number(d.total))}원과 공급가액+세액 ${supply + vat}원이 다름 — 확인 필요` : '',
      dueRaw && !dueOn ? `입금예정일 "${dueRaw}"을 날짜로 읽지 못해 옮기지 않음 — 확인 필요` : '',
    ].filter(Boolean);
    if (status === '취소') {
      if (day(d.contractDate)) { dates.contract = dates.quote > day(d.contractDate) ? dates.quote : day(d.contractDate); stages.push('contract'); }
      dates.cancel = [dates.quote, dates.contract, day(d.invoiceDate), day(d.paidDate)].filter(Boolean).sort().at(-1);
    }
    return { sourceId: d.id, totalMismatch: d.total != null && Math.round(Number(d.total)) !== supply + vat, customerKey, title: text(d.title).slice(0, 200) || '(제목 없음)', supply, vat, taxType, stages, cancelled: status === '취소', dates, dueOn, memo };
  });
  return { customers: list, deals: plans };
}

/** 이관 전후 대조용 합계 — 취소 거래는 매출·청구·미수금에서 빠진다 */
export function expectedTotals(plan) {
  const live = plan.deals.filter((d) => !d.cancelled);
  const gross = (d) => d.supply + d.vat;
  return {
    customers: plan.customers.length, deals: plan.deals.length, cancelled: plan.deals.length - live.length, due: plan.deals.filter((d) => d.dueOn).length,
    sales: live.filter((d) => d.stages.includes('contract')).reduce((a, d) => a + d.supply, 0),
    invoiced: live.filter((d) => d.stages.includes('invoice')).reduce((a, d) => a + gross(d), 0),
    paid: live.filter((d) => d.stages.includes('paid')).reduce((a, d) => a + gross(d), 0),
    vat: live.filter((d) => d.stages.includes('invoice')).reduce((a, d) => a + d.vat, 0),
  };
}
