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
// 숫자 엔터티는 유니코드 범위 안일 때만 바꾼다 — &#99999999999; 같은 값은 String.fromCodePoint가 던져 그 메일의 변환(스레드 읽기)이 통째로 실패했다(10/9 보안 검토 중 재현)
const codePoint = (n, m) => (Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m);
const entities = (s) => String(s ?? '').replace(/&(#\d{1,8}|#x[0-9a-f]{1,8}|\w{1,32});/gi, (m, e) => (e[0] === '#' ? codePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1), m) : ENT[e.toLowerCase()] ?? m));

/** 미리보기 채움 문자(뉴스레터가 요약 줄을 밀어내려고 넣는 U+034F·영폭 공백 반복)를 걷고 공백을 하나로 */
export const tidy = (s) => String(s ?? '').replace(/[\u034f\u00ad\u200b-\u200f\u2060\ufeff]/g, '').replace(/\s+/g, ' ').trim();

export const HEADER_CAP = 2_000; // 머리 한 칸 상한 — 보낸 사람·인증 결과는 보통 수백 자. 남이 마음대로 만드는 값이라 문자열 처리 전에 자른다(10/9 보안 검토 ReDoS)
/** 'Kim <kim@x.com>' → { name, addr } — 끝의 <…>를 문자열 찾기로 한 번에. 예전 정규식(/^(.*?)\s*<([^>]+)>\s*$/)은 닫는 > 없는 긴 머리에서 제곱 시간이었다 */
export function parseAddress(v) {
  const s = decodeWords(String(v ?? '').slice(0, HEADER_CAP)).trim();
  const lt = s.endsWith('>') ? s.lastIndexOf('<') : -1;
  if (lt < 0 || lt >= s.length - 2) return { name: s, addr: s };
  const addr = s.slice(lt + 1, -1).trim();
  const name = s.slice(0, lt).trim().replace(/^"|"$/g, '').trim();
  return { name: name || addr, addr };
}

const header = (msg, name) => (msg.payload?.headers ?? []).find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';

/** 라벨 → 오피스 메일함 하나(15차). 별표·안 읽음은 메일함이 아니라 보기(starred·unread 칸)라 여기서 정하지 않는다.
 *  휴지통은 'trash'(휴지통 메일함에만 보인다), 스팸은 'spam'(어디에도 안 보인다, 10/9). 초안 > 받은편지함 > 보낸편지함 > 보관함 순.
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
    ...(authOf(msg) ? { auth: authOf(msg) } : {}),
  };
}

/** Gmail이 받을 때 붙인 인증 결과(순수) — 첫 Authentication-Results 머리가 mx.google.com의 것일 때만 { dmarc, from }(from = DMARC가 본 머리 From 도메인).
 *  보낸 사람은 From을 마음대로 쓸 수 있어, 본체 비서는 dmarc=pass이고 그 도메인이 보낸 주소와 같을 때만 "확인된 서비스의 보안 알림"으로 즉시 알린다
 *  (src/assistant/mail-classify.mjs). Gmail은 자기 결과를 맨 위에 붙이고, 보낸 쪽이 미리 심은 같은 이름 머리는 그 아래에 남는다 — 첫 것만 본다.
 *  없거나 다른 서버의 것이면 null(확인 못 함). 문자열 나누기만 쓴다(선형). */
/** 머리 값에서 따옴표 글("…", \" 이스케이프 포함)과 괄호 주석((…), 겹침 가능)을 지운다(순수, 한 번 훑기 — 선형). spf 칸의 봉투 주소·주석은 보낸 쪽이 고르는 글이라
 *  그 안의 ';dmarc=pass …'가 칸으로 나뉘면 Gmail의 결과를 바꿀 수 있다(10/9 분리 검수 MEDIUM 2). 닫히지 않은 따옴표·괄호는 끝까지 글로 본다(칸 없음 → 안전한 쪽) */
export function bareHeader(v) {
  let out = '', q = false, depth = 0;
  for (let i = 0; i < v.length; i++) {
    const c = v[i];
    if (q) { if (c === '\\') i += 1; else if (c === '"') q = false; continue; }
    if (c === '"') { q = true; continue; }
    if (c === '(') { depth += 1; continue; }
    if (depth) { if (c === '\\') i += 1; else if (c === ')') depth -= 1; continue; }
    out += c;
  }
  return out;
}
export function authOf(msg) {
  const h = (msg.payload?.headers ?? []).find((x) => String(x?.name ?? '').toLowerCase() === 'authentication-results');
  if (!h) return null;
  const parts = bareHeader(String(h.value ?? '').slice(0, HEADER_CAP)).split(';').map((x) => x.trim());
  if (parts[0]?.toLowerCase() !== 'mx.google.com') return null;
  const ds = parts.filter((x) => /^dmarc=/i.test(x));
  if (!ds.length) return { dmarc: 'none', from: '' };
  if (ds.length > 1) return { dmarc: 'unknown', from: '' }; // Gmail은 dmarc 칸을 하나만 쓴다 — 둘 이상이면 어느 것도 믿지 않는다(10/9 분리 검수 MEDIUM 2)
  const d = ds[0];
  const words = d.split(/\s+/);
  const result = words[0].slice(6).toLowerCase();
  const from = (words.find((w) => /^header\.from=/i.test(w)) ?? '').slice(12).toLowerCase();
  return { dmarc: /^[a-z]{1,20}$/.test(result) ? result : 'unknown', from: /^[a-z0-9.-]{1,253}$/.test(from) ? from : '' };
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

export const BODY_CAP = 200_000; // 글자로 바꿀 본문 상한 — 보통 HTML 메일은 20~100KB이고 쓰는 것은 메일당 앞 1,500자뿐이다. 새 글이 위에 있어 앞부분이면 충분하다(넘으면 앞만)
const BLOCK_END = new Set(['p', 'div', 'li', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
/** 메일 HTML → 글자(스크립트·스타일·head는 버리고 줄바꿈을 남긴다). 서버에는 DOM이 없다 — 한 번 훑는 상태 기계로(입력 길이에 선형).
 *  예전 정규식(/<(script|style|head)[\s\S]*?<\/\1>/·/<[^>]+>/·/[ \t]+\n/)은 닫히지 않은 <script·> 없는 <·줄바꿈 없는 긴 공백에서 제곱 시간이었다(10/9 보안 검토 ReDoS).
 *  닫는 짝이 없는 <script·<style·<head는 끝까지 버린다(브라우저도 그렇게 읽는다). 뒤에 >가 없는 <는 그 뒤를 글자로 둔다. */
export function htmlToText(html) {
  if (!html) return '';
  const src = String(html).slice(0, BODY_CAP);
  const low = src.toLowerCase();
  let out = '', i = 0;
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) { out += src.slice(i); break; }
    out += src.slice(i, lt);
    const gt = src.indexOf('>', lt + 1);
    if (gt < 0) { out += src.slice(lt); break; } // 뒤에 >가 하나도 없다 — 남은 것은 글자
    const closing = low[lt + 1] === '/';
    const name = /^[a-z][a-z0-9]{0,9}/.exec(low.slice(lt + (closing ? 2 : 1), Math.min(gt, lt + 13)))?.[0] ?? '';
    if (!closing && (name === 'script' || name === 'style' || name === 'head')) {
      const end = low.indexOf(`</${name}`, gt + 1);
      if (end < 0) break; // 닫히지 않음 — 끝까지 버린다
      const endGt = src.indexOf('>', end);
      i = endGt < 0 ? src.length : endGt + 1;
      continue;
    }
    if (name === 'br' || (closing && BLOCK_END.has(name))) out += '\n';
    i = gt + 1;
  }
  return entities(out).split('\n').map((l) => l.replace(/[ \t ]+$/, '')).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// 인용된 지난 글이 시작되는 줄 — 답장 메일은 지난 글 전체를 다시 싣는 일이 많아, 스레드로 받을 때는 각 메일의 새 글만 남긴다(지난 글은 그 메일이 따로 있다)
const QUOTE_HEAD = /^(>|On .{4,200} wrote:\s*$|-{2,}\s*Original Message\s*-{2,}|-{5,}\s*Forwarded message|\d{4}[.년\-/ ].{2,120}(작성|wrote)[:：]?\s*$|.{1,120}님이 작성:\s*$|From: .+@.+$|보낸 사람: .+$)/i;
/** 인용 앞까지(순수) — 인용 머리줄 앞의 글만. 남는 글이 없으면(전부 인용) 원문 그대로. 줄마다 앞 300자만 본다(머리줄은 짧다 — 긴 줄에서 정규식이 오래 돌지 않게) */
export function stripQuoted(text) {
  const src = String(text ?? '').slice(0, BODY_CAP);
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const cut = lines.findIndex((l) => QUOTE_HEAD.test(l.slice(0, 300).trim()));
  const kept = (cut >= 0 ? lines.slice(0, cut) : lines).join('\n').trim();
  return kept || src.trim();
}

/** 스레드(threads.get format=full) → 메일 목록(순수, 오래된 순) — 비서 메일 확인(본체 src/assistant/mail-source.mjs)이 답장 여부·준비 입력에 쓴다.
 *  메일마다 새 글 앞 per자, 최근 메일부터 합쳐 total자까지(넘으면 오래된 메일은 글 없이 머리만), 최근 max통. 본문 전체·첨부·그림은 내려주지 않는다 */
export function threadView(thread, account, { per = 1500, total = 6000, max = 10 } = {}) {
  const msgs = (thread?.messages ?? []).filter((m) => !(m.labelIds ?? []).includes('DRAFT')).slice(-max);
  let left = total;
  const out = msgs.slice().reverse().map((m) => {
    const e = envelope(m, account);
    const c = content(m);
    const body = stripQuoted(c.text ? c.text.slice(0, BODY_CAP) : htmlToText(c.html)).replace(/\n{3,}/g, '\n\n');
    const text = left > 0 ? body.slice(0, Math.min(per, left)) : '';
    left -= text.length;
    return { gid: e.gid, threadId: e.threadId, from: e.from, addr: e.addr, to: e.to, subject: e.subject, at: e.at, labels: e.labels,
      sent: e.labels.includes('SENT'), messageId: c.messageId || '', references: c.references || '', text, cut: text.length < body.length };
  });
  return out.reverse();
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
  unread: { q: 'in:inbox is:unread' }, starred: { q: 'is:starred' }, trash: { labelIds: 'TRASH', includeSpamTrash: 'true' }, // Gmail 기본값은 휴지통·스팸 제외 — 휴지통 라벨만 받되 제외되지 않게
};
/** 바꿀 수 있는 라벨 — 읽음·보관·별표(15차) */
export const MODIFY_LABELS = ['UNREAD', 'INBOX', 'STARRED'];

/** 필요한 권한 — 사용자가 동의 화면에서 일부를 끄면 연결을 거절하고 다시 받게 한다 */
export const SCOPES = ['https://www.googleapis.com/auth/gmail.modify', 'https://www.googleapis.com/auth/gmail.compose'];
/** 영구 삭제(휴지통 비우기) 권한 — 평소 연결에는 넣지 않고 비우기를 처음 누를 때만 요청한다(유건 10/9) */
export const PURGE_SCOPE = 'https://mail.google.com/';
export const missingScopes = (granted) => SCOPES.filter((s) => !String(granted ?? '').split(/\s+/).includes(s));
