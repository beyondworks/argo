// 업무 사전 등록(biz.*/bizui.*/mkt.*) — core/i18n.js는 이걸 정적으로 갖지 않는다(첫 화면 150KB 상한, 유건 9/26).
import { useId, useState } from 'react';
import '../business/register-i18n.js';
import { LIBRARY_MODULES } from '../core/module-registry.js';
import { useStore } from '../core/store.js';
import { canManage } from '../core/session.js';
import { t, useLang, registerDict } from '../core/i18n.js';
import { LIBRARY_DICT } from './library-i18n.js';
import { canEditModulePage } from '../core/module-placement-model.js';
import { placeModule } from '../core/module-placement.js';
import { baseOf } from '../core/commands.js';
import { Link, navigate } from '../core/router.jsx';
import { Modal, showToast } from '../ui/Overlay.jsx';
import { Icon } from '../ui/Icon.jsx';
import { defaultPeriod, widgetMetrics } from '../business/dashboard-model.js';
import './module-library.css';

registerDict(LIBRARY_DICT);

function PlacementDialog({ space, module, targetId, onClose }) {
  const formId = useId();
  const pages = useStore((state) => state.pages);
  const eligible = pages.filter((page) => canEditModulePage(page, space));
  const manage = canManage(space);
  const [kind, setKind] = useState(targetId && targetId !== 'home' ? 'page' : manage ? 'home' : 'page');
  const [pageId, setPageId] = useState(eligible.some((page) => page.id === targetId) ? targetId : eligible[0]?.id ?? '');
  const [title, setTitle] = useState(''), [metric, setMetric] = useState('sales'), [filters, setFilters] = useState(defaultPeriod);
  const [busy, setBusy] = useState(false), [error, setError] = useState(null);
  const close = () => { if (!busy) onClose(); };
  const submit = async (event) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const to = await placeModule({ space, moduleId: module.id, cfg: { metric, filters }, target: { kind, pageId, title } });
      showToast(t('library.added')); onClose(); navigate(to);
    } catch (failure) { setError(failure.message?.startsWith('library.') ? failure.message : 'library.loadFailed'); }
    finally { setBusy(false); }
  };
  return <Modal open title={t('library.placeTitle', { name: t(module.title) })} onClose={close} footer={<><button className="btn" disabled={busy} onClick={close}>{t('biz.cancel')}</button><button className="btn primary" type="submit" form={formId} disabled={busy || (kind === 'page' && !pageId)}>{t(busy ? 'biz.loading' : 'library.addHere')}</button></>}>
    <form id={formId} className="bizui-form" onSubmit={submit}>
      <label className="field-block"><span className="label">{t('library.destination')}</span><select className="input" disabled={busy} value={kind} onChange={(event) => setKind(event.target.value)}>{manage && <option value="home">{t('nav.home')}</option>}<option value="page">{t('library.existingPage')}</option>{manage && <option value="new">{t('library.newPage')}</option>}</select></label>
      {kind === 'page' && <label className="field-block"><span className="label">{t('library.existingPage')}</span><select className="input" disabled={busy} required value={pageId} onChange={(event) => setPageId(event.target.value)}><option value="">{t('library.choosePage')}</option>{eligible.map((page) => <option key={page.id} value={page.id}>{page.title || t('page.untitled')}</option>)}</select></label>}
      {kind === 'new' && <label className="field-block"><span className="label">{t('library.pageTitle')}</span><input className="input" required maxLength={200} value={title} disabled={busy} onChange={(event) => setTitle(event.target.value)} /></label>}
      {kind === 'page' && !eligible.length && <p className="dim small">{t('library.noPages')}</p>}
      {module.chartType && <><label className="field-block"><span className="label">{t('biz.widget.metric')}</span><select className="input" value={metric} disabled={busy} onChange={(event) => setMetric(event.target.value)}>{widgetMetrics(module.chartType).map((key) => <option key={key} value={key}>{t(`biz.metric.${key}`)}</option>)}</select></label>{['from', 'to'].map((key) => <label className="field-block" key={key}><span className="label">{t(`biz.filters.${key}`)}</span><input type="date" className="input" required disabled={busy} value={filters[key]} onChange={(event) => setFilters({ ...filters, [key]: event.target.value })} /></label>)}</>}
      <p className="dim small">{t('library.linkedData')}</p>
      {error && <p className="bizui-error" role="alert">{t(error)}</p>}
    </form>
  </Modal>;
}

export default function ModuleLibrary({ space, targetId }) {
  useLang();
  const [query, setQuery] = useState(''), [selected, setSelected] = useState(null);
  const kind = space === 'me' ? 'me' : 'org';
  const modules = LIBRARY_MODULES.filter((module) => module.spaces.includes(kind) && t(module.title).toLocaleLowerCase().includes(query.toLocaleLowerCase().trim()));
  const groups = ['workspace', 'business', 'charts'];
  return <section className="page-wrap wide module-library-page">
    <header className="page-title-row"><div><h1 className="page-h1">{t('library.title')}</h1><p className="dim">{t('library.subtitle')}</p></div></header>
    <label className="search-field library-search"><Icon name="search" size={14} /><input type="search" className="input" placeholder={t('library.search')} aria-label={t('library.search')} value={query} onChange={(event) => setQuery(event.target.value)} /></label>
    {groups.map((group) => {
      const entries = modules.filter((module) => (module.chartType ? 'charts' : module.businessTab ? 'business' : 'workspace') === group);
      return !!entries.length && <section key={group} className="library-group" aria-label={t(`library.${group}`)}>
        <h2 className="library-group-title">{t(`library.${group}`)}</h2>
        <div className="table-wrap"><table className="table module-library-table">
          <colgroup><col /><col className="library-open-column" /><col className="library-add-column" /></colgroup>
          <tbody>{entries.map((module) => <tr key={module.id}>
            <td><span className="library-module-name"><Icon name={module.icon} size={14} className="dim" /><span>{t(module.title)}</span></span></td>
            <td>{module.link && <Link className="btn sm ghost" to={module.link === '/mail' ? '/me/mail' : `${baseOf(space)}${module.link}`}>{t('library.open')}</Link>}</td>
            <td><button type="button" className="btn sm" onClick={() => setSelected(module)} aria-label={t('library.addNamed', { name: t(module.title) })}><Icon name="plus" size={13} />{t('bizui.add')}</button></td>
          </tr>)}</tbody>
        </table></div>
      </section>;
    })}
    {!modules.length && <p className="empty-state">{t('library.noResults')}</p>}
    {selected && <PlacementDialog key={`${space}:${selected.id}`} space={space} module={selected} targetId={targetId} onClose={() => setSelected(null)} />}
  </section>;
}
