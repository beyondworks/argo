// 에이전트 거래처·거래 도구(office_deals) — 오피스 17차 B-7(PARITY-customers T1~T3·T5~T7). 인트라넷 에이전트 도구 customers_list·customers_add·customers_update·
// deals_list·deals_add·deals_update를 아르고 오피스로 옮긴 것("에이전트도 오피스로 쓴다"). 명함·서류 붙이기(T4)는 문서함 도구(office_files attach)가 한다.
// 규칙은 회사·문서함 도구와 같다(office-audience.mjs officeTurn): 메신저 조직 채널의 그 조직만, 주인의 기기 세션으로만, 손님 턴은 chat.mjs가 먼저 거절,
// 손님·조직 밖 사람이 있을 수 있는 방에서는 다루지 않는다. 쓰기 권한(조직 관리자만)은 서버(office_business_write)가 판정한다.
// 서버: office_business_read(거래처·품목·거래·줄·장부 전부 한 번에) · office_business_write(트랙 B: customer.save·item.save·order.create·order.confirm·
//   entry.create·order.cancel·order.update). 단계는 따로 저장하지 않고 장부에서 계산한다(apps/office/src/business/deal-model.js와 같은 계산).
// · 거래처 고치기는 읽고 합쳐 쓴다 — customer.save가 모든 칸을 덮어쓰므로, 준 칸(빈 값 아님)만 바꾸고 나머지는 지금 값 그대로. 메모(notes)는 기존 메모 뒤에 덧붙인다.
// · 거래 추가는 같은 거래처(또는 이관의 '(거래처 미지정)')에 비슷한 건명이 있으면 쓰지 않고 후보를 보여 준다(confirm_duplicate=true일 때만 쓴다) — 인트라넷 우강마케팅 이중 계상 사고.
// · 단계 넘기기는 오피스 '다음 단계' 단추와 같다 — 동작 하나가 장부 기록 하나(계약 확정·계산서 발행·입금 기록·취소). 장부는 지우지 않는다.
// · 여럿이 보는 방에서는 거래처 계좌·사업자번호와 가림 표시한 칸(거래처 연락처 등·거래 건명·금액)을 싣지도 찾지도 않고, 그 칸 넣기·고치기도 주인과의 1:1에서만.
// · 새 거래처는 계좌·사업자번호를 가린 채로 만든다(오피스 화면·이관과 같은 기본 가림).
// 부하: 사람이 시킬 때만 부른다(폴링 없음). 목록·고치기 모두 읽기 1(+ 쓰기 1, 새 품목이 있으면 품목마다 쓰기 1).
// 바깥 글(S1): 거래처 이름·연락처·메모, 거래 건명·품목 이름은 남이 쓴 글이다 — 목록·자세히 결과는 경계 블록으로 감싼다(office-audience.mjs outsideOf).
import { randomUUID } from 'node:crypto';
import { officeTurn, ONLY_DM, refusalText, outsideOf, OUTSIDE_RULE } from './office-audience.mjs';

export const dealsDeps = {
  session: async () => (await import('./msgr.mjs')).sessionClient(),
  now: () => Date.now(),
  newId: () => randomUUID(),
};

const pick = (ko, en, lang) => (lang === 'en' ? en : ko);
const L = (lang) => (lang === 'en' ? 1 : 0);
const NAME = { ko: '거래처·거래 도구', en: 'customers and deals tool' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const LIST_CAP = 50;
const CATEGORY = { customer: ['고객', 'customer'], partner: ['협력사', 'partner'], supplier: ['공급사', 'supplier'], other: ['기타', 'other'] };
const CSTATUS = { active: ['활성', 'active'], hold: ['보류', 'on hold'], closed: ['종료', 'closed'] };
const STAGE = { quote: ['견적', 'quote'], contract: ['계약', 'contract'], invoice: ['계산서 발행', 'invoiced'], paid: ['입금 완료', 'paid'], cancelled: ['취소', 'cancelled'] };
const FIELDS = ['name', 'manager', 'phone', 'email', 'ceo', 'biz_no', 'address', 'account']; // 글자 칸 — 고치기에서 빈 값은 "안 바꿈"
const FIELD_NAME = { name: ['이름', 'name'], manager: ['담당', 'contact'], phone: ['전화', 'phone'], email: ['메일', 'email'], ceo: ['대표', 'CEO'], biz_no: ['사업자번호', 'business no.'],
  address: ['주소', 'address'], account: ['계좌', 'bank account'], category: ['분류', 'category'], status: ['상태', 'status'], notes: ['메모', 'notes'] };
const MAX = { name: 200, manager: 100, phone: 50, email: 320, ceo: 100, biz_no: 20, address: 500, account: 200 }; // 서버 검사와 같은 값
export const UNASSIGNED = '(거래처 미지정)'; // 이관이 만드는 거래처(apps/office/scripts/intranet-plan.mjs)
export const NEW_CUSTOMER_REDACT = ['account', 'biz_no']; // 새 거래처는 계좌·사업자번호를 가린 채로 시작(유건 9/29 기본 가림 — 오피스 화면 apps/office/src/business/cell-pick.js·이관과 같다)

const kstDay = (ms) => new Date(ms + 9 * 3600e3).toISOString().slice(0, 10);
const isDate = (d) => { if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d ?? ''))) return false; const ms = Date.parse(`${d}T00:00:00+09:00`); return Number.isFinite(ms) && kstDay(ms) === d; }; // 없는 날(2/30·13월)은 거절
const dayNo = (d) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 86400e3;
const one = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const digits = (s) => String(s ?? '').replace(/\D/g, '');
const won = (n, lang) => (lang === 'en' ? `KRW ${Math.round(n).toLocaleString('en-US')}` : `${Math.round(n).toLocaleString('ko-KR')}원`);
/** 이름·건명 비교용 — 대소문자·공백·기호·(주) 표기를 뺀다 */
export const norm = (s) => String(s ?? '').toLowerCase().replace(/\(주\)|㈜|주식회사/g, '').replace(/[\s\p{P}\p{S}]+/gu, '');
/** 비슷한 건명 — 같거나, 4자 이상이면서 한쪽이 다른 쪽을 품는다 */
export const similar = (a, b) => { const x = norm(a), y = norm(b); return !!x && !!y && (x === y || (Math.min(x.length, y.length) >= 4 && (x.includes(y) || y.includes(x)))); };

