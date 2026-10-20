// 메신저 축소판 A+ 셸(2026-10-19 유건 승인) — 내 에이전트 1:1 · 내 에이전트 회의방(라운드 2 고정) · 외부 봇(내 PC Argo가 부름) · 설정.
// 사람 탭(2026-10-20 유건: 사람 채팅까지 넣고 한 번에 공개)은 People.jsx — 팀 공간·채널·사람 1:1·초대·멤버. 조직·파견은 이 셸에 없다.
// 무료 계정은 Pro 안내만 보이고 서버를 쓰지 않는다(source.start를 부르지 않음). 첨부는 사람 글·에이전트 글 모두(기계 send files).
// 자료는 source(실제 = source.mjs, 화면 시험 = fake.mjs)로만. 모든 문구는 사전(i18n.js 'aplus.*'), 색은 globals.css 토큰만(graphite 기준).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLang } from '@argo/i18n';
import { t as tm } from '../i18n.js';
import { I } from '../icons.jsx';
import { accessOf, agentRows, togglePick, meetingDraftProblem, meetingView, meetingPickable, deriveRun, errorKey, limitKey, botStatusOf, layoutOf, notOpenYet, MEETING_MAX, MEETING_MIN, MEETING_ROUNDS, TITLE_MAX, BOT_KINDS } from './model.mjs';
import { usePeople, PeopleList, PeopleActions, PeopleSheets } from './People.jsx';
import { addFiles, canSend, toUpload, formatBytes, fileIcon, isImage, legacyRoom, peopleErrorKey, createReadMarker } from './people.mjs';
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
  if (access === 'loading') return <div className="ap-center"><span className="ap-muted">{t('aplus.plan.checking')}</span></div>;
  if (access === 'free') return <FreeGate t={t} purchase={purchase} onRecheck={check} onSignOut={onSignOut} />;
  if (access === 'unknown') return <div className="ap-center"><div className="ap-gate"><h1>{t('aplus.plan.unknown.title')}</h1><p>{t('aplus.plan.unknown.body')}</p><div className="ap-row"><button type="button" className="btn btn-primary" onClick={check}>{t('aplus.plan.recheck')}</button><button type="button" className="btn" onClick={onSignOut}>{t('aplus.me.signOut')}</button></div></div></div>;
  return <Workspace source={source} t={t} lang={lang} setLang={setLang} onSignOut={onSignOut} onStarted={onStarted} purchase={purchase} />;
}

function FreeGate({ t, purchase, onRecheck, onSignOut }) {
  return (
    <div className="ap-center"><div className="ap-gate">
      <span className="ap-tag">Pro</span>
      <h1>{t('aplus.free.title')}</h1>
      <p>{t('aplus.free.body')}</p>
      <ul className="ap-list-plain"><li>{t('aplus.free.f1')}</li><li>{t('aplus.free.f2')}</li><li>{t('people.free.f4')}</li><li>{t('aplus.free.f3')}</li></ul>
      {purchase?.url ? <a className="btn btn-primary" href={purchase.url} target="_blank" rel="noreferrer">{t('aplus.free.upgrade')}</a> : <p className="ap-muted">{t('aplus.free.auto')}</p>}
      <div className="ap-row"><button type="button" className="btn" onClick={onRecheck}>{t('aplus.plan.recheck')}</button><button type="button" className="btn ap-ghost" onClick={onSignOut}>{t('aplus.me.signOut')}</button></div>
    </div></div>
  );
}

const TABS = [['dm', 'memory'], ['meet', 'chat'], ['people', 'person'], ['bots', 'node'], ['me', 'gear']];

