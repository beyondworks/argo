// 거래처·상품 카드(유건 9/29: "볼 수 있는 곳이 '수정' 밖에 없니?") — 줄을 누르면 모든 칸과 관련 거래를 보여 주고, 수정은 카드 안에서.
import { lazy, Suspense, useEffect, useState } from 'react';
import { t, getLang } from '../core/i18n.js';
import { baseOf } from '../core/commands.js';
import { navigate } from '../core/router.jsx';
import { Icon } from '../ui/Icon.jsx';
import { showToast } from '../ui/Overlay.jsx';
import { setUi } from '../core/ui-state.js';
import { customerText } from '../core/crew-items.js';
import { Redact, Hide } from './Redact.jsx';
import { dealAmounts, dealStage, overdueDays, customerSummary, kstToday } from './deal-model.js';

const label = (key) => t(`bizui.${key}`);
const money = (n) => new Intl.NumberFormat(getLang() === 'en' ? 'en-US' : 'ko-KR', { style: 'currency', currency: 'KRW', maximumFractionDigits: 0 }).format(Number(n || 0));
const REDACTABLE = ['manager', 'phone', 'email', 'biz_no', 'account'];
const CONTACT_ONLY = ['ceo', 'address']; // 따로 가리는 칸은 없지만 화면 전체 가리기(18차)에서는 연락처로 가린다
// 거래처 파일(명함·사업자등록증·견적·계약·서명본) — 문서함과 같은 저장소, 카드를 열 때만 받는다(인트라넷 거래처 첨부·허브 문서 탭, 유건 10/2)
const CustomerFiles = lazy(() => import('../files/CustomerFiles.jsx'));
// 이 거래처의 일정·이름이 든 할 일(14차, 인트라넷 허브 '진행' 탭) — 일정·할 일 읽기는 카드를 열 때만
const CustomerLinks = lazy(() => import('./CustomerLinks.jsx'));
const COPYABLE = ['ceo', 'manager', 'phone', 'email', 'biz_no', 'account', 'address'];
const dueShort = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString(getLang() === 'en' ? 'en-US' : 'ko-KR', { timeZone: 'UTC', month: '2-digit', day: '2-digit' }); // 입금 예정일(날짜 문자열 그대로)

function Deals({ orders, data, openOrder }) {
  if (!orders.length) return <p className="dim small card-empty">{label('card.noDeals')}</p>;
  const today = kstToday();
  return <ul className="card-deals">{orders.map((o) => {
    const a = dealAmounts(o, data.lines, data.entries), stage = dealStage(o, a), late = overdueDays(o, a, today);
    return <li key={o.id}><button type="button" className="bizui-link" onClick={() => openOrder(o.id)}>{o.title}</button>
      {late > 0 ? <span className="badge danger">{t('bizui.late', { n: late })}</span>
        : o.due_on && stage !== 'paid' && stage !== 'cancelled' && <span className="dim small mono">{t('bizui.dueShort', { d: dueShort(o.due_on) })}</span>}
      <span className="badge">{stage === 'cancelled' ? label('view.cancelled') : label(`stage.${stage}`)}</span><strong className="mono"><Hide k={`order:${o.id}:total`}>{money(a.total)}</Hide></strong></li>;
  })}</ul>;
}

/** 거래처 요약(14차, 인트라넷 허브 '누적 입금'·'진행 중 금액'·'입금 지연') — 금액은 부가세 포함 */
function CustomerSummary({ c, data }) {
  const s = customerSummary(c.id, data);
  const stages = ['quote', 'contract', 'invoice'].filter((k) => s.byStage[k]).map((k) => `${label(`stage.${k}`)} ${s.byStage[k]}`).join(' · ');
  const first = s.overdue[0];
  return <>
    <dl className="bizui-balances card-summary">
      <div><dt>{label('sum.paid')}</dt><dd><Hide k={`customer:${c.id}:paid`}>{money(s.paid)}</Hide></dd><p className="sub">{label('sum.paidSub')}</p></div>
      <div><dt>{label('sum.open')}</dt><dd><Hide k={`customer:${c.id}:open`}>{money(s.open)}</Hide></dd><p className="sub">{stages || label('sum.noOpen')}</p></div>
      <div><dt>{label('sum.late')}</dt><dd>{t('bizui.attn.deals', { n: s.overdue.length })}</dd>
        <p className="sub">{first ? <><span className="badge danger">{t('bizui.late', { n: first.late })}</span> {first.order.title}</> : label('sum.lateNone')}</p></div>
    </dl>
    <p className="dim small card-basis">{label('sum.basis')}</p>
  </>;
}

