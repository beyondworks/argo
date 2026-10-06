// 진단 기록 — 모바일에서는 실시간 글마다 'notify' 줄이 쌓여 20건 안에서 알림 탭('tap')·이동('nav') 줄이 금방 밀려났다(2026-10-01 반대 검토).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createDiagStore, DIAG_KEY, DIAG_NAV_KEY, DIAG_LIMIT } from '../src/diag-store.mjs';

const memory = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m }; };
let clock = 0;
const tick = () => new Date(Date.UTC(2026, 9, 1, 0, 0, clock++)).toISOString();

test('알림 기록이 많이 쌓여도 탭·이동 기록은 밀려나지 않는다', () => {
  const s = memory(); const store = createDiagStore(() => s, tick);
  store.push('tap', 'channel X', 'src=push page=home org=a shell=on');
  store.push('nav', 'open X');
  for (let i = 0; i < 50; i++) store.push('notify', `m:${i} send`);
  const list = store.read();
  assert.equal(list.filter((e) => e.kind === 'notify').length, DIAG_LIMIT, '일반 기록은 종전대로 최근 20건');
  assert.deepEqual(list.filter((e) => e.kind === 'tap' || e.kind === 'nav').map((e) => e.message), ['open X', 'channel X']);
  assert.equal(JSON.parse(s.getItem(DIAG_NAV_KEY)).length, 2);
  assert.equal(JSON.parse(s.getItem(DIAG_KEY)).length, DIAG_LIMIT);
});

test('두 목록을 시각 순(최신 먼저)으로 합쳐 보여 주고, 지우기는 둘 다 지운다', () => {
  const s = memory(); const store = createDiagStore(() => s, tick);
  store.push('boot', 'start'); store.push('tap', 'channel X'); store.push('shell', 'page=chat');
  assert.deepEqual(store.read().map((e) => e.kind), ['shell', 'tap', 'boot']);
  store.clear();
  assert.deepEqual(store.read(), []);
  assert.equal(s.m.size, 0);
});

test('탭·이동 기록도 20건 상한 — 저장 불가 환경에서는 조용히 넘어간다', () => {
  const s = memory(); const store = createDiagStore(() => s, tick);
  for (let i = 0; i < 30; i++) store.push('nav', `n${i}`);
  assert.equal(store.read().length, DIAG_LIMIT);
  assert.equal(store.read()[0].message, 'n29');
  const broken = createDiagStore(() => { throw new Error('SecurityError'); });
  assert.doesNotThrow(() => broken.push('tap', 'x'));
  assert.deepEqual(broken.read(), []);
  const corrupt = memory(); corrupt.setItem(DIAG_KEY, '{"not":"a list"}');
  assert.deepEqual(createDiagStore(() => corrupt).read(), []);
});

test('diag.jsx는 저장을 이 모듈 한 곳에 맡긴다(키·상한을 따로 두지 않는다)', () => {
  const src = readFileSync(new URL('../src/diag.jsx', import.meta.url), 'utf8');
  assert.match(src, /createDiagStore\(\(\) => globalThis\.localStorage\)/);
  assert.doesNotMatch(src, /localStorage\.setItem/);
});

// 화면 검수 UL2(2026-10-05): 일반 기록 20칸을 'toast'(오류 원문) 줄이 'shell'·'notify' 줄과 같이 써서, 실시간 글이 몇 개만 와도 오류 원문이 밀려났다.
// 오류 줄(error·rejection·render·toast)을 먼저 지킨다 — 다른 줄은 최소 8칸, 상한 20은 그대로.
test('UL2 알림·셸 줄이 많이 와도 오류 줄(토스트 원문 등)은 남는다 — 상한 20 유지', () => {
  const s = memory(); const store = createDiagStore(() => s, tick);
  store.push('toast', 'msgr_forbidden'); store.push('render', 'boom');
  for (let i = 0; i < 40; i++) store.push(i % 2 ? 'notify' : 'shell', `n${i}`);
  const list = JSON.parse(s.getItem(DIAG_KEY));
  assert.equal(list.length, DIAG_LIMIT);
  assert.deepEqual(list.filter((x) => ['toast', 'render'].includes(x.kind)).map((x) => x.message).sort(), ['boom', 'msgr_forbidden']);
  for (let i = 0; i < 30; i++) store.push('error', `e${i}`);
  const after = JSON.parse(s.getItem(DIAG_KEY));
  assert.equal(after.length, DIAG_LIMIT);
  assert.equal(after.filter((x) => ['notify', 'shell'].includes(x.kind)).length, 8, '오류가 넘쳐도 다른 줄은 최소 8칸');
  assert.equal(after[0].message, 'e29', '최신순 그대로');
});
