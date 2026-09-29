// 아르고 메신저 채널 플러그인 — 오픈클로가 아르고 메신저에 **봇**으로 접속한다(텔레그램·슬랙과 같은 자리).
// 설정: channels["argo-msgr"].accounts.<id> { url, token, enabled }  (기본 계정은 env ARGO_MSGR_URL / ARGO_MSGR_BOT_TOKEN로도 가능 —
// 메신저 설정 → 외부 에이전트 카드가 보여주는 두 줄 그대로). 누가 봇에게 일을 시킬 수 있는지·어느 채널을 읽는지·채널 정책은 전부
// 아르고 서버가 판정한다(getUpdates는 멘션·DM·답글만, sendMessage는 답글마다 재판정) — 그래서 여기엔 허용 목록·페어링이 없다(dmPolicy open).
// OpenClaw 2026.9.x 플러그인 SDK: 루트 `openclaw/plugin-sdk`는 없어졌고 기능별 하위 경로만 있다(ERR_PACKAGE_PATH_NOT_EXPORTED).
import {
  DEFAULT_ACCOUNT_ID, deleteAccountFromConfigSection, setAccountEnabledInConfigSection, type ChannelPlugin, type PluginRuntime,
} from "openclaw/plugin-sdk/channel-plugin-common";
import { buildBaseAccountStatusSnapshot, buildBaseChannelStatusSummary } from "openclaw/plugin-sdk/status-helpers";
import { createChannelInboundEnvelopeBuilder } from "openclaw/plugin-sdk/channel-inbound";
import { formatTextWithAttachmentLinks, resolveOutboundMediaUrls } from "openclaw/plugin-sdk/reply-payload";
// 크루 계약 1-a — 위험 작업 승인을 메신저 결재 카드로(채널 네이티브 승인: approvalCapability.native + nativeRuntime), 결정은 게이트웨이 승인 서비스로.
import { createChannelApprovalCapability } from "openclaw/plugin-sdk/approval-delivery-runtime";
import { createChannelApprovalNativeRuntimeAdapter } from "openclaw/plugin-sdk/approval-handler-runtime";
import { CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY } from "openclaw/plugin-sdk/approval-handler-adapter-runtime";
import { resolveApprovalOverGateway } from "openclaw/plugin-sdk/approval-gateway-runtime";
import { registerChannelRuntimeContext } from "openclaw/plugin-sdk/channel-runtime-context";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { makeApi, MAX_LEN, pollLoop, relayPrompt, relayReply, recordCcReceipt } from "./api.js";
import { ApprovalBridge, RoutineMirror, ROUTINES_EVERY_MS } from "./contract.js";

export const CHANNEL_ID = "argo-msgr" as const;
let runtime: PluginRuntime | null = null;
export function setArgoRuntime(next: PluginRuntime) { runtime = next; }
function core(): PluginRuntime { if (!runtime) throw new Error("argo-msgr runtime not initialized"); return runtime; }

type AccountConfig = { url?: string; token?: string; enabled?: boolean; name?: string };
export type ResolvedAccount = { accountId: string; enabled: boolean; configured: boolean; url: string; token: string; name?: string; config: AccountConfig };

function section(cfg: any): { accounts?: Record<string, AccountConfig> } & AccountConfig { return (cfg?.channels?.[CHANNEL_ID] ?? {}) as any; }
export function listAccountIds(cfg: any): string[] {
  const ids = Object.keys(section(cfg).accounts ?? {});
  if (ids.length) return ids;
  return process.env.ARGO_MSGR_URL && process.env.ARGO_MSGR_BOT_TOKEN ? [DEFAULT_ACCOUNT_ID] : [];
}
export function resolveAccount(cfg: any, accountId?: string): ResolvedAccount {
  const id = accountId ?? DEFAULT_ACCOUNT_ID;
  const { accounts: _a, ...base } = section(cfg);
  const acc: AccountConfig = { ...base, ...(section(cfg).accounts?.[id] ?? {}) };
  const url = (acc.url ?? (id === DEFAULT_ACCOUNT_ID ? process.env.ARGO_MSGR_URL : "") ?? "").trim();
  const token = (acc.token ?? (id === DEFAULT_ACCOUNT_ID ? process.env.ARGO_MSGR_BOT_TOKEN : "") ?? "").trim();
  return { accountId: id, enabled: acc.enabled !== false, configured: Boolean(url && token), url, token, name: acc.name, config: acc };
}

