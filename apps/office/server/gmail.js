export { VIEWABLE } from '../src/core/viewable.js';
// Gmail API 메시지 ↔ 오피스 메일 모양(순수 함수). 가져오기·보내기는 api/mail/[op].js, 규칙은 test/mail-server.test.mjs.

/** RFC 2047 인코딩 단어(=?UTF-8?B?…?= / Q) 풀기 — 헤더가 인코딩된 채로 오는 메일이 있다 */
export function decodeWords(s) {
  return String(s ?? '').replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=(\s+(?==\?))?/g, (_, cs, enc, text) => {
    const bytes = enc.toUpperCase() === 'B' ? Buffer.from(text, 'base64')
      : Buffer.from(text.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (__, h) => String.fromCharCode(parseInt(h, 16))), 'latin1');
    try { return new TextDecoder(cs).decode(bytes); } catch { return bytes.toString('utf8'); }
  });
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const entities = (s) => String(s ?? '').replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENT[e.toLowerCase()] ?? m));

/** 미리보기 채움 문자(뉴스레터가 요약 줄을 밀어내려고 넣는 U+034F·영폭 공백 반복)를 걷고 공백을 하나로 */
export const tidy = (s) => String(s ?? '').replace(/[\u034f\u00ad\u200b-\u200f\u2060\ufeff]/g, '').replace(/\s+/g, ' ').trim();

/** 'Kim <kim@x.com>' → { name, addr } */
export function parseAddress(v) {
  const s = decodeWords(v).trim();
  const m = /^(.*?)\s*<([^>]+)>\s*$/.exec(s);
  if (!m) return { name: s, addr: s };
  const name = m[1].replace(/^"|"$/g, '').trim();
  return { name: name || m[2], addr: m[2].trim() };
}

const header = (msg, name) => (msg.payload?.headers ?? []).find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';

/** 라벨 → 오피스 메일함 하나(15차). 별표·안 읽음은 메일함이 아니라 보기(starred·unread 칸)라 여기서 정하지 않는다.
 *  휴지통·스팸은 'trash' — 화면은 그 메일을 목록에서 뺀다. 초안 > 받은편지함 > 보낸편지함 > 보관함 순.
 *  나에게 보낸 메일(INBOX+SENT)은 'inbox' — 보낸편지함 보기는 이 값이 아니라 labels의 SENT로 판정한다(pages/mail-model.js inView) */
export function folderOf(labels = []) {
  if (labels.includes('TRASH')) return 'trash';
  if (labels.includes('SPAM')) return 'spam'; // 스팸은 휴지통 메일함에 섞지 않는다(10/9) — 화면은 어디에도 보이지 않는다
  if (labels.includes('DRAFT')) return 'drafts';
  if (labels.includes('INBOX')) return 'inbox';
  if (labels.includes('SENT')) return 'sent';
  return 'archive';
}

/** 목록 한 줄(format=metadata) — 메일함은 요청한 폴더가 아니라 라벨로 정한다(별표함·검색 결과의 메일도 제자리 메일함을 갖게) */
export function envelope(msg, account) {
  const from = parseAddress(header(msg, 'From'));
  const labels = msg.labelIds ?? [];
  return {
    id: `${account}.${msg.id}`, gid: msg.id, account, threadId: msg.threadId,
    from: from.name, addr: from.addr, to: decodeWords(header(msg, 'To')), subject: decodeWords(header(msg, 'Subject')),
    snippet: tidy(entities(msg.snippet)), at: new Date(Number(msg.internalDate) || Date.parse(header(msg, 'Date')) || 0).toISOString(),
    unread: labels.includes('UNREAD'), starred: labels.includes('STARRED'), folder: folderOf(labels), labels,
  };
}

/** history.list 응답 → 바뀐 메일 id(새로 온 것·라벨이 바뀐 것)와 지워진 id. 초안은 자동 저장마다 새 메시지가 생기므로 빼고(임시 보관함은 열 때 다시 받는다),
 *  같은 메일이 추가된 뒤 지워졌으면 지운 쪽만 남긴다 */
