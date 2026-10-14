// 구글 정식 REST 백엔드 — Gmail·구글 캘린더 커넥터를 원격 MCP(gmailmcp·calendarmcp) 대신 공개 REST API로 실행한다
// (2026-10-14 유건 A안 승인). 원격 MCP는 initialize·tools/list는 받아 주지만 tools/call은 Developer Preview에 등록된
// 프로젝트만 받는다 — 같은 토큰으로 gmail.googleapis.com REST는 200이다(총괄 실측).
//
// 계약(connectors.mjs callConnectorTool·listConnectorTools가 rec.url 호스트로 이 모듈을 고른다):
//  - 연결(OAuth·PKCE·loopback·토큰 저장)은 startConnect 그대로다. 이 모듈은 저장된 토큰으로 REST만 부른다.
//  - 도구 이름은 원격 MCP와 같다 — 카탈로그 dangerous·readOnlyAllow와 결재 판정이 그대로 맞물린다.
//  - **메일 보내기는 없다.** */send 엔드포인트를 부르는 코드가 없고 시험이 잠근다. gmail.modify 범위는 API 발송도 허용하므로
//    보내지 않는 것은 이 모듈이 지키는 약속이다.
//  - 401이면 refresh_token으로 한 번 갱신해 저장하고 재시도한다. invalid_grant(동의 철회·만료)는 { reauth:true }로 돌려
//    호출부가 '재연결 필요'로 강등한다. 같은 연결의 동시 갱신은 하나로 합친다.
//  - 토큰·client secret은 오류 문구·결과에 싣지 않는다(scrubSecrets). 구글 오류는 사람이 읽을 문장으로 바꾼다.
//  - 주기 호출은 없다 — 도구 호출 때만 부른다.
import { randomUUID } from 'node:crypto';

const DEFAULT_ENDPOINTS = Object.freeze({
  gmail: 'https://gmail.googleapis.com/gmail/v1/users/me',
  calendar: 'https://www.googleapis.com/calendar/v3',
  token: 'https://oauth2.googleapis.com/token',
});
let EP = { ...DEFAULT_ENDPOINTS };
/** 시험 전용 — 가짜 구글 서버로 바꾼다. 인자 없이 부르면 원래 주소로 되돌린다. */
export function _setGoogleEndpoints(o = null) { EP = { ...DEFAULT_ENDPOINTS, ...(o ?? {}) }; }

// 원격 MCP 주소(카탈로그 url) → REST 백엔드 종류. 카탈로그 url을 바꾸지 않고(연결 흐름·PRM 디스커버리는 이 주소로 돈다) 실행만 갈아 끼운다.
const REST_HOSTS = Object.freeze({ 'gmailmcp.googleapis.com': 'gmail', 'calendarmcp.googleapis.com': 'calendar' });
export function googleRestKind(url) {
  try { return REST_HOSTS[new URL(url).hostname] ?? null; } catch { return null; }
}

const TIMEOUT_MS = 30_000;
const BODY_CAP = 20_000;     // 메시지 하나의 본문 글자 수 상한 — 크루 컨텍스트 보호
const THREAD_CAP = 60_000;   // 스레드 전체 본문 상한
const FANOUT = 5;            // 목록 → 개별 메타데이터 조회의 동시 요청 수

/** 오류 문구·결과에 토큰·secret이 섞이지 않게 가린다(구글 오류 메시지가 요청 일부를 되울릴 수 있다). */
export function scrubSecrets(s) {
  return String(s ?? '')
    .replace(/ya29\.[\w.\-]+/g, '[token]')
    .replace(/1\/\/[\w.\-]+/g, '[token]')
    .replace(/GOCSPX-[\w\-]+/g, '[secret]')
    .replace(/Bearer\s+[\w.\-~+/]+=*/gi, 'Bearer [token]');
}

const MSG = {
  scope: { ko: () => '구글이 이 작업 권한을 주지 않았습니다(범위 부족). 설정에서 연결을 해제한 뒤 다시 연결해 권한을 모두 허용해 주세요', en: () => 'Google did not grant permission for this action (insufficient scope). Disconnect and reconnect in Settings, allowing all permissions' },
  quota: { ko: () => '구글 사용 한도에 걸렸습니다(요청이 너무 많습니다). 잠시 뒤 다시 시도해 주세요', en: () => 'Hit a Google usage limit (too many requests). Try again shortly' },
  disabled: { ko: () => '이 앱의 구글 API가 꺼져 있어 요청이 거절됐습니다. 사용자 쪽 문제가 아니니 Argo 운영자에게 알려 주세요', en: () => "This app's Google API is turned off, so the request was refused. It's not on your side — please tell the Argo team" },
  forbidden: { ko: (d) => `구글이 이 요청을 거절했습니다(권한 없음)${d ? `: ${d}` : ''}`, en: (d) => `Google refused this request (forbidden)${d ? `: ${d}` : ''}` },
  notFound: { ko: (d) => `구글에서 대상을 찾지 못했습니다(이미 지워졌거나 ID가 틀렸습니다)${d ? `: ${d}` : ''}`, en: (d) => `Google could not find the item (already deleted or wrong ID)${d ? `: ${d}` : ''}` },
  badRequest: { ko: (d) => `구글이 요청 내용을 받아들이지 않았습니다${d ? `: ${d}` : ''}`, en: (d) => `Google rejected the request${d ? `: ${d}` : ''}` },
  server: { ko: (n) => `구글 서비스가 일시적으로 응답하지 않습니다(HTTP ${n}). 잠시 뒤 다시 시도해 주세요`, en: (n) => `Google is temporarily not responding (HTTP ${n}). Try again shortly` },
  network: { ko: () => '구글에 연결하지 못했습니다(네트워크 오류 또는 시간 초과). 잠시 뒤 다시 시도해 주세요', en: () => 'Could not reach Google (network error or timeout). Try again shortly' },
  authConfig: { ko: () => '구글 로그인 설정 문제로 접근 권한을 갱신하지 못했습니다. 사용자 쪽 문제가 아니니 Argo 운영자에게 알려 주세요', en: () => "Could not renew access because of a Google sign-in configuration problem. It's not on your side — please tell the Argo team" },
  unknownTool: { ko: (t) => `이 커넥터에는 '${t}' 도구가 없습니다(메일 보내기는 지원하지 않습니다 — 초안을 만들 수 있습니다)`, en: (t) => `This connector has no '${t}' tool (sending mail is not supported — you can create a draft)` },
  badArgs: { ko: (d) => `도구 인자가 올바르지 않습니다: ${d}`, en: (d) => `Invalid tool arguments: ${d}` },
  notAttendee: { ko: () => '이 일정의 참석자가 아니라서 참석 응답을 보낼 수 없습니다', en: () => "You're not an attendee of this event, so you can't respond to it" },
};
const LABEL = { gmail: 'Gmail', calendar: 'Google Calendar' };

class GErr extends Error {
  constructor(kind, detail = '') { super(kind); this.kind = kind; this.detail = detail; }
}
const badArgs = (d) => new GErr('badArgs', d);
const reauthErr = () => new GErr('reauth');

