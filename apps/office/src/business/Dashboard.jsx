import { createContext, useContext, useEffect, useId, useMemo, useRef, useState } from 'react';
import { getLang, t, useLang } from '../core/i18n.js';
import { CHART_MODULES } from '../core/module-registry.js';
import { ModuleGrid, ModuleAddButton } from '../ui/ModuleGrid.jsx';
import { record } from '../core/history.js';
import { Modal } from '../ui/Overlay.jsx';
import { Icon } from '../ui/Icon.jsx';
import { InfoTip } from '../ui/InfoTip.jsx';
import { openMenu } from '../ui/Menu.jsx';
import { businessError } from './data.js';
import { CHARTS, METRICS, chartSeries, periodOrders, configureWidget, defaultDashboard, newWidget, normalizeDashboards, validateFilters, widgetMetrics } from './dashboard-model.js';
import { PRESETS, firstDay, resolveFilters } from './dashboard-period.js';
import { ResponsiveChart } from './ResponsiveChart.jsx';
import { timeSeriesGeometry, nearestIndex, shortMoney } from './chart-geometry.js';
import { Hide } from './Redact.jsx';

const money = (value) => new Intl.NumberFormat(getLang() === 'en' ? 'en-US' : 'ko-KR', { style: 'currency', currency: 'KRW', maximumFractionDigits: 0 }).format(Number(value));
const ChartContext = createContext(null);
function ChartModule({ item }) {
  const context = useContext(ChartContext);
  return <BusinessChart widget={item} {...context} />;
}

// 들어온 경로별 매출(유건 9/29: 광고를 안 해도 의미 있는 숫자 — "매출의 60%는 소개"). 경로를 고르지 않은 거래는 '모름'
function SourceBreakdown({ sources }) {
  const rows = sources.filter((row) => Number(row.sales) !== 0);
  const total = rows.reduce((sum, row) => sum + Math.max(0, Number(row.sales)), 0);
  const known = rows.some((row) => row.source !== 'unknown');
  return <section className="module biz-source" aria-label={t('biz.sources.title')}>
    <header className="module-head"><Icon name="target" size={15} /><h3>{t('biz.sources.title')}</h3></header>
    <div className="biz-source-body">
      {!rows.length ? <p className="biz-empty">{t('biz.noRows')}</p> : <ul>{rows.map((row) => { const share = total > 0 ? Math.round(Math.max(0, Number(row.sales)) / total * 100) : 0; return <li key={row.source}>
        <span className="name">{t(`bizui.source.${row.source}`)}</span><span className="bar"><i style={{ width: `${share}%` }} /></span><span className="share">{share}%</span><strong><Hide k={`biz:source:${row.source}:sales`}>{money(row.sales)}</Hide></strong></li>; })}</ul>}
      {!known && rows.length > 0 && <p className="dim small">{t('biz.sources.hint')}</p>}
    </div>
  </section>;
}

