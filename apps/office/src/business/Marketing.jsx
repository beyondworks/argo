import { useEffect, useId, useRef, useState } from 'react';
import { t, useLang, getLang } from '../core/i18n.js';
import { baseOf } from '../core/commands.js';
import { Link } from '../core/router.jsx';
import { Modal, showToast } from '../ui/Overlay.jsx';
import { Sheet } from '../ui/Panel.jsx';
import { Icon } from '../ui/Icon.jsx';
import { InfoTip } from '../ui/InfoTip.jsx';
import { useMarketing, marketingError } from './marketing-data.js';
import { defaultPeriod, validateFilters } from './dashboard-model.js';
import { campaignCards, effectOf, linkedTotals } from './marketing-model.js';
import { dealAmounts, dealStage } from './deal-model.js';

// 마케팅 한 화면(유건 9/29 "비전문가도 쓰게"): 기간 요약 → 캠페인 카드 → 목표. 카드를 누르면 광고비 기록과 연결된 거래가 한곳에 보인다.
const label = (key, vars) => t(`mkt.${key}`, vars);
const localDate = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const monthEnd = () => { const now = new Date(); return localDate(new Date(now.getFullYear(), now.getMonth() + 1, 0)); }; // 새 목표 기본 기간 = 이번 달
const monthLater = () => { const date = new Date(); date.setMonth(date.getMonth() + 1); return localDate(date); }; // 새 캠페인 종료일 기본값 — 같은 날 끝나는 캠페인이 되지 않게
const initialPeriod = () => { const { from, to } = defaultPeriod(); return { from, to, campaign: null }; };
const numeric = (value, minimum = 0) => { const number = Number(value); if (value === '' || !Number.isSafeInteger(number) || number < minimum || number > 1e12) throw new Error('biz.error.input'); return number; };
const locale = () => (getLang() === 'en' ? 'en-US' : 'ko-KR');
const money = (value) => new Intl.NumberFormat(locale(), { style: 'currency', currency: 'KRW', maximumFractionDigits: 0 }).format(Number(value || 0));
const count = (value) => new Intl.NumberFormat(locale(), { maximumFractionDigits: 0 }).format(Number(value || 0));
const goalValue = (metric, value) => (metric === 'orders' ? label('ordersCount', { n: count(value) }) : money(value));

export function marketingPayload(kind, value) {
  const identity = value.id ? { id: value.id, version: value.version } : {};
  if (kind === 'attribution') return { order_id: value.order_id, campaign_id: value.campaign_id || null, version: value.version ?? 0 };
  if (kind === 'daily') return { ...identity, campaign_id: value.campaign_id, date: value.date, source: 'manual', ...Object.fromEntries(['spend', 'impressions', 'clicks', 'leads'].map((key) => [key, numeric(value[key])])) };
  validateFilters({ from: value.starts_on, to: value.ends_on });
  if (!value.name.trim()) throw new Error('biz.error.input');
  const base = { ...identity, name: value.name.trim(), starts_on: value.starts_on, ends_on: value.ends_on };
  if (kind === 'goal') return { ...base, campaign_id: value.campaign_id || null, metric: value.metric, target: numeric(value.target, 1) };
  return { ...base, channel: value.channel.trim(), budget: numeric(value.budget || 0), status: value.status, notes: value.notes || '' };
}

function Effect({ stats }) {
  const effect = effectOf(stats);
  return <p className={`mkt-effect ${effect.kind}`}>{label(`effect.${effect.kind}`, { n: effect.times?.toLocaleString(locale()) })}</p>;
}

function Numbers({ stats }) {
  return <dl className="mkt-numbers">{[['spend', money(stats.spend)], ['orders', label('ordersCount', { n: count(stats.orders) })], ['sales', money(stats.sales)], ['paid', money(stats.paid)]].map(([key, value]) => <div key={key}><dt>{label(key)}</dt><dd>{value}</dd></div>)}</dl>;
}

