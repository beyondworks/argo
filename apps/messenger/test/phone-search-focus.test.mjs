// 폰 검색 칸이 초점을 못 지키던 결함(2026-09-29 실측) — 터치 기기는 초점만으로 html.msgr-kb(키보드 모드)가 붙고,
// 키보드 모드가 탭바를 display:none으로 숨겼다. 검색 칸은 그 탭바 안이라 초점을 받자마자 숨겨져 풀렸다(눌러도 BODY로).
// 문자열 핀이다 — 동작 확인은 ego 폰 에뮬레이션(검색 탭 → activeElement INPUT, "결제" 52건)으로 했다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('키보드 모드의 탭바 숨김은 검색 섬이 든 탭바를 빼고, 검색 섬은 보이는 영역 바닥에 붙인다', () => {
  const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
  assert.match(css, /html\.msgr-kb \.msgr-phone \.msgr-tabbar:not\(:has\(\.msgr-island-search\)\)[^{]*\{ display: none; \}/);
  assert.doesNotMatch(css, /html\.msgr-kb \.msgr-phone \.msgr-tabbar,/, '예외 없는 옛 숨김 규칙이 남으면 안 된다');
  assert.match(css, /html\.msgr-kb \.msgr-phone \.msgr-tabbar:has\(\.msgr-island-search\) \{ bottom: calc\(100dvh - var\(--msgr-viewport-top/);
});