function Workspace({ source, t, lang, setLang, onSignOut, onStarted, purchase }) {
  const width = useWidth(); const layout = layoutOf(width);
  const [tab, setTab] = useState('dm');
  const [online, setOnline] = useState(() => source.online());
  const [agents, setAgents] = useState(null); const [dms, setDms] = useState({}); const [loadErr, setLoadErr] = useState('');
  const [meetings, setMeetings] = useState(null); // null = 아직 안 읽음 | 'closed' | []
  const [bots, setBots] = useState(null);
  const [open, setOpen] = useState(null); // { kind: 'dm'|'meeting'|'room', roomId, agentId?, title? } — room = 사람 탭의 채널·사람 1:1
  const [sheet, setSheet] = useState(null); // 'meeting' | 'bot'
  const [psheet, setPsheet] = useState(null); // 사람 탭 시트(People.jsx)
  const people = usePeople({ source, active: tab === 'people' });
  const [toast, setToast] = useState('');
  useEffect(() => { let live = true; source.start?.().then(() => { if (live) onStarted?.(); }, () => {}); return () => { live = false; source.stop?.(); }; }, [source]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const on = () => setOnline(source.online()); window.addEventListener('online', on); window.addEventListener('offline', on); return () => { window.removeEventListener('online', on); window.removeEventListener('offline', on); }; }, [source]);
  const loadAgents = useCallback(() => { setLoadErr(''); source.retry?.(); Promise.all([source.agents(), source.dms()]).then(([a, d]) => { setAgents(a); setDms(d); }, () => setLoadErr(t('aplus.load.failed'))); }, [source, t]);
  useEffect(() => { loadAgents(); }, [loadAgents]);
  const loadMeetings = useCallback(() => source.meetings().then(setMeetings, (e) => setMeetings(notOpenYet(e) ? 'closed' : 'error')), [source]);
  const loadBots = useCallback(() => source.bots().then(setBots, (e) => setBots(notOpenYet(e) ? 'closed' : 'error')), [source]);
  useEffect(() => { if (tab === 'meet' && meetings === null) loadMeetings(); if (tab === 'bots' && bots === null) loadBots(); }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps -- 탭을 처음 열 때 한 번
  useEffect(() => source.on('meeting', ({ roomId, run }) => setMeetings((list) => (Array.isArray(list) ? list.map((m) => (m.roomId === roomId ? { ...m, run } : m)) : list))), [source]);
  useEffect(() => { if (!toast) return undefined; const id = setTimeout(() => setToast(''), 3500); return () => clearTimeout(id); }, [toast]);
  const rows = useMemo(() => agentRows(agents ?? [], { uid: source.uid, rooms: dms }), [agents, dms, source.uid]);
  const nameOf = useCallback((id) => (agents ?? []).find((a) => a.id === id)?.display_name ?? (people.data?.agents ?? []).find((a) => a.id === id)?.display_name ?? people.names[id] ?? '?', [agents, people.data, people.names]);
  const openDm = async (row) => {
    try { const roomId = row.roomId ?? await source.openDm(row.id); setOpen({ kind: 'dm', roomId, agentId: row.id }); setDms((d) => ({ ...d, [row.id]: { ...(d[row.id] ?? {}), roomId, unread: 0 } })); }
    catch { setToast(t('aplus.load.failed')); }
  };
  const openMeeting = (m) => setOpen({ kind: 'meeting', roomId: m.roomId });
  const pickTab = (k) => { setTab(k); if (layout === 'phone') setOpen(null); };
  const meeting = open?.kind === 'meeting' && Array.isArray(meetings) ? meetings.find((m) => m.roomId === open.roomId) : null;

  const room = open?.kind === 'room' ? [...people.rows.channels, ...people.rows.dms].find((r) => r.id === open.roomId) ?? null : null;
  const list = tab === 'people' ? <PeopleList t={t} p={people} openId={open?.kind === 'room' ? open.roomId : null} onOpen={setOpen} onSheet={setPsheet} purchase={purchase} />
    : tab === 'dm' ? <AgentList t={t} rows={rows} loading={agents === null && !loadErr} err={loadErr} onRetry={loadAgents} openId={open?.kind === 'dm' ? open.agentId : null} onOpen={openDm} />
    : tab === 'meet' ? <MeetingList t={t} meetings={meetings} nameOf={nameOf} openId={open?.roomId} onOpen={openMeeting} onNew={() => setSheet('meeting')} onRetry={loadMeetings} canCreate={rows.filter(meetingPickable).length >= MEETING_MIN} />
      : tab === 'bots' ? <BotList t={t} bots={bots} onAdd={() => setSheet('bot')} onRetry={loadBots} />
        : <Settings t={t} lang={lang} setLang={setLang} onSignOut={onSignOut} />;
  const chat = open && (open.kind === 'room' ? (room && <Chat key={open.roomId} t={t} source={source} roomId={open.roomId} title={room.kind === 'channel' ? `#${room.name}` : room.name} sub={room.kind === 'channel' ? t('people.members.n', { n: room.count }) : people.space?.name} person={room} nameOf={nameOf} online={online} onBack={layout === 'phone' ? () => setOpen(null) : null} onMembers={() => setPsheet({ kind: 'members' })} />)
    : open.kind === 'dm'
    ? <Chat key={open.roomId} t={t} source={source} roomId={open.roomId} title={nameOf(open.agentId)} sub={rows.find((r) => r.id === open.agentId)?.role} paused={!!rows.find((r) => r.id === open.agentId)?.paused} nameOf={nameOf} online={online} onBack={layout === 'phone' ? () => setOpen(null) : null} />
    : meeting && <Chat key={open.roomId} t={t} source={source} roomId={open.roomId} title={meeting.title} meeting={meeting} nameOf={nameOf} online={online} onBack={layout === 'phone' ? () => setOpen(null) : null}
      onCancel={() => source.cancelMeeting(open.roomId).catch((e) => setToast(t(errorKey(e) ?? 'aplus.meet.cancelFailed')))} onRun={(run) => setMeetings((l) => l.map((m) => (m.roomId === open.roomId ? { ...m, run } : m)))} />);
  const sheets = <>
    {sheet === 'meeting' && <MeetingSheet t={t} rows={rows.filter(meetingPickable)} onClose={() => setSheet(null)} onCreate={async (draft) => { const roomId = await source.createMeeting(draft); setSheet(null); await loadMeetings(); setTab('meet'); setOpen({ kind: 'meeting', roomId }); }} />}
    {sheet === 'bot' && <BotGuide t={t} onClose={() => setSheet(null)} />}
    <PeopleSheets t={t} source={source} p={people} sheet={psheet} setSheet={setPsheet} onOpen={(o) => { setTab('people'); setOpen(o); }} setToast={setToast} />
    {toast && <div className="ap-toast" role="status">{toast}</div>}
  </>;
  const banner = !online && <div className="ap-offline" role="status"><I name="nodeoff" size={14} />{t('aplus.offline')}</div>;

  if (layout === 'phone') {
    return (
      <div className="ap-app phone">
        {banner}
        {chat || <>
          <header className="ap-head"><h1>{t(`aplus.tab.${tab}`)}</h1>{tab === 'meet' && Array.isArray(meetings) && <button type="button" className="btn sm" onClick={() => setSheet('meeting')} disabled={rows.filter(meetingPickable).length < MEETING_MIN}><I name="plus" size={14} />{t('aplus.meet.new')}</button>}{tab === 'bots' && Array.isArray(bots) && <button type="button" className="btn sm" onClick={() => setSheet('bot')}><I name="link" size={14} />{t('aplus.bots.howto')}</button>}{tab === 'people' && <span className="ap-row"><PeopleActions t={t} p={people} onSheet={setPsheet} cls="btn sm icononly-phone" /></span>}</header>
          <main className="ap-scroll">{list}</main>
          <nav className="ap-tabbar" aria-label={t('aplus.nav')}>{TABS.map(([k, icon]) => <button key={k} type="button" className={tab === k ? 'on' : ''} aria-current={tab === k ? 'page' : undefined} onClick={() => pickTab(k)}><I name={icon} size={22} filled={tab === k} /><span>{t(`aplus.tab.${k}`)}</span></button>)}</nav>
        </>}
        {sheets}
      </div>
    );
  }
  return (
    <div className="ap-app split">
      <aside className="ap-rail">
        <div className="ap-brand">Argo <span className="ap-muted">{t('aplus.brand.sub')}</span></div>
        <nav className="ap-seg" aria-label={t('aplus.nav')}>{TABS.slice(0, 4).map(([k, icon]) => <button key={k} type="button" className={tab === k ? 'on' : ''} aria-current={tab === k ? 'page' : undefined} onClick={() => pickTab(k)}><I name={icon} size={15} />{t(`aplus.tab.${k}`)}</button>)}</nav>
        {tab === 'meet' && Array.isArray(meetings) && <button type="button" className="btn sm ap-railbtn" onClick={() => setSheet('meeting')} disabled={rows.filter(meetingPickable).length < MEETING_MIN}><I name="plus" size={14} />{t('aplus.meet.new')}</button>}
        {tab === 'bots' && Array.isArray(bots) && <button type="button" className="btn sm ap-railbtn" onClick={() => setSheet('bot')}><I name="link" size={14} />{t('aplus.bots.howto')}</button>}
        {tab === 'people' && people.gate === 'open' && people.space && <div className="ap-row ap-railbtn"><PeopleActions t={t} p={people} onSheet={setPsheet} /></div>}
        <div className="ap-scroll">{tab === 'me' ? null : list}</div>
        <button type="button" className={`ap-railfoot${tab === 'me' ? ' on' : ''}`} onClick={() => { setTab('me'); setOpen(null); }}><I name="gear" size={15} />{t('aplus.tab.me')}</button>
      </aside>
      <section className="ap-main">
        {banner}
        {chat || (tab === 'me' ? <div className="ap-scroll ap-pad">{list}</div> : <Empty t={t} tab={tab} />)}
      </section>
      {sheets}
    </div>
  );
}