/* ── 금액·단계(apps/office/src/business/deal-model.js와 같은 계산 — DB office_business_write와 같은 규칙) ── */
export function dealAmounts(order, lines, entries) {
  const own = lines.filter((l) => l.order_id === order.id);
  const supply = own.reduce((n, l) => n + (l.quantity - l.returned) * l.unit_price, 0);
  const vat = own.reduce((n, l) => n + Math.floor(Number(l.vat || 0) * (l.quantity - l.returned) / l.quantity), 0);
  const mine = entries.filter((e) => e.order_id === order.id);
  const sum = (kind) => mine.filter((e) => e.kind === kind).reduce((n, e) => n + Number(e.amount || 0), 0);
  const invoiced = sum('invoice') - sum('credit'), paid = sum('payment') - sum('refund');
  return { supply, vat, total: supply + vat, invoiced, paid };
}
export function dealStage(order, m) {
  if (order.status === 'cancelled') return 'cancelled';
  if (order.status === 'draft') return 'quote';
  if (m.invoiced <= 0) return 'contract';
  return m.total > 0 && m.invoiced >= m.total && m.paid >= m.invoiced ? 'paid' : 'invoice';
}
const vatOf = (supply, tax) => (tax === 'taxable' ? Math.floor(supply / 10) : 0);

// 호출 이름은 글자 그대로 둔다 — 크루 계약 레지스트리(test/crew-contract.test.mjs)가 src/gateway의 rpc('…')를 찾아 분류를 강제한다
function unwrap({ data, error }) {
  if (error) throw Object.assign(new Error(error.message ?? String(error)), { rpc: true });
  return data;
}
const ERRORS = {
  business_forbidden: ['권한이 없다(거래처·거래 쓰기는 조직 관리자만, 읽기는 손님 아닌 멤버)', 'not allowed (only org admins write customers and deals)'],
  business_not_found: ['그 거래처·거래·품목이 없다 — 목록으로 다시 확인하라', 'not found — check the list again'],
  business_version_conflict: ['그새 다른 사람이 고쳤다 — 다시 읽고 고쳐라', 'someone changed it meanwhile — read again and retry'],
  business_input: ['입력이 올바르지 않다(이름 1~200자, 사업자번호는 숫자·하이픈 20자까지, 분류·상태 값)', 'invalid input'],
  business_customer_archived: ['보관한 거래처라 새 거래를 만들지 않는다 — 사람이 오피스 보관함에서 되살려야 한다', 'the customer is archived — a person restores it in Office first'],
  business_order_state: ['지금 단계에서는 그렇게 할 수 없다', 'not possible at the current stage'],
  business_amount_exceeds_balance: ['금액이 남은 금액보다 크다', 'the amount exceeds the remaining balance'],
  business_dates: ['날짜가 맞지 않다(20년 전~내일, 앞 단계 날짜보다 뒤)', 'invalid date (from 20 years ago to tomorrow, after the previous stage)'],
  business_due: ['입금 예정일은 YYYY-MM-DD(2000~2100년)', 'the due date must be YYYY-MM-DD (2000-2100)'],
  business_number: ['금액·수량은 0 이상 정수(수량 1~1,000,000)', 'amounts and quantities must be whole numbers (quantity 1-1,000,000)'],
  business_total_limit: ['합계 한도를 넘는다', 'over the total limit'],
  business_insufficient_stock: ['재고가 모자라 계약으로 넘길 수 없다', 'not enough stock to confirm'],
  business_kind: ['품목 종류가 올바르지 않다', 'invalid item kind'],
  business_idempotency_conflict: ['같은 요청 번호가 다른 내용으로 쓰였다 — 다시 시도하라', 'request key conflict — try again'],
  business_edit_limit: ['이 거래의 고친 기록 한도(200번)에 걸렸다', 'this deal reached its edit limit (200)'],
};

