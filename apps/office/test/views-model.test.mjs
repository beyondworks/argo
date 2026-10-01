// 여러 보기 순수 계산(유건 9/30 명세) — 합치기·거르기·정렬·칸반 칸·칸 이동과 한꺼번에 바꾸기가 무엇을 쓰는지/왜 거절하는지.
// 브라우저 시간대가 한국이 아닌 경우도 본다 — 시간 일정은 브라우저 시각을 그대로 두고 날짜만 옮겨야 한다.
process.env.TZ = 'America/New_York';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as V from '../src/views/model.js';
import { expand, localTime, localDay } from '../src/calendar/model.js';

const TODAY = '2026-09-30'; // 수요일 — 이번 주 일요일은 10-04
const ME = 'u-me';
const ctx = (over = {}) => ({ today: TODAY, me: ME, isAdmin: (s) => s === 'org-admin', members: (s) => (s === 'org-admin' ? new Set([ME, 'u-a']) : null), ...over });
const row = (over) => ({ id: 'e1', title: '회의', org_id: 'o1', visibility: 'org', owner: ME, crew: null, all_day: false, category: '', customer_id: null, exdates: [], rrule: null, parent_id: null, recur_on: null, can_edit: true,
  starts_at: '2026-10-01T14:00:00.000Z', ends_at: '2026-10-01T15:00:00.000Z', ...over }); // 뉴욕 10:00~11:00
const ev = (over) => V.eventItem(expand([row(over)], Date.parse('2026-09-01'), Date.parse('2026-11-30'))[0]);
const task = (over) => V.taskItem({ id: 't1', title: '할 일', due_on: '2026-10-02', assignee: ME, created_by: ME, done_at: null, space: 'me', ...over });

// 이유: 저장은 두 곳(일정·할 일)이고 보기에서만 합친다 — 할 일은 창 안 기한, 기한 없는 열린 일, 지난 열린 일(요청 시)만 들어가고 취소한 일은 빠진다.
test('mergeItems: 기간 창·기한 없음·지남·취소', () => {
  const tasks = [
    { id: 'a', title: 'a', due_on: '2026-10-02', assignee: ME, space: 'me' },
    { id: 'b', title: 'b', due_on: null, assignee: ME, space: 'me' },
    { id: 'c', title: 'c', due_on: '2026-09-20', assignee: ME, space: 'me' },
    { id: 'd', title: 'd', due_on: '2026-09-20', assignee: ME, done_at: '2026-09-21T01:00:00Z', space: 'me' },
    { id: 'e', title: 'e', due_on: '2026-10-03', assignee: ME, cancelled_at: '2026-09-29T00:00:00Z', space: 'me' },
    { id: 'f', title: 'f', due_on: '2026-12-01', assignee: ME, space: 'me' },
  ];
  const keys = (list) => list.map((x) => x.key).sort();
  assert.deepEqual(keys(V.mergeItems([], tasks, { from: TODAY, to: '2026-10-31' })), ['t:a']);
  assert.deepEqual(keys(V.mergeItems([], tasks, { from: TODAY, to: '2026-10-31', undated: true, overdue: true })), ['t:a', 't:b', 't:c']);
  const one = V.mergeItems(expand([row({})], Date.parse('2026-09-01'), Date.parse('2026-11-30')), [], { from: TODAY, to: '2026-10-31' });
  assert.equal(one[0].kind, 'event'); assert.equal(one[0].day, '2026-10-01');
});

// 이유: 필터는 담당·분류·기간·종류, 정렬은 날짜(날짜 없는 것은 뒤)·제목·만든 순 — 명세 규칙 5.
test('filterItems·sortItems', () => {
  const items = [ev({ id: 'x', title: '나', category: '영업' }), task({ id: 'y', title: '가', due_on: null, created_at: '2026-09-01T00:00:00Z' }), task({ id: 'z', title: '다', due_on: '2026-09-28', created_at: '2026-08-01T00:00:00Z' })];
  const f = (over) => V.filterItems(items, { kind: 'all', who: 'all', category: 'all', period: 'all', ...over }, TODAY).map((x) => x.id);
  assert.deepEqual(f({ kind: 'task' }), ['y', 'z']);
  assert.deepEqual(f({ category: '영업' }), ['x']);
  assert.deepEqual(f({ category: 'none' }), ['y', 'z']);
  assert.deepEqual(f({ period: 'overdue' }), ['z']);
  assert.deepEqual(f({ period: 'week' }), ['x']);
  assert.deepEqual(V.sortItems(items, 'date').map((x) => x.id), ['z', 'x', 'y']);
  assert.deepEqual(V.sortItems(items, 'title').map((x) => x.id), ['y', 'x', 'z']);
  assert.deepEqual(V.sortItems(items, 'created').map((x) => x.id), ['x', 'z', 'y']); // 만든 시각 없는 것(0)이 가장 먼저
});