export default function Marketing({ space, business }) {
  useLang();
  const marketing = useMarketing(space);
  const { data, loading, busy, uncertain, error } = marketing;
  const [dialog, setDialog] = useState(null), [formError, setFormError] = useState(null), [openId, setOpenId] = useState(null);
  const [filters, setFilters] = useState(initialPeriod), [draft, setDraft] = useState(initialPeriod);
  const [reportState, setReport] = useState(null), [reportError, setReportError] = useState(null), [reportLoading, setReportLoading] = useState(false);
  const scope = useRef(marketing.scopeKey), sequence = useRef(0);
  scope.current = marketing.scopeKey;
  const blocked = busy || uncertain || !data?.can_write || !!business?.busy || !!business?.uncertain;
  const campaigns = data?.campaigns ?? [];
  const reportKey = JSON.stringify([marketing.scopeKey, filters]);
  const report = data && business?.data && reportState?.key === reportKey ? reportState.value : null;
  const cards = campaignCards(campaigns, report?.campaigns);
  const unlinked = report?.campaigns?.find((row) => row.id == null);
  const open = cards.find((card) => card.id === openId);
  useEffect(() => { setDialog(null); setFormError(null); setOpenId(null); setFilters(initialPeriod()); setDraft(initialPeriod()); }, [space, marketing.scopeKey]);
  useEffect(() => {
    const request = ++sequence.current;
    setReportError(null);
    if (!data || !business?.data || (!data.campaigns.length && !data.goals.length)) { setReport(null); setReportLoading(false); return; } // 시작 화면은 부르지 않는다
    setReportLoading(true);
    // 거래 연결 한 번에 업무·마케팅 원본이 연달아 바뀐다 — 잠깐 모았다가 한 번만 부른다(DB 위생)
    const timer = setTimeout(() => marketing.report(filters).then((result) => { if (request === sequence.current) setReport({ key: reportKey, value: result }); }).catch((failure) => { if (request === sequence.current) { setReport(null); setReportError(marketingError(failure)); } }).finally(() => { if (request === sequence.current) setReportLoading(false); }), 250);
    return () => { clearTimeout(timer); sequence.current += 1; };
  }, [data, business?.data, reportKey, marketing.report]);
  // 업무 ⋯ 새로고침 — 마케팅 원본만 다시 받는다. 보고서는 data가 바뀌면 위 효과가 한 번 다시 부른다(중복 호출 없게)
  useEffect(() => { const refresh = () => { marketing.refresh().catch(() => {}); }; window.addEventListener('office:biz-refresh', refresh); return () => window.removeEventListener('office:biz-refresh', refresh); }, [marketing.refresh]);
  const launch = (kind, value = {}) => { setFormError(null); setDialog({ kind, value }); };
  const retry = async () => {
    const captured = dialog, currentScope = scope.current;
    try {
      const result = await marketing.retryPending();
      if (result?.id && scope.current === currentScope) { setDialog((current) => current === captured ? null : current); setFormError(null); showToast(t('bizui.saved')); }
    } catch (failure) { if (scope.current === currentScope) setFormError(marketingError(failure)); }
  };
  const pendingNotice = uncertain && <div className="bizui-error" role="alert"><span>{t('bizui.pending')}</span><button type="button" className="btn sm" disabled={busy} onClick={retry}>{t('bizui.retry')}</button></div>;
  // 거래 연결은 서버 한 번의 쓰기 — 캠페인 연결과 거래의 '들어온 경로'가 같이 바뀐다(분리 검수 M1). 경로는 업무 원본이라 그쪽만 다시 읽는다
  const link = async (orderId, campaignId) => {
    const attribution = data.attributions.find((row) => row.order_id === orderId);
    await marketing.mutate('attribution.save', marketingPayload('attribution', { order_id: orderId, campaign_id: campaignId, version: attribution?.version ?? 0 }));
    business.refresh().catch(() => {});
  };
  const save = async (kind, value) => {
    const captured = dialog, currentScope = scope.current;
    setFormError(null);
    try {
      if (kind === 'attribution') await link(value.order_id, value.campaign_id);
      else await marketing.mutate(`${kind}.save`, marketingPayload(kind, value));
      if (scope.current === currentScope) { setDialog((current) => current === captured ? null : current); showToast(t('bizui.saved')); }
    } catch (failure) { if (scope.current === currentScope) setFormError(marketingError(failure)); }
  };
  const unlink = (orderId) => link(orderId, null).then(() => showToast(t('bizui.saved'))).catch((failure) => showToast(t(marketingError(failure)))); // 시트가 본문 안내를 가리므로 알림으로
  const apply = (event) => {
    event.preventDefault();
    try { validateFilters({ ...draft, customer: null }); setFilters({ ...draft }); setReportError(null); }
    catch (failure) { setReportError(marketingError(failure)); }
  };
  const totals = linkedTotals(report?.campaigns);
  return <section className="mkt" aria-label={t('bizui.marketing')}>
    {error && <p className="bizui-error" role="alert">{t(error)}</p>}{pendingNotice}
    {loading && !data && <p role="status">{t('biz.loading')}</p>}
    {data && <>
      {!data.can_write && <p className="bizui-muted">{t('bizui.readOnly')}</p>}
      {!campaigns.length ? <div className="mkt-start">
        <Icon name="megaphone" size={22} />
        <h2>{label('start.title')}</h2>
        <p>{label('start.body')}</p>
        <button type="button" className="btn primary" disabled={blocked} onClick={() => launch('campaign')}><Icon name="plus" size={13} />{label('start.button')}</button>
      </div> : <>
        <form className="biz-bar biz-filter" onSubmit={apply}>
          <input className="input" type="date" required aria-label={label('starts_on')} value={draft.from} onChange={(event) => setDraft({ ...draft, from: event.target.value })} />
          <span className="dash">–</span>
          <input className="input" type="date" required aria-label={label('ends_on')} value={draft.to} onChange={(event) => setDraft({ ...draft, to: event.target.value })} />
          <button className="btn sm" disabled={reportLoading}>{t('biz.filters.apply')}</button>
          <InfoTip text={label('reportBasis')} />
        </form>
        {reportError && <p className="bizui-error" role="alert">{t(reportError)}</p>}
        {report ? cards.length > 1 && <div className="mkt-summary"><Numbers stats={totals} /><Effect stats={totals} /></div> : reportLoading && <p className="dim small" role="status">{t('biz.loading')}</p>}
        <div className="biz-section"><h2>{label('campaigns')}</h2><button type="button" className="btn sm" disabled={blocked} onClick={() => launch('campaign')}><Icon name="plus" size={13} />{label('addCampaign')}</button></div>
        <div className="mkt-cards">{cards.map((card) => <article key={card.id} className={`mkt-card ${card.status}`}>
          <div className="mkt-card-head"><button type="button" className="mkt-card-open" onClick={() => setOpenId(card.id)}>{card.name}</button><span className="badge">{label(`status.${card.status}`)}</span></div>
          <p className="mkt-card-meta">{card.channel} · <span className="mono">{card.starts_on} – {card.ends_on}</span></p>
          {report && <><Numbers stats={card.stats} /><Effect stats={card.stats} /></>}
        </article>)}</div>
        {unlinked && Number(unlinked.orders) > 0 && Number(unlinked.sales) > 0 && <p className="bizui-muted mkt-unlinked">{label('unlinked', { n: count(unlinked.orders), sales: money(unlinked.sales) })}</p>}
      </>}
      {(campaigns.length > 0 || data.goals.length > 0) && <Goals goals={data.goals} results={report?.goals} failed={!!reportError} campaigns={campaigns} blocked={blocked} launch={launch} />}
      {open && <CampaignSheet campaign={open} ready={!!report} data={data} business={business.data} space={space} blocked={blocked} busy={busy} period={filters} launch={launch} unlink={unlink} onClose={() => setOpenId(null)} />}
      {dialog && <MarketingForm key={`${dialog.kind}:${dialog.value.id || dialog.value.order_id || ''}`} dialog={dialog} campaigns={campaigns} daily={data.daily} orders={business?.data?.orders ?? []} attributions={data.attributions} blocked={blocked} busy={busy} error={formError} pendingNotice={pendingNotice} dismiss={() => { if (!busy) setDialog(null); }} save={save} />}
    </>}
  </section>;
}

