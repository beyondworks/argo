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
import { resolveOutboundMediaUrls } from "openclaw/plugin-sdk/reply-payload";
// 크루 계약 1-a — 위험 작업 승인을 메신저 결재 카드로(채널 네이티브 승인: approvalCapability.native + nativeRuntime), 결정은 게이트웨이 승인 서비스로.
import { createChannelApprovalCapability } from "openclaw/plugin-sdk/approval-delivery-runtime";
import { createChannelApprovalNativeRuntimeAdapter } from "openclaw/plugin-sdk/approval-handler-runtime";
import { CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY } from "openclaw/plugin-sdk/approval-handler-adapter-runtime";
import { resolveApprovalOverGateway } from "openclaw/plugin-sdk/approval-gateway-runtime";
import { registerChannelRuntimeContext } from "openclaw/plugin-sdk/channel-runtime-context";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ArgoMsgrError, deferTurnFile, deliverFiles, settlePendingFiles, downloadAttachments, findFileTurn, makeApi, MAX_FILE_BYTES, MAX_LEN, openFileTurn, parseMessengerDisposition, pollLoop, relayPrompt, relayReply, recordCcReceipt } from "./api.js";
import { APPROVAL_TOOL, APPROVAL_TOOL_DESCRIPTION, APPROVAL_TOOL_NEXT, APPROVAL_TOOL_PARAMETERS, ApprovalBridge, RoutineMirror, ROUTINES_EVERY_MS } from "./contract.js";

export const CHANNEL_ID = "argo-msgr" as const;
let runtime: PluginRuntime | null = null;
export function setArgoRuntime(next: PluginRuntime) { runtime = next; }
// 크루 계약 1-b ①: 메신저에 보고하는 어댑터 버전 — index.ts registerFull이 api.version(매니페스트 version → package.json version)을 넘긴다
let pluginVersion = "";
export function setPluginVersion(v: unknown) { if (typeof v === "string" && v.trim()) pluginVersion = v.trim(); }
/** 1-b ①: exec 승인 모드 = 이 계정에 묶인 에이전트의 agents.entries.<id>.tools.exec.mode(있으면, 검수 L2) → 설정 tools.exec.mode
 *  (deny|allowlist|ask|auto|full). 둘 다 없으면 OpenClaw 기본값 full(승인 없음, docs/tools/exec.md:116).
 *  호스트 승인 문서까지 합친 실제 값은 비공개 경로라 쓰지 않는다 — 설정값만 보고한다. */
