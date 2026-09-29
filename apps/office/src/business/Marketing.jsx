import { useEffect, useId, useRef, useState } from 'react';
import { t, useLang, getLang } from '../core/i18n.js';
import { Modal, showToast } from '../ui/Overlay.jsx';
import PerformanceBoard from './PerformanceBoard.jsx';
import { useMarketing, marketingError } from './marketing-data.js';
import { defaultPeriod, validateFilters } from './dashboard-model.js';

const label = (key) => t(`mkt.${key}`);
const localDate = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const initialPeriod = () => { const { from, to } = defaultPeriod(); return { from, to, campaign: null }; };
const numeric = (value, minimum = 0) => { const number = Number(value); if (value === '' || !Number.isSafeInteger(number) || number < minimum || number > 1e12) throw new Error('biz.error.input'); return number; };
const format = (key, value) => {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  if (key === 'ratio' || key === 'roas') return `${(Number(value) * 100).toLocaleString(getLang() === 'en' ? 'en-US' : 'ko-KR', { maximumFractionDigits: 1 })}%`;
  return new Intl.NumberFormat(getLang() === 'en' ? 'en-US' : 'ko-KR', ['spend', 'sales', 'paid', 'cpl', 'budget'].includes(key) ? { style: 'currency', currency: 'KRW', maximumFractionDigits: 0 } : { maximumFractionDigits: 0 }).format(Number(value));
};

export function marketingPayload(kind, value) {
  const identity = value.id ? { id: value.id, version: value.version } : {};
  if (kind === 'attribution') return { order_id: value.order_id, campaign_id: value.campaign_id || null, version: value.version ?? 0 };
  if (kind === 'daily') return { ...identity, campaign_id: value.campaign_id, date: value.date, source: 'manual', ...Object.fromEntries(['spend', 'impressions', 'clicks', 'leads'].map((key) => [key, numeric(value[key])])) };
  validateFilters({ from: value.starts_on, to: value.ends_on });
  if (!value.name.trim()) throw new Error('biz.error.input');
  const base = { ...identity, name: value.name.trim(), starts_on: value.starts_on, ends_on: value.ends_on };
  if (kind === 'goal') return { ...base, campaign_id: value.campaign_id || null, metric: value.metric, target: numeric(value.target, 1) };
  return { ...base, channel: value.channel.trim(), budget: numeric(value.budget), status: value.status, notes: value.notes || '' };
}

function Field({ name, children }) { return <label className="field-block bizui-field"><span className="label">{label(name)}</span>{children}</label>; }
function Table({ columns, children, empty }) { return empty ? <p className="empty-state">{t('bizui.empty')}</p> : <div className="table-wrap bizui-table-wrap"><table className="table bizui-table"><thead><tr>{columns.map((column) => <th key={column}>{column === 'edit' ? t('bizui.edit') : label(column)}</th>)}</tr></thead><tbody>{children}</tbody></table></div>; }
function SectionTitle({ name, disabled, onAdd }) { return <div className="page-title-row bizui-toolbar"><h2>{label(name)}</h2>{onAdd && <button type="button" className="btn" disabled={disabled} onClick={onAdd}>{t('bizui.add')}</button>}</div>; }

