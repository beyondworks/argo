// 에이전트 메일 도구(office_mail) — 오피스 17차 B-8(PARITY-mail I절 A1~A4). 인트라넷 에이전트 도구 mail_list·mail_read·mail_draft·mail_star를 아르고 오피스로 옮긴 것.
// 보내기는 만들지 않는다 — 크루는 초안까지(오피스 메일 서버 함수 apps/office/api/mail/[op].js 머리말 "크루는 이 함수로 보내지 않는다").
// 이 도구가 부르는 서버 동작은 list·read·draft·modify 넷뿐이고(MAIL_CALLS — 메서드까지 서버 라우터와 맞춘다), 초안은 언제나 새로 만든다(주인이 쓰던 초안을 덮지 않는다).
// 규칙: 회사·문서함 도구와 같은 관문(office-audience.mjs officeTurn — 주인의 기기 세션, 손님 턴은 chat.mjs가 먼저 거절)에 더해,
// 메일은 주인 개인 메일함이라 주인 혼자 보는 1:1에서만 다룬다(조직 채널에 메일 제목·본문이 올라가지 않게). 조직이 없는 개인 공간의 주인 1:1도 된다.
// chat.mjs도 1:1 턴에만 이 도구를 싣는다. 메일 쪽 글(보낸 사람·제목·요약·본문)은 호출마다 새로 만든 경계 문자열로 감싸 지시와 나눈다.
// 오피스 서버 함수를 주인 로그인 JWT로 부른다(드라이브 도구와 같은 방식) — 구글 토큰은 서버에만 있다. 오피스 주소 ARGO_OFFICE_ORIGIN(https 또는 루프백만).
// 계정 목록은 office_mail_accounts(본인 행만 — RLS). 메일 id는 오피스 목록과 같은 "계정id.Gmail id" 모양이라 읽기·답장·별표에 계정을 따로 받지 않는다.
// 부하: 사람이 시킬 때만(폴링 없음). 목록 = 계정 표 읽기 1 + 서버 함수 1(Gmail 목록 1 + 메타 최대 30), 읽기 = 계정 표 1 + 서버 함수 1, 답장 초안 = 원문 읽기 1 + 초안 1, 별표 = 1.
import { randomBytes } from 'node:crypto';
import { officeTurn, ONLY_DM, outsideOf, quoted, OUTSIDE_RULE } from './office-audience.mjs';
import { jsonText } from '../inbound-marks.mjs';
import { officeOrigin, DEFAULT_ORIGIN } from './office-files.mjs';

export const mailDeps = {
  session: async () => (await import('./msgr.mjs')).sessionClient(),
  jwt: async () => (await (await import('../devicesession.mjs')).getFreshDeviceSession())?.access_token ?? null,
  fetch: (...a) => fetch(...a),
  origin: () => process.env.ARGO_OFFICE_ORIGIN || DEFAULT_ORIGIN,
  nonce: () => randomBytes(8).toString('hex'), // 바깥 글 경계 — 호출마다 새로(메일 쪽이 미리 알 수 없게)
};

const pick = (ko, en, lang) => (lang === 'en' ? en : ko);
const NAME = { ko: '메일 도구', en: 'mail tool' };
/** 도구가 부르는 오피스 메일 서버 동작과 메서드 — 서버(apps/office/api/mail/[op].js get())는 GET으로 config·read만 받고, 목록·검색(검색어가 주소·접근 기록에 남지 않게)과
 *  바꾸는 동작은 POST 본문으로만 받는다(그 밖의 GET은 405). test/office-mail-tool.test.mjs가 서버 처리기를 직접 불러 이 표가 405 없이 통과하는지 확인한다.
 *  send·draftSend·draftDelete는 없다(크루는 초안까지) */
export const MAIL_CALLS = Object.freeze({ list: 'POST', read: 'GET', draft: 'POST', modify: 'POST' });
const FOLDERS = { inbox: ['받은편지함', 'inbox'], unread: ['안 읽음', 'unread'], starred: ['별표', 'starred'], sent: ['보낸편지함', 'sent'], drafts: ['임시 보관함', 'drafts'], archive: ['보관함', 'archive'] };
const MAIL_ID = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([A-Za-z0-9_-]{1,200})$/i;
export const READ_CAP = 20_000, LIST_CAP = 30;
const one = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const kstTime = (iso) => { const ms = Date.parse(iso); return Number.isFinite(ms) ? new Date(ms + 9 * 3600e3).toISOString().slice(0, 16).replace('T', ' ') : ''; };

