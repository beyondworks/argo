// 오른쪽 패널 폭(유건 9/30 #8) — 끌기·키보드가 같은 한계 안에서 움직이고, 기억한 값이 깨져도 기본 폭으로 연다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PANEL_MIN, PANEL_DEFAULT, PANEL_ROOM, PANEL_STEP, clampWidth, widthForKey, readPref, maxWidth } from '../src/ui/panel-model.js';

// 이유: 너무 좁으면 내용이 안 보이고, 너무 넓으면 뒤 화면이 사라져 패널인지 알 수 없다.
test('clampWidth: 최소·최대(창 폭 − 여유), 숫자 아님은 기본 폭', () => {
  assert.equal(clampWidth(100, 1920), PANEL_MIN);
  assert.equal(clampWidth(5000, 1920), 1920 - PANEL_ROOM);
  assert.equal(clampWidth(640.4, 1920), 640);
  assert.equal(clampWidth('x', 1920), PANEL_DEFAULT);
  assert.equal(clampWidth(700, 500), PANEL_MIN); // 창이 좁아도 최소보다 작아지지 않는다(폰 폭은 CSS가 전체 폭으로)
  assert.equal(maxWidth(1920), 1920 - PANEL_ROOM);
});

// 이유: 손잡이는 키보드로도 조절돼야 한다 — 패널이 오른쪽에 붙어 있으니 ←가 넓히기다.
test('widthForKey: ←/→ 한 칸, Home/End 끝, 다른 키는 null', () => {
  assert.equal(widthForKey('ArrowLeft', 600, 1920), 600 + PANEL_STEP);
  assert.equal(widthForKey('ArrowRight', 600, 1920), 600 - PANEL_STEP);
  assert.equal(widthForKey('ArrowRight', PANEL_MIN, 1920), PANEL_MIN);
  assert.equal(widthForKey('Home', 900, 1920), PANEL_MIN);
  assert.equal(widthForKey('End', 900, 1920), 1920 - PANEL_ROOM);
  assert.equal(widthForKey('Enter', 900, 1920), null);
});

// 이유: localStorage 값은 사람이 지우거나 깨질 수 있다. 예전 옆 패널(Peek)에서 맞춘 폭은 이어받는다.
test('readPref: 깨진 값·빈 값·예전 Peek 폭', () => {
  assert.deepEqual(readPref('{"width":700,"full":true}', null), { width: 700, full: true });
  assert.deepEqual(readPref('{깨짐', null), { width: PANEL_DEFAULT, full: false });
  assert.deepEqual(readPref(null, '{"mode":"side","width":820}'), { width: 820, full: false });
  assert.deepEqual(readPref('{"full":"yes"}', null), { width: PANEL_DEFAULT, full: false });
});