export async function dealsTool(args, { ctx = null, lang = 'ko', ownerId = null } = {}) {
  const a = args ?? {};
  const turn = await officeTurn({ ctx, ownerId, lang, session: dealsDeps.session, name: NAME });
  if (turn.text) return turn.text;
  const { c, org, owner } = turn;
  const today = kstDay(dealsDeps.now());
  const read = async () => unwrap(await c.client.rpc('office_business_read', { p_org: org })) ?? {};
  const write = async (action, data) => unwrap(await c.client.rpc('office_business_write', { p_org: org, p_key: dealsDeps.newId(), p_action: action, p_data: data }));
  const why = (code) => pick(`${ERRORS[code][0]}.`, `${ERRORS[code][1]}.`, lang); // 도구가 먼저 거절할 때(서버와 같은 사유)
  const hidden = pick(`(가림 — ${ONLY_DM(lang)})`, `(hidden — ${ONLY_DM(lang)})`, lang);
  const onlyDm = (what) => pick(`${what}은(는) ${ONLY_DM(lang)} 다룬다 — 여럿이 보는 방에 값을 올리지 않게. 주인에게 1:1로 부탁해 달라고 알려라.`, `${what} is handled ${ONLY_DM(lang)} so values are not posted where others read. Ask the owner to request it in a 1:1.`, lang);
  // 여럿이 보는 방에서 싣지도 찾지도 않는 칸 — 거래처 계좌·사업자번호(회사 도구의 계좌·세무 칸과 같다)·가림 표시한 칸, 거래의 가림 표시한 건명·금액
  const quietCustomer = (cu) => new Set(owner ? [] : ['account', 'biz_no', ...(cu.redacted ?? [])]);
  const titleOf = (o) => (!owner && (o.redacted ?? []).includes('title') ? hidden : one(o.title));
  const titleQ = (o) => (titleOf(o) === hidden ? hidden : ox.line(o.title)); // 출력용 — 가림 표시가 아니면 JSON 문자열(건명은 남이 쓴 글)
  const amountQuiet = (o) => !owner && (o.redacted ?? []).includes('amount');
  const ox = outsideOf('deals', lang);
  const DEAL_TEXT = ['거래처 이름·연락처·메모와 거래 건명은 사람들이 쓴 글', 'customer names, contacts, notes and deal titles written by people'];

  try {
    const d = await read();
    const customers = d.customers ?? [], orders = d.orders ?? [], lines = d.lines ?? [], entries = d.entries ?? [], items = d.items ?? [];
    const custName = new Map(customers.map((x) => [x.id, x.name]));
    const nameOf = (id) => (custName.has(id) ? ox.line(custName.get(id)) : '?');
    const deal = (o) => { const m = dealAmounts(o, lines, entries); const stage = dealStage(o, m); const late = o.due_on && !['paid', 'cancelled'].includes(stage) ? Math.max(0, dayNo(today) - dayNo(String(o.due_on).slice(0, 10))) : 0; return { o, m, stage, late }; };
    const dealLine = ({ o, m, stage, late }) => {
      const bits = [`[${STAGE[stage][L(lang)]}] ${titleQ(o)}`, nameOf(o.customer_id)];
      if (amountQuiet(o)) bits.push(`${pick('금액', 'amount', lang)} ${hidden}`);
      else bits.push(`${pick('합계', 'total', lang)} ${won(m.total, lang)}(${pick('공급', 'supply', lang)} ${won(m.supply, lang)}·${pick('부가세', 'VAT', lang)} ${won(m.vat, lang)})`, `${pick('청구', 'invoiced', lang)} ${won(m.invoiced, lang)}`, `${pick('입금', 'paid', lang)} ${won(m.paid, lang)}`);
      if (o.due_on) bits.push(`${pick('입금 예정', 'due', lang)} ${String(o.due_on).slice(0, 10)}${late ? pick(`(입금 지연 ${late}일)`, ` (${late} days overdue)`, lang) : ''}`);
      bits.push(`${pick('견적일', 'quoted', lang)} ${kstDay(Date.parse(o.created_at))}`, `id=${o.id}`);
      return `- ${bits.join(' · ')}`;
    };
    const customerLine = (cu, full = false) => {
      const q = quietCustomer(cu);
      const val = (k) => (q.has(k) && cu[k] ? hidden : ox.line(cu[k]));
      const n = orders.filter((o) => o.customer_id === cu.id && o.status !== 'cancelled').length;
      const bits = [ox.line(cu.name), CATEGORY[cu.category]?.[L(lang)] ?? cu.category, CSTATUS[cu.status]?.[L(lang)] ?? cu.status];
      for (const k of full ? ['manager', 'phone', 'email', 'ceo', 'biz_no', 'address', 'account'] : ['manager', 'phone', 'email', 'biz_no']) if (cu[k]) bits.push(`${FIELD_NAME[k][L(lang)]} ${val(k)}`);
      bits.push(pick(`거래 ${n}건`, `${n} deals`, lang));
      if (cu.archived_at) bits.push(pick('보관함', 'archived', lang));
      return `- ${bits.join(' · ')} · id=${cu.id}`;
    };

    if (a.action === 'customers') {
      if (a.id) {
        const cu = customers.find((x) => x.id === a.id);
        if (!cu) return pick(`id=${a.id} 거래처가 없다 — customers로 확인하라.`, `No customer id=${a.id} — check with customers.`, lang);
        const ds = orders.filter((o) => o.customer_id === cu.id).map(deal).sort((x, y) => String(y.o.created_at).localeCompare(String(x.o.created_at))); // 최근 견적순
        const live = ds.filter((x) => x.stage !== 'cancelled');
        const quietNotes = quietCustomer(cu).has('notes');
        return ox.block([customerLine(cu, true).replace(/^- /, ''),
          ...(cu.notes ? [`${pick('메모', 'notes', lang)}: ${quietNotes ? hidden : ox.text(String(cu.notes).slice(0, 500))}`] : []),
          live.every((x) => !amountQuiet(x.o)) ? pick(`받은 돈 ${won(live.reduce((n, x) => n + x.m.paid, 0), lang)} · 진행 중 ${won(live.filter((x) => x.stage !== 'paid').reduce((n, x) => n + Math.max(0, x.m.total - x.m.paid), 0), lang)}`,
            `Received ${won(live.reduce((n, x) => n + x.m.paid, 0), lang)} · open ${won(live.filter((x) => x.stage !== 'paid').reduce((n, x) => n + Math.max(0, x.m.total - x.m.paid), 0), lang)}`, lang) : '',
          ...(ds.length ? [pick(`거래 ${ds.length}건:`, `${ds.length} deals:`, lang), ...ds.slice(0, 20).map(dealLine)] : [pick('거래 없음', 'No deals', lang)])].filter(Boolean), DEAL_TEXT);
      }
      let list = customers.filter((x) => (a.archived ? x.archived_at : !x.archived_at));
      const q = one(a.q).toLowerCase();
      // 가린 칸은 검색 대상에서도 뺀다 — 여럿이 보는 방에서 검색어로 가린 값을 떠보지 못하게(2차 분리 검수 LOW-3)
      if (q) list = list.filter((x) => { const quiet = quietCustomer(x), open = (k) => (quiet.has(k) ? '' : x[k] ?? ''); const hay = ['name', 'manager', 'email', 'phone', 'ceo', 'biz_no'].map(open).join('\n').toLowerCase(); return hay.includes(q) || (digits(q).length >= 3 && digits(`${open('phone')}${open('biz_no')}`).includes(digits(q))); });
      if (!list.length) return pick('조건에 맞는 거래처가 없다.', 'No customers match.', lang);
      return [pick(`거래처 ${list.length}곳${a.archived ? '(보관함)' : ''}(이름 · 분류 · 상태 · 연락처 · 거래 수 · id):`, `${list.length} customers${a.archived ? ' (archived)' : ''} (name · category · status · contacts · deals · id):`, lang),
        ox.block(list.slice(0, LIST_CAP).map((x) => customerLine(x)), DEAL_TEXT),
        ...(list.length > LIST_CAP ? [pick(`…외 ${list.length - LIST_CAP}곳 — q로 좁혀라.`, `…and ${list.length - LIST_CAP} more — narrow with q.`, lang)] : []),
        pick('자세히는 customers에 id, 고치기는 customer_set.', 'Pass id to customers for details; customer_set to edit.', lang)].join('\n');
    }

    // 거래처 칸 검사(추가·고치기 공통) — 서버 검사와 같은 값
    const badField = (vals) => {
      for (const k of FIELDS) if (vals[k] != null && String(vals[k]).length > MAX[k]) return pick(`${FIELD_NAME[k][0]}은(는) ${MAX[k]}자까지.`, `${FIELD_NAME[k][1]} is limited to ${MAX[k]} chars.`, lang);
      if (vals.biz_no != null && !/^[0-9-]{0,20}$/.test(vals.biz_no)) return pick('사업자번호는 숫자와 하이픈만.', 'The business number takes digits and hyphens only.', lang);
      if (vals.category != null && !CATEGORY[vals.category]) return pick('category는 customer·partner·supplier·other 중 하나.', 'category must be customer, partner, supplier or other.', lang);
      if (vals.status != null && !CSTATUS[vals.status]) return pick('status는 active·hold·closed 중 하나.', 'status must be active, hold or closed.', lang);
      return null;
    };
    const given = (k) => (a[k] != null && one(a[k]) !== '' ? one(a[k]) : undefined); // 빈 값은 "안 줌"(빈 칸으로 덮어쓰지 않는다)

    if (a.action === 'customer_add') {
      const name = given('name');
      if (!name) return pick('customer_add에는 name(회사·거래처 이름)이 필요하다.', 'customer_add needs a name.', lang);
      const vals = Object.fromEntries([...FIELDS, 'category', 'status'].map((k) => [k, given(k)]).filter(([, v]) => v !== undefined));
      const bad = badField(vals); if (bad) return bad;
      const quietNew = ['account', 'biz_no'].filter((k) => vals[k]); // 새 거래처에서 가려지는 칸 — 고치기와 같이 1:1에서만 넣는다
      if (!owner && quietNew.length) return onlyDm(quietNew.map((k) => FIELD_NAME[k][L(lang)]).join(pick('·', ', ', lang)));
      const notes = String(a.notes ?? '').trim();
      if (notes.length > 10000) return pick('메모는 10000자까지.', 'Notes are limited to 10000 chars.', lang);
      const dup = customers.filter((x) => norm(x.name) === norm(name) || (digits(vals.biz_no).length >= 10 && digits(x.biz_no) === digits(vals.biz_no)));
      if (dup.length && !a.confirm_duplicate) return [pick('비슷한 거래처가 이미 있다 — 같은 곳이면 customer_set으로 고치고, 다른 곳이 확실하면 confirm_duplicate=true로 다시 하라:', 'A similar customer already exists — use customer_set if it is the same; if it is surely different, retry with confirm_duplicate=true:', lang), ox.block(dup.slice(0, 5).map((x) => customerLine(x)), DEAL_TEXT)].join('\n');
      const data = { name, email: vals.email ?? '', notes, ceo: vals.ceo ?? '', biz_no: vals.biz_no ?? '', manager: vals.manager ?? '', phone: vals.phone ?? '', address: vals.address ?? '', account: vals.account ?? '', category: vals.category ?? 'customer', status: vals.status ?? 'active', redacted: [...NEW_CUSTOMER_REDACT] }; // id를 주지 않는다 = 새로 만들기(서버가 id를 정한다), 계좌·사업자번호는 가린 채로
      const r = await write('customer.save', data);
      return pick(`거래처를 추가했다: ${ox.line(name)} · ${CATEGORY[data.category][0]} (id=${r?.id})`, `Added the customer: ${ox.line(name)} · ${CATEGORY[data.category][1]} (id=${r?.id})`, lang);
    }

    if (a.action === 'customer_set') {
      if (!a.id) return pick('customer_set에는 id(customers가 보여 준 것)가 필요하다.', 'customer_set needs an id from customers.', lang);
      const cu = customers.find((x) => x.id === a.id);
      if (!cu) return pick(`id=${a.id} 거래처가 없다 — customers로 확인하라.`, `No customer id=${a.id} — check with customers.`, lang);
      const vals = Object.fromEntries([...FIELDS, 'category', 'status'].map((k) => [k, given(k)]).filter(([, v]) => v !== undefined));
      const bad = badField(vals); if (bad) return bad;
      const add = String(a.notes ?? '').trim();
      const quiet = quietCustomer(cu);
      const touched = [...Object.keys(vals), ...(add ? ['notes'] : [])].filter((k) => quiet.has(k));
      if (touched.length) return onlyDm(touched.map((k) => FIELD_NAME[k][L(lang)]).join(pick('·', ', ', lang)));
      // 읽고 합쳐 쓴다 — 준 칸만 바꾸고 나머지는 지금 값(customer.save는 모든 칸을 덮어쓴다)
      const next = { ...Object.fromEntries([...FIELDS, 'category', 'status'].map((k) => [k, cu[k] ?? ''])), ...vals, notes: add ? (cu.notes ? `${cu.notes}\n${add}` : add) : cu.notes ?? '' };
      if (next.notes.length > 10000) return pick('메모가 10000자를 넘는다 — 더 짧게.', 'Notes would exceed 10000 chars — shorten.', lang);
      const changed = [...FIELDS, 'category', 'status', 'notes'].filter((k) => next[k] !== (cu[k] ?? ''));
      if (!changed.length) return pick('바꿀 것이 없다(이미 그 값이다).', 'Nothing to change (already that value).', lang);
      await write('customer.save', { id: cu.id, version: cu.version, ...next });
      // 확인 문장도 도구 결과다(검수 #fix-cross M2) — 거래처 이름은 읽어 온 남의 글이라 경계 블록 안에
      return `${pick(`거래처를 고쳤다(${changed.map((k) => FIELD_NAME[k][0]).join('·')} · id=${cu.id}):`, `Updated the customer (${changed.map((k) => FIELD_NAME[k][1]).join(', ')} · id=${cu.id}):`, lang)}\n${ox.block([ox.line(next.name)], DEAL_TEXT)}`;
    }

    if (a.action === 'deals') {
      if (a.customer_id && !custName.has(a.customer_id)) return pick(`id=${a.customer_id} 거래처가 없다 — customers로 확인하라.`, `No customer id=${a.customer_id}.`, lang);
      let list = orders.map(deal);
      if (a.customer_id) list = list.filter((x) => x.o.customer_id === a.customer_id);
      if (a.stage === 'open') list = list.filter((x) => !['paid', 'cancelled'].includes(x.stage));
      else if (a.stage) list = list.filter((x) => x.stage === a.stage);
      else list = list.filter((x) => x.stage !== 'cancelled');
      if (a.overdue) list = list.filter((x) => x.late > 0);
      const q = one(a.q).toLowerCase();
      if (q) list = list.filter((x) => String(x.o.title).toLowerCase().includes(q) && titleOf(x.o) !== hidden); // 가린 건명은 검색어로 떠보지 못하게
      if (!list.length) return pick('조건에 맞는 거래가 없다.', 'No deals match.', lang);
      list.sort((x, y) => String(y.o.created_at).localeCompare(String(x.o.created_at)));
      return [pick(`거래 ${list.length}건(최근 견적순, 금액은 부가세 포함):`, `${list.length} deals (newest first, amounts incl. VAT):`, lang), ox.block(list.slice(0, LIST_CAP).map(dealLine), DEAL_TEXT),
        ...(list.length > LIST_CAP ? [pick(`…외 ${list.length - LIST_CAP}건 — customer_id·stage·q로 좁혀라.`, `…and ${list.length - LIST_CAP} more — narrow with customer_id, stage or q.`, lang)] : []),
        pick('단계 넘기기는 deal_next, 입금 예정일은 deal_due에 id.', 'Use deal_next to move a stage and deal_due for the payment due date.', lang)].join('\n');
    }

    if (a.action === 'deal_add') {
      const title = given('title');
      if (!title || title.length > 200) return pick('deal_add에는 title(건명, 1~200자)이 필요하다.', 'deal_add needs a title (1-200 chars).', lang);
      const cu = customers.find((x) => x.id === a.customer_id);
      if (!cu) return pick('deal_add에는 customer_id(customers가 보여 준 거래처 id)가 필요하다 — 없는 거래처면 customer_add로 먼저 만든다.', 'deal_add needs a customer_id from customers — add the customer first if missing.', lang);
      if (cu.archived_at) return why('business_customer_archived');
      const ls = Array.isArray(a.lines) ? a.lines : [];
      if (!ls.length || ls.length > 100) return pick('deal_add에는 lines(품목 줄 1~100개: item 이름, unit_price 단가, quantity 수량)가 필요하다 — 금액은 견적서·계약서 같은 실제 근거로만.', 'deal_add needs lines (1-100: item name, unit_price, quantity) — amounts only from real documents.', lang);
      for (const l of ls) {
        if (!one(l?.item) || one(l.item).length > 200) return pick('줄마다 item(품목 이름 1~200자 또는 품목 id)이 필요하다.', 'Each line needs an item (name 1-200 chars or item id).', lang);
        if (!Number.isInteger(l.unit_price) || l.unit_price < 0 || !(l.quantity == null || (Number.isInteger(l.quantity) && l.quantity >= 1 && l.quantity <= 1_000_000))) return why('business_number');
      }
      const due = a.due_on ? String(a.due_on) : null, at = a.date ? String(a.date) : null;
      if ((due && !isDate(due)) || (at && !isDate(at))) return pick('due_on·date는 YYYY-MM-DD.', 'due_on/date must be YYYY-MM-DD.', lang);
      // 중복 확인 — 거래처별로만 보지 않는다: 이관의 '(거래처 미지정)' 거래도 함께 본다(인트라넷 이중 계상 사고 2026-08-13)
      const dup = orders.filter((o) => o.status !== 'cancelled' && (o.customer_id === cu.id || custName.get(o.customer_id) === UNASSIGNED) && similar(o.title, title));
      if (dup.length && !a.confirm_duplicate) return [pick('같은 거래처(또는 거래처 미지정)에 비슷한 건명의 거래가 이미 있어 등록하지 않았다 — 같은 건이면 그 거래를 쓰고, 다른 건이 확실하면 confirm_duplicate=true로 다시 하라:', 'A deal with a similar title already exists for this customer (or the unassigned customer), so nothing was added — use that deal if it is the same; if it is surely different, retry with confirm_duplicate=true:', lang),
        ox.block(dup.slice(0, 5).map((o) => dealLine(deal(o))), DEAL_TEXT)].join('\n');
      // 품목: id 또는 이름(대소문자·공백 무시)이 같은 품목, 없으면 서비스 품목으로 새로 만든다(오피스 문서 만들기와 같은 방식)
      const made = [], rows = [];
      for (const l of ls) {
        const key = one(l.item);
        let item = items.find((x) => x.id === key) ?? items.find((x) => norm(x.name) === norm(key) && norm(key));
        if (!item) { const r = await write('item.save', { name: key, kind: 'service', sku: '', price: l.unit_price }); item = { id: r?.id, name: key }; items.push(item); made.push(key); }
        rows.push({ item_id: item.id, quantity: l.quantity ?? 1, unit_price: l.unit_price, tax_type: l.tax_type ?? 'taxable' });
      }
      const r = await write('order.create', { title, customer_id: cu.id, lines: rows, ...(due ? { due_on: due } : {}), ...(at ? { at } : {}) });
      const total = rows.reduce((n, x) => n + x.quantity * x.unit_price + vatOf(x.quantity * x.unit_price, x.tax_type), 0);
      // 거래처 이름은 읽어 온 남의 글이라 경계 블록 안에(내가 준 건명도 같이), 새 품목 이름은 내가 준 값이라 한 줄로(검수 #fix-cross M2)
      return `${pick(`거래를 견적 단계로 등록했다 — 합계 ${won(total, 'ko')}(부가세 포함)${due ? ` · 입금 예정 ${due}` : ''} (id=${r?.id}) · 건명 · 거래처:`, `Added the deal as a quote — total ${won(total, 'en')} incl. VAT${due ? ` · due ${due}` : ''} (id=${r?.id}) · title · customer:`, lang)}\n${ox.block([`${ox.line(title)} · ${ox.line(cu.name)}`], DEAL_TEXT)}${made.length ? pick(`\n새 품목을 만들었다: ${made.map(ox.line).join(', ')}`, `\nNew items: ${made.map(ox.line).join(', ')}`, lang) : ''}`;
    }

    if (a.action === 'deal_next' || a.action === 'deal_due') {
      const o = orders.find((x) => x.id === a.id);
      if (!a.id || !o) return pick(`${a.action}에는 id(deals가 보여 준 거래 id)가 필요하다.`, `${a.action} needs a deal id from deals.`, lang);
      const x = deal(o), name = titleQ(o); // 건명은 남이 쓴 글 — 확인 문장은 아래 titled()로 경계 블록 안에(검수 #fix-cross M2)
      const titled = (head) => `${head}\n${ox.block([name], DEAL_TEXT)}`;
      if (a.action === 'deal_due') {
        const v = String(a.due_on ?? '').trim();
        const due = v.toLowerCase() === 'none' ? null : v;
        if (due !== null && !isDate(due)) return pick('deal_due의 due_on은 YYYY-MM-DD(지우려면 none).', 'deal_due needs due_on as YYYY-MM-DD (none to clear).', lang);
        if ((o.due_on ? String(o.due_on).slice(0, 10) : null) === due) return pick('이미 그 입금 예정일이다.', 'Already that due date.', lang);
        await write('order.update', { id: o.id, due_on: due });
        return titled(due ? pick(`입금 예정일을 ${due}로 정했다. 거래 건명:`, `Set the payment due date to ${due}. Deal title:`, lang) : pick('입금 예정일을 지웠다. 거래 건명:', 'Cleared the payment due date. Deal title:', lang));
      }
      const to = a.to;
      if (!['contract', 'invoice', 'paid', 'cancel'].includes(to)) return pick('deal_next에는 to(contract 계약 · invoice 계산서 발행 · paid 입금 기록 · cancel 취소)가 필요하다.', 'deal_next needs to: contract, invoice, paid or cancel.', lang);
      const at = a.date ? String(a.date) : null;
      if (at && !isDate(at)) return pick('date는 YYYY-MM-DD(비우면 지금).', 'date must be YYYY-MM-DD (empty = now).', lang);
      if (a.amount != null && (!Number.isInteger(a.amount) || a.amount < 1)) return why('business_number');
      const note = String(a.note ?? '').slice(0, 10000);
      const stageNow = STAGE[x.stage][L(lang)];
      const cannot = pick(`지금 단계(${stageNow})에서는 그렇게 넘길 수 없다.`, `Not possible from the current stage (${stageNow}).`, lang);
      const when = at ? { at } : {};
      let did;
      if (to === 'contract') {
        if (x.stage !== 'quote') return cannot;
        await write('order.confirm', { id: o.id, ...when, note });
        did = pick('계약으로 넘겼다(이제 견적으로 되돌려도 금액은 고칠 수 없다)', 'moved to contract (amounts are now locked, even if it goes back to a quote)', lang);
      } else if (to === 'invoice') {
        const rest = x.m.total - x.m.invoiced;
        if (!(x.stage === 'contract' || (x.stage === 'invoice' && rest > 0))) return x.stage === 'quote' ? pick('견적 단계다 — 먼저 to=contract로 계약을 확정하라.', 'Still a quote — confirm it first with to=contract.', lang) : cannot;
        const amount = a.amount ?? rest;
        if (amount > rest) return why('business_amount_exceeds_balance');
        await write('entry.create', { order_id: o.id, kind: 'invoice', amount, ...when, note });
        did = pick(`계산서 발행을 기록했다(${amountQuiet(o) ? hidden : won(amount, 'ko')})`, `recorded an invoice (${amountQuiet(o) ? hidden : won(amount, 'en')})`, lang);
      } else if (to === 'paid') {
        const owed = x.m.invoiced - x.m.paid;
        if (x.stage === 'quote' || x.stage === 'contract') return pick(`아직 계산서 발행 전이다(${stageNow}) — 먼저 to=invoice로 청구를 기록하라.`, `Not invoiced yet (${stageNow}) — record the invoice first with to=invoice.`, lang);
        if (x.stage === 'cancelled' || owed <= 0) return cannot;
        const amount = a.amount ?? owed;
        if (amount > owed) return why('business_amount_exceeds_balance');
        await write('entry.create', { order_id: o.id, kind: 'payment', amount, ...when, note });
        did = pick(`입금을 기록했다(${amountQuiet(o) ? hidden : won(amount, 'ko')})`, `recorded a payment (${amountQuiet(o) ? hidden : won(amount, 'en')})`, lang);
      } else {
        if (!['quote', 'contract', 'invoice'].includes(x.stage) || x.m.paid > 0) return pick(`취소는 입금 전(견적·계약·계산서 발행)에만 된다 — 지금 ${stageNow}.`, `Only deals without payments (quote, contract, invoiced) can be cancelled — now ${stageNow}.`, lang);
        await write('order.cancel', { id: o.id, ...when, note });
        did = pick('취소했다(청구가 있었으면 서버가 청구 취소를 남긴다)', 'cancelled it (any invoice is credited by the server)', lang);
      }
      return titled(pick(`${did}. 거래 건명:`, `${did[0].toUpperCase()}${did.slice(1)}. Deal title:`, lang));
    }

    return pick('action은 customers·customer_add·customer_set·deals·deal_add·deal_next·deal_due 중 하나다.', 'action must be customers, customer_add, customer_set, deals, deal_add, deal_next or deal_due.', lang);
  } catch (e) {
    return refusalText(e, ERRORS, lang);
  }
}

