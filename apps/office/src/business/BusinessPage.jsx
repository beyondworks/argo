// 업무 사전 등록(biz.*/bizui.*/mkt.*) — core/i18n.js는 이걸 정적으로 갖지 않는다(첫 화면 150KB 상한, 유건 9/26).
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import './register-i18n.js';
import { t, useLang, getLang } from '../core/i18n.js';
import { baseOf } from '../core/commands.js';
import { Link, navigate } from '../core/router.jsx';
import { Modal, showToast } from '../ui/Overlay.jsx';
import { Peek } from '../ui/Peek.jsx';
import { CustomerCard, ItemCard } from './Cards.jsx';
import { Icon } from '../ui/Icon.jsx';
import { InfoTip } from '../ui/InfoTip.jsx';
import { openMenu } from '../ui/Menu.jsx';
import { useBusiness, businessError } from './data.js';
import { BusinessDashboard } from './Dashboard.jsx';
import Marketing from './Marketing.jsx';
import { DealBoard, DealDetail } from './DealBoard.jsx';
import { Redact } from './Redact.jsx';
import { cellsInBox, bulkRedact } from './cell-pick.js';
import { dealAmounts, vatOf } from './deal-model.js';
import './business.css';
import { BUSINESS_MODULES } from '../core/module-registry.js';
import { SortableContext, useSortable, horizontalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useStore } from '../core/store.js';
import { orderTabs } from '../core/nav-model.js';

/** 업무 탭 — 끌어서 순서를 바꾼다(사람마다, biztabs:me — 유건 9/30). 켜기·끄기는 조직 설정 그대로 */
function BizTab({ id, to, on, order, children }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: `biztab:${id}`, data: { kind: 'biztab', id, group: 'biztab', order, label: children } });
  const { onTouchStart, ...mouse } = listeners ?? {};
  return <Link ref={setNodeRef} to={to} style={{ transform: CSS.Translate.toString(transform), transition }} className={`tab${on ? ' on' : ''}${isDragging ? ' dragging' : ''}`} aria-current={on ? 'page' : undefined} {...attributes} {...mouse} role="link">{children}</Link>;
}

// 성과 분석은 마케팅 탭 안으로 합쳤다(유건 9/29) — 예전 주소·홈 카드는 마케팅으로 이어진다
const MODULES = BUSINESS_MODULES.map((module) => module.businessTab).filter((key) => key !== 'performance');
const money = (amount) => new Intl.NumberFormat(getLang() === 'en' ? 'en-US' : 'ko-KR', { style: 'currency', currency: 'KRW', maximumFractionDigits: 0 }).format(Number(amount || 0));
const integer = (value, min = 0, max = 1e12) => Number.isSafeInteger(Number(value)) && Number(value) >= min && Number(value) <= max;
const label = (key) => t(`bizui.${key}`);
const date = (value) => new Date(value).toLocaleString(getLang() === 'en' ? 'en-US' : 'ko-KR', { dateStyle: 'medium', timeStyle: 'short' });

function Field({ name, children }) {
  return <label className="field-block bizui-field"><span className="label">{label(name)}</span>{children}</label>;
}
// 숫자 열은 오른쪽 맞춤·Mono(유건 9/29), 수정 열은 머리글 없이 행 끝에 작은 버튼
const NUM = new Set(['price', 'amount', 'total', 'receivable', 'stock', 'reserved', 'available', 'quantity', 'supply', 'vat']);
const cls = (column) => (NUM.has(column) ? 'num' : column === 'edit' || column === 'receive' ? 'act' : undefined);
function Table({ columns, rows }) {
  return rows.length ? <div className="table-wrap bizui-table-wrap"><table className="table bizui-table"><thead><tr>{columns.map((column) => <th key={column} className={cls(column)}>{cls(column) === 'act' ? '' : label(column)}</th>)}</tr></thead><tbody>{rows}</tbody></table></div> : <p className="empty-state">{label('empty')}</p>;
}
const EditButton = ({ disabled, onClick, children }) => <button type="button" className="btn sm ghost" disabled={disabled} onClick={onClick}>{children ?? label('edit')}</button>;
const ENTRY_ORDER = ['invoice', 'payment', 'refund', 'credit']; // 같은 시각이면 업무 순서대로(청구 → 입금)
function EntryRows({ entries, orders, openOrder }) {
  // 청구는 청색, 입금은 녹색, 되돌린 기록(청구 취소·환불)은 붉은색 — 행 전체 글자색, 금액은 굵게(유건 9/29)
  return <Table columns={['date', 'orders', 'kind', 'supply', 'vat', 'amount', 'notes']} rows={entries.slice().sort((a, b) => a.at.localeCompare(b.at) || ENTRY_ORDER.indexOf(a.kind) - ENTRY_ORDER.indexOf(b.kind)).map((entry) => <tr key={entry.id} className={{ invoice: 'entry-bill', payment: 'entry-pay' }[entry.kind] ?? 'entry-back'}>
    <td>{date(entry.at)}</td><td><button className="bizui-link" onClick={() => openOrder(entry.order_id)}>{orders.find((o) => o.id === entry.order_id)?.title || '—'}</button></td>
    <td>{label(entry.kind)}</td><td className="num">{entry.supply == null ? '—' : money(entry.supply)}</td><td className="num">{entry.vat == null ? '—' : money(entry.vat)}</td><td className="num strong">{money(entry.amount)}</td><td>{entry.note}</td>
  </tr>)} />;
}
const balance = dealAmounts;

