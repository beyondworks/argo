// 모바일 웹뷰 바탕(webview-bg.js) — 창 설정의 스플래시 색(#1F1E1B)이 스플래시가 닫힌 뒤에도 남으면 라이트 테마에서 키보드·회전·바운스로
// 드러나는 자리가 어둡게 보인다(반대 검토 #7). 닫히면 지금 테마 바탕으로 바꾸고, 테마가 바뀔 때만 다시 부른다(같은 값이면 호출 0).
import test from 'node:test';
import assert from 'node:assert/strict';
import { followThemeBackground } from '../src/webview-bg.js';

function fake(bg) {
  const calls = [];
  const observers = [];
  const mq = [];
  const state = { bg };
  const win = {
    __TAURI__: { webview: { getCurrentWebview: () => ({ setBackgroundColor: (c) => { calls.push(c); return Promise.resolve(); } }) } },
    getComputedStyle: () => ({ backgroundColor: state.bg }),
    MutationObserver: class { constructor(cb) { this.cb = cb; observers.push(this); } observe(target, opts) { this.opts = opts; } },
    matchMedia: () => ({ addEventListener: (n, cb) => mq.push(cb) }),
  };
  const doc = { body: {}, documentElement: {} };
  return { win, doc, calls, state, fireTheme: () => observers.forEach((o) => o.cb()), fireScheme: () => mq.forEach((cb) => cb()), observers };
}

test('스플래시가 닫히면 테마 바탕으로 한 번 바꾼다', () => {
  const f = fake('rgb(244, 241, 234)');
  assert.equal(followThemeBackground(f.win, f.doc), true);
  assert.deepEqual(f.calls, [[244, 241, 234]]);
  assert.deepEqual(f.observers[0].opts, { attributes: true, attributeFilter: ['data-theme'] }, '테마 속성만 본다');
});

test('같은 색이면 다시 부르지 않고, 테마가 바뀌면 따라간다', () => {
  const f = fake('rgb(244, 241, 234)');
  followThemeBackground(f.win, f.doc);
  f.fireTheme(); f.fireScheme();
  assert.equal(f.calls.length, 1, '값이 같으면 호출 0');
  f.state.bg = 'rgb(32, 32, 32)';
  f.fireTheme();
  assert.deepEqual(f.calls, [[244, 241, 234], [32, 32, 32]]);
});

test('투명 바탕(테마 미정)·Tauri 없음(브라우저·테스트)에서는 아무것도 안 한다', () => {
  const f = fake('rgba(0, 0, 0, 0)');
  followThemeBackground(f.win, f.doc);
  assert.equal(f.calls.length, 0);
  const g = fake('rgb(1, 2, 3)');
  delete g.win.__TAURI__;
  assert.equal(followThemeBackground(g.win, g.doc), false);
});
