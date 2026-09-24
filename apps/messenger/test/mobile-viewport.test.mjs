import test from 'node:test';
import assert from 'node:assert/strict';
import { viewportVars, KEYBOARD_TARGET } from '../src/viewport-vars.mjs';

test('키보드가 없으면 뷰포트 변수를 내지 않는다 — 부팅 직후 작게 보고된 높이가 셸에 굳지 않는다(유건 제보 2026-09-14)', () => {
  assert.equal(viewportVars({ keyboard: false, height: 580, top: 0, width: 402, coarse: true }).vars, null);
  assert.equal(viewportVars({ keyboard: false, height: 874, top: 0, width: 402, coarse: true }).vars, null);
});

test('키보드가 떠 있으면 visualViewport 높이·오프셋을 변수로 넘긴다', () => {
  assert.deepEqual(viewportVars({ keyboard: true, height: 580, top: 12, width: 402, coarse: true }).vars, { '--msgr-viewport-height': '580px', '--msgr-viewport-top': '12px' });
});

test('짧은 가로 화면 표지는 터치 기기에서 폭 720 초과·높이 320 이하일 때만', () => {
  assert.equal(viewportVars({ keyboard: false, height: 300, width: 800, coarse: true }).short, true);
  assert.equal(viewportVars({ keyboard: false, height: 300, width: 800, coarse: false }).short, false);
  assert.equal(viewportVars({ keyboard: false, height: 400, width: 800, coarse: true }).short, false);
});

test('키보드 모드 표지 — 어떤 입력칸이든 초점이면 html.msgr-kb, 폰 셸은 탭바 자리를 비운다(유건 제보 2026-09-24: 설정 부서 칸에서 카드가 잘리고 빈 띠)', async () => {
  const { readFileSync } = await import('node:fs');
  const hook = readFileSync(new URL('../src/mobile-viewport.js', import.meta.url), 'utf8');
  assert.match(hook, /classList\.toggle\('msgr-kb', !!vars\)/, '변수를 낼 때(키보드)와 같은 조건');
  assert.match(hook, /classList\.remove\('msgr-kb'\)/, '언마운트 때 정리');
  const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
  assert.match(css, /html\.msgr-kb \.msgr-phone \.msgr-tabbar[^{]*\{ display: none; \}/);
  assert.match(css, /html\.msgr-kb \.msgr-phone \.msgr-main \{ padding-bottom: 8px; \}/);
});

test('키보드 대상은 키보드가 뜨는 칸만 — 체크박스·라디오 등에서는 탭바를 숨기지 않는다(재검수 #699 M1)', () => {
  for (const type of ['checkbox', 'radio', 'file', 'range', 'button', 'submit', 'color']) assert.ok(KEYBOARD_TARGET.includes(`:not([type=${type}])`), type);
  assert.match(KEYBOARD_TARGET, /textarea/); assert.match(KEYBOARD_TARGET, /contenteditable/);
});
