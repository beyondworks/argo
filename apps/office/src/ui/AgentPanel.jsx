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
import { createComposerDelivery } from '../../../../src/composer-delivery.mjs';
import { acceptFiles, withoutFile, chipSize } from '../../../messenger/src/attach-files.mjs';
import { formatBytes } from '../../../../src/media-kind.mjs';
import { previewFor } from '../../../messenger/src/media-actions.mjs';
import { panelMeta, conversations, threadOf, shownBody, seeingItem, waiting, openRoom, loadRoom, loadRow, loadSince, loadFiles, fileUrl, stopTurn, listen, panelTransport, proposalsOf, proposalState, proposalFields, fieldLabelKey, sendConfirm, liveSteps, keptSteps, delegatedTo, sendRoute } from '../core/agent-chat.js';
import { AGENT_DICT } from './agent-panel-i18n.js';
import './agent-panel.css';

registerDict(AGENT_DICT);

// 첨부 파일 하나 상한은 플랜에 따라 다르다(무료 25MB · Pro·체험 500MB — 서버 _msgr_file_max가 최종 판정, 20261012120000).
// 메신저 입력창과 같은 5분 모듈 캐시로 my_plan을 읽는다 — 모르는 동안은 무료 상한으로 안내하고 서버가 막는다.
const ATTACH_MAX_FREE = 25 * 1024 * 1024, ATTACH_MAX_PRO = 500 * 1024 * 1024;
const attachMaxFor = (plan) => (plan === 'pro' || plan === 'trial' ? ATTACH_MAX_PRO : ATTACH_MAX_FREE);
let attachPlanCache = { at: 0, plan: null };
const SILENT_MS = 120_000;
const pickKey = (space) => `argo-office-agent:${ME.id}:${space}`;
const autoKey = () => `argo-office-agent-auto:${ME.id}`;
const cancelKey = () => `argo-office-agent-cancel:${ME.id}`;
const readLocal = (k, dflt) => { try { const v = localStorage.getItem(k); return v == null ? dflt : JSON.parse(v); } catch { return dflt; } };
const writeLocal = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 이 기기에 기억만 못 한다 */ } };
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

// 쓰기 확인 카드 — 에이전트가 제안한 오피스 쓰기. [실행]을 눌러야 게이트웨이가 실행한다(office-proposals.mjs)
function ProposalCard({ p, state, onRun, onCancel }) {
  const [more, setMore] = useState(false);
  const fields = proposalFields(p);
  const label = { done: t('agent.prop.done'), failed: t('agent.prop.failed'), unknown: t('agent.prop.unknown'), sent: t('agent.prop.sent'), canceled: t('agent.prop.canceled') }[state];
  return (
    <div className={`agent-prop${state !== 'open' ? ' settled' : ''}`}>
      <div className="agent-prop-row">
        <Icon name={state === 'done' ? 'check' : state === 'failed' ? 'x' : 'run'} size={14} />
        <span className="agent-prop-text">{p.summary}</span>
        {fields.length > 0 && <button type="button" className="link-btn small" aria-expanded={more} onClick={() => setMore(!more)}>{t(more ? 'agent.prop.less' : 'agent.prop.more')}</button>}
        {state === 'open' ? <span className="agent-prop-act">
          <button type="button" className="btn sm" onClick={onCancel}>{t('agent.prop.cancel')}</button>
          <button type="button" className="btn sm primary" onClick={onRun}>{t('agent.prop.run')}</button>
        </span> : <small className="dim">{label}</small>}
      </div>
      {more && <dl className="agent-prop-fields">{fields.map((f) => <div key={f.key}><dt className="dim">{t(fieldLabelKey(f, (k) => t(k) !== k))}</dt><dd>{f.value}</dd></div>)}</dl>}
    </div>
  );
}

// 에이전트 자체 도구(mcp__crew)의 단계 대상은 'crew · 도구이름'으로 온다(turn-status detailForTool) — 아는 도구는 사람이 읽는 이름으로
const CREW_TOOLS = ['calendar', 'office', 'office_files', 'office_work', 'office_deals', 'office_mail', 'office_briefing', 'request_approval', 'send_to_crew', 'start_long_task', 'schedule_task', 'use_connector'];
const stepDetail = (d) => { const m = /^crew · ([a-z_]+)$/.exec(d ?? ''); return m ? (CREW_TOOLS.includes(m[1]) ? t(`agent.tool.${m[1]}`) : '') : d; }; // 모르는 내부 도구 이름은 숨긴다 — 단계 이름('도구 사용')만(검수 L6)

