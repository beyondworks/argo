import { LIBRARY_MODULES } from './module-registry.js';
import { defaultPeriod, validateFilters, widgetMetrics } from '../business/dashboard-model.js';

export function moduleDefinition(item) {
  return LIBRARY_MODULES.find((module) => module.id === (item.moduleId ?? item.id));
}

export function createModuleItem(moduleId, cfg = {}, id = () => crypto.randomUUID()) {
  const module = moduleDefinition({ moduleId });
  if (!module) throw new Error('library.invalid');
  let config = {};
  if (module.chartType) {
    const metric = cfg.metric ?? 'sales';
    if (!widgetMetrics(module.chartType).includes(metric)) throw new Error('library.invalid');
    config = { metric, filters: validateFilters(cfg.filters ?? defaultPeriod()) };
  }
  return { id: id(), moduleId, size: module.defaultSize, hidden: false, cfg: config };
}

export function addModuleItem(items, item) {
  const module = moduleDefinition(item);
  if (!module) throw new Error('library.invalid');
  const existing = !module.repeatable && items.find((entry) => (entry.moduleId ?? entry.id) === item.moduleId);
  if (existing) return items.map((entry) => entry.id === existing.id ? { ...entry, hidden: false } : entry);
  return [...items, item];
}

export function appendPageModule(doc, item) {
  if (!doc || doc.type !== 'doc' || !Array.isArray(doc.content)) throw new Error('library.loadFailed');
  const result = structuredClone(doc);
  const grid = result.content.find((node) => node.type === 'moduleGrid');
  if (grid) grid.attrs = { ...grid.attrs, items: addModuleItem(grid.attrs?.items ?? [], item) };
  else result.content.push({ type: 'moduleGrid', attrs: { items: [item] } }, { type: 'paragraph' });
  return result;
}

export function canEditModulePage(page, space) {
  return !!page && page.space === space && !page.template && !page.trashedAt && ['edit', 'full'].includes(page.access);
}