export function historyChanges(res) {
  const touched = new Set(), gone = new Set();
  for (const h of res?.history ?? []) {
    for (const x of h.messagesAdded ?? []) if (x.message?.id && !(x.message.labelIds ?? []).includes('DRAFT')) touched.add(x.message.id);
    for (const x of [...(h.labelsAdded ?? []), ...(h.labelsRemoved ?? [])]) if (x.message?.id && !(x.message.labelIds ?? []).includes('DRAFT')) touched.add(x.message.id);
    for (const x of h.messagesDeleted ?? []) if (x.message?.id) gone.add(x.message.id);
  }
  for (const id of gone) touched.delete(id);
  return { touched: [...touched], gone: [...gone] };
}

/** 요청 제한 응답에서 기다릴 초 — Retry-After(초 또는 날짜) → 본문의 'Retry after <날짜>' → 없으면 null */
export function retryAfterSec(headerValue, body = '', now = Date.now()) {
  const v = String(headerValue ?? '').trim();
  if (v) {
    const n = Number(v);
    if (Number.isFinite(n)) return Math.max(0, Math.ceil(n));
    const at = Date.parse(v);
    if (Number.isFinite(at)) return Math.max(0, Math.ceil((at - now) / 1000));
  }
  const m = /Retry after ([0-9T:.\-+Z ]{10,40})/i.exec(String(body));
  const at = m ? Date.parse(m[1].trim()) : NaN;
  return Number.isFinite(at) ? Math.max(0, Math.ceil((at - now) / 1000)) : null;
}
/** Gmail이 요청 제한을 403으로 돌려줄 때(사용자·초당 한도) — 본문 사유로 가른다 */
export const isRateLimited = (status, body = '') => status === 429 || (status === 403 && /rateLimitExceeded|userRateLimitExceeded|RESOURCE_EXHAUSTED/i.test(String(body)));

/** 한 요청 안의 Gmail 호출을 동시에 n개까지만(15차 B3 — 메타 30통을 한 번에 쏘지 않는다). 결과는 입력 순서 그대로 */
export async function mapLimit(items, n, fn) {
  const list = [...items], out = new Array(list.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, async () => {
    while (i < list.length) { const k = i++; out[k] = await fn(list[k], k); }
  }));
  return out;
}

const b64 = (d) => Buffer.from(String(d ?? ''), 'base64url').toString('utf8');

