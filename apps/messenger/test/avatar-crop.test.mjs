// 프로필 사진 자르기(유건 피드백 4, 2026-10-01 밤): 정사각형 틀 안에서 끌어 옮기고 확대·축소한 뒤 저장. 계산은 src/avatar-crop.mjs(순수).
import test from 'node:test';
import assert from 'node:assert/strict';
import { coverScale, clampOffset, cropRect, clampZoom, ZOOM_MAX } from '../src/avatar-crop.mjs';

test('처음 배율은 틀을 꽉 채운다(짧은 변 = 틀), 확대는 1~최대', () => {
  assert.equal(coverScale(1200, 800, 300), 300 / 800);
  assert.equal(coverScale(500, 1000, 250), 0.5);
  assert.equal(clampZoom(0.4), 1); assert.equal(clampZoom(9), ZOOM_MAX); assert.equal(clampZoom(2.5), 2.5);
});

test('끌기 한계 — 사진이 틀 밖으로 빠져 빈 자리가 보이지 않게', () => {
  // 1200×800, 틀 300, 확대 1 → 배율 0.375, 그린 크기 450×300: 가로로만 ±75 움직인다
  assert.deepEqual(clampOffset({ w: 1200, h: 800, frame: 300, zoom: 1, x: 200, y: -40 }), { x: 75, y: 0 });
  assert.deepEqual(clampOffset({ w: 1200, h: 800, frame: 300, zoom: 2, x: -1000, y: 1000 }), { x: -300, y: 150 });
  assert.deepEqual(clampOffset({ w: 800, h: 800, frame: 300, zoom: 1, x: 5, y: 5 }), { x: 0, y: 0 });
});

test('잘라낼 영역 — 가운데·옮김·확대가 원본 좌표의 정사각형으로', () => {
  assert.deepEqual(cropRect({ w: 1200, h: 800, frame: 300, zoom: 1, x: 0, y: 0 }), { sx: 200, sy: 0, size: 800 }, '가운데 정사각형(지금 저장 방식과 같다)');
  assert.deepEqual(cropRect({ w: 1200, h: 800, frame: 300, zoom: 1, x: 75, y: 0 }), { sx: 0, sy: 0, size: 800 }, '오른쪽으로 끝까지 밀면 왼쪽 끝');
  const z = cropRect({ w: 1200, h: 800, frame: 300, zoom: 2, x: 0, y: 0 });
  assert.deepEqual(z, { sx: 400, sy: 200, size: 400 }, '2배 확대면 가운데 절반');
  const r = cropRect({ w: 1200, h: 800, frame: 300, zoom: 4, x: -999, y: -999 }); // 한계를 넘는 값도 안에서 자른다
  assert.ok(r.sx >= 0 && r.sy >= 0 && r.sx + r.size <= 1200 + 1e-9 && r.sy + r.size <= 800 + 1e-9, JSON.stringify(r));
});