const REDACT_FIELDS = ['manager', 'phone', 'email', 'biz_no', 'account'];
/** 거래처 표 — 민감 칸은 우클릭으로 가리고, 칸을 누른 채 다른 칸까지 끌어 여러 칸을 고르면 우클릭으로 한 번에 가리기·해제(유건 9/29, 노션처럼) */
function CustomerTable({ rows, blocked, run, launch, openCard }) {
  const [pick, setPick] = useState(null), drag = useRef(false);
  const cells = pick ? cellsInBox(pick.a, pick.b) : [], many = cells.length > 1;
  const at = (event) => event.target.closest?.('[data-cell]')?.dataset.cell.split(':').map(Number);
  useEffect(() => {
    const up = () => { drag.current = false; };
    const down = (event) => { if (!event.target.closest?.('.cell-pick')) setPick(null); }; // 표 밖을 누르면 고르기를 푼다
    const key = (event) => { if (event.key === 'Escape') setPick(null); };
    addEventListener('mouseup', up); addEventListener('mousedown', down); addEventListener('keydown', key);
    return () => { removeEventListener('mouseup', up); removeEventListener('mousedown', down); removeEventListener('keydown', key); };
  }, []);
  const menu = (event) => {
    const cell = at(event);
    if (blocked || !many || !cell || !cells.some(([r, c]) => r === cell[0] && c === cell[1])) return; // 고른 칸 밖은 칸 하나 메뉴(Redact)
    const hide = bulkRedact(rows, REDACT_FIELDS, cells, true), show = bulkRedact(rows, REDACT_FIELDS, cells, false);
    // 바뀌는 칸만, 서버 한도(500칸)씩 나눠 보낸다 — 100줄 넘게 골라도 전체가 거절되지 않게(분리 검수 M4)
    const send = async (items) => { try { for (let i = 0; i < items.length; i += 500) await run('redact.bulk', { items: items.slice(i, i + 500) }); setPick(null); } catch { /* run이 안내를 띄운다 */ } };
    openMenu(event, [
      hide.length > 0 && { label: t('bizui.redactMany', { n: hide.length }), icon: 'eyeOff', run: () => send(hide) },
      show.length > 0 && { label: t('bizui.unredactMany', { n: show.length }), icon: 'eye', run: () => send(show) },
    ]);
  };
  return <div className={`cell-pick${many ? ' picking' : ''}`} onContextMenu={menu}
    onMouseDown={(event) => { if (event.ctrlKey) return; const cell = event.button === 0 && at(event); /* 맥 Ctrl+클릭은 우클릭 */ drag.current = !!cell; if (event.button === 0) setPick(cell ? { a: cell, b: cell } : null); }}
    onMouseOver={(event) => { if (!(event.buttons & 1)) drag.current = false; /* 창 밖에서 버튼을 놓았으면 끌기 끝 */ const cell = drag.current && at(event); if (cell) setPick((old) => old && (old.b[0] === cell[0] && old.b[1] === cell[1] ? old : { ...old, b: cell })); }}>
    <Table columns={['name', 'manager', 'phone', 'email', 'biz_no', 'account', 'category', 'customerStatus', 'edit']} rows={rows.map((row, r) => {
      const hide = (field) => { const c = REDACT_FIELDS.indexOf(field); return { on: row.redacted?.includes(field), disabled: blocked, cell: `${r}:${c}`, picked: many && cells.some(([x, y]) => x === r && y === c),
        onToggle: () => run('redact.set', { entity: 'customer', id: row.id, field, on: !row.redacted?.includes(field) }).catch(() => {}) }; };
      return <tr key={row.id}><td><button type="button" className="bizui-link" onClick={() => openCard('c', row.id)}>{row.name}</button></td><td><Redact {...hide('manager')}>{row.manager || '—'}</Redact></td><td className="mono"><Redact {...hide('phone')}>{row.phone || '—'}</Redact></td><td><Redact {...hide('email')}>{row.email || '—'}</Redact></td><td className="mono"><Redact {...hide('biz_no')}>{row.biz_no || '—'}</Redact></td><td><Redact {...hide('account')}>{row.account || '—'}</Redact></td><td>{label(`category.${row.category ?? 'customer'}`)}</td><td>{label(`status.${row.status ?? 'active'}`)}</td><td className="act"><EditButton disabled={blocked} onClick={() => launch('customer', row)} /></td></tr>;
    })} />
  </div>;
}

