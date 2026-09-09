// 아르고 메신저 채널 플러그인 — 오픈클로가 아르고 메신저에 **봇**으로 접속한다(텔레그램·슬랙과 같은 자리).
// 설정: channels["argo-msgr"].accounts.<id> { url, token, enabled }  (기본 계정은 env ARGO_MSGR_URL / ARGO_MSGR_BOT_TOKEN로도 가능 —
// 메신저 설정 → 외부 에이전트 카드가 보여주는 두 줄 그대로). 누가 봇에게 일을 시킬 수 있는지·어느 채널을 읽는지·채널 정책은 전부
// 아르고 서버가 판정한다(getUpdates는 멘션·DM·답글만, sendMessage는 답글마다 재판정) — 그래서 여기엔 허용 목록·페어링이 없다(dmPolicy open).
import {
  buildBaseAccountStatusSnapshot, buildBaseChannelStatusSummary, createReplyPrefixOptions,
  DEFAULT_ACCOUNT_ID, deleteAccountFromConfigSection, formatTextWithAttachmentLinks, resolveOutboundMediaUrls,
  setAccountEnabledInConfigSection, type ChannelPlugin, type PluginRuntime,
} from "openclaw/plugin-sdk";
import { makeApi, MAX_LEN, pollLoop, relayPrompt, relayReply } from "./api.js";

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

// 원글당 답글은 하나(서버가 reply:<crew>:<src>로 묶는다) — 첫 덩어리만 답글, 나머지는 평문
const replied = new Set<number>();
async function sendText(account: ResolvedAccount, to: string, text: string, replyTo?: number) {
  const api = makeApi({ url: account.url, token: account.token });
  const src = replyTo != null && !replied.has(replyTo) ? replyTo : undefined;
  const res = await api.sendMessage(to, text, src);
  if (src != null) replied.add(src);
  core().channel.activity.record({ channel: CHANNEL_ID, accountId: account.accountId, direction: "outbound" });
  return { channel: CHANNEL_ID, messageId: String(res?.message_id ?? ""), target: to };
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

  const route = c.channel.routing.resolveAgentRoute({ cfg, channel: CHANNEL_ID, accountId: account.accountId, peer: { kind: isGroup ? "group" : "direct", id: chatId } });
  const storePath = c.channel.session.resolveStorePath(cfg.session?.store, { agentId: route.agentId });
  const previousTimestamp = c.channel.session.readSessionUpdatedAt({ storePath, sessionKey: route.sessionKey });
  const body = c.channel.reply.formatAgentEnvelope({
    channel: "Argo Messenger", from: isGroup ? `#${chatName} · ${senderName}` : senderName, timestamp, previousTimestamp,
    envelope: c.channel.reply.resolveEnvelopeFormatOptions(cfg), body: relayPrompt(m),
  });
  const ctxPayload = c.channel.reply.finalizeInboundContext({
    Body: body, RawBody: rawBody, CommandBody: rawBody,
    From: isGroup ? `${CHANNEL_ID}:channel:${chatId}` : `${CHANNEL_ID}:${senderId}`, To: `${CHANNEL_ID}:${chatId}`,
    SessionKey: route.sessionKey, AccountId: route.accountId, ChatType: isGroup ? "group" : "direct",
    ConversationLabel: isGroup ? `#${chatName}` : senderName, SenderName: senderName || undefined, SenderId: senderId,
    GroupSubject: isGroup ? chatName : undefined, Provider: CHANNEL_ID, Surface: CHANNEL_ID,
    WasMentioned: isGroup ? true : undefined,           // 서버가 멘션·DM·답글만 보낸다
    MessageSid: String(messageId), Timestamp: timestamp, OriginatingChannel: CHANNEL_ID, OriginatingTo: `${CHANNEL_ID}:${chatId}`,
    CommandAuthorized: false,                            // 제어 명령(/…)은 아르고 채널에서 받지 않는다
  });
  await c.channel.session.recordInboundSession({ storePath, sessionKey: ctxPayload.SessionKey ?? route.sessionKey, ctx: ctxPayload,
    onRecordError: (err: unknown) => log(`argo-msgr: session meta failed: ${String(err)}`) });
  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({ cfg, agentId: route.agentId, channel: CHANNEL_ID, accountId: account.accountId });
  const chunks: string[] = [];
  const deliver = async (payload: any, info: { kind: string }) => {
    if (info.kind !== "final" || payload.isReasoning) return;
    const text = formatTextWithAttachmentLinks(payload.text, resolveOutboundMediaUrls(payload));
    if (!text) return;
    chunks.push(text);
  };
  await c.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload, cfg, dispatcherOptions: { ...prefixOptions, deliver, onError: (err: unknown, info: any) => log(`argo-msgr ${info?.kind} reply failed: ${String(err)}`) },
    replyOptions: { onModelSelected, disableBlockStreaming: true },
  });
  if (chunks.length) {
    const answer = relayReply(chunks.join("\n\n"), m);
    if (answer.text.length > MAX_LEN) throw new Error("Argo Messenger reply exceeds the channel message limit");
    await makeApi({ url: account.url, token: account.token }).sendMessage(chatId, answer.text, messageId, answer.execution);
    params.statusSink?.({ lastOutboundAt: Date.now() });
  }
}

export const argoMsgrPlugin: ChannelPlugin<ResolvedAccount> = {
  id: CHANNEL_ID,
  meta: { id: CHANNEL_ID, label: "Argo Messenger", selectionLabel: "Argo Messenger (bot API)", docsPath: "/channels/argo-msgr",
    blurb: "Company team messenger with AI crews; OpenClaw joins as an external agent bot.", aliases: ["argo"] },
  capabilities: { chatTypes: ["direct", "group"], media: false, blockStreaming: false },
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
  messaging: { normalizeTarget: (raw) => raw.trim(), targetResolver: { looksLikeId: (raw) => /^[0-9a-f-]{36}$/i.test(raw.trim()), hint: "<channel id>" } },
  outbound: {
    deliveryMode: "direct", chunkerMode: "markdown", textChunkLimit: MAX_LEN,
    chunker: (text, limit) => core().channel.text.chunkMarkdownText(text, limit),
    sendText: async ({ to, text, accountId, replyToId }) => sendText(resolveAccount(core().config.loadConfig(), accountId ?? undefined), to, text, replyToId ? Number(replyToId) : undefined),
    sendMedia: async ({ to, text, mediaUrl, accountId, replyToId }) => sendText(resolveAccount(core().config.loadConfig(), accountId ?? undefined), to, mediaUrl ? `${text}\n\n${mediaUrl}` : text, replyToId ? Number(replyToId) : undefined),
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
      // 이 프로미스가 끝나면 게이트웨이는 계정이 종료된 것으로 보고 자동 재시작한다(실측 2026-09-08: 접속 직후 재시작 반복) — 중지 신호까지 폴링 루프를 기다린다.
      try {
        await pollLoop(api, { signal: abort.signal, log, onMessage: (m) => handleInbound({ m, account, cfg: ctx.cfg, log, statusSink: (patch) => ctx.setStatus({ accountId: ctx.accountId, ...patch }) }) });
      } finally {
        ctx.abortSignal?.removeEventListener("abort", onAbort);
      }
      if (!abort.signal.aborted) throw new Error("Argo Messenger: bot token rejected — rotate the token in Argo Messenger settings and update the config");
    },
  },
};
