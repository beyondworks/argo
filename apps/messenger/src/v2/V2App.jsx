// 메신저 v2 셸(U6b) — 옵트인 플래그(src/v2/flag.mjs)가 켜졌을 때만 기존 Shell 대신 그린다. 기본(꺼짐)은 지금 앱 그대로.
// 화면 방향(유건 결정 2026-10-17 "추천대로"): 기존 화면 모양을 그대로 쓰고(같은 클래스·같은 배치), 새 구조 때문에 꼭 필요한 곳만 바꾼다.
//   ① 공간 목록 통합: 개인·팀 공간을 사이드바의 공간 메뉴 하나로(기존 조직 전환 메뉴와 같은 모양).
//   ② 일 카드: 에이전트 일 1건 = 토픽 하나. 기존 메시지 목록 안, 시킨 글 아래에 승인 카드(msgr-slip) 모양으로. 시스템 글은 코드 + 값 → 사전 문구(D15).
// 서버와는 연결 상태 기계(src/link/machine.mjs)를 통해서만 실시간·보내기를 하고, 화면을 열 때·사건이 왔을 때만 data.mjs로 읽는다(주기 조회 없음).
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ConfirmModal, Markdown } from '@argo/ui';
import { I, STAR_D } from '../icons.jsx';
import { createLinkMachine } from '../link/machine.mjs';
import { bindLifecycle } from '../link/lifecycle.mjs';
import { STATES } from '../link/policy.mjs';
import { markAppReady } from '../splash.js';
import { spaceList, liveSpaceIds, pickStartSpace } from './spaces.mjs';
import { systemLine } from './system-text.mjs';
import { workCard, timeline } from './work-card.mjs';
import { loadSpaces, loadRooms, loadRoom, loadWorks, workStatus, cancelWork, decideApproval, mentionsOf } from './data.mjs';

const LAST_SPACE = (uid) => `argo-msgr2-last-space:${uid}`;
const LAST_ROOM = (uid, space) => `argo-msgr2-last-room:${uid}:${space}`;
const readLS = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const writeLS = (k, v) => { try { localStorage.setItem(k, v); } catch { /* 이 기기에 못 남겨도 화면은 된다 */ } };
const fmtTime = (iso, lang) => { try { return new Date(iso).toLocaleTimeString(lang === 'en' ? 'en-US' : 'ko-KR', { hour: '2-digit', minute: '2-digit' }); } catch { return ''; } };
const shortId = (id) => String(id || '').slice(0, 4);

/** 첫 글자 원(사람) / 타일(에이전트) — 기존 msgr-av 모양 */
function Av({ name, agent = false }) {
  return <span className={`msgr-av${agent ? ' crew' : ''}`} aria-hidden="true">{String(name || '?').trim().slice(0, 1).toUpperCase()}</span>;
}

