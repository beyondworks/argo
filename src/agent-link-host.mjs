// 본체 ↔ agent-link 연결부(메신저 v2, 설계 2026-10-17 3절·U4). packages/agent-link/link.mjs에 Supabase 연결과 Argo 턴 실행을 넣는다.
// 옵트인: ARGO_AGENT_LINK=1일 때만 켠다(기본 꺼짐 — 지금 배포본 동작 그대로). 옛 메신저 브리지는 ARGO_MSGR_LEGACY=off일 때만 끈다(기본 켜짐).
// 두 플래그는 따로다: 새 링크를 켜도 옛 브리지는 그대로 돈다(옛 표는 서버의 중단 스위치가 막는다). 옛 브리지를 끄는 것은 이전이 끝난 뒤의 일이다.
//
// 턴은 범위 턴(mirrorCtx {kind:'scope', scope:{kind:'link', work, room, owner}})으로 돈다(U4b):
// - 등급(offer.limits.tier) → 부품 등급표(packages/agent-link/tiers.mjs). owner만 주인 도구 묶음이고, team·guest는 손님 도구 묶음
//   (isGuestCtx가 link 범위를 owner 표지로만 주인으로 본다 — 지금 배포본에서 조직 채널 에이전트가 주인 아닌 사람의 지시로 도는 턴과 같다).
// - 결재: 그 턴에서 올린 결재(request_approval·셸 결재 등 7곳)는 범위를 각인한다(thread.mjs approvalScope). 연결부가 그것을
//   work.approval_request로 보내고, v2 결정(work.approval_decision)을 chat() 결재 응답(resolveWithFollowUp)으로 돌려준다.
//   승인 실행은 effect intent가 서버에 기록된 뒤에만 한다(D13). 승인 뒤 후속 턴의 답이 결과에 이어진다.
// - 넘김: offer.peers를 동료 목록으로 보여 주고, 답의 넘김 줄을 result.handoffs로 보낸다(연속 상한은 서버, U2).
// - 범위 턴이라 데스크톱 대화 기록을 문맥에 싣지 않는다(방 문맥은 서버가 offer.context로 준다). 세션도 남기지 않는다(scopeKey 없음).
import { createLink } from '../packages/agent-link/link.mjs';
import { tierPolicy } from '../packages/agent-link/tiers.mjs';
import { SUPPORTED, LIMITS, OFFER_KINDS } from '../packages/agent-link/contract/v1.mjs';
import { msgrMeetingEnabled as msgrMeetingEnabledFlag } from './agent-link-flags.mjs';
import { workErrorCodeFor as botWorkErrorCode } from './ext-bots-codes.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, basename } from 'node:path';

export { agentLinkEnabled, legacyMsgrBridgeEnabled, msgrMeetingEnabled } from './agent-link-flags.mjs';

/** 약속 v1.1: 이 본체가 처리할 수 있다고 알리는 기능 — 회의방·외부 봇 설정(ARGO_MSGR_MEETING)이 켜졌을 때만 싣는다. 서버는 알린 기능의 offer만 이 본체에 만든다. */
export const LINK_FEATURES = Object.freeze(['meeting', 'bot']);
/** 외부 봇의 agent.sync slug 접두 — 같은 회사의 에이전트 slug와 겹치지 않게(에이전트 slug는 [a-z0-9-]라 '~'가 없다). */
export const BOT_SLUG_PREFIX = '~bot.';

/** agent.sync에 싣는 외부 봇 한 줄 — 종류·이름만. 주소·키·토큰은 싣지 않는다(본체 로컬 자격 저장소에만, 약속 v1.1). */
export function botSyncEntry(b) {
  return { ws: b.ws, slug: `${BOT_SLUG_PREFIX}${b.id}`, name: b.name || b.id, role: '', face_hash: null, kind: 'bot', bot: { kind: b.kind } };
}

/** 요금제 재확인 간격 — 확인한 값은 10분, 조회 실패는 1분 뒤 다시(무료 계정 클라우드 0 판정 #1110과 같은 주기). */
export const PLAN_CACHE_MS = 600_000;
export const PLAN_FAIL_MS = 60_000;

/** 요금제 조회를 10분 캐시로 감싼다. 조회 실패(null)는 캐시하지 않는다(다음에 다시 본다). */
export function cachedPlanOf(fetchPlanFor, now = () => Date.now()) {
  const c = { uid: null, at: -Infinity, plan: null };
  return async (uid) => {
    if (c.uid === uid && now() - c.at < PLAN_CACHE_MS) return c.plan;
    const plan = await fetchPlanFor(uid);
    if (plan) Object.assign(c, { uid, at: now(), plan });
    return plan;
  };
}

const workErr = (code, message = code) => Object.assign(new Error(message), { code });
/** 회의·봇 결과의 요약(work.result.text, ≤ 2000자, 방에 넣지 않는다). */
const summaryOf = (posts, nameOf) => posts.map((p) => `${nameOf(p.agent)}: ${p.text.replace(/\s+/g, ' ').slice(0, 160)}`).join('\n').slice(0, 2000);

/**
 * 회의방 일(offer.kind 'meeting') 한 건 — 방의 참가자(≤5) × 라운드(1..2)로 회의 실행기(meeting-room.mjs → room.mjs runRoomCore)를 돌려 posts[]로 돌려준다.
 * 회의방은 Pro 전용: 확정 'free'면 회의 실행기·봇을 하나도 부르지 않는다(경로 0, tier_denied). 집행 권위는 서버(pro_required·features)이고 이 검사는 그 뒤의 방어선이다.
 * 조회 실패(null)는 서버 판정을 믿고 진행한다(일시 오류로 유료 사용자를 막지 않는다).
 * agents = 서버 에이전트 id → { ws, slug, name, kind:'agent'|'bot', botId? }(이 기기가 맡은 것), deps = { planOf(uid), uid, runMeeting, chat, interruptTurn, callBot }
 * 결과(약속 v1.1): { text: 요약 ≤ 2000자, files: [], handoffs: [], posts: [{ agent, round, text ≤ 3000자 }] ≤ 10 } — 회의 결과의 넘김은 막는다(서버 post_denied).
 */