function classify(status, j) {
  const e = j?.error && typeof j.error === 'object' ? j.error : {};
  const reasons = [
    ...(Array.isArray(e.errors) ? e.errors.map((x) => x?.reason) : []),
    ...(Array.isArray(e.details) ? e.details.map((x) => x?.reason) : []),
    e.status,
  ].filter(Boolean).map(String);
  const has = (...r) => reasons.some((x) => r.includes(x));
  const detail = scrubSecrets(e.message ?? '').slice(0, 200);
  if (status === 429 || has('rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded', 'dailyLimitExceeded', 'RATE_LIMIT_EXCEEDED', 'RESOURCE_EXHAUSTED')) return new GErr('quota');
  if (status === 403) {
    if (has('insufficientPermissions', 'ACCESS_TOKEN_SCOPE_INSUFFICIENT') || /insufficient authentication scopes/i.test(e.message ?? '')) return new GErr('scope');
    if (has('accessNotConfigured', 'SERVICE_DISABLED')) return new GErr('disabled');
    return new GErr('forbidden', detail);
  }
  if (status === 404 || status === 410) return new GErr('notFound', detail);
  if (status >= 500) return new GErr('server', String(status));
  return new GErr('badRequest', detail || `HTTP ${status}`);
}

async function readJsonSafe(res) {
  const text = await res.text().catch(() => '');
  if (!text) return {};
  try { return JSON.parse(text); } catch { return {}; }
}

/* ─── 토큰 갱신 — 같은 연결(key)의 동시 갱신은 하나의 약속으로 합친다 ─── */
const refreshing = new Map();
function refreshAccess(key, { tokens, client, saveTokens }) {
  let p = refreshing.get(key);
  if (p) return p;
  p = (async () => {
    const rt = tokens?.refresh_token;
    if (!rt || !client?.client_id) throw reauthErr();
    const form = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: rt, client_id: client.client_id });
    if (client.client_secret) form.set('client_secret', client.client_secret);
    let res;
    try {
      res = await fetch(EP.token, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch { throw new GErr('network'); }
    const j = await readJsonSafe(res);
    if (!res.ok || !j.access_token) {
      if (j.error === 'invalid_grant') throw reauthErr();                                  // 동의 철회·refresh 만료 — 다시 연결해야 한다
      if (j.error === 'invalid_client' || j.error === 'unauthorized_client') throw new GErr('authConfig'); // secret 문제 — 다시 연결해도 같다
      if (res.status >= 500) throw new GErr('server', String(res.status));
      throw new GErr('authConfig');
    }
    // 구글은 갱신 응답에 refresh_token을 보통 다시 주지 않는다 — 기존 값을 지켜야 다음 갱신이 된다.
    const next = { ...tokens, ...j, refresh_token: j.refresh_token ?? rt };
    await saveTokens(next);
    return next.access_token;
  })().finally(() => { if (refreshing.get(key) === p) refreshing.delete(key); });
  refreshing.set(key, p);
  return p;
}

