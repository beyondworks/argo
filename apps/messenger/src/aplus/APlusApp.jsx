// 메신저 축소판 A+ 셸(2026-10-19 유건 승인) — 내 에이전트 1:1 · 내 에이전트 회의방(라운드 2 고정) · 외부 봇(내 PC Argo가 부름) · 설정.
// 채널·조직·파견·사람 채팅은 이 셸에 없다(이번 범위 밖 — 서버도 막는다). 무료 계정은 Pro 안내만 보이고 서버를 쓰지 않는다(source.start를 부르지 않음).
// 자료는 source(실제 = source.mjs, 화면 시험 = fake.mjs)로만. 모든 문구는 사전(i18n.js 'ap.*'), 색은 globals.css 토큰만(graphite 기준).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLang } from '@argo/i18n';
import { t as tm } from '../i18n.js';
import { I } from '../icons.jsx';
import { accessOf, agentRows, togglePick, meetingDraftProblem, meetingView, botDraftProblem, botStatusOf, layoutOf, notOpenYet, MEETING_MAX, MEETING_MIN, MEETING_ROUNDS, TITLE_MAX, BOT_KINDS } from './model.mjs';
import './aplus.css';

function useWidth() {
  const [w, setW] = useState(() => (typeof window === 'undefined' ? 1280 : window.innerWidth));
  useEffect(() => { const on = () => setW(window.innerWidth); window.addEventListener('resize', on); return () => window.removeEventListener('resize', on); }, []);
  return w;
}
const initials = (name) => String(name || '?').trim().slice(0, 1).toUpperCase();
function Face({ name, size = 32, muted = false }) { return <span className={`ap-face${muted ? ' muted' : ''}`} style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }} aria-hidden="true">{initials(name)}</span>; }

/** 진입: 플랜 확인 → 무료면 안내, 확인 못 하면 다시 확인, Pro면 작업 화면. */
export default function APlusApp({ source, onSignOut, purchase = null, onStarted = null }) {
  const { lang, setLang } = useLang();
  const t = useCallback((k, v) => tm(k, lang, v), [lang]);
  const [access, setAccess] = useState('loading');
  const check = useCallback(() => { setAccess('loading'); source.plan().then((p) => setAccess(accessOf(p)), () => setAccess('unknown')); }, [source]);
  useEffect(() => { check(); }, [check]);
  if (access === 'loading') return <div className="ap-center"><span className="ap-muted">{t('ap.plan.checking')}</span></div>;
  if (access === 'free') return <FreeGate t={t} purchase={purchase} onRecheck={check} onSignOut={onSignOut} />;
  if (access === 'unknown') return <div className="ap-center"><div className="ap-gate"><h1>{t('ap.plan.unknown.title')}</h1><p>{t('ap.plan.unknown.body')}</p><div className="ap-row"><button type="button" className="btn btn-primary" onClick={check}>{t('ap.plan.recheck')}</button><button type="button" className="btn" onClick={onSignOut}>{t('ap.me.signOut')}</button></div></div></div>;
  return <Workspace source={source} t={t} lang={lang} setLang={setLang} onSignOut={onSignOut} onStarted={onStarted} />;
}

function FreeGate({ t, purchase, onRecheck, onSignOut }) {
  return (
    <div className="ap-center"><div className="ap-gate">
      <span className="ap-tag">Pro</span>
      <h1>{t('ap.free.title')}</h1>
      <p>{t('ap.free.body')}</p>
      <ul className="ap-list-plain"><li>{t('ap.free.f1')}</li><li>{t('ap.free.f2')}</li><li>{t('ap.free.f3')}</li></ul>
      {purchase?.url ? <a className="btn btn-primary" href={purchase.url} target="_blank" rel="noreferrer">{t('ap.free.upgrade')}</a> : <p className="ap-muted">{t('ap.free.auto')}</p>}
      <div className="ap-row"><button type="button" className="btn" onClick={onRecheck}>{t('ap.plan.recheck')}</button><button type="button" className="btn ap-ghost" onClick={onSignOut}>{t('ap.me.signOut')}</button></div>
    </div></div>
  );
}