// ── 크루 계약 1-a: 예약 작업 미러·편집, 위험 작업 결재 카드 ─────────────────────────────────────────────
// 예약 작업은 OpenClaw가 게이트웨이 서비스에 주는 스케줄러 핸들(ctx.getCron → list/update/remove)로만 읽고 고친다(저장소 직접 수정 금지).
// index.ts의 registerFull이 서비스를 등록하고 시작 때 attachCronService를 부른다.
type CronService = { list: (o?: { includeDisabled?: boolean }) => Promise<any[]>; update: (id: string, patch: any) => Promise<unknown>; remove: (id: string) => Promise<unknown> };
let cronHost: { started: boolean; getCron?: () => CronService | undefined } = { started: false };
const moduleLoadedAt = Date.now();
export function attachCronService(ctx: { getCron?: () => any }) { cronHost = { started: true, getCron: ctx?.getCron }; }
export function detachCronService() { cronHost = { started: false }; }
async function cronAccess(): Promise<{ state: "ready"; cron: CronService } | { state: "pending" } | { state: "unsupported"; reason: string }> {
  if (!cronHost.started) {
    // 게이트웨이가 서비스를 시작하지 않는 호스트(서비스 없는 실행·옛 버전)면 5분 뒤 "지원 안 함"으로 알린다 — 조용히 빠지지 않는다
    return Date.now() - moduleLoadedAt > 300_000 ? { state: "unsupported", reason: "This OpenClaw process does not run plugin services, so scheduled jobs cannot be mirrored" } : { state: "pending" };
  }
  if (typeof cronHost.getCron !== "function") return { state: "unsupported", reason: "This OpenClaw version does not give plugins the scheduler (service ctx.getCron missing)" };
  let cron: any;
  try { cron = cronHost.getCron(); } catch { return { state: "pending" }; } // 스케줄러 교체·종료 중
  if (!cron) return { state: "pending" }; // 스케줄러가 아직 올라오지 않았다
  if (typeof cron.list !== "function" || typeof cron.update !== "function" || typeof cron.remove !== "function") return { state: "unsupported", reason: "This OpenClaw scheduler handle lacks list/update/remove" };
  return { state: "ready", cron };
}
type Live = { accountId: string; bridge: ApprovalBridge; mirror: RoutineMirror; log: (s: string) => void };
const live = new Map<string, Live>();
const liveFor = (accountId?: string | null) => live.get(accountId ?? DEFAULT_ACCOUNT_ID);
function routinesStateFile(account: ResolvedAccount) { // 작업별 지문·사람이 고친 시각(Hermes와 같은 자리: ~/.argo-msgr/routines-<서버·토큰 해시>.json, 토큰은 넣지 않는다)
  const outbox = process.env.ARGO_MSGR_OUTBOX_DIR || join(homedir(), ".argo-msgr", "outbox");
  const key = createHash("sha256").update(account.url.replace(/\/+$/, "") + "\0" + account.token).digest("hex").slice(0, 24);
  return join(dirname(outbox), `routines-${key}.json`);
}
const wait = (ms: number, signal: AbortSignal) => new Promise<void>((r) => { const t = setTimeout(r, ms); signal.addEventListener("abort", () => { clearTimeout(t); r(); }, { once: true }); });