function Empty({ t, tab }) { return <div className="ap-center"><div className="ap-empty"><I name={tab === 'meet' ? 'chat' : tab === 'bots' ? 'node' : tab === 'people' ? 'person' : 'memory'} size={28} /><p>{t(`aplus.empty.${tab}`)}</p></div></div>; }

function AgentList({ t, rows, loading, err, onRetry, openId, onOpen }) {
  if (err) return <div className="ap-note"><p>{err}</p><button type="button" className="btn sm" onClick={onRetry}><I name="retry" size={14} />{t('aplus.retry')}</button></div>;
  if (loading) return <p className="ap-note ap-muted">{t('aplus.loading')}</p>;
  if (!rows.length) return <div className="ap-note"><strong>{t('aplus.dm.none.title')}</strong><p>{t('aplus.dm.none.body')}</p></div>;
  return <ul className="ap-rows">{rows.map((r) => (
    <li key={r.id}><button type="button" className={`ap-rowbtn${openId === r.id ? ' on' : ''}`} onClick={() => onOpen(r)}>
      <Face name={r.name} muted={r.paused} />
      <span className="ap-rowtext"><span className="ap-rowname">{r.name}{r.bot && <span className="ap-pill">{t('aplus.dm.bot')}</span>}{r.paused && <span className="ap-pill">{t('aplus.dm.paused')}</span>}</span><span className="ap-rowsub">{r.last || r.role || t('aplus.dm.start')}</span></span>
      {r.unread > 0 && <span className="ap-badge" aria-label={t('aplus.unread', { n: r.unread })}>{r.unread}</span>}
    </button></li>))}</ul>;
}