const TABS = [['dm', 'memory'], ['meet', 'chat'], ['bots', 'node'], ['me', 'gear']];

function Workspace({ source, t, lang, setLang, onSignOut, onStarted }) {
  const width = useWidth(); const layout = layoutOf(width);
  const [tab, setTab] = useState('dm');
  const [online, setOnline] = useState(() => source.online());
  const [agents, setAgents] = useState(null); const [dms, setDms] = useState({}); const [loadErr, setLoadErr] = useState('');
  const [meetings, setMeetings] = useState(null); // null = 아직 안 읽음 | 'closed' | []
  const [bots, setBots] = useState(null);
  const [open, setOpen] = useState(null); // { kind: 'dm'|'meeting', roomId, agentId?, title? }
  const [sheet, setSheet] = useState(null); // 'meeting' | 'bot'
  const [toast, setToast] = useState('');
  useEffect(() => { let live = true; source.start?.().then(() => { if (live) onStarted?.(); }, () => {}); return () => { live = false; source.stop?.(); }; }, [source]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const on = () => setOnline(source.online()); window.addEventListener('online', on); window.addEventListener('offline', on); return () => { window.removeEventListener('online', on); window.removeEventListener('offline', on); }; }, [source]);
  const loadAgents = useCallback(() => { setLoadErr(''); Promise.all([source.agents(), source.dms()]).then(([a, d]) => { setAgents(a); setDms(d); }, () => setLoadErr(t('ap.load.failed'))); }, [source, t]);
  useEffect(() => { loadAgents(); }, [loadAgents]);
  const loadMeetings = useCallback(() => source.meetings().then(setMeetings, (e) => setMeetings(notOpenYet(e) ? 'closed' : 'error')), [source]);
  const loadBots = useCallback(() => source.bots().then(setBots, (e) => setBots(notOpenYet(e) ? 'closed' : 'error')), [source]);
  useEffect(() => { if (tab === 'meet' && meetings === null) loadMeetings(); if (tab === 'bots' && bots === null) loadBots(); }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps -- 탭을 처음 열 때 한 번
  useEffect(() => source.on('meeting', ({ roomId, run }) => setMeetings((list) => (Array.isArray(list) ? list.map((m) => (m.roomId === roomId ? { ...m, run } : m)) : list))), [source]);
  useEffect(() => { if (!toast) return undefined; const id = setTimeout(() => setToast(''), 3500); return () => clearTimeout(id); }, [toast]);
  const rows = useMemo(() => agentRows(agents ?? [], { uid: source.uid, rooms: dms }), [agents, dms, source.uid]);
  const nameOf = useCallback((id) => (agents ?? []).find((a) => a.id === id)?.display_name ?? '?', [agents]);
  const openDm = async (row) => {
    try { const roomId = row.roomId ?? await source.openDm(row.id); setOpen({ kind: 'dm', roomId, agentId: row.id }); setDms((d) => ({ ...d, [row.id]: { ...(d[row.id] ?? {}), roomId, unread: 0 } })); }
    catch { setToast(t('ap.load.failed')); }
  };
  const openMeeting = (m) => setOpen({ kind: 'meeting', roomId: m.roomId });
  const pickTab = (k) => { setTab(k); if (layout === 'phone') setOpen(null); };
  const meeting = open?.kind === 'meeting' && Array.isArray(meetings) ? meetings.find((m) => m.roomId === open.roomId) : null;

  const list = tab === 'dm' ? <AgentList t={t} rows={rows} loading={agents === null && !loadErr} err={loadErr} onRetry={loadAgents} openId={open?.kind === 'dm' ? open.agentId : null} onOpen={openDm} />
    : tab === 'meet' ? <MeetingList t={t} meetings={meetings} nameOf={nameOf} openId={open?.roomId} onOpen={openMeeting} onNew={() => setSheet('meeting')} onRetry={loadMeetings} canCreate={rows.filter((r) => !r.paused).length >= MEETING_MIN} />
      : tab === 'bots' ? <BotList t={t} bots={bots} onAdd={() => setSheet('bot')} onRetry={loadBots} />
        : <Settings t={t} lang={lang} setLang={setLang} onSignOut={onSignOut} />;
  const chat = open && (open.kind === 'dm'
    ? <Chat key={open.roomId} t={t} source={source} roomId={open.roomId} title={nameOf(open.agentId)} sub={rows.find((r) => r.id === open.agentId)?.role} paused={!!rows.find((r) => r.id === open.agentId)?.paused} nameOf={nameOf} online={online} onBack={layout === 'phone' ? () => setOpen(null) : null} />
    : meeting && <Chat key={open.roomId} t={t} source={source} roomId={open.roomId} title={meeting.title} meeting={meeting} nameOf={nameOf} online={online} onBack={layout === 'phone' ? () => setOpen(null) : null}
      onCancel={() => source.cancelMeeting(open.roomId).catch(() => setToast(t('ap.meet.cancelFailed')))} onRun={(run) => setMeetings((l) => l.map((m) => (m.roomId === open.roomId ? { ...m, run } : m)))} />);
  const sheets = <>
    {sheet === 'meeting' && <MeetingSheet t={t} rows={rows.filter((r) => !r.paused)} onClose={() => setSheet(null)} onCreate={async (draft) => { const roomId = await source.createMeeting(draft); setSheet(null); await loadMeetings(); setTab('meet'); setOpen({ kind: 'meeting', roomId }); }} />}
    {sheet === 'bot' && <BotSheet t={t} onClose={() => setSheet(null)} onAdd={async (draft) => { await source.addBot(draft); setSheet(null); setToast(t('ap.bots.added')); await loadBots(); }} />}
    {toast && <div className="ap-toast" role="status">{toast}</div>}
  </>;
  const banner = !online && <div className="ap-offline" role="status"><I name="nodeoff" size={14} />{t('ap.offline')}</div>;

  if (layout === 'phone') {
    return (
      <div className="ap-app phone">
        {banner}
        {chat || <>
          <header className="ap-head"><h1>{t(`ap.tab.${tab}`)}</h1>{tab === 'meet' && Array.isArray(meetings) && <button type="button" className="btn sm" onClick={() => setSheet('meeting')} disabled={rows.filter((r) => !r.paused).length < MEETING_MIN}><I name="plus" size={14} />{t('ap.meet.new')}</button>}{tab === 'bots' && Array.isArray(bots) && <button type="button" className="btn sm" onClick={() => setSheet('bot')}><I name="plus" size={14} />{t('ap.bots.add')}</button>}</header>
          <main className="ap-scroll">{list}</main>
          <nav className="ap-tabbar" aria-label={t('ap.nav')}>{TABS.map(([k, icon]) => <button key={k} type="button" className={tab === k ? 'on' : ''} aria-current={tab === k ? 'page' : undefined} onClick={() => pickTab(k)}><I name={icon} size={22} filled={tab === k} /><span>{t(`ap.tab.${k}`)}</span></button>)}</nav>
        </>}
        {sheets}
      </div>
    );
  }
  return (
    <div className="ap-app split">
      <aside className="ap-rail">
        <div className="ap-brand">Argo <span className="ap-muted">{t('ap.brand.sub')}</span></div>
        <nav className="ap-seg" aria-label={t('ap.nav')}>{TABS.slice(0, 3).map(([k, icon]) => <button key={k} type="button" className={tab === k ? 'on' : ''} aria-current={tab === k ? 'page' : undefined} onClick={() => pickTab(k)}><I name={icon} size={15} />{t(`ap.tab.${k}`)}</button>)}</nav>
        {tab === 'meet' && Array.isArray(meetings) && <button type="button" className="btn sm ap-railbtn" onClick={() => setSheet('meeting')} disabled={rows.filter((r) => !r.paused).length < MEETING_MIN}><I name="plus" size={14} />{t('ap.meet.new')}</button>}
        {tab === 'bots' && Array.isArray(bots) && <button type="button" className="btn sm ap-railbtn" onClick={() => setSheet('bot')}><I name="plus" size={14} />{t('ap.bots.add')}</button>}
        <div className="ap-scroll">{tab === 'me' ? null : list}</div>
        <button type="button" className={`ap-railfoot${tab === 'me' ? ' on' : ''}`} onClick={() => { setTab('me'); setOpen(null); }}><I name="gear" size={15} />{t('ap.tab.me')}</button>
      </aside>
      <section className="ap-main">
        {banner}
        {chat || (tab === 'me' ? <div className="ap-scroll ap-pad">{list}</div> : <Empty t={t} tab={tab} />)}
      </section>
      {sheets}
    </div>
  );
}

