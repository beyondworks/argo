import { lazy, Suspense, useMemo } from 'react';
import { ModuleGrid, ModuleAddButton } from './ModuleGrid.jsx';
import { MODULES, BusinessHomeProvider } from '../pages/modules.jsx';
import { ME, SPACES } from '../core/session.js';
import { t } from '../core/i18n.js';
import { baseOf } from '../core/commands.js';
import { moduleDefinition } from '../core/module-placement-model.js';
import { normalizeModuleItems, moduleAllowedInSpace } from '../core/module-items.js';
import { widgetMetrics } from '../business/dashboard-model.js';

// 그래프 모듈은 업무 데이터 계층 전체를 끌고 오므로 쓸 때만 불러온다(첫 화면 150KB 상한, 유건 9/26)
const LazyChartModule = lazy(() => import('../business/HomeChart.jsx'));
function ChartModule(props) {
  return <Suspense fallback={<p className="mod-empty" role="status">{t('biz.loading')}</p>}><LazyChartModule {...props} /></Suspense>;
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
