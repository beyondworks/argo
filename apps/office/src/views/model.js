// 여러 보기(목록·카드·칸반·표·주·월·일) 순수 계산 — 유건 9/30 명세 '여러 보기 1단계'.
// 일정(office_events)과 할 일(office_tasks)은 저장은 따로, 보기에서만 한 줄로 합친다(DB 변경 없음).
// 여기서는 합치기·거르기·정렬·칸반 칸 묶기와 "이 이동·바꾸기가 무엇을 쓰는지, 안 되면 왜 안 되는지"만 정한다. 실제 쓰기는 data.js.
// 할 일 권한은 서버 office_task_write와 같은 규칙이다(관리자 = 조직 owner·admin, 개인 공간은 관리자 없음).
import * as M from '../calendar/model.js';

export const VIEWS = ['list', 'card', 'kanban', 'table', 'week', 'month', 'day'];
export const BOARD = ['list', 'card', 'kanban', 'table'];
export const GROUPS = ['status', 'who', 'category', 'customer', 'date'];
export const SORTS = ['date', 'title', 'created'];
export const KINDS = ['all', 'event', 'task'];
export const PERIODS = ['all', 'today', 'week', 'month', 'overdue'];
export const KANBAN_PAGE = 50, LIST_PAGE = 100;

/** 저장된 보기 설정 → 쓸 수 있는 값만(모르는 값은 기본값). views: 이 자리에서 고를 수 있는 보기 */
export function normalizeCfg(raw, base = {}, views = VIEWS) {
  const r = raw && typeof raw === 'object' ? raw : {}, f = r.filter && typeof r.filter === 'object' ? r.filter : {};
  const d = { view: views[0], group: 'status', sort: 'date', ...base, filter: { kind: 'all', who: 'all', category: 'all', period: 'all', ...base.filter } };
  const str = (v, fb) => (typeof v === 'string' && v.length <= 200 ? v : fb);
  return {
    view: views.includes(r.view) ? r.view : d.view,
    group: GROUPS.includes(r.group) ? r.group : d.group,
    sort: SORTS.includes(r.sort) ? r.sort : d.sort,
    filter: { kind: KINDS.includes(f.kind) ? f.kind : d.filter.kind, who: str(f.who, d.filter.who), category: str(f.category, d.filter.category), period: PERIODS.includes(f.period) ? f.period : d.filter.period },
  };
}

/* ── 합치기 ── */
/** 일정 회차(calendar/model.js expand 결과) → 보기 항목 */
export function eventItem(o) {
  const [day, last] = M.spanOf(o);
  return {
    key: o.key, kind: 'event', id: o.id, title: o.title, day, last, start: o.start, end: o.end, allDay: !!o.all_day, done: false,
    category: o.category || '', customer: o.customer_id || '', customerName: o.customer_name || '', who: o.crew ? `a:${o.crew}` : o.owner ? `p:${o.owner}` : '',
    canEdit: !!o.can_edit, recurring: !!o.series, created: Date.parse(o.created_at ?? '') || 0, src: o,
  };
}
/** 할 일 행(+ 어느 공간의 것인지) → 보기 항목 */
export function taskItem(x) {
  const day = x.due_on || null;
  return {
    key: `t:${x.id}`, kind: 'task', id: x.id, title: x.title, day, last: day, start: null, end: null, allDay: true, done: !!x.done_at,
    category: '', customer: '', customerName: '', who: x.assignee ? `p:${x.assignee}` : '', space: x.space, created: Date.parse(x.created_at ?? '') || 0, src: x,
  };
}
/** 일정 회차 + 할 일 → 한 목록. 할 일은 기한이 [from, to) 안인 것, undated면 기한 없는 열린 일(끝낸 것은 from 뒤에 끝낸 것만),
 *  overdue면 from 전 기한인 열린 일도. 취소한 할 일은 넣지 않는다 */
export function mergeItems(occurrences, tasks, { from, to, undated = false, overdue = false }) {
  const out = occurrences.map(eventItem);
  for (const x of tasks) {
    if (x.cancelled_at) continue;
    const due = x.due_on || null, done = !!x.done_at;
    const keep = due ? (due >= from && due < to) || (overdue && due < from && !done)
      : undated && (!done || M.kstDay(x.done_at) >= from);
    if (keep) out.push(taskItem(x));
  }
  return out;
}

