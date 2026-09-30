export const PERFORMANCE_MODULES = [
  ...['spend', 'sales', 'paid', 'roas', 'cpl', 'orders'].map((id) => ({ id, size: 's' })),
  { id: 'campaigns', size: 'full' }, { id: 'comparison', size: 'full' }, { id: 'sourceOrders', size: 'full' },
];

export function performanceLayout(saved) {
  if (!Array.isArray(saved)) return PERFORMANCE_MODULES.map((item) => ({ ...item, hidden: false }));
  const registry = new Map(PERFORMANCE_MODULES.map((item) => [item.id, item]));
  const seen = new Set(), items = [];
  for (const item of saved) {
    if (!item || !registry.has(item.id) || seen.has(item.id)) continue;
    seen.add(item.id);
    items.push({ id: item.id, size: ['s', 'm', 'l', 'full'].includes(item.size) ? item.size : registry.get(item.id).size, hidden: item.hidden === true });
  }
  return [...items, ...PERFORMANCE_MODULES.filter((item) => !seen.has(item.id)).map((item) => ({ ...item, hidden: true }))];
}

export function campaignBars(campaigns) {
  const rows = (campaigns ?? []).filter((row) => Number.isFinite(Number(row.sales))).slice().sort((a, b) => Number(b.sales) - Number(a.sales) || String(a.id).localeCompare(String(b.id))).slice(0, 20);
  const low = Math.min(0, ...rows.map((row) => Number(row.sales))), high = Math.max(0, ...rows.map((row) => Number(row.sales)));
  const y = (value) => 174 - (Number(value) - low) / (high - low || 1) * 144;
  return { low, high, baseline: y(0), rows: rows.map((row, index) => ({ ...row, x: 64 + (index + .5) / rows.length * 540, y: Math.min(y(0), y(row.sales)), height: Math.abs(y(0) - y(row.sales)), width: Math.min(32, 400 / rows.length) })) };
}
