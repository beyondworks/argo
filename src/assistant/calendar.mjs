// 능동 비서 — 일정 감지(코드, LLM 0회). 읽기는 에이전트 일정 도구와 같은 RPC(office_event_list — stable, 쓰기 없음)를 같은 기기 세션으로 부른다.
// 반복 회차는 화면·도구와 같은 occurrences로 편다(매주=시작 요일, 매월=없는 날 건너뜀, UNTIL 포함, 제외 날짜) — 따로 계산하지 않는다.
import { occurrences, kstDateOf } from '../gateway/office-calendar.mjs';
import { addDays, instantIn } from './rules.mjs';

export const CAL_READ_MS = 15 * 60_000;     // 전체 읽기 간격(설계 3.2 확인 주기)
export const CAL_SPAN_MS = 26 * 3_600_000;  // 앞 26시간 — 잠든 사이·조용한 시간 뒤 첫 읽기의 뒤로 보기 상한도 같다
export const CONFIRM_PAD_MS = 60_000;       // 확인 읽기 범위 = [가장 이른 회차 − 1분, 가장 늦은 회차 + 1분]

/** 일정 읽기 — { events }. 서버가 거절하거나 연결이 끊기면 던진다(호출부가 상태에 남기고 다음 차례에 다시 읽는다). */
export async function readCalendar(c, fromMs, toMs) {
  // 호출 이름은 글자 그대로 둔다 — 감시기가 부를 수 있는 서버 호출은 정해진 목록뿐이다(test/assistant-engine.test.mjs 허용 목록 핀)
  const { data, error } = await c.client.rpc('office_event_list', { p_from: new Date(fromMs).toISOString(), p_to: new Date(toMs).toISOString() });
  if (error) throw Object.assign(new Error(String(error.message ?? error)), { code: error.code ?? null });
  return { events: Array.isArray(data?.events) ? data.events : [] };
}

/** 주인의 일정만(순수) — 개인 일정 전부, 조직 일정은 주인이 주인이거나 참석자인 것. 조직에 공개된 남의 일정은 주인의 일정이 아니다(설계 5.1). */
export const ownEvents = (events, uid) => (events ?? []).filter((ev) => ev && ev.id && ev.starts_at && ev.ends_at
  && (ev.org_id == null || ev.owner === uid || (Array.isArray(ev.attendees) && ev.attendees.includes(uid))));

const one = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/** 일정 → 회차 목록(순수, 시작 순). [fromMs, toMs)에 걸치는 회차만. */
export function expand(events, fromMs, toMs) {
  const out = [];
  for (const ev of events) {
    for (const o of occurrences(ev, fromMs, toMs)) {
      out.push({ id: String(ev.id), title: one(ev.title, 120), location: one(ev.location, 80), allDay: !!ev.all_day, start: o.start, end: o.end });
    }
  }
  return out.sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

const iso = (ms) => new Date(ms).toISOString();
/** 키 — 회차를 날짜가 아니라 **시작 시각**으로 쓴다: 같은 날 시간만 옮겨도 새 키라 새 시각에 한 번 알리고, 옛 시각은 확인 읽기가 막는다(설계 5.1).
    시작 전 알림 키는 알림 시각(10·15·30·60분 전)과 무관하게 'pre' 하나다 — 설정에서 알림 시각을 바꿔도 이미 알린 회차를 다시 알리지 않는다. */
export const preKey = (o) => `cal:${o.id}:${iso(o.start)}:pre`;
export const eveKey = (o, date) => (o.allDay ? `cal:${o.id}:${date}:eve` : `cal:${o.id}:${iso(o.start)}:eve`); // 여러 날 종일 일정은 날마다 "내일 종일"로 다시 보인다
export const dayKey = (o, date) => `cal:${o.id}:${date}:day`;

/** 종일 회차가 덮는 KST 날짜 범위 — 오피스 종일 일정은 KST 자정 경계로 저장된다(office-calendar resolveTimes). */
const allDayCovers = (o, date) => kstDateOf(o.start) <= date && date <= kstDateOf(o.end - 1);

/**
 * 한 틱의 일정 판정(순수).
 *  occs = 사본 회차(expand 결과), now, coveredUntil = 이 시각까지 시작한 회차는 이미 처리(알림·보류·버림)했다, leadMs, sent = 보낸 키, skip = 확인 읽기에서 사라진 키.
 *  slot = 이번 틱의 묶음({ lane, date } | null), tz.
 * 반환:
 *  due      — 지금 보낼 시작 전 알림(시작 − 리드 ≤ 지금 < 시작, 키 처음). 늦게 안 일정(리드 시각이 이미 지남)도 시작 전이면 여기 — "N분 뒤 시작"(설계 5.1).
 *  missed   — (coveredUntil, 지금]에 시작했는데 알리지 못한 회차(조용한 시간·잠자기·배달 막힘). 다음 묶음으로 간다. 시작이 지난 뒤 처음 안 일정은
 *             coveredUntil이 지난 틱이라 여기 들지 않는다(즉시 알림도 묶음도 없다 — 설계 5.1 "늦게 안 경우").
 *  allDay   — 아침 묶음이면 오늘 종일 회차(시작 전 알림 없음 — 설계 5.1).
 *  tomorrow — 저녁 묶음이면 내일 회차(종일 포함).
 */
export function planCalendar({ occs, now, coveredUntil, leadMs, sent = {}, skip = new Set(), slot = null, tz = null }) {
  const due = []; const missed = [];
  for (const o of occs) {
    if (o.allDay) continue;
    const k = preKey(o);
    if (sent[k] || skip.has(k)) continue;
    if (o.start > now && o.start - leadMs <= now) due.push(o);
    else if (o.start > coveredUntil && o.start <= now) missed.push(o);
  }
  let allDay = []; let tomorrow = [];
  if (slot?.lane === 'am') allDay = occs.filter((o) => o.allDay && allDayCovers(o, slot.date) && !sent[dayKey(o, slot.date)]);
  if (slot?.lane === 'pm') {
    const next = addDays(slot.date, 1);
    const from = instantIn(next, '00:00', tz); const to = instantIn(addDays(slot.date, 2), '00:00', tz);
    tomorrow = occs.filter((o) => (o.allDay ? allDayCovers(o, next) : o.start >= from && o.start < to) && !sent[eveKey(o, next)]);
  }
  return { due, missed, allDay, tomorrow };
}

/** 확인 읽기(설계 5.1) — 보낼 시작 전 알림이 생긴 틱에서만, 그 회차들 시각 앞뒤 1분을 한 번 더 읽어 같은 일정 id·같은 회차 시작이 아직 있는 것만 돌려준다. */
export async function confirmDue(c, due, uid) {
  if (!due.length) return { kept: [], gone: [] };
  const from = Math.min(...due.map((o) => o.start)) - CONFIRM_PAD_MS;
  const to = Math.max(...due.map((o) => o.start)) + CONFIRM_PAD_MS;
  const { events } = await readCalendar(c, from, to);
  const live = new Set(expand(ownEvents(events, uid), from, to).filter((o) => !o.allDay).map(preKey));
  return { kept: due.filter((o) => live.has(preKey(o))), gone: due.filter((o) => !live.has(preKey(o))) };
}

