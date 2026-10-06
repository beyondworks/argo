// 업무 사전 등록(biz.*/bizui.*/mkt.*) — core/i18n.js는 이걸 정적으로 갖지 않는다(첫 화면 150KB 상한, 유건 9/26).
import { createContext, useContext, useEffect, useState } from 'react';
import './register-i18n.js';
import { useBusiness, businessError } from './data.js';
import { useMarketing, marketingError } from './marketing-data.js';
import { t, getLang } from '../core/i18n.js';
import { baseOf } from '../core/commands.js';
import { Link } from '../core/router.jsx';
import { defaultPeriod } from './dashboard-model.js';
import { linkedTotals, effectOf } from './marketing-model.js';
import { InfoTip } from '../ui/InfoTip.jsx';
import { Hide } from './Redact.jsx';

const HomeBusiness = createContext(null);
/** 홈의 업무 읽기(업무 카드가 놓여 있으면 그 읽기) — '챙길 것'(18차, HomeAttention.jsx)이 같은 읽기를 쓴다. 없으면 null */
export const useHomeBusiness = () => useContext(HomeBusiness);
const money = (value) => new Intl.NumberFormat(getLang() === 'en' ? 'en-US' : 'ko-KR', { style: 'currency', currency: 'KRW', maximumFractionDigits: 0 }).format(value);

export function BusinessHomeProvider({ space, tabs, children }) {
  const business = useBusiness(space);
  const marketing = useMarketing(space);
  const [summary, setSummary] = useState(null);
  const [performance, setPerformance] = useState(null);
  const { from, to } = defaultPeriod();
  useEffect(() => {
    let alive = true;
    setSummary(null);
    if (business.data && ['payments', 'analytics'].some((tab) => business.data.settings.enabled.includes(tab) && (!tabs || tabs.includes(tab)))) { // 홈에 놓인 카드만
      business.report({ from, to, customer: null }).then((report) => {
        if (alive) setSummary({ data: business.data, report });
      }).catch((error) => { if (alive) setSummary({ data: business.data, error: businessError(error) }); });
    }
    return () => { alive = false; };
  }, [business.data, business.report, from, to, tabs?.join()]);
  const performanceEnabled = business.data?.settings.enabled.includes('marketing') && (!tabs || tabs.includes('performance'));
  useEffect(() => {
    let alive = true;
    setPerformance(null);
    if (marketing.data && performanceEnabled) {
      marketing.report({ from, to, campaign: null }).then((report) => {
        if (alive) setPerformance({ data: marketing.data, report });
      }).catch((error) => { if (alive) setPerformance({ data: marketing.data, error: marketingError(error) }); });
    }
    return () => { alive = false; };
  }, [marketing.data, marketing.report, performanceEnabled, from, to]); // tabs는 performanceEnabled에 들어 있다
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
  if (!data.settings.enabled.includes(tab === 'performance' ? 'marketing' : tab)) return <div className="mod-empty"><p>{t('bizui.disabled')}</p><Link to={`${baseOf(space)}/business/modules`}>{t('bizui.modules')}</Link></div>;
  if (['marketing', 'performance'].includes(tab)) {
    if (marketing.error) return <div className="mod-empty" role="alert"><p>{t(marketing.error)}</p><button className="btn" onClick={() => marketing.refresh().catch(() => {})}>{t('biz.refresh')}</button></div>;
    if (!marketing.data) return <div className="mod-empty" role="status">{t('biz.loading')}</div>;
  }
  const rowPath = () => path;
  const main = (title, detail) => <span className="mod-main"><span className="clamp">{title}</span>{detail && <small>{detail}</small>}</span>;
  let content;
  if (tab === 'customers') content = <Rows rows={data.customers.filter((row) => !row.archived_at)} path={rowPath} render={(row) => main(row.name, row.email && <Hide k={`customer:${row.id}:email`} focusable={false}>{row.email}</Hide>)} />;
  if (tab === 'catalog') content = <Rows rows={data.items} path={rowPath} render={(row) => main(row.name, <>{t(`bizui.${row.kind}`)} · <Hide k={`item:${row.id}:price`} focusable={false}>{money(row.price)}</Hide></>)} />;
  if (tab === 'orders') content = <Rows rows={data.orders} path={(row) => `${path}?open=${encodeURIComponent(row.id)}`} render={(row) => main(row.title, t(`bizui.${row.status}`))} />;
  if (tab === 'inventory') content = <Rows rows={data.items.filter((row) => row.kind === 'product')} path={rowPath} render={(row) => main(row.name, `${t('bizui.available')}: ${row.stock - row.reserved} · ${t('bizui.reserved')}: ${row.reserved}`)} />;
  if (tab === 'marketing') content = <Rows rows={marketing.data.campaigns} path={rowPath} render={(row) => main(row.name, `${row.channel} · ${t(`mkt.status.${row.status}`)}`)} />;
  if (tab === 'performance') { // 마케팅 탭과 같은 숫자 — 광고와 연결된 거래만(분리 검수 M3)
    const totals = performance?.report && linkedTotals(performance.report.campaigns), effect = totals && effectOf(totals);
    content = <>
    <p className="mod-period"><span className="mono">{from} – {to}</span><InfoTip text={t('biz.home.utc')} /></p>
    {!performance ? <p role="status">{t('biz.loading')}</p> : performance.error ? <div role="alert"><p>{t(performance.error)}</p><button className="btn" onClick={() => marketing.refresh().catch(() => {})}>{t('biz.refresh')}</button></div> : <>
      {['spend', 'sales', 'paid'].map((metric) => <div className="mod-row" key={metric}><span className="mod-main">{t(`mkt.metric.${metric}`)}</span><strong className="mono"><Hide k={`mkt:${metric}`}>{money(totals[metric])}</Hide></strong></div>)}
      <div className="mod-row"><span className="mod-main">{t('mkt.metric.roas')}</span><strong className="mono">{effect.kind === 'times' ? t('mkt.times', { n: effect.times.toLocaleString(getLang() === 'en' ? 'en-US' : 'ko-KR') }) : effect.kind === 'less' ? t('mkt.lessShort') : t('mkt.ratio.na')}</strong></div>
    </>}
  </>;
  }
  if (tab === 'payments' || tab === 'analytics') content = <>
    <p className="mod-period"><span className="mono">{from} – {to}</span><InfoTip text={`${t('biz.home.utc')} · ${t('biz.home.balanceThrough')}`} /></p>
    {!summary ? <p role="status">{t('biz.loading')}</p> : summary.error ? <div role="alert"><p>{t(summary.error)}</p><button className="btn" onClick={() => business.refresh().catch(() => {})}>{t('biz.refresh')}</button></div> : (tab === 'payments' ? ['invoiced', 'paid', 'receivable'] : ['sales', 'invoiced', 'paid', 'receivable']).map((metric) => <div className="mod-row" key={metric}><span className="mod-main">{t(`biz.metric.${metric}`)}</span><strong className="mono"><Hide k={`biz:kpi:${metric}`}>{money(summary.report.metrics[metric])}</Hide></strong></div>)}
  </>;
  return content;
}
