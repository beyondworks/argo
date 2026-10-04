// 할 일 속성(유건 10/4 확정, 오피스 14차 트랙 T) — 상태(할 일·진행 중·보류 + 끝냄)·중요도·분류·시작일의 보기 계산과 쓰기 계획.
// 권한은 서버 office_task_write와 같아야 한다: 맡은 사람은 끝내기·다시 열기·상태 바꾸기, 내용(제목·기한·메모·분류·중요도·시작일)은 내가 만들고 내가 맡은 일만(관리자는 다).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as V from '../src/views/model.js';
import { pageExcerpt } from '../src/views/task-text.js';
import { readFileSync } from 'node:fs';
import { TASK_DICT } from '../src/pages/task-i18n.js';
import { VIEWS_DICT } from '../src/views/views-i18n.js';

const TODAY = '2026-10-04';
const ME = 'u-me';
const ctx = (over = {}) => ({ today: TODAY, me: ME, isAdmin: (s) => s === 'org-admin', members: () => null, categoryOf: (space, name) => ({ 'me:영업': 'c-sales', 'me:세무': 'c-tax' })[`${space}:${name}`] ?? null, ...over });
const row = (over) => ({ id: 't1', title: '할 일', due_on: '2026-10-10', assignee: ME, created_by: ME, done_at: null, status: 'todo', priority: 2, category_id: null, category: null, starts_on: null, note: '', space: 'me', ...over });
const task = (over) => V.taskItem(row(over));
const ev = (over = {}) => ({ key: `e:${over.id ?? 'e1'}`, kind: 'event', id: 'e1', title: '회의', day: '2026-10-05', last: '2026-10-05', start: Date.parse('2026-10-05T01:00:00Z'), end: Date.parse('2026-10-05T02:00:00Z'), allDay: false, done: false, category: '', customer: '', customerName: '', who: '', canEdit: true, recurring: false, created: 0, src: {}, ...over });

// 이유: 보이는 상태는 하나 — 끝낸 일은 저장된 상태와 상관없이 '끝냄', 분류 이름은 분류 id가 있을 때만(지운 분류의 옛 이름이 남지 않게)
test('taskItem: 상태·중요도·분류·시작일, 끝낸 일은 끝냄, 모르는 값은 기본값', () => {
  const t = task({ status: 'doing', priority: 1, category_id: 'c-sales', category: '영업', starts_on: '2026-10-01' });
  assert.deepEqual([t.status, t.priority, t.categoryId, t.category, t.starts], ['doing', 1, 'c-sales', '영업', '2026-10-01']);
  assert.equal(task({ status: 'hold', done_at: '2026-10-03T00:00:00Z' }).status, 'done');
  assert.deepEqual([task({ status: 'nope', priority: 9 }).status, task({ status: 'nope', priority: 9 }).priority], ['todo', 2]);
  assert.equal(task({ category_id: null, category: '남은 이름' }).category, '');
  assert.equal(V.statusOf(row({ status: 'hold', done_at: 'x' })), 'hold', '다시 열면 돌아갈 상태는 저장된 상태');
});

// 이유: 거르기에 상태·중요도가 생겼다 — '끝내지 않은 일'은 진행 중·보류도 포함, 일정은 상태·중요도가 없어 그 거르기에서 빠진다
test('filterItems: 상태(끝내지 않은 일 포함)·중요도, 일정은 빠진다', () => {
  const items = [task({ id: 'a', status: 'doing' }), task({ id: 'b', status: 'hold', priority: 1 }), task({ id: 'c', done_at: '2026-10-02T00:00:00Z' }), task({ id: 'd' }), ev()];
  const f = (over) => V.filterItems(items, { kind: 'all', who: 'all', category: 'all', period: 'all', status: 'all', priority: 'all', ...over }, TODAY).map((x) => x.id);
  assert.deepEqual(f({}), ['a', 'b', 'c', 'd', 'e1']);
  assert.deepEqual(f({ status: 'open' }), ['a', 'b', 'd']);
  assert.deepEqual(f({ status: 'hold' }), ['b']);
  assert.deepEqual(f({ status: 'done' }), ['c']);
  assert.deepEqual(f({ priority: '1' }), ['b']);
  assert.deepEqual(f({ priority: '2' }), ['a', 'c', 'd']);
  assert.deepEqual(V.filterItems(items, { kind: 'all', who: 'all', category: 'all', period: 'all' }, TODAY).length, 5, '예전 저장값(상태·중요도 칸 없음)도 그대로');
});