export function V2App({ session, supabase, t, lang, appVersion }) {
  const uid = session.user.id;
  const machine = useMemo(() => createLinkMachine({ client: supabase, userId: uid, appVersion }), [supabase, uid, appVersion]);
  const [conn, setConn] = useState(() => machine.getSnapshot());
  const [spaces, setSpaces] = useState(null);
  const [spaceId, setSpaceId] = useState(null);
  const [menu, setMenu] = useState(false);
  const [rail, setRail] = useState(false); // 좁은 화면: 사이드바 서랍(기존 rail-open과 같다)
  const [rooms, setRooms] = useState(null); // { rooms, members, agents }
  const [roomId, setRoomId] = useState(null);
  const [room, setRoom] = useState(null); // { messages, attachments, works, approvals, more }
  const [progress, setProgress] = useState(() => new Map());
  const [effects, setEffects] = useState(() => new Map()); // 일 id → msgr2_work_status effects(결과 모름 카드를 펼칠 때만)
  const [err, setErr] = useState('');
  const roomRef = useRef(null); roomRef.current = roomId;
  const threadRef = useRef(null); const stick = useRef(true); // 맨 아래에 있으면 새 글이 와도 맨 아래를 따라간다(기존 채널과 같다)

  // ── 연결 ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    const offs = [
      machine.on('state', setConn),
      machine.on('messages', ({ roomId: r, messages }) => {
        if (r !== roomRef.current || !messages.length) return;
        setRoom((cur) => {
          if (!cur) return cur;
          const byId = new Map(cur.messages.map((m) => [Number(m.id), m]));
          for (const m of messages) byId.set(Number(m.id), { ...byId.get(Number(m.id)), ...m });
          return { ...cur, messages: [...byId.values()].sort((a, b) => Number(a.id) - Number(b.id)) };
        });
        // 일·시스템·카드 글이 오면 그 방의 일·승인을 한 번 다시 읽는다(일 상태는 방송이 없다 — 글이 표지)
        if (messages.some((m) => m.work_id || m.author_kind !== 'user' || (m.mentions && m.mentions.length))) void refreshWorks(r);
      }),
      machine.on('attachments', ({ roomId: r, attachments }) => {
        if (r !== roomRef.current) return;
        setRoom((cur) => cur && { ...cur, attachments: dedupe([...cur.attachments, ...attachments.map(attRow)]) });
      }),
      machine.on('progress', ({ workId, payload }) => setProgress((p) => new Map(p).set(workId, { stage: payload?.stage, note: payload?.note }))),
    ];
    const unbind = bindLifecycle(machine);
    void machine.start();
    return () => { offs.forEach((f) => f()); unbind(); machine.stop(); };
  }, [machine]); // eslint-disable-line react-hooks/exhaustive-deps

  // 스플래시 준비 신호 — 공간 목록을 받았거나 받지 못해 안내를 보여야 할 때(기존 셸과 같은 기준: 스플래시 뒤에 갇히지 않게)
  useEffect(() => { if (spaces !== null || err) markAppReady(); }, [spaces, err]);

  // ── 공간 ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    let alive = true;
    loadSpaces(supabase, uid).then((d) => {
      if (!alive) return;
      const list = spaceList(d);
      setSpaces(list);
      machine.setSpaces(liveSpaceIds(list));
      setSpaceId(pickStartSpace(list, readLS(LAST_SPACE(uid))));
    }).catch(() => alive && setErr('v2.conn.gaveUp'));
    return () => { alive = false; };
  }, [supabase, uid, machine]);

  useEffect(() => {
    if (!spaceId) return undefined;
    let alive = true;
    writeLS(LAST_SPACE(uid), spaceId);
    setRooms(null); setRoom(null);
    loadRooms(supabase, spaceId).then((d) => {
      if (!alive) return;
      setRooms(d);
      const last = readLS(LAST_ROOM(uid, spaceId));
      setRoomId(d.rooms.some((r) => r.id === last) ? last : d.rooms[0]?.id ?? null);
    }).catch(() => alive && setErr('v2.conn.gaveUp'));
    return () => { alive = false; };
  }, [supabase, uid, spaceId]);

  // ── 방 ───────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!roomId) return undefined;
    let alive = true;
    writeLS(LAST_ROOM(uid, spaceId), roomId);
    machine.setActiveRoom(roomId);
    setRoom(null);
    loadRoom(supabase, roomId).then((d) => alive && setRoom({ ...d, attachments: d.attachments.map(attRow) })).catch(() => alive && setErr('v2.conn.gaveUp'));
    return () => { alive = false; machine.setActiveRoom(null); };
  }, [supabase, uid, spaceId, roomId, machine]);

  const refreshWorks = useCallback(async (r) => {
    try { const d = await loadWorks(supabase, r); if (r === roomRef.current) setRoom((cur) => cur && { ...cur, ...d }); } catch { /* 다음 표지에 다시 읽는다 */ }
  }, [supabase]);

  // 진행 중인 일은 볼 때만 v2:wk:를 구독한다(상태 기계가 ready에서만 가입)
  const liveWorkIds = useMemo(() => (room?.works ?? []).filter((w) => ['accepted', 'running', 'awaiting_approval'].includes(w.state)).map((w) => w.id).sort().join(','), [room?.works]);
  useEffect(() => {
    if (!liveWorkIds) return undefined;
    const offs = liveWorkIds.split(',').map((id) => machine.watchWork(id));
    return () => offs.forEach((f) => f());
  }, [liveWorkIds, machine]);

  // ── 이름 ─────────────────────────────────────────────────────────────────
  const agentById = useMemo(() => new Map((rooms?.agents ?? []).map((a) => [a.id, a])), [rooms]);
  const roomAgents = useMemo(() => {
    const ids = new Set((rooms?.members ?? []).filter((m) => m.room_id === roomId && m.member_kind === 'agent').map((m) => m.member_id));
    return [...ids].map((id) => agentById.get(id)).filter(Boolean);
  }, [rooms, roomId, agentById]);
  // 사람 이름은 v2 표에 아직 없다(U6b 미룸) — 나는 '나', 다른 사람은 짧은 식별자
  const nameOf = useCallback((kind, id) => (kind === 'agent' ? (agentById.get(id)?.display_name || agentById.get(id)?.slug || shortId(id)) : id === uid ? t('v2.me') : `${t('v2.member')} ${shortId(id)}`), [agentById, uid, t]);
  const roomName = (r) => (r.kind === 'direct' ? t('v2.room.direct') : r.name || t('v2.room.direct'));
  const space = spaces?.find((s) => s.id === spaceId);
  const spaceName = (s) => (s?.personal ? t('v2.space.personal') : s?.name || '');

  // ── 보내기 ───────────────────────────────────────────────────────────────
  const [draft, setDraft] = useState('');
  const [sendErr, setSendErr] = useState(null); // { body, clientMsgId, code }
  const send = async (again = null) => {
    const body = again ? again.body : draft.trim();
    if (!body || !roomId) return;
    if (!again) setDraft('');
    setSendErr(null);
    const r = await machine.send({ roomId, body, clientMsgId: again?.clientMsgId, mentions: mentionsOf(body, roomAgents) });
    if (!r.ok) setSendErr({ body, clientMsgId: r.clientMsgId, code: r.code });
    else if (r.id != null) setRoom((cur) => cur && !cur.messages.some((m) => Number(m.id) === Number(r.id)) ? { ...cur, messages: [...cur.messages, { id: r.id, room_id: roomId, author_kind: 'user', author_user_id: uid, kind: 'text', body, meta: {}, created_at: new Date().toISOString(), client_msg_id: r.clientMsgId }] } : cur);
  };

  // ── 일 카드 동작 ─────────────────────────────────────────────────────────
  const [cancelAsk, setCancelAsk] = useState(null);
  const [busy, setBusy] = useState(null);
  const decide = async (card, decision) => {
    if (busy) return;
    setBusy(`${card.workId}:${decision}`);
    try { await decideApproval(supabase, card.approval.id, decision); await refreshWorks(roomId); } catch { setErr('v2.ap.failed'); } finally { setBusy(null); }
  };
  const doCancel = async () => {
    const card = cancelAsk; if (!card) return;
    setBusy(`${card.workId}:cancel`);
    try { await cancelWork(supabase, card.workId); await refreshWorks(roomId); setCancelAsk(null); } catch { setErr('v2.work.cancel.failed'); } finally { setBusy(null); }
  };
  const loadEffects = async (workId) => { try { const s = await workStatus(supabase, workId); setEffects((m) => new Map(m).set(workId, s?.effects ?? [])); } catch { /* 표시만 못 한다 */ } };

  // 방을 열면 맨 아래(최근 글)로, 맨 아래에 있었다면 새 글·카드가 와도 따라간다
  useEffect(() => { stick.current = true; }, [roomId]);
  useLayoutEffect(() => { const el = threadRef.current; if (el && stick.current) el.scrollTop = el.scrollHeight; }, [room, effects, progress]); // 카드 내용이 늦게 채워져도 맨 아래를 지킨다
  const onScroll = (e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; };

  // ── 그리기 ───────────────────────────────────────────────────────────────
  const items = room ? timeline(room.messages, room.works) : [];
  const attOf = (mid) => (room?.attachments ?? []).filter((a) => Number(a.message_id) === Number(mid));
  const approvalOf = (wid) => (room?.approvals ?? []).filter((a) => a.work_id === wid).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0] ?? null;

  const connLine = conn.state === STATES.disconnected ? (String(conn.reason || '').startsWith('gave_up') ? 'v2.conn.gaveUp' : 'v2.conn.disconnected')
    : [STATES.connecting, STATES.registering, STATES.subscribing].includes(conn.state) ? 'v2.conn.connecting'
    : conn.state === STATES.paused ? 'v2.state.paused' : conn.state === STATES.updateRequired ? 'v2.state.update' : conn.state === STATES.signedOut ? 'v2.state.signedOut' : null;

  return (
    <div className={`shell msgr-shell msgr-v2${rail ? ' rail-open' : ''}`} data-v2="1">
      {rail && <div className="msgr-scrim" onClick={() => setRail(false)} role="presentation" />}
      <aside id="msgr-navigation" className={`side msgr-side${menu ? ' menu-open' : ''}`}>
        <button type="button" className="msgr-rail-close" onClick={() => setRail(false)} aria-label={t('ui.close')}><I name="x" /></button>
        <div className="msgr-brand"><svg width="14" height="14" viewBox="0 0 16 16"><path d={STAR_D} /></svg>ARGO</div>
        <div className="msgr-orgwrap">
          <button type="button" className={`msgr-org${menu ? ' open' : ''}${space?.personal ? ' personal' : ''}`} onClick={() => setMenu((v) => !v)} aria-haspopup="menu" aria-expanded={menu} title={t('v2.space.switch')}>
            <Av name={spaceName(space) || '·'} /><span className="name">{spaceName(space)}</span><I name="caret" size={14} className="caret" />
          </button>
          {menu && (<>
            <div className="msgr-scrim clear" onClick={() => setMenu(false)} />
            <div className="msgr-menu-pop" role="menu">
              {(spaces ?? []).map((s, i) => (
                <span key={s.id} style={{ display: 'contents' }}>
                  {i === 1 && <div className="sep" />}
                  <button type="button" role="menuitemradio" aria-checked={s.id === spaceId} className={s.id === spaceId ? 'on' : ''} onClick={() => { setSpaceId(s.id); setMenu(false); }}>
                    <Av name={spaceName(s)} /><span className="label">{spaceName(s)}</span>{!s.personal && <span className="msgr-klabel">{t(`v2.space.role.${s.role}`)}</span>}
                  </button>
                </span>
              ))}
            </div>
          </>)}
        </div>
        <div className="msgr-railbody"><div className="msgr-railinner">
          <div className="msgr-group"><span className="label">{t('v2.rooms')}</span></div>
          <div className="msgr-list">
            {rooms && rooms.rooms.length === 0 && <p className="msgr-klabel" style={{ padding: '6px 12px' }}>{t('v2.rooms.empty')}</p>}
            {(rooms?.rooms ?? []).map((r) => (
              <div key={r.id} className="msgr-railrow">
                <button type="button" className={`item${r.id === roomId ? ' active' : ''}${conn.badge?.rooms?.[r.id] ? ' unread' : ''}`} onClick={() => { setRoomId(r.id); setRail(false); }}>
                  <I name={r.kind === 'direct' ? 'at' : r.kind === 'private' ? 'lock' : 'hash'} size={14} /><span className="name">{roomName(r)}</span>
                  {conn.badge?.rooms?.[r.id] ? <span className="msgr-badge mark">{conn.badge.rooms[r.id]}</span> : null}
                </button>
              </div>
            ))}
          </div>
        </div></div>
      </aside>
      <main className="msgr-main">
        <div className="msgr-top"><button type="button" className="msgr-menu" onClick={() => setRail(true)} aria-controls="msgr-navigation" aria-label={t('ui.menu')}><I name="menu" size={16} /></button><span className="title">{rooms?.rooms.find((r) => r.id === roomId) ? roomName(rooms.rooms.find((r) => r.id === roomId)) : t('v2.room.pick')}</span>{space && <span className="topic">{spaceName(space)}</span>}</div>
        {connLine && <div className="msgr-offline-bar" role="status">{t(connLine)}{conn.state === STATES.disconnected && <button type="button" className="btn sm ghost" onClick={() => machine.nudge()}>{t('v2.conn.retry')}</button>}</div>}
        {err && <button type="button" className="msgr-toast err" role="alert" onClick={() => setErr('')}>{t(err)}</button>}
        <div className="msgr-thread" ref={threadRef} onScroll={onScroll}>
          {!roomId ? <div className="msgr-empty"><p>{t('v2.room.pick')}</p></div>
            : !room ? <div className="msgr-empty"><span className="msgr-spin" aria-label={t('v2.conn.connecting')} /></div>
            : items.length === 0 ? <div className="msgr-empty"><p>{t('v2.room.empty')}</p></div>
            : <div className="msgr-rows-v2">
              {items.map((it) => it.type === 'msg'
                ? <Row key={`m${it.m.id}`} m={it.m} uid={uid} t={t} lang={lang} nameOf={nameOf} atts={attOf(it.m.id)} />
                : <WorkCard key={`w${it.work.id}`} card={workCard({ work: it.work, approval: approvalOf(it.work.id), progress: progress.get(it.work.id), effects: effects.get(it.work.id) ?? [], uid })}
                    t={t} nameOf={nameOf} busy={busy} onDecide={decide} onCancel={setCancelAsk} onEffects={loadEffects} />)}
            </div>}
        </div>
        {roomId && (
          <div className="msgr-dock"><div>
            {sendErr && <div className="msgr-delivery" role="alert"><span>{t(sendErr.code === 'invalid_attachment' ? 'v2.compose.badFile' : 'v2.compose.failed')}</span><button type="button" className="btn sm" onClick={() => send(sendErr)}>{t('v2.compose.resend')}</button></div>}
            <form className="msgr-v2-compose" onSubmit={(e) => { e.preventDefault(); void send(); }}>
              <textarea className="msgr-input" rows={1} value={draft} placeholder={t('v2.compose.placeholder')} onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }} aria-label={t('v2.compose.placeholder')} />
              <button type="submit" className="btn btn-primary" disabled={!draft.trim()} aria-label={t('v2.compose.send')}><I name="up" size={16} /></button>
            </form>
          </div></div>
        )}
      </main>
      {cancelAsk && <ConfirmModal title={t('v2.work.cancel.title')} description={t('v2.work.cancel.desc')} confirmLabel={t('v2.work.cancel.confirm')} busy={busy === `${cancelAsk.workId}:cancel`} onConfirm={doCancel} onClose={() => setCancelAsk(null)} />}
    </div>
  );
}

