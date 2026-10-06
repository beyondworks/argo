// 배치 되돌리기·다시 하기(유건 10/2 7차 4). 규칙마다 이유 한 줄. node --test test/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { H, record, target, keyAction, step, attach, MAX_STEPS } from '../src/core/history.js';

const reset = () => { H.stacks.clear(); H.grids.clear(); H.order = []; };
/** 격자 흉내 — apply = 저장 경로(layout.set 1회). writes에 저장한 값을 남긴다 */
function grid(key, items, { blocked = false } = {}) {
  const g = { now: items, writes: [], items: () => g.now, apply: async (next) => { if (blocked) return false; g.writes.push(next); g.now = next; return true; } };
  attach(key, g);
  return g;
}
const A = [{ id: 'a', x: 0, y: 0, t: 0 }], B = [{ id: 'a', x: 6, y: 0, t: 0 }], C = [{ id: 'a', x: 6, y: 0, t: 200 }];

// 이유: 사용자 동작 하나 = 한 단계. 되돌리면 이전 배치를 한 번 저장하고, 다시 하기로 돌아온다. 되돌린 결과도 저장된다(layout.set 1회).
test('되돌리기·다시 하기: 한 단계씩, 저장 1회씩', async () => {
  reset();
  const g = grid('home:me', A);
  record('home:me', A); g.now = B; // 옮기기
  record('home:me', B); g.now = C; // 크기
  assert.equal(await step('home:me', false), true);
  assert.deepEqual(g.now, B); assert.equal(g.writes.length, 1);
  assert.equal(await step('home:me', false), true);
  assert.deepEqual(g.now, A);
  assert.equal(await step('home:me', false), false); // 더 없다 — 저장 0
  assert.equal(g.writes.length, 2);
  assert.equal(await step('home:me', true), true);
  assert.deepEqual(g.now, B);
  assert.equal(await step('home:me', true), true);
  assert.deepEqual(g.now, C);
  assert.equal(await step('home:me', true), false);
  // 되돌린 뒤 새 동작을 하면 다시 하기는 비운다
  await step('home:me', false); record('home:me', g.now); g.now = A;
  assert.equal(H.stacks.get('home:me').redo.length, 0);
});

// 이유: 저장이 막히면(읽기 전용·저장 중·충돌) 아무것도 바뀌지 않고 단계는 남는다.
test('저장이 막히면 단계가 그대로', async () => {
  reset();
  const g = grid('home:me', B, { blocked: true });
  record('home:me', A);
  assert.equal(await step('home:me', false), false);
  assert.equal(H.stacks.get('home:me').undo.length, 1);
  assert.deepEqual(g.now, B);
});

// 이유: 레이아웃 키마다 따로, 최근 50단계. ⌘Z는 화면에 있는 격자 중 마지막으로 바꾼 것을 되돌린다(화면에 없는 격자는 건드리지 않는다).
test('키마다 50단계, 마지막으로 바꾼 화면 격자', () => {
  reset();
  grid('home:me', A);
  for (let i = 0; i < MAX_STEPS + 5; i++) record('home:me', [{ id: String(i) }]);
  assert.equal(H.stacks.get('home:me').undo.length, MAX_STEPS);
  assert.equal(H.stacks.get('home:me').undo[0][0].id, '5');
  const off = attach('page-module:p1', { items: () => A, apply: async () => true });
  record('page-module:p1', A);
  assert.equal(target(false), 'page-module:p1');
  off(); // 페이지를 떠나면 그 격자는 대상이 아니다
  assert.equal(target(false), 'home:me');
  assert.equal(target(true), undefined);
});

// 이유(유건 7차 4): ⌘Z·Ctrl+Z = 되돌리기, ⇧⌘Z·Ctrl+Shift+Z·Ctrl+Y = 다시 하기. 입력칸·편집기에 초점이 있으면 그쪽이 이긴다.
test('단축키: 되돌리기·다시 하기, 입력칸·편집기는 제외', () => {
  const k = (key, mods = {}, target = { tagName: 'BUTTON' }) => keyAction({ key, target, ...mods });
  assert.equal(k('z', { metaKey: true }), 'undo');
  assert.equal(k('z', { ctrlKey: true }), 'undo');
  assert.equal(k('Z', { metaKey: true, shiftKey: true }), 'redo');
  assert.equal(k('Z', { ctrlKey: true, shiftKey: true }), 'redo');
  assert.equal(k('y', { ctrlKey: true }), 'redo');
  assert.equal(k('z'), null);
  assert.equal(k('z', { metaKey: true, altKey: true }), null);
  assert.equal(k('z', { metaKey: true }, { tagName: 'INPUT', type: 'text' }), null);
  assert.equal(k('z', { metaKey: true }, { tagName: 'TEXTAREA' }), null);
  assert.equal(k('z', { metaKey: true }, { tagName: 'DIV', isContentEditable: true }), null);
  assert.equal(k('z', { metaKey: true }, { tagName: 'INPUT', type: 'checkbox' }), 'undo'); // 체크박스는 글자 실행 취소가 없다
  assert.equal(k('z', { metaKey: true, defaultPrevented: true }), null); // 편집기가 먼저 처리했다
  assert.equal(k('z', { metaKey: true, isComposing: true }), null);
});
