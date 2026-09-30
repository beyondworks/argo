// 에이전트 일정 도구(calendar) — 아르고 오피스 일정 표(office_events)를 주인의 기기 세션으로 읽고 쓴다(명세 2026-09-30 규칙 9·10).
// 다룰 수 있는 것은 **주인의 일정**뿐: 개인 일정과 조직에 있는 주인 소유 일정. 남이 주인인 일정은 목록에서 읽기만 한다.
// 서버(office_event_write)도 p_data.crew가 있으면 주인만 고치게 막지만, 도구가 먼저 거절해 헛호출을 만들지 않는다.
// 손님 턴 거절은 chat.mjs 처리기(guestNo)가 이 함수보다 먼저 한다.
import { randomUUID } from 'node:crypto';

const KST = 9 * 3600_000;
const DAY = 86_400_000;
export const LIST_MAX_DAYS = 62;
const LINE_CAP = 80;

// 테스트가 바꿔 끼우는 자리 — 기본은 메신저 기기 세션(msgr.mjs는 chat.mjs를 부르므로 호출 시점에 동적으로 불러 순환을 피한다)
export const calendarDeps = {
  session: async () => (await import('./msgr.mjs')).sessionClient(),
  now: () => Date.now(),
  newId: () => randomUUID(),
};

const pick = (ko, en, lang) => (lang === 'en' ? en : ko);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_RE = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(:\d{2}(\.\d+)?)?$/;
const TZ_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i;
const TIME_RE = /^(\d{1,2}):(\d{2})$/;

export const kstDateOf = (ms) => new Date(ms + KST).toISOString().slice(0, 10);
/** KST 날짜의 자정(ms). 없는 날짜(2026-02-30 등)는 NaN. */
export function kstMidnight(date) {
  if (!DATE_RE.test(String(date ?? ''))) return NaN;
  const ms = Date.parse(`${date}T00:00:00+09:00`);
  return Number.isFinite(ms) && kstDateOf(ms) === date ? ms : NaN;
}
export const addDays = (date, n) => kstDateOf(kstMidnight(date) + n * DAY);
const daysBetween = (a, b) => Math.round((kstMidnight(b) - kstMidnight(a)) / DAY);

/** 에이전트가 준 시각 한 개 → { date } | { ms } | { time:[h,m] } | null. 시간대 없는 날짜·시각은 KST로 읽는다. */
export function parseWhen(s) {
  const v = String(s ?? '').trim();
  if (DATE_RE.test(v)) return Number.isFinite(kstMidnight(v)) ? { date: v } : null;
  const local = LOCAL_RE.exec(v);
  if (local) { const ms = Date.parse(`${local[1]}T${local[2]}${local[3] ?? ''}+09:00`); return Number.isFinite(ms) && Number.isFinite(kstMidnight(local[1])) ? { ms } : null; }
  if (TZ_RE.test(v)) { const ms = Date.parse(v); return Number.isFinite(ms) ? { ms } : null; }
  const t = TIME_RE.exec(v);
  if (t && +t[1] < 24 && +t[2] < 60) return { time: [+t[1], +t[2]] };
  return null;
}

/** rrule 문자열(서버 check와 같은 모양) ↔ { freq, interval, until } */
export function parseRrule(r) {
  const m = /^FREQ=(DAILY|WEEKLY|MONTHLY)(?:;INTERVAL=(\d{1,2}))?(?:;UNTIL=(\d{4})(\d{2})(\d{2}))?$/.exec(String(r ?? ''));
  return m ? { freq: m[1], interval: m[2] ? +m[2] : 1, until: m[3] ? `${m[3]}-${m[4]}-${m[5]}` : null } : null;
}
export function buildRrule(freq, interval = 1, until = null) {
  return `FREQ=${freq.toUpperCase()}${interval > 1 ? `;INTERVAL=${interval}` : ''}${until ? `;UNTIL=${until.replaceAll('-', '')}` : ''}`;
}

