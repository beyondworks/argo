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
