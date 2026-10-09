// 능동 비서 — 글 만들기(템플릿)와 배달. 받는 곳은 개인 공간 1:1 방(msgr_dm_personal_crew)**만**이다(설계 12절):
// 조직 1:1 경로는 보관한 방 대신 새 방을 만들고, 조직 채널의 에이전트 글은 자격 트리거가 'nt:' 접두만 빼 주므로 'as:' 글은 자격이 끝난 조직에서 거절된다.
// 같은 항목은 서버에서 한 번만 — client_msg_id = as:<에이전트 메신저 id>:<기준 문자열 sha256 앞 32자>(유니크: 채널·작성자 종류·작성자·client_msg_id).
// 시작 전 알림·묶음은 기준이 키 하나라 두 기기가 같은 항목을 보내도 DB에 한 번만 들어간다(설계 7절).
import { createHash } from 'node:crypto';
import { at, dateLabel } from './text.mjs';
import { hhmmIn, dateIn, addDays } from './rules.mjs';
import { preKey, eveKey, dayKey } from './calendar.mjs';

export const MSG_MAX = 20_000;   // msgr_messages.body check 제약과 같다(gateway/msgr.mjs MSG_MAX)
export const SECTION_MAX = 30;   // 한 칸에 보이는 줄 상한 — 넘으면 "…외 N건"
export const META_ITEMS_MAX = 200;

export const clientMsgId = (crewId, basis) => `as:${crewId}:${createHash('sha256').update(String(basis)).digest('hex').slice(0, 32)}`;

const coded = (code, message) => Object.assign(new Error(message), { code });

/** 비서 에이전트의 개인 공간 행과 그 1:1 방 — { crewId, channelId }. 개인 행(조직 없음·활성)이 없거나 방 RPC가 실패하면 던진다(code 'personal_room_unavailable').
    조직 1:1 방으로 물러나지 않는다. myCrews는 이 회사의 내 활성 행(개인·조직)이다(gateway/msgr.mjs makeDb). */
export async function personalRoom(c, wsId, slug) {
  const rows = await c.db.myCrews(c.uid, wsId);
  const crew = (rows ?? []).find((r) => r.org_id == null && r.slug === slug);
  if (!crew) throw coded('personal_room_unavailable', `no personal messenger row for ${slug}`);
  const { data, error } = await c.client.rpc('msgr_dm_personal_crew', { crew: crew.id });
  if (error || !data) throw coded('personal_room_unavailable', String(error?.message ?? 'msgr_dm_personal_crew: no room'));
  return { crewId: crew.id, channelId: data };
}

/** 글 넣기 — 'sent' | 'dup'. dup = 같은 client_msg_id가 이미 있다(같은 기기의 응답만 끊긴 재시도, 또는 다른 기기가 같은 항목을 먼저 넣음 — 23505를 insertMessage가 null로 돌려준다).
    그 밖 실패는 던진다. */
export async function insertNotice(c, room, ob) {
  const row = {
    channel_id: room.channelId, author_kind: 'crew', crew_id: room.crewId, kind: 'text', reply_to: null, thread_root: null,
    client_msg_id: clientMsgId(room.crewId, ob.basis), body: String(ob.body).slice(0, MSG_MAX), mentions: [],
    meta: { disposition: 'done', notification: 'assistant', assistant: ob.meta },
  };
  return (await c.db.insertMessage(row)) ? 'sent' : 'dup';
}

/* ── 글 만들기(템플릿) ── */
const timeOf = (o, ctx) => {
  const t = hhmmIn(o.start, ctx.tz);
  const d = dateIn(o.start, ctx.tz);
  return d === ctx.date ? t : `${d.slice(5).replace('-', '/')} ${t}`; // 다른 날 회차는 날짜를 붙인다(밤사이 지난 일정 등)
};
function line(o, ctx, { mins = null } = {}) {
  const title = o.title || at('line.untitled', ctx.lang);
  let s = o.allDay ? `· ${at('line.allDay', ctx.lang)} ${title}` : `· ${timeOf(o, ctx)} ${title}`;
  if (mins != null) s += ` — ${at('line.inMin', ctx.lang, { n: mins })}`;
  if (o.location) s += ` · ${at('line.place', ctx.lang, { v: o.location })}`;
  return s;
}
function section(title, rows, ctx) {
  if (!rows.length) return null;
  const shown = rows.slice(0, SECTION_MAX);
  const more = rows.length - shown.length;
  return [title, ...shown, ...(more > 0 ? [at('line.more', ctx.lang, { n: more })] : [])].join('\n');
}
const minsLeft = (o, now) => Math.max(1, Math.round((o.start - now) / 60_000));
const metaItem = (key, o) => ({ key, source: 'calendar', eventId: o.id, at: new Date(o.start).toISOString() });

