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

/** 목록 한 줄(format=metadata) */
export function envelope(msg, account) {
  const from = parseAddress(header(msg, 'From'));
  const labels = msg.labelIds ?? [];
  return {
    id: `${account}.${msg.id}`, gid: msg.id, account, threadId: msg.threadId,
    from: from.name, addr: from.addr, to: decodeWords(header(msg, 'To')), subject: decodeWords(header(msg, 'Subject')),
    snippet: tidy(entities(msg.snippet)), at: new Date(Number(msg.internalDate) || Date.parse(header(msg, 'Date')) || 0).toISOString(),
    unread: labels.includes('UNREAD'), labels,
  };
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
    references: header(msg, 'References'),
  };
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

/** RFC 5322 메시지(첨부 있으면 multipart/mixed) → Gmail API raw(base64url). attachments: [{ name, type, data(base64) }] */
export function buildRaw({ from, to, cc, subject, text, html, inReplyTo, references, attachments = [] }, boundary = `argo-${Date.now().toString(36)}`) {
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
        `Content-Disposition: attachment; filename="${word(name)}"; filename*=UTF-8''${encodeURIComponent(name)}`, '', wrap(Buffer.from(a.data, 'base64'))];
    }),
    `--${boundary}--`,
  ];
  return Buffer.from(lines.join('\r\n')).toString('base64url');
}

/** 폴더 → Gmail 조회 조건. 보관함 = 받은편지함·보낸편지함·임시 보관함·스팸·휴지통이 아닌 것(Gmail의 '보관') */
export const FOLDER_QUERY = {
  inbox: { labelIds: 'INBOX' }, sent: { labelIds: 'SENT' }, drafts: { labelIds: 'DRAFT' },
  archive: { q: '-in:inbox -in:sent -in:drafts -in:spam -in:trash -in:chats' },
};

/** 필요한 권한 — 사용자가 동의 화면에서 일부를 끄면 연결을 거절하고 다시 받게 한다 */
export const SCOPES = ['https://www.googleapis.com/auth/gmail.modify', 'https://www.googleapis.com/auth/gmail.compose'];
export const missingScopes = (granted) => SCOPES.filter((s) => !String(granted ?? '').split(/\s+/).includes(s));
