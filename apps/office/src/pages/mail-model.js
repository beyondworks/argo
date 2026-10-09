// 메일 규칙(순수 함수, 15차) — 보기 판정·목록 합치기·변경분 반영·인용·전달 본문·HTML→글자·링크 나누기·큰 첨부 나누기·초안 이어 쓰기·알림 문구.
// 화면(Mail.jsx)·상태(core/mail.js)가 쓰고, 규칙은 test/mail-model.test.mjs가 잠근다. 사전(mail-i18n.js)만 들여온다(node 시험에서 그대로 읽힌다).
// 보내는 메일 안의 글(인용·전달 머리·링크 안내)과 날짜는 받은 언어(lang)로 — 화면 언어 상태(core/i18n)에 기대지 않는다.
import { MAIL_DICT } from './mail-i18n.js';

/** 사전 글 하나(언어를 받아서) */
export const L = (key, lang = 'ko', vars) => { let s = MAIL_DICT[key]?.[lang === 'en' ? 1 : 0] ?? key; if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, v); return s; };

export const VIEWS = ['inbox', 'unread', 'starred', 'drafts', 'sent', 'archive']; // 왼쪽 메일함 순서 — 안 읽음·별표는 보기(메일은 제자리 메일함을 그대로 갖는다)
export const ATTACH_CAP = 3 * 1024 * 1024;   // 메일에 바로 싣는 첨부 합계(서버 함수 요청 한도 4.5MB 안 — 유건 결정 5: 한도 유지, 넘는 파일은 문서함 링크)
export const SYNC_MAIL_MS = 30_000;          // 메일 화면이 보이는 동안 바뀐 것 받기 간격
export const SYNC_WATCH_MS = 60_000;         // 다른 화면에서 새 메일 알림을 켰을 때(오피스가 보이는 동안만)
export const RESUME_DAYS = 7;                // 이 기기에 남긴 쓰던 메일을 이어 여는 기간
export const NEW_WINDOW_MS = 30 * 60_000;    // 알림은 30분 안에 온 메일만(오래된 메일이 받은편지함으로 옮겨진 것은 알리지 않는다)

/** 보기에 드는가 — 휴지통·스팸은 어디에도 없다. 안 읽음 = 받은편지함의 안 읽은 메일, 별표 = 별표한 메일(초안 제외), 보낸편지함 = SENT 라벨(라벨을 모르는 예시 메일은 메일함) */
export function inView(m, view, pick = 'all') {
  if (!m || m.folder === 'trash' || (pick !== 'all' && m.account !== pick)) return false;
  if (view === 'unread') return m.folder === 'inbox' && !!m.unread;
  if (view === 'starred') return !!m.starred && m.folder !== 'drafts';
  if (view === 'sent' && m.labels) return m.labels.includes('SENT'); // 보낸편지함은 SENT 라벨로 — 나에게 보낸 메일(INBOX+SENT)은 받은편지함에도 같이 보인다(Gmail과 같다, 분리 검수 LOW-6)
  return m.folder === view;
}
/** 받은 시각 최신순 */
export const byDate = (a, b) => Date.parse(b.at) - Date.parse(a.at);

/** 보내는 중인 메일은 이 기기 값(읽음·메일함·별표)을 지킨다 — 서버가 아직 모르는 변경이 화면에서 되돌아가 보이지 않게 */
/** 이 기기에서 휴지통으로 보냈고 전송도 끝난 메일 — 캐시에서 치운다(검색에 다시 나오지 않게, 검수 #899). 보내는 중이면 되돌리기를 위해 남긴다 */
const trashed = (m, busy) => m.folder === 'trash' && !busy(m.id);
const keepLocal = (m, old) => ({ ...m, unread: old.unread, folder: old.folder, starred: old.starred ?? m.starred });

/** 목록 한 쪽을 받은 뒤 합치기.
 *  - 받은 메일은 새 값으로 바꾸되(이 기기에만 있는 칸은 남긴다), 보내는 중인(busy) 메일은 이 기기 값을 지킨다.
 *  - append(더 보기·검색)가 아니면, 이번에 받은 계정(done)의 이 보기 메일 중 새 목록에 없는 것은 뺀다(다른 기기에서 보관·지움).
 *    다만 그 계정에 다음 쪽이 있으면 받은 가장 오래된 메일보다 새것만 — 그보다 오래된 것은 아직 안 받은 쪽일 수 있다. */
