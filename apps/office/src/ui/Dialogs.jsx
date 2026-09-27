// 공유·게시 창과 "크루에게 맡기기" 창.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Modal, Sheet, showToast } from './Overlay.jsx';
import { Icon } from './Icon.jsx';
import { Face } from './Face.jsx';
import { t, useLang } from '../core/i18n.js';
import { useUi, setUi } from '../core/ui-state.js';
import { useStore, assign, update } from '../core/store.js';
import { imeGuardWith } from '../core/ime.js';
import { CREWS } from '../data/sample.js';
import { SPACES, ME, getMode } from '../core/session.js';
import { getClient } from '../core/supabase.js';
import { baseOf } from '../core/commands.js';

/** 서버에서 공유 상태를 읽는다 — 사람 목록 RPC가 거절되면 이 사람은 전체 권한이 아니다(서버가 기준). */
async function loadShare(id) {
  const sb = await getClient();
  if (!sb || getMode() !== 'signedIn') return 'sample';
  const [people, link] = await Promise.all([
    sb.rpc('office_page_people', { p_page: id }),
    sb.from('office_shares').select('link_token, published, allow_index').eq('page_id', id).eq('principal_kind', 'link').maybeSingle(),
  ]);
  if (people.error) return 'denied';
  return { people: people.data ?? [], link: link.data ?? null };
}

export function ShareDialog() {
  useLang();
  const { share } = useUi();
  const page = useStore((s) => s.pages.find((p) => p.id === share));
  const [tab, setTab] = useState('share');
  const [st, setSt] = useState(null);                          // null 불러오는 중 | 'sample' | 'denied' | { people, link }
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);
  // 바꿀 때마다 서버에서 다시 읽는다. 늦게 도착한 옛 응답이 새 상태를 덮지 않게 마지막 요청만 반영(9/27 실측: 역할 변경 뒤 게시가 꺼져 보임)
  const refresh = (id = share) => { const n = ++seq.current; return loadShare(id).then((v) => n === seq.current && setSt(v)).catch(() => n === seq.current && setSt('denied')); };
  useEffect(() => {
    if (!share) return undefined;
    setTab('share'); setEmail(''); setSt(null);
    refresh(share);
    return () => { seq.current++; };                          // 창을 닫거나 바꾸면 진행 중 응답을 버린다
  }, [share]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!page) return null;
  const sp = SPACES.find((s) => s.key === page.space);
  const isOrg = sp?.kind === 'org';
  const pageUrl = `${location.origin}${baseOf(page.space)}/p/${page.id}`;
  const pubUrl = st?.link?.link_token ? `${location.origin}/s/${st.link.link_token}` : '';
  const can = st && typeof st === 'object';
  const call = async (fn, args) => {
    setBusy(true);
    try { const sb = await getClient(); const { data, error } = await sb.rpc(fn, args); if (error) throw error; return { data }; }
    catch { showToast(t('share.failed')); return null; }
    finally { setBusy(false); }
  };
  const invite = async () => {
    const q = email.trim().toLowerCase();
    if (!q) return;
    const found = await call('msgr_find_user', { q });
    if (!found) return;
    const u = (found.data ?? []).find((x) => q.includes('@') || x.handle === q);  // 아이디는 앞부분이 아니라 정확히 같을 때만
    if (!u) { showToast(t('share.notFound')); return; }
    if (await call('office_share_set', { p_page: page.id, p_user: u.user_id, p_role: 'view' })) { setEmail(''); refresh(); }
  };
  const setRole = async (userId, role) => { if (await call('office_share_set', { p_page: page.id, p_user: userId, p_role: role || null })) refresh(); };
  const setGeneral = async (g) => {
    if (await call('office_page_set_general', { p_page: page.id, p_general: g })) update((s) => ({ pages: s.pages.map((p) => (p.id === page.id ? { ...p, general: g } : p)) }));
  };
  const publish = async (on) => { if (await call('office_page_publish', { p_page: page.id, p_on: on })) refresh(); };
  const setIndex = async (on) => { if (await call('office_page_set_index', { p_page: page.id, p_on: on })) refresh(); };
  const copy = async (url) => { try { await navigator.clipboard.writeText(url); showToast(t('page.linkCopied')); } catch { showToast(url); } };
  const roleSelect = (value, onChange) => (
    <select className="select" value={value} disabled={busy} onChange={(e) => onChange(e.target.value)}>
      {['full', 'edit', 'view'].map((r) => <option key={r} value={r}>{t(`share.role.${r}`)}</option>)}
      <option value="">{t('share.remove')}</option>
    </select>
  );
  const note = st === 'sample' ? t('share.sample') : st === 'denied' ? t('share.readOnly') : null;
  return (
    <Modal open onClose={() => setUi({ share: null })} title={page.title || t('page.untitled')} width={520}
      footer={<><button type="button" className="btn ghost" onClick={() => copy(pageUrl)}><Icon name="link" size={14} />{t('share.copy')}</button><button type="button" className="btn primary" onClick={() => setUi({ share: null })}>{t('close')}</button></>}>
      <div className="tabs" role="tablist">
        {['share', 'publish'].map((k) => <button key={k} type="button" role="tab" aria-selected={tab === k} className={`tab${tab === k ? ' on' : ''}`} onClick={() => setTab(k)}>{t(k === 'share' ? 'share.title' : 'share.publish')}</button>)}
      </div>
      {note && <p className="dim small share-note"><Icon name="lock" size={12} /> {note}</p>}
      {!st && <div className="share skeleton-lines" aria-busy="true"><span /><span /></div>}
      {can && (tab === 'share' ? <div className="share">
        <div className="invite"><input className="input" value={email} placeholder={t('share.invitePh')} onChange={(e) => setEmail(e.target.value)} {...imeGuardWith((e) => { if (e.key === 'Enter') invite(); })} /><button type="button" className="btn primary" disabled={busy || !email.trim()} onClick={invite}>{t('share.invite')}</button></div>
        <div className="people">
          <div className="person"><span className="avatar">{ME.name[0]}</span><span className="person-main"><b>{ME.name} ({t('share.you')})</b><small>{ME.email}</small></span><span className="dim small">{t('share.role.full')}</span></div>
          {st.people.filter((p) => p.user_id !== ME.id).map((p) => <div key={p.user_id} className="person"><span className="avatar">{(p.name || '?')[0]}</span><span className="person-main"><b>{p.name}</b></span>{roleSelect(p.role, (r) => setRole(p.user_id, r))}</div>)}
        </div>
        <div className="field-block">
          <span className="label">{t('share.general')}</span>
          <div className="general">
            <Icon name={page.general === 'invited' || !isOrg ? 'lock' : 'person'} />
            {isOrg ? <select className="select grow" value={page.general ?? 'org_edit'} disabled={busy} onChange={(e) => setGeneral(e.target.value)}>
              <option value="invited">{t('share.g.invited')}</option>
              <option value="org_view">{t('share.g.org', { org: sp.name })}</option>
              <option value="org_edit">{t('share.g.orgEdit', { org: sp.name })}</option>
            </select> : <span className="grow">{t('share.g.invited')}</span>}
          </div>
        </div>
      </div> : <div className="share">
        <label className="switch-row"><span><b>{t('share.pubOn')}</b><small>{t('share.pubDesc')}</small></span><input type="checkbox" role="switch" disabled={busy} checked={!!st.link?.published} onChange={(e) => publish(e.target.checked)} /></label>
        {st.link?.published && <>
          <div className="url-row"><Icon name="globe" size={14} /><a href={pubUrl} target="_blank" rel="noopener">{pubUrl}</a><button type="button" className="btn sm" onClick={() => copy(pubUrl)}>{t('share.copy')}</button></div>
          <label className="switch-row"><span><b>{t('share.index')}</b></span><input type="checkbox" role="switch" disabled={busy} checked={!!st.link.allow_index} onChange={(e) => setIndex(e.target.checked)} /></label>
          {isOrg && <p className="dim small"><Icon name="layout" size={12} /> {t('share.logo', { org: sp.name })}</p>}
          <p className="dim small"><Icon name="lock" size={12} /> {t('share.hidden')}</p>
        </>}
      </div>)}
    </Modal>
  );
}

