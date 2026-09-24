// 당겨서 새로고침 판정(순수 함수) — 유건 결정: 임계 70px, 맨 위에서만, location.reload()
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { REFRESH_THRESHOLD, REFRESH_MAX, pullDistance, shouldRefresh, canStartPull } from '../src/pull-refresh.mjs';

test('pullDistance — 임계 전엔 1:1, 넘으면 저항(고무줄), 음수는 0', () => {
  assert.equal(pullDistance(-10), 0);
  assert.equal(pullDistance(0), 0);
  assert.equal(pullDistance(40), 40);
  assert.equal(pullDistance(REFRESH_THRESHOLD), REFRESH_THRESHOLD);
  assert.equal(pullDistance(REFRESH_THRESHOLD + 50), REFRESH_THRESHOLD + 20, '임계 넘은 50px는 0.4배만 반영');
  assert.equal(pullDistance(9999), REFRESH_MAX, '한도 넘지 않는다');
});

test('shouldRefresh — 임계 이상만 참', () => {
  assert.equal(shouldRefresh(69), false);
  assert.equal(shouldRefresh(70), true);
  assert.equal(shouldRefresh(500), true);
});

test('canStartPull — 스크롤 맨 위 + 손가락 하나일 때만', () => {
  assert.equal(canStartPull(0, 1), true);
  assert.equal(canStartPull(1, 1), false, '1px라도 내려가 있으면 시작 안 함(대화의 이전 기록 스크롤과 안 겹치게)');
  assert.equal(canStartPull(0, 2), false, '멀티터치는 제외');
  assert.equal(canStartPull(-1, 1), true, 'iOS 바운스로 음수가 나올 수 있어 0 이하는 전부 허용');
});

test('배선 — usePullToRefresh 훅이 데스크톱에는 붙지 않고(isPhone만), 새로고침은 location.reload()', () => {
  const src = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(src, /function usePullToRefresh\(/, 'usePullToRefresh 훅 정의');
  assert.match(src, /usePullToRefresh\([^)]*isPhone/, '폰 여부로만 켠다');
  assert.match(src, /location\.reload\(\)/, '새로고침은 location.reload (로그인 유지)');
  assert.match(src, /const onKey = \(e\) => \{ const k = e\.key\.toLowerCase\(\); if \(k === 'f5' \|\| \(\(e\.metaKey \|\| e\.ctrlKey\) && k === 'r'\)\)/, '데스크톱 ⌘R/Ctrl+R/F5 새로고침');
  const dict = readFileSync(new URL('../src/i18n.js', import.meta.url), 'utf8');
  for (const k of ['refresh.pull', 'refresh.release', 'refresh.refreshing']) assert.match(dict, new RegExp(`'${k.replace(/\./g, '\\.')}': \\[["'][^"']+["'], ["'][^"']+["']\\]`), `${k} ko/en`);
});