export default function Marketing({ space, tab = 'marketing', business }) {
  useLang();
  const marketing = useMarketing(space);
  const { data, loading, busy, uncertain, error } = marketing;
  const [dialog, setDialog] = useState(null), [formError, setFormError] = useState(null);
  const [filters, setFilters] = useState(initialPeriod), [draft, setDraft] = useState(initialPeriod);
  const [reportState, setReport] = useState(null), [reportError, setReportError] = useState(null), [reportLoading, setReportLoading] = useState(false), [revision, setRevision] = useState(0);
  const scope = useRef(marketing.scopeKey), sequence = useRef(0);
  scope.current = marketing.scopeKey;
  const blocked = busy || uncertain || !data?.can_write;
  const campaigns = data?.campaigns ?? [], orders = business?.data?.orders ?? [];
  const reportKey = JSON.stringify([marketing.scopeKey, tab, filters]);
  const report = data && business?.data && reportState?.key === reportKey ? reportState.value : null;
  const campaignName = (id) => campaigns.find((campaign) => campaign.id === id)?.name ?? label('unattributed');
  useEffect(() => { setDialog(null); setFormError(null); setFilters(initialPeriod()); setDraft(initialPeriod()); }, [space, marketing.scopeKey]);
  useEffect(() => {
    const request = ++sequence.current;
    setReportError(null);
    if (!data || !business?.data || tab !== 'performance') { setReport(null); setReportLoading(false); return; }
    setReportLoading(true);
    marketing.report(filters).then((result) => { if (request === sequence.current) setReport({ key: reportKey, value: result }); }).catch((failure) => { if (request === sequence.current) { setReport(null); setReportError(marketingError(failure)); } }).finally(() => { if (request === sequence.current) setReportLoading(false); });
    return () => { sequence.current += 1; };
  }, [data, business?.data, reportKey, marketing.report, revision]);
  const launch = (kind, value = {}) => { setFormError(null); setDialog({ kind, value }); };
  const refresh = () => { marketing.refresh().catch(() => {}); setRevision((value) => value + 1); };
  const retry = async () => {
    const captured = dialog, currentScope = scope.current;
    try {
      const result = await marketing.retryPending();
      if (result?.id && scope.current === currentScope) { setDialog((current) => current === captured ? null : current); setFormError(null); showToast(t('bizui.saved')); }
    } catch (failure) { if (scope.current === currentScope) setFormError(marketingError(failure)); }
  };
  const pendingNotice = uncertain && <div className="bizui-error" role="alert"><p>{t('bizui.pending')}</p><button type="button" className="btn" disabled={busy} onClick={retry}>{t('bizui.retry')}</button></div>;
  const save = async (kind, value) => {
    const captured = dialog, currentScope = scope.current;
    setFormError(null);
    try {
      await marketing.mutate(`${kind}.save`, marketingPayload(kind, value));
      if (scope.current === currentScope) { setDialog((current) => current === captured ? null : current); showToast(t('bizui.saved')); }
    } catch (failure) { if (scope.current === currentScope) setFormError(marketingError(failure)); }
  };
  const apply = (event) => {
    event.preventDefault();
    try { validateFilters({ ...draft, customer: null }); setFilters({ ...draft }); setReportError(null); }
    catch (failure) { setReportError(marketingError(failure)); }
  };
  return <section aria-label={label(tab === 'performance' ? 'performance' : 'campaigns')}>
    <div className="row-actions"><button type="button" className="btn ghost" disabled={busy || loading} onClick={refresh}>{t('biz.refresh')}</button></div>
    {error && <p className="bizui-error" role="alert">{t(error)}</p>}{pendingNotice}
    {loading && !data && <p role="status">{t('biz.loading')}</p>}
    {data && <>
      {!data.can_write && <p className="bizui-muted">{t('bizui.readOnly')}</p>}
      <p className="biz-source">{label('sourceHelp')}</p>
      {tab === 'performance' ? <>
        <SectionTitle name="performance" /><p className="biz-source">{label('reportBasis')}</p>
        <form className="biz-dashboard-filters" onSubmit={apply}>
          <Field name="starts_on"><input className="input" type="date" required value={draft.from} onChange={(event) => setDraft({ ...draft, from: event.target.value })} /></Field>
          <Field name="ends_on"><input className="input" type="date" required value={draft.to} onChange={(event) => setDraft({ ...draft, to: event.target.value })} /></Field>
          <Field name="campaign_id"><select className="input" value={draft.campaign || ''} onChange={(event) => setDraft({ ...draft, campaign: event.target.value || null })}><option value="">{label('all')}</option>{campaigns.map((campaign) => <option key={campaign.id} value={campaign.id}>{campaign.name}</option>)}</select></Field>
          <button className="btn" disabled={reportLoading}>{t('biz.filters.apply')}</button>
        </form>
        {reportError && <p className="bizui-error" role="alert">{t(reportError)}</p>}{reportLoading && <p role="status">{t('biz.loading')}</p>}
        {report && <PerformanceBoard space={space} business={business} report={report} campaigns={campaigns} formatValue={format} />}
        <SectionTitle name="goals" disabled={blocked} onAdd={() => launch('goal')} /><p className="biz-source">{label('goalHelp')}</p>
        <Table columns={['name', 'campaign_id', 'period', 'metric', 'target', 'actual', 'ratio', 'edit']} empty={!data.goals.length}>{data.goals.map((goal) => { const result = report?.goals?.find((entry) => entry.id === goal.id); return <tr key={goal.id}><td>{goal.name}</td><td>{goal.campaign_id ? campaignName(goal.campaign_id) : label('all')}</td><td>{goal.starts_on} – {goal.ends_on}</td><td>{label(goal.metric)}</td><td>{format(goal.metric, goal.target)}</td><td>{format(goal.metric, result?.actual)}</td><td>{format('ratio', result?.ratio)}</td><td><button className="btn sm" disabled={blocked} onClick={() => launch('goal', goal)}>{t('bizui.edit')}</button></td></tr>; })}</Table>
      </> : <>
        <SectionTitle name="campaigns" disabled={blocked} onAdd={() => launch('campaign')} />
        <Table columns={['name', 'channel', 'period', 'budget', 'status', 'edit']} empty={!campaigns.length}>{campaigns.map((campaign) => <tr key={campaign.id}><td>{campaign.name}</td><td>{campaign.channel}</td><td>{campaign.starts_on} – {campaign.ends_on}</td><td>{format('budget', campaign.budget)}</td><td><span className="badge">{label(campaign.status)}</span></td><td><button className="btn sm" disabled={blocked} onClick={() => launch('campaign', campaign)}>{t('bizui.edit')}</button></td></tr>)}</Table>
        <SectionTitle name="daily" disabled={blocked || !campaigns.length} onAdd={() => launch('daily')} /><p className="biz-source">{label(campaigns.length ? 'dailyHelp' : 'noCampaigns')}</p>
        <Table columns={['date', 'campaign_id', 'spend', 'impressions', 'clicks', 'leads', 'source', 'edit']} empty={!data.daily.length}>{data.daily.map((row) => <tr key={row.id}><td>{row.date}</td><td>{campaignName(row.campaign_id)}</td>{['spend', 'impressions', 'clicks', 'leads'].map((key) => <td key={key}>{format(key, row[key])}</td>)}<td>{label(row.source)}</td><td><button className="btn sm" disabled={blocked} onClick={() => launch('daily', row)}>{t('bizui.edit')}</button></td></tr>)}</Table>
        <SectionTitle name="attribution" /><p className="biz-source">{label('attributionHelp')}</p>
        <Table columns={['order_id', 'campaign_id', 'edit']} empty={!orders.length}>{orders.map((order) => { const attribution = data.attributions.find((row) => row.order_id === order.id); return <tr key={order.id}><td>{order.title}</td><td>{campaignName(attribution?.campaign_id)}</td><td><button className="btn sm" disabled={blocked} onClick={() => launch('attribution', { order_id: order.id, campaign_id: attribution?.campaign_id ?? '', version: attribution?.version ?? 0 })}>{label('connect')}</button></td></tr>; })}</Table>
      </>}
      {dialog && <MarketingForm key={`${dialog.kind}:${dialog.value.id || dialog.value.order_id || ''}`} dialog={dialog} campaigns={campaigns} orders={orders} blocked={blocked} busy={busy} error={formError} pendingNotice={pendingNotice} dismiss={() => { if (!busy) setDialog(null); }} save={save} />}
    </>}
  </section>;
}

