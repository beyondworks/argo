import { createContext, useContext, useEffect, useId, useMemo, useRef, useState } from 'react';
import { getLang, t, useLang } from '../core/i18n.js';
import { CHART_MODULES } from '../core/module-registry.js';
import { ModuleGrid, ModuleAddButton } from '../ui/ModuleGrid.jsx';
import { Modal } from '../ui/Overlay.jsx';
import { businessError } from './data.js';
import { CHARTS, METRICS, chartSeries, configureWidget, defaultDashboard, newWidget, normalizeDashboards, validateFilters, widgetMetrics } from './dashboard-model.js';
import { ResponsiveChart } from './ResponsiveChart.jsx';
import { timeSeriesGeometry } from './chart-geometry.js';

const money = (value) => new Intl.NumberFormat(getLang() === 'en' ? 'en-US' : 'ko-KR', { style: 'currency', currency: 'KRW', maximumFractionDigits: 0 }).format(Number(value));
const ChartContext = createContext(null);
function ChartModule({ item }) {
  const context = useContext(ChartContext);
  return <BusinessChart widget={item} {...context} />;
}

export function BusinessChart({ widget, report, onOpenOrder, filters }) {
  if (widget.type === 'kpi') return <div className="biz-kpi-wrap"><strong className="biz-kpi">{money(report.metrics[widget.metric])}</strong></div>;
  if (widget.type === 'table') return report.orders.length ? <div className="table-wrap biz-table-wrap"><table className="table biz-table"><thead><tr><th>{t('biz.order')}</th>{METRICS.map((m) => <th key={m}>{t(`biz.metric.${m}`)}</th>)}</tr></thead><tbody>{report.orders.map((row) => <tr key={row.id}><td><button type="button" className="bizui-link" onClick={() => onOpenOrder(row.id)}>{row.title}</button></td>{METRICS.map((m) => <td key={m}>{money(row[m])}</td>)}</tr>)}</tbody></table></div> : <p className="biz-empty">{t('biz.noRows')}</p>;
  if (widget.type === 'donut') {
    const parts = report.mix.filter((row) => ['service', 'product'].includes(row.kind));
    if (parts.some((row) => Number(row.amount) < 0)) return <p className="biz-empty">{t('biz.donut.negative')}</p>;
    const total = parts.reduce((sum, row) => sum + Number(row.amount), 0);
    if (!total) return <p className="biz-empty">{t('biz.noRows')}</p>;
    let offset = 0;
    return <div className="biz-chart-legend"><svg className="biz-donut" viewBox="0 0 160 160" role="img" aria-label={t('biz.chart.donut')}><title>{t('biz.chart.donut')}</title>{parts.map((row) => {
      const length = Number(row.amount) / total * 100, start = offset; offset += length;
      return <circle key={row.kind} className={`biz-donut-${row.kind}`} cx="80" cy="80" r="58" fill="none" strokeWidth="24" pathLength="100" strokeDasharray={`${length} ${100 - length}`} strokeDashoffset={-start} transform="rotate(-90 80 80)" />;
    })}</svg><ul>{parts.map((row) => <li key={row.kind}>{t(`biz.kind.${row.kind}`)} <strong>{money(row.amount)}</strong> <span>{(Number(row.amount) / total * 100).toFixed(1)}%</span></li>)}</ul></div>;
  }
  const series = chartSeries(report.daily, widget.metric, filters);
  if (!series.length) return <p className="biz-empty">{t('biz.noRows')}</p>;
  const axisMoney = (value) => new Intl.NumberFormat(getLang() === 'en' ? 'en-US' : 'ko-KR', { style: 'currency', currency: 'KRW', notation: 'compact', maximumFractionDigits: 1 }).format(value);
  return <><ResponsiveChart label={t(`biz.metric.${widget.metric}`)}>{(width, height) => {
    const extent = [Math.min(0, ...series.map((point) => point.value)), Math.max(0, ...series.map((point) => point.value))];
    const labelWidth = Math.max(...extent.map((value) => axisMoney(value).length)) * 8 + 12;
    const chart = timeSeriesGeometry(series, width, height, labelWidth);
    const dateLabel = (date) => width < 400 ? date.slice(5) : date;
    return <>
      {[chart.high, (chart.high + chart.low) / 2, chart.low].filter((value, index, all) => all.indexOf(value) === index).map((value) => {
        const y = chart.bottom - (value - chart.low) / (chart.high - chart.low || 1) * (chart.bottom - chart.top);
        return <g key={value}><line className="biz-chart-axis" x1={chart.left} x2={chart.right} y1={y} y2={y} /><text x={chart.left - 8} y={y + 4} textAnchor="end">{axisMoney(value)}</text></g>;
      })}
      {chart.low < 0 && chart.high > 0 && <line className="biz-chart-axis" x1={chart.left} x2={chart.right} y1={chart.baseline} y2={chart.baseline} />}
      <text x={chart.left} y={height - 8}>{dateLabel(series[0].date)}</text>{series.length > 1 && <text x={chart.right} y={height - 8} textAnchor="end">{dateLabel(series.at(-1).date)}</text>}
      {widget.type === 'line' ? <><polyline className="biz-chart-line" points={chart.points.map((point) => `${point.x},${point.y}`).join(' ')} />{chart.points.map((point) => <circle key={point.date} className="biz-chart-bar" cx={point.x} cy={point.y} r="3"><title>{`${point.date}: ${money(point.value)}`}</title></circle>)}</> : chart.points.map((point) => <rect key={point.date} className="biz-chart-bar" x={point.x - chart.barWidth / 2} y={Math.min(chart.baseline, point.y)} width={chart.barWidth} height={Math.abs(chart.baseline - point.y)}><title>{`${point.date}: ${money(point.value)}`}</title></rect>)}
    </>;
  }}</ResponsiveChart><details><summary>{t('biz.chart.data')}</summary><div className="table-wrap biz-table-wrap"><table className="table biz-table"><thead><tr><th>{t('biz.chart.date')}</th><th>{t(`biz.metric.${widget.metric}`)}</th></tr></thead><tbody>{series.map((p) => <tr key={p.date}><td>{p.date}</td><td>{money(p.value)}</td></tr>)}</tbody></table></div></details></>;
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
  const filters = active && current && active.id === current.id ? active.filters : current?.filters;
  const signature = JSON.stringify(filters);
  const reportKey = JSON.stringify([business.scopeKey, current?.id, signature]);
  const report = business.data && reportState?.key === reportKey ? reportState.value : null;
  const stamp = report ? reportState.stamp : null;
  const canEdit = !!business.data?.can_manage && !business.busy && !business.uncertain;
  useEffect(() => { setSelected(null); setActive(null); setReport(null); setError(null); setAdding(false); }, [space]);
  useEffect(() => { setDraft(filters ?? null); setName(current?.name ?? ''); }, [current?.id, current?.name, signature]);
  useEffect(() => { setAdding(false); setEditing(null); }, [space, current?.id]);
  useEffect(() => {
    const request = ++sequence.current;
    setError(null);
    if (!current || !business.data) { setReport(null); setLoading(false); return; }
    setLoading(true);
    business.report(filters).then((result) => { if (request === sequence.current) setReport({ key: reportKey, value: result, stamp: new Date() }); }).catch((e) => { if (request === sequence.current) { setReport(null); setError(businessError(e)); } }).finally(() => { if (request === sequence.current) setLoading(false); });
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
      if (await update({ widgets })) { setAdding(false); setEditing(null); }
    } catch (failure) { setError(businessError(failure)); }
  };
  const resolveModule = (item) => { const module = CHART_MODULES.find((entry) => entry.id === item.type); return { ...module, title: `${t(`biz.metric.${item.metric}`)} · ${t(module.title)}`, render: ChartModule, actions: [{ label: t('bizui.edit'), run: () => editWidget(item) }] }; };
  const apply = (e) => { e.preventDefault(); try { setActive({ id: current.id, filters: validateFilters(draft) }); setError(null); } catch (err) { setError(businessError(err)); } };
  const saveFilters = () => { try { update({ filters: validateFilters(draft) }); } catch (err) { setError(businessError(err)); } };
  return <section className="biz-dashboard" aria-label={t('biz.dashboard')}>
    <div className="tabs biz-dashboard-tabs" role="tablist" aria-label={t('biz.dashboard')}>{dashboards.map((d) => <button type="button" role="tab" className={`tab${current?.id === d.id ? ' on' : ''}`} key={d.id} aria-selected={current?.id === d.id} onClick={() => setSelected(d.id)}>{d.name}</button>)}<button type="button" className="btn" disabled={!canEdit} onClick={create}>{t('biz.dashboard.new')}</button></div>
    {error && <p className="biz-error" role="alert">{t(error)}</p>}
    {!current ? <div className="empty-state"><p>{t('biz.dashboard.empty')}</p><button type="button" className="btn primary" disabled={!canEdit} onClick={create}>{t('biz.dashboard.create')}</button></div> : <>
      <form className="biz-dashboard-toolbar" onSubmit={(e) => { e.preventDefault(); if (name.trim()) update({ name: name.trim() }); }}><label className="field-block"><span className="label">{t('biz.dashboard.name')}</span><input className="input" value={name} maxLength={80} disabled={!canEdit} onChange={(e) => setName(e.target.value)} /></label><button className="btn" disabled={!canEdit || !name.trim() || name === current.name}>{t('biz.save')}</button><button type="button" className="btn ghost" disabled={!canEdit} onClick={() => setDeleting(true)}>{t('biz.dashboard.remove')}</button></form>
      {draft && <form className="biz-dashboard-filters" onSubmit={apply}><label className="field-block"><span className="label">{t('biz.filters.from')}</span><input type="date" className="input" value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} /></label><label className="field-block"><span className="label">{t('biz.filters.to')}</span><input type="date" className="input" value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} /></label><label className="field-block"><span className="label">{t('biz.filters.customer')}</span><select className="input" value={draft.customer ?? ''} onChange={(e) => setDraft({ ...draft, customer: e.target.value || null })}><option value="">{t('biz.filters.all')}</option>{(business.data?.customers ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label><button className="btn" disabled={loading}>{t('biz.filters.apply')}</button>{canEdit && <button type="button" className="btn ghost" onClick={saveFilters}>{t('biz.filters.saveDefault')}</button>}<button type="button" className="btn ghost" disabled={loading} onClick={() => setRevision((n) => n + 1)}>{t('biz.refresh')}</button></form>}
      <p className="biz-source">{t('biz.basis')}</p>
      {loading && <p role="status">{t('biz.loading')}</p>}
      {canEdit && <div className="row-actions"><ModuleAddButton disabled={!canEdit} items={[
        ...current.widgets.filter((widget) => widget.hidden).map((widget) => ({ id: widget.id, title: resolveModule(widget).title, icon: resolveModule(widget).icon, run: () => update({ widgets: current.widgets.map((item) => item.id === widget.id ? { ...item, hidden: false } : item) }) })),
        ...(current.widgets.length < 30 ? [{ id: 'new-widget', title: t('biz.addWidget'), icon: 'plus', run: () => { setEditing(null); setAdding(true); } }] : []),
      ]} /></div>}
      {report && <><p className="biz-source">{t('biz.source', { time: stamp?.toLocaleTimeString(getLang() === 'en' ? 'en-US' : 'ko-KR') ?? '' })}</p>
        <ChartContext.Provider value={{ report, onOpenOrder, filters }}><ModuleGrid id={`business:${space}:${current.id}`} items={current.widgets} canEdit={canEdit} onChange={(widgets) => update({ widgets })} resolveModule={resolveModule} space={space} bodyClassName="biz-widget-body" /></ChartContext.Provider>
        {!current.widgets.some((widget) => !widget.hidden) && <p className="biz-empty">{t('biz.noWidgets')}</p>}
      </>}
      <Modal open={adding} title={t(editing ? 'bizui.edit' : 'biz.addWidget')} onClose={() => { if (!business.busy) setAdding(false); }} footer={<><button type="button" className="btn" disabled={business.busy} onClick={() => setAdding(false)}>{t('biz.cancel')}</button><button type="submit" form={addFormId} className="btn primary" disabled={!canEdit || (!editing && current.widgets.length >= 30)}>{t(editing ? 'biz.save' : 'biz.addWidget')}</button></>}>
        <form id={addFormId} className="biz-dashboard-editor" onSubmit={(e) => { e.preventDefault(); if (canEdit) add(); }}><label className="field-block"><span className="label">{t('biz.widget.type')}</span><select className="input" disabled={!canEdit} value={type} onChange={(e) => { setType(e.target.value); if (!widgetMetrics(e.target.value).includes(metric)) setMetric('sales'); }}>{CHARTS.map((c) => <option key={c} value={c}>{t(`biz.chart.${c}`)}</option>)}</select></label><label className="field-block"><span className="label">{t('biz.widget.metric')}</span><select className="input" disabled={!canEdit} value={metric} onChange={(e) => setMetric(e.target.value)}>{widgetMetrics(type).map((m) => <option key={m} value={m}>{t(`biz.metric.${m}`)}</option>)}</select></label>{error && <p className="biz-error" role="alert">{t(error)}</p>}</form>
      </Modal>
      <Modal open={deleting} title={t('biz.dashboard.removeTitle')} onClose={() => setDeleting(false)} footer={<><button type="button" className="btn" onClick={() => setDeleting(false)}>{t('biz.cancel')}</button><button type="button" className="btn danger" disabled={!canEdit} onClick={async () => { if (await save(dashboards.filter((d) => d.id !== current.id))) setDeleting(false); }}>{t('biz.delete')}</button></>}><p>{t('biz.dashboard.removeBody')}</p></Modal>
    </>}
  </section>;
}