/** 승인 요청이 이 계정의 메신저 대화에서 시작됐으면 그 채널 id. 다른 채널·계정의 요청은 기존 OpenClaw 경로로 둔다. */
// 답 대상은 "argo-msgr:<채널 id>"로 기록된다(아래 reply.to) — 서버 chat_id는 접두어 없는 uuid라, 보내기 전에 벗긴다.
// 재시작 복구 경로가 이 값을 그대로 sendText에 넘겨 400으로 거절되던 결함(2026-09-29 격리 실측).
export function bareChatId(to: unknown): string {
  return String(to ?? "").trim().replace(/^argo-msgr:/i, "").replace(/^channel:/i, "");
}
function originChat(request: any, accountId?: string | null): string | null {
  const r = request?.request ?? {};
  if (String(r.turnSourceChannel ?? "").toLowerCase() !== CHANNEL_ID) return null;
  if (r.turnSourceAccountId && accountId && String(r.turnSourceAccountId) !== accountId) return null;
  const to = bareChatId(r.turnSourceTo);
  return /^[0-9a-f-]{36}$/i.test(to) ? to : null;
}
/** 카드에 실을 명령·사유. 위험 등급과 카드 본문은 서버가 정한다(셸 명령 = 고위험). */
function approvalCard(request: any, kind: string, view: any): { command: string; reason: string | null } {
  const r = request?.request ?? {};
  if (kind === "plugin") return { command: [r.title, r.toolName ? `(${r.toolName})` : ""].filter(Boolean).join(" ") || "OpenClaw plugin action", reason: [r.description, r.pluginId ? `plugin: ${r.pluginId}` : ""].filter(Boolean).join(" — ") || null };
  const command = String(view?.commandText || r.commandPreview || r.command || "");
  return { command, reason: [r.warningText || "OpenClaw exec approval", r.cwd ? `cwd: ${r.cwd}` : ""].filter(Boolean).join(" — ") };
}
const argoApprovalRuntime = createChannelApprovalNativeRuntimeAdapter({
  eventKinds: ["exec", "plugin"], // system-agent(게이트웨이 설정 변경)는 OpenClaw 운영자 화면에 둔다
  availability: {
    isConfigured: ({ accountId }: any) => Boolean(liveFor(accountId)),
    shouldHandle: ({ accountId, request }: any) => Boolean(liveFor(accountId) && originChat(request, accountId)),
  },
  presentation: {
    buildPendingPayload: ({ request, approvalKind, view }: any) => approvalCard(request, approvalKind, view),
    buildResolvedResult: () => ({ kind: "update", payload: {} }),
    buildExpiredResult: () => ({ kind: "update", payload: {} }),
  },
  transport: {
    prepareTarget: ({ plannedTarget }: any) => ({ dedupeKey: `${CHANNEL_ID}:${plannedTarget.target.to}`, target: { chatId: String(plannedTarget.target.to) } }),
    deliverPending: async ({ accountId, preparedTarget, request, approvalKind, pendingPayload }: any) => {
      const l = liveFor(accountId);
      if (!l) return null;
      try { // 카드를 못 만들면 null — OpenClaw 기존 경로(/approve·운영자 화면)가 그대로 남는다
        return await l.bridge.request({ externalId: request.id, kind: approvalKind, chatId: preparedTarget.chatId, command: pendingPayload.command, reason: pendingPayload.reason });
      } catch (e) {
        l.log(`argo-msgr: approval card failed for ${request.id}: ${String((e as any)?.message ?? e)}`);
        return null;
      }
    },
    // 결정됐거나(다른 곳에서 결정 포함) 시간 초과로 끝나면: 아직 열린 카드는 expireApproval로 닫는다. 메신저 결정으로 푼 것은 이미 닫혀 있다.
    updateEntry: async ({ accountId, entry }: any) => { const l = liveFor(accountId); if (l && entry?.externalId) await l.bridge.expire(entry.externalId); },
  },
});

// 원글당 답글은 하나(서버가 reply:<crew>:<src>로 묶는다) — 첫 덩어리만 답글, 나머지는 평문
const replied = new Set<number>();
async function sendText(account: ResolvedAccount, target: string, text: string, replyTo?: number) {
  const to = bareChatId(target);
  const api = makeApi({ url: account.url, token: account.token });
  const src = replyTo != null && !replied.has(replyTo) ? replyTo : undefined;
  const res = await api.sendMessage(to, text, src);
  if (src != null) replied.add(src);
  core().channel.activity.record({ channel: CHANNEL_ID, accountId: account.accountId, direction: "outbound" });
  return { channel: CHANNEL_ID, messageId: String(res?.message_id ?? ""), target: { kind: "channel" as const, id: to } };
}

