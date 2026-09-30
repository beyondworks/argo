// 노하우(스킬)·업무 세트(하네스) 4단계(유건 9/29) — 일을 할수록 쌓여 개인과 회사의 자산이 된다.
// 후보: 같은 종류 일을 3번 끝내면 "노하우로 남길까요?"(AI 없음). 개인 노하우는 내 것, 관리자가 승인하면 회사 노하우로 사본이 올라간다.
import { useCallback, useEffect, useId, useState } from 'react';
import { t, getLang, registerDict, useLang } from '../core/i18n.js';
import { rpc, orgOf } from '../core/tasks.js';
import { Modal, showToast } from '../ui/Overlay.jsx';
import { Icon } from '../ui/Icon.jsx';
import { ASSET_DICT } from './assets-i18n.js';
import './perf.css';

registerDict(ASSET_DICT);
const ERR = { asset_forbidden: 'permission', asset_version: 'version', asset_input: 'input', asset_conflict: 'conflict', asset_not_found: 'missing', asset_limit: 'limit' };
const errKey = (e) => `asset.error.${ERR[e?.message] ?? 'failed'}`;
const day = (v) => new Date(v).toLocaleDateString(getLang() === 'en' ? 'en-US' : 'ko-KR', { timeZone: 'Asia/Seoul', month: 'short', day: 'numeric' });
const lines = (s) => String(s ?? '').split('\n').map((x) => x.trim()).filter(Boolean);