const ERRORS = {
  expired: ['메일 계정 연결이 만료됐다 — 오피스 메일 › 계정에서 다시 연결해 달라고 알려라', 'the mail account connection expired — ask the owner to reconnect it in Office mail'],
  no_account: ['그 메일 계정이 없다(연결이 끊겼을 수 있다)', 'that mail account is not connected'],
  rate_limited: ['Gmail 요청 한도에 걸렸다 — 잠시 뒤 다시 하라', 'Gmail rate limit — try again shortly'],
  not_configured: ['오피스의 구글 연결이 설정돼 있지 않다', 'Google is not configured in Office'],
  signed_out: ['오피스 로그인이 만료됐다 — 사장에게 Argo에서 다시 로그인해 달라고 알려라', 'the Office sign-in expired — ask the owner to sign in again in Argo'],
  input: ['입력이 올바르지 않다', 'invalid input'],
  gmail: ['Gmail이 거절했다(메일이 없거나 형식이 맞지 않다)', 'Gmail refused (missing message or bad format)'],
  too_big: ['첨부가 너무 크다', 'attachments are too big'],
  db: ['오피스 DB 호출이 실패했다', 'the Office database call failed'],
  method: ['오피스 서버가 그 호출 방식을 받지 않는다(앱과 오피스 버전이 맞지 않을 수 있다)', 'the Office server does not accept that request method (app and Office versions may differ)'],
};
function errText(code, lang, raw = '', retryAfter = null) {
  const wait = retryAfter ? pick(` (${retryAfter}초 뒤)`, ` (in ${retryAfter}s)`, lang) : '';
  if (ERRORS[code]) return pick(`오피스 메일 거절: ${ERRORS[code][0]}${wait}.`, `Office mail refused: ${ERRORS[code][1]}${wait}.`, lang);
  return pick(`오피스 메일 호출 실패: ${quoted(raw || code || '알 수 없는 오류', 200)}. 사장에게 그대로 알려라.`, `Office mail call failed: ${quoted(raw || code || 'unknown', 200)}. Tell the owner as is.`, lang);
}

