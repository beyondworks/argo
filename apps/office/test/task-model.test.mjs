import test from 'node:test';
import assert from 'node:assert/strict';
import { kstDay, groupTasks, dueInfo } from '../src/core/task-model.js';

// 할 일은 한국 날짜로 묶는다 — 기한 준수율도 같은 날짜 기준으로 계산하므로 화면과 기록이 어긋나면 안 된다(유건 9/29)
test('kstDay: UTC 15시는 한국 다음 날 0시', () => {
  assert.equal(kstDay(new Date('2026-09-29T14:59:59Z')), '2026-09-29');
  assert.equal(kstDay(new Date('2026-09-29T15:00:00Z')), '2026-09-30');
});

test('dueInfo: 지남·오늘·내일·며칠 남음', () => {
  const today = '2026-09-29';
  assert.deepEqual(dueInfo('2026-09-27', today), { key: 'overdue', n: 2 });
  assert.deepEqual(dueInfo('2026-09-29', today), { key: 'today', n: 0 });
  assert.deepEqual(dueInfo('2026-09-30', today), { key: 'tomorrow', n: 1 });
  assert.deepEqual(dueInfo('2026-10-09', today), { key: 'left', n: 10 });
  assert.equal(dueInfo(null, today), null);
});

test('groupTasks: 내가 맡은 일은 기한별로, 내가 남에게 맡긴 일은 따로, 끝낸 일은 맨 아래', () => {
  const me = 'me', other = 'o', today = '2026-09-29';
  const row = (id, extra) => ({ id, title: id, assignee: me, created_by: me, due_on: null, done_at: null, created_at: '2026-09-01T00:00:00Z', ...extra });
  const g = groupTasks([
    row('late', { due_on: '2026-09-28' }), row('now', { due_on: today }), row('week', { due_on: '2026-10-06' }),
    row('later', { due_on: '2026-10-07' }), row('free'), row('done', { due_on: today, done_at: '2026-09-29T01:00:00Z' }),
    row('gave', { assignee: other }), row('theirs', { assignee: other, created_by: other }),
  ], today, me);
  assert.deepEqual(Object.fromEntries(Object.entries(g).map(([k, v]) => [k, v.map((r) => r.id)])), {
    overdue: ['late'], today: ['now'], week: ['week'], later: ['later'], none: ['free'], gave: ['gave'], others: ['theirs'], done: ['done'],
  });
});