function Empty({ t, tab }) { return <div className="ap-center"><div className="ap-empty"><I name={tab === 'meet' ? 'chat' : tab === 'bots' ? 'node' : 'memory'} size={28} /><p>{t(`ap.empty.${tab}`)}</p></div></div>; }

function AgentList({ t, rows, loading, err, onRetry, openId, onOpen }) {
  if (err) return <div className="ap-note"><p>{err}</p><button type="button" className="btn sm" onClick={onRetry}><I name="retry" size={14} />{t('ap.retry')}</button></div>;
  if (loading) return <p className="ap-note ap-muted">{t('ap.loading')}</p>;
  if (!rows.length) return <div className="ap-note"><strong>{t('ap.dm.none.title')}</strong><p>{t('ap.dm.none.body')}</p></div>;
  return <ul className="ap-rows">{rows.map((r) => (
    <li key={r.id}><button type="button" className={`ap-rowbtn${openId === r.id ? ' on' : ''}`} onClick={() => onOpen(r)}>
      <Face name={r.name} muted={r.paused} />
      <span className="ap-rowtext"><span className="ap-rowname">{r.name}{r.paused && <span className="ap-pill">{t('ap.dm.paused')}</span>}</span><span className="ap-rowsub">{r.last || r.role || t('ap.dm.start')}</span></span>
      {r.unread > 0 && <span className="ap-badge" aria-label={t('ap.unread', { n: r.unread })}>{r.unread}</span>}
    </button></li>))}</ul>;
}

