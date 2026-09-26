// 공유·게시 창과 "크루에게 맡기기" 창.
import { useEffect, useMemo, useState } from 'react';
import { Modal, Sheet, showToast } from './Overlay.jsx';
import { Icon } from './Icon.jsx';
import { Face } from './Face.jsx';
import { t, useLang } from '../core/i18n.js';
import { useUi, setUi } from '../core/ui-state.js';
import { useStore, assign } from '../core/store.js';
import { imeGuardWith } from '../core/ime.js';
import { CREWS, PEOPLE } from '../data/sample.js';
import { SPACES, ME } from '../core/session.js';

export function ShareDialog() {
  useLang();
  const { share } = useUi();
  const page = useStore((s) => s.pages.find((p) => p.id === share));
  const [tab, setTab] = useState('share');
  const [general, setGeneral] = useState('org');
  const [people, setPeople] = useState([]);
  const [email, setEmail] = useState('');
  const [pub, setPub] = useState(false);
  const [index, setIndex] = useState(false);
  useEffect(() => { if (share) { setTab('share'); setPeople(PEOPLE.slice(0, 1)); setPub(false); setIndex(false); setGeneral(page?.space === 'me' ? 'invited' : 'org'); } }, [share]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!page) return null;
  const org = SPACES.find((s) => s.key === page.space);
  const orgName = org?.kind === 'org' ? org.name : 'Beyondworks';
  const url = `${location.origin}/s/${page.id.slice(0, 8)}`;
  const invite = () => { if (!email.trim()) return; setPeople((p) => [...p, { name: email.split('@')[0], email, role: 'view' }]); setEmail(''); };
  const copy = async () => { try { await navigator.clipboard.writeText(url); } catch { /* 권한 없음 */ } showToast(t('page.linkCopied')); };
  const role = (value, onChange) => (
    <select className="select" value={value} onChange={(e) => onChange(e.target.value)}>
      {['full', 'edit', 'view'].map((r) => <option key={r} value={r}>{t(`share.role.${r}`)}</option>)}
    </select>
  );
  return (
    <Modal open onClose={() => setUi({ share: null })} title={page.title || t('page.untitled')} width={520}
      footer={<><button type="button" className="btn ghost" onClick={copy}><Icon name="link" size={14} />{t('share.copy')}</button><button type="button" className="btn primary" onClick={() => setUi({ share: null })}>{t('close')}</button></>}>
      <div className="tabs" role="tablist">
        {['share', 'publish'].map((k) => <button key={k} type="button" role="tab" aria-selected={tab === k} className={`tab${tab === k ? ' on' : ''}`} onClick={() => setTab(k)}>{t(k === 'share' ? 'share.title' : 'share.publish')}</button>)}
      </div>
      {tab === 'share' ? <div className="share">
        <div className="invite"><input className="input" value={email} placeholder={t('share.invitePh')} onChange={(e) => setEmail(e.target.value)} {...imeGuardWith((e) => { if (e.key === 'Enter') invite(); })} /><button type="button" className="btn primary" onClick={invite}>{t('share.invite')}</button></div>
        <div className="people">
          <div className="person"><span className="avatar">{ME.name[0]}</span><span className="person-main"><b>{ME.name} ({t('share.you')})</b><small>{ME.email}</small></span><span className="dim small">{t('share.role.full')}</span></div>
          {people.map((p, i) => <div key={p.email} className="person"><span className="avatar">{p.name[0]}</span><span className="person-main"><b>{p.name}</b><small>{p.email}</small></span>{role(p.role, (r) => setPeople((cur) => cur.map((x, j) => (j === i ? { ...x, role: r } : x))))}</div>)}
        </div>
        <div className="field-block">
          <span className="label">{t('share.general')}</span>
          <div className="general">
            <Icon name={general === 'link' ? 'globe' : general === 'org' ? 'person' : 'lock'} />
            <select className="select grow" value={general} onChange={(e) => setGeneral(e.target.value)}>
              <option value="invited">{t('share.g.invited')}</option>
              {org?.kind === 'org' && <option value="org">{t('share.g.org', { org: org.name })}</option>}
              <option value="link">{t('share.g.link')}</option>
            </select>
          </div>
        </div>
      </div> : <div className="share">
        <label className="switch-row"><span><b>{t('share.pubOn')}</b><small>{t('share.pubDesc')}</small></span><input type="checkbox" role="switch" checked={pub} onChange={(e) => setPub(e.target.checked)} /></label>
        {pub && <>
          <div className="url-row"><Icon name="globe" size={14} /><a href={`/s/${page.id}`} target="_blank" rel="noopener">{url}</a></div>
          <label className="switch-row"><span><b>{t('share.index')}</b></span><input type="checkbox" role="switch" checked={index} onChange={(e) => setIndex(e.target.checked)} /></label>
          <p className="dim small"><Icon name="layout" size={12} /> {t('share.logo', { org: orgName })}</p>
          <p className="dim small"><Icon name="lock" size={12} /> {t('share.hidden')}</p>
        </>}
      </div>}
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