/** 호출 하나의 HTTP 세션 — 401이면 한 번만 갱신·재시도한다. */
function makeSession(key, { tokens, client, saveTokens }) {
  let access = tokens?.access_token ?? null;
  let refreshed = false;
  const once = async (method, url, body) => {
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: { authorization: `Bearer ${access}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch { throw new GErr('network'); }
    return res;
  };
  return async function api(method, url, body) {
    if (!access) { access = await refreshAccess(key, { tokens, client, saveTokens }); refreshed = true; }
    let res = await once(method, url, body);
    if (res.status === 401 && !refreshed) {
      await res.body?.cancel().catch(() => {});
      access = await refreshAccess(key, { tokens, client, saveTokens });
      refreshed = true;
      res = await once(method, url, body);
    }
    if (res.status === 401) { await res.body?.cancel().catch(() => {}); throw reauthErr(); }
    if (res.status === 204) return {};
    const j = await readJsonSafe(res);
    if (!res.ok) throw classify(res.status, j);
    return j;
  };
}

/* ─── 공통 도우미 ─── */
/** 경로 조각 — '.'·'..'·슬래시가 섞이면 다른 자원으로 새어 나갈 수 있어 거절한다. */
function seg(v, name) {
  const s = String(v ?? '').trim();
  if (!s) throw badArgs(`${name} is required`);
  if (s === '.' || s === '..' || /[\/\\]/.test(s) || /[\u0000-\u001f]/.test(s)) throw badArgs(`${name} is not valid`);
  return encodeURIComponent(s);
}
function qs(params) {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) for (const x of v) u.append(k, String(x));
    else u.set(k, String(v));
  }
  const s = u.toString();
  return s ? `?${s}` : '';
}
const clampSize = (n, def, max) => { const x = Number.isInteger(n) ? n : def; return Math.max(1, Math.min(max, x)); };
const strArray = (v, name, { required = false } = {}) => {
  if (v === undefined || v === null) { if (required) throw badArgs(`${name} is required`); return []; }
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !x.trim())) throw badArgs(`${name} must be an array of strings`);
  if (required && !v.length) throw badArgs(`${name} must not be empty`);
  return v.map((x) => x.trim());
};
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

/* ─── Gmail ─── */
const hdr = (headers, name) => headers?.find((h) => String(h?.name).toLowerCase() === name)?.value ?? '';
function decodeData(data, contentType = '') {
  const buf = Buffer.from(String(data ?? ''), 'base64url');
  const cs = /charset="?([\w.\-]+)"?/i.exec(contentType)?.[1]?.toLowerCase() ?? 'utf-8';
  try { return new TextDecoder(cs).decode(buf); } catch { return buf.toString('utf8'); }
}
const stripHtml = (h) => String(h)
  .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
  .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n')
  .replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
  .replace(/\n{3,}/g, '\n\n').trim();
function walkParts(p, acc) {
  if (!p) return acc;
  const ct = hdr(p.headers, 'content-type') || p.mimeType || '';
  const isAttachment = !!p.filename || /^attachment/i.test(hdr(p.headers, 'content-disposition'));
  if (isAttachment) acc.attachments.push({ filename: p.filename || '', mimeType: p.mimeType || '', size: p.body?.size ?? 0 });
  else if (p.mimeType === 'text/plain' && p.body?.data && acc.text === null) acc.text = decodeData(p.body.data, ct);
  else if (p.mimeType === 'text/html' && p.body?.data && acc.html === null) acc.html = decodeData(p.body.data, ct);
  for (const c of p.parts ?? []) walkParts(c, acc);
  return acc;
}
function summarizeMessage(m, { withBody = false, budget = null } = {}) {
  const h = m?.payload?.headers ?? [];
  const o = { id: m?.id, threadId: m?.threadId, subject: hdr(h, 'subject'), from: hdr(h, 'from'), to: hdr(h, 'to'), date: hdr(h, 'date'), labelIds: m?.labelIds ?? [], snippet: m?.snippet ?? '' };
  const cc = hdr(h, 'cc'); if (cc) o.cc = cc;
  if (withBody) {
    const acc = walkParts(m?.payload, { text: null, html: null, attachments: [] });
    let body = acc.text ?? (acc.html !== null ? stripHtml(acc.html) : '');
    const cap = budget ? Math.min(BODY_CAP, Math.max(0, budget.left)) : BODY_CAP;
    if (body.length > cap) { o.bodyTruncated = true; body = body.slice(0, cap); }
    if (budget) budget.left -= body.length;
    o.body = body;
    if (acc.attachments.length) o.attachments = acc.attachments;
  }
  return o;
}
const wantsBody = (fmt) => !['MINIMAL', 'METADATA_ONLY'].includes(String(fmt ?? ''));
const META_Q = { format: 'metadata', metadataHeaders: ['Subject', 'From', 'To', 'Cc', 'Date'] };

// RFC 2047 — 비ASCII 제목은 UTF-8 base64 인코딩 단어로. 헤더 값의 줄바꿈은 헤더 주입이라 공백으로 바꾼다.
function encodeHeader(v) {
  const s = String(v ?? '').replace(/[\r\n]+/g, ' ');
  if (!/[^\x20-\x7e]/.test(s)) return s;
  const words = []; let cur = '';
  for (const ch of s) {
    if (Buffer.byteLength(cur + ch) > 45) { words.push(cur); cur = ''; }
    cur += ch;
  }
  if (cur) words.push(cur);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w).toString('base64')}?=`).join('\r\n ');
}
const EMAIL_RE = /^[^\s@<>",;:()\[\]\\]+@[^\s@<>",;:()\[\]\\]+$/;
function emails(v, name) {
  const a = strArray(v, name);
  for (const x of a) if (!EMAIL_RE.test(x)) throw badArgs(`${name}: '${x.slice(0, 80)}' is not a plain email address`);
  return a;
}
const b64lines = (buf) => buf.toString('base64').replace(/.{1,76}/g, '$&\r\n');
function mimePart(type, content) {
  return `Content-Type: ${type}; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64lines(Buffer.from(String(content), 'utf8'))}`;
}
function buildRaw({ to, cc, bcc, subject, body, htmlBody, attachments, inReplyTo, references }) {
  const head = [];
  if (to.length) head.push(`To: ${to.join(', ')}`);
  if (cc.length) head.push(`Cc: ${cc.join(', ')}`);
  if (bcc.length) head.push(`Bcc: ${bcc.join(', ')}`);
  head.push(`Subject: ${encodeHeader(subject ?? '')}`);
  if (inReplyTo) head.push(`In-Reply-To: ${encodeHeader(inReplyTo)}`);
  if (references) head.push(`References: ${encodeHeader(references)}`);
  head.push('MIME-Version: 1.0');
  const textPart = htmlBody && body
    ? (() => { const b = `alt_${randomUUID()}`; return `Content-Type: multipart/alternative; boundary="${b}"\r\n\r\n--${b}\r\n${mimePart('text/plain', body)}--${b}\r\n${mimePart('text/html', htmlBody)}--${b}--\r\n`; })()
    : htmlBody ? mimePart('text/html', htmlBody) : mimePart('text/plain', body ?? '');
  let mime;
  if (attachments.length) {
    const b = `mix_${randomUUID()}`;
    mime = `Content-Type: multipart/mixed; boundary="${b}"\r\n\r\n--${b}\r\n${textPart}`;
    for (const a of attachments) {
      const name = encodeHeader(a.filename || 'attachment').replace(/"/g, '');
      const type = /^[\w.+\-]+\/[\w.+\-]+$/.test(a.mimeType ?? '') ? a.mimeType : 'application/octet-stream';
      mime += `--${b}\r\nContent-Type: ${type}; name="${name}"\r\nContent-Disposition: ${a.inline ? 'inline' : 'attachment'}; filename="${name}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64lines(a.buf)}`;
    }
    mime += `--${b}--\r\n`;
  } else mime = textPart;
  return Buffer.from(`${head.join('\r\n')}\r\n${mime}`, 'utf8').toString('base64url');
}

const G = () => EP.gmail;
const threadMods = { label_thread: 'add', unlabel_thread: 'remove' };
const messageMods = { label_message: 'add', unlabel_message: 'remove' };
const SPAM = { addLabelIds: ['SPAM'], removeLabelIds: ['INBOX'] };
const UNSPAM = { addLabelIds: ['INBOX'], removeLabelIds: ['SPAM'] };
const LABEL_LIST_VIS = { LABEL_SHOW: 'labelShow', LABEL_SHOW_IF_UNREAD: 'labelShowIfUnread', LABEL_HIDE: 'labelHide' };
const MSG_LIST_VIS = { SHOW: 'show', HIDE: 'hide' };

const GMAIL = {
  async search_threads(api, a) {
    const r = await api('GET', `${G()}/threads${qs({ q: a.query, maxResults: clampSize(a.pageSize, 20, 50), pageToken: a.pageToken, includeSpamTrash: a.includeTrash ? 'true' : undefined })}`);
    const threads = await mapLimit(r.threads ?? [], FANOUT, async (t) => {
      const full = await api('GET', `${G()}/threads/${seg(t.id, 'threadId')}${qs(META_Q)}`);
      const msgs = full.messages ?? [];
      const first = summarizeMessage(msgs[0] ?? {});
      const last = summarizeMessage(msgs[msgs.length - 1] ?? {});
      return { id: t.id, subject: first.subject, from: first.from, lastDate: last.date, messageCount: msgs.length, snippet: t.snippet ?? last.snippet, labelIds: [...new Set(msgs.flatMap((m) => m.labelIds ?? []))] };
    });
    return { threads, ...(r.nextPageToken ? { nextPageToken: r.nextPageToken } : {}), resultSizeEstimate: r.resultSizeEstimate ?? threads.length };
  },
  async get_thread(api, a) {
    const body = wantsBody(a.messageFormat);
    const t = await api('GET', `${G()}/threads/${seg(a.threadId, 'threadId')}${qs(body ? { format: 'full' } : META_Q)}`);
    const budget = { left: THREAD_CAP };
    return { id: t.id, messages: (t.messages ?? []).map((m) => summarizeMessage(m, { withBody: body, budget })) };
  },
  async get_message(api, a) {
    const body = wantsBody(a.messageFormat);
    const m = await api('GET', `${G()}/messages/${seg(a.messageId, 'messageId')}${qs(body ? { format: 'full' } : META_Q)}`);
    return summarizeMessage(m, { withBody: body });
  },
  async list_labels(api) {
    const r = await api('GET', `${G()}/labels`);
    return { labels: (r.labels ?? []).map((l) => ({ id: l.id, name: l.name, type: l.type })) };
  },
  async list_drafts(api, a) {
    const r = await api('GET', `${G()}/drafts${qs({ q: a.query, maxResults: clampSize(a.pageSize, 20, 50), pageToken: a.pageToken })}`);
    const drafts = await mapLimit(r.drafts ?? [], FANOUT, async (d) => {
      const full = await api('GET', `${G()}/drafts/${seg(d.id, 'draftId')}${qs(META_Q)}`);
      const m = summarizeMessage(full.message ?? {});
      return { id: d.id, messageId: m.id, threadId: m.threadId, subject: m.subject, to: m.to, date: m.date, snippet: m.snippet };
    });
    return { drafts, ...(r.nextPageToken ? { nextPageToken: r.nextPageToken } : {}) };
  },
  async get_draft(api, a) {
    const body = wantsBody(a.messageFormat);
    const d = await api('GET', `${G()}/drafts/${seg(a.draftId, 'draftId')}${qs(body ? { format: 'full' } : META_Q)}`);
    return { id: d.id, message: summarizeMessage(d.message ?? {}, { withBody: body }) };
  },
  async create_draft(api, a) {
    let to = emails(a.to, 'to');
    const cc = emails(a.cc, 'cc');
    const bcc = emails(a.bcc, 'bcc');
    if (a.body !== undefined && typeof a.body !== 'string') throw badArgs('body must be a string');
    if (a.htmlBody !== undefined && typeof a.htmlBody !== 'string') throw badArgs('htmlBody must be a string');
    const attachments = (Array.isArray(a.attachments) ? a.attachments : []).map((x, i) => {
      if (typeof x?.content !== 'string' || !x.content) throw badArgs(`attachments[${i}].content is required (base64)`);
      return { filename: String(x.filename ?? ''), mimeType: x.mimeType, inline: !!x.inline, buf: Buffer.from(x.content, 'base64') };
    });
    if (attachments.reduce((n, x) => n + x.buf.length, 0) > 25 * 1024 * 1024) throw badArgs('attachments exceed 25MB in total');
    let subject = a.subject ?? '';
    let threadId; let inReplyTo; let references;
    if (a.replyToMessageId) {
      const o = await api('GET', `${G()}/messages/${seg(a.replyToMessageId, 'replyToMessageId')}${qs({ format: 'metadata', metadataHeaders: ['Subject', 'From', 'Reply-To', 'Message-ID', 'References'] })}`);
      const h = o.payload?.headers ?? [];
      threadId = o.threadId;
      inReplyTo = hdr(h, 'message-id') || undefined;
      references = [hdr(h, 'references'), inReplyTo].filter(Boolean).join(' ') || undefined;
      if (!a.subject) { const s = hdr(h, 'subject'); subject = /^re:/i.test(s) ? s : `Re: ${s}`; }
      if (!to.length) {
        const addr = /<([^>]+)>/.exec(hdr(h, 'reply-to') || hdr(h, 'from'))?.[1] ?? (hdr(h, 'reply-to') || hdr(h, 'from')).trim();
        if (EMAIL_RE.test(addr)) to = [addr];
      }
    }
    const raw = buildRaw({ to, cc, bcc, subject, body: a.body, htmlBody: a.htmlBody, attachments, inReplyTo, references });
    const d = await api('POST', `${G()}/drafts`, { message: { raw, ...(threadId ? { threadId } : {}) } });
    return { draftId: d.id, messageId: d.message?.id, threadId: d.message?.threadId ?? threadId, sent: false, note: 'Draft saved. It was not sent — the user can review and send it from Gmail.' };
  },
  async create_label(api, a) {
    const name = String(a.displayName ?? '').trim();
    if (!name) throw badArgs('displayName is required');
    const l = await api('POST', `${G()}/labels`, {
      name,
      ...(LABEL_LIST_VIS[a.labelListVisibility] ? { labelListVisibility: LABEL_LIST_VIS[a.labelListVisibility] } : {}),
      ...(MSG_LIST_VIS[a.messageListVisibility] ? { messageListVisibility: MSG_LIST_VIS[a.messageListVisibility] } : {}),
    });
    return { id: l.id, name: l.name };
  },
};
for (const [tool, dir] of Object.entries(threadMods)) {
  GMAIL[tool] = async (api, a) => {
    const ids = strArray(a.labelIds, 'labelIds', { required: true });
    const r = await api('POST', `${G()}/threads/${seg(a.threadId, 'threadId')}/modify`, dir === 'add' ? { addLabelIds: ids } : { removeLabelIds: ids });
    return { id: r.id ?? a.threadId, ok: true };
  };
}
for (const [tool, dir] of Object.entries(messageMods)) {
  GMAIL[tool] = async (api, a) => {
    const ids = strArray(a.labelIds, 'labelIds', { required: true });
    const r = await api('POST', `${G()}/messages/${seg(a.messageId, 'messageId')}/modify`, dir === 'add' ? { addLabelIds: ids } : { removeLabelIds: ids });
    return { id: r.id ?? a.messageId, labelIds: r.labelIds ?? [] };
  };
}
GMAIL.update_message_labels = async (api, a) => {
  const add = strArray(a.addLabelIds, 'addLabelIds');
  const remove = strArray(a.removeLabelIds, 'removeLabelIds');
  if (!add.length && !remove.length) throw badArgs('addLabelIds or removeLabelIds is required');
  const r = await api('POST', `${G()}/messages/${seg(a.messageId, 'messageId')}/modify`, { addLabelIds: add, removeLabelIds: remove });
  return { id: r.id ?? a.messageId, labelIds: r.labelIds ?? [] };
};
for (const [kind, idName, path] of [['thread', 'threadId', 'threads'], ['message', 'messageId', 'messages']]) {
  const at = (a) => `${G()}/${path}/${seg(a[idName], idName)}`;
  GMAIL[`trash_${kind}`] = async (api, a) => { await api('POST', `${at(a)}/trash`); return { id: a[idName], trashed: true }; };
  GMAIL[`untrash_${kind}`] = async (api, a) => { await api('POST', `${at(a)}/untrash`); return { id: a[idName], trashed: false }; };
  GMAIL[`mark_${kind}_spam`] = async (api, a) => { await api('POST', `${at(a)}/modify`, SPAM); return { id: a[idName], spam: true }; };
  GMAIL[`unmark_${kind}_spam`] = async (api, a) => { await api('POST', `${at(a)}/modify`, UNSPAM); return { id: a[idName], spam: false }; };
  GMAIL[`apply_sensitive_${kind}_label`] = async (api, a) => {
    if (a.labelOption === 'TRASH') return GMAIL[`trash_${kind}`](api, a);
    if (a.labelOption === 'SPAM') return GMAIL[`mark_${kind}_spam`](api, a);
    throw badArgs("labelOption must be 'TRASH' or 'SPAM'");
  };
}

/* ─── 구글 캘린더 ─── */
const C = () => EP.calendar;
const HAS_OFFSET = /(Z|[+-]\d{2}:?\d{2})$/i;
function localParts(ms, tz) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' });
  return Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
}
function tzOffsetMs(ms, tz) {
  const p = localParts(ms, tz);
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000;
}
/** 시간대 표기 없는 현지 시각('2026-04-30T10:00:00')을 그 시간대 기준의 UTC 시각(ms)으로 바꾼다. 표기가 있으면 그대로 읽는다. */
function toMs(local, tz, name) {
  const s = String(local ?? '').trim();
  if (HAS_OFFSET.test(s)) { const t = Date.parse(s); if (Number.isNaN(t)) throw badArgs(`${name} is not a valid time`); return t; }
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (!m) throw badArgs(`${name} must be ISO 8601 like 2026-04-30T10:00:00`);
  const asUtc = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
  try {
    const o1 = tzOffsetMs(asUtc, tz);
    let t = asUtc - o1;
    const o2 = tzOffsetMs(t, tz);
    if (o2 !== o1) t = asUtc - o2;
    return t;
  } catch { throw badArgs(`timeZone '${tz}' is not valid`); }
}
const localStr = (ms, tz) => { const p = localParts(ms, tz); return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`; };
const SEND_UPDATES = { NONE: 'none', EXTERNAL_ONLY: 'externalOnly', ALL: 'all' };
// 알림 메일 기본값은 none — 원격 MCP의 기본(ALL)과 다르다. 일정 변경 알림도 남에게 나가는 메일이라, 크루가 명시할 때만 보낸다(총괄 배정 2026-10-14).
const sendUpdates = (lvl) => SEND_UPDATES[lvl] ?? 'none';
const calId = (a) => seg(a.calendarId || 'primary', 'calendarId');
async function calTz(api, a, ctx) {
  if (a.timeZone) return a.timeZone;
  const key = a.calendarId || 'primary';
  if (!ctx.tz.has(key)) ctx.tz.set(key, (await api('GET', `${C()}/calendars/${calId(a)}`)).timeZone || 'UTC');
  return ctx.tz.get(key);
}
function summarizeEvent(e, descCap = 2000) {
  if (!e) return null;
  const o = { id: e.id, summary: e.summary ?? '', start: e.start, end: e.end, status: e.status };
  if (e.location) o.location = e.location;
  if (e.description) o.description = String(e.description).slice(0, descCap);
  if (e.attendees?.length) o.attendees = e.attendees.map((x) => ({ email: x.email, responseStatus: x.responseStatus, ...(x.self ? { self: true } : {}), ...(x.organizer ? { organizer: true } : {}), ...(x.optional ? { optional: true } : {}) }));
  if (e.organizer?.email) o.organizer = e.organizer.email;
  if (e.hangoutLink) o.meetUrl = e.hangoutLink;
  if (e.recurringEventId) o.recurringEventId = e.recurringEventId;
  if (e.eventType && e.eventType !== 'default') o.eventType = e.eventType;
  if (e.htmlLink) o.htmlLink = e.htmlLink;
  return o;
}
const EVENT_TYPES = { DEFAULT: 'default', OUT_OF_OFFICE: 'outOfOffice', FOCUS_TIME: 'focusTime', WORKING_LOCATION: 'workingLocation', BIRTHDAY: 'birthday', FROM_GMAIL: 'fromGmail' };
const attendeeOf = (x) => {
  if (typeof x === 'string') return { email: x };
  if (!x?.email) throw badArgs('attendee.email is required');
  return { email: x.email, ...(x.displayName ? { displayName: x.displayName } : {}), ...(x.optionalAttendee ? { optional: true } : {}), ...(Number.isInteger(x.additionalGuests) ? { additionalGuests: x.additionalGuests } : {}) };
};
const addDay = (d) => { const t = new Date(`${d}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + 1); return t.toISOString().slice(0, 10); };
function eventTimes(a, tz) {
  if (a.allDay) {
    const sd = String(a.startTime ?? '').slice(0, 10);
    let ed = a.endTime ? String(a.endTime).slice(0, 10) : sd;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(sd)) throw badArgs('startTime must start with YYYY-MM-DD');
    if (ed <= sd) ed = addDay(sd);
    return { start: { date: sd }, end: { date: ed } };
  }
  const start = { dateTime: new Date(toMs(a.startTime, tz, 'startTime')).toISOString(), timeZone: tz };
  const end = { dateTime: new Date(toMs(a.endTime, tz, 'endTime')).toISOString(), timeZone: tz };
  return { start, end };
}
function commonEventFields(a) {
  const ev = {};
  for (const k of ['summary', 'description', 'location', 'colorId', 'visibility']) if (typeof a[k] === 'string') ev[k] = a[k];
  if (a.availability === 'AVAILABILITY_FREE') ev.transparency = 'transparent';
  if (a.availability === 'AVAILABILITY_BUSY') ev.transparency = 'opaque';
  if (a.useDefaultReminders === true) ev.reminders = { useDefault: true };
  if (Array.isArray(a.overrideReminders)) ev.reminders = { useDefault: false, overrides: a.overrideReminders.map((r) => ({ method: r?.method === 'email' ? 'email' : 'popup', minutes: Number(r?.minutes) || 0 })) };
  const gp = a.guestPermissions;
  if (gp && typeof gp === 'object') {
    if (typeof gp.guestsCanInviteOthers === 'boolean') ev.guestsCanInviteOthers = gp.guestsCanInviteOthers;
    if (typeof gp.guestsCanModify === 'boolean') ev.guestsCanModify = gp.guestsCanModify;
    if (typeof gp.guestsCanSeeGuests === 'boolean') ev.guestsCanSeeOtherGuests = gp.guestsCanSeeGuests;
  }
  if (a.addGoogleMeetUrl) ev.conferenceData = { createRequest: { requestId: randomUUID(), conferenceSolutionKey: { type: 'hangoutsMeet' } } };
  return ev;
}