function MeetingList({ t, meetings, nameOf, openId, onOpen, onNew, onRetry, canCreate }) {
  if (meetings === null) return <p className="ap-note ap-muted">{t('ap.loading')}</p>;
  if (meetings === 'closed') return <div className="ap-note"><strong>{t('ap.closed.title')}</strong><p>{t('ap.closed.meet')}</p></div>;
  if (meetings === 'error') return <div className="ap-note"><p>{t('ap.load.failed')}</p><button type="button" className="btn sm" onClick={onRetry}><I name="retry" size={14} />{t('ap.retry')}</button></div>;
  if (!meetings.length) return <div className="ap-note"><strong>{t('ap.meet.none.title')}</strong><p>{t('ap.meet.none.body', { max: MEETING_MAX, rounds: MEETING_ROUNDS })}</p>{canCreate ? <button type="button" className="btn sm btn-primary" onClick={onNew}><I name="plus" size={14} />{t('ap.meet.new')}</button> : <p className="ap-muted">{t('ap.meet.problem.fewAgents', { min: MEETING_MIN })}</p>}</div>;
  return <ul className="ap-rows">{meetings.map((m) => { const v = meetingView(m.run); return (
    <li key={m.roomId}><button type="button" className={`ap-rowbtn${openId === m.roomId ? ' on' : ''}`} onClick={() => onOpen(m)}>
      <span className="ap-stack" aria-hidden="true">{m.agentIds.slice(0, 3).map((id) => <Face key={id} name={nameOf(id)} size={22} />)}</span>
      <span className="ap-rowtext"><span className="ap-rowname">{m.title}</span><span className="ap-rowsub">{v.state === 'idle' ? t('ap.meet.members', { n: m.agentIds.length }) : t(`ap.run.${v.state}`, { round: v.round, rounds: v.rounds })}</span></span>
      {v.state === 'running' && <span className="ap-dot live" aria-hidden="true" />}
    </button></li>); })}</ul>;
}