/** 한 일정의 [fromMs, toMs) 안 회차들 — 반복은 명세대로 펼친다(매주=시작 요일, 매월=시작 날짜·없는 달은 건너뜀, UNTIL 포함, exdates 제외). */
export function occurrences(ev, fromMs, toMs) {
  const start = Date.parse(ev.starts_at); const dur = Date.parse(ev.ends_at) - start;
  const rr = ev.rrule ? parseRrule(ev.rrule) : null;
  if (!rr) return start < toMs && start + dur > fromMs ? [{ start, end: start + dur, day: kstDateOf(start) }] : [];
  const d0 = kstDateOf(start); const [y0, m0, dd] = d0.split('-').map(Number);
  const ex = new Set((ev.exdates ?? []).map(String));
  const step = rr.freq === 'DAILY' ? rr.interval : rr.freq === 'WEEKLY' ? 7 * rr.interval : 0;
  const out = [];
  // 매일·매주는 범위 앞까지 건너뛴다(몇 년 전에 시작한 매일 일정도 반복 횟수가 범위 크기에 묶인다)
  let k = step ? Math.max(0, Math.floor((fromMs - dur - start) / (step * DAY)) - 1) : 0;
  for (let guard = 0; guard < 4000; guard++, k++) {
    let day;
    if (step) day = addDays(d0, k * step);
    else {
      const total = y0 * 12 + (m0 - 1) + k * rr.interval; const yy = Math.floor(total / 12); const mm = (total % 12) + 1;
      if (dd > new Date(Date.UTC(yy, mm, 0)).getUTCDate()) { if (kstMidnight(`${yy}-${String(mm).padStart(2, '0')}-01`) >= toMs) break; continue; }
      day = `${yy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
    }
    if (rr.until && day > rr.until) break;
    const s = start + (kstMidnight(day) - kstMidnight(d0));
    if (s >= toMs) break;
    if (s + dur > fromMs && !ex.has(day)) out.push({ start: s, end: s + dur, day });
  }
  return out;
}

const DOW = { ko: ['일', '월', '화', '수', '목', '금', '토'], en: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] };
const dayLabel = (date, lang) => `${date}(${DOW[lang === 'en' ? 'en' : 'ko'][new Date(`${date}T00:00:00Z`).getUTCDay()]})`;
const hhmm = (ms) => new Date(ms + KST).toISOString().slice(11, 16);

function whenText(occ, allDay, lang) {
  const d1 = kstDateOf(occ.start);
  if (allDay) {
    const last = kstDateOf(occ.end - 1);
    return `${dayLabel(d1, lang)}${last !== d1 ? `~${dayLabel(last, lang)}` : ''} ${pick('종일', 'all day', lang)}`;
  }
  const d2 = kstDateOf(occ.end);
  return `${dayLabel(d1, lang)} ${hhmm(occ.start)}–${d2 !== d1 ? `${d2.slice(5)} ` : ''}${hhmm(occ.end)}`;
}
function repeatText(rrule, lang) {
  const rr = parseRrule(rrule); if (!rr) return '';
  const unit = { DAILY: pick('매일', 'daily', lang), WEEKLY: pick('매주', 'weekly', lang), MONTHLY: pick('매월', 'monthly', lang) }[rr.freq];
  const every = rr.interval > 1 ? pick(`(${rr.interval}${rr.freq === 'DAILY' ? '일' : rr.freq === 'WEEKLY' ? '주' : '개월'} 간격)`, ` (every ${rr.interval})`, lang) : '';
  return `${pick('반복', 'repeats', lang)} ${unit}${every}${rr.until ? pick(` ~${rr.until}`, ` until ${rr.until}`, lang) : ''}`;
}
/** 한 줄 — KST 날짜·시간, 제목, 캘린더, 반복, 편집 가능 여부, id(+회차 날짜). */
export function eventLine(ev, occ, { uid, orgs = [], lang = 'ko' } = {}) {
  const o = occ ?? { start: Date.parse(ev.starts_at), end: Date.parse(ev.ends_at), day: kstDateOf(Date.parse(ev.starts_at)) };
  const org = ev.org_id ? orgs.find((x) => x.id === ev.org_id) : null;
  const cal = ev.org_id ? `${pick('조직', 'org', lang)} ${org?.name ?? ev.org_id}${ev.visibility === 'private' ? pick('(나만)', ' (only me)', lang) : ''}` : pick('개인', 'personal', lang);
  const bits = [whenText(o, ev.all_day, lang), ev.title, cal];
  if (ev.location) bits.push(`${pick('장소', 'at', lang)} ${ev.location}`);
  if (ev.rrule) bits.push(repeatText(ev.rrule, lang));
  if (ev.owner !== uid) bits.push(pick(`읽기 전용(주인 ${ev.owner_name ?? '다른 사람'})`, `read-only (owner ${ev.owner_name ?? 'someone else'})`, lang));
  bits.push(`id=${ev.id}${ev.rrule ? pick(` 회차=${o.day}`, ` occurrence=${o.day}`, lang) : ''}`);
  return `- ${bits.join(' · ')}`;
}

const ERRORS = {
  calendar_forbidden: ['권한이 없다(주인의 일정만 고칠 수 있다)', 'not allowed (only the owner\'s own events can be changed)'],
  calendar_invalid: ['입력이 올바르지 않다(제목 1~200자, 끝이 시작보다 뒤, 참석자는 조직 멤버 등)', 'invalid input (title 1-200 chars, end after start, attendees must be org members, etc.)'],
  calendar_not_found: ['그 일정을 찾지 못했다', 'event not found'],
  calendar_limit: ['올해 일정 생성 한도(5,000건)에 걸렸다', 'the yearly event limit (5,000) was reached'],
};
function rpcError(error, lang) {
  const msg = String(error?.message ?? error ?? '');
  const code = Object.keys(ERRORS).find((c) => msg.includes(c));
  if (code) return pick(`일정 서버 거절: ${ERRORS[code][0]}.`, `Calendar server refused: ${ERRORS[code][1]}.`, lang);
  return pick(`일정 서버 호출 실패: ${msg.slice(0, 200) || '알 수 없는 오류'}. 사장에게 그대로 알려라.`, `Calendar call failed: ${msg.slice(0, 200) || 'unknown error'}. Tell the owner as is.`, lang);
}
// 호출 이름은 글자 그대로 둔다 — 크루 계약 레지스트리(test/crew-contract.test.mjs)가 src/gateway의 rpc('…')를 찾아 분류를 강제한다
function unwrap({ data, error }) {
  if (error) throw Object.assign(new Error(error.message ?? String(error)), { rpc: true, cause: error });
  return data;
}
const writeEvent = async (c, p_action, p_data) => unwrap(await c.client.rpc('office_event_write', { p_action, p_data }));

/** 이 턴에서 다룰 수 있는 일정인가 — 메신저 조직 턴이면 다른 조직 일정은 섞지 않는다(그 조직 채널로 남의 조직 내용이 새지 않게). */
const inTurnScope = (ev, ctx) => (ctx?.kind === 'msgr' ? !ev.org_id || ev.org_id === ctx.orgId : true);

async function listRange(c, fromDate, toDateExcl) {
  const data = unwrap(await c.client.rpc('office_event_list', { p_from: new Date(kstMidnight(fromDate)).toISOString(), p_to: new Date(kstMidnight(toDateExcl)).toISOString() }));
  return { events: Array.isArray(data?.events) ? data.events : [], orgs: Array.isArray(data?.orgs) ? data.orgs : [] };
}

/** 시간 인자(start·end·all_day)를 기준 회차(base) 위에 적용 → { allDay, start, end } | { error } */
export function resolveTimes({ start, end, all_day: allDayArg }, base, lang = 'ko') {
  const s = start != null && start !== '' ? parseWhen(start) : null;
  const e = end != null && end !== '' ? parseWhen(end) : null;
  if ((start && !s) || (end && !e)) return { error: pick('시각 형식을 읽지 못했다 — YYYY-MM-DD, YYYY-MM-DDTHH:MM(한국 시간), 시간대 포함 ISO, 또는 끝 시각만 HH:MM.', 'Could not read the time — use YYYY-MM-DD, YYYY-MM-DDTHH:MM (Korea time), ISO with a time zone, or HH:MM for the end only.', lang) };
  if (s?.time) return { error: pick('start에는 날짜가 있어야 한다.', 'start needs a date.', lang) };
  const allDay = typeof allDayArg === 'boolean' ? allDayArg : s ? !!s.date : base.allDay;
  if (allDay) {
    const firstOf = (w) => (w.date ?? (w.ms != null ? kstDateOf(w.ms) : null));
    const first = s ? firstOf(s) : kstDateOf(base.start);
    const spanDays = base.allDay ? Math.max(1, Math.round((base.end - base.start) / DAY)) : 1;
    const last = e ? firstOf(e) : s ? addDays(first, spanDays - 1) : kstDateOf(base.end - 1);
    if (!first || !last) return { error: pick('종일 일정의 끝은 날짜로 줘라.', 'Give the end of an all-day event as a date.', lang) };
    if (last < first) return { error: pick('끝날이 첫날보다 앞이다.', 'The last day is before the first day.', lang) };
    return { allDay: true, start: kstMidnight(first), end: kstMidnight(addDays(last, 1)) }; // KST 자정 [첫날, 끝날 다음날)
  }
  let st;
  if (s) st = s.ms ?? kstMidnight(s.date) + 9 * 3600_000; // 날짜만 주고 시간 일정이라 하면 09:00
  else if (base.allDay) return { error: pick('시간 일정으로 바꾸려면 start에 시각을 줘라.', 'Give a start time to make it a timed event.', lang) };
  else st = base.start;
  let en;
  if (e?.time) en = kstMidnight(kstDateOf(st)) + (e.time[0] * 60 + e.time[1]) * 60_000;
  else if (e?.date) return { error: pick('시간 일정의 끝은 시각까지 줘라.', 'Give the end of a timed event with a time.', lang) };
  else if (e) en = e.ms;
  else en = st + (base.allDay ? 3600_000 : Math.max(60_000, base.end - base.start));
  if (!(en > st)) return { error: pick('끝이 시작보다 뒤여야 한다.', 'The end must be after the start.', lang) };
  return { allDay: false, start: st, end: en };
}

/** 반복 인자 → rrule(문자열·null) | undefined(바꾸지 않음) | { error } */
function resolveRepeat({ repeat, repeat_interval: iv, repeat_until: until }, lang) {
  if (repeat == null) return iv != null || until != null ? { error: pick('반복 간격·종료일을 바꾸려면 repeat도 함께 줘라.', 'Give repeat together with repeat_interval / repeat_until.', lang) } : undefined;
  if (repeat === 'none') return null;
  const n = iv == null ? 1 : Number(iv);
  if (!Number.isInteger(n) || n < 1 || n > 99) return { error: pick('repeat_interval은 1~99.', 'repeat_interval must be 1-99.', lang) };
  if (until != null && !Number.isFinite(kstMidnight(until))) return { error: pick('repeat_until은 YYYY-MM-DD.', 'repeat_until must be YYYY-MM-DD.', lang) };
  return buildRrule(repeat, n, until ?? null);
}

/** 쓰기 p_data — 명세의 save 필드 전체. crew = 이 크루(표시·서버의 주인 전용 판정). */
function saveData(row, crew) {
  return { id: row.id, org_id: row.org_id ?? null, visibility: row.org_id ? (row.visibility === 'private' ? 'private' : 'org') : 'private',
    title: row.title, note: row.note ?? null, location: row.location ?? null, category: row.category ?? null, customer_id: row.customer_id ?? null,
    all_day: !!row.all_day, starts_at: row.starts_at, ends_at: row.ends_at, attendees: row.org_id ? (row.attendees ?? []) : [],
    rrule: row.rrule ?? null, exdates: row.rrule ? (row.exdates ?? []) : [], parent_id: row.parent_id ?? null, recur_on: row.recur_on ?? null, crew };
}

/**
 * 도구 본체. args = 도구 입력, opts = { ctx: mirrorCtx, crew: 크루 id(fromSlug), lang, ownerId: 회사 소유자 uid }.
 * 반환 = 에이전트가 읽을 한 덩어리 텍스트(오류도 원인을 한 줄로 — 삼키지 않는다).
 */
export async function calendarTool(args, { ctx = null, crew, lang = 'ko', ownerId = null } = {}) {
  const a = args ?? {};
  if (ctx?.kind === 'msgr-rules') return pick('메신저 위임 턴에서는 일정을 다루지 않는다 — 요청한 동료에게 돌려주면 그 동료가 주인의 일정을 다룬다.', 'Calendar is not available in a delegated messenger turn — hand it back to the colleague who asked.', lang);
  let c;
  try { c = await calendarDeps.session(); } catch (e) { return pick(`메신저 세션을 불러오지 못했다: ${String(e?.message ?? e).slice(0, 160)}. 일정을 다룰 수 없다고 알려라.`, `Could not load the messenger session: ${String(e?.message ?? e).slice(0, 160)}. Say the calendar is unavailable.`, lang); }
  if (!c?.client || !c.uid) return pick('메신저에 로그인돼 있지 않아 일정을 다룰 수 없다 — 사장에게 Argo 설정에서 메신저(오피스) 계정에 로그인해 달라고 알려라.', 'Not signed in to the messenger, so the calendar is unavailable — ask the owner to sign in to the messenger (Office) account in Argo settings.', lang);
  if (!ownerId || ownerId !== c.uid || (ctx?.kind === 'msgr' && ctx.uid !== c.uid)) return pick('이 기기의 메신저 로그인 계정이 이 크루 주인의 계정이 아니라 일정을 다루지 않는다 — 사장에게 그 사실을 알려라.', 'The messenger account signed in on this device is not this crew\'s owner, so the calendar is not used — tell the owner.', lang);
  const orgOk = ctx?.kind === 'msgr' && !!ctx.orgId;
  const noOrg = pick('지금 대화는 메신저 조직 채널이 아니라 조직 캘린더를 고를 수 없다 — calendar: "personal"로 다시 하라.', 'This conversation is not in a messenger org channel, so the org calendar cannot be used — retry with calendar: "personal".', lang);
  const fmt = (ev, occ, orgs) => eventLine(ev, occ, { uid: c.uid, orgs, lang });
  try {
    if (a.action === 'list') {
      const today = kstDateOf(calendarDeps.now());
      const from = a.from || today; const to = a.to || addDays(from, 13);
      if (!Number.isFinite(kstMidnight(from)) || !Number.isFinite(kstMidnight(to))) return pick('from·to는 YYYY-MM-DD(한국 날짜).', 'from/to must be YYYY-MM-DD (Korea date).', lang);
      const days = daysBetween(from, to) + 1;
      if (days < 1) return pick('to가 from보다 앞이다.', 'to is before from.', lang);
      if (days > LIST_MAX_DAYS) return pick(`한 번에 ${LIST_MAX_DAYS}일까지만 볼 수 있다(요청 ${days}일) — 범위를 나눠 다시 보라.`, `At most ${LIST_MAX_DAYS} days per call (asked ${days}) — split the range.`, lang);
      if (a.calendar === 'org' && !orgOk) return noOrg;
      const { events, orgs } = await listRange(c, from, addDays(to, 1));
      const fromMs = kstMidnight(from); const toMs = kstMidnight(addDays(to, 1));
      const rows = events.filter((ev) => inTurnScope(ev, ctx) && (a.calendar === 'personal' ? !ev.org_id : a.calendar === 'org' ? ev.org_id === ctx.orgId : true))
        .flatMap((ev) => occurrences(ev, fromMs, toMs).map((occ) => ({ ev, occ }))).sort((x, y) => x.occ.start - y.occ.start);
      const head = pick(`일정 ${from}~${to}(한국 시간) — ${rows.length}건`, `Events ${from}~${to} (Korea time) — ${rows.length}`, lang);
      if (!rows.length) return `${head}. ${pick('이 기간에 일정이 없다.', 'Nothing in this range.', lang)}`;
      const lines = rows.slice(0, LINE_CAP).map((r) => fmt(r.ev, r.occ, orgs));
      if (rows.length > LINE_CAP) lines.push(pick(`…외 ${rows.length - LINE_CAP}건 — 범위를 좁혀 다시 보라.`, `…and ${rows.length - LINE_CAP} more — narrow the range.`, lang));
      return `${head}\n${lines.join('\n')}\n${pick('고치거나 지울 때는 id와 그 줄의 날짜(반복이면 회차)를 day로 준다. 읽기 전용 일정은 고칠 수 없다.', 'To change or delete, pass the id and that line\'s date (occurrence for repeats) as day. Read-only events cannot be changed.', lang)}`;
    }

    if (a.action === 'create') {
      const title = String(a.title ?? '').trim();
      if (!title) return pick('create에는 title이 필요하다.', 'create needs a title.', lang);
      if (!a.start) return pick('create에는 start가 필요하다(날짜만 주면 종일 일정).', 'create needs start (a date alone makes an all-day event).', lang);
      const cal = a.calendar ?? 'personal';
      if (cal === 'org' && !orgOk) return noOrg;
      const now = calendarDeps.now();
      const t = resolveTimes(a, { allDay: false, start: now, end: now + 3600_000 }, lang);
      if (t.error) return t.error;
      const rrule = resolveRepeat(a, lang);
      if (rrule?.error) return rrule.error;
      const row = { id: calendarDeps.newId(), org_id: cal === 'org' ? ctx.orgId : null, visibility: a.visibility ?? 'org', title, note: a.note, location: a.location, category: a.category,
        all_day: t.allDay, starts_at: new Date(t.start).toISOString(), ends_at: new Date(t.end).toISOString(), rrule: rrule ?? null };
      const r = await writeEvent(c, 'save', saveData(row, crew));
      return `${pick('일정을 만들었다', 'Created the event', lang)}: ${fmt(r?.event ?? row, null, [])}`;
    }

    if (a.action === 'update' || a.action === 'delete') {
      if (!a.id || !a.day) return pick(`${a.action}에는 id와 day(list가 보여 준 그 줄의 날짜, 반복이면 회차 날짜)가 필요하다.`, `${a.action} needs id and day (the date shown by list; the occurrence date for repeats).`, lang);
      if (!Number.isFinite(kstMidnight(a.day))) return pick('day는 YYYY-MM-DD.', 'day must be YYYY-MM-DD.', lang);
      const { events } = await listRange(c, a.day, addDays(a.day, 1));
      const row = events.find((ev) => ev.id === a.id && inTurnScope(ev, ctx));
      if (!row) return pick(`${a.day}에 id=${a.id} 일정이 없다 — list로 id와 날짜를 다시 확인하라.`, `No event id=${a.id} on ${a.day} — check the id and date with list.`, lang);
      if (row.owner !== c.uid || row.can_edit !== true) return pick(`이 일정은 주인(${row.owner_name ?? '다른 사람'})의 것이라 에이전트가 고치거나 지울 수 없다 — 그 사실을 한 줄로 알려라.`, `This event belongs to ${row.owner_name ?? 'someone else'}, so an agent cannot change or delete it — say so in one line.`, lang);
      const recurring = !!parseRrule(row.rrule);
      const occ = recurring ? occurrences(row, kstMidnight(a.day), kstMidnight(addDays(a.day, 1))).find((o) => o.day === a.day) : null;
      if (recurring && !occ) return pick(`${a.day}은(는) 이 반복 일정의 회차가 아니다.`, `${a.day} is not an occurrence of this repeating event.`, lang);
      const scope = recurring ? a.scope : 'all';
      if (!scope) return pick('반복 일정이다 — scope를 정해 다시 하라: this(이 회차만) / following(이 회차 및 이후) / all(모든 회차).', 'This event repeats — retry with scope: this / following / all.', lang);
      const firstDay = kstDateOf(Date.parse(row.starts_at));

      if (a.action === 'delete') {
        if (scope === 'this') await writeEvent(c, 'skip', { id: row.id, day: a.day, crew });
        // 이후 지우기 = next 없는 split — 서버가 UNTIL을 전날로 자르고 그 뒤의 회차 수정 행까지 지운다(save로 UNTIL만 바꾸면 유령 회차가 남는다)
        else if (scope === 'following' && a.day > firstDay) await writeEvent(c, 'split', { id: row.id, day: a.day, crew });
        else await writeEvent(c, 'delete', { id: row.id, crew });
        const what = scope === 'this' ? pick(`${a.day} 회차만`, `only the ${a.day} occurrence`, lang) : scope === 'following' ? pick(`${a.day} 회차부터 이후`, `from ${a.day} onward`, lang) : pick('전체', 'entirely', lang);
        return pick(`일정 "${row.title}"을(를) ${what} 지웠다.`, `Deleted "${row.title}" ${what}.`, lang);
      }

      // update — 바꾼 값만 기존 행 위에 얹는다(명세 save = 전체 필드)
      const base = occ ?? { start: Date.parse(row.starts_at), end: Date.parse(row.ends_at) };
      const touchesTime = a.start != null || a.end != null || typeof a.all_day === 'boolean';
      const t = touchesTime ? resolveTimes(a, { allDay: !!row.all_day, start: base.start, end: base.end }, lang) : { allDay: !!row.all_day, start: base.start, end: base.end };
      if (t.error) return t.error;
      const rrule = resolveRepeat(a, lang);
      if (rrule?.error) return rrule.error;
      if (scope === 'this' && rrule !== undefined) return pick('한 회차만 바꿀 때는 반복 설정을 바꿀 수 없다 — scope를 following이나 all로.', 'Repeat settings cannot change for a single occurrence — use scope following or all.', lang);
      let orgId = row.org_id ?? null;
      if (a.calendar === 'org') { if (!orgOk) return noOrg; orgId = ctx.orgId; }
      if (a.calendar === 'personal') orgId = null;
      const moved = orgId !== (row.org_id ?? null);
      const fields = { org_id: orgId, visibility: a.visibility ?? row.visibility, title: a.title != null ? String(a.title).trim() : row.title,
        note: a.note ?? row.note, location: a.location ?? row.location, category: a.category ?? row.category,
        ...(moved ? { customer_id: null, attendees: [] } : {}), all_day: t.allDay }; // 캘린더를 옮기면 고객·참석자 범위가 달라진다(서버 check)
      const iso = (ms) => new Date(ms).toISOString();
      let r;
      if (scope === 'this') {
        const child = { ...row, ...fields, id: calendarDeps.newId(), parent_id: row.id, recur_on: a.day, rrule: null, exdates: [], starts_at: iso(t.start), ends_at: iso(t.end) };
        r = await writeEvent(c, 'save', saveData(child, crew));
      } else if (scope === 'following' && a.day > firstDay) {
        const next = { ...row, ...fields, id: calendarDeps.newId(), rrule: rrule === undefined ? row.rrule : rrule, exdates: (row.exdates ?? []).filter((d) => d > a.day), starts_at: iso(t.start), ends_at: iso(t.end) };
        r = await writeEvent(c, 'split', { id: row.id, day: a.day, next: saveData(next, crew), crew });
      } else {
        // 전체(또는 첫 회차부터) — 회차 기준 변경을 시리즈 시작에 옮긴다(매주 요일·매월 날짜의 기준이 흐트러지지 않게)
        const shift = t.start - base.start; const s0 = Date.parse(row.starts_at) + shift;
        const whole = { ...row, ...fields, rrule: rrule === undefined ? row.rrule : rrule, starts_at: iso(s0), ends_at: iso(s0 + (t.end - t.start)) };
        r = await writeEvent(c, 'save', saveData(whole, crew));
      }
      return `${pick('일정을 고쳤다', 'Updated the event', lang)}${recurring ? pick(`(${scope === 'this' ? '이 회차만' : scope === 'following' ? '이 회차 및 이후' : '모든 회차'})`, ` (${scope})`, lang) : ''}: ${r?.event ? fmt(r.event, null, []) : `"${fields.title}"`}`;
    }
    return pick('action은 list·create·update·delete 중 하나다.', 'action must be list, create, update or delete.', lang);
  } catch (e) {
    return rpcError(e?.rpc ? e.message : e, lang);
  }
}

export function calendarDescription(lang = 'ko') {
  return lang === 'en'
    ? 'The owner\'s calendar (Argo Office events). action=list shows events for from~to (YYYY-MM-DD Korea dates, up to 62 days; default two weeks from today) — the owner\'s personal events and the org events the owner can see, with id and date. action=create makes an event; update/delete change one (pass id and day = the date list showed; for repeating events also scope: this | following | all). calendar: "personal" (default) or "org" (only in a messenger org channel — that org); visibility for org events: org (everyone, default) or private. start/end: YYYY-MM-DD (all-day, end = last day inclusive), YYYY-MM-DDTHH:MM (Korea time) or ISO with a time zone; end may be HH:MM. repeat: none|daily|weekly|monthly with repeat_interval and repeat_until (YYYY-MM-DD, inclusive). You can only change or delete the owner\'s own events; other people\'s events are read-only. This is not for scheduling your own future work — use schedule_task for that.'
    : '주인의 일정(아르고 오피스 달력)을 보고 만들고 고치고 지운다. action=list는 from~to(YYYY-MM-DD 한국 날짜, 최대 62일, 비우면 오늘부터 2주)의 일정을 id·날짜와 함께 보여 준다 — 주인의 개인 일정과 주인이 볼 수 있는 조직 일정. action=create는 새 일정, update·delete는 기존 일정(id와 day=list가 보여 준 그 줄의 날짜, 반복 일정이면 scope: this 이 회차만 | following 이 회차 및 이후 | all 모든 회차). calendar: "personal"(기본) 또는 "org"(메신저 조직 채널 대화에서만 — 그 조직), 조직 일정의 visibility: org(조직 전체, 기본) 또는 private(나만). start/end: YYYY-MM-DD(종일, end는 끝날 포함), YYYY-MM-DDTHH:MM(한국 시간) 또는 시간대 포함 ISO, end는 HH:MM만 줘도 된다. repeat: none|daily|weekly|monthly, repeat_interval(간격), repeat_until(YYYY-MM-DD, 포함). 고치고 지울 수 있는 것은 주인 소유 일정뿐이고, 남이 주인인 일정은 읽기만 한다. 크루 자신의 나중 할 일 예약은 이 도구가 아니라 schedule_task다.';
}