export function BusinessChart({ widget, report, onOpenOrder, filters }) {
  if (widget.type === 'kpi') return <div className="biz-kpi-wrap"><strong className="biz-kpi metric"><Hide k={`biz:kpi:${widget.metric}`}>{money(report.metrics[widget.metric])}</Hide></strong></div>;
  if (widget.type === 'table') { const rows = periodOrders(report.orders); return rows.length ? <div className="table-wrap biz-table-wrap"><table className="table biz-table"><thead><tr><th>{t('biz.order')}</th>{METRICS.map((m) => <th key={m} className="num">{t(`biz.metric.${m}`)}</th>)}</tr></thead><tbody>{rows.map((row) => <tr key={row.id}><td><button type="button" className="bizui-link" onClick={() => onOpenOrder(row.id)}>{row.title}</button></td>{METRICS.map((m) => <td key={m} className="num"><Hide k={`order:${row.id}:${m}`}>{money(row[m])}</Hide></td>)}</tr>)}</tbody></table></div> : <p className="biz-empty">{t('biz.noRows')}</p>; }
  if (widget.type === 'donut') {
    const parts = report.mix.filter((row) => ['service', 'product'].includes(row.kind));
    if (parts.some((row) => Number(row.amount) < 0)) return <p className="biz-empty">{t('biz.donut.negative')}</p>;
    const total = parts.reduce((sum, row) => sum + Number(row.amount), 0);
    if (!total) return <p className="biz-empty">{t('biz.noRows')}</p>;
    let offset = 0;
    return <div className="biz-chart-legend"><svg className="biz-donut" viewBox="0 0 160 160" role="img" aria-label={t('biz.chart.donut')}><title>{t('biz.chart.donut')}</title>{parts.map((row) => {
      const length = Number(row.amount) / total * 100, start = offset; offset += length;
      return <circle key={row.kind} className={`biz-donut-${row.kind}`} cx="80" cy="80" r="58" fill="none" strokeWidth="24" pathLength="100" strokeDasharray={`${length} ${100 - length}`} strokeDashoffset={-start} transform="rotate(-90 80 80)" />;
    })}</svg><ul>{parts.map((row) => <li key={row.kind}><i style={{ background: row.kind === 'service' ? 'var(--fg)' : 'var(--fg-3)' }} />{t(`biz.kind.${row.kind}`)} <strong><Hide k={`biz:kind:${row.kind}`}>{money(row.amount)}</Hide></strong> <span className="dim">{(Number(row.amount) / total * 100).toFixed(1)}%</span></li>)}</ul></div>;
  }
  const series = chartSeries(report.daily, widget.metric, filters);
  if (!series.length) return <p className="biz-empty">{t('biz.noRows')}</p>;
  return <><TimeSeries series={series} type={widget.type} label={t(`biz.metric.${widget.metric}`)} /><details><summary>{t('biz.chart.data')}</summary><div className="table-wrap biz-table-wrap"><table className="table biz-table"><thead><tr><th>{t('biz.chart.date')}</th><th className="num">{t(`biz.metric.${widget.metric}`)}</th></tr></thead><tbody>{series.map((p) => <tr key={p.date}><td className="mono">{p.date}</td><td className="num"><Hide k={`biz:${widget.metric}:${p.date}`}>{money(p.value)}</Hide></td></tr>)}</tbody></table></div></details></>;
}

/** 선·막대 그래프 — 마우스를 올리면 가장 가까운 날짜에 세로선·점과 '날짜 · 값'(유건 9/30). 키보드·화면 읽기는 아래 '데이터 표'가 맡는다 */
function TimeSeries({ series, type, label }) {
  const [hover, setHover] = useState(-1);
  const geometry = useRef(null); // 마지막으로 그린 점 위치 — 마우스 좌표를 가장 가까운 날짜로 바꿀 때 쓴다
  const axisMoney = (value) => new Intl.NumberFormat(getLang() === 'en' ? 'en-US' : 'ko-KR', { style: 'currency', currency: 'KRW', notation: 'compact', maximumFractionDigits: 1 }).format(value);
  const track = (event) => { const points = geometry.current?.points; if (!points) return; const next = nearestIndex(points, event.clientX - event.currentTarget.getBoundingClientRect().left); if (next !== hover) setHover(next); };
  const svg = { onPointerMove: track, onPointerDown: track, onPointerLeave: () => setHover(-1), onPointerCancel: () => setHover(-1) };
  const overlay = (width) => { // 값 풍선 — 가장자리에서는 안쪽으로 붙인다
    const point = geometry.current?.points[hover];
    if (!point) return null;
    const side = point.x < 90 ? 'start' : point.x > width - 90 ? 'end' : 'mid';
    return <div className={`biz-chart-tip ${side}`} style={{ left: side === 'end' ? undefined : point.x, right: side === 'end' ? width - point.x : undefined }} aria-hidden="true"><span className="mono">{point.date}</span> · <strong>{shortMoney(point.value, getLang())}</strong></div>;
  };
  return <ResponsiveChart label={label} svg={svg} overlay={overlay}>{(width, height) => {
    const extent = [Math.min(0, ...series.map((point) => point.value)), Math.max(0, ...series.map((point) => point.value))];
    const labelWidth = Math.max(...extent.map((value) => axisMoney(value).length)) * 8 + 12;
    const chart = timeSeriesGeometry(series, width, height, labelWidth);
    geometry.current = chart;
    const dateLabel = (date) => width < 400 ? date.slice(5) : date;
    const on = chart.points[hover];
    return <>
      {[chart.high, (chart.high + chart.low) / 2, chart.low].filter((value, index, all) => all.indexOf(value) === index).map((value) => {
        const y = chart.bottom - (value - chart.low) / (chart.high - chart.low || 1) * (chart.bottom - chart.top);
        return <g key={value}><line className="biz-chart-axis" x1={chart.left} x2={chart.right} y1={y} y2={y} /><text x={chart.left - 8} y={y + 4} textAnchor="end">{axisMoney(value)}</text></g>;
      })}
      {chart.low < 0 && chart.high > 0 && <line className="biz-chart-axis" x1={chart.left} x2={chart.right} y1={chart.baseline} y2={chart.baseline} />}
      <text x={chart.left} y={height - 8}>{dateLabel(series[0].date)}</text>{series.length > 1 && <text x={chart.right} y={height - 8} textAnchor="end">{dateLabel(series.at(-1).date)}</text>}
      {type === 'line' ? <><polyline className="biz-chart-line" points={chart.points.map((point) => `${point.x},${point.y}`).join(' ')} />{chart.points.map((point, index) => <circle key={point.date} className="biz-chart-dot" cx={point.x} cy={point.y} r={chart.points.length <= 14 || index === chart.points.length - 1 ? 2.5 : 0} />)}</> : chart.points.map((point, index) => <rect key={point.date} className={`biz-chart-bar${index === hover ? ' on' : ''}`} x={point.x - chart.barWidth / 2} y={Math.min(chart.baseline, point.y)} width={chart.barWidth} height={Math.abs(chart.baseline - point.y)} />)}
      {on && <g className="biz-chart-hover"><line x1={on.x} x2={on.x} y1={chart.top} y2={chart.bottom} /><circle cx={on.x} cy={on.y} r="4" /></g>}
    </>;
  }}</ResponsiveChart>;
}

