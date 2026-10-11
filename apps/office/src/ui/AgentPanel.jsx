import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Icon } from './Icon.jsx';
import { Face } from './Face.jsx';
import { Markdown } from './Markdown.jsx';
import { showToast } from './Overlay.jsx';
import { t, useLang, registerDict } from '../core/i18n.js';
import { useStore, getState } from '../core/store.js';
import { SPACES, ME, getMode } from '../core/session.js';
import { getClient } from '../core/supabase.js';
import { crewsIn } from '../core/crew-list.js';
import { assignTarget, composeAssign, htmlText, docText } from '../core/crew-assign.js';
import { readMail } from '../core/mail.js';
import { loadPageContent } from '../core/pull.js';
import { rpc } from '../core/tasks.js';
import { imeGuardWith } from '../core/ime.js';
import { openExternal } from '../core/platform.js';
import { createComposerDelivery } from '../../../messenger/src/composer-delivery.mjs';
import { acceptFiles, withoutFile, chipSize } from '../../../messenger/src/attach-files.mjs';
import { previewFor } from '../../../messenger/src/media-actions.mjs';
import { PANEL_SOURCE, conversations, threadOf, shownBody, seeingItem, waiting, openRoom, loadRoom, loadRow, loadSince, loadFiles, fileUrl, stopTurn, listen, panelTransport } from '../core/agent-chat.js';
import { AGENT_DICT } from './agent-panel-i18n.js';
import './agent-panel.css';

registerDict(AGENT_DICT);

const ATTACH_MAX = 25 * 1024 * 1024; // 메신저·게이트웨이 ATTACH_MAX와 같은 값
const SILENT_MS = 120_000;
const pickKey = (space) => `argo-office-agent:${ME.id}:${space}`;
const ITEM_ICON = { mail: 'mail', page: 'doc' };
const noSub = () => () => {};
const EMPTY = { text: '', files: [], job: null, busy: false, uploading: '' };

async function withText(items) {
  return Promise.all(items.map(async (i) => {
    if (i.kind === 'mail') {
      const m = getState().mails.find((x) => x.id === i.id);
      if (!m?.account) return i;
      const full = await readMail(m);
      return { ...i, from: full.from ?? m.from, text: htmlText(full.html) };
    }
    let page = getState().pages.find((x) => x.id === i.id);
    if (page && page.content === undefined) { await loadPageContent(i.id); page = getState().pages.find((x) => x.id === i.id); }
    return { ...i, text: docText(page?.content) };
  }));
}

function FileCard({ f }) {
  const image = String(f.mime ?? '').startsWith('image/');
  const [src, setSrc] = useState(null);
  useEffect(() => {
    if (!image) return undefined;
    let alive = true;
    getClient().then((sb) => fileUrl(sb, f.storage_path)).then((u) => { if (alive) setSrc(u); }, () => {});
    return () => { alive = false; };
  }, [image, f.storage_path]);
  const open = async () => { const u = await fileUrl(await getClient(), f.storage_path); if (u) openExternal(u); };
  if (image) return <button type="button" className="agent-img" title={f.name} onClick={open}>{src ? <img src={src} alt={f.name} /> : <Icon name="image" />}</button>;
  return (
    <button type="button" className="agent-file" title={f.name} onClick={open}>
      <span className="agent-file-ic"><Icon name="file" size={16} /></span>
      <span className="agent-file-name"><b>{f.name}</b><small className="dim">{chipSize({ size: f.bytes ?? 0 })}</small></span>
    </button>
  );
}

function LinkCard({ row }) {
  const p = previewFor(row);
  if (!p) return null;
  return <button type="button" className="agent-link" title={p.url} onClick={() => openExternal(p.url)}><b>{p.title || p.host}</b>{p.description && <small className="dim">{p.description}</small>}<small className="dim">{p.host}</small></button>;
}

function Message({ row, files, crewName, fence }) {
  const mine = row.author_kind === 'user';
  const own = files.filter((f) => f.message_id === row.id);
  const items = mine ? row.meta?.office_items ?? [] : [];
  const body = mine ? shownBody(row.body, fence) : row.body;
  return (
    <div className={`agent-msg ${mine ? 'me' : 'bot'}`}>
      {!mine && <div className="agent-name dim small">{crewName}</div>}
      {body && (mine ? <div className="agent-bubble">{body}</div> : <div className={`agent-bubble${row.kind === 'system' ? ' dim' : ''}`}><Markdown text={body} /></div>)}
      {items.length > 0 && <div className="agent-chips">{items.map((i) => <span key={`${i.kind}-${i.label}`} className="chip" title={t('agent.sentWith')}><Icon name={ITEM_ICON[i.kind] ?? 'file'} size={12} />{i.label}</span>)}</div>}
      {own.length > 0 && <div className="agent-files">{own.map((f) => <FileCard key={f.id} f={f} />)}</div>}
      {!mine && <LinkCard row={row} />}
    </div>
  );
}

