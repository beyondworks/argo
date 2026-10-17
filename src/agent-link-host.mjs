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
import { SUPPORTED } from '../packages/agent-link/contract/v1.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, basename } from 'node:path';

export { agentLinkEnabled, legacyMsgrBridgeEnabled } from './agent-link-flags.mjs';

export const ATTACH_IN_MAX = 25 * 1024 * 1024; // 받은 첨부 한 개 상한(옛 브리지와 같은 25MB)
const SESSION_RETRY_MS = [60_000, 120_000, 300_000, 600_000];
export const RESYNC_MIN_MS = 60_000; // 게이트웨이 확인(10초)마다 불려도 로컬 목록은 1분에 한 번만 읽는다(보낼지는 바뀌었을 때만) // 세션·등록이 없을 때 다시 볼 간격(요청 폭주 없이, 상한 10분)

/** supabase-js 클라이언트를 link.mjs transport 모양으로. 받는 길은 비공개 broadcast 채널(event 'envelope') 하나. */
export function supabaseTransport(client) {
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
    // offer 첨부(#1076): 서명 URL이 아니라 Storage 위치. runner 세션으로 받는다(버킷 정책 = 그 방 일의 리스를 쥔 runner 기기만)
    async download(bucket, path) {
      const { data, error } = await client.storage.from(bucket).download(path);
      if (error || !data) throw Object.assign(new Error('download failed'), { code: 'download_failed' });
      return new Uint8Array(await data.arrayBuffer());
    },
    // 업로드 슬롯(서버가 정한 경로)에 runner 세션으로 올린다. 덮어쓰지 않는다(같은 슬롯에 두 번 올리지 않는다)
    async upload(bucket, path, bytes, mime) {
      const { error } = await client.storage.from(bucket).upload(path, bytes, { contentType: mime || 'application/octet-stream', upsert: false });
      if (error) throw Object.assign(new Error('upload failed'), { code: 'upload_failed' });
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

export const APPROVAL_TTL_MS = 24 * 3_600_000; // v2 승인 요청의 만료(서버가 그때 work.approval_decision{expire}를 보낸다)

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
    risk: item.kind === 'tool' || item.kind === 'connector' ? 'high' : 'medium',
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
  const agents = new Map(); // 서버 에이전트 id → { ws, slug }
  const agentIds = new Set();

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
      const closeLocal = (id) => deps.resolveApproval(a.ws, id, false, { resolvedBy: { via: 'msgr2', at: new Date(clock.now()).toISOString() } }).catch(() => {});
      async function bridge(item) {
        if (!policy.approvals) { await closeLocal(item.id); return ''; } // guest: 승인 요청을 보내지 않는다(서버도 tier_denied) — 막힌 턴을 풀어 준다
        let decision;
        try { decision = await ctx.requestApproval(approvalRequestFrom(item, clock.now())); }
        catch (e) { log('approval request failed', e.code ?? e.message); await closeLocal(item.id); return ''; }
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
        await closeLocal(item.id); // expire: 후속 턴 없이 닫는다
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
          mirrorCtx: { kind: 'scope', scope: { kind: 'link', work: offer.work, room: offer.data.room, owner: policy.ownerTools === true } },
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
    current = transport;
    // 기기 등록(U3 msgr2_device_register): runner 기기 + 지원 약속 범위. 답의 device_id가 봉투의 device다.
    // 러너 목록이 비면 서버가 이 기기에 일을 주지 않는다(경우 17) — CLI 감지 + 회사 설정의 러너(API 키 등)를 함께 본다
    const runners = deps.detectRunners ? await detectRunnerIds(() => deps.detectRunners(s.uid)) : [];
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
  const [{ sessionClient }, { chat }, { interruptTurn }, rf, { listCompanies, listAgents }, { paths }, { APP_VERSION }, { detectRunners, resolveRunner }, { onNotify }, { resolveWithFollowUp }, { resolveApproval }] = await Promise.all([
    import('./gateway/msgr.mjs'), import('./chat.mjs'), import('./turn-abort.mjs'), import('./gateway/msgr-reply-files.mjs'),
    import('./hub.mjs'), import('./workspace.mjs'), import('./app-version.mjs'), import('./runners.mjs'),
    import('./notify.mjs'), import('./approval-actions.mjs'), import('./approvals.mjs'),
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
    }, transportFor: (client) => supabaseTransport(client),
  });
  host.start();
  return host;
}
