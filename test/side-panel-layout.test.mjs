// 수평 리사이즈 수학 회귀 — 마우스 이동 방향, 화면/열린 문서 최소 폭, 상한을 UI와 독립 검증한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FILE_TREE_DEFAULT_WIDTH,
  PANEL_DEFAULT_WIDTH,
  clampWidth,
  fileTreeWidthBounds,
  panelWidthBounds,
  widthFromLeftDrag,
} from '../src/side-panel-layout.mjs';

test('패널 폭 경계: 오버레이는 화면 안, 도킹은 채팅 읽기 폭과 900px 상한을 남긴다', () => {
  assert.deepEqual(panelWidthBounds(320), { min: 320, max: 320 });
  assert.deepEqual(panelWidthBounds(1400), { min: 360, max: 900 });
  assert.deepEqual(panelWidthBounds(1800), { min: 360, max: 720 });
  assert.deepEqual(panelWidthBounds(2300), { min: 360, max: 900 });
  assert.equal(clampWidth(PANEL_DEFAULT_WIDTH, 360, 900), 540);
});

test('왼쪽 경계 드래그: 왼쪽으로 끌면 오른쪽 영역이 커지고 경계를 넘지 않는다', () => {
  const bounds = { min: 360, max: 900 };
  assert.equal(widthFromLeftDrag(540, 1000, 900, bounds), 640);
  assert.equal(widthFromLeftDrag(540, 1000, 1200, bounds), 360);
  assert.equal(widthFromLeftDrag(850, 1000, 800, bounds), 900);
});

test('파일 트리 폭 경계: 열린 문서 최소 폭을 보존하고 큰 패널에서도 420px을 넘지 않는다', () => {
  assert.deepEqual(fileTreeWidthBounds(540), { min: 150, max: 354 });
  assert.deepEqual(fileTreeWidthBounds(300), { min: 114, max: 114 });
  assert.deepEqual(fileTreeWidthBounds(900), { min: 150, max: 420 });
  const bounds = fileTreeWidthBounds(540);
  assert.equal(widthFromLeftDrag(FILE_TREE_DEFAULT_WIDTH, 500, 400, bounds), 320);
  assert.equal(widthFromLeftDrag(FILE_TREE_DEFAULT_WIDTH, 500, 700, bounds), 150);
});