// 이유: 칸반 날짜 칸은 기한 지남·오늘·이번 주(내일~일요일)·나중·날짜 없음, 상태·날짜 칸은 비어 있어도 놓을 수 있게 늘 있다.
test('칸 키와 칸 순서', () => {
  assert.equal(V.bucketOf('2026-09-29', TODAY), 'overdue');
  assert.equal(V.bucketOf(TODAY, TODAY), 'today');
  assert.equal(V.bucketOf('2026-10-04', TODAY), 'week');
  assert.equal(V.bucketOf('2026-10-05', TODAY), 'later');
  assert.equal(V.bucketOf(null, TODAY), 'none');
  const items = [ev({ category: '영업' }), task({ done_at: '2026-09-30T00:00:00Z' })];
  assert.deepEqual(V.groupItems(items, 'status', { today: TODAY, me: ME }).map(([k, l]) => [k, l.length]), [['event', 1], ['todo', 0], ['done', 1]]);
  assert.deepEqual(V.groupItems(items, 'status', { today: TODAY, me: ME, kind: 'task' }).map(([k]) => k), ['todo', 'done']);
  assert.deepEqual(V.groupItems(items, 'date', { today: TODAY, me: ME }).map(([k]) => k), ['overdue', 'today', 'week', 'later', 'none']);
  assert.deepEqual(V.groupItems(items, 'category', { today: TODAY, me: ME }).map(([k]) => k), ['c:영업', 'none']);
  const who = [task({ id: '1', assignee: 'u-b' }), ev({ crew: 'crew-luna' }), task({ id: '2' })];
  assert.deepEqual(V.groupItems(who, 'who', { today: TODAY, me: ME }).map(([k]) => k), [`p:${ME}`, 'p:u-b', 'a:crew-luna']);
});

// 이유: 칸을 옮기면 그 속성이 바뀐다 — 상태(할 일 완료↔할 일), 날짜(할 일은 기한), 분류·거래처(일정만). 같은 칸이면 쓰지 않는다.
test('planMove: 바꾸는 것', () => {
  const c = ctx();
  assert.deepEqual(V.planMove(task(), 'status', 'done', c).write.action, 'task.done');
  assert.equal(V.planMove(task({ done_at: 'x' }), 'status', 'todo', c).write.action, 'task.reopen');
  assert.equal(V.planMove(task(), 'status', 'todo', c).write, null);
  assert.deepEqual(V.planMove(task(), 'date', 'today', c).write.data, { id: 't1', due_on: TODAY });
  assert.deepEqual(V.planMove(task(), 'date', 'later', c).write.data, { id: 't1', due_on: '2026-10-05' }); // 다음 주 월요일
  assert.deepEqual(V.planMove(task(), 'date', 'none', c).write.data, { id: 't1', due_on: null });
  const cat = V.planMove(ev({}), 'category', 'c:영업', c).write;
  assert.equal(cat.type, 'event.save'); assert.equal(cat.row.category, '영업'); assert.equal(cat.row.starts_at, row({}).starts_at);
  assert.equal(V.planMove(ev({ customer_id: 'u1' }), 'customer', 'none', c).write.row.customer_id, null);
  assert.equal(V.planMove(task({ space: 'org-admin', assignee: ME }), 'who', 'p:u-a', c).write.action, 'task.assign');
});

// 이유: 일정은 시각을 그대로 두고 날짜만 옮긴다(브라우저 시각). 종일은 기간 길이를 그대로.
test('planMove 날짜: 일정 시각·종일 기간 유지', () => {
  const w = V.planMove(ev({}), 'date', 'later', ctx()).write.row; // 10-01 10:00(뉴욕) → 10-05 10:00
  assert.equal(localDay(Date.parse(w.starts_at)), '2026-10-05');
  assert.equal(localTime(Date.parse(w.starts_at)), '10:00');
  assert.equal(Date.parse(w.ends_at) - Date.parse(w.starts_at), 3600e3);
  const all = ev({ all_day: true, starts_at: '2026-09-30T15:00:00.000Z', ends_at: '2026-10-02T15:00:00.000Z' }); // 한국 10-01~10-02
  const a = V.planDate(all, '2026-10-10', ctx()).write.row;
  assert.equal(a.starts_at, '2026-10-09T15:00:00.000Z'); assert.equal(a.ends_at, '2026-10-11T15:00:00.000Z');
});