async function handleInbound(params: { m: any; account: ResolvedAccount; cfg: any; log: (s: string) => void; statusSink?: (p: any) => void }) {
  const { m, account, cfg, log } = params;
  const c = core();
  const rawBody = String(m?.text ?? "").trim();
  const chatId = String(m?.chat?.id ?? "");
  if (!rawBody || !chatId) return;
  const isGroup = m?.chat?.kind !== "dm";
  const chatName = String(m?.chat?.name ?? chatId);
  const senderName = String(m?.from?.name ?? "");
  const senderId = String(m?.from?.id ?? "");
  const messageId = Number(m?.message_id ?? 0);
  const timestamp = m?.date ? Number(m.date) * 1000 : Date.now();
  params.statusSink?.({ lastInboundAt: timestamp });
  c.channel.activity.record({ channel: CHANNEL_ID, accountId: account.accountId, direction: "inbound", at: timestamp });

  if (m.delivery_role === 'cc') {
    await recordCcReceipt(account, m);
    return;
  }

  const resolvedRoute = c.channel.routing.resolveAgentRoute({ cfg, channel: CHANNEL_ID, accountId: account.accountId, peer: { kind: isGroup ? "group" : "direct", id: chatId } });
  const route = { ...resolvedRoute };
  // A server-authorized DM thread must not resume a provider's shared direct-message session.
  if (!isGroup) route.sessionKey = `${route.sessionKey}:argo-dm:${encodeURIComponent(chatId)}:${m.delegated ? m.thread_root || messageId : 'conversation'}`;
  // 모델이 읽는 본문은 BodyForAgent다 — 스레드 맥락·넘김 규칙(relayPrompt)을 여기에 싣는다. Body는 사람이 읽는 봉투(기록·표시용).
  const prompt = relayPrompt(m);
  const from = isGroup ? `#${chatName} · ${senderName}` : senderName;
  const envelope = createChannelInboundEnvelopeBuilder({ cfg, route })({ channel: "Argo Messenger", from, timestamp, body: prompt });
  const peerAddress = isGroup ? `${CHANNEL_ID}:channel:${chatId}` : `${CHANNEL_ID}:${senderId}`;
  const ctxPayload = c.channel.inbound.buildContext({
    channel: CHANNEL_ID, accountId: route.accountId ?? account.accountId, messageId: String(messageId), timestamp,
    from: peerAddress,
    sender: { id: senderId, name: senderName || undefined },
    conversation: { kind: isGroup ? "group" : "direct", id: chatId, label: isGroup ? `#${chatName}` : senderName },
    route: { agentId: route.agentId, dmScope: route.dmScope, accountId: route.accountId, routeSessionKey: route.sessionKey, dispatchSessionKey: route.sessionKey },
    reply: { to: `${CHANNEL_ID}:${chatId}`, originatingTo: `${CHANNEL_ID}:${chatId}` },
    message: { body: envelope, bodyForAgent: prompt, rawBody, commandBody: rawBody },
    // 서버가 멘션·DM·답글만 보낸다. 제어 명령(/…)은 아르고 채널에서 받지 않는다.
    access: { mentions: { canDetectMention: true, wasMentioned: true }, commands: { authorized: false } },
    extra: { GroupSubject: isGroup ? chatName : undefined },
  });
  const chunks: string[] = [];
  const bridge = liveFor(account.accountId)?.bridge;
  bridge?.track(m); // 이 턴 안에서 오는 승인 요청은 이 원문의 실행 시도로 카드를 만든다
  try {
  // 답은 모아서 한 번에 보낸다(원글당 답글 하나 + 넘김 표지). 운영자가 visibleReplies=message_tool로 바꿔도 이 채널은 자동 전달로 고정한다.
  await c.channel.inbound.dispatch({
    cfg, channel: CHANNEL_ID, accountId: account.accountId,
    route: { agentId: route.agentId, dmScope: route.dmScope, sessionKey: route.sessionKey },
    ctxPayload,
    record: { onRecordError: (err: unknown) => log(`argo-msgr: session meta failed: ${String(err)}`) },
    delivery: {
      deliver: async (payload: any, info: { kind: string }) => {
        if (info.kind !== "final" || payload.isReasoning) return;
        const text = formatTextWithAttachmentLinks(payload.text, resolveOutboundMediaUrls(payload));
        if (text) chunks.push(text);
      },
      onError: (err: unknown, info: { kind: string }) => log(`argo-msgr ${info?.kind} reply failed: ${String(err)}`),
    },
    replyOptions: { disableBlockStreaming: true, sourceReplyDeliveryMode: "automatic" },
    replyPipeline: {},
  });
  if (chunks.length) {
    const answer = relayReply(chunks.join("\n\n"), m);
    if (answer.text.length > MAX_LEN) throw new Error("Argo Messenger reply exceeds the channel message limit");
    await makeApi({ url: account.url, token: account.token }).sendMessage(chatId, answer.text, messageId, answer.execution);
    params.statusSink?.({ lastOutboundAt: Date.now() });
  }
  } finally {
    bridge?.done(m);
  }
}

