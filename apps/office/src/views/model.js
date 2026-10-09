// 여러 보기(목록·카드·칸반·표·주·월·일) 순수 계산 — 유건 9/30 명세 '여러 보기 1단계'.
// 일정(office_events)과 할 일(office_tasks)은 저장은 따로, 보기에서만 한 줄로 합친다(DB 변경 없음).
// 여기서는 합치기·거르기·정렬·칸반 칸 묶기와 "이 이동·바꾸기가 무엇을 쓰는지, 안 되면 왜 안 되는지"만 정한다. 실제 쓰기는 data.js.
// 할 일 권한은 서버 office_task_write와 같은 규칙이다(관리자 = 조직 owner·admin, 개인 공간은 관리자 없음).
import * as M from '../calendar/model.js';

export const VIEWS = ['list', 'card', 'kanban', 'table', 'week', 'month', 'day'];
export const BOARD = ['list', 'card', 'kanban', 'table'];
export const GROUPS = ['status', 'who', 'category', 'customer', 'date'];
export const SORTS = ['date', 'title', 'created', 'priority'];
export const DIRS = ['asc', 'desc'];
export const KINDS = ['all', 'event', 'task'];
export const PERIODS = ['all', 'today', 'week', 'month', 'overdue'];
// 할 일 속성(유건 10/4 확정): 상태 할 일·진행 중·보류(+끝냄은 done_at), 중요도 1 높음·2 보통·3 낮음(기본 2). 서버 office_tasks 칸과 같은 값
export const STATUSES = ['todo', 'doing', 'hold'];
export const STATUS_FILTERS = ['all', 'open', 'active', 'todo', 'doing', 'hold', 'done']; // active = 끝내지 않은 일 중 보류 빼고(배지 ?due와 같은 건수, #907 검수)
export const PRIORITIES = [1, 2, 3];
export const PRIORITY_FILTERS = ['all', '1', '2', '3'];
// 목록 보기 묶음(할 일 화면) — 'none'이면 날짜순일 때 날짜별 머리
export const LIST_GROUPS = ['none', 'category', 'status', 'who'];
export const KANBAN_PAGE = 50, LIST_PAGE = 100;