// 이유: 바꿀 수 없는 이동은 카드가 제자리로 가고 이유를 알린다 — 이유 키가 사전(views.why.*)과 짝이다.
test('planMove: 거절 이유', () => {
  const c = ctx();
  const why = (it, by, to, cx = c) => V.planMove(it, by, to, cx).reason;
  assert.equal(why(ev({}), 'status', 'done'), 'eventStatus');
  assert.equal(why(task(), 'status', 'event'), 'taskToEvent');
  assert.equal(why(task(), 'category', 'c:영업'), 'taskCategory');
  assert.equal(why(task(), 'customer', 'u:c1'), 'taskCustomer');
  assert.equal(why(ev({}), 'who', 'p:u-a'), 'eventWho');
  assert.equal(why(task({ space: 'org-admin' }), 'who', 'a:crew-luna'), 'taskAgent');
  assert.equal(why(task(), 'who', 'p:u-a'), 'personal');
  assert.equal(why(task({ space: 'org-member' }), 'who', 'p:u-a'), 'assignAdmin');
  assert.equal(why(task({ space: 'org-admin' }), 'who', 'p:u-x'), 'member');
  assert.equal(why(task({ done_at: 'x' }), 'date', 'today'), 'done');
  assert.equal(why(task(), 'date', 'overdue'), 'past');
  assert.equal(why(task(), 'date', 'week', ctx({ today: '2026-10-04' })), 'weekOver'); // 일요일엔 이번 주에 남은 날이 없다
  assert.equal(why(ev({}), 'date', 'none'), 'eventNeedsDate');
  assert.equal(why(ev({ can_edit: false }), 'category', 'c:영업'), 'eventPerm');
  const series = V.eventItem(expand([row({ rrule: 'FREQ=WEEKLY' })], Date.parse('2026-10-01'), Date.parse('2026-10-20'))[1]);
  assert.equal(why(series, 'category', 'c:영업'), 'recurring');
});

// 이유: 할 일 권한은 서버 office_task_write와 같아야 한다 — 남이 맡긴 일은 끝내기만, 기한은 내가 만들고 내가 맡은 일만(관리자는 다).
test('taskCan: 서버와 같은 권한', () => {
  const given = { assignee: ME, created_by: 'u-boss' };
  assert.equal(V.taskCan('task.done', given, ME, false), true);
  assert.equal(V.taskCan('task.due', given, ME, false), false);
  assert.equal(V.taskCan('task.cancel', { assignee: 'u-a', created_by: ME }, ME, false), false); // 관리자가 남에게 다시 맡긴 일
  assert.equal(V.taskCan('task.assign', { assignee: ME, created_by: ME }, ME, false), false);
  assert.equal(V.taskCan('task.due', given, ME, true), true);
  assert.equal(V.planMove(task({ space: 'org-member', created_by: 'u-boss' }), 'date', 'today', ctx()).reason, 'taskPerm');
});

// 이유: 한꺼번에 바꾸기는 되는 것만 쓰고 나머지는 이유와 함께 건너뛴다. 지우기는 일정 삭제(반복은 이 회차만), 할 일은 취소.
test('planMany·planDelete·planDuplicate', () => {
  const c = ctx(), series = V.eventItem(expand([row({ rrule: 'FREQ=WEEKLY' })], Date.parse('2026-10-01'), Date.parse('2026-10-20'))[1]);
  const r = V.planMany([task(), ev({}), task({ id: 't2', done_at: 'x' })], (x) => V.planDate(x, '2026-10-09', c));
  assert.equal(r.writes.length, 2); assert.deepEqual(r.skipped.map((s) => s.reason), ['done']);
  assert.deepEqual(V.planDelete(task(), c).write, { type: 'task', space: 'me', action: 'task.cancel', data: { id: 't1' }, patch: undefined });
  assert.deepEqual(V.planDelete(series, c).write, { type: 'event.skip', id: 'e1', day: '2026-10-08' });
  assert.deepEqual(V.planDelete(ev({}), c).write, { type: 'event.delete', id: 'e1' });
  const d = V.planDuplicate(series, c, 'new').write.row;
  assert.equal(d.id, 'new'); assert.equal(d.rrule, null); assert.equal(localDay(Date.parse(d.starts_at)), '2026-10-08');
});

// 이유: 저장된 설정이 망가졌거나 예전 값이어도 화면이 깨지지 않게 — 모르는 값은 기본값, 이 자리에서 못 고르는 보기는 첫 보기.
test('normalizeCfg', () => {
  assert.deepEqual(V.normalizeCfg(null), { view: 'list', group: 'status', sort: 'date', filter: { kind: 'all', who: 'all', category: 'all', period: 'all' } });
  const c = V.normalizeCfg({ view: 'customers', group: 'x', sort: 'title', filter: { kind: 'task', period: 'nope', who: 5 } }, { view: 'month' });
  assert.deepEqual(c, { view: 'month', group: 'status', sort: 'title', filter: { kind: 'task', who: 'all', category: 'all', period: 'all' } });
  assert.equal(V.normalizeCfg({ view: 'tasks' }, { view: 'tasks' }, ['tasks', 'list']).view, 'tasks');
  assert.equal(V.normalizeCfg({ view: 'day' }, {}, ['list', 'week']).view, 'list');
});
