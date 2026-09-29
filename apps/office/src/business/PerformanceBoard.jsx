import { createContext, useContext, useMemo, useState } from 'react';
import { t } from '../core/i18n.js';
import { Link } from '../core/router.jsx';
import { baseOf } from '../core/commands.js';
import { ModuleGrid, ModuleAddButton } from '../ui/ModuleGrid.jsx';
import { businessError } from './data.js';
import { campaignBars, performanceLayout } from './marketing-model.js';
import { HorizontalBarChart } from './ResponsiveChart.jsx';

const PerformanceContext = createContext(null);
const label = (key) => t(`mkt.${key}`);
function PerformanceModule({ item, space }) {
  const { report, formatValue, campaigns } = useContext(PerformanceContext);
  const campaignName = (id) => campaigns.find((campaign) => campaign.id === id)?.name ?? label('unattributed');
  if (item.id === 'campaigns') {
    const chart = campaignBars(report.campaigns);
    if (!chart.rows.length) return <p className="biz-empty">{t('bizui.empty')}</p>;
    return <><HorizontalBarChart label={label('campaignChart')} rows={chart.rows} low={chart.low} high={chart.high} formatValue={(value) => formatValue('sales', value)} unnamed={label('unattributed')} />
      <details><summary>{t('biz.chart.data')}</summary><p>{label('chartLimit')}</p><div className="table-wrap biz-table-wrap"><table className="table"><thead><tr><th>{label('name')}</th><th className="num">{label('sales')}</th></tr></thead><tbody>{chart.rows.map((row) => <tr key={row.id ?? 'unattributed'}><td>{row.name || label('unattributed')}</td><td className="num">{formatValue('sales', row.sales)}</td></tr>)}</tbody></table></div></details></>;
  }
  if (item.id === 'comparison' || item.id === 'sourceOrders') {
    const isOrders = item.id === 'sourceOrders', rows = isOrders ? report.orders : report.campaigns;
    if (!rows?.length) return <p className="biz-empty">{t('bizui.empty')}</p>;
    const columns = isOrders ? ['order_id', 'campaign_id', 'sales', 'paid'] : ['name', 'channel', 'spend', 'sales', 'paid', 'orders', 'roas', 'cpl'];
    return <div className="table-wrap biz-table-wrap"><table className="table biz-table"><thead><tr>{columns.map((column, index) => <th key={column} className={index > 1 ? 'num' : undefined}>{label(column)}</th>)}</tr></thead><tbody>{rows.map((row) => <tr key={row.id ?? 'unattributed'}>
      <td>{isOrders ? <Link className="bizui-link" to={`${baseOf(space)}/business/orders?open=${encodeURIComponent(row.id)}`}>{row.title}</Link> : row.name || label('unattributed')}</td>
      <td>{isOrders ? campaignName(row.campaign_id) : row.channel || '—'}</td>{columns.slice(2).map((key) => <td key={key} className="num">{formatValue(key, row[key])}</td>)}
    </tr>)}</tbody></table></div>;
  }
  return <div className="biz-kpi-wrap"><strong className="biz-kpi metric">{formatValue(item.id, report.metrics[item.id])}</strong>{report.previous && <small className="stat-sub">{label('previous')} <span className="mono">{formatValue(item.id, report.previous[item.id])}</span></small>}</div>;
}

export default function PerformanceBoard({ space, business, report, campaigns, formatValue }) {
  const [error, setError] = useState(null);
  const items = useMemo(() => performanceLayout(business.data?.settings?.performance?.items), [business.data?.settings?.performance?.items]);
  const canEdit = !!business.data?.can_manage && !business.busy && !business.uncertain;
  const save = async (next) => {
    setError(null);
    try { await business.mutate('settings.save', { ...business.data.settings, performance: { items: next } }); return true; }
    catch (failure) { setError(businessError(failure)); return false; }
  };
  const resolveModule = (item) => ({ title: label(item.id === 'campaigns' ? 'campaignChart' : item.id), icon: ['campaigns', 'comparison', 'sourceOrders'].includes(item.id) ? 'chart' : 'target', sizes: ['s', 'm', 'l', 'full'], render: PerformanceModule });
  return <div className="biz-dashboard">
    {error && <p className="bizui-error" role="alert">{t(error)}</p>}
    {canEdit && items.some((item) => item.hidden) && <div className="biz-bar"><span className="spacer" /><ModuleAddButton items={items.filter((item) => item.hidden).map((item) => ({ id: item.id, title: resolveModule(item).title, icon: resolveModule(item).icon, run: () => save([...items.filter((entry) => entry.id !== item.id), { ...item, hidden: false }]) }))} /></div>}
    <PerformanceContext.Provider value={{ report, campaigns, formatValue }}><ModuleGrid id={`performance:${space}`} items={items} canEdit={canEdit} onChange={save} resolveModule={resolveModule} space={space} bodyClassName="biz-widget-body" /></PerformanceContext.Provider>
    {!items.some((item) => !item.hidden) && <p className="biz-empty">{t('biz.noWidgets')}</p>}
  </div>;
}