function MarketingForm({ dialog, campaigns, orders, blocked, busy, error, pendingNotice, dismiss, save }) {
  const id = useId(), { kind } = dialog;
  const [value, setValue] = useState({ name: '', channel: '', starts_on: localDate(), ends_on: localDate(), budget: 0, status: 'active', notes: '', campaign_id: '', date: localDate(), spend: 0, impressions: 0, clicks: 0, leads: 0, metric: 'sales', target: 1, ...dialog.value });
  const set = (key, next) => setValue((old) => ({ ...old, [key]: next }));
  const input = (name, props = {}) => <Field name={name}><input className="input" value={value[name]} onChange={(event) => set(name, event.target.value)} {...props} /></Field>;
  const campaignSelect = (optional) => <Field name="campaign_id"><select className="input" required={!optional} disabled={kind === 'daily' && !!value.id} value={value.campaign_id || ''} onChange={(event) => set('campaign_id', event.target.value)}><option value="">{label(optional ? kind === 'goal' ? 'all' : 'unattributed' : 'choose')}</option>{campaigns.map((campaign) => <option key={campaign.id} value={campaign.id}>{campaign.name}</option>)}</select></Field>;
  return <Modal open title={label({ campaign: 'campaigns', daily: 'daily', goal: 'goals', attribution: 'attribution' }[kind])} onClose={dismiss}
    footer={<><button type="button" className="btn" disabled={busy} onClick={dismiss}>{t('bizui.cancel')}</button><button className="btn primary" type="submit" form={id} disabled={blocked}>{busy ? t('biz.loading') : t('bizui.save')}</button></>}>
    <form id={id} onSubmit={(event) => { event.preventDefault(); if (!blocked) save(kind, value); }}><fieldset className="bizui-form bizui-form-fields" disabled={busy}>
      {['campaign', 'goal'].includes(kind) && <>{input('name', { required: true, maxLength: 200 })}{input('starts_on', { type: 'date', required: true })}{input('ends_on', { type: 'date', required: true })}</>}
      {kind === 'campaign' && <>{input('channel', { required: true, maxLength: 100 })}{input('budget', { type: 'number', min: 0, max: 1e12, step: 1, required: true })}<Field name="status"><select className="input" value={value.status} onChange={(event) => set('status', event.target.value)}>{['active', 'paused', 'archived'].map((status) => <option key={status} value={status}>{label(status)}</option>)}</select></Field><Field name="notes"><textarea className="input area" maxLength={10000} value={value.notes} onChange={(event) => set('notes', event.target.value)} /></Field></>}
      {kind === 'daily' && <>{campaignSelect(false)}{input('date', { type: 'date', required: true, disabled: !!value.id })}{['spend', 'impressions', 'clicks', 'leads'].map((key) => <div key={key}>{input(key, { type: 'number', min: 0, max: 1e12, step: 1, required: true })}</div>)}<p className="dim small">{label('source')}: {label('manual')}</p></>}
      {kind === 'goal' && <>{campaignSelect(true)}<Field name="metric"><select className="input" value={value.metric} onChange={(event) => set('metric', event.target.value)}>{['sales', 'paid', 'orders'].map((metric) => <option key={metric} value={metric}>{label(metric)}</option>)}</select></Field>{input('target', { type: 'number', min: 1, max: 1e12, step: 1, required: true })}</>}
      {kind === 'attribution' && <><p>{orders.find((order) => order.id === value.order_id)?.title}</p>{campaignSelect(true)}</>}
      {error && <p className="bizui-error" role="alert">{t(error)}</p>}
    </fieldset></form>{pendingNotice}
  </Modal>;
}