export function execApprovalMode(cfg?: any, accountId?: string | null): string {
  let live: any;
  try { live = (runtime as any)?.config?.current?.(); } catch { live = undefined; }
  const c = live ?? cfg;
  const pick = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  return pick(c?.agents?.entries?.[boundAgentId(c, accountId)]?.tools?.exec?.mode) ?? pick(c?.tools?.exec?.mode) ?? "full";
}
/** 이 채널 계정에 묶인 에이전트 id(bindings: 계정 일치 → 계정 없이 채널만 → 기본 main). 대화(peer) 단위 묶음은 보고 대상이 아니다. */
function boundAgentId(cfg: any, accountId?: string | null): string {
  const bs: any[] = Array.isArray(cfg?.bindings) ? cfg.bindings : [];
  const ours = bs.filter((b) => b?.match?.channel === CHANNEL_ID && !b?.match?.peer && b?.agentId);
  const hit = ours.find((b) => accountId && b.match.accountId === accountId) ?? ours.find((b) => !b.match.accountId);
  return String(hit?.agentId ?? "main");
}
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
// 프로세스 전체에서 하나 — OpenClaw는 도구 팩토리를 계정을 띄운 것과 다른 플러그인 모듈 사본에서 부른다(2026.9.6 격리 실측: 도구 쪽 사본의
// live가 비어 "연결 안 됨"으로 실패). 그래서 연결된 계정 목록은 모듈 변수가 아니라 globalThis의 고정 키에 둔다.
const live: Map<string, Live> = ((globalThis as any)[Symbol.for("argo-msgr.live-accounts")] ??= new Map<string, Live>());
const liveFor = (accountId?: string | null) => live.get(accountId ?? DEFAULT_ACCOUNT_ID);
function routinesStateFile(account: ResolvedAccount) { // 작업별 지문·사람이 고친 시각(Hermes와 같은 자리: ~/.argo-msgr/routines-<서버·토큰 해시>.json, 토큰은 넣지 않는다)
  const outbox = process.env.ARGO_MSGR_OUTBOX_DIR || join(homedir(), ".argo-msgr", "outbox");
  const key = createHash("sha256").update(account.url.replace(/\/+$/, "") + "\0" + account.token).digest("hex").slice(0, 24);
  return join(dirname(outbox), `routines-${key}.json`);
}
function agentApprovalsFile(account: ResolvedAccount) { // 1-b ④ 재개 정보 — Hermes와 같은 자리(~/.argo-msgr/agent-approvals-<서버·토큰 해시>.json, 0600, 토큰·본문 없음)
  return routinesStateFile(account).replace(/routines-([0-9a-f]+)\.json$/, "agent-approvals-$1.json");
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
        // 세션 키가 있으면 그 세션의 원문(재개 턴이면 부모 결재의 원문)에만 붙인다 — 같은 채팅의 다른 대화로 새지 않게(검수 3)
        return await l.bridge.request({ externalId: request.id, kind: approvalKind, chatId: preparedTarget.chatId, sessionKey: request?.request?.sessionKey ?? null,
          command: pendingPayload.command, reason: pendingPayload.reason });
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
  if (src != null) {
    replied.add(src);
    // 턴 도중 이 경로가 요청의 답글을 먼저 만들었다 — 이후 파일(대기 중인 것 포함)은 그 답글에 붙일 수 있게 기억한다
    const turn = findFileTurn({ accountId: account.accountId, chatId: to, replyToId: src });
    if (turn && turn.finalId == null) turn.finalId = Number(res?.message_id) || null;
  }
  core().channel.activity.record({ channel: CHANNEL_ID, accountId: account.accountId, direction: "outbound" });
  return { channel: CHANNEL_ID, messageId: String(res?.message_id ?? ""), target: { kind: "channel" as const, id: to } };
}

