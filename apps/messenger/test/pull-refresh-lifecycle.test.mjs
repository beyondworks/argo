import test from 'node:test';
import assert from 'node:assert/strict';
import { bindPullRefresh } from '../src/pull-refresh.mjs';

function fixture(refresh) {
  const events = {}; const phases = []; const errors = []; const styles = {};
  const node = { scrollTop: 0, style: { setProperty: (k, v) => { styles[k] = v; }, removeProperty: k => delete styles[k] }, addEventListener: (k, f) => { events[k] = f; }, removeEventListener: k => delete events[k] };
  const cleanup = bindPullRefresh(node, { refresh, phase: p => phases.push(p), error: e => errors.push(e) });
  const touch = y => ({ touches: [{ clientX: 10, clientY: y }], changedTouches: [{ clientX: 10, clientY: y }], preventDefault() {} });
  const pull = () => { events.touchstart(touch(0)); events.touchmove(touch(140)); return events.touchend(touch(140)); };
  return { events, node, phases, errors, styles, cleanup, touch, pull };
}

test('refresh remains single-flight and retains current surface until settled', async () => {
  let finish; let calls = 0;
  const f = fixture(() => { calls++; return new Promise(r => { finish = r; }); });
  const pending = f.pull();
  assert.equal(f.phases.at(-1), 'refreshing');
  await f.pull(); assert.equal(calls, 1);
  f.events.touchcancel(f.touch(140)); assert.equal(f.phases.at(-1), 'refreshing');
  finish(); await pending;
  assert.equal(f.phases.at(-1), 'idle'); assert.equal(f.styles['--pull-dy'], '0px');
  f.cleanup(); assert.deepEqual(f.events, {});
});

test('offline failure reports error and permits retry without destroying the surface', async () => {
  let calls = 0;
  const f = fixture(async () => { if (++calls === 1) throw new Error('offline'); });
  await f.pull(); assert.equal(f.errors[0].message, 'offline'); assert.equal(f.phases.at(-1), 'idle');
  await f.pull(); assert.equal(calls, 2); assert.equal(f.errors.length, 1); f.cleanup();
});

test('touchcancel, multitouch and below-threshold do not refresh', async () => {
  let calls = 0; const f = fixture(async () => { calls++; });
  f.events.touchstart(f.touch(0)); f.events.touchmove(f.touch(140)); f.events.touchcancel(f.touch(140));
  await f.events.touchend(f.touch(140));
  f.events.touchstart(f.touch(0)); f.events.touchmove({ touches: [f.touch(1).touches[0], f.touch(2).touches[0]] });
  await f.events.touchend(f.touch(140));
  f.events.touchstart(f.touch(0)); await f.events.touchend(f.touch(50));
  assert.equal(calls, 0); f.cleanup();
});

test('unmount while refreshing detaches listeners and suppresses stale error/state updates', async () => {
  let reject; const f = fixture(() => new Promise((_, r) => { reject = r; }));
  const pending = f.pull(); f.cleanup(); const count = f.phases.length;
  reject(new Error('offline')); await pending;
  assert.deepEqual(f.errors, []); assert.equal(f.phases.length, count);
});