export async function runMeetingOffer(offer, ctx, { agents, deps }) {
  const plan = deps.planOf ? await deps.planOf(deps.uid) : null;
  if (plan === 'free') throw workErr('tier_denied', 'meeting room is Pro only');
  const policy = tierPolicy(ctx.tier);
  const m = offer.data.meeting;
  const participants = [];
  for (const p of m.participants) {
    const a = agents.get(p.agent);
    if (!a) continue; // 다른 기기의 참가자 — 이 본체는 맡지 않는다
    participants.push(a.kind === 'bot'
      ? { kind: 'bot', ref: p.agent, ws: a.ws, id: a.botId, name: String(p.name || a.name) }
      : { kind: 'agent', ref: p.agent, ws: a.ws, slug: a.slug, name: String(p.name || a.name || a.slug) });
  }
  if (!participants.length) throw workErr('no_runner', 'no participant on this device');
  ctx.progress?.('thinking');
  const memoryOff = offer.data.memory === false;
  const res = await deps.runMeeting({
    text: offer.data.text, participants, signal: ctx.signal, maxTurnS: offer.data.limits?.max_turn_s, tag: offer.work, sessionKey: `argo:${offer.data.room}`,
    rounds: m.rounds,
  }, {
    chat: deps.chat, interruptTurn: deps.interruptTurn, callBot: deps.callBot,
    mirrorCtxFor: () => ({ kind: 'scope', scope: { kind: 'link', work: offer.work, room: offer.data.room, owner: policy.ownerTools === true, ...(memoryOff ? { memoryOff: true } : {}) } }),
    chatExtra: () => (memoryOff ? { journal: { off: true } } : {}),
  });
  if (ctx.signal?.aborted && res.stopped === 'cancelled') return null;
  ctx.progress?.('writing');
  const posts = res.posts.filter((p) => String(p.text).trim()).slice(0, LIMITS.posts)
    .map((p) => ({ agent: p.ref, round: p.round ?? 1, text: String(p.text).slice(0, LIMITS.postText) }));
  if (!posts.length) throw workErr(res.stopped === 'timeout' ? 'timeout' : 'internal', 'no meeting post');
  const nameOf = (id) => participants.find((x) => x.ref === id)?.name ?? '';
  const notes = res.notes.filter((n) => ['cap', 'relay', 'error', 'timeout', 'unsupported', 'unknown'].includes(n.code)).map((n) => n.text);
  return { text: [summaryOf(posts, nameOf), ...notes].join('\n').slice(0, LIMITS.postsResultText), files: [], handoffs: [], posts };
}

/**
 * 외부 봇 일(offer.kind 'bot') 한 건 — 이 PC의 봇 로컬 HTTP를 1번 부른다(ext-bots.mjs callBot: 루프백·Tailscale만, BOT_RATE). 우리 서버를 거치지 않는다.
 * limits: hop > max_hops 이거나 turns_left가 0이면 부르지 않고 bot_limit. 실패 코드는 work.error의 bot_unreachable·bot_limit(·timeout·tier_denied)로 바꾼다.
 */
export async function runBotOffer(offer, ctx, { agents, deps }) {
  const plan = deps.planOf ? await deps.planOf(deps.uid) : null;
  if (plan === 'free') throw workErr('tier_denied', 'external bot is Pro only');
  const a = agents.get(offer.agent);
  if (!a || a.kind !== 'bot') throw workErr('no_runner', 'bot not on this device');
  const l = offer.data.limits ?? {};
  const hop = l.hop ?? 0;
  if (hop > (l.max_hops ?? LIMITS.botHops) || l.turns_left === 0) throw workErr('bot_limit');
  ctx.progress?.('thinking');
  // 사람 글 1개에서 이미 쓴 봇 턴 = 상한 − 남은 턴(서버가 센 값을 따른다)
  const budget = { turns: l.turns_left != null ? Math.max(0, LIMITS.botTurns - l.turns_left) : 0 };
  const text = contextSection(offer.data.context) + offer.data.text;
  try {
    const r = await deps.callBot({ ws: a.ws, id: a.botId }, { text, sessionId: `argo:${offer.data.room}:${a.botId}`, signal: ctx.signal, budget, hop });
    if (ctx.signal?.aborted) return null;
    return { text: r.text, files: [], handoffs: [] };
  } catch (e) {
    if (ctx.signal?.aborted || e?.code === 'cancelled') return null;
    throw workErr(deps.workErrorCodeFor(e?.code));
  }
}

export const ATTACH_IN_MAX = 25 * 1024 * 1024; // 받은 첨부 한 개 상한(옛 브리지와 같은 25MB)
const SESSION_RETRY_MS = [60_000, 120_000, 300_000, 600_000];
// 목록 보내기가 실패한 뒤(중단 중 부팅·일시 오류)의 다시 보내기 간격 — 다시 붙기(#1089)와 같은 1→2→5→10분. 실패도 요청 예산에 든다(본체 400대 × 분당 0.1회 = 분당 40회)
export const SYNC_RETRY_MS = [60_000, 120_000, 300_000, 600_000];
export const RESYNC_MIN_MS = 60_000; // 게이트웨이 확인(10초)마다 불려도 로컬 목록은 1분에 한 번만 읽는다(보낼지는 바뀌었을 때만) // 세션·등록이 없을 때 다시 볼 간격(요청 폭주 없이, 상한 10분)

/** 서버 방송에서 봉투 꺼내기. 서버(_msgr2_send_w, 20261018010000)는 event = 봉투 type('work.offer' 등), payload = { envelope: 봉투 }로 보낸다.
    본체 진행 방송(event 'envelope')과 옛 모양은 payload가 봉투 자체다 — 둘 다 받는다. 봉투가 아니면 null. */
export function unwrapEnvelope(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const env = payload.envelope && typeof payload.envelope === 'object' ? payload.envelope : payload;
  return typeof env.type === 'string' ? env : null;
}

