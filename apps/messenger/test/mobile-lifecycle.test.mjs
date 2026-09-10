import test from 'node:test';
import assert from 'node:assert/strict';
import { observeMobileResume } from '../src/mobile-lifecycle.mjs';

function fixture({ visible = true, online = true } = {}) {
  const doc = new EventTarget(); doc.visibilityState = visible ? 'visible' : 'hidden';
  const win = new EventTarget(); win.navigator = { onLine: online };
  const timers = new Map(); let next = 0; let calls = 0;
  const stop = observeMobileResume(() => { calls += 1; }, {
    document: doc, window: win, debounceMs: 25,
    setTimeout(fn, ms) { assert.equal(ms, 25); timers.set(++next, fn); return next; },
    clearTimeout(id) { timers.delete(id); },
  });
  const flush = () => { const pending = [...timers.values()]; timers.clear(); pending.forEach((fn) => fn()); };
  const visibility = (state) => { doc.visibilityState = state; doc.dispatchEvent(new Event('visibilitychange')); };
  const network = (state) => { win.navigator.onLine = state; win.dispatchEvent(new Event(state ? 'online' : 'offline')); };
  return { doc, win, stop, flush, visibility, network, timers, get calls() { return calls; } };
}

test('mount and duplicate visible events do not reconcile; a foreground transition does', () => {
  const f = fixture(); f.flush(); assert.equal(f.calls, 0);
  f.visibility('visible'); f.flush(); assert.equal(f.calls, 0);
  f.visibility('hidden'); f.visibility('visible');
  assert.equal(f.calls, 0); f.flush(); assert.equal(f.calls, 1); f.stop();
});

test('an initially hidden document reconciles on its first visible transition', () => {
  const f = fixture({ visible: false }); f.flush(); assert.equal(f.calls, 0);
  f.visibility('visible'); f.flush(); assert.equal(f.calls, 1); f.stop();
});

test('foreground and reconnection bursts share a single debounce', () => {
  const f = fixture(); f.visibility('hidden'); f.visibility('visible'); f.network(true); f.network(true);
  assert.equal(f.timers.size, 1); f.flush(); assert.equal(f.calls, 1);
  f.network(false); f.network(true); f.flush(); assert.equal(f.calls, 2); f.stop();
});

test('hidden network events are suppressed until the next foreground transition', () => {
  const f = fixture({ visible: false }); f.network(false); f.network(true); f.flush(); assert.equal(f.calls, 0);
  f.visibility('visible'); f.flush(); assert.equal(f.calls, 1); f.stop();
});

test('offline foreground events wait for visible reconnection', () => {
  const f = fixture({ visible: false, online: false });
  f.visibility('visible'); f.flush(); assert.equal(f.calls, 0);
  f.network(true); f.flush(); assert.equal(f.calls, 1); f.stop();
});

test('hiding or disconnecting before the debounce expires cancels pending work', () => {
  const f = fixture(); f.network(true); f.visibility('hidden');
  assert.equal(f.timers.size, 0); f.flush(); assert.equal(f.calls, 0);
  f.visibility('visible'); f.network(false);
  assert.equal(f.timers.size, 0); f.flush(); assert.equal(f.calls, 0); f.stop();
});

test('callback rechecks current availability even when the platform omitted an event', () => {
  const f = fixture(); f.network(true); f.win.navigator.onLine = false; f.flush(); assert.equal(f.calls, 0);
  f.network(true); f.doc.visibilityState = 'hidden'; f.flush(); assert.equal(f.calls, 0); f.stop();
});

test('cleanup cancels timers and unsubscribes every listener, including stale callbacks', () => {
  const f = fixture(); f.network(true); const stale = [...f.timers.values()][0]; f.stop(); f.stop();
  assert.equal(f.timers.size, 0); stale(); assert.equal(f.calls, 0);
  f.visibility('hidden'); f.visibility('visible'); f.network(true);
  assert.equal(f.timers.size, 0); f.flush(); assert.equal(f.calls, 0);
});