const CAL = {
  async list_calendars(api, a) {
    const r = await api('GET', `${C()}/users/me/calendarList${qs({ maxResults: clampSize(a.pageSize, 100, 250), pageToken: a.pageToken })}`);
    return { calendars: (r.items ?? []).map((c) => ({ id: c.id, summary: c.summaryOverride || c.summary, primary: !!c.primary, accessRole: c.accessRole, timeZone: c.timeZone })), ...(r.nextPageToken ? { nextPageToken: r.nextPageToken } : {}) };
  },
  async list_events(api, a, ctx) {
    const tz = await calTz(api, a, ctx);
    const startMs = a.startTime ? toMs(a.startTime, tz, 'startTime') : Date.now();
    const endMs = a.endTime ? toMs(a.endTime, tz, 'endTime') : startMs + 7 * 86_400_000;
    const types = Array.isArray(a.eventType) ? a.eventType : (Array.isArray(a.eventTypeFilter) ? a.eventTypeFilter : []);
    const r = await api('GET', `${C()}/calendars/${calId(a)}/events${qs({
      timeMin: new Date(startMs).toISOString(), timeMax: new Date(endMs).toISOString(), singleEvents: 'true',
      orderBy: a.orderBy === 'updated' ? 'updated' : 'startTime', maxResults: clampSize(a.pageSize, 100, 250), pageToken: a.pageToken,
      q: a.fullText, timeZone: tz, eventTypes: types.map((t) => EVENT_TYPES[t] ?? t).filter((t) => typeof t === 'string'),
    })}`);
    return { timeZone: tz, events: (r.items ?? []).map((e) => summarizeEvent(e)), ...(r.nextPageToken ? { nextPageToken: r.nextPageToken } : {}) };
  },
  async get_event(api, a) {
    return summarizeEvent(await api('GET', `${C()}/calendars/${calId(a)}/events/${seg(a.eventId, 'eventId')}`), 10_000);
  },
  async search_events(api, a) {
    const q = String(a.query ?? '').trim();
    if (!q) throw badArgs('query is required');
    const r = await api('GET', `${C()}/calendars/primary/events${qs({ q, singleEvents: 'true', maxResults: clampSize(a.pageSize, 25, 250), pageToken: a.pageToken })}`);
    return { events: (r.items ?? []).map((e) => summarizeEvent(e)), ...(r.nextPageToken ? { nextPageToken: r.nextPageToken } : {}) };
  },
  async suggest_time(api, a, ctx) {
    const who = emails(a.attendeeEmails, 'attendeeEmails');
    if (!who.length) throw badArgs('attendeeEmails is required');
    const tz = await calTz(api, { ...a, calendarId: 'primary' }, ctx);
    const min = toMs(a.startTime, tz, 'startTime');
    const max = toMs(a.endTime, tz, 'endTime');
    if (!(max > min)) throw badArgs('endTime must be after startTime');
    const ids = [...new Set(['primary', ...who])];
    const r = await api('POST', `${C()}/freeBusy`, { timeMin: new Date(min).toISOString(), timeMax: new Date(max).toISOString(), timeZone: tz, items: ids.map((id) => ({ id })) });
    const unavailable = [];
    const busy = [];
    for (const id of ids) {
      const c = r.calendars?.[id];
      if (!c || c.errors?.length) { if (id !== 'primary') unavailable.push(id); continue; }
      for (const b of c.busy ?? []) busy.push([Date.parse(b.start), Date.parse(b.end)]);
    }
    busy.sort((x, y) => x[0] - y[0]);
    const free = []; let cur = min;
    for (const [s, e] of busy) { if (s > cur) free.push([cur, Math.min(s, max)]); cur = Math.max(cur, e); if (cur >= max) break; }
    if (cur < max) free.push([cur, max]);
    const dur = clampSize(a.durationMinutes, 30, 24 * 60) * 60_000;
    const pref = a.preferences ?? {};
    const want = clampSize(pref.pageSize, 5, 50);
    const hm = (s) => (/^\d{2}:\d{2}$/.test(String(s ?? '')) ? s : null);
    // 빈 구간을 현지 날짜별로 자르고 선호 시간대·주말 제외를 적용한 창을 만든다.
    const windows = [];
    for (const [s, e] of free) {
      let dayStart = s;
      while (dayStart < e) {
        const p = localParts(dayStart, tz);
        const day = `${p.year}-${p.month}-${p.day}`;
        const nextDay = toMs(`${addDay(day)}T00:00:00`, tz, 'day');
        if (!(pref.excludeWeekends && (p.weekday === 'Sat' || p.weekday === 'Sun'))) {
          const ws = Math.max(dayStart, hm(pref.startHour) ? toMs(`${day}T${pref.startHour}:00`, tz, 'startHour') : dayStart);
          const we = Math.min(e, nextDay, hm(pref.endHour) ? toMs(`${day}T${pref.endHour}:00`, tz, 'endHour') : nextDay);
          if (we - ws >= dur) windows.push([ws, we]);
        }
        dayStart = nextDay;
      }
    }
    // 창마다 첫 칸을 먼저 고르고, 모자라면 같은 창의 다음 칸으로 채운다(한 구간에 몰리지 않게).
    const slots = [];
    for (let k = 0; slots.length < want && k < 48; k++) {
      let added = false;
      for (const [ws, we] of windows) {
        const st = ws + k * dur;
        if (st + dur > we) continue;
        slots.push([st, st + dur]); added = true;
        if (slots.length >= want) break;
      }
      if (!added) break;
    }
    slots.sort((x, y) => x[0] - y[0]);
    return { timeZone: tz, slots: slots.map(([s, e]) => ({ start: localStr(s, tz), end: localStr(e, tz) })), ...(unavailable.length ? { unavailable } : {}) };
  },
  async create_event(api, a, ctx) {
    if (!String(a.summary ?? '').trim()) throw badArgs('summary is required');
    if (!a.startTime || !a.endTime) throw badArgs('startTime and endTime are required');
    const tz = await calTz(api, a, ctx);
    const ev = { ...commonEventFields(a), ...eventTimes(a, tz) };
    const people = [...(Array.isArray(a.attendees) ? a.attendees : []), ...emails(a.attendeeEmails, 'attendeeEmails')].map(attendeeOf);
    if (people.length) ev.attendees = people;
    if (Array.isArray(a.recurrenceData)) ev.recurrence = a.recurrenceData.map((r) => (/^(RRULE|RDATE|EXDATE|EXRULE):/i.test(r) ? r : `RRULE:${r}`));
    if (EVENT_TYPES[a.eventType] && ['default', 'outOfOffice', 'focusTime'].includes(EVENT_TYPES[a.eventType])) ev.eventType = EVENT_TYPES[a.eventType];
    const e = await api('POST', `${C()}/calendars/${calId(a)}/events${qs({ sendUpdates: sendUpdates(a.notificationLevel), conferenceDataVersion: ev.conferenceData ? 1 : undefined })}`, ev);
    return summarizeEvent(e);
  },
  async update_event(api, a, ctx) {
    const at = `${C()}/calendars/${calId(a)}/events/${seg(a.eventId, 'eventId')}`;
    const cur = await api('GET', at);
    const patch = commonEventFields(a);
    if (a.startTime || a.endTime || a.allDay) {
      const tz = a.timeZone || cur.start?.timeZone || await calTz(api, a, ctx);
      if (a.allDay) Object.assign(patch, eventTimes({ ...a, startTime: a.startTime ?? cur.start?.date ?? cur.start?.dateTime }, tz));
      else {
        const curStart = Date.parse(cur.start?.dateTime ?? `${cur.start?.date}T00:00:00Z`);
        const curEnd = Date.parse(cur.end?.dateTime ?? `${cur.end?.date}T00:00:00Z`);
        const s = a.startTime ? toMs(a.startTime, tz, 'startTime') : curStart;
        // 시작만 바꾸면 길이를 지킨다(원격 MCP와 같은 동작).
        const e = a.endTime ? toMs(a.endTime, tz, 'endTime') : s + (Number.isFinite(curEnd - curStart) ? curEnd - curStart : 3_600_000);
        if (!(e > s)) throw badArgs('endTime must be after startTime');
        patch.start = { dateTime: new Date(s).toISOString(), timeZone: tz };
        patch.end = { dateTime: new Date(e).toISOString(), timeZone: tz };
      }
    }
    const added = [...(Array.isArray(a.addedAttendees) ? a.addedAttendees : []), ...emails(a.addedAttendeeEmails, 'addedAttendeeEmails')].map(attendeeOf);
    const removed = new Set(emails(a.removedAttendeeEmails, 'removedAttendeeEmails').map((x) => x.toLowerCase()));
    if (added.length || removed.size) {
      const list = (cur.attendees ?? []).filter((x) => !removed.has(String(x.email).toLowerCase()));
      for (const x of added) if (!list.some((y) => String(y.email).toLowerCase() === x.email.toLowerCase())) list.push(x);
      patch.attendees = list;
    }
    const e = await api('PATCH', `${at}${qs({ sendUpdates: sendUpdates(a.notificationLevel), conferenceDataVersion: patch.conferenceData ? 1 : undefined })}`, patch);
    return summarizeEvent(e);
  },
  async delete_event(api, a) {
    await api('DELETE', `${C()}/calendars/${calId(a)}/events/${seg(a.eventId, 'eventId')}${qs({ sendUpdates: sendUpdates(a.notificationLevel) })}`);
    return { eventId: a.eventId, deleted: true };
  },
  async respond_to_event(api, a) {
    const status = String(a.responseStatus ?? '');
    if (!['accepted', 'declined', 'tentative'].includes(status)) throw badArgs("responseStatus must be 'accepted', 'declined' or 'tentative'");
    const at = `${C()}/calendars/${calId(a)}/events/${seg(a.eventId, 'eventId')}`;
    const cur = await api('GET', at);
    const attendees = cur.attendees ?? [];
    const me = attendees.find((x) => x.self);
    if (!me) throw new GErr('notAttendee');
    me.responseStatus = status;
    if (typeof a.responseComment === 'string') me.comment = a.responseComment;
    const e = await api('PATCH', `${at}${qs({ sendUpdates: sendUpdates(a.notificationLevel) })}`, { attendees });
    return { eventId: e.id ?? a.eventId, responseStatus: status };
  },
};