function attRow(a) { return a.storage_path ? a : { ...a, storage_path: `${a.bucket}/${a.path}` }; }
function dedupe(list) { const seen = new Set(); return list.filter((a) => (seen.has(a.id) ? false : (seen.add(a.id), true))); }

function Row({ m, uid, t, lang, nameOf, atts }) {
  const mine = m.author_kind === 'user' && m.author_user_id === uid;
  const files = atts.length > 0 && <span className="msgr-filechips msgr-v2-files">{atts.map((a) => <span key={a.id} className="filechip"><I name="ffile" size={12} /><span className="filechip-name">{a.name}</span></span>)}</span>;
  if (m.kind === 'system' || m.author_kind === 'system') {
    const line = systemLine(m.meta, nameOf);
    return <div className="msgr-sys" data-mid={m.id}>{line ? t(line.key, line.vars) : ''}{line?.late && <span className="msgr-klabel"> · {t('v2.work.late')}</span>}</div>;
  }
  if (m.deleted_at) return <div className="msgr-sys" data-mid={m.id}>{t('v2.msg.deleted')}</div>;
  if (mine) return (
    <div className="msgr-mine" data-mid={m.id}>
      <div className="bubble">{m.body}</div>
      {files}
      <div className="meta"><span className="sent">{fmtTime(m.created_at, lang)}</span></div>
    </div>
  );
  const agent = m.author_kind === 'agent';
  const name = agent ? nameOf('agent', m.author_agent_id) : nameOf('user', m.author_user_id);
  return (
    <div className="msgr-row" data-mid={m.id}>
      <Av name={name} agent={agent} />
      <div className="msgr-col">
        <div className="who">{name}<span className="role">{fmtTime(m.created_at, lang)}</span>{m.meta?.mark === 'work.late' && <span className="msgr-klabel"> · {t('v2.work.late')}</span>}</div>
        {agent ? <div className="msgr-sheet"><Markdown text={m.body || ''} /></div> : <div className="text">{m.body}</div>}
        {files}
      </div>
    </div>
  );
}