function Goals({ goals, results, failed, campaigns, blocked, launch }) {
  const campaignName = (id) => campaigns.find((campaign) => campaign.id === id)?.name ?? label('all');
  return <>
    <div className="biz-section"><h2>{label('goals')}</h2><InfoTip text={label('goalHelp')} /><button type="button" className="btn sm" disabled={blocked} onClick={() => launch('goal')}><Icon name="plus" size={13} />{label('addGoal')}</button></div>
    {!goals.length ? <p className="biz-empty">{label('goalEmpty')}</p> : <ul className="mkt-goals">{goals.map((goal) => {
      const result = results?.find((entry) => entry.id === goal.id), ratio = Math.max(0, Number(result?.ratio ?? 0));
      return <li key={goal.id}>
        <div className="mkt-goal-head"><strong>{goal.name}</strong><span className="dim small">{campaignName(goal.campaign_id)} · <span className="mono">{goal.starts_on} – {goal.ends_on}</span></span><button type="button" className="btn sm ghost" disabled={blocked} onClick={() => launch('goal', goal)}>{t('bizui.edit')}</button></div>
        <div className="mkt-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(Math.min(ratio, 1) * 100)} aria-label={goal.name}><span style={{ width: `${Math.min(ratio, 1) * 100}%` }} /></div>
        <p className="small">{result ? label('goalLine', { metric: label(`goal.${goal.metric}`), actual: goalValue(goal.metric, result.actual), target: goalValue(goal.metric, goal.target), pct: Math.round(ratio * 100) }) : failed ? '—' : t('biz.loading')}</p>
      </li>;
    })}</ul>}
  </>;
}

