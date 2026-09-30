import test from 'node:test';
import assert from 'node:assert/strict';
import { closestCenter } from '@dnd-kit/core';
import { moduleKeyboardCoordinates } from '../src/core/module-keyboard.js';

const rect = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height });
function fixture(rows, current) {
  const containers = rows.map(([id, bounds, group = 'performance']) => ({ id, rect: { current: bounds }, data: { current: { kind: 'module', id, group, keyboardTarget: { current: null } } } }));
  const droppableRects = new Map(rows.map(([id, bounds]) => [id, bounds]));
  return { currentCoordinates: { x: current.left, y: current.top }, context: { active: containers.find((item) => item.id === 'orders'), over: { id: 'orders' }, collisionRect: current, droppableRects, droppableContainers: { getEnabled: () => containers } }, containers };
}

test('up into a tall full-width row lands on its center under the actual collision algorithm', () => {
  const current = rect(620, 900, 280, 120);
  const args = fixture([['comparison', rect(0, 100, 900, 788)], ['orders', current], ['foreign', rect(620, 800, 280, 60), 'home']], current);
  const next = moduleKeyboardCoordinates({ code: 'ArrowUp', preventDefault() {} }, args);
  const moved = rect(next.x, next.y, current.width, current.height);
  const collisions = closestCenter({ active: args.context.active, collisionRect: moved, droppableRects: args.context.droppableRects, droppableContainers: args.containers.filter((item) => item.data.current.group === 'performance') });
  assert.equal(collisions[0].id, 'comparison');
  assert.equal(moved.left + moved.width / 2, 450);
  assert.equal(moved.top + moved.height / 2, 494);
});

test('horizontal movement remains within the module group and stops at the edge', () => {
  const current = rect(310, 0, 280, 120);
  const args = fixture([['left', rect(0, 0, 280, 120)], ['orders', current], ['foreign', rect(280, 0, 10, 120), 'home']], current);
  assert.deepEqual(moduleKeyboardCoordinates({ code: 'ArrowLeft', preventDefault() {} }, args), { x: 0, y: 0 });
  assert.equal(moduleKeyboardCoordinates({ code: 'ArrowRight', preventDefault() {} }, args), undefined);
  assert.equal(moduleKeyboardCoordinates({ code: 'Space', preventDefault() {} }, args), undefined);
});

test('left chooses the adjacent chart in the same row, not a closer center in the row below', () => {
  const current = rect(761, 0, 365, 348);
  const args = fixture([['chart', rect(0, 0, 745, 348)], ['orders', current], ['table', rect(0, 364, 1126, 200)]], current);
  assert.deepEqual(moduleKeyboardCoordinates({ code: 'ArrowLeft', preventDefault() {} }, args), { x: 190, y: 0 });
});

test('after live reflow the placeholder determines direction while the overlay supplies displacement', () => {
  const current = rect(0, 0, 365, 348);
  const args = fixture([['orders', current], ['chart', rect(381, 0, 745, 348)]], current);
  args.context.collisionRect = rect(190, 0, 365, 348);
  args.currentCoordinates = { x: 190, y: 0 };
  args.context.over = { id: 'chart' };
  assert.deepEqual(moduleKeyboardCoordinates({ code: 'ArrowRight', preventDefault() {} }, args), { x: 571, y: 0 });
  assert.deepEqual(args.context.active.data.current.keyboardTarget.current, { kind: 'module', group: 'performance', id: 'chart' });
  moduleKeyboardCoordinates({ code: 'ArrowLeft', preventDefault() {} }, args);
  assert.equal(args.context.active.data.current.keyboardTarget.current, null);
});
