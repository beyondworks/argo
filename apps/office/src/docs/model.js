// 견적서·계약서 입력 모델 — 순수 함수(브라우저·노드 테스트 공용). 인트라넷 app/quote-contract/page.tsx + lib/docgen/*.ts의 규칙을 옮겼다.
// 금액: 공급가액 = Σ 단가×수량(원 단위 반올림 — 인트라넷 quote.ts:29-33), 부가세는 줄마다 과세 10% 원 미만 절사(오피스 장부 office_business_vat와 같다 —
// 거래에서 만든 견적서와 거래 카드의 부가세가 같은 값이 되게). 영세율·면세 줄은 0.
import { DOC, SAFE_NAME_RE } from './doc-text.js';

export const KINDS = ['quote', 'contract'];
export const PAYMENTS = ['split', 'full'];   // 분할(착수 50 / 완료 50) | 완납(100%)
export const IP_TYPES = ['service', 'product']; // 용역형 | 납품형
export const TAX_TYPES = ['taxable', 'zero', 'exempt'];
export const ROWS_PER_PAGE = 7; // 견적서 한 장에 넣는 항목 행 수(인트라넷 quote.ts:27)

const int = (v) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? n : 0; };
const s = (v, max = 2000) => (typeof v === 'string' ? v.slice(0, max) : v == null ? '' : String(v).slice(0, max));

/** 원화 정수 → 콤마(3000000 → "3,000,000") */
export const won = (n) => int(n).toLocaleString('en-US');

