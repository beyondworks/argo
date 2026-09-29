import { useEffect, useMemo, useState } from 'react';
import { ModuleGrid, ModuleAddButton } from './ModuleGrid.jsx';
import { MODULES, BusinessHomeProvider } from '../pages/modules.jsx';
import { ME, SPACES } from '../core/session.js';
import { t } from '../core/i18n.js';
import { baseOf } from '../core/commands.js';
import { navigate } from '../core/router.jsx';
import { moduleDefinition } from '../core/module-placement-model.js';
import { normalizeModuleItems, moduleAllowedInSpace } from '../core/module-items.js';
import { useBusiness, businessError } from '../business/data.js';
import { BusinessChart } from '../business/Dashboard.jsx';
import { defaultPeriod, validateFilters, widgetMetrics } from '../business/dashboard-model.js';
import '../business/business.css';

function ChartModule({ item, space }) {
  const business = useBusiness(space);
  const [result, setResult] = useState(null);
  const module = moduleDefinition(item);
  const metric = item.cfg?.metric ?? 'sales';
  let filters, invalid = false;
  try { filters = validateFilters(item.cfg?.filters ?? defaultPeriod()); invalid = !widgetMetrics(module.chartType).includes(metric); } catch { invalid = true; }
  const key = JSON.stringify([business.scopeKey, filters, item.id]);
  useEffect(() => {
    let active = true;
    if (invalid || !business.data) return;
    business.report(filters).then((report) => { if (active) setResult({ key, report }); }).catch((error) => { if (active) setResult({ key, error: businessError(error) }); });
    return () => { active = false; };
  }, [key, business.data, business.report, invalid]);
  if (invalid) return <p role="alert">{t('library.invalid')}</p>;
  const error = business.error || (result?.key === key && result.error);
  if (error) return <div className="mod-empty" role="alert"><p>{t(error)}</p><button className="btn" onClick={() => business.refresh().catch(() => {})}>{t('biz.refresh')}</button></div>;
  if (!business.data || result?.key !== key) return <p className="mod-empty" role="status">{t('biz.loading')}</p>;
  return <><p className="dim small">{filters.from} — {filters.to} · {t('biz.home.utc')}</p><BusinessChart widget={{ ...item, type: module.chartType, metric: item.cfg?.metric ?? 'sales' }} report={result.report} filters={filters} onOpenOrder={(id) => navigate(`${baseOf(space)}/business/orders?open=${encodeURIComponent(id)}`)} /></>;
}

export function resolveSurfaceModule(item, space) {
  const definition = moduleDefinition(item);
  if (!moduleAllowedInSpace(definition, space)) return { title: t('library.unavailable'), icon: 'layout', sizes: ['s', 'm', 'l', 'full'], render: () => <p className="mod-empty">{t('library.unavailable')}</p> };
  const renderer = definition.chartType ? ChartModule : MODULES.find((module) => module.id === definition.id)?.render;
  const metric = item.cfg?.metric ?? 'sales';
  const title = definition.chartType ? (widgetMetrics(definition.chartType).includes(metric) ? `${t(`biz.metric.${metric}`)} · ${t(definition.title)}` : t('library.invalid')) : t(definition.title);
  return { ...definition, title, render: renderer,
    link: definition.link && (definition.link === '/mail' ? '/me/mail' : `${baseOf(space)}${definition.link}`) };
}

export default function ModuleSurface({ space, items: rawItems, canEdit, onChange, sourceOwner = ME.id, id = `modules:${space}`, showRestore = true }) {
  const items = useMemo(() => normalizeModuleItems(rawItems), [rawItems]);
  if (!SPACES.some((entry) => entry.key === space) || (space === 'me' && sourceOwner !== ME.id)) return <p className="mod-empty" role="status">{t('library.sourcePermission')}</p>;
  const hasBusiness = items.some((item) => { const module = moduleDefinition(item); return !item.hidden && module?.businessTab; });
  const grid = <ModuleGrid id={id} items={items} canEdit={canEdit} onChange={onChange} resolveModule={(item) => resolveSurfaceModule(item, space)} space={space} />;
  const hidden = items.filter((item) => item.hidden).map((item) => ({ id: item.id, title: resolveSurfaceModule(item, space).title, icon: resolveSurfaceModule(item, space).icon,
    run: () => onChange(items.map((entry) => entry.id === item.id ? { ...entry, hidden: false } : entry)) }));
  return <>{showRestore && canEdit && hidden.length > 0 && <div className="row-actions"><ModuleAddButton items={hidden} /></div>}{hasBusiness ? <BusinessHomeProvider space={space}>{grid}</BusinessHomeProvider> : grid}</>;
}