export default function BusinessPage({ space, tab: requested = 'analytics', openId }) {
  const savedTabs = useStore((st) => st.layouts['biztabs:me']?.items);
  const tab = requested === 'performance' ? 'marketing' : requested;
  useLang();
  const business = useBusiness(space);
  const { data, busy, uncertain, loading, error } = business;
  const [dialog, setDialog] = useState(null), [formError, setFormError] = useState(null);
  useEffect(() => { setDialog(null); setFormError(null); }, [space, business.scopeKey, tab]); // 탭을 옮기면 이전 탭의 실패 안내는 지운다
  const path = `${baseOf(space)}/business`;
  // 카드는 지금 탭 위에서 연다(유건 9/29: 청구·입금에서 거래명을 누르면 거래 탭으로 넘어가 보던 목록을 잃었다). open = 거래 id | c:<거래처> | i:<상품>
  const openRecord = (value) => navigate(`${location.pathname}?open=${encodeURIComponent(value)}`);
  const openOrder = (id) => openRecord(id);
  const openCard = (kind, id) => openRecord(`${kind}:${id}`);
  const closeOrder = () => navigate(location.pathname);
  const blocked = busy || uncertain || !data?.can_write;
  const launch = (kind, value = {}) => { setFormError(null); setDialog({ kind, value }); };
  const run = async (action, payload, { quiet = false } = {}) => { // quiet: 자기 창에서 오류를 보여 주는 호출(단계 창)
    setFormError(null);
    try { const result = await business.mutate(action, payload); showToast(label('saved')); return result; }
    catch (failure) { if (!quiet) setFormError(businessError(failure)); throw failure; }
  };
  const enabledTabs = data?.settings?.enabled || MODULES;
  // 꺼 둔 탭 주소(사이드바 '업무' 포함)로 오면 켜진 첫 탭을 보여 준다
  const current = MODULES.includes(tab) && enabledTabs.includes(tab) ? tab : (enabledTabs.includes('analytics') ? 'analytics' : MODULES.find((key) => enabledTabs.includes(key)) ?? 'analytics');
  const [settings, setSettings] = useState(false);
  useEffect(() => { if (tab === 'modules') setSettings(true); }, [tab]); // 예전 '모듈 관리' 주소는 켜고 끄기 창으로 연다
  const closeSettings = useCallback(() => { setSettings(false); if (tab === 'modules') navigate(`${path}/${current}`); }, [tab, path, current]);
  const refresh = () => { business.refresh().catch(() => {}); window.dispatchEvent(new Event('office:biz-refresh')); };
  const pageMenu = (event) => openMenu(event, [
    { label: t('biz.refresh'), icon: 'refresh', run: refresh },
    ...(data && data.can_manage !== false ? [{ label: label('modules'), icon: 'layout', run: () => setSettings(true) }] : []),
  ], { anchor: event.currentTarget });
  const addButton = (onAdd, disabled) => <button type="button" className="btn sm" disabled={disabled} onClick={onAdd}><Icon name="plus" size={13} />{label('add')}</button>;
  const tabAction = data && enabledNow(data, current) && {
    customers: addButton(() => launch('customer'), blocked),
    catalog: addButton(() => launch('item', { kind: 'service', price: 0 }), blocked),
    orders: addButton(() => launch('order'), blocked || !data.customers.length || !data.items.length),
    payments: addButton(() => launch('entry', { kind: 'invoice' }), blocked || !data.orders.some((o) => o.status === 'confirmed')),
    inventory: <InfoTip end text={label('singleStock')} />,
  }[current];
  const enabled = data?.settings?.enabled || MODULES;
  const tabs = orderTabs(MODULES, enabled, savedTabs); // 내 탭 순서(사람마다)
  function enabledNow(d, key) { return (d.settings?.enabled || MODULES).includes(key); }
  const [openKind, openRef] = openId?.includes(':') ? openId.split(':') : ['order', openId];
  const order = openKind === 'order' ? data?.orders.find((row) => row.id === openRef) : null;
  const customer = openKind === 'c' ? data?.customers.find((row) => row.id === openRef) : null;
  const item = openKind === 'i' ? data?.items.find((row) => row.id === openRef) : null;
  const dismiss = () => { if (!busy) setDialog(null); };

  return <section className="page-wrap wide bizui-page">
    <header className="page-title-row"><div><h1 className="page-h1">{label('title')}</h1><p className="dim">{label('subtitle')}</p></div><button type="button" className="icon-btn" aria-label={t('more')} disabled={busy || loading} onClick={pageMenu}><Icon name="dots" /></button></header>
    <div className="biz-tabbar">
      <nav className="tabs" aria-label={label('title')}><SortableContext items={tabs.map((key) => `biztab:${key}`)} strategy={horizontalListSortingStrategy}>{tabs.map((key) => <BizTab key={key} id={key} order={tabs} to={`${path}/${key}`} on={current === key}>{label(key)}</BizTab>)}</SortableContext></nav>
      {tabAction && <div className="biz-tab-actions">{tabAction}</div>}
    </div>
    {((!data && error) || (formError && !dialog && !openId)) && <p className="bizui-error" role="alert">{t(!data && error ? error : formError)}</p>}
    {uncertain && <div className="bizui-error" role="alert"><span>{label('pending')}</span><button className="btn sm" disabled={busy} onClick={() => { setFormError(null); business.retryPending().catch(() => {}); }}>{label('retry')}</button></div>}
    {loading && !data && <p role="status">{t('biz.loading')}</p>}
    {data && <>
      {!data.can_write && <p className="bizui-muted">{label('readOnly')}</p>}
      {!enabled.includes(current) ? <p className="empty-state">{label('disabled')}</p> : <>
        {current === 'analytics' && <BusinessDashboard business={business} space={space} onOpenOrder={openOrder} />}
        {current === 'marketing' && <Marketing space={space} business={business} />}
        {current === 'customers' && <CustomerTable rows={data.customers} blocked={blocked} run={run} launch={launch} openCard={openCard} />}
        {current === 'catalog' && <Table columns={['name', 'kind', 'sku', 'price', 'edit']} rows={data.items.map((row) => <tr key={row.id}><td><button type="button" className="bizui-link" onClick={() => openCard('i', row.id)}>{row.name}</button></td><td>{label(row.kind)}</td><td>{row.sku || '—'}</td><td className="num">{money(row.price)}</td><td className="act"><EditButton disabled={blocked} onClick={() => launch('item', row)} /></td></tr>)} />}
        {current === 'orders' && <>{(!data.customers.length || !data.items.length) && <p className="bizui-muted">{label('prerequisites')}</p>}<DealBoard data={data} blocked={blocked} run={run} openOrder={openOrder} /></>}
        {current === 'inventory' && <><Table columns={['name', 'sku', 'stock', 'reserved', 'available', 'receive']} rows={data.items.filter((item) => item.kind === 'product').map((row) => <tr key={row.id}><td>{row.name}</td><td>{row.sku || '—'}</td><td className="num">{row.stock}</td><td className="num">{row.reserved}</td><td className="num">{row.stock - row.reserved}</td><td className="act"><EditButton disabled={blocked} onClick={() => launch('receive', { item_id: row.id, quantity: 1 })}>{label('receive')}</EditButton></td></tr>)} /><div className="biz-section"><h2>{label('movements')}</h2></div><Table columns={['date', 'name', 'kind', 'quantity', 'orders']} rows={data.movements.map((row) => <tr key={row.id}><td>{date(row.at)}</td><td>{data.items.find((i) => i.id === row.item_id)?.name}</td><td>{label(row.kind)}</td><td className="num">{row.quantity}</td><td>{row.order_id && <button className="bizui-link" onClick={() => openOrder(row.order_id)}>{data.orders.find((o) => o.id === row.order_id)?.title}</button>}</td></tr>)} /></>}
        {current === 'payments' && <EntryRows entries={data.entries} orders={data.orders} openOrder={openOrder} />}
      </>}
      {openId && <Peek onClose={() => { if (!busy) closeOrder(); }} title={order?.title || customer?.name || item?.name || label('notFound')}>
        {formError && <p className="bizui-error" role="alert">{t(formError)}</p>}
        {uncertain && <div className="bizui-error" role="alert"><p>{label('pending')}</p><button className="btn" disabled={busy} onClick={() => { setFormError(null); business.retryPending().catch(() => {}); }}>{label('retry')}</button></div>}
        {order && <DealDetail order={order} data={data} blocked={blocked} launch={launch} run={run} space={space} refresh={() => business.refresh().catch(() => {})} call={business.call} />}
        {customer && <CustomerCard customer={customer} data={data} blocked={blocked} run={run} launch={launch} openOrder={openOrder} />}
        {item && <ItemCard item={item} data={data} blocked={blocked} launch={launch} openOrder={openOrder} />}
      </Peek>}
      {settings && <Modal open title={label('modules')} onClose={closeSettings} footer={<button type="button" className="btn" onClick={closeSettings}>{label('cancel')}</button>}>
        {(formError || error) && <p className="bizui-error" role="alert">{t(formError || error)}</p>}
        {uncertain && <div className="bizui-error" role="alert"><span>{label('pending')}</span><button className="btn sm" disabled={busy} onClick={() => { setFormError(null); business.retryPending().catch(() => {}); }}>{label('retry')}</button></div>}
        <p className="dim small">{label('moduleHelp')}</p>
        <div className="bizui-module-list">{MODULES.map((key) => <label className="switch-row" key={key}><span>{label(key)}</span><input role="switch" type="checkbox" checked={enabled.includes(key)} disabled={blocked || data.can_manage === false} onChange={(event) => run('settings.save', { ...data.settings, enabled: event.target.checked ? [...enabled, key] : enabled.filter((m) => m !== key) }).catch(() => {})} /></label>)}</div>
      </Modal>}
      {dialog && <BusinessForm key={`${dialog.kind}:${dialog.value.id || ''}`} dialog={dialog} data={data} blocked={blocked} busy={busy} error={formError} dismiss={dismiss} submit={async (action, payload) => { const result = await run(action, payload); setDialog(null); if (action === 'order.create') openOrder(result.id); }} />}
    </>}
  </section>;
}

