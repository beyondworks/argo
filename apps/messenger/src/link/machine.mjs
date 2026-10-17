// 메신저 v2 연결 상태 기계(U5) — 연결·등록·구독·따라잡기·보내기·업로드·배지의 소유자 하나.
// 설계 정본: 볼트 AI-Sessions/conversations/argo/2026-10-17-argo-messenger-redesign-design.md 0절 D7·D10·D15, 4절(실시간), 7절 경우 1·4·5·10·11·18·19, 10절 메모.
//
// 상태: idle → connecting(최소 버전·중단 확인) → registering(msgr2_device_register) → subscribing(u:<uid> 1개) → catching_up(msgr2_catch_up 1회) → ready.
//   끊기면 disconnected — 지수 간격(상한 60초)으로 다시 붙고, 정해진 횟수를 넘으면 타이머 없이 멈춘다(gave_up). online 등 nudge는 간격을 건너뛰지 않는다.
//   background: 앱이 뒤로 가면 소켓을 닫는다(요청 0). 앞으로 오면 구독 → 따라잡기 1회.
//   paused: 서버 중단 스위치(시작 확인·u: 방송·거부 코드 service_paused). 조회·보내기 0. u: 소켓이 열려 있으면 그대로 두고(DB 요청 아님) 풀림 방송을 기다린다.
//   update_required: 최소 버전 미만 — 등록하지 않는다. signed_out: 기기 폐기 — 소켓을 닫고 그 뒤 요청 0.
// 유휴 요청 0: ready에서는 타이머가 하나도 없다(주기 조회·심박·폴링 없음). 서버 커서 행을 쓰지 않고, 마지막으로 받은 글 id는 로컬에 둔다.
// 화면 문자열은 없다 — 상태 코드와 사건만 낸다(문구는 U6이 i18n 사전으로 그린다).
import { SUPPORTED } from '../../../../packages/agent-link/contract/v1.mjs';
import {
  NAMES, USER_EVENTS, STATES, TERMINAL_STATES, RECONNECT, SEND_RETRY, REGISTER_EVERY_MS, SEEN_CAP,
  backoffDelay, belowMin, rejectCodeOf, retryable, normalizeCatchUp, deviceIdOf, pausedOf, uploadPath,
} from './policy.mjs';

export const LAST_ID_KEY = (uid) => `argo-msgr2-last-id:${uid}`;
const BUSY = [STATES.connecting, STATES.registering, STATES.subscribing, STATES.catchingUp];
const DROP_STATUSES = ['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'];

function defaultStorage() { try { return globalThis.localStorage ?? null; } catch { return null; } }
const realClock = { now: () => Date.now(), setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (t) => clearTimeout(t) };
const newId = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID()
  : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = (Math.random() * 16) | 0; return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16); }));

/**
 * opts.client: supabase-js 클라이언트(rpc·from·channel·removeChannel·storage). 시험은 같은 모양의 가짜를 넣는다.
 * opts.userId, opts.appVersion(이 앱 판), opts.pushToken(있으면 등록에 싣는다).
 * opts.storage(localStorage 모양), opts.clock({ now, setTimeout, clearTimeout }), opts.random, opts.names·reconnect·sendRetry(시험·U1~U3 맞춤용).
 */