/** 메일 HTML → 글자(스크립트·스타일은 버리고 줄바꿈을 남긴다) — 오피스 crew-assign.js htmlText와 같은 취지, 서버에는 DOM이 없어 정규식으로 */
export function htmlText(html) {
  if (!html) return '';
  const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return String(html).replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<img[^>]*>/gi, '').replace(/<[^>]+>/g, '').replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENT[e.toLowerCase()] ?? m))
    .replace(/[ \t ]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
const addresses = (s) => String(s ?? '').split(/[,;]/).map((x) => x.trim()).filter(Boolean);
const validList = (s) => addresses(s).every((x) => /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(x) || /^[^<>]*<[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+>$/.test(x));

/** 오피스 메일 서버 함수(api/mail) — 주인 로그인 JWT로, MAIL_CALLS의 넷만 그 메서드로 */
async function mailApi(op, body, lang) {
  const method = MAIL_CALLS[op];
  if (!method) throw new Error(`mail op not allowed: ${op}`);
  const origin = officeOrigin(mailDeps.origin());
  if (!origin) return { text: pick('오피스 주소(ARGO_OFFICE_ORIGIN)가 https가 아니라 메일을 쓰지 않는다 — 사장에게 알려라.', 'The Office address (ARGO_OFFICE_ORIGIN) is not https, so mail is not used — tell the owner.', lang) };
  const jwt = await mailDeps.jwt().catch(() => null);
  if (!jwt) return { text: pick('메신저(오피스) 로그인이 없어 메일을 쓸 수 없다 — 사장에게 알려라.', 'Not signed in, so mail is unavailable — tell the owner.', lang) };
  const url = method === 'GET' ? `${origin}/api/mail/${op}?${new URLSearchParams(Object.entries(body).filter(([, v]) => v != null && v !== ''))}` : `${origin}/api/mail/${op}`;
  const r = await mailDeps.fetch(url, { method, headers: { authorization: `Bearer ${jwt}`, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) }, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60_000) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) return { text: errText(d.error, lang, `HTTP ${r.status}`, d.retryAfter) };
  return { data: d };
}

export async function mailTool(args, { ctx = null, lang = 'ko', ownerId = null } = {}) {
  const a = args ?? {};
  const turn = await officeTurn({ ctx, ownerId, lang, session: mailDeps.session, name: NAME, personal: true }); // 개인 공간(조직 없음) 1:1도 — 주인 혼자인지는 아래 owner로
  if (turn.text) return turn.text;
  const { c, owner } = turn;
  if (!owner) return pick(`메일은 주인의 개인 메일함이라 ${ONLY_DM(lang)} 다룬다 — 여럿이 보는 방에 메일 제목·본문이 올라가지 않게. 주인에게 1:1로 부탁해 달라고 알려라.`, `Mail is the owner's personal mailbox, so it is handled ${ONLY_DM(lang)} — mail is not posted where others read. Ask the owner to request it in a 1:1.`, lang);
  try {
    const { data: accounts, error } = await c.client.from('office_mail_accounts').select('id, address, display_name, status').order('created_at');
    if (error) return errText('db', lang);
    if (!accounts?.length) return pick('주인의 메일 계정이 오피스에 연결돼 있지 않다 — 오피스 메일에서 Gmail을 연결해 달라고 알려라.', 'No mail account is connected in Office — ask the owner to connect Gmail in Office mail.', lang);
    const accountList = accounts.map((x) => `${jsonText(x.address)}${x.status !== 'ok' ? pick('(다시 연결 필요)', ' (reconnect needed)', lang) : ''}`).join(', ');
    const byArg = (v) => accounts.find((x) => x.id === v || x.address.toLowerCase() === String(v).trim().toLowerCase());
    const choose = () => (a.account ? byArg(a.account) : accounts.find((x) => x.status === 'ok') ?? accounts[0]);
    const usable = (acc) => (acc.status === 'ok' ? null : errText('expired', lang));
    // 메일 id("계정id.Gmail id") → { acc, gid } | { text }
    const target = (id) => {
      const m = MAIL_ID.exec(String(id ?? ''));
      if (!m) return { text: pick('id는 mails가 보여 준 메일 id(계정id.메일id)다.', 'id must be a mail id shown by mails (account.message).', lang) };
      const acc = accounts.find((x) => x.id.toLowerCase() === m[1].toLowerCase());
      if (!acc) return { text: errText('no_account', lang) };
      return usable(acc) ? { text: usable(acc) } : { acc, gid: m[2] };
    };

    if (a.action === 'mails') {
      const acc = choose();
      if (!acc) return pick(`그 계정이 없다. 연결된 계정: ${accountList}`, `No such account. Connected: ${accountList}`, lang);
      if (usable(acc)) return usable(acc);
      const folder = FOLDERS[a.folder] ? a.folder : 'inbox';
      const q = one(a.q).slice(0, 300);
      const r = await mailApi('list', { account: acc.id, folder, ...(q ? { q } : {}) }, lang);
      if (r.text) return r.text;
      const list = r.data?.items ?? [];
      const where = `${jsonText(acc.address)} · ${q ? pick(`검색 ${jsonText(q)}`, `search ${jsonText(q)}`, lang) : FOLDERS[folder][lang === 'en' ? 1 : 0]}`;
      const others = accounts.length > 1 ? pick(`\n연결된 다른 계정: ${accounts.filter((x) => x.id !== acc.id).map((x) => jsonText(x.address)).join(', ')} — account로 고른다.`, `\nOther accounts: ${accounts.filter((x) => x.id !== acc.id).map((x) => jsonText(x.address)).join(', ')} — pick with account.`, lang) : '';
      if (!list.length) return pick(`메일이 없다(${where}).${others}`, `No mail (${where}).${others}`, lang);
      const ox = outsideOf('mail', lang, mailDeps.nonce());
      return [pick(`메일 ${list.length}통(${where}${r.data.next ? ' · 더 있음 — q로 좁혀라' : ''}):`, `${list.length} messages (${where}${r.data.next ? ' · more — narrow with q' : ''}):`, lang),
        ox.block(list.slice(0, LIST_CAP).map((m) => {
          const from = one(m.from).slice(0, 200), addr = one(m.addr).slice(0, 200); // 비교용(JSON으로 감싸기 전의 값) — 보내는 사람 칸은 200자까지
          return `- ${kstTime(m.at)} · ${ox.lineOr(from, '') || ox.line(addr)}${addr && addr !== from ? ` · ${pick('주소', 'address', lang)} ${ox.line(addr)}` : ''} · ${ox.lineOr(m.subject, pick('(제목 없음)', '(no subject)', lang), 500)}${m.unread ? pick(' · 안 읽음', ' · unread', lang) : ''}${m.starred ? pick(' · 별표', ' · starred', lang) : ''}${m.draftId ? pick(' · 초안', ' · draft', lang) : ''} · id=${ox.id(m.id)}${m.snippet ? `\n  ${ox.line(String(m.snippet).slice(0, 120))}` : ''}`;
        }),
          ['메일 쪽이 쓴 보낸 사람·제목·요약', 'senders, subjects and previews written by others']),
        pick('본문은 mail_read에 id, 답장 초안은 mail_draft에 reply_to=id.', 'Use mail_read with the id for the body; mail_draft with reply_to=id for a reply draft.', lang) + others].join('\n');
    }

    if (a.action === 'mail_read') {
      const t = target(a.id);
      if (t.text) return t.text;
      const r = await mailApi('read', { account: t.acc.id, id: t.gid }, lang);
      if (r.text) return r.text;
      const m = r.data;
      // 메일은 바깥 사람이 쓴 글이다 — 호출마다 새 번호의 경계 블록으로 감싸고, 안의 값은 JSON 문자열로 싣는다(office-audience.mjs outsideOf, inbound-marks.mjs 머리말)
      const ox = outsideOf('mail', lang, mailDeps.nonce());
      const rawBody = String(m.text || htmlText(m.html) || '').trim(); // 길이 상한은 원문 글자 수(READ_CAP)와 이스케이프 뒤 글자 예산 둘 다 — 제어 문자 본문이 6배로 커져 끝 줄이 잘리지 않게(검수 3차 M-A)
      const atts = (m.attachments ?? []).slice(0, 50);
      const head = [`${pick('제목', 'Subject', lang)}: ${ox.lineOr(m.subject, pick('(제목 없음)', '(no subject)', lang), 500)}`, `${pick('보낸 사람', 'From', lang)}: ${ox.line(m.from, 300)}${m.addr ? ` ${pick('주소', 'address', lang)} ${ox.line(m.addr, 300)}` : ''}`,
        `${pick('받는 사람', 'To', lang)}: ${ox.line(m.to, 1000)}`, ...(m.cc ? [`${pick('참조', 'Cc', lang)}: ${ox.line(m.cc, 1000)}`] : []),
        ...(atts.length ? [`${pick('첨부', 'Attachments', lang)}: ${atts.map((x) => ox.line(x.name, 200)).join(', ')}${(m.attachments ?? []).length > atts.length ? pick(` …외 ${m.attachments.length - atts.length}개`, ` …and ${m.attachments.length - atts.length} more`, lang) : ''}`] : [])];
      const body = rawBody ? ox.body(rawBody, { chars: READ_CAP, max: ox.room(head) }) : null;
      return [`${pick('메일', 'Mail', lang)} id=${t.acc.id}.${t.gid} · ${jsonText(t.acc.address)} · ${kstTime(m.at)} (KST)`,
        ox.block([...head, '', ...(body ? [body.json, ...(body.cut ? [pick(`…(앞 ${body.kept}자만)`, `…(first ${body.kept} chars)`, lang)] : [])] : [pick('(본문 없음)', '(empty)', lang)])],
          ['메일 원문', 'mail content'])].join('\n');
    }

    if (a.action === 'mail_draft') {
      const text = String(a.text ?? '');
      if (!text.trim()) return pick('mail_draft에는 text(본문)가 필요하다.', 'mail_draft needs text (the body).', lang);
      if (text.length > 50_000) return pick('본문은 50,000자까지.', 'The body is limited to 50,000 chars.', lang);
      let acc, thread = {}, to = one(a.to), subject = one(a.subject), fromMail = false; // fromMail = 받는 사람·제목을 답장 원문(바깥 글)에서 가져왔다
      if (a.reply_to) {
        const t = target(a.reply_to);
        if (t.text) return t.text;
        const r = await mailApi('read', { account: t.acc.id, id: t.gid }, lang);
        if (r.text) return r.text;
        const m = r.data;
        acc = t.acc;
        thread = { threadId: m.threadId, ...(m.messageId ? { inReplyTo: m.messageId, references: [m.references, m.messageId].filter(Boolean).join(' ') } : {}) }; // 같은 스레드의 답장으로 잇는다
        if (!to) { to = (m.addr && m.addr.toLowerCase() !== acc.address.toLowerCase() ? m.addr : m.to) || ''; fromMail = true; } // 주인이 보낸 메일에 이어 쓰면 원래 받는 사람에게
        if (!subject) { subject = /^re:/i.test(m.subject ?? '') ? m.subject : `Re: ${m.subject ?? ''}`.trim(); fromMail = true; }
      } else {
        acc = choose();
        if (!acc) return pick(`그 계정이 없다. 연결된 계정: ${accountList}`, `No such account. Connected: ${accountList}`, lang);
        if (usable(acc)) return usable(acc);
      }
      if (!to) return pick('mail_draft에는 to(받는 사람)가 필요하다(답장이면 reply_to).', 'mail_draft needs to (or reply_to for a reply).', lang);
      const cc = one(a.cc);
      if (!validList(to) || (cc && !validList(cc)) || to.length > 2000 || cc.length > 2000) return pick('to·cc는 메일 주소(여럿이면 쉼표로)여야 한다.', 'to/cc must be email addresses (comma-separated).', lang);
      if (subject.length > 300) return pick('제목은 300자까지.', 'The subject is limited to 300 chars.', lang);
      const r = await mailApi('draft', { account: acc.id, to, ...(cc ? { cc } : {}), subject, text, ...thread }, lang); // draftId를 주지 않는다 = 언제나 새 초안
      if (r.text) return r.text;
      // 확인 문장도 모델이 읽는 도구 결과다(검수 #fix-cross M2) — 답장은 받는 사람·제목을 원문(바깥 글)에서 가져오니 경계 블록 안에, 내가 준 값은 한 줄로 펴서 표지 흉내를 바꿔 쓴다.
      // 서버로 보낸 값(위 draft 호출)은 그대로다 — 여기서 바꾸는 것은 모델에게 되돌리는 글뿐
      const ox = outsideOf('mail', lang, mailDeps.nonce());
      const echo = pick(`받는 사람 ${ox.line(to)} · 제목 ${ox.lineOr(subject, '(제목 없음)')}`, `to ${ox.line(to)} · subject ${ox.lineOr(subject, '(no subject)')}`, lang);
      const saved = pick(`초안을 임시 보관함에 저장했다(보내지 않았다 — 주인이 오피스 메일에서 검토하고 보낸다)`, `Saved a draft (not sent — the owner reviews and sends it in Office mail)`, lang);
      const tail = `${jsonText(acc.address)}${thread.threadId ? pick(' · 답장', ' · reply', lang) : ''} (${pick('초안', 'draft', lang)} id=${r.data?.draftId == null ? '?' : ox.id(r.data.draftId)})`;
      return fromMail ? `${saved} · ${tail}:\n${ox.block([echo], ['받는 사람·제목은 답장 원문에서 가져온 바깥 글', 'recipient and subject taken from the original mail (written by others)'])}` : `${saved}: ${echo} · ${tail}`;
    }

    if (a.action === 'mail_star') {
      const t = target(a.id);
      if (t.text) return t.text;
      const on = a.starred !== false;
      const r = await mailApi('modify', { account: t.acc.id, id: t.gid, add: on ? ['STARRED'] : [], remove: on ? [] : ['STARRED'] }, lang);
      if (r.text) return r.text;
      return on ? pick('별표를 달았다.', 'Starred.', lang) : pick('별표를 뗐다.', 'Unstarred.', lang);
    }

    return pick('action은 mails·mail_read·mail_draft·mail_star 중 하나다(보내기는 없다 — 크루는 초안까지).', 'action must be mails, mail_read, mail_draft or mail_star (no sending — crews stop at drafts).', lang);
  } catch (e) {
    return errText(null, lang, String(e?.message ?? e));
  }
}

export function mailDescription(lang = 'ko') {
  return lang === 'en'
    ? 'The owner\'s mail connected in Argo Office (Gmail), only in a 1:1 chat with the owner. action=mails lists messages with id (folder inbox|unread|starred|sent|drafts|archive, or q = Gmail search such as "from:kim@x.com invoice"; account = address when several are connected). mail_read returns one message (id). mail_draft saves a NEW draft in the Gmail drafts folder — it never sends: to, cc, subject, text (plain text); reply_to = a mail id makes a reply in that thread (to and subject default to the original). mail_star stars a message (id, starred=false removes). There is no sending: tell the owner the draft is ready for review in Office mail. ' + OUTSIDE_RULE('en')
    : '아르고 오피스에 연결한 주인의 메일(Gmail) — 주인과의 1:1 대화에서만. action=mails는 메일 목록(id 포함, folder inbox|unread|starred|sent|drafts|archive 또는 q = Gmail 검색어 예: "from:kim@x.com 세금계산서", 계정이 여럿이면 account에 주소). mail_read는 한 통 읽기(id). mail_draft는 Gmail 임시 보관함에 새 초안을 저장한다 — 보내지 않는다: to, cc, subject, text(글자 본문), reply_to에 메일 id를 주면 그 스레드의 답장 초안(받는 사람·제목은 원문에서). mail_star는 별표 달기(id, starred=false면 떼기). 보내기는 없다 — 초안을 만들었으면 주인이 오피스 메일에서 검토하고 보내면 된다고 알려라. ' + OUTSIDE_RULE('ko');
}