export default function AgentPanel({ path, space, onClose }) {
  useLang();
  const live = getMode() === 'signedIn';
  const allCrews = useStore((s) => s.crews), mails = useStore((s) => s.mails), pages = useStore((s) => s.pages);
  const crews = useMemo(() => crewsIn(allCrews, space, ME.id).filter((c) => !live || (c.owner === ME.id && !c.company && (c.access ?? 'ok') === 'ok')), [allCrews, space, live]);
  const saved = () => { try { return localStorage.getItem(pickKey(space)); } catch { return null; } };
  const [crewId, setCrewId] = useState(saved);
  useEffect(() => { setCrewId(saved()); }, [space]);
  const crew = crews.find((c) => c.id === crewId || c.ids?.includes(crewId)) ?? crews[0] ?? null;
  const target = useMemo(() => (crew ? assignTarget(crew, allCrews, SPACES) : null), [crew, allCrews]);
  const targetKey = target ? `${target.orgId}|${target.crewId}|${target.personalId}|${target.personalBot}` : '';
  const fence = t('crew.msg.fence');

  const [room, setRoom] = useState(null);
  const [rows, setRows] = useState([]), [files, setFiles] = useState([]);
  const [root, setRoot] = useState(null), [view, setView] = useState('chat');
  const [progress, setProgress] = useState(null), [sentAt, setSentAt] = useState(null), [now, setNow] = useState(() => Date.now());
  const [again, setAgain] = useState(0), [dropped, setDropped] = useState(null), [tooBig, setTooBig] = useState([]);
  const sbRef = useRef(null), rootRef = useRef(null), prepRef = useRef(null), fileIn = useRef(null), box = useRef(null);
  rootRef.current = root;
  const maxIdRef = useRef(0);
  maxIdRef.current = rows.reduce((m, r) => Math.max(m, r.id), 0);

  useEffect(() => {
    if (!live || !target) return undefined;
    let alive = true, stop = null;
    setRoom(null); setRows([]); setFiles([]); setRoot(null); setProgress(null); setSentAt(null);
    (async () => {
      const sb = await getClient(); sbRef.current = sb;
      const r = await openRoom(sb, ME.id, target, crew.name);
      const data = await loadRoom(sb, r.channel);
      if (!alive) return;
      setRows(data.rows); setFiles(data.files); setRoot(conversations(data.rows, fence)[0]?.id ?? null); setRoom(r);
      const addRows = (list) => { if (alive && list.length) setRows((rs) => [...list.filter((x) => !rs.some((y) => y.id === x.id)), ...rs]); };
      stop = await listen(sb, { channel: r.channel, uid: ME.id, personal: r.personal }, {
        message: (p) => loadRow(sb, p.id).then((row) => {
          if (!alive || !row) return;
          setRows((rs) => [row, ...rs.filter((x) => x.id !== row.id)]);
          if (row.author_kind === 'crew') { setProgress(null); setSentAt(null); }
        }, () => {}),
        attach: (p) => loadFiles(sb, [p.message_id]).then((fs) => { if (alive) setFiles((old) => [...old.filter((x) => x.message_id !== p.message_id), ...fs]); }, () => {}),
        progress: (p) => { if (alive) setProgress({ at: Date.now(), startedAt: (typeof p.startedAt === 'number' ? p.startedAt : Date.parse(p.startedAt)) || Date.now(), source: p.source_msg_id, crew: p.crew_id }); }, // 게이트웨이는 Date.now() 숫자를 보낸다(turn-status.mjs)
        // 구독이 붙을 때마다(처음·재연결) 그사이 들어온 글만 한 번 읽는다 — 불러오기와 구독 사이 틈, 끊긴 동안 놓친 답. 이벤트 때만이라 폴링이 아니다
        status: (s) => {
          if (!alive) return;
          if (s === 'SUBSCRIBED') loadSince(sb, r.channel, maxIdRef.current).then((list) => { addRows(list); if (list.some((x) => x.author_kind === 'crew')) setProgress(null); }, () => {});
          else if (s === 'CHANNEL_ERROR' || s === 'TIMED_OUT') setRoom({ error: 'load' });
        },
      });
      if (!alive) stop();
    })().catch((e) => { if (alive) setRoom({ error: e?.assign ?? 'load' }); });
    return () => { alive = false; stop?.(); };
  }, [live, targetKey, again]);

  const busyTurn = waiting(progress, now);
  useEffect(() => {
    if (!busyTurn && !sentAt) return undefined;
    const iv = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(iv);
  }, [busyTurn, sentAt]);

  const composer = useMemo(() => (room?.channel ? createComposerDelivery(panelTransport(sbRef.current, { orgId: target?.orgId, channel: room.channel, uid: ME.id, personal: room.personal }, (job) => prepRef.current(job))) : null), [room?.channel]);
  useEffect(() => () => composer?.dispose(), [composer]);
  const cs = useSyncExternalStore(composer ? composer.subscribe : noSub, composer ? composer.snapshot : () => EMPTY);

  const seen = seeingItem(path, { mails, pages }, t('page.untitled'));
  const seeing = seen && dropped !== `${seen.kind}:${seen.id}` ? seen : null;
  prepRef.current = async (job) => {
    const items = seeing ? await withText([seeing]) : [];
    const { body, meta } = composeAssign({ instruction: job.body || t('agent.filesOnly'), items, t });
    return { body, meta: { ...meta, source: PANEL_SOURCE, office_items: items.map(({ kind, label }) => ({ kind, label })) }, replyTo: rootRef.current };
  };

  const send = async () => {
    if (!composer || cs.busy || cs.job) return;
    const sentSeeing = seeing;
    const ok = await composer.send([]);
    if (!ok) return;
    const id = composer.snapshot().lastDeliveredId;
    if (sentSeeing) setDropped(`${sentSeeing.kind}:${sentSeeing.id}`);
    setSentAt(Date.now()); setView('chat');
    if (!rootRef.current && id) setRoot(id);
    if (id) loadRow(sbRef.current, id).then((row) => { if (row) setRows((rs) => [row, ...rs.filter((x) => x.id !== row.id)]); }, () => {});
  };
  const addFiles = (list) => {
    if (!composer || !list?.length) return;
    const { files: next, rejected } = acceptFiles(cs.files, [...list], ATTACH_MAX);
    composer.setFiles(next); setTooBig(rejected.map((f) => f.name));
  };
  const onKey = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } };
  const pickCrew = (id) => { setCrewId(id); try { localStorage.setItem(pickKey(space), id); } catch { /* 이 기기에 기억만 못 한다 */ } };
  const agree = () => rpc('msgr_set_ai_consent', { consent: true }).then(() => setAgain((n) => n + 1), () => {});

  const list = useMemo(() => conversations(rows, fence), [rows, fence]);
  const thread = useMemo(() => (root ? threadOf(rows, root) : []), [rows, root]);
  const lastMine = [...thread].reverse().find((r) => r.author_kind === 'user');
  const answered = !!lastMine && thread.some((r) => r.author_kind === 'crew' && r.id > lastMine.id);
  const silent = !!sentAt && !busyTurn && !answered && now - sentAt > SILENT_MS;

  let body;
  if (!live) body = <p className="agent-note dim">{t('agent.signIn')}</p>;
  else if (!crew) body = <p className="agent-note dim">{t('crew.fail.no_crew')}</p>;
  else if (room?.error === 'consent') body = <div className="agent-note"><p>{t('consent.title')}</p><p className="dim small">{t('consent.desc')}</p><button type="button" className="btn primary" onClick={agree}><Icon name="check" size={14} />{t('consent.confirm')}</button></div>;
  else if (room?.error) body = <div className="agent-note"><p className="dim">{room.error === 'load' ? t('agent.loadFail') : t(`crew.fail.${room.error}`)}</p><button type="button" className="btn sm" onClick={() => setAgain((n) => n + 1)}><Icon name="refresh" size={14} />{t('agent.retry')}</button></div>;
  else if (!room) body = <p className="agent-note dim">{t('agent.loading')}</p>;
  else if (view === 'list') body = (
    <div className="agent-list">
      {list.length ? list.map((c) => <button key={c.id} type="button" className={`agent-row${c.id === root ? ' on' : ''}`} onClick={() => { setRoot(c.id); setView('chat'); }}><b>{c.title || '…'}</b><small className="dim">{new Date(c.at).toLocaleString()}</small></button>)
        : <p className="agent-note dim">{t('agent.empty')}</p>}
    </div>
  );
  else body = (
    <div className="agent-thread">
      {thread.length === 0 && <p className="agent-note dim">{t('agent.empty')}</p>}
      {thread.map((r) => <Message key={r.id} row={r} files={files} crewName={crew.name} fence={fence} />)}
      {busyTurn && <div className="agent-progress dim small"><span className="agent-spin" />{t('agent.preparing', { crew: crew.name, sec: Math.max(0, Math.round((now - progress.startedAt) / 1000)) })}
        {progress.source && <button type="button" className="btn sm" onClick={() => stopTurn(sbRef.current, progress.crew, progress.source).then((ok) => { setProgress(null); if (ok) showToast(t('agent.stopped')); }, () => showToast(t('crew.fail.generic')))}>{t('agent.stop')}</button>}</div>}
      {!busyTurn && sentAt && !answered && <p className="agent-progress dim small">{t(silent ? 'agent.silent' : 'agent.waiting', { crew: crew.name })}</p>}
      {crew.on === false && <p className="data-note"><Icon name="info" size={12} />{t('crew.offNote')}</p>}
    </div>
  );

  const ready = live && room?.channel && composer;
  return (
    <aside className="agent-dock" role="complementary" aria-label={t('agent.title')} onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
      onDragOver={(e) => { if (ready && e.dataTransfer?.types?.includes('Files')) e.preventDefault(); }} onDrop={(e) => { if (!ready) return; e.preventDefault(); addFiles(e.dataTransfer.files); }}>
      <header className="agent-head">
        {crew ? <Face id={crew.id} size={28} /> : <Icon name="hand" />}
        <div className="agent-who">
          <b>{crew?.name ?? t('agent.title')}</b>
          {crews.length > 1 ? <label className="dim small">{t('agent.who')} · <select className="agent-pick" aria-label={t('agent.change')} value={crew?.id ?? ''} onChange={(e) => pickCrew(e.target.value)}>{crews.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
            : <small className="dim">{t('agent.who')}</small>}
        </div>
        <button type="button" className={`btn sm${view === 'list' ? ' on' : ''}`} disabled={!room?.channel} onClick={() => setView(view === 'list' ? 'chat' : 'list')}>{t('agent.list')}</button>
        <button type="button" className="btn sm" disabled={!room?.channel} onClick={() => { setRoot(null); setView('chat'); setSentAt(null); setDropped(null); box.current?.focus(); }}><Icon name="plus" size={14} />{t('agent.new')}</button>
        <button type="button" className="icon-btn" aria-label={t('close')} onClick={onClose}><Icon name="x" /></button>
      </header>
      <div className="agent-body">{body}</div>
      {ready && <footer className="agent-comp">
        {cs.job?.error && <div className="data-note agent-fail"><span>{t('agent.sendFail')}</span><button type="button" className="link-btn small" onClick={() => composer.retry()}>{t('agent.resend')}</button><button type="button" className="link-btn small" onClick={() => composer.dismiss()}>{t('agent.dismiss')}</button></div>}
        {cs.uploading && <p className="dim small">{t('agent.uploading', { name: cs.uploading })}</p>}
        {tooBig.length > 0 && <p className="data-note">{t('agent.tooBig', { names: tooBig.join(', ') })}</p>}
        {(seeing || cs.files.length > 0) && <div className="agent-chips">
          {seeing && <span className="chip"><Icon name={ITEM_ICON[seeing.kind]} size={12} />{t('agent.seeing', { label: seeing.label })}<button type="button" className="chip-x" aria-label={t('close')} onClick={() => setDropped(`${seeing.kind}:${seeing.id}`)}><Icon name="x" size={12} /></button></span>}
          {cs.files.map((f) => <span key={`${f.name}-${f.size}`} className="chip"><Icon name="attach" size={12} />{f.name} · {chipSize(f)}<button type="button" className="chip-x" aria-label={t('close')} onClick={() => composer.setFiles(withoutFile(cs.files, f))}><Icon name="x" size={12} /></button></span>)}
        </div>}
        <textarea ref={box} data-autofocus className="input agent-input" rows={2} value={cs.text} placeholder={t('agent.ph')} aria-label={t('agent.ph')}
          onChange={(e) => composer.setText(e.target.value)} onPaste={(e) => { if (e.clipboardData?.files?.length) { e.preventDefault(); addFiles(e.clipboardData.files); } }} {...imeGuardWith(onKey)} />
        <div className="agent-actions">
          <button type="button" className="btn sm" onClick={() => fileIn.current?.click()}><Icon name="attach" size={14} />{t('agent.attach')}</button>
          <input ref={fileIn} type="file" multiple hidden onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
          <small className="dim agent-ctx">{t('agent.context')}</small>
          <button type="button" className="agent-send" aria-label={t('agent.send')} disabled={cs.busy || !!cs.job || (!cs.text.trim() && !cs.files.length)} onClick={send}><Icon name="send" size={16} /></button>
        </div>
      </footer>}
    </aside>
  );
}