function CampaignSheet({ campaign, ready, data, business, space, blocked, busy, period, launch, unlink, onClose }) {
  const days = data.daily.filter((row) => row.campaign_id === campaign.id).slice().sort((a, b) => b.date.localeCompare(a.date));
  const linkedIds = new Set(data.attributions.filter((row) => row.campaign_id === campaign.id).map((row) => row.order_id));
  const deals = (business?.orders ?? []).filter((order) => linkedIds.has(order.id));
  const extra = (row) => ['impressions', 'clicks', 'leads'].filter((key) => Number(row[key]) > 0).map((key) => `${label(key)} ${count(row[key])}`).join(' · ');
  return <Sheet open title={campaign.name} onClose={() => { if (!busy) onClose(); }} footer={<><button type="button" className="btn" disabled={blocked} onClick={() => launch('campaign', campaign)}>{label('editCampaign')}</button><button type="button" className="btn primary" disabled={blocked} onClick={() => launch('daily', { campaign_id: campaign.id })}>{label('addSpend')}</button></>}>
    <div className="mkt-sheet"><p className="mkt-card-meta">{campaign.channel} · <span className="mono">{campaign.starts_on} – {campaign.ends_on}</span> · <span className="badge">{label(`status.${campaign.status}`)}</span></p>
    {ready && <><p className="dim small">{label('periodOf', { from: period.from, to: period.to })}</p><Numbers stats={campaign.stats} /><Effect stats={campaign.stats} /></>}
    {campaign.notes && <p className="mkt-notes">{campaign.notes}</p>}
    <h3>{label('daily')}</h3>
    {!days.length ? <p className="biz-empty">{label('dailyEmpty')}</p> : <ul className="mkt-list">{days.map((row) => <li key={row.id}>
      <span className="mono">{row.date}</span><strong className="mono">{money(row.spend)}</strong><span className="dim small">{extra(row)}</span>
      <button type="button" className="btn sm ghost" disabled={blocked} onClick={() => launch('daily', row)}>{t('bizui.edit')}</button>
    </li>)}</ul>}
    <div className="biz-section"><h3>{label('linkedDeals')}</h3><button type="button" className="btn sm" disabled={blocked} onClick={() => launch('attribution', { campaign_id: campaign.id, order_id: '' })}><Icon name="plus" size={13} />{label('linkDeal')}</button></div>
    {!deals.length ? <p className="biz-empty">{label('dealsEmpty')}</p> : <ul className="mkt-list">{deals.map((order) => { const amounts = dealAmounts(order, business.lines, business.entries); return <li key={order.id}>
      <Link className="bizui-link" to={`${baseOf(space)}/business/orders?open=${encodeURIComponent(order.id)}`}>{order.title}</Link>
      <span className="badge">{t(order.status === 'cancelled' ? 'bizui.cancelled' : `bizui.stage.${dealStage(order, amounts)}`)}</span><strong className="mono">{order.status === 'cancelled' ? '—' : money(amounts.total)}</strong>
      <button type="button" className="btn sm ghost" disabled={blocked} onClick={() => unlink(order.id)}>{label('unlink')}</button>
    </li>; })}</ul>}
    </div>
  </Sheet>;
}

