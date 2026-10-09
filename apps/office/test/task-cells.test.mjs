// 할 일 표에서 바로 바꾸기·캘린더에서 바로 끝내기(유건 10/9) — views/cells.js 순수 계산.
// 칸마다: 바꿀 수 있는가(서버 office_task_write와 같은 판정), 고를 값 목록, 고른 값의 쓰기(할 일 패널과 같은 계획 함수).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../src/views/cells.js';
import * as V from '../src/views/model.js';
import { VIEWS_DICT } from '../src/views/views-i18n.js';

const TODAY = '2026-10-09';
const ME = 'u-me';
const ctx = (over = {}) => ({ today: TODAY, me: ME, isAdmin: (s) => s === 'org-admin', members: (s) => (s.startsWith('org') ? new Set([ME, 'u-jun', 'u-min']) : null), categoryOf: () => null, ...over });
const row = (over) => ({ id: 't1', title: '할 일', due_on: '2026-10-12', assignee: ME, created_by: ME, done_at: null, status: 'todo', priority: 2, category_id: null, category: null, starts_on: null, note: '', hold_reason: null, space: 'me', ...over });
const task = (over) => V.taskItem(row(over));
const ev = { key: 'e:e1', kind: 'event', id: 'e1', title: '회의', day: TODAY, last: TODAY, done: false, canEdit: true, recurring: false, src: {} };
const writes = (plan) => V.writesOf(plan).map((w) => [w.action, w.data]);

// 이유: 표 칸에서 못 바꾸는 값을 단추로 그리면 눌러도 거절 알림만 뜬다 — 할 일 패널의 잠금과 같은 규칙으로 글자만 보인다
test('cellWhyNot: 내 개인 할 일은 맡은 사람 말고 다 바꾼다', () => {
  const it = task();
  assert.deepEqual(C.CELLS.map((c) => [c, C.cellWhyNot(it, c, ctx())]), [['status', null], ['priority', null], ['category', null], ['assign', 'personal'], ['starts_on', null], ['due_on', null]]);
});
test('cellWhyNot: 관리자가 나에게 맡긴 조직 할 일은 상태만, 관리자는 맡은 사람까지 다', () => {
  const given = task({ space: 'org-plain', created_by: 'u-boss' });
  assert.deepEqual(C.CELLS.map((c) => C.cellWhyNot(given, c, ctx())), [null, 'taskPerm', 'taskPerm', 'assignAdmin', 'taskPerm', 'taskPerm']);
  const admin = task({ space: 'org-admin', created_by: 'u-jun', assignee: 'u-jun' });
  assert.deepEqual(C.CELLS.map((c) => C.cellWhyNot(admin, c, ctx())), [null, null, null, null, null, null]);
  const others = task({ space: 'org-plain', created_by: 'u-jun', assignee: 'u-jun' });
  assert.equal(C.cellWhyNot(others, 'status', ctx()), 'taskPerm', '남이 맡은 일은 상태도 못 바꾼다');
});
test('cellWhyNot: 끝낸 일은 상태(다시 열기)만, 일정은 아무 칸도', () => {
  const done = task({ done_at: '2026-10-08T03:00:00Z' });
  assert.deepEqual(C.CELLS.map((c) => C.cellWhyNot(done, c, ctx())), [null, 'done', 'done', 'personal', 'done', 'done']);
  assert.ok(C.CELLS.every((c) => C.cellWhyNot(ev, c, ctx())));
  assert.equal(C.cellWhyNot(task(), 'nope', ctx()), 'input');
});