function BusinessForm({ dialog, data, blocked, busy, error, dismiss, submit }) {
  const formId = useId();
  const { kind } = dialog;
  const [value, setValue] = useState({ name: '', email: '', notes: '', ceo: '', biz_no: '', manager: '', phone: '', address: '', account: '', category: 'customer', status: 'active', sku: '', title: '', customer_id: '', quantity: 1, amount: '', order_id: '', note: '', lines: [{ item_id: '', quantity: 1, unit_price: 0 }], ...dialog.value });
  const [invalid, setInvalid] = useState(false);
  const set = (key, next) => setValue((old) => ({ ...old, [key]: next }));
  const input = (key, props = {}) => <input className="input" value={value[key] ?? ''} onChange={(event) => set(key, event.target.value)} disabled={busy} {...props} />;
  const title = { customer: 'customers', item: 'catalog', order: 'orders', receive: 'receive', fulfill: value.kind === 'service' ? 'deliver' : 'ship', return: 'return', entry: 'payments', cancel: 'cancelOrder' }[kind];
  const entryOrder = data.orders.find((order) => order.id === value.order_id);
  const amounts = entryOrder && balance(entryOrder, data.lines, data.entries);
  const entryMax = amounts && ({ invoice: Math.max(0, amounts.total - amounts.invoiced), credit: amounts.invoiced, payment: Math.max(0, amounts.receivable), refund: amounts.paid })[value.kind];
  const send = async (event) => {
    event.preventDefault(); setInvalid(false);
    let action, payload;
    if (kind === 'customer' || kind === 'item') {
      if (!value.name.trim() || (kind === 'item' && !integer(value.price))) { setInvalid(true); return; }
      action = `${kind}.save`; payload = { name: value.name.trim(), ...(value.id ? { id: value.id, version: value.version } : {}) };
      if (kind === 'customer' && value.biz_no && !/^[0-9-]{1,20}$/.test(value.biz_no)) { setInvalid(true); return; }
      if (kind === 'customer' && !value.id) payload.redacted = ['account', 'biz_no']; // 새 거래처도 이관과 같이 계좌·사업자번호는 가린 채로 시작(유건 9/29 기본 가림)
      Object.assign(payload, kind === 'customer' ? { email: value.email, notes: value.notes, ceo: value.ceo, biz_no: value.biz_no, manager: value.manager, phone: value.phone, address: value.address, account: value.account, category: value.category, status: value.status } : { kind: value.kind, sku: value.sku, price: Number(value.price) });
    } else if (kind === 'order') {
      if (!value.title.trim() || !value.customer_id || !value.lines.every((line) => line.item_id && integer(line.quantity, 1, 1e6) && integer(line.unit_price))) { setInvalid(true); return; }
      action = 'order.create'; payload = { title: value.title.trim(), customer_id: value.customer_id, lines: value.lines.map((line) => ({ item_id: line.item_id, quantity: Number(line.quantity), unit_price: Number(line.unit_price), tax_type: line.tax_type ?? 'taxable' })) };
    } else if (kind === 'entry') {
      if (!value.order_id || !integer(value.amount, 1, entryMax || 0)) { setInvalid(true); return; }
      action = 'entry.create'; payload = { order_id: value.order_id, kind: value.kind, amount: Number(value.amount), note: value.note };
    } else if (kind === 'cancel') { action = 'order.cancel'; payload = { id: value.id }; }
    else {
      if (!integer(value.quantity, 1, Math.min(value.max ?? 1e6, 1e6))) { setInvalid(true); return; }
      action = kind === 'receive' ? 'stock.receive' : `line.${kind}`;
      payload = { ...(kind === 'receive' ? { item_id: value.item_id, note: value.note } : { id: value.id }), quantity: Number(value.quantity) };
    }
    await submit(action, payload).catch(() => {});
  };
  return <Modal open title={label(title)} onClose={dismiss} width={kind === 'order' ? 720 : 480}
    footer={<><button className="btn" type="button" disabled={busy} onClick={dismiss}>{label('cancel')}</button><button className="btn primary" type="submit" form={formId} disabled={blocked || busy}>{busy ? t('biz.loading') : label(kind === 'cancel' ? 'cancelOrder' : 'save')}</button></>}>
    <form id={formId} onSubmit={send}><fieldset className="bizui-form bizui-form-fields" disabled={busy}>
    {(kind === 'customer' || kind === 'item') && <Field name="name">{input('name', { required: true, maxLength: 200 })}</Field>}
    {kind === 'customer' && <><div className="bizui-grid2"><Field name="ceo">{input('ceo', { maxLength: 100 })}</Field><Field name="biz_no">{input('biz_no', { maxLength: 20, inputMode: 'numeric', pattern: '[0-9-]*' })}</Field>
      <Field name="manager">{input('manager', { maxLength: 100 })}</Field><Field name="phone">{input('phone', { type: 'tel', maxLength: 50 })}</Field>
      <Field name="email">{input('email', { type: 'email', maxLength: 320 })}</Field><Field name="account">{input('account', { maxLength: 200 })}</Field>
      <Field name="category"><select className="input" value={value.category} onChange={(event) => set('category', event.target.value)}>{['customer', 'partner'].map((key) => <option key={key} value={key}>{label(`category.${key}`)}</option>)}</select></Field>
      <Field name="customerStatus"><select className="input" value={value.status} onChange={(event) => set('status', event.target.value)}>{['active', 'hold', 'closed'].map((key) => <option key={key} value={key}>{label(`status.${key}`)}</option>)}</select></Field></div>
      <Field name="address">{input('address', { maxLength: 500 })}</Field><Field name="notes"><textarea className="input area" maxLength={10000} value={value.notes} onChange={(event) => set('notes', event.target.value)} /></Field></>}
    {kind === 'item' && <><Field name="kind"><select className="input" value={value.kind} disabled={busy || !!value.id} onChange={(event) => set('kind', event.target.value)}>{['service', 'product'].map((key) => <option key={key} value={key}>{label(key)}</option>)}</select></Field><Field name="sku">{input('sku', { maxLength: 100 })}</Field><Field name="price">{input('price', { type: 'number', min: 0, max: 1e12, step: 1, required: true })}</Field></>}
    {kind === 'order' && <><Field name="titleField">{input('title', { required: true, maxLength: 200 })}</Field><Field name="customer"><select className="input" required value={value.customer_id} onChange={(event) => set('customer_id', event.target.value)}><option value="">{label('choose')}</option>{data.customers.map((customer) => <option key={customer.id} value={customer.id}>{customer.name}</option>)}</select></Field>
      {value.lines.map((line, index) => { const update = (patch) => set('lines', value.lines.map((row, i) => i === index ? { ...row, ...patch } : row)); return <fieldset className="bizui-order-line" key={index}><legend>{label('line')} {index + 1}</legend><Field name="catalog"><select className="input" required value={line.item_id} onChange={(event) => { const item = data.items.find((row) => row.id === event.target.value); update({ item_id: event.target.value, unit_price: item?.price ?? 0 }); }}><option value="">{label('choose')}</option>{data.items.map((item) => <option key={item.id} value={item.id}>{item.name} · {label(item.kind)}</option>)}</select></Field><Field name="quantity"><input className="input" type="number" min="1" max="1000000" step="1" required value={line.quantity} onChange={(event) => update({ quantity: event.target.value })} /></Field><Field name="price"><input className="input" type="number" min="0" max="1000000000000" step="1" required value={line.unit_price} onChange={(event) => update({ unit_price: event.target.value })} /></Field><Field name="taxType"><select className="input" value={line.tax_type ?? 'taxable'} onChange={(event) => update({ tax_type: event.target.value })}>{['taxable', 'zero', 'exempt'].map((key) => <option key={key} value={key}>{label(`tax.${key}`)}</option>)}</select></Field><button className="btn" type="button" disabled={value.lines.length === 1 || busy} onClick={() => set('lines', value.lines.filter((_, i) => i !== index))}>{label('removeLine')}</button></fieldset>; })}
      <button className="btn" type="button" disabled={busy || value.lines.length >= 100} onClick={() => set('lines', [...value.lines, { item_id: '', quantity: 1, unit_price: 0 }])}>{label('addLine')}</button>{(() => { const supply = value.lines.reduce((sum, line) => sum + Number(line.quantity) * Number(line.unit_price), 0), vat = value.lines.reduce((sum, line) => sum + vatOf(Number(line.quantity) * Number(line.unit_price), line.tax_type ?? 'taxable'), 0); return <div className="bizui-total"><span className="dim">{label('supply')} {money(supply)} · {label('vat')} {money(vat)}</span><strong>{money(supply + vat)}</strong></div>; })()}
    </>}
    {['receive', 'fulfill', 'return'].includes(kind) && <Field name="quantity">{input('quantity', { type: 'number', min: 1, max: value.max ?? 1e6, step: 1, required: true })}</Field>}
    {kind === 'entry' && <><Field name="orders"><select className="input" required value={value.order_id} onChange={(event) => set('order_id', event.target.value)}><option value="">{label('choose')}</option>{data.orders.filter((order) => order.status === 'confirmed').map((order) => <option key={order.id} value={order.id}>{order.title}</option>)}</select></Field><Field name="kind"><select className="input" value={value.kind} onChange={(event) => set('kind', event.target.value)}>{['invoice', 'credit', 'payment', 'refund'].map((key) => <option key={key} value={key}>{label(key)}</option>)}</select></Field><Field name="amount">{input('amount', { type: 'number', required: true, min: 1, max: entryMax ?? 1e12, step: 1 })}</Field>{amounts && <p className="bizui-muted">{label('limit')}: {money(entryMax)}</p>}</>}
    {['entry', 'receive'].includes(kind) && <Field name="notes">{input('note', { maxLength: 10000 })}</Field>}
    {kind === 'cancel' && <p>{label(value.billed > 0 ? 'cancelBodyBilled' : 'cancelBody')}</p>}
    {(error || invalid) && <p className="bizui-error" role="alert">{t(error || 'bizui.invalid')}</p>}
  </fieldset></form></Modal>;
}