/** capTail = 하루 즉시 알림 상한(설계 9절) — 상한에 처음 걸린 글이면 그 수, 아니면 0. 끝에 한 줄을 붙인다(그 글 하나만 — tick.mjs send가 정한다). */
const prebody = (o, now, ctx, capTail = 0) => `${at('head.pre', ctx.lang)}\n${line(o, ctx, { mins: minsLeft(o, now) })}${capTail ? `\n${at('tail.cap', ctx.lang, { n: capTail })}` : ''}`;
/** 대기열의 시작 전 알림 본문을 보내는 순간 기준으로 다시 쓴다 — 템플릿이라 비용이 없고, client_msg_id(기준 = 키)는 그대로라 응답만 끊겼던 첫 시도와 겹쳐도
    DB에 한 번만 들어간다. 대기열에 오래 머문 글이 "30분 뒤 시작"을 8분 전에 보내지 않게. 다시 보내기 전 확인 읽기가 바꾼 제목·장소(ob.occ)와
    하루 상한 꼬리(ob.capTail)도 여기서 반영된다. (3단계 LLM 머리말이 붙는 글은 같은 본문을 다시 보낸다 — 작성 턴 재호출 0) */
export const refreshPreBody = (ob, { now, lang = 'ko', tz = null }) => (ob?.kind === 'pre' && ob.occ ? prebody(ob.occ, now, { lang, tz, date: dateIn(now, tz) }, ob.capTail) : ob?.body);

/** 시작 전 알림 한 건(설계 7절: 일정 시작 전 알림은 늘 혼자 보낸다 — client_msg_id 기준 = 그 키 하나). */
export function composePre(o, { now, lang = 'ko', tz = null }) {
  const ctx = { lang, tz, date: dateIn(now, tz) };
  const key = preKey(o);
  return {
    kind: 'pre', basis: key, keys: [key], until: o.start, // until — 시작이 지나면 "N분 뒤 시작"이 거짓이 되므로 대기열에서 다시 보내지 않는다(tick.mjs)
    occ: { id: o.id, title: o.title, location: o.location, allDay: false, start: o.start }, // 다시 보낼 때 "N분 뒤"를 보내는 순간 기준으로 다시 쓴다(prebody)
    body: prebody(o, now, ctx),
    meta: { v: 1, kind: 'pre', keys: [key], items: [metaItem(key, o)] },
    items: [{ key, source: 'calendar', reason: 'gap', eventId: o.id, start: o.start, title: o.title, location: o.location }],
  };
}

/** 아침·저녁 묶음 — 새 항목이 하나도 없으면 null(개수 줄만으로는 보내지 않는다 — 설계 5.3).
    parts = { allDay: [회차](오늘 종일, 아침), tomorrow: [회차](내일, 저녁), pending: [보류 항목](지난 일정) }.
    곧 시작할 일정은 넣지 않는다 — 시작 전 알림은 묶음 차례에도 혼자 보낸다(설계 7절: 기준 = 키 하나라 두 기기·상태 없는 새 리더가 보내도 DB가 한 번만 넣고,
    묶음이 대기열에 머물러도 거짓 "N분 뒤 시작"이 생기지 않는다 — #863 분리 검수). items = 넣은 보류 항목(기한이 지나 버릴 때 보류 목록으로 되돌린다). */
export function composeBundle(slot, parts, { lang = 'ko', tz = null }) {
  const ctx = { lang, tz, date: slot.date };
  const allDay = parts.allDay ?? []; const tomorrow = parts.tomorrow ?? []; const pending = parts.pending ?? [];
  const mail = typeof parts.mail === 'string' && parts.mail ? parts.mail : null; // 메일 저녁 몫(src/assistant/mail.mjs takeSummary — 이미 만든 글)
  if (!allDay.length && !tomorrow.length && !pending.length && !mail) return null;
  const quiet = pending.filter((p) => p.reason === 'quiet'); const gap = pending.filter((p) => p.reason !== 'quiet');
  const asOcc = (p) => ({ id: p.eventId, title: p.title, location: p.location, allDay: false, start: p.start });
  const next = slot.lane === 'pm' ? addDays(slot.date, 1) : null;
  const blocks = [
    section(at('sec.allDay', lang), allDay.map((o) => line(o, ctx)), ctx),
    section(at('sec.missedQuiet', lang), quiet.map((p) => line(asOcc(p), ctx)), ctx),
    section(at('sec.missedGap', lang), gap.map((p) => line(asOcc(p), ctx)), ctx),
    section(at('sec.tomorrow', lang, { n: tomorrow.length, date: next ? dateLabel(next, lang) : '' }), tomorrow.map((o) => line(o, { ...ctx, date: next })), ctx),
    mail,
  ].filter(Boolean);
  const itemKeys = [
    ...allDay.map((o) => [dayKey(o, slot.date), o]),
    ...pending.map((p) => [p.key, asOcc(p)]),
    ...tomorrow.map((o) => [eveKey(o, next), o]),
  ];
  const keys = [slot.key, ...itemKeys.map(([k]) => k)];
  return {
    kind: slot.lane, basis: slot.key, keys,
    body: `${at(slot.lane === 'am' ? 'head.am' : 'head.pm', lang, { date: dateLabel(slot.date, lang) })}\n\n${blocks.join('\n\n')}`,
    // 메일 줄(보낸 사람·제목)이 든 정리 글은 바깥 글 표지 — 다음 대화 턴의 방 문맥에는 표지 줄로만(설계 4.9 규칙 2)
    meta: { v: 1, kind: slot.lane, keys: keys.slice(0, META_ITEMS_MAX), items: itemKeys.slice(0, META_ITEMS_MAX).map(([k, o]) => metaItem(k, o)), ...(mail ? { outside: true } : {}) },
    items: pending,
  };
}
