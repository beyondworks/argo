import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleDrag } from '../src/core/module-drag.js';

const items = [{ id: 'kpi', size: 's', cfg: { metric: 'sales' } }, { id: 'trend', size: 'l' }, { id: 'table', size: 'full' }, { id: 'hidden', size: 'm', hidden: true }];
const target = (id, group = 'analysis') => ({ kind: 'module', group, id });
const action = (type, extra = {}) => ({ type, scope: 'analysis', source: items, items, canEdit: true, active: target('kpi'), ...extra });

test('mixed-width preview reorders actual items while preserving size, config and hidden entries', () => {
  const start = moduleDrag(null, action('start'));
  const moved = moduleDrag(start.drag, action('over', { over: target('table') }));
  assert.deepEqual(moved.drag.items.map((item) => item.id), ['trend', 'table', 'kpi', 'hidden']);
  assert.equal(moved.commit, null);
  for (const item of items) assert.equal(moved.drag.items.find((entry) => entry.id === item.id), item);
  assert.deepEqual(items.map((item) => item.id), ['kpi', 'trend', 'table', 'hidden']);
  assert.equal(moduleDrag(moved.drag, action('over', { over: target('kpi') })).drag, moved.drag);
});

test('drop consumes the preview once and cancel never requests persistence', () => {
  let state = moduleDrag(null, action('start')).drag;
  state = moduleDrag(state, action('over', { over: target('table') })).drag;
  assert.deepEqual(moduleDrag(state, action('cancel')), { drag: null, commit: null });
  const dropped = moduleDrag(state, action('end', { over: target('kpi') }));
  assert.equal(dropped.commit, state.items);
  assert.deepEqual(moduleDrag(dropped.drag, action('end', { over: target('table') })), { drag: null, commit: null });
});

test('stale source, read-only and scope changes discard a drag without saving', () => {
  let state = moduleDrag(null, action('start')).drag;
  state = moduleDrag(state, action('over', { over: target('table') })).drag;
  for (const extra of [{ source: [...items] }, { canEdit: false }, { scope: 'home' }]) {
    assert.deepEqual(moduleDrag(state, action('end', { over: target('table'), ...extra })), { drag: null, commit: null });
  }
  assert.deepEqual(moduleDrag(null, action('start', { canEdit: false })), { drag: null, commit: null });
});

test('other grids and missing targets cannot reorder or save this grid', () => {
  const state = moduleDrag(null, action('start')).drag;
  assert.equal(moduleDrag(state, action('over', { over: target('table', 'home') })).drag, state);
  assert.equal(moduleDrag(state, action('end', { over: target('table', 'home') })).commit, null);
  assert.equal(moduleDrag(state, action('end')).commit, null);
});

test('moving across a neighbor and back restores the original order without saving', () => {
  const pair = items.slice(0, 2);
  const step = (type, over) => action(type, { source: pair, items: pair, over: target(over) });
  let state = moduleDrag(null, step('start')).drag;
  state = moduleDrag(state, step('over', 'trend')).drag;
  assert.deepEqual(state.items.map((item) => item.id), ['trend', 'kpi']);
  state = moduleDrag(state, step('over', 'kpi')).drag;
  state = moduleDrag(state, step('over', 'trend')).drag;
  assert.deepEqual(state.items, pair);
  assert.equal(moduleDrag(state, step('end', 'kpi')).commit, null);
});

// 이유(유건 9/30): 모듈을 옮기면 가만히 있어도 자리가 또 바뀌어 엉뚱한 곳에 놓였다(운영·로컬 재현: work를 approvals 자리로 끌어
// 멈췄는데 outputs 뒤로 튐). 대상의 앞쪽 절반이면 그 앞, 뒤쪽 절반이면 그 뒤 — 옮긴 뒤 같은 포인터로 다시 재도 결과가 같다.
import { sideOf } from '../src/core/module-drag.js';

test('놓을 쪽: 가로로 꽉 찬 모듈은 위·아래 절반, 나머지는 왼쪽·오른쪽 절반', () => {
  const rect = { left: 0, top: 0, width: 400, height: 200 };
  assert.equal(sideOf(rect, { x: 100, y: 190 }, 'm'), 'before');
  assert.equal(sideOf(rect, { x: 300, y: 10 }, 'm'), 'after');
  assert.equal(sideOf(rect, { x: 390, y: 50 }, 'full'), 'before');
  assert.equal(sideOf(rect, { x: 10, y: 150 }, 'full'), 'after');
  assert.equal(sideOf(rect, { x: 200, y: 100 }, 'm'), 'after'); // 정확히 가운데는 뒤
});

test('앞·뒤로 넣기, 같은 자리면 그대로(같은 배열) — 두 모듈이 서로 계속 자리를 바꾸지 않는다', () => {
  const abc = [{ id: 'a', size: 'm' }, { id: 'b', size: 'm' }, { id: 'c', size: 's' }, { id: 'h', size: 'm', hidden: true }];
  const act = (type, extra = {}) => ({ type, scope: 'analysis', source: abc, items: abc, canEdit: true, active: target('c'), ...extra });
  let state = moduleDrag(null, act('start')).drag;
  state = moduleDrag(state, act('over', { over: { ...target('a'), side: 'before' } })).drag;
  assert.deepEqual(state.items.map((i) => i.id), ['c', 'a', 'b', 'h']);
  const again = moduleDrag(state, act('over', { over: { ...target('a'), side: 'before' } })).drag;
  assert.equal(again, state); // 같은 포인터로 다시 재도 바뀌지 않는다
  state = moduleDrag(state, act('over', { over: { ...target('a'), side: 'after' } })).drag;
  assert.deepEqual(state.items.map((i) => i.id), ['a', 'c', 'b', 'h']);
  state = moduleDrag(state, act('over', { over: { ...target('b'), side: 'after' } })).drag;
  assert.deepEqual(state.items.map((i) => i.id), ['a', 'b', 'c', 'h']);
  assert.equal(moduleDrag(state, act('end', { over: target('b') })).commit, null); // 원래 순서로 돌아오면 저장하지 않는다
});