function WorkCard({ card, t, nameOf, busy, onDecide, onCancel, onEffects }) {
  const agent = nameOf('agent', card.agentId);
  const ap = card.approval;
  const tone = card.phase === 'approval' ? 'pending' : ['done'].includes(card.phase) ? 'approved' : ['failed', 'unknown'].includes(card.phase) ? 'rejected' : 'expired';
  const icon = { waiting: 'clock', received: 'check', working: 'node', approval: 'stamp', done: 'check', failed: 'x', cancelled: 'x', expired: 'clock', unknown: 'clock' }[card.phase] ?? 'node';
  useEffect(() => { if (card.phase === 'unknown') onEffects(card.workId); }, [card.phase, card.workId]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className={`msgr-slip msgr-v2-work ${tone} phase-${card.phase}`} role="group" aria-label={t('v2.work.agent', { agent })} data-work={card.workId}>
      <div className="band"><I name={icon} size={14} /><span className="v2-band-text">{t('v2.work.agent', { agent })} · {t(`v2.work.${card.phase}`)}</span>{card.late && <span className="msgr-klabel risk">{t('v2.work.late')}</span>}</div>
      {(card.stage || card.error || card.unknownEffects.length > 0 || ap || card.canCancel) && <div className="body">
        {card.stage && <div className="reason">{t(`v2.work.stage.${card.stage}`)}</div>}
        {card.error && <div className="reason">{t(`v2.sys.error.${card.error}`, { agent })}</div>}
        {card.unknownEffects.length > 0 && <div className="reason">{t('v2.work.unknownEffects', { list: card.unknownEffects.join(', ') })}</div>}
        {ap && (<>
          <div className="msgr-klabel">{t('v2.ap.request')} · {t(`v2.ap.risk.${ap.risk}`)}</div>
          <div className="action">{ap.action}</div>
          {ap.summary && <div className="reason">{ap.summary}</div>}
        </>)}
        <div className="row2">
          {ap && card.canDecide && (<>
            <button type="button" className="btn btn-primary sm" disabled={!!busy} onClick={() => onDecide(card, 'approve')}>{busy === `${card.workId}:approve` ? <span className="msgr-spin sm" aria-hidden="true" /> : <I name="check" size={13} />}{t(busy === `${card.workId}:approve` ? 'v2.ap.deciding' : 'v2.ap.approve')}</button>
            <button type="button" className="btn sm" disabled={!!busy} onClick={() => onDecide(card, 'reject')}>{busy === `${card.workId}:reject` ? <span className="msgr-spin sm" aria-hidden="true" /> : <I name="x" size={13} />}{t(busy === `${card.workId}:reject` ? 'v2.ap.deciding' : 'v2.ap.reject')}</button>
          </>)}
          {ap && ap.state === 'pending' && !card.canDecide && <span className="note">{t('v2.ap.ownerOnly')}</span>}
          {ap && ap.state !== 'pending' && <span className={`msgr-seal${ap.state === 'approved' ? ' ok' : ap.state === 'rejected' ? ' no' : ''}`}>{t(`v2.ap.${ap.state}`)}</span>}
          {card.canCancel && <button type="button" className="btn sm ghost" disabled={!!busy} onClick={() => onCancel(card)}><I name="x" size={13} />{t('v2.work.cancel')}</button>}
        </div>
      </div>}
    </div>
  );
}
