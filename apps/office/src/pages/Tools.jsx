// 도구함 5단계(유건 9/29) — 회사가 쓰는 도구를 등록해 두는 곳. 오피스가 봇에 도구를 설치하지는 못하므로,
// 크루에게 일을 맡길 때 그 크루에게 배정되고 켜진 도구의 이름·주소·사용법이 맡기는 글에 실린다. 업무 세트도 도구를 묶는다.
import { useCallback, useEffect, useId, useState } from 'react';
import { t, registerDict, useLang } from '../core/i18n.js';
import { rpc, orgOf } from '../core/tasks.js';
import { ME } from '../core/session.js';
import { useStore, crewsIn } from '../core/store.js';
import { loadAccounts } from '../core/mail.js';
import { Link } from '../core/router.jsx';
import { Modal, showToast } from '../ui/Overlay.jsx';
import { Icon } from '../ui/Icon.jsx';
import { TOOL_DICT } from './tools-i18n.js';
import './perf.css';

registerDict(TOOL_DICT);
const ERR = { asset_forbidden: 'permission', asset_version: 'version', asset_input: 'input', asset_limit: 'limit' };
const errKey = (e) => `tool.error.${ERR[e?.message] ?? 'failed'}`;
const KINDS = ['service', 'mcp', 'plugin', 'account', 'other'];

export default function Tools({ space }) {
  useLang();
  const org = orgOf(space);
  const [data, setData] = useState(null), [edit, setEdit] = useState(null), [tab, setTab] = useState(org ? 'company' : 'mine');
  const accounts = useStore((s) => s.mailAccounts), allCrews = useStore((s) => s.crews);
  const crews = crewsIn(allCrews, space, ME.id);
  const load = useCallback(() => rpc('office_asset_list', { p_org: org }).then(setData).catch((e) => showToast(t(errKey(e)))), [org]);
  useEffect(() => { setData(null); load(); loadAccounts().catch(() => {}); }, [load]);
  const write = async (action, payload) => { try { await rpc('office_asset_write', { p_org: org, p_action: action, p_data: payload }); await load(); } catch (e) { showToast(t(errKey(e))); throw e; } };
  const manager = data?.role === 'manager' || !org;
  const list = data ? (tab === 'company' ? data.company : data.mine).filter((a) => a.kind === 'tool') : [];
  const canEdit = (a) => a.scope === 'me' || manager;
  const toggle = (a) => write('asset.update', { id: a.id, version: a.version, title: a.title, body: a.body, spec: { ...a.spec, enabled: !a.spec.enabled } }).catch(() => {});
  const crewName = (id) => allCrews.find((c) => c.id === id)?.name ?? '?';
  return <div className="page-wrap wide perf">
    <div className="page-title-row"><div><h1 className="page-h1">{t('tool.title')}</h1><p className="dim">{t('tool.subtitle')}</p></div>
      {(tab === 'mine' || manager) && <button type="button" className="btn sm" onClick={() => setEdit({ scope: tab === 'company' ? 'org' : 'me', title: '', body: '', spec: { tool_kind: 'service', url: '', enabled: true, crews: [] } })}><Icon name="plus" size={13} />{t('tool.add')}</button>}</div>
    <section className="module"><header className="module-head"><Icon name="mail" size={15} /><h3>{t('tool.connected')}</h3></header>
      {!accounts.length ? <p className="mod-empty">{t('tool.noAccount')} <Link to="/me/mail">{t('tool.connect')}</Link></p>
        : <ul className="perf-days">{accounts.map((a) => <li key={a.id} className="perf-item"><span className={`badge${a.status === 'ok' ? '' : ' late'}`}>{t(a.status === 'ok' ? 'tool.ok' : 'tool.expired')}</span><span className="perf-item-main">{a.address}</span><small className="dim">{t('tool.mailUse')}</small></li>)}</ul>}
    </section>
    {org && <div className="perf-bar"><div className="seg" role="tablist">{['company', 'mine'].map((k) => <button key={k} type="button" role="tab" aria-selected={tab === k} className={`seg-btn${tab === k ? ' on' : ''}`} onClick={() => setTab(k)}>{t(`tool.tab.${k}`)}</button>)}</div></div>}
    <section className="module"><header className="module-head"><Icon name="box" size={15} /><h3>{t(`tool.tab.${tab}`)}</h3></header>
      {!data ? <p className="dim small" role="status">…</p> : !list.length ? <p className="mod-empty">{t('tool.empty')}</p>
        : <ul className="perf-days">{list.map((a) => <li key={a.id} className={`perf-item${a.spec.enabled ? '' : ' tool-off'}`}>
          <label className="tool-switch" title={t(a.spec.enabled ? 'tool.on' : 'tool.off')}><input type="checkbox" checked={!!a.spec.enabled} disabled={!canEdit(a)} onChange={() => toggle(a)} aria-label={t('tool.enabled')} /></label>
          <span className="badge">{t(`tool.kind.${a.spec.tool_kind}`)}</span>
          <button type="button" className="perf-item-main asset-open" onClick={() => setEdit({ ...a, spec: { crews: [], ...a.spec, url: a.spec.url ?? '' } })}><strong>{a.title}</strong><br />
            <small className="dim">{[a.spec.crews?.length ? t('tool.crews', { names: a.spec.crews.map(crewName).join(', ') }) : t('tool.noCrew'), t('tool.uses', { n: a.uses })].join(' · ')}</small></button>
          {a.spec.url && <a className="btn ghost sm" href={a.spec.url} target="_blank" rel="noreferrer noopener">{t('tool.open')}</a>}
        </li>)}</ul>}
    </section>
    <p className="dim small">{t('tool.hint')}</p>
    {edit && <Editor edit={edit} setEdit={setEdit} crews={crews.filter((c) => edit.scope === 'org' || c.owner === ME.id)} readOnly={!!edit.id && !canEdit(edit)} write={write} />}
  </div>;
}