const TASKS = ['summary', 'todos', 'reply', 'custom'];

export function AssignSheet() {
  useLang();
  const { assign: a } = useUi();
  const [crew, setCrew] = useState(null);
  const [task, setTask] = useState('summary');
  const [text, setText] = useState('');
  useEffect(() => { if (a) { setCrew(a.crew ?? null); setTask(a.items?.some((i) => i.kind === 'mail') ? 'summary' : 'custom'); setText(''); } }, [a]);
  const label = useMemo(() => a?.items?.map((i) => i.label).filter(Boolean).join(', ') ?? '', [a]);
  if (!a) return null;
  const hasMail = a.items.some((i) => i.kind === 'mail');
  const close = () => setUi({ assign: null });
  const go = () => {
    const c = CREWS.find((x) => x.id === crew);
    assign({ space: a.space === 'me' ? 'beyondworks' : a.space, crew, goal: task === 'custom' ? (text || label) : `${t(`crew.task.${task}`)} · ${label}` });
    close(); showToast(t('crew.handed', { crew: c.name }));
  };
  return (
    <Sheet open onClose={close} title={t('crew.assign')}
      footer={<><button type="button" className="btn" onClick={close}>{t('cancel')}</button><button type="button" className="btn primary" disabled={!crew || (task === 'custom' && !text.trim() && !label)} onClick={go}><Icon name="hand" size={14} />{t('crew.go')}</button></>}>
      {a.items.length > 0 && <div className="assign-items">{a.items.map((i) => <span key={`${i.kind}-${i.id}`} className="chip"><Icon name={{ mail: 'mail', page: 'doc', file: 'file', record: 'run' }[i.kind]} size={12} />{i.label}</span>)}</div>}
      <div className="field-block"><span className="label">{t('nav.crews')}</span>
        <div className="crew-pick">{CREWS.map((c) => <button key={c.id} type="button" className={`crew-opt${crew === c.id ? ' on' : ''}`} aria-pressed={crew === c.id} onClick={() => setCrew(c.id)}><Face id={c.id} size={26} /><b>{c.name}</b><small>{c.role}</small></button>)}</div>
      </div>
      <div className="field-block"><span className="label">{t('crew.what')}</span>
        <div className="seg">{TASKS.filter((k) => hasMail || k !== 'reply').map((k) => <button key={k} type="button" className={`seg-btn${task === k ? ' on' : ''}`} aria-pressed={task === k} onClick={() => setTask(k)}>{t(`crew.task.${k}`)}</button>)}</div>
        {task === 'custom' && <textarea className="input area" rows={4} value={text} placeholder={t('crew.customPh')} onChange={(e) => setText(e.target.value)} />}
      </div>
      <p className="data-note"><Icon name="lock" size={12} />{t('crew.dataNote')}</p>
    </Sheet>
  );
}