/** supabase-js 클라이언트를 link.mjs transport 모양으로. 받는 길은 비공개 broadcast 채널(v2:w:) 하나 — 서버가 봉투 type을 event로 쓰므로 모든 event를 받는다.
    source = 클라이언트, 또는 지금 클라이언트를 돌려주는 함수(async 가능). 기기 세션 토큰이 회전하면(게이트웨이 sessionClient가 새 클라이언트를 만든다)
    요청마다 새 클라이언트를 쓰고, 열어 둔 구독 채널을 새 클라이언트로 옮긴다(옮기면 다시 'connected' → 따라잡기 1번). 그대로 두면 옛 토큰이 만료된 뒤 401이다.
    쉬는 본체는 요청이 없으므로 호스트가 게이트웨이 확인(10초)마다 refresh()를 불러 회전을 따라가고, 끊긴 구독(CLOSED·CHANNEL_ERROR·TIMED_OUT)을 다시 붙인다
    (realtime-js는 손으로 넣은 토큰이면 heartbeat 때 토큰을 바꾸지 않는다 — 옛 토큰이 만료되면 서버가 채널을 닫는다).
    다시 붙기(#1089 재검수): 끊긴 채널은 다음 refresh에서 떼어 realtime-js 자체 재시도를 멈추고, 끊긴 뒤 1→2→5→10분 간격으로만 다시 연다(SUBSCRIBED면 처음으로).
    다시 열기 전에 beforeReopen(호스트 = 링크 따라잡기 rpc 1번)으로 기기 상태를 본다 — device_revoked 등이면 링크가 멈추고 구독을 닫아 다시 열지 않는다.
    세션이 없으면(getClient → null: 로그아웃·앱 관문 차단) 옛 클라이언트와 채널을 버리고 다시 붙지 않는다. 세션이 돌아오면 그때 연다.
    진행 방송 채널(v2:wk:<일>)은 일이 끝나면 release로 닫는다(쌓이지 않게). 닫은 뒤 늦게 도착한 진행 방송은 채널을 다시 만들지 않는다. */
export const RESUBSCRIBE_BACKOFF_MS = Object.freeze([60_000, 120_000, 300_000, 600_000]);
export function supabaseTransport(source, { now = () => Date.now() } = {}) {
  const getClient = typeof source === 'function' ? source : async () => source;
  let cur = typeof source === 'function' ? null : source;
  const subs = new Set();      // { topic, onEnvelope, onStatus, ch, dead, fails, retryAt }
  const progress = new Map();  // topic → ch(보내기만)
  const released = new Map();  // 닫은 진행 토픽 → 닫은 시각(늦은 진행 방송이 채널을 다시 만들지 않게, 10분 뒤 잊는다)
  const RELEASED_KEEP_MS = 10 * 60_000;
  function open(sub) {
    const ch = cur.channel(sub.topic, { config: { private: true } });
    ch.on('broadcast', { event: '*' }, (msg) => { const env = unwrapEnvelope(msg?.payload); if (env) sub.onEnvelope(env); });
    sub.ch = ch; sub.dead = false; // 상태 알림보다 먼저(동기로 SUBSCRIBED를 알리는 클라이언트도 있다)
    ch.subscribe((status) => {
      if (sub.ch !== ch) return; // 옮긴 뒤 옛 채널의 상태는 무시
      if (status === 'SUBSCRIBED') { sub.dead = false; sub.fails = 0; sub.retryAt = 0; sub.onStatus?.('connected'); }
      else if (status === 'CLOSED' || status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        if (!sub.dead) { sub.dead = true; sub.retryAt = now() + RESUBSCRIBE_BACKOFF_MS[Math.min(sub.fails ?? 0, RESUBSCRIBE_BACKOFF_MS.length - 1)]; }
        if ((sub.fails ?? 0) > 0) detach(sub); // 우리가 다시 연 채널이 또 끊겼다 — 바로 떼어 realtime-js 재시도를 멈춘다(다음은 간격 뒤)
        sub.onStatus?.('disconnected');
      }
    });
  }
  function detach(sub) { const ch = sub.ch; sub.ch = null; try { if (ch) cur?.removeChannel?.(ch); } catch { /* 무시 */ } }
  function drop() { // 세션 없음: 옛 클라이언트·채널을 버린다(관문이 끊은 연결이 옛 클라이언트로 되살아나지 않게)
    if (!cur) return;
    for (const sub of subs) { detach(sub); if (!sub.dead) { sub.dead = true; sub.retryAt = 0; sub.onStatus?.('disconnected'); } }
    for (const ch of progress.values()) { try { cur.removeChannel?.(ch); } catch { /* 무시 */ } }
    progress.clear();
    cur = null;
  }
  function swap(next) {
    if (!next || next === cur) return;
    const old = cur; cur = next;
    for (const sub of subs) { const och = sub.ch; sub.ch = null; try { if (och) old?.removeChannel?.(och); } catch { /* 닫기 실패 무시 */ } sub.fails = 0; open(sub); }
    for (const ch of progress.values()) { try { old?.removeChannel?.(ch); } catch { /* 무시 */ } }
    progress.clear();
  }
  async function client() {
    const next = await getClient();
    if (!next) { drop(); throw Object.assign(new Error('no session'), { code: 'no_session' }); }
    swap(next);
    return cur;
  }
  return {
    async rpc(name, args) {
      let c;
      try { c = await client(); } catch (e) { return { data: null, error: { code: e.code ?? null, message: e.message ?? '', status: 0 } }; }
      const { data, error, status } = await c.rpc(name, args);
      return { data, error: error ? { code: error.code ?? null, message: error.message ?? '', status: error.status ?? status ?? 0 } : null };
    },
    subscribe(topic, onEnvelope, onStatus) {
      const sub = { topic, onEnvelope, onStatus, ch: null, dead: false, fails: 0, retryAt: 0 };
      subs.add(sub);
      if (cur) open(sub);
      else client().then(() => { if (subs.has(sub) && !sub.ch) open(sub); }).catch(() => onStatus?.('disconnected'));
      return { close: () => { subs.delete(sub); const ch = sub.ch; sub.ch = null; try { if (ch) cur?.removeChannel?.(ch); } catch { /* 무시 */ } } };
    },
    /** 지금 클라이언트를 확인한다(네트워크 없음) — 바뀌었으면 구독을 옮기고, 끊긴 구독은 간격(1→2→5→10분)이 지났을 때만 beforeReopen 뒤 다시 연다.
        세션이 없으면 아무것도 다시 열지 않는다. 호스트가 게이트웨이 확인마다 부른다. */
    async refresh({ beforeReopen } = {}) {
      try { await client(); } catch { return; }
      const due = [];
      for (const sub of subs) {
        if (!sub.dead) continue;
        if (sub.ch) detach(sub); // 끊긴 채 남은 채널을 떼어 realtime-js 자체 재시도를 멈춘다
        if (now() >= (sub.retryAt ?? 0)) due.push(sub);
      }
      if (!due.length) return;
      if (beforeReopen) { try { await beforeReopen(); } catch { /* 확인 실패는 다시 열기를 막지 않는다 — 간격은 그대로 */ } }
      if (!cur) return; // 확인하는 사이 세션이 사라졌다
      for (const sub of due) {
        if (!subs.has(sub) || !sub.dead || sub.ch) continue; // 링크가 멈춰 닫았거나(폐기) 이미 다시 붙었다
        sub.fails = (sub.fails ?? 0) + 1;
        sub.retryAt = now() + RESUBSCRIBE_BACKOFF_MS[Math.min(sub.fails, RESUBSCRIBE_BACKOFF_MS.length - 1)];
        sub.dead = false; // open이 상태를 다시 받는다(실패하면 위 retryAt 뒤에 또)
        open(sub);
      }
    },
    async broadcast(topic, envelope) {
      // 진행 표시는 저장하지 않는 방송이다(설계 D7). 채널을 만들어 두고 일이 끝날 때까지 다시 쓴다(release).
      if (released.has(topic)) return;
      const c = await client();
      if (released.has(topic)) return; // 기다리는 사이 일이 끝나 닫혔다 — 다시 만들지 않는다
      let ch = progress.get(topic);
      if (!ch) { ch = c.channel(topic, { config: { private: true } }); progress.set(topic, ch); ch.subscribe(); }
      await ch.send({ type: 'broadcast', event: 'envelope', payload: envelope });
    },
    release(topic) {
      const now = Date.now();
      released.set(topic, now);
      for (const [t, at] of released) if (now - at > RELEASED_KEEP_MS) released.delete(t);
      const ch = progress.get(topic);
      if (!ch) return;
      progress.delete(topic);
      try { cur?.removeChannel?.(ch); } catch { /* 무시 */ }
    },
    // offer 첨부(#1076): 서명 URL이 아니라 Storage 위치. runner 세션으로 받는다(버킷 정책 = 그 방 일의 리스를 쥔 runner 기기만)
    async download(bucket, path) {
      const { data, error } = await (await client()).storage.from(bucket).download(path);
      if (error || !data) throw Object.assign(new Error('download failed'), { code: 'download_failed' });
      return new Uint8Array(await data.arrayBuffer());
    },
    // 업로드 슬롯(서버가 정한 경로)에 runner 세션으로 올린다. 덮어쓰지 않는다(같은 슬롯에 두 번 올리지 않는다)
    async upload(bucket, path, bytes, mime) {
      const { error } = await (await client()).storage.from(bucket).upload(path, bytes, { contentType: mime || 'application/octet-stream', upsert: false });
      if (error) throw Object.assign(new Error('upload failed'), { code: 'upload_failed' });
    },
    // 시험·진단용
    get openChannels() { return [...subs].filter((x) => x.ch).length + progress.size; },
  };
}