export function mergeList(cache, fresh, { view = null, done = new Set(), busy = () => false, append = false, hasMore = {} } = {}) {
  const local = new Map(cache.map((m) => [m.id, m]));
  const got = fresh.map((m) => { const old = local.get(m.id); return old ? (busy(m.id) ? keepLocal({ ...old, ...m }, old) : { ...old, ...m }) : m; });
  const ids = new Set(got.map((m) => m.id));
  const oldest = {};
  for (const m of got) oldest[m.account] = Math.min(oldest[m.account] ?? Infinity, Date.parse(m.at));
  const stale = (m) => !append && view && done.has(m.account) && inView(m, view) && !busy(m.id)
    && (!hasMore[m.account] || Date.parse(m.at) >= (oldest[m.account] ?? -Infinity));
  return [...cache.filter((m) => !ids.has(m.id) && !stale(m) && !trashed(m, busy)), ...got.filter((m) => m.folder !== 'trash')];
}

/** 바뀐 것만 받기(계정 하나)의 결과 반영 — 바뀐 메일은 새 값(휴지통으로 간 것은 뺀다), 지워진 메일(gone: 오피스 id)은 뺀다 */
export function applySync(cache, changed = [], gone = new Set(), busy = () => false) {
  const local = new Map(cache.map((m) => [m.id, m]));
  const next = changed.map((m) => { const old = local.get(m.id); return old ? (busy(m.id) ? keepLocal({ ...old, ...m }, old) : { ...old, ...m }) : m; });
  const ids = new Set(next.map((m) => m.id));
  return [...cache.filter((m) => !ids.has(m.id) && !gone.has(m.id) && !trashed(m, busy)), ...next.filter((m) => m.folder !== 'trash')];
}
/** 새로 온 안 읽은 받은편지함 메일(알림 대상) — 이 기기가 처음 보는 메일 중 30분 안에 온 것 */
export function newArrivals(cache, changed = [], now = Date.now()) {
  const known = new Set(cache.map((m) => m.id));
  return changed.filter((m) => !known.has(m.id) && m.folder === 'inbox' && m.unread && now - Date.parse(m.at) < NEW_WINDOW_MS);
}