/** 본문(format=full) — html이 있으면 html, 없으면 text. 첨부는 이름·크기만(내용은 따로 받는다) */
export function content(msg) {
  let html = null, text = null;
  const attachments = [], inline = [];
  const walk = (p) => {
    if (!p) return;
    const cid = (p.headers ?? []).find((h) => h.name.toLowerCase() === 'content-id')?.value?.replace(/^<|>$/g, '');
    if (cid && /^image\//.test(p.mimeType) && (p.body?.attachmentId || p.body?.data)) inline.push({ cid, type: p.mimeType, id: p.body.attachmentId ?? null, data: p.body.data ?? null, size: p.body.size ?? 0 }); // 본문 속 그림 — 첨부 목록에 넣지 않는다
    else if (p.filename && p.body?.attachmentId) attachments.push({ id: p.body.attachmentId, name: decodeWords(p.filename), type: p.mimeType, size: p.body.size ?? 0 });
    else if (p.mimeType === 'text/html' && html === null && p.body?.data) html = b64(p.body.data);
    else if (p.mimeType === 'text/plain' && text === null && p.body?.data) text = b64(p.body.data);
    (p.parts ?? []).forEach(walk);
  };
  walk(msg.payload);
  return {
    html, text, attachments, inline,
    cc: decodeWords(header(msg, 'Cc')), messageId: header(msg, 'Message-ID') || header(msg, 'Message-Id'),
    references: header(msg, 'References'), inReplyTo: header(msg, 'In-Reply-To'), // 초안을 다시 열어 고칠 때 답장 스레드를 잇는다
  };
}

/** 원문 첨부 싣기(전달·초안 고치기) — 원본 메일의 첨부 중 keep(이름·크기)에 든 것만. keep이 없으면 전부 */
export function pickCarry(attachments = [], keep) {
  if (!Array.isArray(keep)) return attachments;
  const want = keep.map((k) => `${k?.name}\u0000${Number(k?.size) || 0}`);
  return attachments.filter((a) => want.includes(`${a.name}\u0000${Number(a.size) || 0}`));
}

/** 본문 속 그림(cid:) → data: 주소. images: { cid → { type, data(base64url) } } */
export function inlineImages(html, images) {
  if (!html) return html;
  return html.replace(/(["'(])cid:([^"')\s>]+)/gi, (m, q, cid) => {
    const i = images[cid] ?? images[decodeURIComponent(cid)];
    return i ? `${q}data:${i.type};base64,${Buffer.from(i.data, 'base64url').toString('base64')}` : m;
  });
}

/* ── 보내기 ── */
const clean = (s) => String(s ?? '').replace(/[\r\n]+/g, ' ').trim();             // 헤더 주입 차단
const word = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`);
const wrap = (buf) => buf.toString('base64').replace(/.{76}(?=.)/g, '$&\r\n');

/** RFC 5322 메시지(첨부 있으면 multipart/mixed) → Gmail API raw(base64url). attachments: [{ name, type, data(base64) | bytes(Buffer) }] */
export function buildRaw(msg, boundary) { return buildMime(msg, boundary).toString('base64url'); }
/** 같은 메시지를 바이트로 — 큰 메시지(원문 첨부를 실은 전달)는 Gmail 올리기 주소로 그대로 보낸다 */
export function buildMime({ from, to, cc, subject, text, html, inReplyTo, references, attachments = [] }, boundary = `argo-${Date.now().toString(36)}`) {
  const head = [
    from && `From: ${clean(from)}`, `To: ${clean(to)}`, cc && `Cc: ${clean(cc)}`, `Subject: ${word(clean(subject))}`,
    inReplyTo && `In-Reply-To: ${clean(inReplyTo)}`, (references || inReplyTo) && `References: ${clean([references, inReplyTo].filter(Boolean).join(' '))}`,
    'MIME-Version: 1.0',
  ].filter(Boolean);
  const plain = ['Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', wrap(Buffer.from(String(text ?? ''), 'utf8'))];
  // html이 있으면 글자 본문과 함께 multipart/alternative(글자만 보는 메일 앱도 내용을 본다) — 서명 요청 메일의 버튼(10/2 견적·계약)
  const alt = `${boundary}-alt`;
  const textPart = typeof html === 'string' && html ? [`Content-Type: multipart/alternative; boundary="${alt}"`, '', `--${alt}`, ...plain,
    `--${alt}`, 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', wrap(Buffer.from(html, 'utf8')), `--${alt}--`] : plain;
  const lines = !attachments.length ? [...head, ...textPart] : [
    ...head, `Content-Type: multipart/mixed; boundary="${boundary}"`, '',
    `--${boundary}`, ...textPart,
    ...attachments.flatMap((a) => {
      const name = clean(a.name) || 'file';
      return [`--${boundary}`, `Content-Type: ${clean(a.type) || 'application/octet-stream'}; name="${word(name)}"`, 'Content-Transfer-Encoding: base64',
        `Content-Disposition: attachment; filename="${word(name)}"; filename*=UTF-8''${encodeURIComponent(name)}`, '', wrap(Buffer.isBuffer(a.bytes) ? a.bytes : Buffer.from(String(a.data ?? ''), 'base64'))];
    }),
    `--${boundary}--`,
  ];
  return Buffer.from(lines.join('\r\n'));
}

/** 폴더 → Gmail 조회 조건. 보관함 = 받은편지함·보낸편지함·임시 보관함·스팸·휴지통이 아닌 것(Gmail의 '보관').
 *  안 읽음 = 받은편지함의 안 읽은 메일, 별표 = 별표한 메일 전부(15차). 임시 보관함은 drafts.list로 받는다(초안 id가 있어야 고치고 보낸다) */
export const FOLDER_QUERY = {
  inbox: { labelIds: 'INBOX' }, sent: { labelIds: 'SENT' }, drafts: { labelIds: 'DRAFT' },
  archive: { q: '-in:inbox -in:sent -in:drafts -in:spam -in:trash -in:chats' },
  unread: { q: 'in:inbox is:unread' }, starred: { q: 'is:starred' }, trash: { labelIds: 'TRASH' },
};
/** 바꿀 수 있는 라벨 — 읽음·보관·별표(15차) */
export const MODIFY_LABELS = ['UNREAD', 'INBOX', 'STARRED'];

/** 필요한 권한 — 사용자가 동의 화면에서 일부를 끄면 연결을 거절하고 다시 받게 한다 */
export const SCOPES = ['https://www.googleapis.com/auth/gmail.modify', 'https://www.googleapis.com/auth/gmail.compose'];
export const missingScopes = (granted) => SCOPES.filter((s) => !String(granted ?? '').split(/\s+/).includes(s));
