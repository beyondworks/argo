// 직원 명부(트랙 C, 유건 10/2) — 인트라넷 직원 화면(이름·역할·에이전트 + CLI 토큰)을 조직 명부로.
// 계정 멤버는 자동으로 나오고, 계정 없는 직원은 이름만으로 넣는다. 멤버는 보고, 관리자만 고친다. 메모는 관리자만 본다.
// CLI 토큰 대신 직원마다 자기 계정으로 로그인해 에이전트를 연결한다(실행기는 같은 계정으로 쓴다 — spec8 결정).
import { useId, useMemo, useState } from 'react';
import { t, getLang, registerDict, useLang } from '../core/i18n.js';
import { usePeople, peopleWrite } from '../core/company.js';
import { AGENT_PRESETS, agentLabel, filterPeople, counts, personPayload, linkable, selectable } from '../core/people-model.js';
import { kstDay } from '../core/task-model.js';
import { useStore, crewsIn } from '../core/store.js';
import { ME } from '../core/session.js';
import { Modal, showToast } from '../ui/Overlay.jsx';
import { Icon } from '../ui/Icon.jsx';
import { openMenu } from '../ui/Menu.jsx';
import { Hide } from '../business/Redact.jsx';
import { isHidden, setHidden } from '../business/redact-store.js';
import { redactState } from '../business/cell-pick.js';
import { redactMenu } from '../business/redact-rule.js';
import { hideAllOn } from '../core/hide-all.js';
import { useSelection, selProps } from '../core/selection.js';
import { COMPANY_DICT } from './company-i18n.js';
import './perf.css';
import './company.css';