// 처리 과정 — 누가(이 에이전트) 무엇을 했는지 단계 한 줄씩. 진행 중에는 펼쳐 두고, 끝난 답에서는 접어 둔다
function Steps({ steps, n, open: initial = false }) {
  const [open, setOpen] = useState(initial);
  if (!steps?.length) return null;
  const more = Math.max(0, (n ?? steps.length) - steps.length);
  return (
    <div className="agent-steps">
      <button type="button" className="link-btn small agent-steps-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="caret" size={14} />{t('agent.steps', { n: n ?? steps.length })}
      </button>
      {open && <ol className="agent-steps-list">
        {more > 0 && <li className="dim">{t('agent.steps.more', { n: more })}</li>}
        {steps.map((s, i) => { const d = stepDetail(s.detail); return <li key={i}><b>{t(`agent.stage.${s.stage}`)}</b>{d && <span className="dim"> · {d}</span>}</li>; })}
      </ol>}
    </div>
  );
}

// 배분 줄 — 이 답에서 조율자가 맡긴 동료, 그리고 같은 요청을 다른 에이전트에게 맡기기(직무별 배분의 안전장치, 2단계 PR3)
function RouteBar({ row, others, onRoute }) {
  const names = delegatedTo(row);
  if (!names.length && !others.length) return null;
  return (
    <div className="agent-route dim small">
      {names.length > 0 && <span>{t('agent.route.by', { names: names.map((d) => (d.role ? `${d.name}(${d.role})` : d.name)).join(', ') })}</span>}
      {others.length > 0 && <select className="agent-pick" aria-label={t('agent.route.pick')} value="" onChange={(e) => { if (e.target.value) onRoute(e.target.value); }}>
        <option value="">{t('agent.route.pick')}</option>
        {others.map((c) => <option key={c.id} value={c.name}>{c.name}{c.role ? ` · ${c.role}` : ''}</option>)}
      </select>}
    </div>
  );
}