function Field({ name, children }) { return <label className="field-block bizui-field"><span className="label">{label(name)}</span>{children}</label>; }

function MarketingForm({ dialog, campaigns, daily, orders, attributions, blocked, busy, error, pendingNotice, dismiss, save }) {
  const id = useId(), listId = useId(), { kind } = dialog;
  // 같은 캠페인·날짜의 기록이 있으면 노출·클릭·문의는 그 값으로 채운다 — 광고비만 고쳐도 나머지가 0으로 지워지지 않게(분리 검수 M2)
  const withDay = (next) => {
    if (kind !== 'daily' || next.id) return next;
    const row = daily.find((entry) => entry.campaign_id === next.campaign_id && entry.date === next.date);
    if (row) return { ...next, impressions: row.impressions, clicks: row.clicks, leads: row.leads, fromDay: true };
    return next.fromDay ? { ...next, impressions: 0, clicks: 0, leads: 0, fromDay: false } : next; // 직접 적은 수는 날짜를 바꿔도 지우지 않는다
  };
  const [value, setValue] = useState(() => withDay({ name: '', channel: '', starts_on: kind === 'goal' ? `${localDate().slice(0, 8)}01` : localDate(), ends_on: kind === 'campaign' ? monthLater() : kind === 'goal' ? monthEnd() : localDate(), budget: '', status: 'active', notes: '', campaign_id: '', date: localDate(), spend: '', impressions: 0, clicks: 0, leads: 0, metric: 'sales', target: '', ...dialog.value }));
  const set = (key, next) => setValue((old) => (key === 'date' || key === 'campaign_id' ? withDay({ ...old, [key]: next }) : { ...old, [key]: next }));
  const input = (name, props = {}) => <Field name={name}><input className="input" value={value[name]} onChange={(event) => set(name, event.target.value)} {...props} /></Field>;
  const number = (name, props = {}) => input(name, { type: 'number', min: 0, max: 1e12, step: 1, inputMode: 'numeric', ...props });
  // 같은 캠페인·날짜에 기록이 이미 있으면 새 줄 대신 그 기록을 고친다(서버는 하루 한 줄)
  const same = kind === 'daily' && !value.id ? daily.find((row) => row.campaign_id === value.campaign_id && row.date === value.date) : null;
  const linked = new Set(attributions.filter((row) => row.campaign_id === value.campaign_id).map((row) => row.order_id));
  const choices = orders.filter((order) => order.status !== 'cancelled' && !linked.has(order.id));
  const now = (order) => { const other = attributions.find((row) => row.order_id === order.id)?.campaign_id; return other ? label('nowIn', { name: campaigns.find((campaign) => campaign.id === other)?.name ?? '' }) : order.source && order.source !== 'campaign' ? t(`bizui.source.${order.source}`) : ''; };
  const submit = () => save(kind, same ? { ...value, id: same.id, version: same.version } : value);
  const title = { campaign: dialog.value.id ? 'editCampaign' : 'addCampaign', daily: dialog.value.id ? 'editSpend' : 'addSpend', goal: dialog.value.id ? 'editGoal' : 'addGoal', attribution: 'linkDeal' }[kind];
  return <Modal open title={label(title)} onClose={dismiss}
    footer={<><button type="button" className="btn" disabled={busy} onClick={dismiss}>{t('bizui.cancel')}</button><button className="btn primary" type="submit" form={id} disabled={blocked || (kind === 'attribution' && !choices.length)}>{busy ? t('biz.loading') : t('bizui.save')}</button></>}>
    <form id={id} onSubmit={(event) => { event.preventDefault(); if (!blocked) submit(); }}><fieldset className="bizui-form bizui-form-fields" disabled={busy}>
      {kind === 'campaign' && <>
        {input('name', { required: true, maxLength: 200, placeholder: label('namePlaceholder') })}
        {input('channel', { required: true, maxLength: 100, list: listId, placeholder: label('channelPlaceholder') })}
        <datalist id={listId}>{label('channelIdeas').split(',').map((channel) => <option key={channel} value={channel} />)}</datalist>
        <div className="bizui-grid2">{input('starts_on', { type: 'date', required: true })}{input('ends_on', { type: 'date', required: true })}</div>
        {number('budget', { placeholder: label('optional') })}
        {dialog.value.id && <Field name="status"><select className="input" value={value.status} onChange={(event) => set('status', event.target.value)}>{['active', 'paused', 'archived'].map((status) => <option key={status} value={status}>{label(`status.${status}`)}</option>)}</select></Field>}
        <Field name="notes"><textarea className="input area" maxLength={10000} value={value.notes} onChange={(event) => set('notes', event.target.value)} /></Field>
      </>}
      {kind === 'daily' && <>
        <Field name="campaign_id"><select className="input" required disabled={!!value.id} value={value.campaign_id || ''} onChange={(event) => set('campaign_id', event.target.value)}><option value="">{label('choose')}</option>{campaigns.map((campaign) => <option key={campaign.id} value={campaign.id}>{campaign.name}</option>)}</select></Field>
        <div className="bizui-grid2">{input('date', { type: 'date', required: true, disabled: !!value.id })}{number('spend', { required: true, 'data-autofocus': value.campaign_id ? '' : undefined })}</div>
        {same && <p className="bizui-muted small">{label('sameDay', { spend: money(same.spend) })}</p>}
        <details className="mkt-more"><summary>{label('more')}</summary><div className="bizui-grid3">{['impressions', 'clicks', 'leads'].map((key) => <div key={key}>{number(key)}</div>)}</div></details>
      </>}
      {kind === 'goal' && <>
        {input('name', { required: true, maxLength: 200, placeholder: label('goalPlaceholder') })}
        <div className="bizui-grid2"><Field name="metric"><select className="input" value={value.metric} onChange={(event) => set('metric', event.target.value)}>{['sales', 'paid', 'orders'].map((metric) => <option key={metric} value={metric}>{label(`goal.${metric}`)}</option>)}</select></Field>{number('target', { min: 1, required: true })}</div>
        <div className="bizui-grid2">{input('starts_on', { type: 'date', required: true })}{input('ends_on', { type: 'date', required: true })}</div>
        <Field name="campaign_id"><select className="input" value={value.campaign_id || ''} onChange={(event) => set('campaign_id', event.target.value)}><option value="">{label('all')}</option>{campaigns.map((campaign) => <option key={campaign.id} value={campaign.id}>{campaign.name}</option>)}</select></Field>
      </>}
      {kind === 'attribution' && <>
        <p>{campaigns.find((campaign) => campaign.id === value.campaign_id)?.name}</p>
        {!choices.length ? <p className="biz-empty">{label('noDealsToLink')}</p> : <Field name="order_id"><select className="input" required value={value.order_id} onChange={(event) => set('order_id', event.target.value)}><option value="">{label('choose')}</option>{choices.map((order) => <option key={order.id} value={order.id}>{order.title}{now(order) ? ` (${now(order)})` : ''}</option>)}</select></Field>}
        <p className="dim small">{label('linkHelp')}</p>
      </>}
      {error && <p className="bizui-error" role="alert">{t(error)}</p>}
    </fieldset></form>{pendingNotice}
  </Modal>;
}