// 이유(인트라넷 업무 보드와 같거나 낫게): 기한·중요도·만든 날을 오름·내림으로. 날짜 없는 일은 어느 방향이든 뒤, 중요도가 없는 일정도 뒤
test('sortItems: 기한 내림차순(날짜 없음은 뒤)·중요도순(같으면 기한순)·만든 날 내림차순', () => {
  const items = [task({ id: 'a', due_on: '2026-10-08', priority: 3, created_at: '2026-09-01T00:00:00Z' }), task({ id: 'b', due_on: null, priority: 1, created_at: '2026-09-03T00:00:00Z' }),
    task({ id: 'c', due_on: '2026-10-06', priority: 1, created_at: '2026-09-02T00:00:00Z' }), ev({ id: 'e1', key: 'e:e1', day: '2026-10-07', last: '2026-10-07' })];
  const ids = (sort, dir) => V.sortItems(items, sort, dir).map((x) => x.id);
  assert.deepEqual(ids('date', 'asc'), ['c', 'e1', 'a', 'b']);
  assert.deepEqual(ids('date', 'desc'), ['a', 'e1', 'c', 'b']);
  assert.deepEqual(ids('priority', 'asc'), ['c', 'b', 'a', 'e1'], '높음 먼저, 같은 높음은 기한 있는 것 먼저, 일정은 뒤');
  assert.deepEqual(ids('priority', 'desc'), ['a', 'c', 'b', 'e1']);
  assert.deepEqual(ids('created', 'desc').slice(0, 3), ['b', 'c', 'a']);
  assert.deepEqual(ids('date'), ids('date', 'asc'), '방향이 없으면 오름차순(예전 호출)');
});

// 이유: 칸반 상태 칸은 할 일·진행 중·보류·끝냄, 분류 칸은 분류 관리 순서이고 빈 분류도 칸이 있어야 끌어 놓을 수 있다
test('groupItems: 상태 4칸, 분류는 관리 순서(빈 분류 포함) → 그 밖의 이름 → 미분류', () => {
  const items = [task({ id: 'a', status: 'doing', category_id: 'c-tax', category: '세무' }), task({ id: 'b', status: 'hold' }), task({ id: 'c', done_at: 'x', category_id: 'c-x', category: '기타' })];
  const st = V.groupItems(items, 'status', { today: TODAY, me: ME, kind: 'task' });
  assert.deepEqual(st.map(([k, l]) => [k, l.map((x) => x.id)]), [['todo', []], ['doing', ['a']], ['hold', ['b']], ['done', ['c']]]);
  const cats = V.groupItems(items, 'category', { today: TODAY, me: ME, kind: 'task', cats: ['영업', '세무'] });
  assert.deepEqual(cats.map(([k, l]) => [k, l.length]), [['c:영업', 0], ['c:세무', 1], ['c:기타', 1], ['none', 1]]);
});

test('progressOf: 묶음의 할 일 중 끝낸 수/전체(일정은 세지 않는다)', () => {
  assert.deepEqual(V.progressOf([task({ id: 'a', done_at: 'x' }), task({ id: 'b' }), ev()]), { done: 1, total: 2 });
  assert.deepEqual(V.progressOf([]), { done: 0, total: 0 });
});

// 이유(서버 office_task_write와 같은 판정): 맡은 사람은 상태를 바꾼다(할 일↔진행 중↔보류), 내용은 내가 만들고 내가 맡은 일만
test('taskCan: 새 동작 권한 — 서버 규칙 표와 같다', () => {
  const given = { assignee: ME, created_by: 'u-boss' }, mine = { assignee: ME, created_by: ME }, others = { assignee: 'u-a', created_by: ME };
  for (const a of ['task.done', 'task.reopen', 'task.status']) { assert.equal(V.taskCan(a, given, ME, false), true, a); assert.equal(V.taskCan(a, others, ME, false), false, a); }
  for (const a of ['task.title', 'task.due', 'task.note', 'task.priority', 'task.category', 'task.start', 'task.cancel']) {
    assert.equal(V.taskCan(a, given, ME, false), false, a); assert.equal(V.taskCan(a, mine, ME, false), true, a); assert.equal(V.taskCan(a, others, ME, false), false, a); assert.equal(V.taskCan(a, given, ME, true), true, a);
  }
  assert.equal(V.taskCan('task.assign', mine, ME, false), false);
});