function BotList({ t, bots, onAdd, onRetry }) {
  if (bots === null) return <p className="ap-note ap-muted">{t('ap.loading')}</p>;
  if (bots === 'closed') return <div className="ap-note"><strong>{t('ap.closed.title')}</strong><p>{t('ap.closed.bots')}</p></div>;
  if (bots === 'error') return <div className="ap-note"><p>{t('ap.load.failed')}</p><button type="button" className="btn sm" onClick={onRetry}><I name="retry" size={14} />{t('ap.retry')}</button></div>;
  return <>
    <p className="ap-note ap-muted">{t('ap.bots.lead')}</p>
    {!bots.length ? <div className="ap-note"><strong>{t('ap.bots.none.title')}</strong><button type="button" className="btn sm btn-primary" onClick={onAdd}><I name="plus" size={14} />{t('ap.bots.add')}</button></div>
      : <ul className="ap-rows">{bots.map((b) => { const s = botStatusOf(b); return (
        <li key={b.id}><div className="ap-rowbtn static">
          <Face name={b.name} muted={s !== 'connected'} />
          <span className="ap-rowtext"><span className="ap-rowname">{b.name}</span><span className={`ap-status ${s}`}><span className="ap-dot" aria-hidden="true" />{t(`ap.bots.status.${s}`)}<span className="ap-muted"> · {t(`ap.bots.kind.${b.kind}`)}</span></span><span className="ap-rowsub ap-addr"><code>{b.address}</code></span></span>
        </div></li>); })}</ul>}
  </>;
}

function Settings({ t, lang, setLang, onSignOut }) {
  return <div className="ap-settings">
    <section><h2>{t('ap.me.lang')}</h2><div className="ap-seg small">{['ko', 'en'].map((l) => <button key={l} type="button" className={lang === l ? 'on' : ''} onClick={() => setLang(l)}>{l === 'ko' ? '한국어' : 'English'}</button>)}</div></section>
    <section><h2>{t('ap.me.scope')}</h2><p className="ap-muted">{t('ap.me.scope.body')}</p></section>
    <section><button type="button" className="btn" onClick={onSignOut}>{t('ap.me.signOut')}</button></section>
  </div>;
}

