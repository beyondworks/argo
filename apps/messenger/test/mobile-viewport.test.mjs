import test from 'node:test';
import assert from 'node:assert/strict';
import { viewportVars } from '../src/viewport-vars.mjs';

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