/* ── 거르기·정렬 ── */
const overlaps = (it, a, b) => !!it.day && it.day <= b && (it.last ?? it.day) >= a;
export function filterItems(items, f, today) {
  return items.filter((it) => {
    if (f.kind !== 'all' && it.kind !== f.kind) return false;
    if (f.who !== 'all' && (f.who === 'none' ? !!it.who : it.who !== f.who)) return false;
    if (f.category !== 'all' && (f.category === 'none' ? !!it.category : it.category !== f.category)) return false;
    if (f.period === 'today') return overlaps(it, today, today);
    if (f.period === 'week') return overlaps(it, today, M.addDays(today, 6));
    if (f.period === 'month') return overlaps(it, today, M.addDays(today, 29));
    if (f.period === 'overdue') return !!it.day && (it.last ?? it.day) < today && !it.done;
    return true;
  });
}
const byTitle = (a, b) => a.title.localeCompare(b.title, 'ko') || a.key.localeCompare(b.key);
const when = (it) => it.start ?? M.kstStart(it.day);
/** 날짜순(날짜 없는 것은 뒤, 같은 날은 종일·할 일 먼저) · 제목순 · 만든 순(오래된 것부터) */
export function sortItems(items, sort) {
  const list = items.slice();
  if (sort === 'title') return list.sort(byTitle);
  if (sort === 'created') return list.sort((a, b) => a.created - b.created || byTitle(a, b));
  return list.sort((a, b) => (!a.day || !b.day ? (!a.day) - (!b.day) : a.day.localeCompare(b.day)) || (b.allDay - a.allDay) || (a.day ? when(a) - when(b) : 0) || byTitle(a, b));
}

/* ── 칸반 칸 ── */
const sundayOf = (day) => M.addDays(M.mondayOf(day), 6);
/** 날짜 칸 — 기한 지남 · 오늘 · 이번 주(내일~일요일) · 나중 · 날짜 없음 */
export function bucketOf(day, today) {
  if (!day) return 'none';
  if (day < today) return 'overdue';
  if (day === today) return 'today';
  return day <= sundayOf(today) ? 'week' : 'later';
}
/** 그 날짜 칸으로 옮기면 정할 날짜 — { day } | { reason }. '날짜 없음'은 day: null */
export function bucketTarget(bucket, today) {
  if (bucket === 'overdue') return { reason: 'past' };
  if (bucket === 'today') return { day: today };
  if (bucket === 'week') { const next = M.addDays(today, 1); return next <= sundayOf(today) ? { day: next } : { reason: 'weekOver' }; }
  if (bucket === 'later') return { day: M.addDays(M.mondayOf(today), 7) };
  return { day: null };
}
/** 항목이 들어갈 칸 키 — 상태: event|todo|done, 담당: p:사람|a:에이전트|none, 분류: c:이름|none, 거래처: u:id|none, 날짜: bucketOf */
export function keyOf(it, by, today) {
  if (by === 'status') return it.kind === 'event' ? 'event' : it.done ? 'done' : 'todo';
  if (by === 'date') return bucketOf(it.day, today);
  if (by === 'category') return it.category ? `c:${it.category}` : 'none';
  if (by === 'customer') return it.customer ? `u:${it.customer}` : 'none';
  return it.who || 'none';
}
/** 칸 순서 — 상태·날짜는 늘 같은 칸(비어 있어도 놓을 수 있게), 분류·거래처는 이름순 + '없음'은 끝, 담당은 나 → 사람 → 에이전트 → 없음.
 *  kind: 지금 거른 종류(할 일만 보면 '일정' 칸은 뺀다). label: 칸 키 → 이름(정렬용) */