/* ── 주소·제목 ── */
/** 'A <a@x.com>, b@y.com' → ['a@x.com', 'b@y.com'] */
export const parseAddrs = (s) => (String(s ?? '').match(/[^\s<>,;"'()]+@[^\s<>,;"'()]+/g) ?? []).map((x) => x.replace(/^mailto:/i, ''));
const same = (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();
const uniq = (list) => list.filter((x, i) => list.findIndex((y) => same(x, y)) === i);
export const replySubject = (s) => (/^\s*re\s*:/i.test(s ?? '') ? String(s) : `Re: ${s ?? ''}`.trim());
export const forwardSubject = (s) => (/^\s*(fwd?|fw)\s*:/i.test(s ?? '') ? String(s) : `Fwd: ${s ?? ''}`.trim());
/** 답장 받는 사람 — 보통은 보낸 사람. 내가 보낸 메일에 답장하면 원래 받는 사람에게(Gmail과 같다) */
export function replyTo(mail, me) {
  if (me && same(mail.addr, me)) return uniq(parseAddrs(mail.to).filter((a) => !same(a, me))).join(', ') || mail.addr;
  return mail.addr ?? '';
}
/** 전체 회신 — 받는 사람: 보낸 사람(내가 보낸 메일이면 원래 받는 사람), 참조: 원래 받는 사람·참조에서 보낸 사람과 나를 뺀 나머지 */
export function replyAll(mail, cc, me) {
  const mine = me && same(mail.addr, me);
  const to = mine ? uniq(parseAddrs(mail.to).filter((a) => !same(a, me))) : [mail.addr].filter(Boolean);
  const rest = uniq([...(mine ? [] : parseAddrs(mail.to)), ...parseAddrs(cc)]).filter((a) => !same(a, me) && !to.some((x) => same(x, a)));
  return { to: to.join(', '), cc: rest.join(', ') };
}

/* ── 날짜 ── */
/** 정확한 날짜(한국 시각) — '2026년 10월 4일 (토) 오후 3:04' / 'Sat, Oct 4, 2026, 3:04 PM' */
export function fmtExact(iso, lang = 'ko') {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  // 숫자만 Intl에서 받아 직접 잇는다 — 오전/오후 표기가 실행 환경(ICU 데이터)마다 'PM'으로 바뀌는 일이 있어서(실측: node)
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Seoul', year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short', hour: 'numeric', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(d).map((x) => [x.type, x.value]));
  const h = Number(p.hour) % 24;
  const wd = L('mailx.weekdays', lang).split(',')[['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday)];
  return L('mailx.dateFmt', lang, { y: p.year, m: p.month, mon: L('mailx.months', lang).split(',')[p.month - 1], d: p.day, wd, ap: L('mailx.ampm', lang).split(',')[h < 12 ? 0 : 1], h: h % 12 || 12, mi: p.minute });
}

/* ── 본문 ── */
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
const decode = (s) => s.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+|#39);/gi, (m, e) => (e[0] === '#' && e !== '#39' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENT[e.toLowerCase()] ?? m));
export const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** HTML → 글자 본문(보낼 때 글자 갈래, 인용 원문). 문단·줄바꿈·목록(- / 1.)·링크(글자 (주소))를 살리고 나머지 태그는 걷는다 */
export function htmlToText(html) {
  let s = String(html ?? '');
  s = s.replace(/<(head|style|script|title)[^>]*>[\s\S]*?<\/\1>/gi, '');
  s = s.replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gi, (_, inner) => { let n = 0; return `\n${inner.replace(/<li[^>]*>/gi, () => `\n${++n}. `)}\n\n`; });
  s = s.replace(/<li[^>]*>/gi, '\n- ');
  s = s.replace(/<a\b[^>]*href\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi, (_, q, href, inner) => {
    const label = decode(inner.replace(/<[^>]+>/g, '')).trim(), url = decode(href).trim();
    return !label || label === url || /^mailto:/i.test(url) && label === url.slice(7) ? (label || url) : `${label} (${url})`;
  });
  s = s.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|h[1-6]|blockquote|tr|table|ul|ol)>/gi, '\n\n').replace(/<\/li>/gi, '');
  s = decode(s.replace(/<[^>]+>/g, ''));
  return s.split('\n').map((l) => l.replace(/[ \t ]+$/g, '')).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
/** 글자 본문 → 조각(글자 | 주소). http(s)만 주소로 — 끝의 문장부호는 주소에서 뺀다. 화면은 주소 조각만 <a>로 그린다(HTML을 끼워 넣지 않는다) */
const count = (s, c) => s.split(c).length - 1;
const trimUrl = (u) => {
  for (;;) {
    if (/[.,!?;:'"’”]$/.test(u)) u = u.slice(0, -1);
    else if (u.endsWith(')') && count(u, '(') < count(u, ')')) u = u.slice(0, -1); // (https://x.com/a) — 짝 없는 닫는 괄호만 뺀다(위키 주소의 괄호는 남긴다)
    else if (u.endsWith(']') && count(u, '[') < count(u, ']')) u = u.slice(0, -1);
    else return u;
  }
};
export function linkify(text) {
  const out = [], s = String(text ?? '');
  let last = 0;
  for (const m of s.matchAll(/https?:\/\/[^\s<>"'`]+/g)) {
    const url = trimUrl(m[0]);
    if (m.index > last) out.push({ t: 'text', v: s.slice(last, m.index) });
    out.push({ t: 'url', v: url });
    last = m.index + url.length;
  }
  if (last < s.length) out.push({ t: 'text', v: s.slice(last) });
  return out;
}
/** 원문 글자 — 글자 갈래가 있으면 그것, 없으면 HTML을 글자로, 그것도 없으면 요약 */
export const sourceText = (c, mail) => (c?.text?.trim() ? c.text : c?.html ? htmlToText(c.html) : mail?.snippet ?? (mail?.body ?? []).join('\n\n'));
const quoteHtmlBlock = (head, text) => `<div class="gmail_quote"><p>${escapeHtml(head)}</p><blockquote class="gmail_quote" style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${escapeHtml(text).replace(/\n/g, '<br>')}</blockquote></div>`;
const who = (mail) => (mail.from && !same(mail.from, mail.addr) ? `${mail.from} <${mail.addr}>` : mail.addr ?? mail.from ?? '');

/** 답장·전체 회신 인용 — '<날짜> <보낸 사람> 님이 작성:' + 원문(글자 갈래는 '> '를 붙인다) */
export function quoteBlock(mail, c, lang = 'ko') {
  const head = L('mailx.wrote', lang, { date: fmtExact(mail.at, lang), who: who(mail) });
  const body = sourceText(c, mail);
  return { text: `${head}\n${body.split('\n').map((l) => `> ${l}`).join('\n')}`, html: quoteHtmlBlock(head, body) };
}
/** 전달 — 원래 메일의 머리(보낸 사람·날짜·제목·받는 사람·참조)와 원문 */
export function forwardBlock(mail, c, lang = 'ko') {
  const head = [L('mailx.fwdHead', lang), `${L('mailx.from', lang)}: ${who(mail)}`, `${L('mailx.dateLabel', lang)}: ${fmtExact(mail.at, lang)}`, `${L('mailx.subjectLabel', lang)}: ${mail.subject ?? ''}`,
    mail.to && `${L('mailx.to', lang)}: ${mail.to}`, c?.cc && `${L('mailx.cc', lang)}: ${c.cc}`].filter(Boolean);
  const body = sourceText(c, mail);
  return { text: `${head.join('\n')}\n\n${body}`, html: `<div class="gmail_quote"><p>${head.map(escapeHtml).join('<br>')}</p><div>${escapeHtml(body).replace(/\n/g, '<br>')}</div></div>` };
}

/* ── 큰 첨부(유건 결정 5) ── */
/** 합계 cap 안에 드는 것만 메일에 싣고 나머지는 문서함 링크로 — 작은 파일부터 채워 메일에 실리는 파일 수를 늘린다. 각 묶음은 원래 순서 */
export function splitAttachments(files, cap = ATTACH_CAP) {
  const order = files.map((f, i) => ({ f, i })).sort((a, b) => a.f.size - b.f.size || a.i - b.i);
  const keep = new Set();
  let sum = 0;
  for (const { f, i } of order) if (sum + f.size <= cap) { sum += f.size; keep.add(i); }
  return { attach: files.filter((_, i) => keep.has(i)), link: files.filter((_, i) => !keep.has(i)) };
}
const size = (n) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1048576).toFixed(1)} MB`);
/** 본문 끝에 붙일 링크 안내 — links: [{ name, size, url }] */
export function linkNote(links, lang = 'ko', days = 30) {
  if (!links.length) return { text: '', html: '' };
  const head = L('mailx.linkHead', lang, { days });
  return {
    text: `${head}\n${links.map((l) => `- ${l.name} (${size(l.size)}): ${l.url}`).join('\n')}`,
    html: `<p>${escapeHtml(head)}</p><ul>${links.map((l) => `<li><a href="${escapeHtml(l.url)}">${escapeHtml(l.name)}</a> (${size(l.size)})</li>`).join('')}</ul>`,
  };
}
/** 보낼 본문 = 쓴 글 + 링크 안내 + 인용(답장·전달) — 글자·HTML 두 갈래 */
export function composeBody({ html = '', text, quote = null, links = [] }, lang = 'ko', days = 30) {
  const note = linkNote(links, lang, days);
  const mainText = text ?? htmlToText(html);
  return {
    text: [mainText, note.text, quote?.text].filter((x) => x && x.trim()).join('\n\n'),
    html: [html || (mainText ? `<p>${escapeHtml(mainText).replace(/\n/g, '<br>')}</p>` : ''), note.html, quote?.html].filter(Boolean).join(''),
  };
}

/* ── 초안 이어 쓰기 ── */
/** 빈 메일인가(받는 사람·참조·제목·본문·원문 첨부·파일 모두 없음) — 빈 메일은 저장하지 않는다 */
export const isBlank = (d) => !String(d?.to ?? '').trim() && !String(d?.cc ?? '').trim() && !String(d?.subject ?? '').trim()
  && !htmlToText(d?.html ?? '').trim() && !(d?.carry?.length) && !(d?.files ?? 0);
/** 첨부 묶음 표시 — 메일에 바로 싣는 파일(이름·크기·수정 시각)과 원문 첨부(이름·크기). 같으면 지난번 저장한 첨부와 같다 */
export const attachSig = (files, carry) => JSON.stringify([files.map((f) => [f.name, f.size, f.lastModified ?? 0]), carry.map((a) => [a.name, Number(a.size) || 0])]);
/** 초안 저장 방식(분리 검수 MEDIUM-2) — Gmail은 초안 일부만 고칠 수 없다(drafts.update는 메시지 전체를 바꾼다). 그래서 첨부가 있는 초안을 글만 바꿔 저장하면
 *  첨부를 매번 다시 올려야 하고(화면 → 서버 최대 4MB, 원문 첨부는 서버가 Gmail에서 최대 20MB 다시 받기), 첨부 없이 저장하면 초안에서 첨부가 사라진다.
 *  - 'text': 첨부가 없다 — 글만 임시 보관함에(가볍다)
 *  - 'full': 첨부가 지난번 저장과 다르거나(더하기·빼기·처음 저장), 닫을 때·보낼 때(final) — 첨부까지 한 번에
 *  - 'local': 첨부가 지난번 저장 그대로이고 글만 바뀌었다 — Gmail에 쓰지 않고 이 기기에만 남긴다(닫을 때 'full'로 임시 보관함에)
 *  부하: 첨부 2개를 단 메일을 10분 동안 고치며 첨부를 한 번 더하면 — 전: 멈출 때마다(5초) 저장 → 최대 120번 × 첨부 전부, 후: 첨부를 바꾼 1번 + 닫을 때 1번 = 2번 */
export function draftSavePlan({ files = [], carry = [], savedSig = null, final = false }) {
  if (!files.length && !carry.length) return { kind: 'text', sig: attachSig([], []) };
  const sig = attachSig(files, carry);
  return { kind: final || sig !== savedSig ? 'full' : 'local', sig };
}
/** 이 기기에 남긴 쓰던 메일을 다시 열까 — 같은 모양(v1)·7일 안·빈 메일이 아님 */
export const resumable = (snap, now = Date.now()) => !!snap && snap.v === 1 && now - (snap.at ?? 0) < RESUME_DAYS * 864e5 && !isBlank({ ...snap, files: 0 });

/* ── 알림 ── */
/** 새 메일 알림 문구 — 1통이면 '보낸 사람 / 제목', 여러 통이면 '새 메일 N통 / 이름 세 개' */
export function notifyText(list, lang = 'ko', hidden = false) {
  if (!list.length) return null;
  // 화면 전체 가리기 중(18차 검수 LOW 3) — OS 알림도 화면 밖에 보낸 사람·제목을 내보이지 않는다: "새 메일 N통"만
  if (hidden) return { title: L('mailx.newMany', lang, { n: list.length }), body: '', id: list.length === 1 ? list[0].id : null };
  const untitled = L('mailx.noSubject', lang);
  if (list.length === 1) return { title: list[0].from || list[0].addr || '', body: list[0].subject?.trim() || untitled, id: list[0].id };
  const names = uniq(list.map((m) => m.from || m.addr)).slice(0, 3).join(', ');
  return { title: L('mailx.newMany', lang, { n: list.length }), body: names, id: null };
}

/** 보낸 사람 아바타 — 이름(없으면 주소) 첫 글자와 주소별 색 번호(0~5, 화면이 기존 색 토큰에 맞춘다) */
export function avatarOf(name, addr) {
  const base = String(name || addr || '?').trim().replace(/^["'(<]+/, '');
  const letter = (base[0] ?? '?').toUpperCase();
  let h = 0;
  for (const ch of String(addr || base).toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return { letter, tone: h % 6 };
}
