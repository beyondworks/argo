import { useEffect, useId, useState } from 'react';
import { t, useLang, getLang } from '../core/i18n.js';
import { baseOf } from '../core/commands.js';
import { Link, navigate } from '../core/router.jsx';
import { Modal, Sheet, showToast } from '../ui/Overlay.jsx';
import { useBusiness, businessError } from './data.js';
import { BusinessDashboard } from './Dashboard.jsx';
import Marketing from './Marketing.jsx';
import './business.css';
import { BUSINESS_MODULES } from '../core/module-registry.js';

const MODULES = BUSINESS_MODULES.map((module) => module.businessTab);
const money = (amount) => new Intl.NumberFormat(getLang() === 'en' ? 'en-US' : 'ko-KR', { style: 'currency', currency: 'KRW', maximumFractionDigits: 0 }).format(Number(amount || 0));
const integer = (value, min = 0, max = 1e12) => Number.isSafeInteger(Number(value)) && Number(value) >= min && Number(value) <= max;
const label = (key) => t(`bizui.${key}`);
const date = (value) => new Date(value).toLocaleString(getLang() === 'en' ? 'en-US' : 'ko-KR');

function Field({ name, children }) {
  return <label className="field-block bizui-field"><span className="label">{label(name)}</span>{children}</label>;
}
function Table({ columns, rows }) {
  return rows.length ? <div className="table-wrap bizui-table-wrap"><table className="table bizui-table"><thead><tr>{columns.map((column) => <th key={column}>{label(column)}</th>)}</tr></thead><tbody>{rows}</tbody></table></div> : <p className="empty-state">{label('empty')}</p>;
}
function EntryRows({ entries, orders, openOrder }) {
  return <Table columns={['date', 'orders', 'kind', 'amount', 'notes']} rows={entries.map((entry) => <tr key={entry.id}>
    <td>{date(entry.at)}</td><td><button className="bizui-link" onClick={() => openOrder(entry.order_id)}>{orders.find((o) => o.id === entry.order_id)?.title || '—'}</button></td>
    <td>{label(entry.kind)}</td><td>{money(entry.amount)}</td><td>{entry.note}</td>
  </tr>)} />;
}
function balance(order, lines, entries) {
  const total = lines.filter((line) => line.order_id === order.id).reduce((sum, line) => sum + (line.quantity - line.returned) * line.unit_price, 0);
  const sum = (kind) => entries.filter((entry) => entry.order_id === order.id && entry.kind === kind).reduce((n, entry) => n + Number(entry.amount), 0);
  const invoiced = sum('invoice') - sum('credit'), paid = sum('payment') - sum('refund');
  return { total, invoiced, paid, receivable: invoiced - paid };
}

