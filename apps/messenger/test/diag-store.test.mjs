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