function Editor({ edit, setEdit, crews, readOnly, write }) {
  const formId = useId();
  const spec = edit.spec, set = (patch) => setEdit({ ...edit, ...patch }), setSpec = (patch) => set({ spec: { ...spec, ...patch } });
  const save = async (e) => {
    e.preventDefault();
    const payload = { title: edit.title.trim(), body: edit.body, spec: { tool_kind: spec.tool_kind, url: spec.url.trim() || null, enabled: spec.enabled, crews: spec.crews } };
    try {
      if (edit.id) await write('asset.update', { id: edit.id, version: edit.version, ...payload });
      else await write('asset.create', { id: crypto.randomUUID(), kind: 'tool', scope: edit.scope, ...payload });
      setEdit(null); showToast(t('tool.saved'));
    } catch { /* write가 알림 */ }
  };
  const archive = async () => { try { await write('asset.archive', { id: edit.id }); setEdit(null); } catch { /* 알림 */ } };
  return <Modal open width={600} title={t(edit.id ? 'tool.edit' : 'tool.add')} onClose={() => setEdit(null)} footer={<>
    {edit.id && !readOnly && <button type="button" className="btn ghost" onClick={archive}>{t('tool.archive')}</button>}
    <span className="spacer" />
    <button type="button" className="btn" onClick={() => setEdit(null)}>{t('tool.close')}</button>
    {!readOnly && <button type="submit" form={formId} className="btn primary" disabled={!edit.title.trim()}>{t('tool.save')}</button>}</>}>
    <form id={formId} className="perf-form" onSubmit={save}>
      <label className="field-block"><span className="label">{t('tool.name')}</span><input className="input" maxLength={200} value={edit.title} readOnly={readOnly} placeholder={t('tool.nameHint')} onChange={(e) => set({ title: e.target.value })} /></label>
      <label className="field-block"><span className="label">{t('tool.kind')}</span><select className="input" value={spec.tool_kind} disabled={readOnly} onChange={(e) => setSpec({ tool_kind: e.target.value })}>{KINDS.map((k) => <option key={k} value={k}>{t(`tool.kind.${k}`)}</option>)}</select></label>
      <label className="field-block"><span className="label">{t('tool.url')}</span><input className="input" type="url" maxLength={500} value={spec.url} readOnly={readOnly} placeholder="https://" onChange={(e) => setSpec({ url: e.target.value })} /></label>
      <label className="field-block"><span className="label">{t('tool.guide')}</span><textarea className="input area" rows={5} maxLength={20000} value={edit.body} readOnly={readOnly} placeholder={t('tool.guideHint')} onChange={(e) => set({ body: e.target.value })} /></label>
      <label className="check-row"><input type="checkbox" checked={!!spec.enabled} disabled={readOnly} onChange={(e) => setSpec({ enabled: e.target.checked })} />{t('tool.enabledLong')}</label>
      <fieldset className="field-block"><legend className="label">{t('tool.assign')}</legend>
        {!crews.length ? <p className="dim small">{t('tool.noCrews')}</p> : <div className="deal-owner-list">{crews.map((c) => <label key={c.id} className="check-row">
          <input type="checkbox" disabled={readOnly} checked={spec.crews.includes(c.id)} onChange={() => setSpec({ crews: spec.crews.includes(c.id) ? spec.crews.filter((x) => x !== c.id) : [...spec.crews, c.id] })} />{c.name}</label>)}</div>}
        <p className="dim small">{t('tool.assignHint')}</p></fieldset>
    </form>
  </Modal>;
}