/** 이 기기에서 쓸 수 있는 러너 id(설치·로그인 둘 다) — 정렬해서(순서만 바뀌어도 서버 쓰기가 생기지 않게). 감지 실패·초과는 빈 목록. */
export async function detectRunnerIds(detect, { timeoutMs = 3000 } = {}) {
  try {
    const m = await Promise.race([detect(), new Promise((r) => setTimeout(r, timeoutMs, null))]);
    return Object.entries(m ?? {}).filter(([, v]) => v?.installed && v?.authed).map(([k]) => k).sort();
  } catch { return []; }
}

/** msgr2_device_register 인자(U3 …_msgr2_device.sql) — PostgREST가 이름으로 잇는다(p_ 접두). 본체는 kind 'runner' + app 'desktop'만 받는다
 *  (app 'argo'는 22023 msgr2_device_invalid). 지원 약속 범위 + 정렬한 러너 목록. 로그인 지점과 연결부 시작이 같은 모양을 쓴다. p_push_token은 싣지 않는다(기본 null). */
export const RUNNER_APP = 'desktop';
export const runnerRegisterArgs = ({ appVersion = null, runners = [] } = {}) => ({
  p_kind: 'runner', p_app: RUNNER_APP, p_app_version: appVersion, p_link_min: SUPPORTED.min, p_link_max: SUPPORTED.max, p_runners: [...new Set(runners)].sort(),
});

export const LOGIN_REG_TIMEOUT_MS = 5_000; // 한 번의 등록 요청 상한(옆 fetchProfileName과 같은 5초)
export const LOGIN_REG_BUDGET_MS = 8_000; // 재시도까지 합친 상한 — 응답 없는 서버에서도 로그인이 이보다 오래 기다리지 않는다

/**
 * 로그인 응답을 받은 즉시, 세션 파일을 쓰기 전에 그 세션을 runner 기기로 잠근다(검수 1 #1071 경주 창: 다시 로그인한 직후
 * 에이전트 셸이 새 세션 파일을 읽어 app 기기로 먼저 등록할 수 있다 — app 등록은 로그인 10분 안 세션만 받는다).
 * 짧게 3번까지 다시 해 본다. 그래도 실패하면 로그인은 그대로 진행한다(로그인을 막지 않는다) — 연결부가 시작할 때 다시 등록하고,
 * 등록이 성공하기 전에는 메신저 v2 일을 받지 않는다(boot 순서). 반환: { ok, device_id?, code? }.
 */