function MeetingList({ t, meetings, nameOf, openId, onOpen, onNew, onRetry, canCreate }) {
  if (meetings === null) return <p className="ap-note ap-muted">{t('aplus.loading')}</p>;
  if (meetings === 'closed') return <div className="ap-note"><strong>{t('aplus.closed.title')}</strong><p>{t('aplus.closed.meet')}</p></div>;
  if (meetings === 'error') return <div className="ap-note"><p>{t('aplus.load.failed')}</p><button type="button" className="btn sm" onClick={onRetry}><I name="retry" size={14} />{t('aplus.retry')}</button></div>;
  if (!meetings.length) return <div className="ap-note"><strong>{t('aplus.meet.none.title')}</strong><p>{t('aplus.meet.none.body', { max: MEETING_MAX, rounds: MEETING_ROUNDS })}</p>{canCreate ? <button type="button" className="btn sm btn-primary" onClick={onNew}><I name="plus" size={14} />{t('aplus.meet.new')}</button> : <p className="ap-muted">{t('aplus.meet.problem.fewAgents', { min: MEETING_MIN })}</p>}</div>;
  return <ul className="ap-rows">{meetings.map((m) => { const v = meetingView(m.run); return (
    <li key={m.roomId}><button type="button" className={`ap-rowbtn${openId === m.roomId ? ' on' : ''}`} onClick={() => onOpen(m)}>
      <span className="ap-stack" aria-hidden="true">{m.agentIds.slice(0, 3).map((id) => <Face key={id} name={nameOf(id)} size={22} />)}</span>
      <span className="ap-rowtext"><span className="ap-rowname">{m.title}</span><span className="ap-rowsub">{v.state === 'idle' ? t('aplus.meet.members', { n: m.agentIds.length }) : t(`aplus.run.${v.state}`, { round: v.round, rounds: v.rounds })}</span></span>
      {v.state === 'running' && <span className="ap-dot live" aria-hidden="true" />}
    </button></li>); })}</ul>;
}