function Chat({ t, source, roomId, title, sub, paused = false, meeting = null, nameOf, online, onBack, onCancel, onRun }) {
  const [msgs, setMsgs] = useState(null); const [err, setErr] = useState('');
  const [draft, setDraft] = useState(''); const [sending, setSending] = useState(false);
  const endRef = useRef(null);
  const load = useCallback(() => { setErr(''); source.messages(roomId).then(setMsgs, () => setErr(t('ap.load.failed'))); }, [source, roomId, t]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => source.on('messages', (e) => { if (e.roomId !== roomId) return; setMsgs((cur) => { const have = new Set((cur ?? []).map((m) => m.id)); return [...(cur ?? []), ...e.messages.filter((m) => !have.has(m.id))]; }); }), [source, roomId]);
  useEffect(() => source.on('meeting', (e) => { if (e.roomId === roomId) onRun?.(e.run); }), [source, roomId, onRun]);
  useEffect(() => { endRef.current?.scrollIntoView?.({ block: 'end' }); }, [msgs]);
  const v = meetingView(meeting?.run);
  const blocked = paused ? t('ap.chat.paused') : !v.canSend ? t('ap.chat.meetingBusy') : '';
  const send = async () => {
    const body = draft.trim(); if (!body || blocked || sending) return;
    setSending(true);
    try { const r = await source.send(roomId, body); if (r?.ok === false) setErr(t('ap.chat.sendFailed')); else setDraft(''); } finally { setSending(false); }
  };
  return (
    <div className="ap-chat">
      <header className="ap-chathead">
        {onBack && <button type="button" className="ap-iconbtn" onClick={onBack} aria-label={t('ap.back')}><I name="back" size={20} /></button>}
        {meeting ? <span className="ap-stack" aria-hidden="true">{meeting.agentIds.slice(0, 3).map((id) => <Face key={id} name={nameOf(id)} size={24} />)}</span> : <Face name={title} muted={paused} />}
        <div className="ap-chattitle"><strong>{title}</strong><span className="ap-muted">{meeting ? meeting.agentIds.map(nameOf).join(', ') : sub}</span></div>
      </header>
      {meeting && <div className={`ap-run ${v.state}`} role="status">
        <span className="ap-runlabel">{v.state === 'idle' ? t('ap.run.idle', { rounds: MEETING_ROUNDS }) : t(`ap.run.${v.state}`, { round: v.round, rounds: v.rounds })}</span>
        {v.state === 'running' && <span className="ap-runcount">{t('ap.run.answered', { n: v.answered, total: v.total })}</span>}
        {v.state !== 'idle' && <span className="ap-steps" aria-hidden="true">{Array.from({ length: v.rounds }, (_, i) => <span key={i} className={i + 1 < v.round || v.state === 'done' ? 'done' : i + 1 === v.round && v.state === 'running' ? 'now' : ''} />)}</span>}
        {v.canCancel && <button type="button" className="btn sm ap-danger" onClick={onCancel}>{t('ap.run.cancel')}</button>}
      </div>}
      <div className="ap-msgs">
        {err && <div className="ap-note"><p>{err}</p><button type="button" className="btn sm" onClick={load}><I name="retry" size={14} />{t('ap.retry')}</button></div>}
        {msgs === null && !err && <p className="ap-note ap-muted">{t('ap.loading')}</p>}
        {msgs && !msgs.length && <p className="ap-note ap-muted">{meeting ? t('ap.chat.emptyMeeting', { rounds: MEETING_ROUNDS }) : t('ap.chat.empty', { name: title })}</p>}
        {msgs?.map((m) => m.author === 'me'
          ? <div key={m.id} className="ap-msg me"><div className="ap-bubble">{m.body}</div></div>
          : <div key={m.id} className="ap-msg"><Face name={nameOf(m.author)} size={28} /><div><div className="ap-msgname">{nameOf(m.author)}{m.round && meeting ? <span className="ap-pill">{t('ap.run.roundTag', { round: m.round })}</span> : null}</div><div className="ap-bubble">{m.body}</div></div></div>)}
        <div ref={endRef} />
      </div>
      <footer className="ap-composer">
        {blocked && <p className="ap-muted ap-blocked">{blocked}</p>}
        <div className="ap-inputrow">
          <textarea rows={1} value={draft} disabled={!!blocked} placeholder={meeting ? t('ap.chat.placeholderMeeting') : t('ap.chat.placeholder', { name: title })} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }} aria-label={t('ap.chat.input')} />
          <button type="button" className="ap-send" onClick={send} disabled={!draft.trim() || !!blocked || sending} aria-label={t('ap.chat.send')}><I name="up" size={18} /></button>
        </div>
        {!online && <p className="ap-muted ap-blocked">{t('ap.chat.offline')}</p>}
      </footer>
    </div>
  );
}

function Sheet({ title, onClose, children, t }) {
  useEffect(() => { const on = (e) => { if (e.key === 'Escape') onClose(); }; window.addEventListener('keydown', on); return () => window.removeEventListener('keydown', on); }, [onClose]);
  return <div className="ap-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}><div className="ap-sheet" role="dialog" aria-modal="true" aria-label={title}>
    <header><h2>{title}</h2><button type="button" className="ap-iconbtn" onClick={onClose} aria-label={t('ap.close')}><I name="x" size={18} /></button></header>{children}</div></div>;
}