/* ─── 도구 정의(tools/list 대용) — 이름·읽기 여부는 원격 MCP 실측(2026-10-14)과 같다 ─── */
const S = (properties, required = []) => ({ type: 'object', properties, ...(required.length ? { required } : {}) });
const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const int = (description) => ({ type: 'integer', description });
const bool = (description) => ({ type: 'boolean', description });
const arr = (description, items = { type: 'string' }) => ({ type: 'array', items, description });
const RO = { readOnlyHint: true, destructiveHint: false };
const RW = { readOnlyHint: false, destructiveHint: false };
const RWD = { readOnlyHint: false, destructiveHint: true };
const FMT = str('PLAIN_TEXT or FULL_CONTENT include the body (default). MINIMAL or METADATA_ONLY return headers only.', { enum: ['MESSAGE_FORMAT_UNSPECIFIED', 'MINIMAL', 'FULL_CONTENT', 'METADATA_ONLY', 'PLAIN_TEXT', 'RAW'] });
const THREAD = str('Thread ID (from search_threads).');
const MESSAGE = str('Message ID (from get_thread).');
const LABEL_IDS = arr('Label IDs (system IDs like INBOX, STARRED, UNREAD, IMPORTANT, or user label IDs from list_labels).');
const CAL_ID = str('Calendar ID. Default: primary calendar.');
const NOTIFY = str('Who gets update emails. Default here: NONE (no emails).', { enum: ['NOTIFICATION_LEVEL_UNSPECIFIED', 'NONE', 'EXTERNAL_ONLY', 'ALL'] });
const TIME = (what) => str(`${what} (ISO 8601 local time without offset, e.g. 2026-04-30T10:00:00; interpreted in timeZone or the calendar's time zone).`);
const ATTENDEE = { type: 'object', properties: { email: str('Email'), displayName: str('Name'), optionalAttendee: bool('Optional attendee'), additionalGuests: int('Extra guests') }, required: ['email'] };
const REMINDER = { type: 'object', properties: { method: str('popup or email'), minutes: int('Minutes before start') } };
const EVENT_FIELDS = {
  calendarId: CAL_ID, description: str('Description (HTML allowed).'), location: str('Location.'), timeZone: str('IANA time zone, only if the user names one.'),
  allDay: bool('All-day event (dates only).'), availability: str('Busy or free.', { enum: ['AVAILABILITY_UNSPECIFIED', 'AVAILABILITY_BUSY', 'AVAILABILITY_FREE'] }),
  colorId: str('Event color ID.'), visibility: str('default, public, private or confidential.'), addGoogleMeetUrl: bool('Add a Google Meet link.'),
  useDefaultReminders: bool('Use calendar default reminders.'), overrideReminders: arr('Custom reminders.', REMINDER),
  guestPermissions: { type: 'object', properties: { guestsCanInviteOthers: bool(''), guestsCanModify: bool(''), guestsCanSeeGuests: bool('') } },
  notificationLevel: NOTIFY,
};

