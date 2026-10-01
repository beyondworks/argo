import { CHART_MODULES } from '../core/module-registry.js';

export const METRICS = ['sales', 'invoiced', 'paid', 'receivable'];
export const CHARTS = CHART_MODULES.map((module) => module.id);
export const widgetMetrics = (type) => type === 'donut' ? ['sales'] : ['line', 'bar'].includes(type) ? METRICS.filter((x) => x !== 'receivable') : METRICS;

export function dateOnly(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

export function validateFilters(filters) {
  if (!dateOnly(filters?.from) || !dateOnly(filters?.to) || filters.from > filters.to || Date.parse(filters.to) - Date.parse(filters.from) > 3660 * 86400000) throw Object.assign(new Error('biz.error.dates'), { code: 'dates' });
  const customer = filters.customer || null;
  if (customer !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(customer)) throw new Error('biz.error.customer');
  return { ...(filters.preset ? { preset: filters.preset } : {}), from: filters.from, to: filters.to, customer };
}

export function newWidget(type = 'kpi', metric = 'sales', key = () => crypto.randomUUID()) {
  if (!CHARTS.includes(type) || !widgetMetrics(type).includes(metric)) throw new Error('biz.error.widget');
  return { id: key(), type, metric, size: CHART_MODULES.find((module) => module.id === type).defaultSize };
}

export function configureWidget(widgets, id, type, metric) {
  if (!CHARTS.includes(type) || !widgetMetrics(type).includes(metric) || !widgets.some((widget) => widget.id === id)) throw new Error('biz.error.widget');
  return widgets.map((widget) => widget.id === id ? { ...widget, type, metric } : widget);
}

export function defaultPeriod(today = new Date()) {
  const end = new Date(today);
  const localDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const start = new Date(end.getFullYear(), end.getMonth(), 1);
  return { from: localDate(start), to: localDate(end), customer: null };
}

export function defaultDashboard(name, today = new Date(), key = () => crypto.randomUUID()) {
  return { id: key(), name, filters: { preset: 'all', ...defaultPeriod(today) }, widgets: [newWidget('kpi', 'sales', key), newWidget('kpi', 'paid', key), newWidget('kpi', 'receivable', key), { ...newWidget('line', 'paid', key), size: 'full' }, newWidget('table', 'sales', key)] };
}

export function normalizeDashboards(value) {
  if (!Array.isArray(value)) return [];
  const ids = new Set();
  return value.filter((d) => d && typeof d.id === 'string' && typeof d.name === 'string' && !ids.has(d.id) && ids.add(d.id)).map((d) => {
    const seen = new Set();
    // 프리셋이 없는 옛 저장값(자동으로 들어간 '이번 달')은 한 번 전체로 — 직접 고른 기간은 'custom'. 날짜는 서버 검사(시작·종료일 필수) 때문에 늘 같이 둔다
    const f = d.filters;
    const filters = f && (['month', 'year', 'all', 'custom'].includes(f.preset) ? f : { ...f, preset: 'all' });
    return { ...d, ...(f ? { filters } : {}), widgets: (Array.isArray(d.widgets) ? d.widgets : []).filter((w) => w && typeof w.id === 'string' && !seen.has(w.id) && seen.add(w.id) && CHARTS.includes(w.type) && widgetMetrics(w.type).includes(w.metric)).map((w) => ({ ...w, size: ['s', 'm', 'l', 'full'].includes(w.size) ? w.size : 'full' })) };
  });
}

export function moveWidget(widgets, id, direction) {
  const result = widgets.slice(), index = result.findIndex((w) => w.id === id), next = index + direction;
  if (index < 0 || next < 0 || next >= result.length) return result;
  [result[index], result[next]] = [result[next], result[index]];
  return result;
}

export function chartSeries(daily, metric, filters) {
  if (!widgetMetrics('line').includes(metric)) throw new Error('biz.error.widget');
  const values = (daily ?? []).map((row) => ({ date: row.date, value: Number(row[metric]) })).filter((row) => dateOnly(row.date) && Number.isFinite(row.value)).sort((a, b) => a.date.localeCompare(b.date));
  if (!filters) return values;
  const { from, to } = validateFilters(filters);
  const byDate = new Map(values.map((row) => [row.date, row.value]));
  const result = [];
  for (let day = Date.parse(from); day <= Date.parse(to); day += 86400000) {
    const date = new Date(day).toISOString().slice(0, 10);
    result.push({ date, value: byDate.get(date) ?? 0 });
  }
  return result;
}

/** 기간 거래 목록 — 이 기간에 금액이 하나도 움직이지 않은 거래(₩0 줄)는 뺀다 */
export const periodOrders = (orders) => (orders ?? []).filter((row) => METRICS.some((metric) => Number(row[metric] || 0) !== 0));