function BotList({ t, bots, onAdd, onRetry }) {
  if (bots === null) return <p className="ap-note ap-muted">{t('aplus.loading')}</p>;
  if (bots === 'closed') return <div className="ap-note"><strong>{t('aplus.closed.title')}</strong><p>{t('aplus.closed.bots')}</p></div>;
  if (bots === 'error') return <div className="ap-note"><p>{t('aplus.load.failed')}</p><button type="button" className="btn sm" onClick={onRetry}><I name="retry" size={14} />{t('aplus.retry')}</button></div>;
  return <>
    <p className="ap-note ap-muted">{t('aplus.bots.lead')}</p>
    {!bots.length ? <div className="ap-note"><strong>{t('aplus.bots.none.title')}</strong><p>{t('aplus.bots.none.body')}</p><button type="button" className="btn sm btn-primary" onClick={onAdd}><I name="link" size={14} />{t('aplus.bots.howto')}</button></div>
      : <ul className="ap-rows">{bots.map((b) => { const s = botStatusOf(b); return (
        <li key={b.id}><div className="ap-rowbtn static">
          <Face name={b.name} muted={s !== 'connected'} />
          <span className="ap-rowtext"><span className="ap-rowname">{b.name}</span><span className={`ap-status ${s}`}><span className="ap-dot" aria-hidden="true" />{t(`aplus.bots.status.${s}`)}<span className="ap-muted"> · {t(BOT_KINDS.includes(b.kind) ? `aplus.bots.kind.${b.kind}` : 'aplus.bots.kind.bot')}</span></span></span>
        </div></li>); })}</ul>}
  </>;
}

function Settings({ t, lang, setLang, onSignOut }) {
  return <div className="ap-settings">
    <section><h2>{t('aplus.me.lang')}</h2><div className="ap-seg small">{['ko', 'en'].map((l) => <button key={l} type="button" className={lang === l ? 'on' : ''} onClick={() => setLang(l)}>{l === 'ko' ? '한국어' : 'English'}</button>)}</div></section>
    <section><h2>{t('aplus.me.scope')}</h2><p className="ap-muted">{t('aplus.me.scope.body')}</p></section>
    <section><button type="button" className="btn" onClick={onSignOut}>{t('aplus.me.signOut')}</button></section>
  </div>;
}