// 이유: 드롭다운에는 지금 값이 표시되어야 하고, 지워졌거나 목록 밖인 지금 값도 사라지지 않게 남긴다(할 일 패널 select와 같다)
test('cellOptions: 상태 4개·중요도 3개, 지금 값에 표시', () => {
  assert.deepEqual(C.cellOptions(task({ status: 'hold' }), 'status').map((o) => [o.value, o.checked]), [['todo', false], ['doing', false], ['hold', true], ['done', false]]);
  assert.deepEqual(C.cellOptions(task({ status: 'hold', done_at: 'x' }), 'status').find((o) => o.checked).value, 'done', '끝낸 일은 끝냄에 표시');
  assert.deepEqual(C.cellOptions(task({ priority: 1 }), 'priority').map((o) => [o.value, o.checked]), [[1, true], [2, false], [3, false]]);
});
test('cellOptions: 분류는 미분류 → 그 공간 분류(관리 순서), 목록에 없는 지금 분류도 남긴다', () => {
  const cats = [{ id: 'c-sales', name: '영업' }, { id: 'c-tax', name: '세무' }];
  assert.deepEqual(C.cellOptions(task({ category_id: 'c-tax', category: '세무' }), 'category', { categories: cats }).map((o) => [o.value, o.name, o.checked]),
    [[null, '', false], ['c-sales', '영업', false], ['c-tax', '세무', true]]);
  assert.deepEqual(C.cellOptions(task(), 'category', { categories: cats })[0], { value: null, name: '', checked: true });
  assert.deepEqual(C.cellOptions(task({ category_id: 'c-old', category: '옛 분류' }), 'category', { categories: cats }).at(-1), { value: 'c-old', name: '옛 분류', checked: true });
});
test('cellOptions: 맡은 사람은 손님 뺀 직원, 목록 밖의 지금 맡은 사람도 남긴다', () => {
  const people = [{ user_id: ME, name: '김유건' }, { user_id: 'u-jun', name: '박준' }, { user_id: 'u-g', name: '손님', role: 'guest' }];
  const it = task({ space: 'org-admin', assignee: 'u-jun' });
  assert.deepEqual(C.cellOptions(it, 'assign', { people }).map((o) => [o.value, o.checked]), [[ME, false], ['u-jun', true]]);
  const gone = task({ space: 'org-admin', assignee: 'u-left' });
  assert.deepEqual(C.cellOptions(gone, 'assign', { people, nameOf: () => '나간 사람' }).at(-1), { value: 'u-left', name: '나간 사람', checked: true });
  assert.deepEqual(C.cellOptions(task(), 'starts_on'), [], '날짜 칸은 목록이 없다(날짜 고르기)');
});

// 이유: 표에서 고른 값은 할 일 패널과 같은 계획 함수로 쓴다 — 서버로 가는 요청 모양이 패널과 같아야 기록·권한·충돌 처리가 같다
test('planCell: 상태·중요도·분류·맡은 사람·시작일·기한 → 패널과 같은 쓰기', () => {
  const c = ctx();
  assert.deepEqual(writes(C.planCell(task(), 'status', 'hold', c)), [['task.status', { id: 't1', status: 'hold' }]], '보류는 패널처럼 상태만(사유는 패널 사유 칸에서)');
  assert.deepEqual(writes(C.planCell(task({ done_at: 'x', status: 'todo' }), 'status', 'doing', c)), [['task.reopen', { id: 't1' }], ['task.status', { id: 't1', status: 'doing' }]]);
  assert.deepEqual(writes(C.planCell(task(), 'status', 'done', c)), [['task.done', { id: 't1' }]]);
  assert.deepEqual(writes(C.planCell(task(), 'priority', 1, c)), [['task.priority', { id: 't1', priority: 1 }]]);
  const cats = [{ id: 'c-sales', name: '영업' }];
  const cat = C.planCell(task(), 'category', 'c-sales', c, { categories: cats });
  assert.deepEqual(writes(cat), [['task.category', { id: 't1', category_id: 'c-sales' }]]);
  assert.deepEqual(cat.write.patch, { category_id: 'c-sales', category: '영업' }, '표에 분류 이름이 바로 보이게');
  assert.deepEqual(writes(C.planCell(task({ category_id: 'c-sales', category: '영업' }), 'category', null, c, { categories: cats })), [['task.category', { id: 't1', category_id: null }]]);
  assert.deepEqual(writes(C.planCell(task({ space: 'org-admin' }), 'assign', 'u-jun', c)), [['task.assign', { id: 't1', assignee: 'u-jun' }]]);
  assert.deepEqual(writes(C.planCell(task(), 'starts_on', '2026-10-10', c)), [['task.start', { id: 't1', starts_on: '2026-10-10' }]]);
  assert.deepEqual(writes(C.planCell(task(), 'due_on', '', c)), [['task.due', { id: 't1', due_on: null }]], '기한 지우기');
});
test('planCell: 같은 값이면 쓰지 않고, 시작일이 기한보다 늦으면·권한이 없으면 이유', () => {
  const c = ctx();
  assert.equal(C.planCell(task({ priority: 2 }), 'priority', 2, c).write, null);
  assert.equal(C.planCell(task({ status: 'doing' }), 'status', 'doing', c).write, null);
  assert.equal(C.planCell(task(), 'due_on', '2026-10-12', c).write, null);
  assert.equal(C.planCell(task(), 'starts_on', '2026-10-20', c).reason, 'dates');
  assert.equal(C.planCell(task({ starts_on: '2026-10-11' }), 'due_on', '2026-10-10', c).reason, 'dates');
  assert.equal(C.planCell(task({ space: 'org-plain', created_by: 'u-boss' }), 'priority', 1, c).reason, 'taskPerm');
  assert.equal(C.planCell(task({ space: 'org-admin' }), 'assign', 'u-stranger', c).reason, 'member');
  assert.equal(C.planCell(task(), 'nope', 1, c).reason, 'input');
});

