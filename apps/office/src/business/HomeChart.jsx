// 업무 사전 등록(biz.*/bizui.*/mkt.*) — core/i18n.js는 이걸 정적으로 갖지 않는다(첫 화면 150KB 상한, 유건 9/26).
import { useEffect, useState } from 'react';
import './register-i18n.js';
import { t } from '../core/i18n.js';
import { baseOf } from '../core/commands.js';
import { navigate } from '../core/router.jsx';
import { moduleDefinition } from '../core/module-placement-model.js';
import { useBusiness, businessError } from './data.js';
import { BusinessChart } from './Dashboard.jsx';
import { defaultPeriod, validateFilters, widgetMetrics } from './dashboard-model.js';
import { InfoTip } from '../ui/InfoTip.jsx';
import './business.css';

export default function ChartModule({ item, space }) {
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
  return <><p className="mod-period"><span className="mono">{filters.from} – {filters.to}</span><InfoTip text={t('biz.basis')} /></p><BusinessChart widget={{ ...item, type: module.chartType, metric: item.cfg?.metric ?? 'sales' }} report={result.report} filters={filters} onOpenOrder={(id) => navigate(`${baseOf(space)}/business/orders?open=${encodeURIComponent(id)}`)} /></>;
}