registerDict(COMPANY_DICT);
const dayText = (d) => (d ? new Date(`${d}T00:00:00+09:00`).toLocaleDateString(getLang() === 'en' ? 'en-US' : 'ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: 'short', day: 'numeric' }) : '—');

export default function People({ space }) {
  useLang();
  const { data, error, loading, reload } = usePeople(space);
  const crews = crewsIn(useStore((s) => s.crews), space, ME.id);
  const [status, setStatus] = useState('active'), [q, setQ] = useState(''), [edit, setEdit] = useState(null), [confirm, setConfirm] = useState(null), [sel, setSel] = useState(() => new Set());
  const people = data?.people ?? [];
  const manager = data?.role === 'manager';
  const list = useMemo(() => filterPeople(people, { status, q }), [people, status, q]);
  const n = counts(people);
  if (space === 'me') return <div className="page-wrap"><Head /><div className="empty-state"><Icon name="person" size={20} /><p>{t('people.orgOnly')}</p></div></div>;

  const open = (p) => setEdit({ ...p, id: p.id ?? crypto.randomUUID(), isNew: !p.id, notes: p.notes ?? '', title: p.title ?? '', department: p.department ?? '', email: p.email ?? '', phone: p.phone ?? '', agent: p.agent ?? '', name: p.id ? p.name : p.name ?? '' });
  const save = async (payload) => { try { await peopleWrite(space, 'person.save', payload); setEdit(null); await reload(); showToast(t('people.saved')); } catch (e) { showToast(t(e.message)); } };
  const del = async () => {
    try { for (const id of confirm.ids) await peopleWrite(space, 'person.delete', { id }); } catch (e) { showToast(t(e.message)); }
    const k = confirm.ids.length; setConfirm(null); setSel(new Set()); await reload();
    showToast(k > 1 ? t('people.deletedN', { n: k }) : t('people.removed'));
  };
  // 고를 수 있는 줄 = 화면의 모든 줄(계정만 있는 직원 포함) — 체크박스·회색 표시·개수가 한 상태다(12차 제보: 회색 4·체크 3·막대 4가 달랐다). 지우기는 명부에 있는 직원만
  const { keys: keysAll, ids: rowIds, deletable: selIds, all } = selectable(list, sel);
  const toggleSel = (id) => setSel((s) => { const x = new Set(s); if (x.has(id)) x.delete(id); else x.add(id); return x; });
  const rowKey = (p) => p.id ?? `u:${p.user_id}`;
  // 여러 개 고르기(11·12차) — 체크박스와 같은 선택. 고른 직원 줄의 이름·이메일·전화를 한 번에 가리기·가림 해제(내 화면 가림 — redact-store.js)
  const cellsOf = (keys) => keys.flatMap((k) => ['name', 'email', 'phone'].map((f) => `person:${k}:${f}`));
  const hideMany = (keys, clear) => {
    const cells = cellsOf(keys), st = redactState(cells, isHidden), go = (on) => () => {
      const changed = cells.filter((k) => isHidden(k) !== on);
      setHidden(changed, on); clear?.();
      showToast(t(on ? 'sel.redacted' : 'sel.unredacted', { n: changed.length }), { undo: () => setHidden(changed, !on) });
    };
    return redactMenu([!st.all && { label: t('bizui.redact'), icon: 'eyeOff', run: go(true) }, st.any && { label: t('bizui.unredact'), icon: 'eye', run: go(false) }], hideAllOn(), t); // 전체 가리기 중이면 안내(18차 검수 M1)
  };
  useSelection('people', { value: sel, onChange: setSel, keys: keysAll, actions: (keys, clear) => {
    const ids = keys.filter((k) => rowIds.includes(k));
    return [...hideMany(keys, clear), manager && ids.length > 0 && { label: t('people.deleteSel'), icon: 'trash', danger: true, run: () => setConfirm({ ids }) }];
  } });
  const rowMenu = (p) => (e) => { if (sel.size > 1 && sel.has(rowKey(p))) { const acts = hideMany([...sel]).filter(Boolean); if (acts.length) openMenu(e, acts); } }; // 고른 직원 위 우클릭 = 고른 것 전체

  return <div className="page-wrap wide perf people">
    <Head right={manager && <button type="button" className="btn primary sm" onClick={() => open({ id: null, user_id: null, name: '' })}><Icon name="plus" size={13} />{t('people.add')}</button>} />
    {error && <p className="biz-error" role="alert">{t(error)}</p>}
    {!data ? <p className="dim small" role="status">{loading ? t('people.loading') : ''}</p> : <>
      <div className="pp-bar">
        <div className="seg" role="tablist">{['active', 'left', 'all'].map((k) => <button key={k} type="button" role="tab" aria-selected={status === k} className={`seg-btn${status === k ? ' on' : ''}`} onClick={() => setStatus(k)}>{t(`people.st.${k}`)} <span className="dim">{n[k]}</span></button>)}</div>
        <label className="search-field pp-search"><Icon name="search" size={14} /><input className="input" type="search" value={q} placeholder={t('people.search')} aria-label={t('people.search')} onChange={(e) => setQ(e.target.value)} /></label>
        {manager && sel.size > 0 && <><span className="small">{t('people.selectedN', { n: sel.size })}</span>
          <button type="button" className="btn ghost sm danger-text" disabled={!selIds.length} onClick={() => setConfirm({ ids: selIds })}><Icon name="trash" size={13} />{t('people.deleteSel')}</button></>}
      </div>
      {!manager && <p className="dim small pp-hint">{t('people.readOnly')}</p>}
      {!list.length ? <div className="empty-state"><Icon name="person" size={20} /><p>{t(people.length ? 'people.emptyFilter' : 'people.empty')}</p></div>
        : <div className="table-wrap" data-sel-scope="people"><table className="table pp-table"><thead><tr>
          {manager && <th className="pp-check"><input type="checkbox" className="co-row-check" checked={all} onChange={() => setSel(all ? new Set() : new Set(keysAll))} aria-label={t('people.selectAll')} /></th>}
          <th>{t('people.col.name')}</th><th>{t('people.col.title')}</th><th className="pp-hide-narrow">{t('people.col.dept')}</th><th className="pp-hide-phone">{t('people.col.contact')}</th>
          <th className="pp-hide-narrow">{t('people.col.agent')}</th><th className="pp-hide-narrow">{t('people.col.joined')}</th><th>{t('people.col.status')}</th></tr></thead>
          <tbody>{list.map((p) => <tr key={rowKey(p)} className={`row-link${p.status === 'left' ? ' left' : ''}`} {...selProps(sel, rowKey(p))} onContextMenu={rowMenu(p)} onClick={(e) => { if (!e.target.closest('input, .redact')) open(p); }}>
            {manager && <td className="pp-check"><input type="checkbox" className="co-row-check" checked={sel.has(rowKey(p))} onChange={() => toggleSel(rowKey(p))} aria-label={t('people.select', { name: p.name })} /></td>}
            <td><span className="pp-name"><Hide k={`person:${rowKey(p)}:name`} kind="name"><strong>{p.name}</strong></Hide>
              {p.account_role && <span className="badge" title={t('people.account')}>{t(`people.role.${p.account_role}`)}</span>}</span>
              {!p.id && <small className="dim">{t('people.accountOnly')}</small>}</td>
            <td>{p.title || <span className="dim">—</span>}</td>
            <td className="pp-hide-narrow">{p.department || <span className="dim">—</span>}</td>
            <td className="pp-hide-phone"><span className="pp-contact">{p.email && <Hide k={`person:${rowKey(p)}:email`}>{p.email}</Hide>}{p.phone && <Hide k={`person:${rowKey(p)}:phone`}><span className="mono">{p.phone}</span></Hide>}{!p.email && !p.phone && <span className="dim">—</span>}</span></td>
            <td className="pp-hide-narrow">{p.agent ? <span className="badge">{agentLabel(p.agent)}</span> : <span className="dim">—</span>}</td>
            <td className="pp-hide-narrow">{dayText(p.joined_on)}</td>
            <td><span className={`badge${p.status === 'left' ? ' late' : ''}`}>{t(`people.st.${p.status}`)}</span>{p.left_on && <small className="dim"> {dayText(p.left_on)}</small>}</td>
          </tr>)}</tbody></table></div>}
    </>}
    {edit && <PersonForm edit={edit} setEdit={setEdit} manager={manager} people={people} crews={crews} onSave={save} onDelete={() => { setConfirm({ ids: [edit.id], name: edit.name }); setEdit(null); }} />}
    {confirm && <Modal open title={t('people.deleteTitle')} onClose={() => setConfirm(null)} footer={<>
      <button type="button" className="btn" onClick={() => setConfirm(null)}>{t('company.cancel')}</button>
      <button type="button" className="btn danger" onClick={del}>{t('people.delete')}</button></>}>
      <p>{confirm.ids.length > 1 ? t('people.deleteManyBody', { n: confirm.ids.length }) : t('people.deleteBody', { name: confirm.name ?? '' })}</p>
    </Modal>}
  </div>;
}

function Head({ right }) {
  return <div className="page-title-row"><div><h1 className="page-h1">{t('people.title')}</h1><p className="dim">{t('people.subtitle')}</p>
    <p className="page-note"><Icon name="info" size={13} />{t('people.signinNote')}</p></div>{right}</div>;
}

function PersonForm({ edit, setEdit, manager, people, crews, onSave, onDelete }) {
  const formId = useId(), agentList = useId();
  const set = (patch) => setEdit({ ...edit, ...patch });
  const payload = personPayload(edit);
  const ro = !manager;
  const accounts = linkable(people, edit.user_id);
  const field = (k, label, extra = {}) => <label className="field-block"><span className="label">{t(label)}</span>
    <input className="input" value={edit[k] ?? ''} readOnly={ro} onChange={(e) => set({ [k]: e.target.value })} {...extra} /></label>;
  return <Modal open width={560} title={edit.isNew && manager ? t('people.add') : edit.name || t('people.edit')} onClose={() => setEdit(null)} footer={<>
    {manager && !edit.isNew && <button type="button" className="btn ghost danger-text" onClick={onDelete}><Icon name="trash" size={13} />{t('people.delete')}</button>}
    {manager && !edit.left_on && !edit.isNew && <button type="button" className="btn ghost" onClick={() => set({ left_on: kstDay() })}>{t('people.leave')}</button>}
    <span className="spacer" />
    <button type="button" className="btn" onClick={() => setEdit(null)}>{t(manager ? 'company.cancel' : 'company.close')}</button>
    {manager && <button type="submit" form={formId} className="btn primary" disabled={!payload}>{t('company.save')}</button>}</>}>
    <form id={formId} className="perf-form pp-form" onSubmit={(e) => { e.preventDefault(); if (payload && manager) onSave(payload); }}>
      {field('name', 'people.f.name', { maxLength: 100, placeholder: t('people.f.namePh'), 'data-autofocus': true })}
      <div className="pp-form-row">{field('title', 'people.f.title', { maxLength: 100, placeholder: t('people.f.titlePh') })}{field('department', 'people.f.dept', { maxLength: 100 })}</div>
      <div className="pp-form-row">{field('email', 'people.f.email', { maxLength: 200, type: 'email' })}{field('phone', 'people.f.phone', { maxLength: 50, type: 'tel' })}</div>
      <div className="pp-form-row">
        {field('agent', 'people.f.agent', { maxLength: 100, list: agentList })}
        <datalist id={agentList}>{[...AGENT_PRESETS, ...crews.map((c) => c.name)].map((a) => <option key={a} value={a} />)}</datalist>
        <label className="field-block"><span className="label">{t('people.f.account')}</span>
          <select className="input" value={edit.user_id ?? ''} disabled={ro} onChange={(e) => { const u = e.target.value || null; const acct = people.find((p) => p.user_id === u); set({ user_id: u, name: edit.name || acct?.name || '' }); }}>
            <option value="">{t('people.f.accountNone')}</option>{accounts.map((p) => <option key={p.user_id} value={p.user_id}>{p.account_name || p.name}</option>)}</select></label>
      </div>
      <div className="pp-form-row">{field('joined_on', 'people.f.joined', { type: 'date' })}{field('left_on', 'people.f.left', { type: 'date', min: edit.joined_on || undefined })}</div>
      {manager && <label className="field-block"><span className="label">{t('people.f.notes')}</span>
        <textarea className="input" rows={3} maxLength={2000} value={edit.notes ?? ''} onChange={(e) => set({ notes: e.target.value })} /></label>}
    </form>
  </Modal>;
}