const TOOL_DEFS = {
  gmail: [
    ['search_threads', 'Search email threads with Gmail query syntax (e.g. "from:alice is:unread newer_than:7d"). Returns subject, sender, date and snippet per thread.', S({ query: str('Gmail search query. Empty = all threads.'), pageSize: int('Max threads (default 20, max 50).'), pageToken: str('Next page token.'), includeTrash: bool('Include Trash.') }), RO],
    ['get_thread', 'Get all messages of a thread, with plain-text bodies.', S({ threadId: THREAD, messageFormat: FMT }, ['threadId']), RO],
    ['get_message', 'Get one message, with its plain-text body.', S({ messageId: MESSAGE, messageFormat: FMT }, ['messageId']), RO],
    ['list_labels', 'List Gmail labels (system and user labels) with their IDs.', S({}), RO],
    ['list_drafts', 'List draft emails.', S({ query: str('Gmail search query.'), pageSize: int('Max drafts (default 20, max 50).'), pageToken: str('Next page token.') }), RO],
    ['get_draft', 'Get one draft email with its body.', S({ draftId: str('Draft ID (from list_drafts).'), messageFormat: FMT }, ['draftId']), RO],
    ['create_draft', 'Create a draft email. It is NOT sent — the user reviews and sends it from Gmail. Sending mail is not available.', S({
      to: arr('Recipients (plain email addresses).'), cc: arr('Cc recipients.'), bcc: arr('Bcc recipients.'), subject: str('Subject.'),
      body: str('Plain-text body (no Markdown).'), htmlBody: str('Optional HTML body.'), replyToMessageId: str('Message ID to reply to (threads the draft and defaults subject/recipient).'),
      attachments: arr('Attachments.', { type: 'object', properties: { content: str('Base64 content.'), filename: str('File name.'), mimeType: str('MIME type.'), inline: bool('Inline attachment.') }, required: ['content'] }),
    }), RW],
    ['label_thread', 'Add labels to a thread.', S({ threadId: THREAD, labelIds: LABEL_IDS }, ['threadId', 'labelIds']), RW],
    ['unlabel_thread', 'Remove labels from a thread.', S({ threadId: THREAD, labelIds: LABEL_IDS }, ['threadId', 'labelIds']), RWD],
    ['apply_sensitive_thread_label', 'Move a thread to Trash or Spam.', S({ threadId: THREAD, labelOption: str('TRASH or SPAM', { enum: ['LABEL_OPTION_UNSPECIFIED', 'TRASH', 'SPAM'] }) }, ['threadId', 'labelOption']), RWD],
    ['trash_thread', 'Move a thread to Trash (recoverable with untrash_thread).', S({ threadId: THREAD }, ['threadId']), RWD],
    ['untrash_thread', 'Restore a thread from Trash.', S({ threadId: THREAD }, ['threadId']), RW],
    ['mark_thread_spam', 'Mark a thread as spam.', S({ threadId: THREAD }, ['threadId']), RWD],
    ['unmark_thread_spam', 'Move a thread out of spam back to the inbox.', S({ threadId: THREAD }, ['threadId']), RW],
    ['label_message', 'Add labels to a message.', S({ messageId: MESSAGE, labelIds: LABEL_IDS }, ['messageId', 'labelIds']), RW],
    ['update_message_labels', 'Add and/or remove labels on a message.', S({ messageId: MESSAGE, addLabelIds: LABEL_IDS, removeLabelIds: LABEL_IDS }, ['messageId']), RW],
    ['unlabel_message', 'Remove labels from a message.', S({ messageId: MESSAGE, labelIds: LABEL_IDS }, ['messageId', 'labelIds']), RWD],
    ['apply_sensitive_message_label', 'Move a message to Trash or Spam.', S({ messageId: MESSAGE, labelOption: str('TRASH or SPAM', { enum: ['LABEL_OPTION_UNSPECIFIED', 'TRASH', 'SPAM'] }) }, ['messageId', 'labelOption']), RWD],
    ['trash_message', 'Move a message to Trash (recoverable with untrash_message).', S({ messageId: MESSAGE }, ['messageId']), RWD],
    ['untrash_message', 'Restore a message from Trash.', S({ messageId: MESSAGE }, ['messageId']), RW],
    ['mark_message_spam', 'Mark a message as spam.', S({ messageId: MESSAGE }, ['messageId']), RWD],
    ['unmark_message_spam', 'Move a message out of spam back to the inbox.', S({ messageId: MESSAGE }, ['messageId']), RW],
    ['create_label', 'Create a Gmail label. Use "/" for nesting (e.g. "Projects/Alpha").', S({ displayName: str('Label name.'), labelListVisibility: str('', { enum: ['LABEL_LIST_VISIBILITY_UNSPECIFIED', 'LABEL_SHOW', 'LABEL_SHOW_IF_UNREAD', 'LABEL_HIDE'] }), messageListVisibility: str('', { enum: ['MESSAGE_LIST_VISIBILITY_UNSPECIFIED', 'SHOW', 'HIDE'] }) }, ['displayName']), RW],
  ],
  calendar: [
    ['list_events', 'List events in a time range (default: now to 7 days later), expanded and ordered by start time.', S({ calendarId: CAL_ID, startTime: TIME('Range start'), endTime: TIME('Range end'), fullText: str('Free-text filter.'), pageSize: int('Max events (default 100, max 250).'), pageToken: str('Next page token.'), timeZone: str('IANA time zone, only if the user names one.'), orderBy: str('startTime (default) or updated.'), eventType: arr('Event types, e.g. DEFAULT, OUT_OF_OFFICE, FOCUS_TIME.') }), RO],
    ['get_event', 'Get one event.', S({ calendarId: CAL_ID, eventId: str('Event ID.') }, ['eventId']), RO],
    ['list_calendars', 'List the calendars the user owns or subscribes to.', S({ pageSize: int('Max calendars (default 100, max 250).'), pageToken: str('Next page token.') }), RO],
    ['suggest_time', 'Suggest free time slots for the user and the given attendees, using their free/busy information.', S({
      attendeeEmails: arr('Attendee emails.'), startTime: TIME('Search window start'), endTime: TIME('Search window end'), durationMinutes: int('Slot length in minutes (default 30).'), timeZone: str('IANA time zone, only if the user names one.'),
      preferences: { type: 'object', properties: { startHour: str('Earliest local time "HH:mm".'), endHour: str('Latest local time "HH:mm".'), excludeWeekends: bool('Skip Saturday and Sunday.'), pageSize: int('Max slots (default 5).') } },
    }, ['attendeeEmails', 'startTime', 'endTime']), RO],
    ['search_events', "Search events on the user's primary calendar by text.", S({ query: str('Search text.'), pageSize: int('Max events.'), pageToken: str('Next page token.') }, ['query']), RO],
    ['create_event', 'Create a calendar event. Attendees get no email unless notificationLevel is set.', S({ summary: str('Title.'), startTime: TIME('Start'), endTime: TIME('End'), attendees: arr('Attendees.', ATTENDEE), attendeeEmails: arr('Attendee emails (shorthand).'), recurrenceData: arr('RRULE/RDATE/EXDATE strings (RFC 5545).'), eventType: str('', { enum: ['EVENT_TYPE_UNSPECIFIED', 'DEFAULT', 'OUT_OF_OFFICE', 'FOCUS_TIME'] }), ...EVENT_FIELDS }, ['summary', 'startTime', 'endTime']), RW],
    ['update_event', 'Update an event. Changing only the start keeps the duration.', S({ eventId: str('Event ID.'), summary: str('New title.'), startTime: TIME('New start'), endTime: TIME('New end'), addedAttendees: arr('Attendees to add.', ATTENDEE), addedAttendeeEmails: arr('Attendee emails to add.'), removedAttendeeEmails: arr('Attendee emails to remove.'), ...EVENT_FIELDS }, ['eventId']), RW],
    ['delete_event', 'Delete an event.', S({ calendarId: CAL_ID, eventId: str('Event ID.'), notificationLevel: NOTIFY }, ['eventId']), RWD],
    ['respond_to_event', 'Respond to an event invitation as the user.', S({ calendarId: CAL_ID, eventId: str('Event ID.'), responseStatus: str('accepted, declined or tentative.', { enum: ['accepted', 'declined', 'tentative'] }), responseComment: str('Optional comment.'), notificationLevel: NOTIFY }, ['eventId', 'responseStatus']), RW],
  ],
};
const IMPL = { gmail: GMAIL, calendar: CAL };