export function groupItems(items, by, { today, me, kind = 'all', label = (k) => k }) {
  const map = new Map();
  for (const it of items) { const k = keyOf(it, by, today); if (!map.has(k)) map.set(k, []); map.get(k).push(it); }
  let keys;
  if (by === 'status') keys = kind === 'task' ? ['todo', 'done'] : kind === 'event' ? ['event'] : ['event', 'todo', 'done'];
  else if (by === 'date') keys = ['overdue', 'today', 'week', 'later', 'none'];
  else {
    const rank = (k) => (k === 'none' ? 3 : by === 'who' ? (k === `p:${me}` ? 0 : k.startsWith('p:') ? 1 : 2) : 1);
    keys = [...new Set([...map.keys(), ...(by === 'who' ? [] : ['none'])])].sort((a, b) => rank(a) - rank(b) || String(label(a)).localeCompare(String(label(b)), 'ko'));
  }
  return keys.map((k) => [k, map.get(k) ?? []]);
}

/* ── 권한·이유 ── */
/** 서버 office_task_write와 같은 판정 — 관리자는 다 되고, 맡은 사람은 끝내기·다시 열기, 기한·제목·취소는 내가 만들고 내가 맡은 일만 */
export function taskCan(action, task, me, admin) {
  if (admin) return true;
  if (action === 'task.done' || action === 'task.reopen') return task.assignee === me;
  if (action === 'task.due' || action === 'task.title' || action === 'task.cancel') return task.created_by === me && task.assignee === me;
  return false;
}
const admin = (it, ctx) => it.space !== 'me' && !!ctx.isAdmin(it.space);
/** 이 항목에 이 동작이 안 되는 이유(사전 키 끝) — 되면 null. op: date|category|customer|done|delete|duplicate|assign */
export function whyNot(it, op, ctx) {
  if (it.kind === 'event') {
    if (op === 'done') return 'eventStatus';
    if (op === 'assign') return 'eventWho';
    if (!it.canEdit && op !== 'duplicate') return 'eventPerm';
    if (it.recurring && (op === 'date' || op === 'category' || op === 'customer')) return 'recurring';
    return null;
  }
  if (op === 'category') return 'taskCategory';
  if (op === 'customer') return 'taskCustomer';
  if (op === 'duplicate') return null;
  const t = it.src, a = admin(it, ctx);
  if (op === 'done') return taskCan('task.done', t, ctx.me, a) ? null : 'taskPerm';
  if (op === 'assign') { if (it.space === 'me') return 'personal'; if (!a) return 'assignAdmin'; }
  if (it.done) return 'done'; // 끝낸 일은 기한·담당·취소를 바꾸지 않는다(서버 task_done)
  if (op === 'assign') return null;
  return taskCan(op === 'date' ? 'task.due' : 'task.cancel', t, ctx.me, a) ? null : 'taskPerm';
}

/* ── 쓰기 계획 ── 결과: { write } (write=null이면 바꿀 것 없음) | { reason } */
const no = (reason) => ({ reason });
/** 서버 행 → 다시 저장할 값(바꿀 것만 덮는다) — 달력 화면의 rowFrom과 같은 모양 */
export const eventRow = (r, patch) => ({ id: r.id, org_id: r.org_id ?? null, visibility: r.visibility, title: r.title, note: r.note ?? '', location: r.location ?? '', category: r.category ?? '', customer_id: r.customer_id ?? null, all_day: !!r.all_day, starts_at: r.starts_at, ends_at: r.ends_at, attendees: r.attendees ?? [], rrule: r.rrule ?? null, exdates: r.exdates ?? [], parent_id: r.parent_id ?? null, recur_on: r.recur_on ?? null, ...patch });
/** 일정을 그 날짜로 — 시간 일정은 시각을 그대로 두고 날짜만, 종일은 기간 길이를 그대로 */
export function eventOnDay(o, day) {
  if (o.all_day) { const [a, b] = M.spanOf(o); return M.allDayRange(day, M.addDays(day, M.dayDiff(a, b))); }
  const s = M.localAt(day, M.localTime(o.start));
  return { starts_at: new Date(s).toISOString(), ends_at: new Date(s + (o.end - o.start)).toISOString() };
}
const taskWrite = (it, action, data, patch) => ({ write: { type: 'task', space: it.space, action, data: { id: it.id, ...data }, patch } });