function Message({ row, files, crewName, fence, cards, route }) {
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
      {cards}
      {!mine && (() => { const k = keptSteps(row); return k ? <Steps steps={k.steps} n={k.n} /> : null; })()}
      {!mine && row.kind !== 'system' && route}
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
  const [auto, setAuto] = useState(() => readLocal(autoKey(), false) === true), [canceled, setCanceled] = useState(() => readLocal(cancelKey(), []));
  const [attachMax, setAttachMax] = useState(() => attachMaxFor(attachPlanCache.plan));
  useEffect(() => { // 내 플랜의 첨부 상한(5분 모듈 캐시 — 메신저 입력창과 같은 규칙). 실패·지연은 무료 상한 안내 유지
    let live = true;
    if (Date.now() - attachPlanCache.at > 300_000) rpc('my_plan').then((d) => { attachPlanCache = { at: Date.now(), plan: d?.plan ?? null }; if (live) setAttachMax(attachMaxFor(attachPlanCache.plan)); }).catch(() => {});
    else setAttachMax(attachMaxFor(attachPlanCache.plan));
    return () => { live = false; };
  }, []);
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
        progress: (p) => { if (alive) setProgress((old) => { const steps = liveSteps(p); return { at: Date.now(), startedAt: (typeof p.startedAt === 'number' ? p.startedAt : Date.parse(p.startedAt)) || Date.now(), source: p.source_msg_id, crew: p.crew_id, steps: steps.length ? steps : (old?.source === p.source_msg_id ? old.steps : []), n: Number.isSafeInteger(p.steps_n) && p.steps_n > 0 ? p.steps_n : (old?.source === p.source_msg_id ? old.n : null) }; }); }, // 단계는 패널 턴·주인 혼자 1:1에서만 온다 — 빈 방송이 와도 같은 턴의 마지막 목록을 지우지 않는다 // 게이트웨이는 Date.now() 숫자를 보낸다(turn-status.mjs)
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
    return { body, meta: panelMeta(meta, { items, auto, personal: room?.personal === true, orgId: target?.orgId ?? null }), replyTo: rootRef.current };
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
    const { files: next, rejected } = acceptFiles(cs.files, [...list], attachMax);
    composer.setFiles(next); setTooBig(rejected.map((f) => f.name));
  };
  const onKey = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } };
  const pickCrew = (id) => { setCrewId(id); try { localStorage.setItem(pickKey(space), id); } catch { /* 이 기기에 기억만 못 한다 */ } };
  const agree = () => rpc('msgr_set_ai_consent', { consent: true }).then(() => setAgain((n) => n + 1), () => {});
  const toggleAuto = (on) => { setAuto(on); writeLocal(autoKey(), on); };
  const cancelProp = (key) => { const next = [...canceled.filter((k) => k !== key), key].slice(-200); setCanceled(next); writeLocal(cancelKey(), next); }; // 이 기기에만 — 오래된 것부터 200개 유지
  const routing = useRef(false);
  const routeTo = async (asked, name) => { // 같은 요청을 고른 동료에게 — 조율자가 그 동료에게 맡기고 결과를 검토해 답한다
    if (!room?.channel || !root || routing.current) return;
    routing.current = true; // 보내는 동안 잠금 — 빠르게 두 번 골라 조율자 턴이 두 번 도는 것을 막는다
    try {
      const id = await sendRoute(sbRef.current, { channel: room.channel, uid: ME.id, root, name, clientId: `or:${asked.id}:${name}`,
        body: t('agent.route.body', { name, text: shownBody(asked.body, fence).slice(0, 2000) }) });
      setSentAt(Date.now());
      loadRow(sbRef.current, id).then((r) => { if (r) setRows((rs) => [r, ...rs.filter((x) => x.id !== r.id)]); }, () => {});
    } catch { showToast(t('agent.sendFail')); } finally { routing.current = false; }
  };
  const runProp = async (row, p) => {
    if (!room?.channel || !root) return;
    try {
      const id = await sendConfirm(sbRef.current, { channel: room.channel, uid: ME.id, root, replyId: row.id, pid: p.pid, body: t('agent.prop.body', { summary: p.summary }) });
      setSentAt(Date.now());
      loadRow(sbRef.current, id).then((r) => { if (r) setRows((rs) => [r, ...rs.filter((x) => x.id !== r.id)]); }, () => {});
    } catch { showToast(t('agent.sendFail')); }
  };

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
      {thread.map((r) => {
        const props = proposalsOf(r);
        const cards = props.length > 0 && <div className="agent-props">{props.map((p) => {
          const key = `${r.id}:${p.pid}`, st = proposalState(thread, r.id, p.pid);
          return <ProposalCard key={p.pid} p={p} state={st === 'open' && canceled.includes(key) ? 'canceled' : st} onRun={() => runProp(r, p)} onCancel={() => cancelProp(key)} />;
        })}</div>;
        const asked = r.author_kind === 'crew' ? thread.find((x) => x.id === r.reply_to && x.author_kind === 'user') : null;
        const route = asked && <RouteBar row={r} others={crews.filter((c) => c.id !== crew.id && c.name !== crew.name)} onRoute={(name) => routeTo(asked, name)} />;
        return <Message key={r.id} row={r} files={files} crewName={crew.name} fence={fence} cards={cards} route={route} />;
      })}
      {busyTurn && <div className="agent-progress dim small"><span className="agent-spin" />{t('agent.preparing', { crew: crew.name, sec: Math.max(0, Math.round((now - progress.startedAt) / 1000)) })}
        {progress.source && <button type="button" className="btn sm" onClick={() => stopTurn(sbRef.current, progress.crew, progress.source).then((ok) => { setProgress(null); if (ok) showToast(t('agent.stopped')); }, () => showToast(t('crew.fail.generic')))}>{t('agent.stop')}</button>}</div>}
      {busyTurn && progress.steps?.length > 0 && <Steps key={progress.source ?? 'live'} steps={progress.steps} n={progress.n ?? undefined} open />}
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
        {tooBig.length > 0 && <p className="data-note">{t('agent.tooBig', { names: tooBig.join(', '), max: formatBytes(attachMax) })}</p>}
        {(seeing || cs.files.length > 0) && <div className="agent-chips">
          {seeing && <span className="chip"><Icon name={ITEM_ICON[seeing.kind]} size={12} />{t('agent.seeing', { label: seeing.label })}<button type="button" className="chip-x" aria-label={t('close')} onClick={() => setDropped(`${seeing.kind}:${seeing.id}`)}><Icon name="x" size={12} /></button></span>}
          {cs.files.map((f) => <span key={`${f.name}-${f.size}`} className="chip"><Icon name="attach" size={12} />{f.name} · {chipSize(f)}<button type="button" className="chip-x" aria-label={t('close')} onClick={() => composer.setFiles(withoutFile(cs.files, f))}><Icon name="x" size={12} /></button></span>)}
        </div>}
        <textarea ref={box} data-autofocus className="input agent-input" rows={2} value={cs.text} placeholder={t('agent.ph')} aria-label={t('agent.ph')}
          onChange={(e) => composer.setText(e.target.value)} onPaste={(e) => { if (e.clipboardData?.files?.length) { e.preventDefault(); addFiles(e.clipboardData.files); } }} {...imeGuardWith(onKey)} />
        <div className="agent-actions">
          <button type="button" className="btn sm" onClick={() => fileIn.current?.click()}><Icon name="attach" size={14} />{t('agent.attach')}</button>
          <input ref={fileIn} type="file" multiple hidden onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
          <label className="agent-auto small" title={t('agent.auto.hint')}><input type="checkbox" checked={auto} onChange={(e) => toggleAuto(e.target.checked)} />{t('agent.auto')}</label>
          <small className="dim agent-ctx">{t('agent.context')}</small>
          <button type="button" className="agent-send" aria-label={t('agent.send')} disabled={cs.busy || !!cs.job || (!cs.text.trim() && !cs.files.length)} onClick={send}><Icon name="send" size={16} /></button>
        </div>
      </footer>}
    </aside>
  );
}