export function createLinkMachine(opts) {
  const {
    client, userId, appVersion = null, pushToken = null, storage = defaultStorage(), clock = realClock, random = Math.random,
    names = NAMES, reconnect = RECONNECT, sendRetry = SEND_RETRY, registerEveryMs = REGISTER_EVERY_MS,
  } = opts || {};
  if (!client || !userId) throw new Error('link: client and userId are required');

  let state = STATES.idle; let reason = null;
  let foreground = true; let stopped = false; let booted = false;
  let epoch = 0; // 끊김·뒤로 감·폐기 때 올린다 — 그 전에 시작한 비동기 이어짐을 버린다
  let deviceId = null; let registeredAt = 0;
  let uChannel = null; let subscribed = false;
  let reopenedPaused = false;
  let attempts = 0; let timer = null; let nextAt = null; let lastAttemptAt = -Infinity;
  let catching = false; let catchAgain = false;
  let lastId = readLastId();
  const gaps = new Set(); // 방송으로 id만 받고 아직 못 읽은 글 — 따라잡기 since를 그 앞으로 둔다(검수 2: 뒤 글이 lastId를 넘겨 빠지는 것)
  const seen = new Set();
  const unread = new Map(); let activeRoom = null;
  const moreRooms = new Set();
  const watched = new Map(); // workId → { owner, chans: [] }
  const sleeps = new Set(); // 보내기 재시도 대기 — 중단·폐기 때 바로 깨운다
  const listeners = new Map();

  // ── 바깥으로 ────────────────────────────────────────────────────────────────
  function on(type, fn) {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(fn);
    return () => listeners.get(type)?.delete(fn);
  }
  function emit(type, payload) {
    for (const fn of listeners.get(type) || []) { try { fn(payload); } catch { /* 화면 쪽 오류가 연결을 깨지 않게 */ } }
  }
  function setState(next, why = null) {
    if (state === next && reason === why) return;
    state = next; reason = why;
    emit('state', snapshot());
  }
  function snapshot() {
    return {
      state, reason, deviceId, lastId, attempts, nextRetryAt: nextAt, foreground,
      moreRooms: [...moreRooms], badge: badgeOf(),
    };
  }
  const terminal = () => stopped || TERMINAL_STATES.includes(state);

  // ── 로컬 저장(마지막으로 받은 글 id) ─────────────────────────────────────────
  function readLastId() {
    try { const v = Number(storage?.getItem?.(LAST_ID_KEY(userId))); return Number.isSafeInteger(v) && v > 0 ? v : null; } catch { return null; } // 글 id = 정수(bigint, 2^53 안)
  }
  /** 따라잡기 기준 = 받은 최대 id, 단 못 읽은 글이 있으면 그 바로 앞(정수 크기 비교). */
  function sinceId() {
    if (!gaps.size) return lastId;
    const g = Math.min(...gaps) - 1;
    return lastId == null ? (g > 0 ? g : null) : Math.min(lastId, g);
  }
  function writeLastId() {
    const v = sinceId(); if (v == null) return;
    try { storage?.setItem?.(LAST_ID_KEY(userId), String(v)); } catch { /* 저장 못 해도 연결은 된다 — 다음 시작은 최근 글부터 */ }
  }

  // ── 서버 호출 한 겹 — 결과를 { data, code }로 ───────────────────────────────
  async function call(fn, { storage: isStorage = false } = {}) {
    try {
      const r = await fn();
      return { data: r?.data ?? null, code: rejectCodeOf(r?.error, r?.status, { storage: isStorage }) };
    } catch (e) {
      return { data: null, code: rejectCodeOf({ message: String(e?.message ?? e), name: e?.name }, 0, { storage: isStorage }) };
    }
  }

  // ── 타이머·채널 정리 ────────────────────────────────────────────────────────
  function clearTimer() { if (timer != null) clock.clearTimeout(timer); timer = null; nextAt = null; }
  function closeWorks() {
    for (const w of watched.values()) { for (const ch of w.chans) { try { client.removeChannel(ch); } catch { /* 이미 닫힘 */ } } w.chans = []; }
  }
  function closeUser() {
    const ch = uChannel; uChannel = null; subscribed = false;
    if (ch) { try { client.removeChannel(ch); } catch { /* 이미 닫힘 */ } }
  }
  function wakeSleeps() { for (const s of [...sleeps]) s(); sleeps.clear(); }

  // ── 끝 상태 ────────────────────────────────────────────────────────────────
  function toTerminal(next, why) {
    epoch++; clearTimer(); closeWorks(); closeUser(); wakeSleeps();
    setState(next, why);
  }
  const signOut = (why) => toTerminal(STATES.signedOut, why);

  function enterPaused(why) {
    if (terminal()) return;
    epoch++; clearTimer(); closeWorks(); wakeSleeps(); catching = false; catchAgain = false;
    attempts = 0;
    setState(STATES.paused, why); // u: 소켓은 열린 채 둔다 — 풀림 방송(pause:false)을 받는다. DB 요청이 아니다
  }

  /** 서버 거부 코드 공통 처리. 반환 true = 처리했다(호출한 쪽은 더 진행하지 않는다). */
  function handleCode(code, where) {
    if (code === 'update_required' || (where === 'register' && code === 'link_version_unsupported')) { toTerminal(STATES.updateRequired, code); return true; }
    if (code === 'device_revoked') { signOut(code); return true; }
    if (code === 'device_unknown' || code === 'device_expired') {
      if (where === 'register') { signOut(code); return true; }
      deviceId = null; registeredAt = 0; // 한 번 다시 등록한다(폐기된 기기면 등록이 device_revoked로 답한다)
      drop(code); // 소켓을 닫고 간격을 두고 다시 붙는다 — 그때 등록부터 한다
      return true;
    }
    if (code === 'service_paused') { enterPaused('server'); return true; }
    return false;
  }

  // ── 시작 ───────────────────────────────────────────────────────────────────
  async function start() {
    if (stopped || state !== STATES.idle) return snapshot();
    await boot();
    return snapshot();
  }

  async function boot() {
    const gen = ++epoch;
    setState(STATES.connecting, 'boot');
    // 1) 최소 버전(D10). 확인 실패는 판정을 바꾸지 않는다 — 등록 RPC가 같은 값으로 다시 거부한다
    const mv = await call(() => client.rpc(names.minVersionRpc, { p_app: 'messenger' }));
    if (gen !== epoch || terminal()) return;
    if (!mv.code && belowMin(appVersion, mv.data)) { toTerminal(STATES.updateRequired, 'min_version'); return; }
    // 2) v2 중단 스위치(10절 메모 — 옛 앱은 msgr_paused를 읽지 않아 중단 중에도 계속 받았다)
    lastAttemptAt = clock.now();
    const pz = await call(() => client.rpc(names.pauseRpc));
    if (gen !== epoch || terminal()) return;
    if (!pz.code && pausedOf(pz.data)) { enterPaused('server'); return; }
    booted = true;
    if (!foreground) { setState(STATES.background); return; }
    await connect();
  }

  // ── 연결: 등록(필요할 때만) → u:<uid> 구독 → (SUBSCRIBED에서) 따라잡기 1회 ─────────────
  async function connect() {
    if (terminal() || !booted || !foreground || state === STATES.paused) return;
    if (BUSY.includes(state) && state !== STATES.connecting) return;
    clearTimer();
    const gen = ++epoch;
    lastAttemptAt = clock.now();
    if (!deviceId || clock.now() - registeredAt >= registerEveryMs) {
      setState(STATES.registering);
      const r = await call(() => client.rpc(names.registerRpc, registerArgs()));
      if (gen !== epoch || terminal()) return;
      if (r.code) {
        if (handleCode(r.code, 'register')) return;
        if (retryable(r.code)) drop(r.code); else giveUp(r.code);
        return;
      }
      deviceId = deviceIdOf(r.data) ?? deviceId; registeredAt = clock.now();
    }
    setState(STATES.subscribing);
    openUser();
  }

  function registerArgs() {
    // 설계 5절 msgr2_devices 열 — U3의 인자 이름과 맞춘다(PR 본문 "접점")
    return { p_kind: 'app', p_app: 'messenger', p_app_version: appVersion, p_link_min: SUPPORTED.min, p_link_max: SUPPORTED.max, p_runners: [], p_push_token: pushToken };
  }

  function openUser() {
    closeUser();
    const ch = client.channel(names.userTopic(userId), { config: { private: true } });
    uChannel = ch;
    ch.on('broadcast', { event: '*' }, (m) => { if (ch === uChannel) onUserEvent(m); });
    ch.subscribe((status) => {
      if (ch !== uChannel) return; // 우리가 닫은 채널의 CLOSED
      if (status === 'SUBSCRIBED') {
        subscribed = true; // attempts는 따라잡기가 성공한 뒤에만 0으로 — 붙었다 끊김·따라잡기 실패가 되풀이되면 간격이 커지게(검수 1)
        if (state === STATES.paused) { // 중단 중 다시 붙음 — 조회하지 않는다. 끊긴 사이 풀림 방송을 놓쳤을 수 있어 다시 연 때만 중단 표지를 1회 묻는다
          if (reopenedPaused) { reopenedPaused = false; void pauseCheckLive(); }
          return;
        }
        void catchUp();
      } else if (DROP_STATUSES.includes(status)) {
        drop(status.toLowerCase());
      }
    });
  }

  // ── 끊김·재연결 ─────────────────────────────────────────────────────────────
  function drop(why) {
    epoch++; closeWorks(); closeUser(); catching = false; catchAgain = false;
    if (terminal() || !foreground || stopped) return;
    if (state === STATES.paused) { pausedReopen(); return; }
    attempts += 1;
    if (attempts > reconnect.maxAttempts) { giveUp(why); return; }
    clearTimer();
    const d = backoffDelay(attempts - 1, reconnect, random);
    nextAt = clock.now() + d;
    timer = clock.setTimeout(() => { timer = null; nextAt = null; void connect(); }, d);
    setState(STATES.disconnected, why);
  }
  /** 중단 중 u: 소켓이 끊김 — 풀림 방송을 받으려고 소켓만 간격을 두고 다시 연다(REST 0). 상한 횟수를 넘으면 멈추고 nudge·앞으로 옴을 기다린다(검수 3). */
  function pausedReopen() {
    if (!deviceId || !foreground) return; // 등록 전(시작 때 중단)이면 소켓을 열 수 없다 — 앞으로 옴·online 사건에 중단 확인 1회
    attempts += 1;
    clearTimer();
    if (attempts > reconnect.maxAttempts) return;
    const d = backoffDelay(attempts - 1, reconnect, random);
    nextAt = clock.now() + d;
    timer = clock.setTimeout(() => { timer = null; nextAt = null; if (state === STATES.paused && foreground && !terminal()) { lastAttemptAt = clock.now(); reopenedPaused = true; openUser(); } }, d);
  }
  /** 중단 중 소켓을 다시 연 직후 1회: 풀렸으면 따라잡기로 이어 간다(소켓 끊김 한 번당 최대 1요청, 간격·상한 안). */
  async function pauseCheckLive() {
    const ch = uChannel; const gen = epoch;
    const pz = await call(() => client.rpc(names.pauseRpc));
    if (gen !== epoch || ch !== uChannel || terminal() || state !== STATES.paused) return;
    if (!pz.code && !pausedOf(pz.data)) void catchUp();
  }
  function giveUp(why) {
    clearTimer(); closeUser(); closeWorks();
    attempts = Math.max(attempts, reconnect.maxAttempts + 1);
    setState(STATES.disconnected, `gave_up:${why}`);
  }

  /** 이벤트(online·포커스 등) — 대기 중인 간격을 건너뛰지 않는다. 멈춘(gave_up) 상태면 마지막 시도 뒤 상한 간격이 지났을 때만 한 번 시도한다. */
  function nudge() {
    if (terminal() || !foreground) return false;
    if (state === STATES.paused) { // 중단 중 소켓이 없으면(시작 때 중단·소켓 끊김) 풀렸는지 한 번 묻는다 — 상한 간격에 한 번까지
      if (subscribed || timer != null || clock.now() - lastAttemptAt < reconnect.maxMs) return false;
      void recheckPause();
      return true;
    }
    if (!booted) return false;
    if (state !== STATES.disconnected) return false;
    if (timer != null) return false;
    if (clock.now() - lastAttemptAt < reconnect.maxMs) return false;
    void connect();
    return true;
  }

  // ── 앞·뒤 ─────────────────────────────────────────────────────────────────
  async function setForeground(fg) {
    fg = !!fg;
    if (fg === foreground) return;
    foreground = fg;
    if (terminal()) return;
    if (!fg) {
      epoch++; clearTimer(); closeWorks(); closeUser(); wakeSleeps(); catching = false; catchAgain = false;
      attempts = 0;
      if (state !== STATES.paused && state !== STATES.idle) setState(STATES.background);
      return;
    }
    if (state === STATES.idle) return;
    if (state === STATES.paused) { await recheckPause(); return; }
    if (!booted) { await boot(); return; }
    await connect();
  }

  /** 중단 중 앞으로 옴(소켓 없음): 중단 표지를 한 번만 다시 묻는다. 풀렸으면 이어서 연결한다. */
  async function recheckPause() {
    if (subscribed) return; // 소켓이 살아 있으면 방송을 기다린다(요청 0)
    const gen = ++epoch;
    lastAttemptAt = clock.now();
    const pz = await call(() => client.rpc(names.pauseRpc));
    if (gen !== epoch || terminal() || !foreground) return;
    if (pz.code || pausedOf(pz.data)) { // 여전히 중단(또는 확인 실패) — 등록된 기기면 소켓만 열어 풀림 방송을 기다린다(REST 0)
      if (deviceId && !uChannel) { attempts = 0; openUser(); }
      return;
    }
    booted = true;
    setState(STATES.connecting, 'resume');
    await connect();
  }

  // ── 따라잡기 ───────────────────────────────────────────────────────────────
  async function catchUp() {
    if (catching) { catchAgain = true; return; }
    catching = true;
    const ch = uChannel; const gen = epoch;
    setState(STATES.catchingUp);
    try {
      do {
        catchAgain = false;
        const since = sinceId(); const asked = new Set(gaps);
        const r = await call(() => client.rpc(names.catchUpRpc, { p_since_id: since }));
        if (gen !== epoch || ch !== uChannel || terminal()) return;
        if (r.code) {
          if (handleCode(r.code, 'catch_up')) return;
          drop(r.code); return; // 다시 붙을 때 다시 따라잡는다 — 간격·상한(8회) 안이라 폭주하지 않고, 만료 토큰 401 같은 일시 거부도 회복할 시간을 준다(재검수 1)
        }
        const n = normalizeCatchUp(r.data);
        if (n.paused) { enterPaused('server'); return; }
        for (const id of asked) gaps.delete(id); // 이 따라잡기가 빈 곳을 덮었다
        for (const room of n.rooms) deliver(room.roomId, room.messages, { more: room.more, source: 'catch_up' });
      } while (catchAgain);
    } finally {
      if (gen === epoch) catching = false;
    }
    if (gen !== epoch || ch !== uChannel || terminal() || state === STATES.paused) return;
    attempts = 0;
    setState(STATES.ready);
    for (const id of watched.keys()) joinWork(id);
  }

  // ── 글 받기(중복 0) ─────────────────────────────────────────────────────────
  function remember(id) {
    seen.add(id);
    if (seen.size > SEEN_CAP) { const drop = [...seen].sort((a, b) => a - b).slice(0, seen.size - SEEN_CAP); for (const x of drop) seen.delete(x); }
  }
  function deliver(roomId, messages, { more = false, source }) {
    const fresh = [];
    for (const m of messages) {
      const id = Number(m.id);
      if (!Number.isSafeInteger(id) || seen.has(id)) continue; // 글 id는 정수 — 크기로 비교한다
      remember(id); fresh.push(m);
      if (lastId == null || id > lastId) lastId = id;
      if (m.author_user_id !== userId && roomId !== activeRoom) unread.set(roomId, (unread.get(roomId) || 0) + 1);
    }
    if (more) moreRooms.add(roomId);
    if (fresh.length || more) {
      writeLastId();
      emit('messages', { roomId, messages: fresh, more, source });
      if (fresh.some((m) => m.author_user_id !== userId) && roomId !== activeRoom) emit('badge', badgeOf());
    }
  }

  async function onUserEvent(m) {
    const ev = String(m?.event ?? '').toLowerCase();
    const payload = m?.payload ?? {};
    if (ev === USER_EVENTS.pause) {
      if (pausedOf(payload)) { enterPaused('server'); return; }
      if (state === STATES.paused && subscribed) { attempts = 0; void catchUp(); }
      return;
    }
    if (ev === USER_EVENTS.deviceRevoked) {
      if (payload.all === true || (deviceId && payload.device_id === deviceId)) { signOut('device_revoked'); return; }
      if (state !== STATES.paused) emit('event', { event: ev, payload }); // 다른 기기 폐기 — 기기 목록 화면용
      return;
    }
    if (state === STATES.paused) return; // 중단 중에는 받은 표지로 조회하지 않는다(풀린 뒤 따라잡기가 가져온다)
    if (ev === USER_EVENTS.message) {
      const msg = payload.message ?? payload;
      const id = Number(msg?.id);
      if (!msg || !Number.isSafeInteger(id) || !msg.room_id) return;
      const update = !!(msg.deleted_at || msg.edited_at); // 고침·지움은 같은 id로 다시 온다 — 중복 거르기를 지나 갱신으로 낸다(검수 4)
      if (!update && (seen.has(id) || gaps.has(id))) return;
      let row = msg;
      if (msg.body === undefined && !msg.deleted_at) {
        // 본문이 4KB를 넘어 id만 왔다 — 이 글 하나만 읽는다(설계 4절 "받는 쪽 1요청")
        if (!update) gaps.add(id);
        const gen = epoch;
        const r = await call(() => client.from(names.messages).select('*').eq('id', id).maybeSingle());
        if (gen !== epoch || terminal() || state === STATES.paused) return; // gaps에 남는다 — 다음 따라잡기가 그 앞부터 가져온다
        if (r.code) { if (!handleCode(r.code, 'fetch')) drop(r.code); return; } // 못 읽음: 간격을 두고 다시 붙어 따라잡기로 가져온다
        gaps.delete(id);
        if (!r.data) { writeLastId(); return; }
        row = r.data;
      }
      if (update) { remember(id); emit('messages', { roomId: row.room_id, messages: [row], more: false, source: 'update' }); return; }
      deliver(row.room_id, [row], { source: 'broadcast' });
      return;
    }
    emit('event', { event: ev, payload });
  }

  // ── 배지 ──────────────────────────────────────────────────────────────────
  function badgeOf() {
    let total = 0; const rooms = {};
    for (const [r, n] of unread) { rooms[r] = n; total += n; }
    return { total, rooms };
  }
  function setActiveRoom(roomId) {
    activeRoom = roomId ?? null;
    if (roomId && unread.delete(roomId)) emit('badge', badgeOf());
  }
  function clearMore(roomId) { moreRooms.delete(roomId); }

  // ── 일 화면(진행·접속 표시) — 볼 때만 구독한다 ─────────────────────────────────
  function joinWork(workId) {
    const w = watched.get(workId);
    if (!w || w.chans.length || state !== STATES.ready) return;
    const ch = client.channel(names.workTopic(workId), { config: { private: true } });
    ch.on('broadcast', { event: '*' }, (m) => emit('progress', { workId, event: String(m?.event ?? '').toLowerCase(), payload: m?.payload ?? {} }));
    ch.subscribe(() => {}); // 끊기면 u:가 다시 붙을 때 함께 다시 가입한다(따로 재시도하지 않는다)
    w.chans.push(ch);
    if (w.owner) {
      const pr = client.channel(names.presenceTopic(w.owner), { config: { private: true } });
      pr.on('presence', { event: 'sync' }, () => emit('presence', { owner: w.owner, state: pr.presenceState?.() ?? {} }));
      pr.subscribe(() => {});
      w.chans.push(pr);
    }
  }
  function watchWork(workId, { owner = null } = {}) {
    if (!workId || terminal()) return () => {};
    if (!watched.has(workId)) watched.set(workId, { owner, chans: [] });
    joinWork(workId);
    return () => {
      const w = watched.get(workId); if (!w) return;
      for (const ch of w.chans) { try { client.removeChannel(ch); } catch { /* 이미 닫힘 */ } }
      watched.delete(workId);
    };
  }

  // ── 보내기·업로드 ───────────────────────────────────────────────────────────
  function sendBlock() {
    if (stopped) return 'stopped';
    if (!foreground) return 'background'; // 뒤로 간 앱은 보내기·재시도를 멈춘다(검수 5) — 화면이 같은 client_msg_id로 다시 보낸다
    if (state === STATES.paused) return 'service_paused';
    if (state === STATES.updateRequired) return 'update_required';
    if (state === STATES.signedOut) return 'device_revoked';
    if (!deviceId) return 'not_registered';
    return null;
  }
  function sleep(ms) {
    return new Promise((resolve) => {
      let t = null;
      const wake = () => { if (t != null) clock.clearTimeout(t); sleeps.delete(wake); resolve(); };
      sleeps.add(wake);
      t = clock.setTimeout(wake, ms);
    });
  }

  async function sendOnce({ roomId, body, clientMsgId, topicId, replyTo, files }, attempt) {
    const ups = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const path = uploadPath(roomId, clientMsgId, i, f.name);
      const up = await call(() => client.storage.from(names.bucket).upload(path, f.data, { contentType: f.mime || undefined, upsert: false }), { storage: true });
      if (up.code && up.code !== 'duplicate') return { ok: false, code: up.code };
      ups.push({ storage_path: path, name: String(f.name || ''), mime: f.mime || null, bytes: Number.isFinite(f.bytes) ? f.bytes : null });
    }
    const row = { room_id: roomId, author_kind: 'user', author_user_id: userId, kind: 'text', body, client_msg_id: clientMsgId };
    if (topicId != null) row.topic_id = topicId;
    if (replyTo != null) row.reply_to = replyTo;
    const ins = await call(() => client.from(names.messages).insert(row).select('id').single());
    let id = ins.data?.id ?? null; let duplicate = false;
    if (ins.code === 'duplicate') {
      duplicate = true;
      if (ups.length) {
        const q = await call(() => client.from(names.messages).select('id').eq('room_id', roomId).eq('client_msg_id', clientMsgId).maybeSingle());
        if (q.code) return { ok: false, code: q.code };
        id = q.data?.id ?? null;
      }
    } else if (ins.code) return { ok: false, code: ins.code };
    if (ups.length && id != null) {
      let missing = ups;
      if (duplicate || attempt > 0) { // 앞선 시도가 첨부 행을 이미 넣었을 수 있다 — 빠진 것만 넣는다(첨부 표에는 유일 키가 없다)
        const ex = await call(() => client.from(names.attachments).select('storage_path').eq('message_id', id));
        if (ex.code) return { ok: false, code: ex.code };
        const have = new Set((ex.data || []).map((r) => r.storage_path));
        missing = ups.filter((u) => !have.has(u.storage_path));
      }
      if (missing.length) {
        const a = await call(() => client.from(names.attachments).insert(missing.map((u) => ({ ...u, message_id: id, room_id: roomId }))));
        if (a.code) return { ok: false, code: a.code };
      }
    }
    return { ok: true, id, duplicate };
  }

  /**
   * 사람 글 보내기. client_msg_id로 멱등(같은 id로 다시 보내면 서버 유일 키가 한 벌만 남긴다).
   * 다시 보내는 것은 약속의 retry 표시가 참인 코드(rate_limited·internal)뿐이고 간격·상한(SEND_RETRY)을 둔다.
   * files: [{ name, mime, bytes, data(Blob·File·ArrayBuffer) }] — 같은 글의 같은 파일은 같은 경로라 다시 올려도 한 벌이다.
   * 반환: { ok, clientMsgId, id?, duplicate?, code?, attempts }.
   */
  async function send({ roomId, body = '', clientMsgId = newId(), topicId = null, replyTo = null, files = [] } = {}) {
    const blocked = sendBlock();
    if (blocked || !roomId) return { ok: false, clientMsgId, code: blocked || 'invalid_envelope', attempts: 0 };
    emit('send', { clientMsgId, roomId, status: 'sending' });
    let last = null; let n = 0;
    for (; n < sendRetry.maxAttempts; n++) {
      const b = sendBlock();
      if (b) { last = b; break; }
      const r = await sendOnce({ roomId, body, clientMsgId, topicId, replyTo, files: files || [] }, n);
      if (r.ok) {
        const out = { ok: true, clientMsgId, id: r.id, duplicate: r.duplicate, attempts: n + 1 };
        emit('send', { clientMsgId, roomId, status: 'sent', id: r.id });
        return out;
      }
      last = r.code;
      if (handleCode(r.code, 'send')) { n++; break; } // 폐기·중단·업데이트·기기 다시 등록 — 다시 보내지 않는다
      if (!retryable(r.code)) { n++; break; }
      if (n + 1 < sendRetry.maxAttempts) await sleep(backoffDelay(n, sendRetry, random));
    }
    const out = { ok: false, clientMsgId, code: last, attempts: n };
    emit('send', { clientMsgId, roomId, status: 'failed', code: last }); // 화면은 같은 client_msg_id로 다시 보낼 수 있다(멱등)
    return out;
  }

  // ── 그만 ──────────────────────────────────────────────────────────────────
  function stop() {
    if (stopped) return;
    epoch++; clearTimer(); closeWorks(); closeUser(); wakeSleeps();
    for (const id of [...watched.keys()]) watched.delete(id);
    stopped = true;
    setState(STATES.disconnected, 'stopped');
  }

  return {
    start, stop, setForeground, nudge, send, watchWork, setActiveRoom, clearMore, on,
    getState: () => state, getSnapshot: snapshot,
  };
}