export default function Assets({ space }) {
  useLang();
  const org = orgOf(space);
  const [data, setData] = useState(null), [error, setError] = useState(null), [edit, setEdit] = useState(null), [tab, setTab] = useState(org ? 'company' : 'mine');
  const load = useCallback(() => rpc('office_asset_list', { p_org: org }).then((d) => { setData(d); setError(null); }).catch((e) => setError(errKey(e))), [org]);
  useEffect(() => { setData(null); load(); }, [load]);
  const write = async (action, payload) => { try { const r = await rpc('office_asset_write', { p_org: org, p_action: action, p_data: payload }); await load(); return r; } catch (e) { showToast(t(errKey(e))); throw e; } };
  const decide = (id, approve) => rpc('office_asset_manage', { p_org: org, p_action: 'promotion.decide', p_data: { id, approve } }).then(() => { showToast(t(approve ? 'asset.promoted' : 'asset.rejected')); load(); }).catch((e) => showToast(t(errKey(e))));
  const manager = data?.role === 'manager';
  const draft = (s) => setEdit({ kind: 'knowhow', scope: 'me', title: t('asset.draftTitle', { k: s.key }), source_key: s.key,
    body: `${t('asset.draftDone')}\n${s.tasks.map((x) => `- ${x.title} (${day(x.done_at)})${x.note ? ` — ${x.note}` : ''}`).join('\n')}\n\n${t('asset.draftSteps')}\n1. \n2. \n3. `, spec: {} });
  const blank = (kind) => setEdit({ kind, scope: tab === 'company' && manager ? 'org' : 'me', title: '', body: '', spec: { knowhow: [], tools: [], checks: [] } });
  const list = data ? (tab === 'company' ? data.company : data.mine).filter((a) => a.kind !== 'tool') : []; // 도구는 '도구' 화면에서
  return <div className="page-wrap wide perf">
    <div className="page-title-row"><div><h1 className="page-h1">{t('asset.title')}</h1><p className="dim">{t('asset.subtitle')}</p></div>
      <div className="perf-nav"><button type="button" className="btn sm" onClick={() => blank('knowhow')}><Icon name="plus" size={13} />{t('asset.newKnowhow')}</button>
        <button type="button" className="btn sm" onClick={() => blank('set')}><Icon name="plus" size={13} />{t('asset.newSet')}</button></div></div>
    {error && <p className="biz-error" role="alert">{t(error)}</p>}
    {!data ? <p className="dim small" role="status">{t('asset.loading')}</p> : <>
      {data.suggestions.length > 0 && <section className="module"><header className="module-head"><Icon name="info" size={15} /><h3>{t('asset.suggest')}</h3></header>
        <ul className="perf-days">{data.suggestions.map((s) => <li key={s.key} className="perf-item">
          <span className="badge">{t('asset.times', { n: s.count })}</span>
          <span className="perf-item-main"><strong>{s.key}</strong><br /><small className="dim">{s.tasks.slice(0, 3).map((x) => x.title).join(' · ')}</small></span>
          <button type="button" className="btn ghost sm" onClick={() => write('suggest.dismiss', { key: s.key }).catch(() => {})}>{t('asset.dismiss')}</button>
          <button type="button" className="btn primary sm" onClick={() => draft(s)}>{t('asset.keep')}</button></li>)}</ul></section>}
      {data.promotions.length > 0 && <section className="module"><header className="module-head"><Icon name="stamp" size={15} /><h3>{t('asset.promotions')}</h3></header>
        <ul className="perf-days">{data.promotions.map((p) => <li key={p.id} className="perf-item">
          <span className="perf-item-main"><strong>{p.title}</strong><br /><small className="dim clamp">{lines(p.body).slice(0, 2).join(' · ')}</small></span>
          {manager ? <><button type="button" className="btn sm" onClick={() => decide(p.id, false)}>{t('asset.reject')}</button><button type="button" className="btn primary sm" onClick={() => decide(p.id, true)}>{t('asset.approve')}</button></>
            : <span className="badge">{t('asset.pending')}</span>}</li>)}</ul></section>}
      {org && <div className="perf-bar"><div className="seg" role="tablist">{['company', 'mine'].map((k) => <button key={k} type="button" role="tab" aria-selected={tab === k} className={`seg-btn${tab === k ? ' on' : ''}`} onClick={() => setTab(k)}>{t(`asset.tab.${k}`)}</button>)}</div></div>}
      <section className="module"><header className="module-head"><Icon name="book" size={15} /><h3>{t(tab === 'company' ? 'asset.tab.company' : 'asset.tab.mine')}</h3></header>
        {!list.length ? <p className="mod-empty">{t(tab === 'company' ? 'asset.emptyCompany' : 'asset.emptyMine')}</p>
          : <ul className="perf-days">{list.map((a) => <li key={a.id} className="perf-item">
            <span className="badge">{t(`asset.kind.${a.kind}`)}</span>
            <button type="button" className="perf-item-main asset-open" onClick={() => setEdit({ ...a, spec: { knowhow: [], tools: [], checks: [], ...a.spec } })}><strong>{a.title}</strong><br />
              <small className="dim">{[t('asset.uses', { n: a.uses }), `v${a.version}`, day(a.updated_at), a.promoted_from && t('asset.fromPersonal')].filter(Boolean).join(' · ')}</small></button>
            {org && a.scope === 'me' && a.kind === 'knowhow' && !data.promotions.some((p) => p.asset_id === a.id) && <button type="button" className="btn ghost sm" onClick={() => write('asset.promote', { id: crypto.randomUUID(), asset_id: a.id }).then(() => showToast(t('asset.promoteSent'))).catch(() => {})}>{t('asset.promote')}</button>}
          </li>)}</ul>}
      </section>
      <p className="dim small">{t('asset.hint')}</p>
    </>}
    {edit && <Editor edit={edit} setEdit={setEdit} data={data} manager={manager} org={org} write={write} />}
  </div>;
}