/** 저장된 보기 설정 → 쓸 수 있는 값만(모르는 값은 기본값). views: 이 자리에서 고를 수 있는 보기 */
export function normalizeCfg(raw, base = {}, views = VIEWS) {
  const r = raw && typeof raw === 'object' ? raw : {}, f = r.filter && typeof r.filter === 'object' ? r.filter : {};
  const d = { view: views[0], group: 'status', sort: 'date', dir: 'asc', listGroup: 'none', ...base, filter: { kind: 'all', who: 'all', category: 'all', period: 'all', status: 'all', priority: 'all', ...base.filter } };
  const str = (v, fb) => (typeof v === 'string' && v.length <= 200 ? v : fb);
  return {
    view: views.includes(r.view) ? r.view : d.view,
    group: GROUPS.includes(r.group) ? r.group : d.group,
    sort: SORTS.includes(r.sort) ? r.sort : d.sort,
    dir: DIRS.includes(r.dir) ? r.dir : d.dir,
    listGroup: LIST_GROUPS.includes(r.listGroup) ? r.listGroup : d.listGroup,
    filter: {
      kind: KINDS.includes(f.kind) ? f.kind : d.filter.kind, who: str(f.who, d.filter.who), category: str(f.category, d.filter.category), period: PERIODS.includes(f.period) ? f.period : d.filter.period,
      status: STATUS_FILTERS.includes(f.status) ? f.status : d.filter.status, priority: PRIORITY_FILTERS.includes(f.priority) ? f.priority : d.filter.priority,
    },
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
/** 할 일 저장 상태(끝낸 일이어도 다시 열면 돌아갈 상태) — 모르는 값은 'todo' */
export const statusOf = (x) => (STATUSES.includes(x?.status) ? x.status : 'todo');
export const priorityOf = (x) => (PRIORITIES.includes(Number(x?.priority)) ? Number(x.priority) : 2);
/** 할 일 행(+ 어느 공간의 것인지) → 보기 항목. status는 보이는 상태(끝낸 일은 'done'), category는 분류 이름(서버 office_task_list가 붙인다) */
export function taskItem(x) {
  const day = x.due_on || null;
  return {
    key: `t:${x.id}`, kind: 'task', id: x.id, title: x.title, day, last: day, start: null, end: null, allDay: true, done: !!x.done_at,
    status: x.done_at ? 'done' : statusOf(x), priority: priorityOf(x), categoryId: x.category_id || null, starts: x.starts_on || null,
    category: x.category_id ? x.category || '' : '', customer: '', customerName: '', who: x.assignee ? `p:${x.assignee}` : '', space: x.space, created: Date.parse(x.created_at ?? '') || 0, src: x,
  };
}
/** ?due(홈 '챙길 것'·메뉴 배지에서 온 주소) 거르기 — 내가 맡은·안 끝낸·그 기한 할 일만. 분류·중요도 거르기는 푼다(배지 수와 같은 건수가 보이게, 18차 검수 LOW 1). 모르는 값은 null */
export const dueFilter = (filter, due, me) => (due === 'overdue' || due === 'today' ? { ...filter, period: due, who: `p:${me}`, status: 'active', category: 'all', priority: 'all' } : null);

/** 보기 설정 바꾸기(OFC-15) — 홈 '챙길 것'에서 ?due로 온 임시 거르기(temp)는 이 창에서만 쓰고 저장하지 않는다.
 *  정렬·보기·묶기만 바꾸면 저장값(saved)에 임시 거르기가 섞이지 않고 임시는 그대로, 사람이 거르기를 바꾸면 그 거르기(임시 위에서 고친 것)가 저장되고 임시는 끝난다.
 *  fixed = 늘 같은 칸(할 일 화면은 kind 'task') */
export function patchCfg(cfg, temp, patch, { base, views, fixed = {} } = {}) {
  const from = patch.filter && temp ? { ...cfg, filter: temp } : cfg;
  return { saved: normalizeCfg({ ...from, ...patch, filter: { ...from.filter, ...patch.filter, ...fixed } }, base, views), temp: patch.filter ? null : temp };
}
/** 화면에 쓸 설정 — 임시 거르기가 있으면 그 거르기로 */
export const shownCfg = (cfg, temp, base, views) => (temp ? normalizeCfg({ ...cfg, filter: temp }, base, views) : cfg);

/** 기한이 지났는데 끝내지 않았는가 — 여러 날이면 마지막 날 기준(필터 '지난 일'과 할 일 배지가 같이 쓴다) */
export const isOverdue = (it, today) => !!it.day && (it.last ?? it.day) < today && !it.done;

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
/** 거르기 — 종류·담당·분류(이름)·기간, 할 일 상태('open' = 끝내지 않은 일)·중요도. 상태·중요도를 거르면 일정은 빠진다(일정에는 없는 속성) */
export function filterItems(items, f, today) {
  return items.filter((it) => {
    if (f.kind !== 'all' && it.kind !== f.kind) return false;
    if (f.who !== 'all' && (f.who === 'none' ? !!it.who : it.who !== f.who)) return false;
    if (f.category !== 'all' && (f.category === 'none' ? !!it.category : it.category !== f.category)) return false;
    if (f.status && f.status !== 'all' && (it.kind !== 'task' || (f.status === 'open' ? it.done : f.status === 'active' ? it.done || it.status === 'hold' : it.status !== f.status))) return false;
    if (f.priority && f.priority !== 'all' && (it.kind !== 'task' || String(it.priority) !== f.priority)) return false;
    if (f.period === 'today') return overlaps(it, today, today);
    if (f.period === 'week') return overlaps(it, today, M.addDays(today, 6));
    if (f.period === 'month') return overlaps(it, today, M.addDays(today, 29));
    if (f.period === 'overdue') return isOverdue(it, today);
    return true;
  });
}
const byTitle = (a, b) => a.title.localeCompare(b.title, 'ko') || a.key.localeCompare(b.key);
const when = (it) => it.start ?? M.kstStart(it.day);
/** 날짜순(날짜 없는 것은 늘 뒤, 같은 날은 종일·할 일 먼저) · 제목순 · 만든 순 · 중요도순(높음 먼저, 같으면 날짜순, 중요도가 없는 일정은 뒤).
 *  dir 'desc'면 거꾸로(날짜 없는 것·중요도 없는 것이 뒤인 것은 그대로) */
export function sortItems(items, sort, dir = 'asc') {
  const list = items.slice(), s = dir === 'desc' ? -1 : 1;
  const byDate = (a, b) => (!a.day || !b.day ? (!a.day) - (!b.day) : s * a.day.localeCompare(b.day)) || (b.allDay - a.allDay) || (a.day ? s * (when(a) - when(b)) : 0) || byTitle(a, b);
  if (sort === 'title') return list.sort((a, b) => s * byTitle(a, b));
  if (sort === 'created') return list.sort((a, b) => s * (a.created - b.created) || byTitle(a, b));
  if (sort === 'priority') {
    const p = (it) => (it.kind === 'task' ? it.priority : null);
    return list.sort((a, b) => (p(a) == null || p(b) == null ? (p(a) == null) - (p(b) == null) : s * (p(a) - p(b))) || byDate(a, b));
  }
  return list.sort(byDate);
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
/** 항목이 들어갈 칸 키 — 상태: event|todo|doing|hold|done, 담당: p:사람|a:에이전트|none, 분류: c:이름|none, 거래처: u:id|none, 날짜: bucketOf */
export function keyOf(it, by, today) {
  if (by === 'status') return it.kind === 'event' ? 'event' : it.done ? 'done' : (it.status ?? 'todo');
  if (by === 'date') return bucketOf(it.day, today);
  if (by === 'category') return it.category ? `c:${it.category}` : 'none';
  if (by === 'customer') return it.customer ? `u:${it.customer}` : 'none';
  return it.who || 'none';
}
const TASK_COLS = ['todo', 'doing', 'hold', 'done'];
/** 칸 순서 — 상태·날짜는 늘 같은 칸(비어 있어도 놓을 수 있게), 분류·거래처는 이름순 + '없음'은 끝, 담당은 나 → 사람 → 에이전트 → 없음.
 *  kind: 지금 거른 종류(할 일만 보면 '일정' 칸은 뺀다). label: 칸 키 → 이름(정렬용).
 *  cats: 할 일 분류 이름(관리 순서) — 주면 분류 칸은 그 순서로, 비어 있는 분류도 칸을 둔다(끌어 놓을 수 있게) */
export function groupItems(items, by, { today, me, kind = 'all', label = (k) => k, cats = null }) {
  const map = new Map();
  for (const it of items) { const k = keyOf(it, by, today); if (!map.has(k)) map.set(k, []); map.get(k).push(it); }
  let keys;
  if (by === 'status') keys = kind === 'task' ? TASK_COLS : kind === 'event' ? ['event'] : ['event', ...TASK_COLS];
  else if (by === 'date') keys = ['overdue', 'today', 'week', 'later', 'none'];
  else if (by === 'category' && cats) {
    const own = cats.map((n) => `c:${n}`);
    const rest = [...map.keys()].filter((k) => k !== 'none' && !own.includes(k)).sort((a, b) => String(label(a)).localeCompare(String(label(b)), 'ko'));
    keys = [...own, ...rest, 'none'];
  } else {
    const rank = (k) => (k === 'none' ? 3 : by === 'who' ? (k === `p:${me}` ? 0 : k.startsWith('p:') ? 1 : 2) : 1);
    keys = [...new Set([...map.keys(), ...(by === 'who' ? [] : ['none'])])].sort((a, b) => rank(a) - rank(b) || String(label(a)).localeCompare(String(label(b)), 'ko'));
  }
  return keys.map((k) => [k, map.get(k) ?? []]);
}

/* ── 권한·이유 ── */
const BY_ASSIGNEE = ['task.done', 'task.reopen', 'task.status'];
const BY_OWNER = ['task.due', 'task.title', 'task.cancel', 'task.note', 'task.priority', 'task.category', 'task.start'];
/** 서버 office_task_write와 같은 판정 — 관리자는 다 되고, 맡은 사람은 끝내기·다시 열기·상태 바꾸기,
 *  기한·제목·메모·분류·중요도·시작일·취소는 내가 만들고 내가 맡은 일만 */
export function taskCan(action, task, me, admin) {
  if (admin) return true;
  if (BY_ASSIGNEE.includes(action)) return task.assignee === me;
  if (BY_OWNER.includes(action)) return task.created_by === me && task.assignee === me;
  return false;
}
const admin = (it, ctx) => it.space !== 'me' && !!ctx.isAdmin(it.space);
/** 할 일에서 그 칸을 고칠 수 있는가(할 일 패널) — field: title|note|priority|category|starts_on|due_on|status|assign|cancel. 끝낸 일은 상태(다시 열기)만 */
export const FIELD_ACTION = { title: 'task.title', note: 'task.note', priority: 'task.priority', category: 'task.category', starts_on: 'task.start', due_on: 'task.due', status: 'task.status', cancel: 'task.cancel' };
/** 이 항목에 이 동작이 안 되는 이유(사전 키 끝) — 되면 null. op: date|category|customer|done|status|edit|delete|duplicate|assign */
export function whyNot(it, op, ctx) {
  if (it.kind === 'event') {
    if (op === 'done' || op === 'status') return 'eventStatus';
    if (op === 'assign') return 'eventWho';
    if (!it.canEdit && op !== 'duplicate') return 'eventPerm';
    if (it.recurring && (op === 'date' || op === 'category' || op === 'customer')) return 'recurring';
    return null;
  }
  if (op === 'customer') return 'taskCustomer';
  if (op === 'duplicate') return null;
  const t = it.src, a = admin(it, ctx);
  if (op === 'done') return taskCan('task.done', t, ctx.me, a) ? null : 'taskPerm';
  if (op === 'status') return taskCan('task.status', t, ctx.me, a) ? null : 'taskPerm'; // 끝낸 일은 다시 열면서 상태를 바꾼다(맡은 사람·관리자)
  if (op === 'assign') { if (it.space === 'me') return 'personal'; if (!a) return 'assignAdmin'; }
  if (it.done) return 'done'; // 끝낸 일은 기한·담당·취소·분류·메모를 바꾸지 않는다(서버 task_done)
  if (op === 'assign') return null;
  const action = op === 'date' ? 'task.due' : op === 'category' ? 'task.category' : op === 'edit' ? 'task.title' : 'task.cancel';
  return taskCan(action, t, ctx.me, a) ? null : 'taskPerm';
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
/** 일정 분류(자유 글자) — 할 일은 분류 표의 id라 planTaskCategory로 */
export function planCategory(it, category, ctx) {
  if (it.kind === 'task') return no('taskCategoryPick');
  const r = whyNot(it, 'category', ctx);
  if (r) return no(r);
  const next = (category ?? '').trim().slice(0, 40);
  return it.category === next ? { write: null } : { write: { type: 'event.save', row: eventRow(it.src, { category: next }) } };
}
/** 할 일 분류 — id(null = 미분류)와 화면에 먼저 보일 이름 */
export function planTaskCategory(it, id, name, ctx) {
  const r = whyNot(it, 'category', ctx);
  if (r) return no(r);
  if ((it.categoryId ?? null) === (id ?? null)) return { write: null };
  return taskWrite(it, 'task.category', { category_id: id ?? null }, { category_id: id ?? null, category: id ? name ?? '' : null });
}
/** 할 일 상태 — 'done'은 끝내기, 끝낸 일을 할 일·진행 중·보류로 옮기면 다시 열고(저장된 상태가 다르면) 상태도 바꾼다 */
export function planStatus(it, status, ctx) {
  if (it.kind === 'event') return no('eventStatus');
  if (status === 'done') return planDone(it, true, ctx);
  if (!STATUSES.includes(status)) return no('taskToEvent');
  const r = whyNot(it, 'status', ctx);
  if (r) return no(r);
  const same = statusOf(it.src) === status;
  const change = taskWrite(it, 'task.status', { status }, { status }).write;
  if (!it.done) return same ? { write: null } : { write: change };
  const reopen = taskWrite(it, 'task.reopen', {}, { done_at: null }).write;
  return { write: same ? reopen : [reopen, change] };
}
/** 보류 사유(업무 현황, 유건 10/8) — 보류인 일에만. 서버 office_task_write task.status { status: 'hold', hold_reason, reason_only: true }(이미 보류면 사유만, 아니면 task_conflict).
 *  권한은 상태 바꾸기와 같다. 앞뒤 공백을 걷고 비면 null(사유 지우기), 500자까지, 같은 값이면 쓰지 않는다. 끝낸 일은 바꾸지 않는다 */
export const HOLD_REASON_MAX = 500;
export function planHoldReason(it, value, ctx) {
  if (it.kind !== 'task') return no('eventStatus');
  if (it.done) return no('done');
  if (statusOf(it.src) !== 'hold') return no('input');
  const r = whyNot(it, 'status', ctx);
  if (r) return no(r);
  const v = String(value ?? '').trim() || null;
  if (v && v.length > HOLD_REASON_MAX) return no('input');
  if ((it.src.hold_reason ?? null) === v) return { write: null };
  return taskWrite(it, 'task.status', { status: 'hold', hold_reason: v, reason_only: true }, { hold_reason: v }); // reason_only: 그사이 보류가 풀렸으면 서버가 상태를 되돌리지 않고 task_conflict
}
/** 할 일 한 칸 고치기(할 일 패널) — 제목·메모·중요도·시작일·기한. 값이 같으면 쓰지 않고, 시작일이 기한보다 늦으면 거절 */
export function planField(it, field, value, ctx) {
  if (it.kind !== 'task') return no('eventPerm');
  const r = whyNot(it, field === 'due_on' ? 'date' : 'edit', ctx);
  if (r) return no(r);
  const t = it.src;
  let v = value;
  if (field === 'title') { v = String(value ?? '').trim(); if (!v || v.length > 200) return no('input'); }
  if (field === 'note') { v = String(value ?? ''); if (v.length > 4000) return no('input'); }
  if (field === 'priority') { v = Number(value); if (!PRIORITIES.includes(v)) return no('input'); }
  if (field === 'starts_on' || field === 'due_on') {
    v = value || null;
    const start = field === 'starts_on' ? v : t.starts_on || null, due = field === 'due_on' ? v : t.due_on || null;
    if (start && due && start > due) return no('dates');
  }
  const cur = field === 'priority' ? priorityOf(t) : field === 'note' ? t.note ?? '' : t[field] ?? null;
  if (cur === v) return { write: null };
  return taskWrite(it, FIELD_ACTION[field], { [field]: v }, { [field]: v });
}
/** 묶음 진행률 — 그 묶음의 할 일 중 끝낸 수/전체(일정은 세지 않는다) */
export function progressOf(list) {
  const tasks = list.filter((x) => x.kind === 'task');
  return { done: tasks.filter((x) => x.done).length, total: tasks.length };
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
/** 복제 — 일정은 이 회차 시각의 한 번짜리 일정, 할 일은 같은 제목·기한·분류·중요도로 나에게(상태는 새로 할 일) */
export function planDuplicate(it, ctx, id) {
  if (it.kind === 'task') return { write: { type: 'task', space: it.space, action: 'task.create', data: { id, title: it.title, due_on: it.day, priority: it.priority, category_id: it.categoryId, starts_on: it.starts && (!it.day || it.starts <= it.day) ? it.starts : null } } };
  const o = it.src;
  return { write: { type: 'event.save', row: eventRow(o, { id, starts_at: new Date(o.start).toISOString(), ends_at: new Date(o.end).toISOString(), rrule: null, exdates: [], parent_id: null, recur_on: null }) } };
}

/** 칸반에서 칸을 옮기면 — 그 칸의 속성이 바뀐다. 같은 칸이면 write: null */
export function planMove(it, by, to, ctx) {
  if (keyOf(it, by, ctx.today) === to) return { write: null };
  if (by === 'status') {
    if (it.kind === 'event') return no('eventStatus');
    return to === 'event' ? no('taskToEvent') : planStatus(it, to, ctx);
  }
  if (by === 'date') { const tg = bucketTarget(to, ctx.today); return tg.reason ? no(tg.reason) : planDate(it, tg.day, ctx); }
  if (by === 'category' && it.kind === 'task') { // 할 일 분류는 그 공간의 분류 표에서 이름으로 찾는다(없는 이름 칸 = 일정에만 있는 분류)
    if (to === 'none') return planTaskCategory(it, null, '', ctx);
    const id = ctx.categoryOf?.(it.space, to.slice(2));
    return id ? planTaskCategory(it, id, to.slice(2), ctx) : no('taskCategoryMissing');
  }
  if (by === 'category') return planCategory(it, to === 'none' ? '' : to.slice(2), ctx);
  if (by === 'customer') return planCustomer(it, to === 'none' ? null : to.slice(2), ctx);
  if (it.kind === 'event') return no('eventWho');
  if (!to.startsWith('p:')) return no('taskAgent');
  return planAssign(it, to.slice(2), ctx);
}

/** 여러 항목에 같은 계획 — { writes, skipped: [{ item, reason }], same(바꿀 것 없던 수) }. 한 항목이 쓰기 둘(다시 열기 + 상태)이면 차례대로 넣는다 */
export function planMany(items, plan) {
  const writes = [], skipped = [];
  let same = 0;
  for (const it of items) {
    const p = plan(it);
    if (p.reason) skipped.push({ item: it, reason: p.reason });
    else if (p.write) writes.push(...[].concat(p.write));
    else same++;
  }
  return { writes, skipped, same };
}
/** 계획 결과의 쓰기 목록(없으면 빈 목록) */
export const writesOf = (plan) => (plan?.write ? [].concat(plan.write) : []);

/** '날짜 바꾸기' 창의 처음 날짜(OFC-16) — 고른 첫 항목의 날짜, 없으면 오늘(한국 날짜). UTC로 잡으면 한국 오전 9시 전에는 어제가 들어가 바로 '기한 지남'이 됐다 */
export const askDay = (items, now = Date.now()) => items[0]?.day ?? M.kstDay(now);