export default function BusinessPage({ space, tab = 'analytics', openId }) {
  useLang();
  const business = useBusiness(space);
  const { data, busy, uncertain, loading, error } = business;
  const [dialog, setDialog] = useState(null), [formError, setFormError] = useState(null);
  useEffect(() => { setDialog(null); setFormError(null); }, [space, business.scopeKey]);
  const path = `${baseOf(space)}/business`;
  const openOrder = (id) => navigate(`${path}/orders?open=${encodeURIComponent(id)}`);
  const closeOrder = () => navigate(`${path}/orders`);
  const blocked = busy || uncertain || !data?.can_write;
  const launch = (kind, value = {}) => { setFormError(null); setDialog({ kind, value }); };
  const run = async (action, payload) => {
    setFormError(null);
    try { const result = await business.mutate(action, payload); showToast(label('saved')); return result; }
    catch (failure) { setFormError(businessError(failure)); throw failure; }
  };
  const current = MODULES.includes(tab) || tab === 'modules' ? tab : 'analytics';
  const enabled = data?.settings?.enabled || MODULES;
  const order = data?.orders.find((row) => row.id === openId);
  const dismiss = () => { if (!busy) setDialog(null); };

  return <section className="page-wrap wide bizui-page">
    <header className="page-title-row"><div><h1 className="page-h1">{label('title')}</h1><p className="dim">{label('subtitle')}</p></div><button className="btn" disabled={busy || loading} onClick={() => business.refresh().catch(() => {})}>{t('biz.refresh')}</button></header>
    <nav className="tabs bizui-tabs" aria-label={label('title')}>{[...MODULES.filter((key) => enabled.includes(key)), 'modules'].map((key) => <Link key={key} to={`${path}/${key}`} className={`tab${current === key ? ' on' : ''}`} aria-current={current === key ? 'page' : undefined}>{label(key)}</Link>)}</nav>
    {error && <p className="bizui-error" role="alert">{t(error)}</p>}
    {uncertain && <div className="bizui-error" role="alert"><p>{label('pending')}</p><button className="btn" disabled={busy} onClick={() => business.retryPending().catch(() => {})}>{label('retry')}</button></div>}
    {loading && !data && <p role="status">{t('biz.loading')}</p>}
    {data && <>
      {!data.can_write && <p className="bizui-muted">{label('readOnly')}</p>}
      {current !== 'modules' && !enabled.includes(current) ? <p className="empty-state">{label('disabled')}</p> : <>
        {current === 'analytics' && <BusinessDashboard business={business} space={space} onOpenOrder={openOrder} />}
        {['marketing', 'performance'].includes(current) && <Marketing space={space} tab={current} business={business} />}
        {current === 'modules' && <div className="bizui-module-list"><p>{label('moduleHelp')}</p>{MODULES.map((key) => <label className="switch-row" key={key}><span>{label(key)}</span><input role="switch" type="checkbox" checked={enabled.includes(key)} disabled={blocked || data.can_manage === false} onChange={(event) => run('settings.save', { ...data.settings, enabled: event.target.checked ? [...enabled, key] : enabled.filter((m) => m !== key) }).catch(() => {})} /></label>)}</div>}
        {current === 'customers' && <><Toolbar title="customers" blocked={blocked} onAdd={() => launch('customer')} /><Table columns={['name', 'email', 'notes', 'edit']} rows={data.customers.map((row) => <tr key={row.id}><td>{row.name}</td><td>{row.email || '—'}</td><td>{row.notes}</td><td><button className="btn" disabled={blocked} onClick={() => launch('customer', row)}>{label('edit')}</button></td></tr>)} /></>}
        {current === 'catalog' && <><Toolbar title="catalog" blocked={blocked} onAdd={() => launch('item', { kind: 'service', price: 0 })} /><Table columns={['name', 'kind', 'sku', 'price', 'edit']} rows={data.items.map((row) => <tr key={row.id}><td>{row.name}</td><td>{label(row.kind)}</td><td>{row.sku || '—'}</td><td>{money(row.price)}</td><td><button className="btn" disabled={blocked} onClick={() => launch('item', row)}>{label('edit')}</button></td></tr>)} /></>}
        {current === 'orders' && <><Toolbar title="orders" blocked={blocked || !data.customers.length || !data.items.length} onAdd={() => launch('order')} />{(!data.customers.length || !data.items.length) && <p className="bizui-muted">{label('prerequisites')}</p>}<Table columns={['titleField', 'customer', 'status', 'total', 'receivable']} rows={data.orders.map((row) => { const amounts = balance(row, data.lines, data.entries); return <tr key={row.id}><td><button className="bizui-link" onClick={() => openOrder(row.id)}>{row.title}</button></td><td>{data.customers.find((c) => c.id === row.customer_id)?.name}</td><td>{label(row.status)}</td><td>{money(row.status === 'cancelled' ? 0 : amounts.total)}</td><td>{money(amounts.receivable)}</td></tr>; })} /></>}
        {current === 'inventory' && <><h2>{label('inventory')}</h2><p className="bizui-muted">{label('singleStock')}</p><Table columns={['name', 'sku', 'stock', 'reserved', 'available', 'receive']} rows={data.items.filter((item) => item.kind === 'product').map((row) => <tr key={row.id}><td>{row.name}</td><td>{row.sku || '—'}</td><td>{row.stock}</td><td>{row.reserved}</td><td>{row.stock - row.reserved}</td><td><button className="btn" disabled={blocked} onClick={() => launch('receive', { item_id: row.id, quantity: 1 })}>{label('receive')}</button></td></tr>)} /><h3>{label('movements')}</h3><Table columns={['date', 'name', 'kind', 'quantity', 'orders']} rows={data.movements.map((row) => <tr key={row.id}><td>{date(row.at)}</td><td>{data.items.find((i) => i.id === row.item_id)?.name}</td><td>{label(row.kind)}</td><td>{row.quantity}</td><td>{row.order_id && <button className="bizui-link" onClick={() => openOrder(row.order_id)}>{data.orders.find((o) => o.id === row.order_id)?.title}</button>}</td></tr>)} /></>}
        {current === 'payments' && <><Toolbar title="payments" blocked={blocked || !data.orders.some((o) => o.status === 'confirmed')} onAdd={() => launch('entry', { kind: 'invoice' })} /><EntryRows entries={data.entries} orders={data.orders} openOrder={openOrder} /></>}
      </>}
      {current === 'orders' && openId && <Sheet open onClose={() => { if (!busy) closeOrder(); }} title={order?.title || label('notFound')}>
        {(formError || error) && <p className="bizui-error" role="alert">{t(formError || error)}</p>}
        {uncertain && <div className="bizui-error" role="alert"><p>{label('pending')}</p><button className="btn" disabled={busy} onClick={() => business.retryPending().catch(() => {})}>{label('retry')}</button></div>}
        {order && <OrderDetail order={order} data={data} blocked={blocked} launch={launch} run={run} openOrder={openOrder} />}
      </Sheet>}
      {dialog && <BusinessForm key={`${dialog.kind}:${dialog.value.id || ''}`} dialog={dialog} data={data} blocked={blocked} busy={busy} error={formError} dismiss={dismiss} submit={async (action, payload) => { const result = await run(action, payload); setDialog(null); if (action === 'order.create') openOrder(result.id); }} />}
    </>}
  </section>;
}