// 이유: 보류 사유는 할 일 패널의 사유 칸 규칙 그대로 쓴다(유건 10/8) — 표·캘린더에서 보류로 바꾸면 '사유 적기'로 그 칸을 바로 열어 준다. 이미 보류였으면 안내하지 않는다
test('askHoldReason: 보류가 아니던 일을 보류로 바꿀 때만', () => {
  assert.equal(C.askHoldReason(task(), 'hold'), true);
  assert.equal(C.askHoldReason(task({ status: 'doing' }), 'hold'), true);
  assert.equal(C.askHoldReason(task({ status: 'hold', done_at: 'x' }), 'hold'), true, '끝낸 일을 다시 열어 보류로');
  assert.equal(C.askHoldReason(task({ status: 'hold' }), 'hold'), false);
  assert.equal(C.askHoldReason(task(), 'doing'), false);
  assert.equal(C.askHoldReason(ev, 'hold'), false);
});

// 이유: 캘린더 할 일 칩의 ✓는 보이기만 하고 누르면 패널이 열렸다 — 이제 누르면 끝내기·다시 열기(목록·표의 동그라미와 같은 계획)
test('toggleDone: 열린 일은 끝내기, 끝낸 일은 다시 열기, 남의 일은 이유', () => {
  assert.deepEqual(writes(C.toggleDone(task(), ctx())), [['task.done', { id: 't1' }]]);
  assert.deepEqual(writes(C.toggleDone(task({ done_at: 'x' }), ctx())), [['task.reopen', { id: 't1' }]]);
  assert.equal(C.toggleDone(task({ space: 'org-plain', assignee: 'u-jun', created_by: 'u-jun' }), ctx()).reason, 'taskPerm');
  assert.equal(C.toggleDone(ev, ctx()).reason, 'eventStatus');
});

// 이유(유건 10/9): 메모가 4줄쯤만 보이고 스크롤됐다 — 처음 9줄 높이에서 시작해 글 길이만큼 자란다
test('noteHeight: 최소 9줄, 글이 길면 글 높이만큼', () => {
  assert.equal(C.noteHeight(40, 21), 9 * 21 + 18);
  assert.equal(C.noteHeight(900, 21), 900);
  assert.equal(C.noteHeight(0, 0), C.NOTE_MIN_LINES * 21 + 18, '줄 높이를 못 읽으면 21px로');
});

test('사전: 새 문구는 ko·en 둘 다, 한국어에는 영문자가 없다', () => {
  for (const key of ['tasks.held', 'tasks.addReason', 'tasks.clearDate', 'tasks.cell']) {
    const [ko, en] = VIEWS_DICT[key] ?? [];
    assert.ok(ko && en, key);
    assert.doesNotMatch(ko.replace(/\{\w+\}/g, ''), /[A-Za-z]/, key);
  }
});