/** 이 백엔드의 도구 목록 — listConnectorTools가 tools/list 대신 돌려준다(네트워크 없음). */
export function googleRestTools(kind) {
  return (TOOL_DEFS[kind] ?? []).map(([name, description, inputSchema, annotations]) => ({ name, description, inputSchema, annotations: { ...annotations } }));
}

const ok = (data) => ({ ok: true, isError: false, content: [{ type: 'text', text: JSON.stringify(data) }] });
const failText = (kind, lang, label, text) => ({ ok: false, isError: true, error: 'call_failed', googleError: kind, content: [{ type: 'text', text: `${label}: ${text}` }] });

/**
 * REST 백엔드 호출. 반환: 성공 { ok:true, content } / 실패 { ok:false, error:'call_failed', googleError, content } / 재연결 필요 { reauth:true }.
 * key = 같은 연결의 동시 토큰 갱신을 합치는 열쇠(wsId:serverId). saveTokens = 갱신 토큰 저장(호출부의 저장소).
 */
export async function callGoogleRest(kind, tool, args = {}, { key, tokens, client, saveTokens, lang = 'ko' } = {}) {
  const L = lang === 'en' ? 'en' : 'ko';
  const label = LABEL[kind] ?? 'Google';
  const fn = Object.hasOwn(IMPL[kind] ?? {}, tool) ? IMPL[kind][tool] : null;
  if (!fn) return failText('unknownTool', L, label, MSG.unknownTool[L](String(tool).slice(0, 80)));
  const api = makeSession(key, { tokens, client, saveTokens });
  try {
    return ok(await fn(api, args && typeof args === 'object' ? args : {}, { tz: new Map() }));
  } catch (e) {
    if (e instanceof GErr) {
      if (e.kind === 'reauth') return { reauth: true };
      return failText(e.kind, L, label, scrubSecrets(MSG[e.kind][L](e.detail)));
    }
    // 예상 밖 오류 — 메시지는 가려서 싣는다(스택·요청 정보 없음).
    return failText('internal', L, label, scrubSecrets(String(e?.message ?? e)).slice(0, 200));
  }
}