function Editor({ edit, setEdit, data, manager, org, write }) {
  const formId = useId();
  const readOnly = edit.id && edit.scope === 'org' && !manager;
  const knowhow = [...(data?.company ?? []), ...(data?.mine ?? [])].filter((a) => a.kind === 'knowhow' && (edit.scope === 'me' || a.scope === 'org'));
  const tools = [...(data?.company ?? []), ...(data?.mine ?? [])].filter((a) => a.kind === 'tool' && (edit.scope === 'me' || a.scope === 'org')); // 도구함(5단계)
  const spec = edit.spec ?? {}, set = (patch) => setEdit({ ...edit, ...patch }), setSpec = (patch) => set({ spec: { ...spec, ...patch } });
  const save = async (e) => {
    e.preventDefault();
    const payload = { title: edit.title.trim(), body: edit.body, spec: edit.kind === 'set' ? { knowhow: spec.knowhow ?? [], tool_ids: spec.tool_ids ?? [], tools: lines((spec.toolsText ?? (spec.tools ?? []).join('\n'))), checks: lines((spec.checksText ?? (spec.checks ?? []).join('\n'))) } : {} };
    try {
      if (edit.id) await write('asset.update', { id: edit.id, version: edit.version, ...payload });
      else await write('asset.create', { id: crypto.randomUUID(), kind: edit.kind, scope: edit.scope, source_key: edit.source_key, ...payload });
      setEdit(null); showToast(t('asset.saved'));
    } catch { /* write가 알림을 띄운다 */ }
  };
  const archive = async () => { try { await write('asset.archive', { id: edit.id }); setEdit(null); } catch { /* 알림 */ } };
  return <Modal open width={640} title={t(edit.id ? (readOnly ? 'asset.view' : 'asset.edit') : edit.kind === 'set' ? 'asset.newSet' : 'asset.newKnowhow')} onClose={() => setEdit(null)} footer={<>
    {edit.id && !readOnly && <button type="button" className="btn ghost" onClick={archive}>{t('asset.archive')}</button>}
    <span className="spacer" />
    <button type="button" className="btn" onClick={() => setEdit(null)}>{t('asset.close')}</button>
    {!readOnly && <button type="submit" form={formId} className="btn primary" disabled={!edit.title.trim()}>{t('asset.save')}</button>}</>}>
    <form id={formId} className="perf-form" onSubmit={save}>
      <p className="dim small">{t(edit.kind === 'set' ? 'asset.setHint' : 'asset.knowhowHint')}</p>
      {!edit.id && org && manager && <label className="field-block"><span className="label">{t('asset.where')}</span>
        <select className="input" value={edit.scope} onChange={(e) => set({ scope: e.target.value })}><option value="me">{t('asset.tab.mine')}</option><option value="org">{t('asset.tab.company')}</option></select></label>}
      <label className="field-block"><span className="label">{t('asset.name')}</span><input className="input" maxLength={200} value={edit.title} readOnly={readOnly} onChange={(e) => set({ title: e.target.value })} /></label>
      <label className="field-block"><span className="label">{t(edit.kind === 'set' ? 'asset.setBody' : 'asset.body')}</span><textarea className="input area" rows={edit.kind === 'set' ? 3 : 12} maxLength={20000} value={edit.body} readOnly={readOnly} onChange={(e) => set({ body: e.target.value })} /></label>
      {edit.kind === 'set' && <>
        <fieldset className="field-block"><legend className="label">{t('asset.setKnowhow')}</legend>
          {!knowhow.length ? <p className="dim small">{t('asset.noKnowhow')}</p> : <div className="deal-owner-list">{knowhow.map((k) => <label key={k.id} className="check-row">
            <input type="checkbox" disabled={readOnly} checked={(spec.knowhow ?? []).includes(k.id)} onChange={() => setSpec({ knowhow: (spec.knowhow ?? []).includes(k.id) ? spec.knowhow.filter((x) => x !== k.id) : [...(spec.knowhow ?? []), k.id] })} />{k.title}</label>)}</div>}</fieldset>
        {tools.length > 0 && <fieldset className="field-block"><legend className="label">{t('asset.toolIds')}</legend><div className="deal-owner-list">{tools.map((k) => <label key={k.id} className="check-row">
          <input type="checkbox" disabled={readOnly} checked={(spec.tool_ids ?? []).includes(k.id)} onChange={() => setSpec({ tool_ids: (spec.tool_ids ?? []).includes(k.id) ? spec.tool_ids.filter((x) => x !== k.id) : [...(spec.tool_ids ?? []), k.id] })} />{k.title}</label>)}</div></fieldset>}
        <label className="field-block"><span className="label">{t('asset.tools')}</span><textarea className="input area" rows={2} readOnly={readOnly} placeholder={t('asset.toolsHint')} value={spec.toolsText ?? (spec.tools ?? []).join('\n')} onChange={(e) => setSpec({ toolsText: e.target.value })} /></label>
        <label className="field-block"><span className="label">{t('asset.checks')}</span><textarea className="input area" rows={4} readOnly={readOnly} placeholder={t('asset.checksHint')} value={spec.checksText ?? (spec.checks ?? []).join('\n')} onChange={(e) => setSpec({ checksText: e.target.value })} /></label>
      </>}
    </form>
  </Modal>;
}