// ── 파일 보내기 (플러그인 0.3.2) ──────────────────────────────────────────────────────────────────────────
// 에이전트가 파일을 보내는 길은 둘이다. ① 최종 답 페이로드의 mediaUrl(s) — 아래 runTurn의 deliver가 모아 답을 보낸 뒤 붙인다.
// ② message 도구·예약 작업 — 코어가 outbound.sendMedia(ctx)를 부른다(ctx.mediaUrl = http(s) 주소·절대 경로·file://·작업 폴더 상대 경로 중 하나,
// 로컬 파일은 ctx.mediaAccess(localRoots·readFile·workspaceDir)로 읽는다). 두 길 모두 코어의 runtime.media.loadWebMedia로 바이트를 읽는다.
type MediaAccess = { mediaAccess?: { localRoots?: readonly string[]; readFile?: (p: string) => Promise<Buffer>; workspaceDir?: string }; mediaLocalRoots?: readonly string[] | "any"; mediaReadFile?: (p: string) => Promise<Buffer> };
function mediaFileName(url: string): string {
  const bare = String(url).replace(/^file:\/\//i, "").split(/[?#]/)[0];
  try { return decodeURIComponent(bare.split(/[\\/]/).filter(Boolean).pop() ?? "") || "file"; } catch { return bare.split(/[\\/]/).filter(Boolean).pop() || "file"; }
}
/** 파일 하나를 바이트로 읽는 지연 함수. 25MB를 넘으면 413으로 돌려 방에 안내가 나가게 한다(넘는 파일은 끝까지 읽지 않는다). */
function fileFromUrl(url: string, access: MediaAccess & { workspaceDir?: string } = {}) {
  return { name: mediaFileName(url), load: async () => {
    const roots = access.mediaAccess?.localRoots ?? access.mediaLocalRoots;
    const readFile = access.mediaAccess?.readFile ?? access.mediaReadFile;
    const workspaceDir = access.mediaAccess?.workspaceDir ?? access.workspaceDir;
    try {
      const m: any = await (core() as any).media.loadWebMedia(url, {
        maxBytes: MAX_FILE_BYTES + 1, optimizeImages: false,
        ...(roots && (roots === "any" || roots.length) ? { localRoots: roots } : {}),
        ...(readFile ? { readFile, hostReadCapability: true } : {}),
        ...(workspaceDir ? { workspaceDir } : {}),
      });
      return { data: m.buffer as Buffer, mime: m.contentType as string | undefined, name: m.fileName as string | undefined };
    } catch (e) {
      if (/exceeds .*limit|exceeds maxBytes|too large/i.test(String((e as any)?.message ?? e))) throw new ArgoMsgrError(413, "files are limited to 25 MB");
      throw e;
    }
  } };
}
/** 에이전트가 파일을 만든 작업 폴더까지 읽을 수 있게 그 에이전트의 미디어 루트를 붙인다. 이 SDK 경로가 없는 옛 호스트는 코어 기본 루트로 읽는다. */
async function agentMediaRoots(cfg: any, agentId: string | undefined, sources: string[]): Promise<readonly string[] | undefined> {
  try {
    const mod: any = await import("openclaw/plugin-sdk/media-local-roots");
    return mod.getAgentScopedMediaLocalRootsForSources({ cfg, agentId, mediaSources: sources });
  } catch { return undefined; }
}
async function sendMediaFile(account: ResolvedAccount, target: string, text: string, mediaUrl: string, access: MediaAccess, replyTo?: number) {
  const chatId = bareChatId(target);
  const api = makeApi({ url: account.url, token: account.token });
  const turn = findFileTurn({ accountId: account.accountId, chatId, replyToId: replyTo ?? null });
  if (turn && turn.finalId == null) { // 이 요청이 아직 답하지 않았다 — 최종 답이 게시된 뒤 그 답글에 붙도록 대기시킨다(handleInbound가 처리)
    const d = await deferTurnFile({ api, chatId, turn, text, file: fileFromUrl(mediaUrl, access), log: (s) => console.warn(s) });
    return { channel: CHANNEL_ID, messageId: String(d.noticeId ?? ""), target: { kind: "channel" as const, id: chatId } };
  }
  const res = await deliverFiles({ api, accountId: account.accountId, chatId, turn, text, files: [fileFromUrl(mediaUrl, access)], log: (s) => console.warn(s) });
  if (turn?.finalId != null && turn.sourceId != null) replied.add(Number(turn.sourceId)); // 파일이 이 요청을 마감했다 — 뒤이은 sendText가 또 답글을 달지 않게
  core().channel.activity.record({ channel: CHANNEL_ID, accountId: account.accountId, direction: "outbound" });
  return { channel: CHANNEL_ID, messageId: String(res.messageId ?? ""), target: { kind: "channel" as const, id: chatId } };
}

type TurnInput = { account: ResolvedAccount; cfg: any; log: (s: string) => void; route: any; isGroup: boolean; chatId: string; chatName: string;
  senderId: string; senderName: string; messageId: string; timestamp: number; prompt: string; rawBody: string; media?: any[] };
/** OpenClaw 에이전트 턴 하나(받기 → 세션 → 최종 답 모으기). 일반 수신과 결재 결정 뒤 재개 턴이 같이 쓴다. */
async function runTurn(t: TurnInput): Promise<{ chunks: string[]; media: string[] }> {
  const c = core();
  const { cfg, route, isGroup, chatId, chatName, senderId, senderName, log, account } = t;
  // 모델이 읽는 본문은 BodyForAgent다 — 스레드 맥락·넘김 규칙(relayPrompt)을 여기에 싣는다. Body는 사람이 읽는 봉투(기록·표시용).
  const from = isGroup ? `#${chatName} · ${senderName}` : senderName;
  const envelope = createChannelInboundEnvelopeBuilder({ cfg, route })({ channel: "Argo Messenger", from, timestamp: t.timestamp, body: t.prompt });
  const peerAddress = isGroup ? `${CHANNEL_ID}:channel:${chatId}` : `${CHANNEL_ID}:${senderId}`;
  const ctxPayload = c.channel.inbound.buildContext({
    channel: CHANNEL_ID, accountId: route.accountId ?? account.accountId, messageId: t.messageId, timestamp: t.timestamp,
    from: peerAddress,
    sender: { id: senderId, name: senderName || undefined },
    conversation: { kind: isGroup ? "group" : "direct", id: chatId, label: isGroup ? `#${chatName}` : senderName },
    route: { agentId: route.agentId, dmScope: route.dmScope, accountId: route.accountId, routeSessionKey: route.sessionKey, dispatchSessionKey: route.sessionKey },
    reply: { to: `${CHANNEL_ID}:${chatId}`, originatingTo: `${CHANNEL_ID}:${chatId}` },
    message: { body: envelope, bodyForAgent: t.prompt, rawBody: t.rawBody, commandBody: t.rawBody },
    // 사람이 올린 첨부 — 내려받은 파일을 순서 있는 미디어 사실(media[])로 넘긴다(코어가 MediaPath 등 옛 필드로 투영한다). 경로는 프롬프트에도 적혀 있다.
    ...(t.media?.length ? { media: t.media } : {}),
    // 서버가 멘션·DM·답글만 보낸다. 제어 명령(/…)은 아르고 채널에서 받지 않는다.
    access: { mentions: { canDetectMention: true, wasMentioned: true }, commands: { authorized: false } },
    extra: { GroupSubject: isGroup ? chatName : undefined },
  });
  const chunks: string[] = [];
  const media: string[] = []; // 에이전트가 답에 붙인 파일(mediaUrl) — 답을 보낸 뒤 첨부로 올린다
  // 답은 모아서 한 번에 보낸다(원글당 답글 하나 + 넘김 표지). 운영자가 visibleReplies=message_tool로 바꿔도 이 채널은 자동 전달로 고정한다.
  await c.channel.inbound.dispatch({
    cfg, channel: CHANNEL_ID, accountId: account.accountId,
    route: { agentId: route.agentId, dmScope: route.dmScope, sessionKey: route.sessionKey },
    ctxPayload,
    record: { onRecordError: (err: unknown) => log(`argo-msgr: session meta failed: ${String(err)}`) },
    delivery: {
      deliver: async (payload: any, info: { kind: string }) => {
        if (info.kind !== "final" || payload.isReasoning) return;
        const text = String(payload.text ?? "").trim();
        if (text) chunks.push(text);
        media.push(...resolveOutboundMediaUrls(payload));
      },
      onError: (err: unknown, info: { kind: string }) => log(`argo-msgr ${info?.kind} reply failed: ${String(err)}`),
    },
    replyOptions: { disableBlockStreaming: true, sourceReplyDeliveryMode: "automatic" },
    replyPipeline: {},
  });
  return { chunks, media };
}

function routeFor(cfg: any, account: ResolvedAccount, isGroup: boolean, chatId: string) {
  return { ...core().channel.routing.resolveAgentRoute({ cfg, channel: CHANNEL_ID, accountId: account.accountId, peer: { kind: isGroup ? "group" : "direct", id: chatId } }) } as any;
}

async function handleInbound(params: { m: any; account: ResolvedAccount; cfg: any; log: (s: string) => void; statusSink?: (p: any) => void }) {
  const { m, account, cfg, log } = params;
  const c = core();
  let rawBody = String(m?.text ?? "").trim();
  const chatId = String(m?.chat?.id ?? "");
  const hasAttachments = Array.isArray(m?.attachments) && m.attachments.length > 0;
  if ((!rawBody && !hasAttachments) || !chatId) return; // 글 없이 파일만 온 메시지도 받는다
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

  const api = makeApi({ url: account.url, token: account.token });
  // 사람이 올린 첨부 내려받기(getFile → 25MB 상한 스트리밍 → ~/.argo-msgr/files/<메시지 id>/). 실패해도 본문은 그대로 전달하고 프롬프트에 알린다.
  const attached = hasAttachments ? await downloadAttachments(api, m, { log }) : { files: [], failed: [] };
  if (!rawBody) rawBody = [...attached.files, ...attached.failed].map((f) => f.name).join(", ") || "(attachment)";
  const mediaFacts = attached.files.map((f) => ({ path: f.path, contentType: f.mime ?? undefined, fileName: f.name, sizeBytes: f.size, messageId: String(messageId) }));

  const route = routeFor(cfg, account, isGroup, chatId);
  // A server-authorized DM thread must not resume a provider's shared direct-message session.
  if (!isGroup) route.sessionKey = `${route.sessionKey}:argo-dm:${encodeURIComponent(chatId)}:${m.delegated ? m.thread_root || messageId : 'conversation'}`;
  const bridge = liveFor(account.accountId)?.bridge;
  // 재개 턴(결재 결정 뒤)이 이 세션에서 돌고 있으면 끝난 뒤에 넣는다 — 두 턴의 답이 섞여 이 글의 답이 결재 후속 보고로 새지 않게(검수 H1)
  await bridge?.afterResume(route.sessionKey);
  bridge?.track(m, route.sessionKey); // 이 턴 안에서 오는 승인 요청·결재 도구는 이 원문의 실행 시도로 카드를 만든다
  const endTurn = bridge?.beginTurn(route.sessionKey); // 재개 턴은 이 턴이 끝날 때까지 기다린다
  const turn = openFileTurn({ accountId: account.accountId, chatId, message: m }); // 이 요청 처리 중에 에이전트가 보내는 파일이 붙을 자리
  try {
    const { chunks, media } = await runTurn({ account, cfg, log, route, isGroup, chatId, chatName, senderId, senderName, messageId: String(messageId), timestamp,
      prompt: relayPrompt(m, attached), rawBody, media: mediaFacts });
    // 파일: 턴 도중 sendMedia로 대기시킨 것(turn.pending) + 최종 답에 붙은 mediaUrl. 최종 답이 게시된 뒤 그 답글에 붙인다.
    const files = [...turn.pending, ...(media.length ? await agentMediaRoots(cfg, route.agentId, media).then((roots) => media.map((url) => fileFromUrl(url, { mediaLocalRoots: roots }))) : [])];
    const text = chunks.join("\n\n");
    // 최종 답이 있으면 그 글(넘김·멘션 그대로). 글 없이 파일만이면 그때 도구 설명(caption) 또는 파일 이름으로 마감한다.
    const closing = text || turn.captions.join("\n") || files.map((f) => f.name).join(", ");
    if (closing) {
      const answer = relayReply(closing, m);
      if (answer.text.length > MAX_LEN) throw new Error("Argo Messenger reply exceeds the channel message limit");
      const sent: any = await api.sendMessage(chatId, answer.text, messageId, answer.execution);
      turn.finalId = Number(sent?.message_id) || turn.finalId;
      turn.pending.splice(0); // 마감 전송이 성공했다 — 대기 파일은 아래 deliverFiles가 맡는다(위 files에 담겨 있다)
      params.statusSink?.({ lastOutboundAt: Date.now() });
    }
    if (files.length) await deliverFiles({ api, accountId: account.accountId, chatId, turn, files, log });
  } finally {
    await settlePendingFiles({ api, accountId: account.accountId, chatId, turn, log }); // 마감 전에 예외로 끝났으면 대기 파일을 알리거나(답글이 있으면) 붙인다
    turn.end();
    bridge?.done(m);
    endTurn?.();
  }
}

/** 1-b ④: 에이전트 결재가 결정되면 같은 대화(저장한 세션 키)로 합성 메시지를 넣어 턴을 돌리고, 그 턴의 최종 답을 돌려준다(후속 보고로 올라간다). */
async function resumeAgentTurn(params: { account: ResolvedAccount; cfg: any; log: (s: string) => void; approvalId: string; info: any; text: string }): Promise<string | null> {
  const { account, cfg, log, approvalId, info, text } = params;
  const src = info?.source ?? {}, chat = src.chat ?? {}, from = src.from ?? {};
  const chatId = String(chat.id ?? "");
  if (!chatId) return null;
  const isGroup = chat.kind !== "dm";
  const route = routeFor(cfg, account, isGroup, chatId);
  if (info?.sessionKey) route.sessionKey = String(info.sessionKey); // 결재를 요청한 바로 그 세션(DM 스레드 세션 포함)
  const { chunks, media } = await runTurn({ account, cfg, log, route, isGroup, chatId, chatName: String(chat.name ?? chatId), senderId: String(from.id ?? ""),
    senderName: String(from.name ?? ""), messageId: `apf:${approvalId}`, timestamp: Date.now(), prompt: text, rawBody: text });
  // 후속 보고는 넘김이 없다(서버가 done으로 저장) — 모델이 습관처럼 붙인 MSGR 표지는 떼고 보낸다
  const answer = chunks.length ? parseMessengerDisposition(chunks.join("\n\n")).text : null;
  if (!media.length) return answer;
  // 재개 턴의 파일 — 후속 보고 글에 붙인다. 후속 보고는 결재 다리(ApprovalBridge.followup)가 올리므로, 파일은 그 글 id를 받아 붙이는 함수(attach)로 넘긴다.
  // 다리가 후속 보고를 올린 뒤(글이 없으면 파일 이름으로 올린 뒤) attach(글 id)를 부른다.
  const roots = await agentMediaRoots(cfg, route.agentId, media);
  const files = media.map((url) => fileFromUrl(url, { mediaLocalRoots: roots }));
  return { text: answer, names: files.map((f) => f.name),
    attach: (messageId: number) => deliverFiles({ api: makeApi({ url: account.url, token: account.token }), accountId: account.accountId, chatId, log, files,
      turn: { finalId: messageId, files: 0, sourceId: null, message: {}, pending: [], captions: [] } }) }; // 등록하지 않는 임시 요청 — 이미 정해진 후속 보고 글에 붙이기만 한다
}

/** 1-b ④: 결재 도구. 이 채널(argo-msgr) 대화에서만 보이고, 다른 채널에서는 null로 숨긴다. index.ts registerFull이 등록한다.
 *  처리 중인 메신저 원문(또는 재개 중인 부모 결재)이 없는 실행 — 예약 작업 실행 등 — 에서도 만들지 않는다(검수 H2). */
export function argoApprovalToolFactory(ctx: any) {
  if (String(ctx?.messageChannel ?? "").toLowerCase() !== CHANNEL_ID) return null;
  const owner = liveFor(ctx?.deliveryContext?.accountId ?? ctx?.agentAccountId ?? DEFAULT_ACCOUNT_ID);
  if (!owner || !owner.bridge.hasCurrentSource(ctx?.sessionKey)) return null;
  return {
    name: APPROVAL_TOOL, label: "Argo Messenger approval", description: APPROVAL_TOOL_DESCRIPTION, parameters: APPROVAL_TOOL_PARAMETERS,
    // OpenClaw 기본 Tool Search는 플러그인 도구를 검색 목록 뒤로 숨긴다(모델에는 tool_search·tool_call만 보인다, 2026.9.6 격리 실측).
    // 결재는 "하기 전에" 불러야 하는 도구라 모델이 바로 보게 둔다(Hermes처럼). 이 채널 대화에서만 만들어지므로 다른 대화의 프롬프트는 늘지 않는다.
    catalogMode: "direct-only" as const,
    execute: async (_toolCallId: string, params: any) => {
      const accountId = ctx?.deliveryContext?.accountId ?? ctx?.agentAccountId ?? DEFAULT_ACCOUNT_ID;
      const l = liveFor(accountId);
      if (!l) throw new Error("argo_request_approval works only while this Argo Messenger account is connected");
      // 원문은 세션 키 + 요청자(requesterSenderId)로 정확히 정한다 — "그 채팅의 최근 원문" 대체는 없다(검수 H2)
      const out = await l.bridge.requestAgent({ sessionKey: ctx?.sessionKey ?? null, requesterSenderId: ctx?.requesterSenderId ?? null, title: params?.title, reason: params?.reason });
      const result = { ok: true, ...out, next: APPROVAL_TOOL_NEXT };
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: result };
    },
  };
}

