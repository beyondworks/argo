import { createContext, useContext, useEffect, useState } from 'react';
import { useBusiness, businessError } from './data.js';
import { useMarketing, marketingError } from './marketing-data.js';
import { t, getLang } from '../core/i18n.js';
import { baseOf } from '../core/commands.js';
import { Link } from '../core/router.jsx';
import { defaultPeriod } from './dashboard-model.js';

const HomeBusiness = createContext(null);
const money = (value) => new Intl.NumberFormat(getLang() === 'en' ? 'en-US' : 'ko-KR', { style: 'currency', currency: 'KRW', maximumFractionDigits: 0 }).format(value);

export function BusinessHomeProvider({ space, children }) {
  const business = useBusiness(space);
  const marketing = useMarketing(space);
  const [summary, setSummary] = useState(null);
  const [performance, setPerformance] = useState(null);
  const { from, to } = defaultPeriod();
  useEffect(() => {
    let alive = true;
    setSummary(null);
    if (business.data && ['payments', 'analytics'].some((tab) => business.data.settings.enabled.includes(tab))) {
      business.report({ from, to, customer: null }).then((report) => {
        if (alive) setSummary({ data: business.data, report });
      }).catch((error) => { if (alive) setSummary({ data: business.data, error: businessError(error) }); });
    }
    return () => { alive = false; };
  }, [business.data, business.report, from, to]);
  const performanceEnabled = business.data?.settings.enabled.includes('performance');
  useEffect(() => {
    let alive = true;
    setPerformance(null);
    if (marketing.data && performanceEnabled) {
      marketing.report({ from, to, campaign: null }).then((report) => {
        if (alive) setPerformance({ data: marketing.data, report });
      }).catch((error) => { if (alive) setPerformance({ data: marketing.data, error: marketingError(error) }); });
    }
    return () => { alive = false; };
  }, [marketing.data, marketing.report, performanceEnabled, from, to]);
  return <HomeBusiness.Provider value={{ business, marketing, summary: summary?.data === business.data ? summary : null, performance: performance?.data === marketing.data ? performance : null, from, to }}>{children}</HomeBusiness.Provider>;
}

function Rows({ rows, path, render }) {
  if (!rows.length) return <div className="mod-empty">{t('mod.empty')}</div>;
  return rows.slice(0, 4).map((row) => <Link key={row.id} className="mod-row" to={path(row)}>{render(row)}</Link>);
}

export function BusinessHomeCard({ space, tab }) {
  const context = useContext(HomeBusiness);
  if (!context) return <BusinessHomeProvider space={space}><BusinessHomeCard space={space} tab={tab} /></BusinessHomeProvider>;
  const { business, marketing, summary, performance, from, to } = context;
  const { data, error } = business;
  const path = `${baseOf(space)}/business/${tab}`;
  if (error) return <div className="mod-empty" role="alert"><p>{t(error)}</p><button className="btn" onClick={() => business.refresh().catch(() => {})}>{t('biz.refresh')}</button></div>;
  if (!data) return <div className="mod-empty" role="status">{t('biz.loading')}</div>;
  if (!data.settings.enabled.includes(tab)) return <div className="mod-empty"><p>{t('bizui.disabled')}</p><Link to={`${baseOf(space)}/business/modules`}>{t('bizui.modules')}</Link></div>;
  if (['marketing', 'performance'].includes(tab)) {
    if (marketing.error) return <div className="mod-empty" role="alert"><p>{t(marketing.error)}</p><button className="btn" onClick={() => marketing.refresh().catch(() => {})}>{t('biz.refresh')}</button></div>;
    if (!marketing.data) return <div className="mod-empty" role="status">{t('biz.loading')}</div>;
  }
  const rowPath = () => path;
  const main = (title, detail) => <span className="mod-main"><span className="clamp">{title}</span>{detail && <small>{detail}</small>}</span>;
  let content;
  if (tab === 'customers') content = <Rows rows={data.customers} path={rowPath} render={(row) => main(row.name, row.email)} />;
  if (tab === 'catalog') content = <Rows rows={data.items} path={rowPath} render={(row) => main(row.name, `${t(`bizui.${row.kind}`)} · ${money(row.price)}`)} />;
  if (tab === 'orders') content = <Rows rows={data.orders} path={(row) => `${path}?open=${encodeURIComponent(row.id)}`} render={(row) => main(row.title, t(`bizui.${row.status}`))} />;
  if (tab === 'inventory') content = <Rows rows={data.items.filter((row) => row.kind === 'product')} path={rowPath} render={(row) => main(row.name, `${t('bizui.available')}: ${row.stock - row.reserved} · ${t('bizui.reserved')}: ${row.reserved}`)} />;
  if (tab === 'marketing') content = <Rows rows={marketing.data.campaigns} path={rowPath} render={(row) => main(row.name, `${row.channel} · ${t(`mkt.status.${row.status}`)}`)} />;
  if (tab === 'performance') content = <>
    <p className="dim">{from} — {to} · {t('biz.home.utc')}</p>
    {!performance ? <p role="status">{t('biz.loading')}</p> : performance.error ? <div role="alert"><p>{t(performance.error)}</p><button className="btn" onClick={() => marketing.refresh().catch(() => {})}>{t('biz.refresh')}</button></div> : ['spend', 'sales', 'paid', 'roas'].map((metric) => <div className="mod-row" key={metric}><span className="mod-main">{t(`mkt.metric.${metric}`)}</span><strong className="mono">{metric === 'roas' ? performance.report.metrics.roas == null ? t('mkt.ratio.na') : new Intl.NumberFormat(getLang() === 'en' ? 'en-US' : 'ko-KR', { style: 'percent', maximumFractionDigits: 2 }).format(performance.report.metrics.roas) : money(performance.report.metrics[metric])}</strong></div>)}
  </>;
  if (tab === 'payments' || tab === 'analytics') content = <>
    <p className="dim">{from} — {to} · {t('biz.home.utc')}</p>
    {!summary ? <p role="status">{t('biz.loading')}</p> : summary.error ? <div role="alert"><p>{t(summary.error)}</p><button className="btn" onClick={() => business.refresh().catch(() => {})}>{t('biz.refresh')}</button></div> : (tab === 'payments' ? ['invoiced', 'paid', 'receivable'] : ['sales', 'invoiced', 'paid', 'receivable']).map((metric) => <div className="mod-row" key={metric}><span className="mod-main">{t(`biz.metric.${metric}`)}</span><strong className="mono">{money(summary.report.metrics[metric])}</strong></div>)}
    <small className="dim">{t('biz.home.balanceThrough')}</small>
  </>;
  return <>{content}<Link className="mod-row" to={path}>{t('biz.home.open')}</Link></>;
}