function Toolbar({ title, blocked, onAdd }) {
  return <div className="page-title-row bizui-toolbar"><h2>{label(title)}</h2><button className="btn" disabled={blocked} onClick={onAdd}>{label('add')}</button></div>;
}

function OrderDetail({ order, data, blocked, launch, run, openOrder }) {
  const lines = data.lines.filter((line) => line.order_id === order.id);
  const entries = data.entries.filter((entry) => entry.order_id === order.id);
  const amounts = balance(order, lines, entries);
  const limits = { invoice: Math.max(0, amounts.total - amounts.invoiced), credit: amounts.invoiced, payment: Math.max(0, amounts.receivable), refund: amounts.paid };
  return <div className="bizui-detail"><p>{data.customers.find((customer) => customer.id === order.customer_id)?.name} · {label(order.status)}</p>
    <dl className="bizui-balances">{['total', 'invoiced', 'paid', 'receivable'].map((key) => <div key={key}><dt>{label(key)}</dt><dd>{money(order.status === 'cancelled' && key === 'total' ? 0 : amounts[key])}</dd></div>)}</dl>
    <div className="bizui-actions">{order.status === 'draft' && <button className="btn" disabled={blocked} onClick={() => run('order.confirm', { id: order.id }).catch(() => {})}>{label('confirmOrder')}</button>}
      {order.status !== 'cancelled' && !lines.some((line) => line.fulfilled) && !entries.length && <button className="btn" disabled={blocked} onClick={() => launch('cancel', { id: order.id })}>{label('cancelOrder')}</button>}
    </div>
    {lines.map((line) => <article className="stat-card bizui-line-card" key={line.id}><h3>{line.name} <span className="bizui-muted">{label(line.kind)}</span></h3><p>{line.quantity} × {money(line.unit_price)}</p><p>{label('fulfilled')}: {line.fulfilled} · {label('returned')}: {line.returned}</p>
      {order.status === 'confirmed' && <div className="bizui-actions"><button className="btn" disabled={blocked || line.fulfilled >= line.quantity} onClick={() => launch('fulfill', { id: line.id, quantity: line.quantity - line.fulfilled, max: line.quantity - line.fulfilled, kind: line.kind })}>{label(line.kind === 'service' ? 'deliver' : 'ship')}</button>{line.kind === 'product' && <button className="btn" disabled={blocked || line.fulfilled <= line.returned} onClick={() => launch('return', { id: line.id, quantity: 1, max: line.fulfilled - line.returned })}>{label('return')}</button>}</div>}
    </article>)}
    {order.status === 'confirmed' && <div className="bizui-actions">{Object.keys(limits).map((kind) => <button key={kind} className="btn" disabled={blocked || limits[kind] <= 0} onClick={() => launch('entry', { order_id: order.id, kind, amount: limits[kind] })}>{label(kind)}</button>)}</div>}
    <h3>{label('entries')}</h3><EntryRows entries={entries} orders={data.orders} openOrder={openOrder} />
  </div>;
}