function Chat({ t, source, roomId, title, sub, paused = false, meeting = null, person = null, nameOf, online, onBack, onCancel, onRun, onMembers }) {
  const [msgs, setMsgs] = useState(null); const [err, setErr] = useState('');
  const [draft, setDraft] = useState(''); const [sending, setSending] = useState(false);
  const [files, setFiles] = useState([]); const [fileErr, setFileErr] = useState('');
  const endRef = useRef(null); const pickRef = useRef(null);
  const load = useCallback(() => { setErr(''); source.retry?.(); source.messages(roomId).then(setMsgs, (e) => setErr(t(peopleErrorKey(e) ?? 'aplus.load.failed'))); }, [source, roomId, t]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => source.on('messages', (e) => { if (e.roomId !== roomId) return; setMsgs((cur) => { const have = new Set((cur ?? []).map((m) => m.id)); return [...(cur ?? []), ...e.messages.filter((m) => !have.has(m.id))]; }); }), [source, roomId]);
  useEffect(() => source.on('attachments', (e) => { if (e.roomId !== roomId) return; setMsgs((cur) => (cur ?? []).map((m) => (m.id === e.messageId ? { ...m, files: [...(m.files ?? []).filter((f) => !e.attachments.some((a) => a.id === f.id)), ...e.attachments.map((a) => ({ id: a.id, name: a.name, mime: a.mime, bytes: a.bytes, storage_path: a.bucket && a.path ? `${a.bucket}/${a.path}` : a.path }))] } : m))); }), [source, roomId]);
  useEffect(() => source.on('meeting', (e) => { if (e.roomId === roomId) onRun?.(e.run); }), [source, roomId, onRun]);
  useEffect(() => { endRef.current?.scrollIntoView?.({ block: 'end' }); }, [msgs]);
  // 읽음: 화면에 보이는 동안 가장 큰 글 id가 커질 때만, 조용해진 뒤 1회(createReadMarker — 글마다 보내지 않는다). 방을 닫으면 남은 것을 한 번 보낸다.
  const reader = useMemo(() => (source.markRead ? createReadMarker({ send: (id) => source.markRead(roomId, id) }) : null), [source, roomId]);
  useEffect(() => () => reader?.dispose(), [reader]);
  useEffect(() => {
    if (!reader || !msgs?.length) return undefined;
    const top = Math.max(...msgs.map((m) => (Number.isSafeInteger(m.id) ? m.id : 0)));
    const seen = () => { if (typeof document === 'undefined' || document.visibilityState !== 'hidden') reader.see(top); };
    seen();
    document.addEventListener?.('visibilitychange', seen);
    return () => document.removeEventListener?.('visibilitychange', seen);
  }, [reader, msgs]);
  const [, rerender] = useState(0);
  useEffect(() => { // 기한(offered)이 지나면 서버도 끝남으로 본다 — 그 시각에 한 번 다시 그린다(요청 없음)
    const until = meeting?.run?.state === 'running' ? meeting.run.until : null;
    if (!until) return undefined;
    const id = setTimeout(() => rerender((x) => x + 1), Math.max(0, until - Date.now()) + 500);
    return () => clearTimeout(id);
  }, [meeting?.run]);
  const run = meeting?.run?.state === 'running' && meeting.run.until && meeting.run.until <= Date.now() ? { ...meeting.run, state: 'failed' } : meeting?.run;
  const v = meetingView(deriveRun(run, msgs ?? [])); // 라운드·답한 수는 그 회의 일의 글(meta.round)로 센다
  const readOnly = !!person?.readOnly;
  const legacy = !!person && legacyRoom(person, msgs ?? []);
  const blocked = paused ? t('aplus.chat.paused') : !v.canSend ? t('aplus.chat.meetingBusy') : '';
  const pick = (list) => { const r = addFiles(files, [...(list ?? [])].map(toUpload)); setFiles(r.files); setFileErr(r.problem ? t(`people.file.${r.problem}`) : ''); };
  const send = async () => {
    const body = draft.trim(); if (!canSend({ body, files, blocked: !!blocked || readOnly, sending })) return;
    setSending(true);
    try { const r = await source.send(roomId, body, files); if (r?.ok === false) setErr(t(errorKey(r.code) ?? peopleErrorKey({ code: r.code, details: r.detail }) ?? 'aplus.chat.sendFailed')); else { setDraft(''); setFiles([]); setFileErr(''); } } finally { setSending(false); }
  };
  const authorName = (m) => nameOf(m.author);
  return (
    <div className="ap-chat">
      <header className="ap-chathead">
        {onBack && <button type="button" className="ap-iconbtn" onClick={onBack} aria-label={t('aplus.back')}><I name="back" size={20} /></button>}
        {meeting ? <span className="ap-stack" aria-hidden="true">{meeting.agentIds.slice(0, 3).map((id) => <Face key={id} name={nameOf(id)} size={24} />)}</span> : person?.kind === 'channel' ? <span className="ap-hash big" aria-hidden="true"><I name={person.private ? 'lock' : 'hash'} size={18} /></span> : <Face name={title} muted={paused} />}
        <div className="ap-chattitle"><strong>{title}</strong><span className="ap-muted">{meeting ? meeting.agentIds.map(nameOf).join(', ') : sub}</span></div>
        {onMembers && <button type="button" className="ap-iconbtn ap-headend" onClick={onMembers} aria-label={t('people.members')}><I name="person" size={18} /></button>}
      </header>
      {meeting && <div className={`ap-run ${v.state}`} role="status">
        <span className="ap-runlabel">{v.state === 'idle' ? t('aplus.run.idle', { rounds: MEETING_ROUNDS }) : t(`aplus.run.${v.state}`, { round: v.round, rounds: v.rounds })}</span>
        {v.state === 'running' && <span className="ap-runcount">{t('aplus.run.answered', { n: v.answered, total: v.total })}</span>}
        {v.state !== 'idle' && <span className="ap-steps" aria-hidden="true">{Array.from({ length: v.rounds }, (_, i) => <span key={i} className={i + 1 < v.round || v.state === 'done' ? 'done' : i + 1 === v.round && v.state === 'running' ? 'now' : ''} />)}</span>}
        {v.canCancel && <button type="button" className="btn sm ap-danger" onClick={onCancel}>{t('aplus.run.cancel')}</button>}
      </div>}
      {legacy && <div className="ap-legacy" role="note"><I name="archive" size={14} /><span>{readOnly ? t('people.legacy.readOnly') : t('people.legacy.banner')}</span></div>}
      <div className="ap-msgs">
        {err && <div className="ap-note"><p>{err}</p><button type="button" className="btn sm" onClick={load}><I name="retry" size={14} />{t('aplus.retry')}</button></div>}
        {msgs === null && !err && <p className="ap-note ap-muted">{t('aplus.loading')}</p>}
        {msgs && !msgs.length && <p className="ap-note ap-muted">{meeting ? t('aplus.chat.emptyMeeting', { rounds: MEETING_ROUNDS }) : t('aplus.chat.empty', { name: title })}</p>}
        {msgs?.map((m) => m.author === 'system' || m.kind === 'system'
          ? ((m.errKey || limitKey(m.meta)) ? <p key={m.id} className="ap-sysline" role="note">{t(m.errKey || limitKey(m.meta))}</p> : null) /* 그 밖의 system 글(방 만듦 등)은 A+에서 그리지 않는다 */
          : m.author === 'me'
          ? <div key={m.id} className="ap-msg me"><div className="ap-msgbody">{m.body ? <div className="ap-bubble">{m.body}</div> : null}<Files t={t} source={source} files={m.files} mine /></div></div>
          : <div key={m.id} className="ap-msg"><Face name={authorName(m)} size={28} /><div className="ap-msgbody"><div className="ap-msgname">{authorName(m)}{m.round && meeting ? <span className="ap-pill">{t('aplus.run.roundTag', { round: m.round })}</span> : null}{m.legacy ? <span className="ap-pill">{t('people.legacy.msgTag')}</span> : null}</div>{m.body ? <div className="ap-bubble">{m.body}</div> : null}<Files t={t} source={source} files={m.files} /></div></div>)}
        <div ref={endRef} />
      </div>
      {readOnly ? <footer className="ap-composer"><p className="ap-muted ap-blocked ap-readonly"><I name="lock" size={14} />{t('people.readOnly.body')}</p></footer> : <footer className="ap-composer">
        {blocked && <p className="ap-muted ap-blocked">{blocked}</p>}
        {files.length > 0 && <ul className="ap-chips" aria-label={t('people.file.picked', { n: files.length })}>{files.map((f, i) => (
          <li key={`${f.name}:${f.bytes}`} className="ap-chip"><I name={fileIcon(f)} size={14} /><span className="ap-chipname">{f.name}</span><span className="ap-muted">{formatBytes(f.bytes)}</span><button type="button" className="ap-iconbtn xs" onClick={() => setFiles((l) => l.filter((_, j) => j !== i))} aria-label={t('people.file.remove', { name: f.name })}><I name="x" size={12} /></button></li>))}</ul>}
        {fileErr && <p className="ap-error ap-blocked" role="alert">{fileErr}</p>}
        <div className="ap-inputrow">
          <input ref={pickRef} type="file" multiple hidden onChange={(e) => { pick(e.target.files); e.target.value = ''; }} />
          <button type="button" className="ap-attach" onClick={() => pickRef.current?.click()} disabled={!!blocked} aria-label={t('people.file.attach')}><I name="clip" size={18} /></button>
          <textarea rows={1} value={draft} disabled={!!blocked} placeholder={meeting ? t('aplus.chat.placeholderMeeting') : person?.kind === 'channel' ? t('people.chat.placeholderChannel', { name: person.name }) : t('aplus.chat.placeholder', { name: title })} onChange={(e) => setDraft(e.target.value)} onPaste={(e) => { if (e.clipboardData?.files?.length) { e.preventDefault(); pick(e.clipboardData.files); } }} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }} aria-label={t('aplus.chat.input')} />
          <button type="button" className="ap-send" onClick={send} disabled={!canSend({ body: draft, files, blocked: !!blocked, sending })} aria-label={t('aplus.chat.send')}><I name="up" size={18} /></button>
        </div>
        {!online && <p className="ap-muted ap-blocked">{t('aplus.chat.offline')}</p>}
      </footer>}
    </div>
  );
}