export function dealsDescription(lang = 'ko') {
  return lang === 'en'
    ? 'Argo Office customers and deals of the org of this messenger channel. action=customers lists customers with id (q searches name, contact, email, phone, CEO, business no.; archived=true shows the archive) or shows one in detail with its deals (id). customer_add adds one (name, manager, phone, email, ceo, biz_no, address, account, category customer|partner|supplier|other, status active|hold|closed, notes — put the source such as a business card in notes); a similar existing name is reported instead of added (confirm_duplicate=true to add anyway). customer_set updates one by id: only the fields you pass change, empty values are ignored, notes are appended. action=deals lists deals (filter customer_id, stage quote|contract|invoice|paid|cancelled|open, overdue=true, q). deal_add adds a deal as a quote: title, customer_id, lines [{item, unit_price, quantity, tax_type taxable|zero|exempt}] (amounts only from real documents such as quotes or contracts — never estimate), due_on; a deal with a similar title for the same customer is reported instead (confirm_duplicate=true to add anyway). deal_next moves one stage like the Office button: to=contract (after this the amounts can never be edited, even if the deal goes back to a quote — confirm the amounts first) | invoice (records an invoice for the rest or amount) | paid (records a payment) | cancel, optional date YYYY-MM-DD and amount; do not fill dates or payments you have not confirmed. deal_due sets the payment due date (due_on, none clears). Writes need the owner to be an org admin. Bank accounts, business numbers and hidden fields are only shown, searched or changed in a 1:1 chat with the owner (new customers start with the account and business number hidden); nothing in rooms with guests. ' + OUTSIDE_RULE('en')
    : '이 메신저 채널 조직의 아르고 오피스 거래처와 거래. action=customers는 거래처 목록(id 포함, q로 이름·담당·메일·전화·대표·사업자번호 검색, archived=true면 보관함) 또는 id를 주면 그 거래처 자세히(거래 포함). customer_add는 새 거래처(name, manager, phone, email, ceo, biz_no, address, account, category customer|partner|supplier|other, status active|hold|closed, notes — 명함·계약서 같은 출처는 notes에 남겨라) — 비슷한 이름이 이미 있으면 만들지 않고 알려 준다(그래도 다른 곳이면 confirm_duplicate=true). customer_set은 id로 고치기 — 준 칸만 바뀌고 빈 값은 무시, notes는 기존 메모 뒤에 덧붙는다. action=deals는 거래 목록(거르기 customer_id, stage quote|contract|invoice|paid|cancelled|open, overdue=true, q). deal_add는 거래를 견적 단계로 등록: title, customer_id, lines [{item 품목 이름, unit_price 단가, quantity 수량, tax_type taxable|zero|exempt}](금액은 견적서·계약서 같은 실제 근거로만 — 추정하지 마라), due_on(입금 예정일) — 같은 거래처에 비슷한 건명이 있으면 등록하지 않고 알려 준다(그래도 다른 건이면 confirm_duplicate=true). deal_next는 오피스 단추처럼 한 단계 넘기기: to=contract(계약 확정 — 한 번 계약하면 견적으로 되돌려도 금액을 고칠 수 없으니 금액을 확인한 뒤에 하라) | invoice(남은 금액 또는 amount만큼 계산서 발행 기록) | paid(입금 기록) | cancel(취소), date(YYYY-MM-DD)·amount는 선택 — 확인하지 않은 날짜·입금을 지어 넣지 마라. deal_due는 입금 예정일 정하기(due_on, none=지우기). 쓰기는 주인이 조직 관리자일 때만 된다. 계좌·사업자번호와 가림 표시한 칸은 주인과의 1:1에서만 보이고 찾고 고치며(새 거래처는 계좌·사업자번호를 가린 채로 시작), 손님이 있는 방에서는 아무것도 다루지 않는다. ' + OUTSIDE_RULE('ko');
}