/** 에이전트에게 맡기기(17차 A-5) — 고른 거래처들을 글자로(계좌·사업자번호는 빼고, core/crew-items.js) 맡기기 창에. 크루는 창에서 고른다 */
export const assignCustomers = (space, customers, data) => setUi({ assign: { space, items: customers.map((c) => ({ kind: 'customer', id: c.id, label: c.name, text: customerText(c, data, t) })) } });

/** 칸 복사(인트라넷 허브 개요의 복사 버튼) — 가린 값도 복사는 된다(가림은 화면 공유용) */
async function copyValue(key, value) {
  try { await navigator.clipboard.writeText(value); showToast(t('bizui.copied', { label: label(key) })); }
  catch { showToast(label('copyFail')); }
}

/** 이 거래처의 견적서·계약서(인트라넷 거래처 허브 '문서' — "견적서·계약서 생성 시 자동 연결") — 견적·계약 저장소를 열 때만 불러온다 */
function CustomerDocs({ space, customer }) {
  const [docs, setDocs] = useState(null);
  useEffect(() => {
    let live = true;
    import('../docs/backend.js').then((m) => m.backend()).then((be) => be.load(space))
      .then((d) => { if (live) setDocs(d.docs.filter((x) => x.customer_id === customer.id || (!x.customer_id && x.customer_name === customer.name))); })
      .catch(() => { if (live) setDocs([]); });
    return () => { live = false; };
  }, [space, customer.id, customer.name]);
  const go = (q) => navigate(`${baseOf(space)}/contracts?${new URLSearchParams(q)}`);
  return <>
    <h3>{label('card.docs')} {docs && <span className="dim small">{docs.length}</span>}</h3>
    {docs?.length ? <ul className="card-deals">{docs.map((d) => <li key={d.id}><button type="button" className="bizui-link" onClick={() => go({ open: `doc:${d.id}` })}>{d.title}</button><strong className="mono"><Hide k={`doc:${d.id}:total`}>{money(d.total)}</Hide></strong></li>)}</ul>
      : docs && <p className="dim small card-empty">{label('card.noDocs')}</p>}
    <div className="bizui-actions"><button type="button" className="btn sm" onClick={() => go({ new: 'quote', customer: customer.id })}><Icon name="doc" size={12} /> {label('makeQuote')}</button><button type="button" className="btn sm" onClick={() => go({ new: 'contract', customer: customer.id })}><Icon name="sign" size={12} /> {label('makeContract')}</button></div>
  </>;
}

