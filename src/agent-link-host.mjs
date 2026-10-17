// 본체 ↔ agent-link 연결부(메신저 v2, 설계 2026-10-17 3절·U4). packages/agent-link/link.mjs에 Supabase 연결과 Argo 턴 실행을 넣는다.
// 옵트인: ARGO_AGENT_LINK=1일 때만 켠다(기본 꺼짐 — 지금 배포본 동작 그대로). 옛 메신저 브리지는 ARGO_MSGR_LEGACY=off일 때만 끈다(기본 켜짐).
// 두 플래그는 따로다: 새 링크를 켜도 옛 브리지는 그대로 돈다(옛 표는 서버의 중단 스위치가 막는다). 옛 브리지를 끄는 것은 이전이 끝난 뒤의 일이다.
//
// 1판 범위(설계 D16·이 PR 본문 "하지 않은 것"):
// - 주인(owner) 등급 일만 실행한다. team·guest 등급은 받은 뒤 work.error{tier_denied}로 알린다 — 손님 도구 축소(chat.mjs isGuestCtx)는
//   옛 메신저 문맥(kind:'msgr')에 묶여 있어 그 문맥 없이 손님 턴을 안전하게 돌릴 길이 아직 없다(돌리지 않는 것이 가장 좁은 도구다).
// - 결재·되돌릴 수 없는 일 기록(work.approval_request·work.effect)은 부품이 지원하지만, 이 연결부는 아직 chat()의 결재와 잇지 않는다:
//   주인 턴의 결재는 지금처럼 데스크톱 결재함에 쌓이고, 답 글이 "결재를 올렸다"고 알린다.
// - 넘김(handoffs)은 보내지 않는다(offer에 동료 목록이 없다 — U2가 싣으면 잇는다).
import { createLink } from '../packages/agent-link/link.mjs';
import { SUPPORTED } from '../packages/agent-link/contract/v1.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, basename } from 'node:path';

export { agentLinkEnabled, legacyMsgrBridgeEnabled } from './agent-link-flags.mjs';

export const ATTACH_IN_MAX = 25 * 1024 * 1024; // 받은 첨부 한 개 상한(옛 브리지와 같은 25MB)
const SESSION_RETRY_MS = [60_000, 120_000, 300_000, 600_000];
export const RESYNC_MIN_MS = 60_000; // 게이트웨이 확인(10초)마다 불려도 로컬 목록은 1분에 한 번만 읽는다(보낼지는 바뀌었을 때만) // 세션·등록이 없을 때 다시 볼 간격(요청 폭주 없이, 상한 10분)