/** 글의 첨부: 그림은 미리보기, 그 밖은 파일 카드(이름·크기·종류). 주소는 누를 때(그림은 보일 때) 한 번 받는다. */
function Files({ t, source, files = [], mine = false }) {
  if (!files?.length) return null;
  return <div className={`ap-files${mine ? ' mine' : ''}`}>{files.map((f) => <FileItem key={f.id ?? f.name} t={t} source={source} f={f} />)}</div>;
}
function FileItem({ t, source, f }) {
  const [url, setUrl] = useState(f.url ?? null);
  const img = isImage(f);
  useEffect(() => { if (img && !url && f.storage_path) source.fileUrl?.(f.storage_path).then((u) => u && setUrl(u), () => {}); }, [img, url, f.storage_path, source]);
  const openIt = async () => { const u = url ?? await source.fileUrl?.(f.storage_path).catch(() => null); if (u) window.open(u, '_blank', 'noopener'); };
  if (img && url) return <button type="button" className="ap-img" onClick={openIt} aria-label={t('people.file.open', { name: f.name })}><img src={url} alt={f.name} loading="lazy" /></button>;
  return <button type="button" className="ap-file" onClick={openIt} aria-label={t('people.file.open', { name: f.name })}><span className="ap-fileicon"><I name={fileIcon(f)} size={18} /></span><span className="ap-rowtext"><span className="ap-rowname">{f.name}</span><span className="ap-rowsub">{formatBytes(f.bytes)}</span></span><I name="download" size={15} /></button>;
}