export function CustomerCard({ customer: c, data, blocked, run, launch, openOrder, space, restore }) {
  const hide = (field) => ({ on: c.redacted?.includes(field), disabled: blocked, cellKey: `cust:${c.id}:${field}`, onToggle: () => run('redact.set', { entity: 'customer', id: c.id, field, on: !c.redacted?.includes(field) }).catch(() => {}) });
  const rows = [['ceo', c.ceo], ['manager', c.manager], ['phone', c.phone], ['email', c.email], ['biz_no', c.biz_no], ['account', c.account],
    ['category', label(`category.${c.category ?? 'customer'}`)], ['customerStatus', label(`status.${c.status ?? 'active'}`)], ['address', c.address],
    ...(c.created_at ? [['createdAt', new Date(c.created_at).toLocaleDateString(getLang() === 'en' ? 'en-US' : 'ko-KR', { year: 'numeric', month: 'long', day: 'numeric' })]] : [])]; // 등록일(유건 9/30) — 서버가 돌려줄 때만
  const orders = data.orders.filter((o) => o.customer_id === c.id);
  const total = orders.filter((o) => o.status !== 'cancelled').reduce((s, o) => s + dealAmounts(o, data.lines, data.entries).total, 0);
  return <div className="bizui-detail">
    {c.archived_at && <p className="bizui-muted card-archived"><span className="badge">{label('archivedMark')}</span> {label('archivedNote')}</p>}
    <div className="bizui-actions">
      <button type="button" className="btn sm" disabled={blocked} onClick={() => launch('customer', c)}><Icon name="draft" size={13} />{label('edit')}</button>
      {!c.archived_at && <button type="button" className="btn sm" disabled={blocked || !data.items.length} title={data.items.length ? undefined : label('prerequisites')} onClick={() => launch('order', { customer_id: c.id })}><Icon name="plus" size={13} />{label('addDeal')}</button>}
      <button type="button" className="btn sm" onClick={() => assignCustomers(space, [c], data)}><Icon name="hand" size={13} />{t('crew.assign')}</button>
      <button type="button" className="btn sm ghost" disabled={blocked} onClick={() => (c.archived_at ? restore([c.id]) : launch('archive', { ids: [c.id] }))}><Icon name={c.archived_at ? 'refresh' : 'archive'} size={13} />{label(c.archived_at ? 'unarchive' : 'archive')}</button>
    </div>
    <CustomerSummary c={c} data={data} />
    <dl className="card-fields">{rows.map(([k, v]) => <div key={k}><dt>{label(k)}</dt><dd>{REDACTABLE.includes(k) ? <Redact {...hide(k)}>{v || '—'}</Redact> : CONTACT_ONLY.includes(k) && v ? <Redact kind="contact">{v}</Redact> : v || '—'}
      {COPYABLE.includes(k) && v && <button type="button" className="icon-btn sm card-copy" aria-label={t('bizui.copy', { label: label(k) })} title={t('bizui.copy', { label: label(k) })} onClick={() => copyValue(k, v)}><Icon name="copy" size={12} /></button>}</dd></div>)}</dl>
    {c.notes && <div className="card-notes"><h3>{label('notes')}</h3><p><Redact kind="memo">{c.notes}</Redact></p></div>}
    <h3>{label('card.deals')} <span className="dim small">{orders.length} · <Hide k={`customer:${c.id}:dealsTotal`}>{money(total)}</Hide></span></h3>
    <Deals orders={orders} data={data} openOrder={openOrder} />
    {space && <Suspense fallback={null}><CustomerLinks space={space} customer={c} /></Suspense>}
    {space && <CustomerDocs space={space} customer={c} />}
    {space && <Suspense fallback={null}><CustomerFiles space={space} customer={c} /></Suspense>}
  </div>;
}

export function ItemCard({ item: i, data, blocked, launch, openOrder }) {
  const orderIds = new Set(data.lines.filter((l) => l.item_id === i.id).map((l) => l.order_id));
  const orders = data.orders.filter((o) => orderIds.has(o.id));
  const rows = [['kind', label(i.kind)], ['sku', i.sku], ['price', <Hide key="price" k={`item:${i.id}:price`}>{money(i.price)}</Hide>], ...(i.kind === 'product' ? [['stock', String(i.stock ?? 0)], ['reserved', String(i.reserved ?? 0)]] : [])];
  return <div className="bizui-detail">
    <div className="bizui-actions"><button type="button" className="btn sm" disabled={blocked} onClick={() => launch('item', i)}><Icon name="draft" size={13} />{label('edit')}</button></div>
    <dl className="card-fields">{rows.map(([k, v]) => <div key={k}><dt>{label(k)}</dt><dd>{v || '—'}</dd></div>)}</dl>
    <h3>{label('card.deals')} <span className="dim small">{orders.length}</span></h3>
    <Deals orders={orders} data={data} openOrder={openOrder} />
  </div>;
}