/** supabase-js 클라이언트를 link.mjs transport 모양으로. 받는 길은 비공개 broadcast 채널(event 'envelope') 하나. */
export function supabaseTransport(client, { fetchImpl = fetch } = {}) {
  const channels = new Map();
  return {
    async rpc(name, args) {
      const { data, error, status } = await client.rpc(name, args);
      return { data, error: error ? { code: error.code ?? null, message: error.message ?? '', status: error.status ?? status ?? 0 } : null };
    },
    subscribe(topic, onEnvelope, onStatus) {
      const ch = client.channel(topic, { config: { private: true } });
      ch.on('broadcast', { event: 'envelope' }, (msg) => onEnvelope(msg?.payload));
      ch.subscribe((status) => {
        if (status === 'SUBSCRIBED') onStatus?.('connected');
        else if (status === 'CLOSED' || status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') onStatus?.('disconnected');
      });
      channels.set(topic, ch);
      return { close: () => { channels.delete(topic); client.removeChannel?.(ch); } };
    },
    async broadcast(topic, envelope) {
      // 진행 표시는 저장하지 않는 방송이다(설계 D7). 채널을 만들어 두고 다시 쓴다.
      let ch = channels.get(topic);
      if (!ch) { ch = client.channel(topic, { config: { private: true } }); channels.set(topic, ch); ch.subscribe(); }
      await ch.send({ type: 'broadcast', event: 'envelope', payload: envelope });
    },
    async put(url, bytes, mime) {
      const r = await fetchImpl(url, { method: 'PUT', headers: { 'content-type': mime || 'application/octet-stream' }, body: bytes });
      if (!r.ok) throw Object.assign(new Error(`upload ${r.status}`), { code: 'upload_failed' });
    },
  };
}

/** 이 기기에서 쓸 수 있는 러너 id(설치·로그인 둘 다) — 정렬해서(순서만 바뀌어도 서버 쓰기가 생기지 않게). 감지 실패·초과는 빈 목록. */
export async function detectRunnerIds(detect, { timeoutMs = 3000 } = {}) {
  try {
    const m = await Promise.race([detect(), new Promise((r) => setTimeout(r, timeoutMs, null))]);
    return Object.entries(m ?? {}).filter(([, v]) => v?.installed && v?.authed).map(([k]) => k).sort();
  } catch { return []; }
}

/** msgr2_device_register 인자(U3) — runner 기기 + 지원 약속 범위 + 정렬한 러너 목록. 로그인 지점과 연결부 시작이 같은 모양을 쓴다. */
export const runnerRegisterArgs = ({ appVersion = null, runners = [] } = {}) => ({
  kind: 'runner', app: 'argo', app_version: appVersion, link_min: SUPPORTED.min, link_max: SUPPORTED.max, runners: [...new Set(runners)].sort(),
});

/**
 * 로그인 응답을 받은 즉시, 세션 파일을 쓰기 전에 그 세션을 runner 기기로 잠근다(검수 1 #1071 경주 창: 다시 로그인한 직후
 * 에이전트 셸이 새 세션 파일을 읽어 app 기기로 먼저 등록할 수 있다 — app 등록은 로그인 10분 안 세션만 받는다).
 * 짧게 3번까지 다시 해 본다. 그래도 실패하면 로그인은 그대로 진행한다(로그인을 막지 않는다) — 연결부가 시작할 때 다시 등록하고,
 * 등록이 성공하기 전에는 메신저 v2 일을 받지 않는다(boot 순서). 반환: { ok, device_id?, code? }.
 */
export async function registerRunnerOnLogin({ url, anonKey, accessToken }, { mkClient, appVersion = null, runners = [], attempts = 3, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = (...a) => console.error('[argo] agent-link', ...a) } = {}) {
  const client = mkClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${accessToken}` } } });
  let last = null;
  for (let i = 0; i < attempts; i++) {
    if (i) await sleep(300 * 3 ** (i - 1));
    try {
      const { data, error } = await client.rpc('msgr2_device_register', runnerRegisterArgs({ appVersion, runners }));
      if (!error && data?.device_id) return { ok: true, device_id: data.device_id };
      last = error?.code ?? data?.code ?? 'no_device_id';
      if (error && error.status && error.status < 500 && error.status !== 429) break; // 영구 거부(함수 없음·권한) — 다시 해도 같다
    } catch (e) { last = 'network'; }
  }
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

const safeName = (n) => basename(String(n || 'file')).replace(/[^\p{L}\p{N}._-]+/gu, '_').slice(0, 120) || 'file';

/**
 * 연결부. deps는 시험이 가짜로 바꾼다.
 * deps = { getSession() → { client, uid } | null, listOwnedAgents(uid) → [{ ws, slug, name, role }], chat, interruptTurn,
 *          planReplyFiles, readReplyFile, vaultDir(ws), appVersion, clock, log, transportFor(client), fetchImpl }
 */
export function createAgentLinkHost(deps) {
  const { clock = { now: () => Date.now(), setTimeout, clearTimeout }, log = (...a) => console.error('[argo] agent-link', ...a) } = deps;
  let link = null, timer = null, stopped = false, tries = 0, lastResync = -Infinity;
  const agents = new Map(); // 서버 에이전트 id → { ws, slug }
  const agentIds = new Set();

  async function attachments(offer, ws) {
    const out = [];
    const dir = join(deps.vaultDir(ws), 'files', 'msgr2');
    for (const a of offer.data.attachments) {
      if (a.bytes > ATTACH_IN_MAX) continue;
      try {
        const r = await (deps.fetchImpl ?? fetch)(a.url);
        if (!r.ok) continue;
        const buf = Buffer.from(await r.arrayBuffer());
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
      const a = agents.get(offer.agent);
      if (!a) throw Object.assign(new Error('agent not on this device'), { code: 'no_runner' });
      if (ctx.tier !== 'owner') throw Object.assign(new Error('tier not served by this Argo build'), { code: 'tier_denied' });
      ctx.progress('thinking');
      const onAbort = () => { deps.interruptTurn(a.ws, a.slug, { source: 'messenger', tag: offer.work }).catch(() => {}); };
      ctx.signal.addEventListener('abort', onAbort, { once: true });
      try {
        const files = await attachments(offer, a.ws);
        const text = contextSection(offer.data.context) + offer.data.text;
        const turn = await deps.chat(a.ws, a.slug, text, null, {
          source: 'messenger', attachments: files, abortTag: offer.work,
          // 일지: offer.memory가 거짓이면 남기지 않는다(기억 안 남김 방). 참이면 chat()의 기본 일지(주인 턴)
          ...(offer.data.memory === false ? { journal: { off: true } } : {}),
        });
        if (ctx.signal.aborted) return null;
        ctx.progress('writing');
        const reply = String(turn?.reply ?? '');
        const plan = await deps.planReplyFiles(a.ws, reply).catch(() => ({ body: reply, files: [] }));
        const slots = [];
        for (const f of plan.files) {
          try { slots.push(await ctx.upload(f.name, await deps.readReplyFile(a.ws, f), undefined)); }
          catch (e) { log('reply file upload failed', e.code ?? e.message); }
        }
        return { text: plan.body, files: slots, ...(turn?.costUsd != null ? { usage: { cost_usd: turn.costUsd } } : {}) };
      } finally {
        ctx.signal.removeEventListener('abort', onAbort);
      }
    },
    onEvent(name, detail) {
      if (['update_required', 'device_invalid', 'paused', 'lease_lost', 'report_failed', 'accept_failed'].includes(name)) log(name, JSON.stringify(detail));
    },
  };

  function retryLater() {
    if (stopped) return;
    const ms = SESSION_RETRY_MS[Math.min(tries++, SESSION_RETRY_MS.length - 1)];
    timer = clock.setTimeout(() => { timer = null; boot().catch((e) => log('boot failed', e.message)); }, ms);
  }

  async function boot() {
    if (stopped || link) return;
    const s = await deps.getSession();
    if (!s) return retryLater();
    const transport = deps.transportFor(s.client);
    // 기기 등록(U3 msgr2_device_register): runner 기기 + 지원 약속 범위. 답의 device_id가 봉투의 device다.
    const runners = deps.detectRunners ? await detectRunnerIds(deps.detectRunners) : [];
    const reg = await transport.rpc('msgr2_device_register', runnerRegisterArgs({ appVersion: deps.appVersion ?? null, runners }));
    const device = reg?.data?.device_id;
    if (reg.error || !device) { log('device register failed', reg.error?.code ?? reg.data?.code ?? 'no device_id'); return retryLater(); }
    tries = 0;
    lastResync = clock.now();
    link = createLink({ transport, host, uid: s.uid, device, agentIds, clock: deps.linkClock });
    await resync();
    link.start();
  }

  /** 로컬 에이전트 목록을 보낸다(바뀌었을 때만 요청). 답의 대응표로 이 본체가 맡을 에이전트를 정한다. */
  async function resync() {
    if (!link) return;
    const s = await deps.getSession();
    if (!s) return;
    const list = await deps.listOwnedAgents(s.uid);
    const r = await link.syncAgents(list.map((x) => ({ ws: x.ws, slug: x.slug, name: x.name || x.slug, role: String(x.role ?? '').slice(0, 2000), face_hash: null })));
    if (!r.sent) return;
    agents.clear(); agentIds.clear();
    for (const m of r.data?.agents ?? []) {
      if (list.some((x) => x.ws === m.ws && x.slug === m.slug)) { agents.set(m.id, { ws: m.ws, slug: m.slug }); agentIds.add(m.id); }
    }
  }

  return {
    start() { stopped = false; boot().catch((e) => { log('boot failed', e.message); retryLater(); }); return this; },
    stop() { stopped = true; if (timer) clock.clearTimeout(timer); timer = null; link?.stop(); link = null; },
    resync() {
      if (clock.now() - lastResync < RESYNC_MIN_MS) return Promise.resolve();
      lastResync = clock.now();
      return resync().catch((e) => log('agent sync failed', e.code ?? e.message));
    },
    get link() { return link; },
    get agents() { return agents; },
  };
}

/** 게이트웨이가 부르는 실제 연결부(진짜 세션·chat()). 플래그가 꺼져 있으면 부르지 않는다(gateway.mjs). */
export async function startAgentLinkHost() {
  const [{ sessionClient }, { chat }, { interruptTurn }, rf, { listCompanies, listAgents }, { paths }, { APP_VERSION }, { detectRunners }] = await Promise.all([
    import('./gateway/msgr.mjs'), import('./chat.mjs'), import('./turn-abort.mjs'), import('./gateway/msgr-reply-files.mjs'),
    import('./hub.mjs'), import('./workspace.mjs'), import('./app-version.mjs'), import('./runners.mjs'),
  ]);
  const host = createAgentLinkHost({
    getSession: async () => { const c = await sessionClient(); return c ? { client: c.client, uid: c.uid } : null; },
    async listOwnedAgents(uid) {
      const out = [];
      for (const c of await listCompanies()) {
        if (c.ownerId !== uid) continue; // 주인 계정의 회사만(옛 브리지의 소유자 관문과 같은 기준, msgr.mjs 713)
        for (const a of await listAgents(c.id).catch(() => [])) out.push({ ws: c.id, slug: a.slug, name: a.name, role: a.role });
      }
      return out;
    },
    chat, interruptTurn, planReplyFiles: rf.planReplyFiles, readReplyFile: rf.readReplyFile,
    vaultDir: (ws) => paths(ws).vault, appVersion: APP_VERSION, detectRunners: () => detectRunners(), transportFor: (client) => supabaseTransport(client),
  });
  host.start();
  return host;
}