export async function registerRunnerOnLogin({ url, anonKey, accessToken }, { mkClient, appVersion = null, runners = [], attempts = 3, timeoutMs = LOGIN_REG_TIMEOUT_MS, budgetMs = LOGIN_REG_BUDGET_MS, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = (...a) => console.error('[argo] agent-link', ...a) } = {}) {
  const deadline = now() + budgetMs;
  let last = null;
  try {
    const client = mkClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${accessToken}` } } });
    for (let i = 0; i < attempts; i++) {
      if (i) await sleep(300 * 3 ** (i - 1));
      const left = Math.min(timeoutMs, deadline - now());
      if (left < 1) { last = last ?? 'timeout'; break; } // 합계 상한을 다 썼다
      let timer = null;
      try {
        // supabase-js 빌더면 요청 자체를 끊고(abortSignal), 아니어도 경주로 기다림을 끊는다(멈춘 서버가 로그인을 붙잡지 않게).
        const call = client.rpc('msgr2_device_register', runnerRegisterArgs({ appVersion, runners }));
        const q = typeof call?.abortSignal === 'function' ? call.abortSignal(AbortSignal.timeout(left)) : call;
        const { data, error } = await Promise.race([q, new Promise((_, rej) => { timer = setTimeout(() => rej(Object.assign(new Error('timeout'), { code: 'timeout' })), left); })]);
        if (!error && data?.device_id) return { ok: true, device_id: data.device_id };
        last = error?.code || data?.code || (error ? 'error' : 'no_device_id');
        if (error && error.status && error.status < 500 && error.status !== 429) break; // 영구 거부(함수 없음·권한·값 모양) — 다시 해도 같다
      } catch (e) { last = e?.code === 'timeout' ? 'timeout' : 'network'; } finally { clearTimeout(timer); }
    }
  } catch { last = 'client'; }
  log('runner register on login failed', last);
  return { ok: false, code: last };
}

/** offer.context[](서버가 만든 최근 글) → 지시 앞에 붙일 문맥 구역. 비면 ''. */
export function contextSection(context, lang = 'ko') {
  if (!Array.isArray(context) || !context.length) return '';
  const head = lang === 'en' ? '## Recent conversation in this room' : '## 이 방의 최근 대화';
  const lines = context.map((c) => `- ${c.author?.name || (c.author?.kind === 'agent' ? 'agent' : 'user')}: ${String(c.text ?? '').replace(/\s+/g, ' ').slice(0, 2000)}`);
  return `${head}\n${lines.join('\n')}\n\n`;
}

// v2 승인 요청의 만료. 서버는 만료 결정을 보내지 않는다(msgr2_approval_decide는 approve·reject만, 기한이 지나면 'expired'만 돌려주고 크론도 없다) —
// 본체가 expires_at에 로컬 타이머를 걸어 닫는다. 결재 대기 중인 일은 result를 받지 않으므로 work.error{timeout}으로 끝내고, 그러면 리스 연장도 멈춘다.
export const APPROVAL_TTL_MS = 24 * 3_600_000;

/** offer.peers[](서버가 등급·파견 허용으로 거른 동료) → 지시 앞에 붙일 동료 구역과 넘김 규칙. 비면 ''. */
export function peersSection(peers, lang = 'ko') {
  if (!Array.isArray(peers) || !peers.length) return '';
  const list = peers.map((p) => `- @${p.name}${p.role ? ` — ${String(p.role).replace(/\s+/g, ' ').slice(0, 200)}` : ''}`).join('\n');
  return lang === 'en'
    ? `## Colleagues you can hand off to in this room\n${list}\nTo hand part of the work to a colleague, end your answer with one line per colleague: [handoff @name] what they should do\n\n`
    : `## 이 방에서 넘길 수 있는 동료\n${list}\n일의 일부를 동료에게 넘기려면 답의 끝에 동료마다 한 줄을 쓴다: [넘김 @이름] 맡길 일\n\n`;
}

const HANDOFF_LINE = /^[ \t]*\[(?:넘김|handoff)[ \t]+@([^\]\n]{1,80})\][ \t]*(\S.*)$/i;
/** 답에서 넘김 줄을 뽑는다. 동료 이름이 정확히 하나와 맞는 줄만 넘김이 되고 본문에서 지운다(모르는 이름·동명이인 줄은 그대로 둔다). 최대 8개. */
export function parseHandoffs(text, peers) {
  const src = String(text ?? '');
  if (!Array.isArray(peers) || !peers.length) return { body: src, handoffs: [] };
  const handoffs = [];
  const kept = src.split('\n').filter((line) => {
    const m = HANDOFF_LINE.exec(line);
    if (!m || handoffs.length >= 8) return true;
    const hit = peers.filter((p) => String(p.name).trim().toLowerCase() === m[1].trim().toLowerCase());
    if (hit.length !== 1) return true;
    handoffs.push({ agent: hit[0].agent, text: m[2].trim().slice(0, 4000) });
    return false;
  });
  return { body: kept.join('\n').replace(/\n{3,}/g, '\n\n').trim(), handoffs };
}

/** 로컬 결재 항목(approvals.mjs) → work.approval_request data. effect_key = approval:<로컬 id>(승인 실행의 intent 키와 같다). */
export function approvalRequestFrom(item, now = Date.now()) {
  const plain = item.plain ? [item.plain.purpose, item.plain.task, item.plain.need].filter(Boolean).join(' · ') : '';
  const summary = (plain || [item.action, item.reason].filter(Boolean).join(' — ') || 'approval').slice(0, 2000);
  return {
    action: String(item.action || item.kind || 'approval').slice(0, 200),
    risk: item.kind === 'tool' || item.kind === 'connector' || item.payload?.shell ? 'high' : 'medium', // payload.shell = 고위험 셸 결재(D28)
    summary, effect_key: `approval:${item.id}`, expires_at: new Date(now + APPROVAL_TTL_MS).toISOString(),
  };
}

const safeName = (n) => basename(String(n || 'file')).replace(/[^\p{L}\p{N}._-]+/gu, '_').slice(0, 120) || 'file';

/**
 * 연결부. deps는 시험이 가짜로 바꾼다.
 * deps = { getSession() → { client, uid } | null, listOwnedAgents(uid) → [{ ws, slug, name, role }], chat, interruptTurn,
 *          onNotify(fn) → off, resolveWithFollowUp(ws, id, approve, opts), resolveApproval(ws, id, approve, opts),
 *          planReplyFiles, readReplyFile, vaultDir(ws), appVersion, clock, log, transportFor(client) }
 */