export function BusinessDashboard({ business, space, onOpenOrder }) {
  useLang();
  const dashboards = useMemo(() => normalizeDashboards(business.data?.settings?.dashboards), [business.data?.settings?.dashboards]);
  const [selected, setSelected] = useState(null), [name, setName] = useState(''), [draft, setDraft] = useState(null);
  const [active, setActive] = useState(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(null);
  const addFormId = useId();
  const [type, setType] = useState('kpi'), [metric, setMetric] = useState('sales'), [deleting, setDeleting] = useState(false);
  const [reportState, setReport] = useState(null), [loading, setLoading] = useState(false), [error, setError] = useState(null), [revision, setRevision] = useState(0);
  const sequence = useRef(0);
  const current = dashboards.find((d) => d.id === selected) ?? dashboards[0];
  const first = useMemo(() => firstDay(business.data), [business.data]); // '전체' = 첫 거래일부터
  const filters = resolveFilters(active && current && active.id === current.id ? active.filters : current?.filters, new Date(), first);
  const signature = JSON.stringify(filters);
  const reportKey = JSON.stringify([business.scopeKey, current?.id, signature]);
  const report = business.data && reportState?.key === reportKey ? reportState.value : null;
  const canEdit = !!business.data?.can_manage && !business.busy && !business.uncertain;
  const gridEdit = !!business.data?.can_manage && !business.uncertain; // 격자는 저장 중(busy)을 locked로 따로 받는다 — 손잡이·키보드 초점이 저장마다 사라지지 않게
  useEffect(() => { setSelected(null); setActive(null); setReport(null); setError(null); setAdding(false); }, [space]);
  useEffect(() => { setDraft(filters ?? null); setName(current?.name ?? ''); }, [current?.id, current?.name, signature]);
  useEffect(() => { setAdding(false); setEditing(null); }, [space, current?.id]);
  useEffect(() => {
    const request = ++sequence.current;
    setError(null);
    if (!current || !business.data) { setReport(null); setLoading(false); return; }
    setLoading(true);
    business.report(filters).then((result) => { if (request === sequence.current) setReport({ key: reportKey, value: result }); }).catch((e) => { if (request === sequence.current) { setReport(null); setError(businessError(e)); } }).finally(() => { if (request === sequence.current) setLoading(false); });
    return () => { sequence.current += 1; };
  }, [reportKey, business.report, business.data, revision]);
  const save = async (next) => {
    setError(null);
    try { await business.mutate('settings.save', { ...business.data.settings, dashboards: next }); return true; }
    catch (e) { setError(businessError(e)); return false; }
  };
  const update = (patch) => save(dashboards.map((d) => d.id === current.id ? { ...d, ...patch } : d));
  const create = async () => { const next = defaultDashboard(t('biz.dashboard.default')); if (await save([...dashboards, next])) setSelected(next.id); };
  const editWidget = (item) => { setType(item.type); setMetric(item.metric); setEditing(item.id); setAdding(true); };
  const add = async () => {
    try {
      if (!editing && current.widgets.length >= 30) return;
      const widgets = editing ? configureWidget(current.widgets, editing, type, metric) : [...current.widgets, newWidget(type, metric)];
      if (await update({ widgets })) { if (!editing) record(`business:${space}:${current.id}`, current.widgets); setAdding(false); setEditing(null); } // 위젯 추가는 ⌘Z로 되돌린다(7차)
    } catch (failure) { setError(businessError(failure)); }
  };
  const resolveModule = (item) => { const module = CHART_MODULES.find((entry) => entry.id === item.type); return { ...module, title: `${t(`biz.metric.${item.metric}`)} · ${t(module.title)}`, render: ChartModule, actions: [{ label: t('bizui.edit'), run: () => editWidget(item) }] }; };
  const apply = (e) => { e.preventDefault(); try { setActive({ id: current.id, filters: validateFilters(draft) }); setError(null); } catch (err) { setError(businessError(err)); } };
  const saveFilters = () => { try { update({ filters: validateFilters(PRESETS.includes(draft.preset) ? resolveFilters(draft, new Date(), first) : { ...draft, preset: 'custom' }) }); } catch (err) { setError(businessError(err)); } };
  const pickPreset = (preset) => { setActive({ id: current.id, filters: { preset, customer: draft?.customer ?? null } }); setError(null); };
  const setDate = (patch) => setDraft({ ...draft, ...patch, preset: 'custom' }); // 날짜를 직접 고르면 '직접 고른 기간'
  const [renaming, setRenaming] = useState(false);
  const closeRename = useMemo(() => () => setRenaming(false), []); // 창에 매번 새 함수를 주면 입력 포커스가 첫 칸으로 돌아간다
  const dashboardMenu = (event) => openMenu(event, [
    { label: t('biz.dashboard.rename'), icon: 'draft', disabled: !canEdit, run: () => { setName(current.name); setRenaming(true); } },
    { label: t('biz.filters.saveDefault'), icon: 'check', disabled: !canEdit, run: saveFilters },
    { sep: true },
    { label: t('biz.dashboard.remove'), icon: 'trash', danger: true, disabled: !canEdit, run: () => setDeleting(true) },
  ], { anchor: event.currentTarget });
  const hiddenWidgets = current ? current.widgets.filter((widget) => widget.hidden).map((widget) => ({ id: widget.id, title: resolveModule(widget).title, icon: resolveModule(widget).icon, run: () => update({ widgets: current.widgets.map((item) => item.id === widget.id ? { ...item, hidden: false } : item) }) })) : [];
  return <section className="biz-dashboard" aria-label={t('biz.dashboard')}>
    {current && <div>
      <div className="biz-bar">
        {dashboards.length > 0 && <div className="seg" role="tablist" aria-label={t('biz.dashboard')}>{dashboards.map((d) => <button type="button" role="tab" className={`seg-btn${current?.id === d.id ? ' on' : ''}`} key={d.id} aria-selected={current?.id === d.id} onClick={() => setSelected(d.id)}>{d.name}</button>)}</div>}
        {canEdit && <button type="button" className="btn ghost sm" onClick={create}><Icon name="plus" size={13} />{t('biz.dashboard.new')}</button>}
        <span className="spacer" />
        {canEdit && <ModuleAddButton disabled={!canEdit} items={[...hiddenWidgets, ...(current.widgets.length < 30 ? [{ id: 'new-widget', title: t('biz.addWidget'), icon: 'plus', run: () => { setEditing(null); setAdding(true); } }] : [])]} />}
        <button type="button" className="icon-btn" aria-label={t('more')} onClick={dashboardMenu}><Icon name="dots" /></button>
      </div>
      {draft && <form className="biz-bar biz-filter" onSubmit={apply}>
        <div className="seg" role="group" aria-label={t('biz.period')}>{PRESETS.map((p) => <button key={p} type="button" className={`seg-btn${filters?.preset === p ? ' on' : ''}`} aria-pressed={filters?.preset === p} onClick={() => pickPreset(p)}>{t(`biz.period.${p}`)}</button>)}</div>
        <input type="date" className="input" aria-label={t('biz.filters.from')} value={draft.from} onChange={(e) => setDate({ from: e.target.value })} />
        <span className="dash">–</span>
        <input type="date" className="input" aria-label={t('biz.filters.to')} value={draft.to} onChange={(e) => setDate({ to: e.target.value })} />
        <select className="input" aria-label={t('biz.filters.customer')} value={draft.customer ?? ''} onChange={(e) => setDraft({ ...draft, customer: e.target.value || null })}><option value="">{t('biz.filters.all')}</option>{(business.data?.customers ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
        <button className="btn sm" disabled={loading}>{t('biz.filters.apply')}</button>
        <InfoTip text={t('biz.basis')} />
      </form>}
    </div>}
    {error && <p className="biz-error" role="alert">{t(error)}</p>}
    {!current ? <div className="empty-state"><p>{t('biz.dashboard.empty')}</p><button type="button" className="btn primary" disabled={!canEdit} onClick={create}>{t('biz.dashboard.create')}</button></div> : <>
      {loading && !report && <p className="dim small" role="status">{t('biz.loading')}</p>}
      {report && <>
        <ChartContext.Provider value={{ report, onOpenOrder, filters }}><ModuleGrid id={`business:${space}:${current.id}`} items={current.widgets} canEdit={gridEdit} locked={business.busy} onChange={(widgets) => update({ widgets })} resolveModule={resolveModule} space={space} bodyClassName="biz-widget-body" /></ChartContext.Provider>
        {!current.widgets.some((widget) => !widget.hidden) && <p className="biz-empty">{t('biz.noWidgets')}</p>}
        {report.sources && <SourceBreakdown sources={report.sources} />}
      </>}
      <Modal open={renaming} title={t('biz.dashboard.rename')} onClose={closeRename} footer={<><button type="button" className="btn" onClick={closeRename}>{t('biz.cancel')}</button><button type="submit" form={`${addFormId}-name`} className="btn primary" disabled={!canEdit || !name.trim() || name.trim() === current.name}>{t('biz.save')}</button></>}>
        <form id={`${addFormId}-name`} onSubmit={async (e) => { e.preventDefault(); if (name.trim() && await update({ name: name.trim() })) setRenaming(false); }}><label className="field-block"><span className="label">{t('biz.dashboard.name')}</span><input className="input" value={name} maxLength={80} disabled={!canEdit} onChange={(e) => setName(e.target.value)} /></label>{error && <p className="biz-error" role="alert">{t(error)}</p>}</form>
      </Modal>
      <Modal open={adding} title={t(editing ? 'bizui.edit' : 'biz.addWidget')} onClose={() => { if (!business.busy) setAdding(false); }} footer={<><button type="button" className="btn" disabled={business.busy} onClick={() => setAdding(false)}>{t('biz.cancel')}</button><button type="submit" form={addFormId} className="btn primary" disabled={!canEdit || (!editing && current.widgets.length >= 30)}>{t(editing ? 'biz.save' : 'biz.addWidget')}</button></>}>
        <form id={addFormId} className="biz-dashboard-editor" onSubmit={(e) => { e.preventDefault(); if (canEdit) add(); }}><label className="field-block"><span className="label">{t('biz.widget.type')}</span><select className="input" disabled={!canEdit} value={type} onChange={(e) => { setType(e.target.value); if (!widgetMetrics(e.target.value).includes(metric)) setMetric('sales'); }}>{CHARTS.map((c) => <option key={c} value={c}>{t(`biz.chart.${c}`)}</option>)}</select></label><label className="field-block"><span className="label">{t('biz.widget.metric')}</span><select className="input" disabled={!canEdit} value={metric} onChange={(e) => setMetric(e.target.value)}>{widgetMetrics(type).map((m) => <option key={m} value={m}>{t(`biz.metric.${m}`)}</option>)}</select></label>{error && <p className="biz-error" role="alert">{t(error)}</p>}</form>
      </Modal>
      <Modal open={deleting} title={t('biz.dashboard.removeTitle')} onClose={() => setDeleting(false)} footer={<><button type="button" className="btn" onClick={() => setDeleting(false)}>{t('biz.cancel')}</button><button type="button" className="btn danger" disabled={!canEdit} onClick={async () => { if (await save(dashboards.filter((d) => d.id !== current.id))) setDeleting(false); }}>{t('biz.delete')}</button></>}><p>{t('biz.dashboard.removeBody')}</p></Modal>
    </>}
  </section>;
}