// 이유: 칸반에서 상태 칸으로 끌면 그 상태가 된다. 끝낸 일을 진행 중 칸으로 = 다시 열기 + 상태 바꾸기(두 번 쓰기), 저장 상태가 같으면 다시 열기만
test('planStatus·planMove 상태: 쓰는 것과 순서', () => {
  const c = ctx();
  assert.deepEqual(V.planMove(task(), 'status', 'doing', c).write, { type: 'task', space: 'me', action: 'task.status', data: { id: 't1', status: 'doing' }, patch: { status: 'doing' } });
  assert.equal(V.planMove(task({ status: 'doing' }), 'status', 'done', c).write.action, 'task.done');
  const both = V.planMove(task({ done_at: 'x' }), 'status', 'hold', c).write;
  assert.deepEqual(both.map((w) => w.action), ['task.reopen', 'task.status']);
  assert.equal(V.planMove(task({ done_at: 'x', status: 'hold' }), 'status', 'hold', c).write.action, 'task.reopen', '저장된 상태가 같으면 다시 열기만');
  assert.equal(V.planStatus(task({ status: 'doing' }), 'doing', c).write, null, '같은 값은 쓰지 않는다');
  assert.equal(V.planStatus(task({ space: 'org-member', created_by: 'u-boss' }), 'hold', c).write.action, 'task.status', '남이 맡긴 일도 맡은 사람은 상태를 바꾼다');
  assert.equal(V.planStatus(task({ space: 'org-member', assignee: 'u-a' }), 'hold', c).reason, 'taskPerm');
  assert.equal(V.planStatus(ev(), 'doing', c).reason, 'eventStatus');
  const many = V.planMany([task({ done_at: 'x' }), task({ id: 't2' })], (x) => V.planStatus(x, 'doing', c));
  assert.deepEqual(many.writes.map((w) => `${w.data.id}:${w.action}`), ['t1:task.reopen', 't1:task.status', 't2:task.status'], '한 항목의 두 쓰기는 차례대로 펼친다');
  assert.deepEqual(V.writesOf(V.planStatus(task(), 'doing', c)).length, 1);
  assert.deepEqual(V.writesOf({ write: null }), []);
});

// 이유: 할 일 분류는 그 공간 분류 표의 id다 — 칸 이름으로 id를 찾고, 없는 이름(일정에만 있는 분류)이면 이유를 알린다
test('planMove 분류: 이름 → 분류 id, 미분류, 없는 이름·끝낸 일·권한', () => {
  const c = ctx();
  assert.deepEqual(V.planMove(task(), 'category', 'c:영업', c).write.data, { id: 't1', category_id: 'c-sales' });
  assert.deepEqual(V.planMove(task(), 'category', 'c:영업', c).write.patch, { category_id: 'c-sales', category: '영업' });
  assert.deepEqual(V.planMove(task({ category_id: 'c-tax', category: '세무' }), 'category', 'none', c).write.data, { id: 't1', category_id: null });
  assert.equal(V.planMove(task(), 'category', 'c:회의', c).reason, 'taskCategoryMissing');
  assert.equal(V.planMove(task({ done_at: 'x' }), 'category', 'c:영업', c).reason, 'done');
  assert.equal(V.planMove(task({ created_by: 'u-boss', space: 'org-member', category_id: 'c-tax', category: '세무' }), 'category', 'none', c).reason, 'taskPerm');
  assert.equal(V.planCategory(task(), '영업', c).reason, 'taskCategoryPick', '일정용 자유 글자 분류로는 할 일을 바꾸지 않는다');
});

// 이유: 할 일 패널은 칸마다 바로 저장한다 — 같은 값은 쓰지 않고, 시작일이 기한보다 늦으면 쓰기 전에 막는다(서버 task_dates와 같은 규칙)
test('planField: 제목·메모·중요도·시작일·기한', () => {
  const c = ctx();
  assert.deepEqual(V.planField(task(), 'title', '  새 제목 ', c).write.data, { id: 't1', title: '새 제목' });
  assert.equal(V.planField(task(), 'title', '할 일', c).write, null);
  assert.equal(V.planField(task(), 'title', '   ', c).reason, 'input');
  assert.equal(V.planField(task(), 'note', '메모', c).write.action, 'task.note');
  assert.equal(V.planField(task({ note: '메모' }), 'note', '메모', c).write, null);
  assert.equal(V.planField(task(), 'priority', 1, c).write.action, 'task.priority');
  assert.equal(V.planField(task(), 'priority', 2, c).write, null);
  assert.equal(V.planField(task(), 'priority', 5, c).reason, 'input');
  assert.equal(V.planField(task(), 'starts_on', '2026-10-11', c).reason, 'dates', '기한(10-10)보다 늦은 시작일');
  assert.deepEqual(V.planField(task(), 'starts_on', '2026-10-08', c).write.data, { id: 't1', starts_on: '2026-10-08' });
  assert.equal(V.planField(task({ starts_on: '2026-10-08' }), 'due_on', '2026-10-07', c).reason, 'dates');
  assert.deepEqual(V.planField(task({ starts_on: '2026-10-08' }), 'due_on', null, c).write.data, { id: 't1', due_on: null }, '기한을 비우면 시작일은 그대로 둔다');
  assert.equal(V.planField(task({ created_by: 'u-boss', space: 'org-member' }), 'note', '바꿈', c).reason, 'taskPerm', '남이 맡긴 일의 메모는 못 고친다');
  assert.equal(V.planField(task({ created_by: 'u-boss', space: 'org-admin' }), 'note', '바꿈', c).write.action, 'task.note', '관리자는 고친다');
  assert.equal(V.planField(task({ done_at: 'x' }), 'title', '바꿈', c).reason, 'done');
});

