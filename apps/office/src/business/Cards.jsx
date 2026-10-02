// 거래처·상품 카드(유건 9/29: "볼 수 있는 곳이 '수정' 밖에 없니?") — 줄을 누르면 모든 칸과 관련 거래를 보여 주고, 수정은 카드 안에서.
import { lazy, Suspense } from 'react';
import { t, getLang } from '../core/i18n.js';
import { Icon } from '../ui/Icon.jsx';
import { Redact } from './Redact.jsx';
import { dealAmounts, dealStage } from './deal-model.js';

const label = (key) => t(`bizui.${key}`);
const money = (n) => new Intl.NumberFormat(getLang() === 'en' ? 'en-US' : 'ko-KR', { style: 'currency', currency: 'KRW', maximumFractionDigits: 0 }).format(Number(n || 0));
const REDACTABLE = ['manager', 'phone', 'email', 'biz_no', 'account'];
// 거래처 파일(명함·사업자등록증·견적·계약·서명본) — 문서함과 같은 저장소, 카드를 열 때만 받는다(인트라넷 거래처 첨부·허브 문서 탭, 유건 10/2)
const CustomerFiles = lazy(() => import('../files/CustomerFiles.jsx'));

function Deals({ orders, data, openOrder }) {
  if (!orders.length) return <p className="dim small card-empty">{label('card.noDeals')}</p>;
  return <ul className="card-deals">{orders.map((o) => {
    const a = dealAmounts(o, data.lines, data.entries), stage = dealStage(o, a);
    return <li key={o.id}><button type="button" className="bizui-link" onClick={() => openOrder(o.id)}>{o.title}</button>
      <span className="badge">{stage === 'cancelled' ? label('view.cancelled') : label(`stage.${stage}`)}</span><strong className="mono">{money(a.total)}</strong></li>;
  })}</ul>;
}

export function CustomerCard({ customer: c, data, blocked, run, launch, openOrder, space }) {
  const hide = (field) => ({ on: c.redacted?.includes(field), disabled: blocked, onToggle: () => run('redact.set', { entity: 'customer', id: c.id, field, on: !c.redacted?.includes(field) }).catch(() => {}) });
  const rows = [['ceo', c.ceo], ['manager', c.manager], ['phone', c.phone], ['email', c.email], ['biz_no', c.biz_no], ['account', c.account],
    ['category', label(`category.${c.category ?? 'customer'}`)], ['customerStatus', label(`status.${c.status ?? 'active'}`)], ['address', c.address],
    ...(c.created_at ? [['createdAt', new Date(c.created_at).toLocaleDateString(getLang() === 'en' ? 'en-US' : 'ko-KR', { year: 'numeric', month: 'long', day: 'numeric' })]] : [])]; // 등록일(유건 9/30) — 서버가 돌려줄 때만
  const orders = data.orders.filter((o) => o.customer_id === c.id);
  const total = orders.filter((o) => o.status !== 'cancelled').reduce((s, o) => s + dealAmounts(o, data.lines, data.entries).total, 0);
  return <div className="bizui-detail">
    <div className="bizui-actions"><button type="button" className="btn sm" disabled={blocked} onClick={() => launch('customer', c)}><Icon name="draft" size={13} />{label('edit')}</button></div>
    <dl className="card-fields">{rows.map(([k, v]) => <div key={k}><dt>{label(k)}</dt><dd>{REDACTABLE.includes(k) ? <Redact {...hide(k)}>{v || '—'}</Redact> : v || '—'}</dd></div>)}</dl>
    {c.notes && <div className="card-notes"><h3>{label('notes')}</h3><p>{c.notes}</p></div>}
    <h3>{label('card.deals')} <span className="dim small">{orders.length} · {money(total)}</span></h3>
    <Deals orders={orders} data={data} openOrder={openOrder} />
    {space && <Suspense fallback={null}><CustomerFiles space={space} customer={c} /></Suspense>}
  </div>;
}

export function ItemCard({ item: i, data, blocked, launch, openOrder }) {
  const orderIds = new Set(data.lines.filter((l) => l.item_id === i.id).map((l) => l.order_id));
  const orders = data.orders.filter((o) => orderIds.has(o.id));
  const rows = [['kind', label(i.kind)], ['sku', i.sku], ['price', money(i.price)], ...(i.kind === 'product' ? [['stock', String(i.stock ?? 0)], ['reserved', String(i.reserved ?? 0)]] : [])];
  return <div className="bizui-detail">
    <div className="bizui-actions"><button type="button" className="btn sm" disabled={blocked} onClick={() => launch('item', i)}><Icon name="draft" size={13} />{label('edit')}</button></div>
    <dl className="card-fields">{rows.map(([k, v]) => <div key={k}><dt>{label(k)}</dt><dd>{v || '—'}</dd></div>)}</dl>
    <h3>{label('card.deals')} <span className="dim small">{orders.length}</span></h3>
    <Deals orders={orders} data={data} openOrder={openOrder} />
  </div>;
}