export function createAgentLinkHost(deps) {
  const { clock = { now: () => Date.now(), setTimeout, clearTimeout }, log = (...a) => console.error('[argo] agent-link', ...a) } = deps;
  let link = null, timer = null, stopped = false, tries = 0, lastResync = -Infinity, current = null; // current = 지금 transport(첨부 받기)
  let syncFails = 0; // 연달아 실패한 목록 보내기 수(성공하면 0 — 간격이 1분으로 돌아간다)
  let catchUpAfterSync = false; // 시작 때 목록을 못 보냈다 — 처음 성공하면 그동안 못 받은 offer를 따라잡기로 한 번 가져온다
  const agents = new Map(); // 서버 에이전트 id → { ws, slug }
  const agentIds = new Set();
  let currentUid = null; // 회의방 요금제 확인(runMeetingOffer)
  // pro_required(무료 계정) 쉼 — 다음 플랜 확인(nextPlanAt) 전에는 기기 등록·agent.sync·따라잡기·구독 갱신 요청이 0이다
  let proBlocked = false, nextPlanAt = 0;
  function proBlock() {
    proBlocked = true; nextPlanAt = clock.now() + PLAN_CACHE_MS;
    if (link) { link.stop(); link = null; }
    if (timer) { clock.clearTimeout(timer); timer = null; }
    agents.clear(); agentIds.clear();
  }
  /** 쉼 관문. 'open' = 쉬지 않음, 'blocked' = 쉬는 중(요청 0), 'resumed' = 방금 플랜을 다시 봤더니 Pro·체험이라 쉼을 풀었다(다시 연다). */
  async function planGate() {
    if (!proBlocked) return 'open';
    if (clock.now() < nextPlanAt || !deps.planOf) return 'blocked';
    const plan = await deps.planOf(currentUid).catch(() => null);
    if (plan === 'pro' || plan === 'trial') { proBlocked = false; return 'resumed'; }
    nextPlanAt = clock.now() + (plan ? PLAN_CACHE_MS : PLAN_FAIL_MS);
    return 'blocked';
  }

  async function attachments(offer, ws, transport) {
    const out = [];
    const dir = join(deps.vaultDir(ws), 'files', 'msgr2');
    for (const a of offer.data.attachments) {
      if (a.bytes > ATTACH_IN_MAX) continue;
      try {
        const buf = Buffer.from(await transport.download(a.bucket, a.path));
        if (buf.length > ATTACH_IN_MAX) continue;
        await mkdir(dir, { recursive: true });
        const name = `${offer.work.slice(0, 8)}-${safeName(a.name)}`;
        await writeFile(join(dir, name), buf);
        out.push({ rel: `files/msgr2/${name}`, name: a.name, mime: a.mime, isImage: /^image\//.test(a.mime) });
      } catch { /* 한 첨부 실패는 턴을 막지 않는다 */ }
    }
    return out;
  }

  const host = {
    canAccept: (offer) => agents.has(offer.agent),
    async runTurn(offer, ctx) {
      // 약속 v1.1 offer.kind — 없으면 chat. 회의·봇은 설정(ARGO_MSGR_MEETING)이 켜졌을 때만(그때만 features로 알린다). 모르는 kind·꺼진 기능은 unsupported
      const kind = offer.data.kind ?? 'chat';
      const on = deps.meetingEnabled?.() === true;
      if (!OFFER_KINDS.includes(kind) || (kind !== 'chat' && !on)) throw Object.assign(new Error(`unsupported offer kind: ${kind}`), { code: 'unsupported' });
      const extra = { ...deps.meeting, planOf: deps.planOf, uid: currentUid, chat: deps.chat, interruptTurn: deps.interruptTurn };
      if (kind === 'meeting') return runMeetingOffer(offer, ctx, { agents, deps: extra });
      if (kind === 'bot' || agents.get(offer.agent)?.kind === 'bot') {
        if (!on) throw Object.assign(new Error('external bot is off'), { code: 'unsupported' });
        return runBotOffer(offer, ctx, { agents, deps: extra });
      }
      const a = agents.get(offer.agent);
      if (!a) throw Object.assign(new Error('agent not on this device'), { code: 'no_runner' });
      const policy = tierPolicy(ctx.tier);
      ctx.progress('thinking');
      const onAbort = () => { deps.interruptTurn(a.ws, a.slug, { source: 'messenger', tag: offer.work }).catch(() => {}); };
      ctx.signal.addEventListener('abort', onAbort, { once: true });
      // 결재 다리: 이 일의 범위를 단 결재·후속 답만 받는다(같은 에이전트의 다른 턴·다른 일과 섞이지 않게)
      const mine = (ev) => ev?.wsId === a.ws && ev.item?.scope?.kind === 'link' && ev.item.scope.work === offer.work;
      const later = []; const bridges = []; const replies = new Map(); const waiters = new Map();
      const waitFollowup = (id) => (replies.has(id) ? Promise.resolve(replies.get(id)) : new Promise((res) => {
        waiters.set(id, res);
        ctx.signal.addEventListener('abort', () => res(''), { once: true });
      }));
      let expiredAny = false; // 기한이 지난 결재가 있다 — 일은 결과 대신 timeout 오류로 끝난다(결재 대기 상태라 result를 받지 않는다)
      const closeLocal = (id) => deps.resolveApproval(a.ws, id, false, { resolvedBy: { via: 'msgr2', at: new Date(clock.now()).toISOString() } }).catch(() => {});
      async function bridge(item) {
        if (!policy.approvals) { await closeLocal(item.id); return ''; } // guest: 승인 요청을 보내지 않는다(서버도 tier_denied) — 막힌 턴을 풀어 준다
        let decision;
        const req = approvalRequestFrom(item, clock.now());
        let timer = null;
        const expiry = new Promise((res) => { timer = clock.setTimeout(() => res('expire'), Math.max(0, Date.parse(req.expires_at) - clock.now())); });
        try { decision = await Promise.race([ctx.requestApproval(req), expiry]); }
        catch (e) { log('approval request failed', e.code ?? e.message); await closeLocal(item.id); return ''; }
        finally { clock.clearTimeout(timer); }
        if (ctx.signal.aborted) { await closeLocal(item.id); return ''; }
        const tool = item.kind === 'tool'; // 권한 게이트 결재 — 기다리던 턴이 스스로 재개한다(후속 턴 없음)
        if (decision === 'approve') {
          try {
            // 되돌릴 수 없는 일: intent가 서버에 기록돼야 승인을 풀어 실행한다. 이미 있는 키면 실행하지 않는다(effect_exists)
            return await ctx.effect(`approval:${item.id}`, String(item.kind || 'approval').replace(/[^a-z0-9_]/g, '_') || 'approval', async () => {
              const wait = tool ? null : waitFollowup(item.id);
              try { await deps.resolveWithFollowUp(a.ws, item.id, true, { resolvedBy: { via: 'msgr2', at: new Date(clock.now()).toISOString() } }); }
              catch (e) {
                // 주인이 데스크톱 결재함·텔레그램에서 먼저 확정했다(카드는 그쪽에도 간다) — 다시 풀지 않고 그때 나온 후속 답을 쓴다
                if (e?.code === 'approval_already_resolved') return replies.get(item.id) ?? '';
                throw e;
              }
              return wait ? await wait : '';
            }) ?? '';
          } catch (e) { log('approval apply failed', e.code ?? e.message); await closeLocal(item.id); return ''; }
        }
        if (decision === 'reject') {
          const wait = tool ? null : waitFollowup(item.id);
          await deps.resolveWithFollowUp(a.ws, item.id, false, { resolvedBy: { via: 'msgr2', at: new Date(clock.now()).toISOString() } }).catch(() => {});
          return wait ? await wait : '';
        }
        await closeLocal(item.id); // expire(로컬 타이머): 후속 턴 없이 닫는다
        expiredAny = true;
        return '';
      }
      const off = deps.onNotify((ev) => {
        if (!mine(ev)) return;
        if (ev.type === 'approval') { if (ev.item.kind === 'tool') bridges.push(bridge(ev.item)); else later.push(ev.item); }
        else if (ev.type === 'approval_followup') {
          const w = waiters.get(ev.item.id);
          if (w) { waiters.delete(ev.item.id); w(String(ev.reply ?? '')); } else replies.set(ev.item.id, String(ev.reply ?? ''));
        }
      });
      try {
        const files = await attachments(offer, a.ws, current); // offer = accept 답의 첨부가 반영된 것(link.mjs)
        const peers = policy.handoffs ? offer.data.peers ?? [] : [];
        const text = contextSection(offer.data.context) + peersSection(peers) + offer.data.text;
        const turn = await deps.chat(a.ws, a.slug, text, null, {
          source: 'messenger', attachments: files, abortTag: offer.work,
          // memoryOff — 기억 안 남김 방: 이 턴에서 이어지는 쪽지 배달 턴·결재 후속 턴도 일지를 남기지 않게 범위에 싣는다
          mirrorCtx: { kind: 'scope', scope: { kind: 'link', work: offer.work, room: offer.data.room, owner: policy.ownerTools === true, ...(offer.data.memory === false ? { memoryOff: true } : {}) } },
          // 일지: offer.memory가 거짓이면 남기지 않는다(기억 안 남김 방). 참이면 chat()의 기본 일지
          ...(offer.data.memory === false ? { journal: { off: true } } : {}),
        });
        const parts = [String(turn?.reply ?? '')];
        for (const t of await Promise.all(bridges)) if (t) parts.push(t);
        // 턴이 끝난 뒤의 결재(행동 결재 — 승인되면 후속 턴이 한다): 하나씩 결정을 기다린다. 기다리는 동안 리스는 link가 5분마다 연장한다
        for (const item of later) {
          if (ctx.signal.aborted) { await closeLocal(item.id); continue; }
          const t = await bridge(item);
          if (t) parts.push(t);
        }
        if (ctx.signal.aborted) return null;
        if (expiredAny) throw Object.assign(new Error('approval expired'), { code: 'timeout' }); // 방에는 코드 글만(원문 없음, D15)
        ctx.progress('writing');
        const { body, handoffs } = parseHandoffs(parts.filter(Boolean).join('\n\n'), peers);
        const plan = policy.uploads ? await deps.planReplyFiles(a.ws, body).catch(() => ({ body, files: [] })) : { body, files: [] };
        const slots = [];
        for (const f of plan.files) {
          try { slots.push(await ctx.upload(f.name, await deps.readReplyFile(a.ws, f), undefined)); }
          catch (e) { log('reply file upload failed', e.code ?? e.message); }
        }
        return { text: plan.body, files: slots, handoffs, ...(turn?.costUsd != null ? { usage: { cost_usd: turn.costUsd } } : {}) };
      } finally {
        off();
        ctx.signal.removeEventListener('abort', onAbort);
      }
    },
    onEvent(name, detail) {
      if (['update_required', 'device_invalid', 'paused', 'resumed', 'lease_lost', 'report_failed', 'accept_failed', 'pro_required'].includes(name)) log(name, JSON.stringify(detail));
      if (name === 'pro_required') proBlock(); // 무료 계정 — 링크는 이미 멈췄다(link.mjs fatal). 다음 플랜 확인 전까지 다시 열지 않는다
    },
  };

  function retryLater() {
    if (stopped || proBlocked) return;
    const ms = SESSION_RETRY_MS[Math.min(tries++, SESSION_RETRY_MS.length - 1)];
    timer = clock.setTimeout(() => { timer = null; boot().catch((e) => log('boot failed', e.message)); }, ms);
  }

  async function boot() {
    if (stopped || link || proBlocked) return;
    const s = await deps.getSession();
    if (!s) return retryLater();
    const transport = deps.transportFor(s.client);
    current = transport;
    // 기기 등록(U3 msgr2_device_register): runner 기기 + 지원 약속 범위. 답의 device_id가 봉투의 device다.
    // 러너 목록이 비면 서버가 이 기기에 일을 주지 않는다(경우 17) — CLI 감지 + 회사 설정의 러너(API 키 등)를 함께 본다
    const runners = deps.detectRunners ? await detectRunnerIds(() => deps.detectRunners(s.uid)) : [];
    const reg = await transport.rpc('msgr2_device_register', runnerRegisterArgs({ appVersion: deps.appVersion ?? null, runners }));
    const device = reg?.data?.device_id;
    if (reg.error || !device) { log('device register failed', reg.error?.code ?? reg.data?.code ?? 'no device_id'); return retryLater(); }
    tries = 0;
    lastResync = clock.now();
    currentUid = s.uid;
    link = createLink({ transport, host, uid: s.uid, device, agentIds, clock: deps.linkClock });
    // 목록을 못 보내도(중단 스위치·일시 오류 6번) 링크는 연다. 예전에는 여기서 던져 link만 남고 start()가 안 불려, retryLater의 boot가 `link`에서 빠져
    // 해제 뒤에도 구독 0이었다(#1091 검수). 목록은 host.resync가 1분마다 다시 보낸다(대응표가 비어 있는 동안 offer는 받지 않는다)
    await resync().catch((e) => { catchUpAfterSync = true; syncFails++; log('agent sync failed', e.code ?? e.message); });
    link.start();
  }

  /** 로컬 에이전트 목록을 보낸다(바뀌었을 때만 요청). 답의 대응표로 이 본체가 맡을 에이전트를 정한다. */
  async function resync() {
    if (!link) return;
    const s = await deps.getSession();
    if (!s) return;
    const list = await deps.listOwnedAgents(s.uid);
    const on = deps.meetingEnabled?.() === true;
    const bots = on && deps.listOwnedBots ? await deps.listOwnedBots(s.uid).catch(() => []) : [];
    const rows = [
      ...list.map((x) => ({ ws: x.ws, slug: x.slug, name: x.name || x.slug, role: String(x.role ?? '').slice(0, 2000), face_hash: null })),
      ...bots.map(botSyncEntry),
    ];
    const r = await link.syncAgents(rows, { features: on ? [...LINK_FEATURES] : null });
    syncFails = 0;
    if (!r.sent) return;
    agents.clear(); agentIds.clear();
    for (const m of r.data?.agents ?? []) {
      const ag = list.find((x) => x.ws === m.ws && x.slug === m.slug);
      const bt = !ag && bots.find((b) => b.ws === m.ws && `${BOT_SLUG_PREFIX}${b.id}` === m.slug);
      if (ag) { agents.set(m.id, { ws: m.ws, slug: m.slug }); agentIds.add(m.id); }
      else if (bt) { agents.set(m.id, { ws: m.ws, slug: m.slug, kind: 'bot', botId: bt.id, name: bt.name }); agentIds.add(m.id); }
    }
    if (catchUpAfterSync) { catchUpAfterSync = false; link.catchUp(); }
  }

  return {
    start() { stopped = false; boot().catch((e) => { log('boot failed', e.message); retryLater(); }); return this; },
    stop() { stopped = true; if (timer) clock.clearTimeout(timer); timer = null; link?.stop(); link = null; },
    async resync() {
      const gate = await planGate();
      if (gate === 'blocked') return; // 무료 계정 쉼 — 요청 0(플랜 확인만 10분·실패 1분마다)
      if (gate === 'resumed') { if (stopped) return; tries = 0; return boot().catch((e) => { log('boot failed', e.message); retryLater(); }); } // 쉼이 풀렸다 — 다시 연다
      // 토큰 회전·끊긴 구독은 매번(게이트웨이 확인 10초마다) 확인한다 — 네트워크 요청이 아니다(쉬는 본체가 옛 토큰의 구독에 남지 않게)
      const fresh = Promise.resolve(current?.refresh?.({ beforeReopen: () => link?.catchUp?.() })).catch(() => {}); // 다시 붙기 전 따라잡기 rpc 1번 = 기기 상태 확인(폐기면 링크가 멈춘다)
      const gap = syncFails ? SYNC_RETRY_MS[Math.min(syncFails - 1, SYNC_RETRY_MS.length - 1)] : RESYNC_MIN_MS;
      if (clock.now() - lastResync < gap) return fresh;
      lastResync = clock.now();
      return fresh.then(() => resync()).catch((e) => { syncFails++; log('agent sync failed', e.code ?? e.message); });
    },
    get link() { return link; },
    get agents() { return agents; },
    get proBlocked() { return proBlocked; },
  };
}

/** 게이트웨이가 부르는 실제 연결부(진짜 세션·chat()). 플래그가 꺼져 있으면 부르지 않는다(gateway.mjs). */
export async function startAgentLinkHost() {
  const [{ sessionClient }, { chat }, { interruptTurn }, rf, { listCompanies, listAgents }, { paths }, { APP_VERSION }, { detectRunners, resolveRunner }, { onNotify }, { resolveWithFollowUp }, { resolveApproval }] = await Promise.all([
    import('./gateway/msgr.mjs'), import('./chat.mjs'), import('./turn-abort.mjs'), import('./gateway/msgr-reply-files.mjs'),
    import('./hub.mjs'), import('./workspace.mjs'), import('./app-version.mjs'), import('./runners.mjs'),
    import('./notify.mjs'), import('./approval-actions.mjs'), import('./approvals.mjs'),
  ]);
  const host = createAgentLinkHost({
    meetingEnabled: () => msgrMeetingEnabledFlag(),
    // 요금제 확인 — 회의·봇 일이 왔을 때와 pro_required 쉼의 재확인 때만 부른다(쉬는 동안 요청 0). 10분 캐시, 실패는 캐시하지 않음
    planOf: cachedPlanOf(async (uid) => {
      const c = await sessionClient();
      if (!c) return null;
      const { fetchPlan } = await import('./entitlement.mjs');
      return fetchPlan(c.client, uid ?? c.uid);
    }),
    meeting: {
      runMeeting: async (...a) => (await import('./meeting-room.mjs')).runMeeting(...a),
      callBot: async (...a) => (await import('./ext-bots.mjs')).callBot(...a),
      workErrorCodeFor: botWorkErrorCode,
    },
    // 주인 회사들의 기기 로컬 봇(키 없는 목록) — 설정이 켜졌을 때만 agent.sync에 싣는다
    async listOwnedBots(uid) {
      const { listBots } = await import('./ext-bots.mjs');
      const out = [];
      for (const c of await listCompanies()) {
        if (c.ownerId !== uid) continue;
        for (const b of await listBots(c.id).catch(() => [])) if (b.enabled) out.push({ ws: c.id, id: b.id, name: b.name, kind: b.kind });
      }
      return out;
    },
    getSession: async () => { const c = await sessionClient(); return c ? { client: c.client, uid: c.uid } : null; },
    async listOwnedAgents(uid) {
      const out = [];
      for (const c of await listCompanies()) {
        if (c.ownerId !== uid) continue; // 주인 계정의 회사만(옛 브리지의 소유자 관문과 같은 기준, msgr.mjs 713)
        for (const a of await listAgents(c.id).catch(() => [])) out.push({ ws: c.id, slug: a.slug, name: a.name, role: a.role });
      }
      return out;
    },
    chat, interruptTurn, onNotify, resolveWithFollowUp, resolveApproval, planReplyFiles: rf.planReplyFiles, readReplyFile: rf.readReplyFile,
    vaultDir: (ws) => paths(ws).vault, appVersion: APP_VERSION,
    // CLI 로그인 감지(detectRunners)만 보면 회사 설정에 API 키로 둔 러너(OpenRouter 등)만 쓰는 사용자는 빈 목록이 되어 일을 못 받는다.
    // 동기화의 리더 양보 판정(sync.mjs probeRunnerUsable)과 같이 주인 회사마다 resolveRunner도 본다(3초 상한은 detectRunnerIds).
    async detectRunners(uid) {
      const m = { ...(await detectRunners().catch(() => ({}))) };
      for (const c of await listCompanies().catch(() => [])) {
        if (c.ownerId !== uid) continue;
        const r = await resolveRunner(c.id, null).catch(() => null);
        if (r?.available && r.runner) m[r.runner] = { installed: true, authed: true };
      }
      return m;
    }, // 토큰 회전을 따라가게 클라이언트 대신 "지금 세션의 클라이언트"를 넘긴다(sessionClient는 토큰이 같으면 캐시를 돌려준다 — 요청마다 세션 파일 확인만)
    transportFor: () => supabaseTransport(async () => (await sessionClient())?.client ?? null),
  });
  host.start();
  return host;
}
