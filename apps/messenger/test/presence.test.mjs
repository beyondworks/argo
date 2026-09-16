// 심박 규칙 — 화면 앞일 때만 남긴다. 자리를 뜨면 멎고, 돌아오면 바로 한 번 남긴다(유건 2026-09-16).
import test from 'node:test';
import assert from 'node:assert/strict';
import { startPresence, isWatching, PRESENCE_MS } from '../src/presence.mjs';

const fakeDoc = (state) => {
  const listeners = {};
  return {
    get visibilityState() { return state.visible ? 'visible' : 'hidden'; },
    hasFocus: () => state.focused,
    addEventListener: (k, fn) => { (listeners[k] ??= []).push(fn); },
    removeEventListener: (k, fn) => { listeners[k] = (listeners[k] ?? []).filter((f) => f !== fn); },
    fire: (k) => { for (const fn of listeners[k] ?? []) fn(); },
    count: (k) => (listeners[k] ?? []).length,
  };
};
const fakeWin = fakeDoc({ visible: true, focused: true });
const fakeSupabase = (calls) => ({ rpc: (fn, args) => { calls.push(`${fn}:${args.source}`); return { then: (ok) => { ok?.(); return { catch: () => {} }; } }; } });

test('isWatching — 보이고 초점이 있을 때만 참', () => {
  assert.equal(isWatching(fakeDoc({ visible: true, focused: true })), true);
  assert.equal(isWatching(fakeDoc({ visible: true, focused: false })), false, '초점이 없으면 보는 중이 아니다');
  assert.equal(isWatching(fakeDoc({ visible: false, focused: true })), false, '가려져 있으면 보는 중이 아니다');
});

test('심박은 화면 앞일 때만 나가고, 멈추면 더 나가지 않는다', () => {
  const state = { visible: true, focused: true };
  const doc = fakeDoc(state); const win = fakeDoc(state);
  const calls = [];
  const stop = startPresence({ supabase: fakeSupabase(calls), source: 'desktop', interval: 10_000, doc, win });
  assert.deepEqual(calls, ['msgr_presence_ping:desktop'], '시작하면 한 번');
  state.focused = false;
  doc.fire('visibilitychange');
  assert.equal(calls.length, 1, '자리를 뜨면 남기지 않는다 — 낡은 심박이 폰 알림을 막지 않게');
  state.focused = true;
  win.fire('focus');
  assert.equal(calls.length, 2, '돌아오면 바로 한 번(주기를 기다리지 않는다)');
  stop();
  win.fire('focus');
  assert.equal(calls.length, 2, '멈춘 뒤에는 나가지 않는다');
  assert.equal(doc.count('visibilitychange'), 0, '리스너를 정리한다');
  assert.equal(win.count('focus'), 0);
});

test('심박 주기는 서버 판정 창(2분)보다 짧다 — 한 번 걸러도 살아 있는 것으로 읽힌다', () => {
  assert.ok(PRESENCE_MS <= 60_000, `${PRESENCE_MS}ms`);
});