/** YYYY-MM-DD(로컬) — base 기준 days일 뒤 */
export function isoDay(days = 0, base = new Date()) {
  const d = new Date(base); d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export const emptyItem = () => ({ name: '', desc: '', unitPrice: '', qty: '1', taxType: 'taxable' });

/** 쓸 수 있는 항목만(이름이 있는 줄) — 숫자로 바꿔서 */
export function cleanItems(items = []) {
  return (Array.isArray(items) ? items : []).filter((it) => it && s(it.name).trim())
    .map((it) => ({ name: s(it.name, 200).trim(), desc: s(it.desc, 500).trim(), unitPrice: int(it.unitPrice), qty: int(it.qty), taxType: TAX_TYPES.includes(it.taxType) ? it.taxType : 'taxable' }));
}

export const lineSupply = (it) => int(it.unitPrice) * int(it.qty);
export const lineVat = (it) => ((it.taxType ?? 'taxable') === 'taxable' ? Math.floor(lineSupply(it) / 10) : 0);

/** 합계 — { supply, vat, total, allTaxable }. allTaxable이 아니면 서식의 "부가세 (10%)" 문구를 "부가세"로 */
export function docTotals(items = []) {
  const rows = (Array.isArray(items) ? items : []).filter((it) => it && s(it.name).trim());
  const supply = rows.reduce((n, it) => n + lineSupply(it), 0);
  const vat = rows.reduce((n, it) => n + lineVat(it), 0);
  return { supply, vat, total: supply + vat, allTaxable: rows.every((it) => (it.taxType ?? 'taxable') === 'taxable') };
}

const lines = (v) => (Array.isArray(v) ? v : s(v, 20000).split('\n')).map((x) => s(x, 1000).trim()).filter(Boolean);

/** 새 문서 입력값 */
export function emptyDoc(kind, today = isoDay()) {
  const base = { kind, title: '', customer: '', customerId: '', orderId: '', summary: '', date: today, items: [emptyItem()], option: { title: '', rows: [] } };
  if (kind === 'quote') return { ...base, terms: '', notes: '', validUntil: isoDay(14, new Date(`${today}T12:00:00`)), showValid: true };
  return {
    ...base, serviceSummary: '', purpose: '', party: { company: '', bizNo: '', ceo: '', address: '', contact: '', email: '' },
    scope: '', scopeNote: '', payment: 'split', ip: 'service', startBasis: '', schedule: '', method: '', deliverable: '', note: '',
  };
}

/** 검증 — 오류 사전 키 배열(빈 배열 = 통과). 인트라넷: 고객사 필수, 항목 1개 이상(page.tsx:86-87, 159-160) */
export function validateDoc(doc) {
  const errors = [];
  if (!s(doc?.customer).trim()) errors.push(doc?.kind === 'contract' ? 'docs.err.customerA' : 'docs.err.customer');
  if (!cleanItems(doc?.items).length) errors.push(doc?.kind === 'contract' ? 'docs.err.contractItems' : 'docs.err.items');
  if (cleanItems(doc?.items).some((it) => it.unitPrice < 0 || it.qty < 0 || it.unitPrice > 1e12 || it.qty > 1e6)) errors.push('docs.err.amount');
  if (docTotals(cleanItems(doc?.items)).total > 1e12) errors.push('docs.err.amount');
  if (doc?.kind === 'contract' && doc.party?.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(doc.party.email)) errors.push('docs.err.email');
  return [...new Set(errors)];
}

/** 서식에 넘길 견적서 값(인트라넷 QuoteInput) */
export function quoteInput(doc) {
  return {
    title: s(doc.title, 200).trim() || s(doc.customer, 200).trim(), customer: s(doc.customer, 200).trim(), summary: s(doc.summary, 300).trim(), date: doc.date || isoDay(),
    items: cleanItems(doc.items), option: optionOf(doc.option), terms: lines(doc.terms), notes: lines(doc.notes),
    validUntil: doc.showValid === false ? '' : (doc.validUntil || isoDay(14)),
  };
}

const optionOf = (o) => {
  const rows = (o?.rows ?? []).filter((r) => r && s(r.name).trim()).map((r) => ({ name: s(r.name, 100).trim(), unitPrice: int(r.unitPrice), condition: s(r.condition, 500).trim() }));
  return rows.length ? { title: s(o.title, 200).trim() || DOC.defaultOption, rows } : null;
};

/** 서식에 넘길 계약서 값(인트라넷 ContractInput) — 빈 칸 기본값은 인트라넷 page.tsx:166-175 */
export function contractInput(doc) {
  const customer = s(doc.customer, 200).trim();
  const serviceSummary = s(doc.serviceSummary, 300).trim() || DOC.defaultService;
  const party = doc.party ?? {};
  return {
    title: s(doc.title, 200).trim() || DOC.contractTitle(customer), customer, summary: s(doc.summary, 300).trim(), date: doc.date || isoDay(),
    serviceSummary, purpose: s(doc.purpose, 300).trim() || serviceSummary,
    party: { company: s(party.company, 200).trim() || customer, bizNo: s(party.bizNo, 20).trim(), ceo: s(party.ceo, 100).trim(), address: s(party.address, 500).trim(), contact: s(party.contact, 200).trim() },
    scope: lines(doc.scope), scopeNote: s(doc.scopeNote, 1000).trim(), items: cleanItems(doc.items), option: optionOf(doc.option),
    payment: PAYMENTS.includes(doc.payment) ? doc.payment : 'split', ip: IP_TYPES.includes(doc.ip) ? doc.ip : 'service',
    startBasis: s(doc.startBasis, 200).trim(), schedule: s(doc.schedule, 300).trim(), method: s(doc.method, 200).trim(),
    deliverable: s(doc.deliverable, 300).trim() || DOC.defaultDeliverable, note: s(doc.note, 1000).trim(),
  };
}

/** 문서 제목(목록·문서함) — "견적서 — 제목" / "계약서 — 제목"(인트라넷 routes title) */
export function docTitle(doc) {
  const head = DOC.kind[doc.kind === 'contract' ? 'contract' : 'quote'];
  const name = doc.kind === 'contract' ? contractInput(doc).title : (s(doc.title, 200).trim() || s(doc.customer, 200).trim());
  return `${head}${DOC.titleSep}${name}`;
}

/** 파일 이름에 쓸 수 있는 글자만(인트라넷 sanitize: 숫자·영문·한글·._-, 50자) */
export const safeName = (v, max = 50) => (s(v).replace(SAFE_NAME_RE, '_').slice(0, max) || DOC.fileFallback);
/** "<고객사>_견적서.pdf" / "<고객사>_계약서.pdf" */
export const docFilename = (doc) => `${safeName(doc.customer)}_${DOC.kind[doc.kind === 'contract' ? 'contract' : 'quote']}.pdf`;

/** 문서함 검색용 요약(인트라넷 routes summary) */
export function docSummary(doc) {
  const d = { customer: s(doc.customer), title: s(doc.title), summary: s(doc.summary), serviceSummary: s(doc.serviceSummary) };
  return DOC.summary[doc.kind === 'contract' ? 'contract' : 'quote'](d);
}

/** 거래(오피스 업무 원장)에서 문서 채우기 — 거래처 칸(대표자·사업자번호·주소·담당자·연락처·이메일)과 거래 줄(품목·단가·수량·과세) */
export function fromDeal(kind, { order, customer, lines: orderLines = [] }, today = isoDay()) {
  const doc = emptyDoc(kind, today);
  doc.orderId = order?.id ?? '';
  doc.customerId = customer?.id ?? order?.customer_id ?? '';
  doc.customer = customer?.name ?? '';
  doc.title = order?.title ?? '';
  const own = orderLines.filter((l) => l.order_id === order?.id);
  if (own.length) doc.items = own.map((l) => ({ name: l.name, desc: '', unitPrice: String(l.unit_price), qty: String((l.quantity ?? 0) - (l.returned ?? 0) || l.quantity), taxType: TAX_TYPES.includes(l.tax_type) ? l.tax_type : 'taxable' }));
  if (kind === 'contract') {
    doc.party = { company: customer?.name ?? '', bizNo: customer?.biz_no ?? '', ceo: customer?.ceo ?? '', address: customer?.address ?? '', contact: [customer?.manager, customer?.phone].filter(Boolean).join(' / '), email: customer?.email ?? '' };
    doc.serviceSummary = order?.title ?? '';
  }
  return doc;
}

/** 다른 문서에서 이어 쓰기(견적서 → 계약서): 거래처·거래·항목·옵션을 그대로 */
export function quoteToContract(quote, today = isoDay()) {
  const doc = emptyDoc('contract', today);
  return { ...doc, customer: quote.customer, customerId: quote.customerId ?? '', orderId: quote.orderId ?? '', title: '', summary: quote.summary ?? '', serviceSummary: quote.title || quote.summary || '', items: (quote.items ?? []).map((it) => ({ ...it })), option: quote.option ?? doc.option, party: { ...doc.party, company: quote.customer } };
}

/** 사업자등록증에서 읽은 값으로 갑 칸 채우기 — 읽은 값이 있는 칸만 바꾼다(인트라넷 page.tsx:151) */
export function applyBizcert(doc, fields = {}) {
  const party = { ...(doc.party ?? {}) };
  for (const k of ['company', 'bizNo', 'ceo', 'address']) if (fields[k]) party[k] = fields[k];
  return { ...doc, party, customer: doc.customer || fields.company || '' };
}

/** 거래처 이름 → 거래처 레코드(정확 일치 우선, 부분 일치는 1건일 때만 — 인트라넷 save.ts:9-19). 애매하면 null */
export function matchCustomer(name, customers = []) {
  const q = s(name).trim().normalize('NFC');
  if (!q) return null;
  const exact = customers.find((c) => s(c.name).trim().normalize('NFC') === q);
  if (exact) return exact;
  const part = customers.filter((c) => { const n = s(c.name).trim().normalize('NFC'); return n && (n.includes(q) || q.includes(n)); });
  return part.length === 1 ? part[0] : null;
}

/** 견적서로 거래 등록할 계획 — 거래처(없으면 새로)·품목(이름이 같은 상품·서비스, 없으면 새 서비스)·거래 줄. 실제 저장은 화면이 업무 원장 동작으로 한다 */
export function dealPlan(doc, { customers = [], items = [] }) {
  const rows = cleanItems(doc.items);
  const customer = (doc.customerId && customers.find((c) => c.id === doc.customerId)) || matchCustomer(doc.customer, customers);
  const lines = rows.map((it) => {
    const item = items.find((x) => s(x.name).trim().normalize('NFC') === it.name.normalize('NFC'));
    return { name: it.name, item_id: item?.id ?? null, newItem: item ? null : { name: it.name, kind: 'service', price: it.unitPrice }, quantity: Math.max(1, it.qty), unit_price: it.unitPrice, tax_type: it.taxType };
  });
  return { customer_id: customer?.id ?? null, newCustomer: customer ? null : { name: s(doc.customer, 200).trim() }, title: s(doc.title, 200).trim() || DOC.dealTitle(s(doc.customer, 180).trim()), lines };
}