async function handleEvent(ev: any, l: Live) {
  if (ev?.event === "routine_edit") await l.mirror.applyEdit(ev);
  else if (ev?.event === "approval_decided") await l.bridge.onDecided(ev);
}

export const argoMsgrPlugin: ChannelPlugin<ResolvedAccount> = {
  id: CHANNEL_ID,
  meta: { id: CHANNEL_ID, label: "Argo Messenger", selectionLabel: "Argo Messenger (bot API)", docsPath: "/channels/argo-msgr",
    blurb: "Company team messenger with AI crews; OpenClaw joins as an external agent bot.", aliases: ["argo"] },
  capabilities: { chatTypes: ["direct", "group"], media: false, blockStreaming: false },
  approvalCapability: createChannelApprovalCapability({
    native: {
      describeDeliveryCapabilities: ({ accountId }: any) => ({ enabled: Boolean(liveFor(accountId)), preferredSurface: "origin", supportsOriginSurface: true, supportsApproverDmSurface: false }),
      resolveOriginTarget: ({ accountId, request }: any) => { const chat = originChat(request, accountId); return chat ? { to: chat } : null; },
    },
    nativeRuntime: argoApprovalRuntime,
  }),
  reload: { configPrefixes: [`channels.${CHANNEL_ID}`] },
  config: {
    listAccountIds, resolveAccount, defaultAccountId: () => DEFAULT_ACCOUNT_ID,
    setAccountEnabled: ({ cfg, accountId, enabled }) => setAccountEnabledInConfigSection({ cfg, sectionKey: CHANNEL_ID, accountId, enabled, allowTopLevel: true }),
    deleteAccount: ({ cfg, accountId }) => deleteAccountFromConfigSection({ cfg, sectionKey: CHANNEL_ID, accountId, clearBaseFields: ["name", "url", "token"] }),
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({ accountId: account.accountId, name: account.name, enabled: account.enabled, configured: account.configured, url: account.url }),
    resolveAllowFrom: () => ["*"],
  },
  security: {
    resolveDmPolicy: ({ accountId }) => ({ policy: "open", allowFrom: ["*"], policyPath: `channels.${CHANNEL_ID}.accounts.${accountId ?? DEFAULT_ACCOUNT_ID}.dmPolicy`,
      allowFromPath: `channels.${CHANNEL_ID}.accounts.${accountId ?? DEFAULT_ACCOUNT_ID}.allowFrom`, approveHint: "Access is decided by the Argo Messenger server (who may instruct the bot, channel policy)." }),
    collectWarnings: () => [],
  },
  groups: { resolveRequireMention: () => false },      // 서버가 이미 멘션·DM·답글만 보낸다
  messaging: { normalizeTarget: (raw) => bareChatId(raw), targetResolver: { looksLikeId: (raw) => /^[0-9a-f-]{36}$/i.test(bareChatId(raw)), hint: "<channel id>" } },
  outbound: {
    deliveryMode: "direct", chunkerMode: "markdown", textChunkLimit: MAX_LEN,
    chunker: (text, limit) => core().channel.text.chunkMarkdownText(text, limit),
    sendText: async ({ cfg, to, text, accountId, replyToId }) => sendText(resolveAccount(cfg, accountId ?? undefined), to, text, replyToId ? Number(replyToId) : undefined),
    sendMedia: async ({ cfg, to, text, mediaUrl, accountId, replyToId }) => sendText(resolveAccount(cfg, accountId ?? undefined), to, mediaUrl ? `${text}\n\n${mediaUrl}` : text, replyToId ? Number(replyToId) : undefined),
  },
  status: {
    defaultRuntime: { accountId: DEFAULT_ACCOUNT_ID, running: false, lastStartAt: null, lastStopAt: null, lastError: null },
    buildChannelSummary: ({ account, snapshot }) => ({ ...buildBaseChannelStatusSummary(snapshot), url: account.url }),
    buildAccountSnapshot: ({ account, runtime: rt, probe }) => ({ ...buildBaseAccountStatusSnapshot({ account, runtime: rt, probe }), url: account.url }),
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      if (!account.configured) throw new Error(`Argo Messenger is not configured for account "${account.accountId}" (need url and token in channels.${CHANNEL_ID}).`);
      const api = makeApi({ url: account.url, token: account.token });
      const me: any = await api.getMe();
      ctx.log?.info(`[${account.accountId}] Argo Messenger: connected as ${me?.first_name} (${me?.kind}) in org ${me?.org?.name}`);
      const abort = new AbortController();
      const onAbort = () => abort.abort();
      ctx.abortSignal?.addEventListener("abort", onAbort, { once: true });
      const log = (s: string) => ctx.log?.warn?.(s) ?? ctx.log?.info?.(s);
      // 크루 계약 1-a: 이 계정의 결재 카드 다리·예약 작업 미러. 승인 결정은 게이트웨이 승인 서비스(approval.resolve)로 돌려준다.
      const bridge = new ApprovalBridge({ api, log, resolve: ({ externalId, kind, decision }: any) => resolveApprovalOverGateway({ cfg: ctx.cfg, approvalId: externalId, decision, approvalKind: kind }) });
      const mirror = new RoutineMirror({ api, cronAccess, accountId: account.accountId, log, stateFile: routinesStateFile(account),
        ownsUnscoped: () => listAccountIds(ctx.cfg).length <= 1 || account.accountId === DEFAULT_ACCOUNT_ID });
      const l: Live = { accountId: account.accountId, bridge, mirror, log };
      live.set(account.accountId, l);
      // 코어가 이 계정의 네이티브 승인 핸들러를 띄우게 한다(요청 구독·만료·중복 제거는 코어 몫, 카드 전송·만료 알림은 위 nativeRuntime)
      const approvalsLease = registerChannelRuntimeContext({ channelRuntime: (ctx as any).channelRuntime, channelId: CHANNEL_ID, accountId: account.accountId,
        capability: CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY, context: { accountId: account.accountId }, abortSignal: abort.signal });
      const stopMirror = new AbortController();
      const mirrorLoop = (async () => { // 60초마다 읽고, 바뀌었을 때만 setRoutines(1시간마다 재확인)
        await wait(3_000, stopMirror.signal);
        while (!stopMirror.signal.aborted) {
          try { await mirror.sync(); } catch (e) { log(`argo-msgr: routine mirror failed — ${String((e as any)?.message ?? e)}`); }
          await wait(ROUTINES_EVERY_MS, stopMirror.signal);
        }
      })();
      // 이 프로미스가 끝나면 게이트웨이는 계정이 종료된 것으로 보고 자동 재시작한다(실측 2026-09-08: 접속 직후 재시작 반복) — 중지 신호까지 폴링 루프를 기다린다.
      try {
        await pollLoop(api, { signal: abort.signal, log, onEvent: (ev) => handleEvent(ev, l),
          onMessage: (m) => handleInbound({ m, account, cfg: ctx.cfg, log, statusSink: (patch) => ctx.setStatus({ accountId: ctx.accountId, ...patch }) }) });
      } finally {
        ctx.abortSignal?.removeEventListener("abort", onAbort);
        stopMirror.abort();
        await mirrorLoop;
        approvalsLease?.dispose();
        if (live.get(account.accountId) === l) live.delete(account.accountId);
      }
      if (!abort.signal.aborted) throw new Error("Argo Messenger: bot token rejected — rotate the token in Argo Messenger settings and update the config");
    },
  },
};