function MeetingSheet({ t, rows, onClose, onCreate }) {
  const [title, setTitle] = useState(''); const [picked, setPicked] = useState([]); const [capped, setCapped] = useState(false);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const problem = meetingDraftProblem({ title, picked, available: rows.length });
  const create = async () => { if (problem || busy) return; setBusy(true); setErr(''); try { await onCreate({ title: title.trim(), agentIds: picked }); } catch (e) { setErr(notOpenYet(e) ? t('ap.closed.meet') : t('ap.meet.createFailed')); } finally { setBusy(false); } };
  return <Sheet title={t('ap.meet.new')} onClose={onClose} t={t}>
    <div className="ap-form">
      <label className="ap-field"><span>{t('ap.meet.title')}</span><input value={title} maxLength={TITLE_MAX} onChange={(e) => setTitle(e.target.value)} placeholder={t('ap.meet.titlePh')} /></label>
      <div className="ap-field"><span>{t('ap.meet.pick', { n: picked.length, max: MEETING_MAX })}</span>
        <ul className="ap-picks">{rows.map((r) => { const on = picked.includes(r.id); const full = !on && picked.length >= MEETING_MAX; return (
          <li key={r.id}><label className={`ap-pick${on ? ' on' : ''}${full ? ' off' : ''}`}><input type="checkbox" checked={on} disabled={full} onChange={() => { const x = togglePick(picked, r.id); setPicked(x.picked); setCapped(x.capped); }} /><Face name={r.name} size={24} /><span className="ap-rowtext"><span className="ap-rowname">{r.name}</span><span className="ap-rowsub">{r.role}</span></span></label></li>); })}</ul>
        {(capped || picked.length >= MEETING_MAX) && <p className="ap-muted">{t('ap.meet.problem.max', { max: MEETING_MAX })}</p>}
      </div>
      <p className="ap-hint"><I name="clock" size={14} />{t('ap.meet.rounds', { rounds: MEETING_ROUNDS })}</p>
      <p className="ap-hint"><I name="person" size={14} />{t('ap.meet.onlyMe')}</p>
      {problem && problem !== 'title' && problem !== 'min' && <p className="ap-error">{t(`ap.meet.problem.${problem}`, { min: MEETING_MIN, max: MEETING_MAX, n: TITLE_MAX })}</p>}
      {err && <p className="ap-error">{err}</p>}
      <div className="ap-row end"><button type="button" className="btn" onClick={onClose}>{t('ap.cancel')}</button><button type="button" className="btn btn-primary" disabled={!!problem || busy} onClick={create}>{busy ? t('ap.working') : t('ap.meet.create')}</button></div>
    </div>
  </Sheet>;
}

function BotSheet({ t, onClose, onAdd }) {
  const [kind, setKind] = useState(BOT_KINDS[0]); const [name, setName] = useState(''); const [address, setAddress] = useState('');
  const [touched, setTouched] = useState(false); const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const problem = botDraftProblem({ kind, name, address });
  const addrProblem = problem?.startsWith('addr.') && address.trim() ? problem : null;
  const add = async () => { setTouched(true); if (problem || busy) return; setBusy(true); setErr(''); try { await onAdd({ kind, name: name.trim(), address: address.trim() }); } catch (e) { setErr(notOpenYet(e) ? t('ap.closed.bots') : t('ap.bots.addFailed')); } finally { setBusy(false); } };
  return <Sheet title={t('ap.bots.add')} onClose={onClose} t={t}>
    <div className="ap-form">
      <div className="ap-field"><span>{t('ap.bots.kind')}</span><div className="ap-seg small">{BOT_KINDS.map((k) => <button key={k} type="button" className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>{t(`ap.bots.kind.${k}`)}</button>)}</div></div>
      <label className="ap-field"><span>{t('ap.bots.name')}</span><input value={name} maxLength={40} onChange={(e) => setName(e.target.value)} placeholder={t('ap.bots.namePh')} /></label>
      <label className="ap-field"><span>{t('ap.bots.address')}</span><input value={address} inputMode="url" autoCapitalize="off" autoCorrect="off" spellCheck={false} onChange={(e) => setAddress(e.target.value)} onBlur={() => setTouched(true)} placeholder={kind === 'hermes' ? 'http://127.0.0.1:8642' : 'http://127.0.0.1:18789'} /></label>
      {(touched || addrProblem) && problem?.startsWith('addr.') ? <p className="ap-error">{t(`ap.bots.problem.${problem}`)}</p> : <p className="ap-hint"><I name="lock" size={14} />{t('ap.bots.addrRule')}</p>}
      <div className="ap-callout"><I name="lock" size={16} /><div><strong>{t('ap.bots.key.title')}</strong><p>{t('ap.bots.key.body')}</p></div></div>
      {err && <p className="ap-error">{err}</p>}
      <div className="ap-row end"><button type="button" className="btn" onClick={onClose}>{t('ap.cancel')}</button><button type="button" className="btn btn-primary" disabled={busy || (touched && !!problem)} onClick={add}>{busy ? t('ap.working') : t('ap.bots.addDo')}</button></div>
    </div>
  </Sheet>;
}