function BusinessForm({ dialog, data, blocked, busy, error, dismiss, submit }) {
  const formId = useId();
  const { kind } = dialog;
  const [value, setValue] = useState({ name: '', email: '', notes: '', sku: '', title: '', customer_id: '', quantity: 1, amount: '', order_id: '', note: '', lines: [{ item_id: '', quantity: 1, unit_price: 0 }], ...dialog.value });
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
      Object.assign(payload, kind === 'customer' ? { email: value.email, notes: value.notes } : { kind: value.kind, sku: value.sku, price: Number(value.price) });
    } else if (kind === 'order') {
      if (!value.title.trim() || !value.customer_id || !value.lines.every((line) => line.item_id && integer(line.quantity, 1, 1e6) && integer(line.unit_price))) { setInvalid(true); return; }
      action = 'order.create'; payload = { title: value.title.trim(), customer_id: value.customer_id, lines: value.lines.map((line) => ({ item_id: line.item_id, quantity: Number(line.quantity), unit_price: Number(line.unit_price) })) };
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
    {kind === 'customer' && <><Field name="email">{input('email', { type: 'email', maxLength: 320 })}</Field><Field name="notes"><textarea className="input area" maxLength={10000} value={value.notes} onChange={(event) => set('notes', event.target.value)} /></Field></>}
    {kind === 'item' && <><Field name="kind"><select className="input" value={value.kind} disabled={busy || !!value.id} onChange={(event) => set('kind', event.target.value)}>{['service', 'product'].map((key) => <option key={key} value={key}>{label(key)}</option>)}</select></Field><Field name="sku">{input('sku', { maxLength: 100 })}</Field><Field name="price">{input('price', { type: 'number', min: 0, max: 1e12, step: 1, required: true })}</Field></>}
    {kind === 'order' && <><Field name="titleField">{input('title', { required: true, maxLength: 200 })}</Field><Field name="customer"><select className="input" required value={value.customer_id} onChange={(event) => set('customer_id', event.target.value)}><option value="">{label('choose')}</option>{data.customers.map((customer) => <option key={customer.id} value={customer.id}>{customer.name}</option>)}</select></Field>
      {value.lines.map((line, index) => { const update = (patch) => set('lines', value.lines.map((row, i) => i === index ? { ...row, ...patch } : row)); return <fieldset className="bizui-order-line" key={index}><legend>{label('line')} {index + 1}</legend><Field name="catalog"><select className="input" required value={line.item_id} onChange={(event) => { const item = data.items.find((row) => row.id === event.target.value); update({ item_id: event.target.value, unit_price: item?.price ?? 0 }); }}><option value="">{label('choose')}</option>{data.items.map((item) => <option key={item.id} value={item.id}>{item.name} · {label(item.kind)}</option>)}</select></Field><Field name="quantity"><input className="input" type="number" min="1" max="1000000" step="1" required value={line.quantity} onChange={(event) => update({ quantity: event.target.value })} /></Field><Field name="price"><input className="input" type="number" min="0" max="1000000000000" step="1" required value={line.unit_price} onChange={(event) => update({ unit_price: event.target.value })} /></Field><button className="btn" type="button" disabled={value.lines.length === 1 || busy} onClick={() => set('lines', value.lines.filter((_, i) => i !== index))}>{label('removeLine')}</button></fieldset>; })}
      <button className="btn" type="button" disabled={busy || value.lines.length >= 100} onClick={() => set('lines', [...value.lines, { item_id: '', quantity: 1, unit_price: 0 }])}>{label('addLine')}</button><strong>{label('total')}: {money(value.lines.reduce((sum, line) => sum + Number(line.quantity) * Number(line.unit_price), 0))}</strong>
    </>}
    {['receive', 'fulfill', 'return'].includes(kind) && <Field name="quantity">{input('quantity', { type: 'number', min: 1, max: value.max ?? 1e6, step: 1, required: true })}</Field>}
    {kind === 'entry' && <><Field name="orders"><select className="input" required value={value.order_id} onChange={(event) => set('order_id', event.target.value)}><option value="">{label('choose')}</option>{data.orders.filter((order) => order.status === 'confirmed').map((order) => <option key={order.id} value={order.id}>{order.title}</option>)}</select></Field><Field name="kind"><select className="input" value={value.kind} onChange={(event) => set('kind', event.target.value)}>{['invoice', 'credit', 'payment', 'refund'].map((key) => <option key={key} value={key}>{label(key)}</option>)}</select></Field><Field name="amount">{input('amount', { type: 'number', required: true, min: 1, max: entryMax ?? 1e12, step: 1 })}</Field>{amounts && <p className="bizui-muted">{label('limit')}: {money(entryMax)}</p>}</>}
    {['entry', 'receive'].includes(kind) && <Field name="notes">{input('note', { maxLength: 10000 })}</Field>}
    {kind === 'cancel' && <p>{label('cancelBody')}</p>}
    {(error || invalid) && <p className="bizui-error" role="alert">{t(error || 'bizui.invalid')}</p>}
  </fieldset></form></Modal>;
}