test('planDuplicate: 할 일 복제는 분류·중요도·시작일을 이어받고 상태는 새로 할 일', () => {
  const w = V.planDuplicate(task({ status: 'hold', priority: 1, category_id: 'c-sales', category: '영업', starts_on: '2026-10-08' }), ctx(), 'new').write;
  assert.deepEqual(w.data, { id: 'new', title: '할 일', due_on: '2026-10-10', priority: 1, category_id: 'c-sales', starts_on: '2026-10-08' });
});

// 이유(페이지 ⋯ '할 일로 만들기'): 제목은 할 일 제목으로 따로 들어가니 본문 첫 줄이 제목과 같으면 빼고, 앞부분만 메모에
test('pageExcerpt: 제목 줄을 빼고 앞부분만, 긴 본문은 잘라 …', () => {
  const doc = { type: 'doc', content: [{ type: 'heading', content: [{ type: 'text', text: '회의록' }] }, { type: 'paragraph', content: [{ type: 'text', text: '결정: 랜딩 개편' }] },
    { type: 'paragraph' }, { type: 'paragraph' }, { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '견적 보내기' }] }] }] }] };
  assert.equal(pageExcerpt('회의록', doc), '결정: 랜딩 개편\n\n견적 보내기');
  assert.equal(pageExcerpt('다른 제목', doc).split('\n')[0], '회의록');
  assert.equal(pageExcerpt('x', { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '가'.repeat(30) }] }] }, 10), `${'가'.repeat(10)}…`);
  assert.equal(pageExcerpt('x', undefined), '');
});

// 이유(분리 검수 LOW-4): 시작일·분류 오류가 한 건 쓰기(core taskAction)에서는 '저장하지 못했습니다'로, 여러 건 쓰기에서는 제 글자로 나뉘어 나왔다.
// core/tasks.js는 Vite 환경값(import.meta.env)을 읽는 supabase.js를 들여와 노드에서 바로 못 불러오므로, 오류 표와 taskError 두 줄만 꺼내 그대로 실행한다
test('할 일 쓰기 오류: 시작일·분류·분류 이름 오류는 어느 경로든 같은 사전 글자(ko·en 둘 다 있음)', () => {
  const src = readFileSync(new URL('../src/core/tasks.js', import.meta.url), 'utf8');
  const lines = src.split('\n').filter((l) => /^const ERRORS = |^export const taskError = /.test(l)).map((l) => l.replace(/^export /, ''));
  assert.equal(lines.length, 2);
  const taskError = new Function(`${lines.join('\n')}; return taskError;`)();
  const want = { task_dates: 'task.error.dates', task_category: 'task.error.category', task_category_name: 'task.error.categoryName', task_limit: 'task.error.limit', task_forbidden: 'task.error.permission' };
  for (const [code, key] of Object.entries(want)) {
    assert.equal(taskError({ message: code }), key, code);
    assert.ok(TASK_DICT[key]?.[0] && TASK_DICT[key]?.[1], `${key} ko·en`);
  }
  assert.equal(taskError({ message: 'boom' }), 'task.error.request');
  assert.equal(taskError({ message: 'x', code: '42501' }), 'task.error.permission');
  const data = readFileSync(new URL('../src/views/data.js', import.meta.url), 'utf8');
  assert.match(data, /taskError \} from '\.\.\/core\/tasks\.js'/, '여러 건 쓰기·예시 모드도 같은 표를 쓴다');
});

// 이유(분리 검수 LOW-5): 서버 목록은 끝낸 일을 최근 30일 것만 준다 — 묶음 진행률은 목록에 있는 할 일로 세므로, 그 기준을 글로 같이 보여 전체 기간 진행률로 착각하지 않게 한다
test('묶음 진행률: 목록에 있는 할 일로 센다(일정 제외) — 30일 기준 안내 글이 ko·en으로 있고 묶음 목록이 보여 준다', () => {
  const list = [task({ id: 'a', done_at: '2026-10-01T00:00:00Z' }), task({ id: 'b', status: 'doing' }), task({ id: 'c' }), ev()];
  assert.deepEqual(V.progressOf(list), { done: 1, total: 3 });
  const [ko, en] = VIEWS_DICT['views.progressNote'];
  assert.match(ko, /30일/); assert.match(en, /30 days/);
  const board = readFileSync(new URL('../src/views/Board.jsx', import.meta.url), 'utf8');
  assert.match(board, /className="vw-progress-note dim">\{t\('views\.progressNote'\)\}/);
});