export function planDone(it, done, ctx) {
  const r = whyNot(it, 'done', ctx);
  if (r) return no(r);
  if (it.done === done) return { write: null };
  return taskWrite(it, done ? 'task.done' : 'task.reopen', {}, { done_at: done ? new Date().toISOString() : null });
}
export function planDate(it, day, ctx) {
  if (it.kind === 'event' && !day) return no('eventNeedsDate');
  const r = whyNot(it, 'date', ctx);
  if (r) return no(r);
  if (it.kind === 'task') return (it.day ?? null) === (day ?? null) ? { write: null } : taskWrite(it, 'task.due', { due_on: day }, { due_on: day });
  if (it.day === day) return { write: null };
  return { write: { type: 'event.save', row: eventRow(it.src, eventOnDay(it.src, day)) } };
}
export function planCategory(it, category, ctx) {
  const r = whyNot(it, 'category', ctx);
  if (r) return no(r);
  const next = (category ?? '').trim().slice(0, 40);
  return it.category === next ? { write: null } : { write: { type: 'event.save', row: eventRow(it.src, { category: next }) } };
}
export function planCustomer(it, customer, ctx) {
  const r = whyNot(it, 'customer', ctx);
  if (r) return no(r);
  return (it.customer || null) === (customer || null) ? { write: null } : { write: { type: 'event.save', row: eventRow(it.src, { customer_id: customer || null }) } };
}
export function planAssign(it, user, ctx) {
  const r = whyNot(it, 'assign', ctx);
  if (r) return no(r);
  const members = ctx.members?.(it.space);
  if (members && !members.has(user)) return no('member');
  return it.src.assignee === user ? { write: null } : taskWrite(it, 'task.assign', { assignee: user }, { assignee: user });
}
/** 지우기 — 일정은 삭제(반복 회차는 이 회차만 빼기), 할 일은 서버에 지우기가 없어 '취소'(기록은 남는다) */
export function planDelete(it, ctx) {
  const r = whyNot(it, 'delete', ctx);
  if (r) return no(r);
  if (it.kind === 'task') return taskWrite(it, 'task.cancel', {});
  return { write: it.recurring ? { type: 'event.skip', id: it.src.series.id, day: it.src.occ } : { type: 'event.delete', id: it.id } };
}
/** 복제 — 일정은 이 회차 시각의 한 번짜리 일정, 할 일은 같은 제목·기한으로 나에게 */
export function planDuplicate(it, ctx, id) {
  if (it.kind === 'task') return { write: { type: 'task', space: it.space, action: 'task.create', data: { id, title: it.title, due_on: it.day } } };
  const o = it.src;
  return { write: { type: 'event.save', row: eventRow(o, { id, starts_at: new Date(o.start).toISOString(), ends_at: new Date(o.end).toISOString(), rrule: null, exdates: [], parent_id: null, recur_on: null }) } };
}

/** 칸반에서 칸을 옮기면 — 그 칸의 속성이 바뀐다. 같은 칸이면 write: null */
export function planMove(it, by, to, ctx) {
  if (keyOf(it, by, ctx.today) === to) return { write: null };
  if (by === 'status') {
    if (it.kind === 'event') return no('eventStatus');
    return to === 'event' ? no('taskToEvent') : planDone(it, to === 'done', ctx);
  }
  if (by === 'date') { const tg = bucketTarget(to, ctx.today); return tg.reason ? no(tg.reason) : planDate(it, tg.day, ctx); }
  if (by === 'category') return planCategory(it, to === 'none' ? '' : to.slice(2), ctx);
  if (by === 'customer') return planCustomer(it, to === 'none' ? null : to.slice(2), ctx);
  if (it.kind === 'event') return no('eventWho');
  if (!to.startsWith('p:')) return no('taskAgent');
  return planAssign(it, to.slice(2), ctx);
}

/** 여러 항목에 같은 계획 — { writes, skipped: [{ item, reason }], same(바꿀 것 없던 수) } */
export function planMany(items, plan) {
  const writes = [], skipped = [];
  let same = 0;
  for (const it of items) {
    const p = plan(it);
    if (p.reason) skipped.push({ item: it, reason: p.reason });
    else if (p.write) writes.push(p.write);
    else same++;
  }
  return { writes, skipped, same };
}