function Sheet({ title, onClose, children, t }) {
  useEffect(() => { const on = (e) => { if (e.key === 'Escape') onClose(); }; window.addEventListener('keydown', on); return () => window.removeEventListener('keydown', on); }, [onClose]);
  return <div className="ap-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}><div className="ap-sheet" role="dialog" aria-modal="true" aria-label={title}>
    <header><h2>{title}</h2><button type="button" className="ap-iconbtn" onClick={onClose} aria-label={t('aplus.close')}><I name="x" size={18} /></button></header>{children}</div></div>;
}

function MeetingSheet({ t, rows, onClose, onCreate }) {
  const [title, setTitle] = useState(''); const [picked, setPicked] = useState([]); const [capped, setCapped] = useState(false);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const problem = meetingDraftProblem({ title, picked, available: rows.length });
  const create = async () => { if (problem || busy) return; setBusy(true); setErr(''); try { await onCreate({ title: title.trim(), agentIds: picked }); } catch (e) { setErr(notOpenYet(e) ? t('aplus.closed.meet') : t(errorKey(e) ?? 'aplus.meet.createFailed')); } finally { setBusy(false); } };
  return <Sheet title={t('aplus.meet.new')} onClose={onClose} t={t}>
    <div className="ap-form">
      <label className="ap-field"><span>{t('aplus.meet.title')}</span><input value={title} maxLength={TITLE_MAX} onChange={(e) => setTitle(e.target.value)} placeholder={t('aplus.meet.titlePh')} /></label>
      <div className="ap-field"><span>{t('aplus.meet.pick', { n: picked.length, max: MEETING_MAX })}</span>
        <ul className="ap-picks">{rows.map((r) => { const on = picked.includes(r.id); const full = !on && picked.length >= MEETING_MAX; return (
          <li key={r.id}><label className={`ap-pick${on ? ' on' : ''}${full ? ' off' : ''}`}><input type="checkbox" checked={on} disabled={full} onChange={() => { const x = togglePick(picked, r.id); setPicked(x.picked); setCapped(x.capped); }} /><Face name={r.name} size={24} /><span className="ap-rowtext"><span className="ap-rowname">{r.name}</span><span className="ap-rowsub">{r.role}</span></span></label></li>); })}</ul>
        {(capped || picked.length >= MEETING_MAX) && <p className="ap-muted">{t('aplus.meet.problem.max', { max: MEETING_MAX })}</p>}
      </div>
      <p className="ap-hint"><I name="clock" size={14} />{t('aplus.meet.rounds', { rounds: MEETING_ROUNDS })}</p>
      <p className="ap-hint"><I name="person" size={14} />{t('aplus.meet.onlyMe')}</p>
      {problem && problem !== 'title' && problem !== 'min' && <p className="ap-error">{t(`aplus.meet.problem.${problem}`, { min: MEETING_MIN, max: MEETING_MAX, n: TITLE_MAX })}</p>}
      {err && <p className="ap-error">{err}</p>}
      <div className="ap-row end"><button type="button" className="btn" onClick={onClose}>{t('aplus.cancel')}</button><button type="button" className="btn btn-primary" disabled={!!problem || busy} onClick={create}>{busy ? t('aplus.working') : t('aplus.meet.create')}</button></div>
    </div>
  </Sheet>;
}

function BotGuide({ t, onClose }) { // 봇 주소·키는 서버에 두지 않는다(약속 v1.1) — 내 PC의 Argo 설정에서 연결하고, 여기에는 연결된 봇이 보인다
  return <Sheet title={t('aplus.bots.guide.title')} onClose={onClose} t={t}>
    <div className="ap-form">
      <ol className="ap-steps-list">{['s1', 's2', 's3', 's4'].map((k) => <li key={k}>{t(`aplus.bots.guide.${k}`)}</li>)}</ol>
      <div className="ap-callout"><I name="lock" size={16} /><div><strong>{t('aplus.bots.key.title')}</strong><p>{t('aplus.bots.key.body')}</p></div></div>
      <div className="ap-row end"><button type="button" className="btn btn-primary" onClick={onClose}>{t('aplus.ok')}</button></div>
    </div>
  </Sheet>;
}