async function handleEvent(ev: any, l: Live) {
  if (ev?.event === "routine_edit") await l.mirror.applyEdit(ev);
  else if (ev?.event === "approval_decided") await l.bridge.onDecided(ev);
  else if (ev?.event === "config") await l.mirror.applyMirrorAll(ev.mirror_all === true); // 1-b ②: 소유자가 메신저에서 바꾼 "모든 예약 작업 보기"
}

export const argoMsgrPlugin: ChannelPlugin<ResolvedAccount> = {
  id: CHANNEL_ID,
  meta: { id: CHANNEL_ID, label: "Argo Messenger", selectionLabel: "Argo Messenger (bot API)", docsPath: "/channels/argo-msgr",
    blurb: "Company team messenger with AI agents; OpenClaw joins as an external agent bot.", aliases: ["argo"] },
  capabilities: { chatTypes: ["direct", "group"], media: true, blockStreaming: false },
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
    sendMedia: async (ctx) => {
      const { cfg, to, text, mediaUrl, accountId, replyToId } = ctx as any;
      const account = resolveAccount(cfg, accountId ?? undefined), replyTo = replyToId ? Number(replyToId) : undefined;
      if (!mediaUrl) return sendText(account, to, text, replyTo);
      return sendMediaFile(account, to, String(text ?? ""), String(mediaUrl), ctx as MediaAccess, replyTo);
    },
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
      const bridge = new ApprovalBridge({ api, log, agentStateFile: agentApprovalsFile(account),
        resolve: ({ externalId, kind, decision }: any) => resolveApprovalOverGateway({ cfg: ctx.cfg, approvalId: externalId, decision, approvalKind: kind }),
        resume: ({ approvalId, info, text }: any) => resumeAgentTurn({ account, cfg: ctx.cfg, log, approvalId, info, text }) });
      const mirror = new RoutineMirror({ api, cronAccess, accountId: account.accountId, log, stateFile: routinesStateFile(account),
        ownsUnscoped: () => listAccountIds(ctx.cfg).length <= 1 || account.accountId === DEFAULT_ACCOUNT_ID,
        version: () => pluginVersion || "unknown", approvalMode: () => execApprovalMode(ctx.cfg, account.accountId) });
      const l: Live = { accountId: account.accountId, bridge, mirror, log };
      live.set(account.accountId, l);
      // 코어가 이 계정의 네이티브 승인 핸들러를 띄우게 한다(요청 구독·만료·중복 제거는 코어 몫, 카드 전송·만료 알림은 위 nativeRuntime)
      const approvalsLease = registerChannelRuntimeContext({ channelRuntime: (ctx as any).channelRuntime, channelId: CHANNEL_ID, accountId: account.accountId,
        capability: CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY, context: { accountId: account.accountId }, abortSignal: abort.signal });
      const stopMirror = new AbortController();
      // 1-b ①: 버전·승인 모드는 연결 직후 한 번, 그 뒤엔 같은 60초 주기에 바뀌었을 때만 보고한다(유휴 호출 0). 표시용 — 실패해도 수신·미러는 계속
      const report = async () => { try { await mirror.reportStatus(); } catch (e) { log(`argo-msgr: reportStatus failed — ${String((e as any)?.message ?? e)}`); } };
      const mirrorLoop = (async () => { // 60초마다 읽고, 바뀌었을 때만 setRoutines(1시간마다 재확인)
        await report();
        await wait(3_000, stopMirror.signal);
        while (!stopMirror.signal.aborted) {
          await report();
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
