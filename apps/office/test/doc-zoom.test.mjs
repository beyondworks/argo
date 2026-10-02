import test from 'node:test';
import assert from 'node:assert/strict';
import { clampZoom, stepZoom, fitZoom, zoomAt, pageAt, PAGE_W, PAGE_H, PAGE_GAP, STAGE_PAD } from '../src/docs/zoom-model.js';

// 이유(유건 10/2 13차): 견적서·계약서 미리보기를 크게 펼쳐 확대해 보고 싶다 — 배율 50~400%, 포인터 자리 기준 확대, 폭·쪽 맞춤.
test('배율은 50~400% 안, − / +는 정해진 계단으로', () => {
  assert.equal(clampZoom(10), 4); assert.equal(clampZoom(0.1), 0.5); assert.equal(clampZoom('x'), 1);
  assert.equal(stepZoom(1, 1), 1.1); assert.equal(stepZoom(1, -1), 0.9);
  assert.equal(stepZoom(4, 1), 4); assert.equal(stepZoom(0.5, -1), 0.5); // 끝에서는 그대로
  assert.equal(stepZoom(1.2, 1), 1.25); assert.equal(stepZoom(1.2, -1), 1.1); // 핀치로 생긴 사이 값에서도 다음 계단
});

test('폭 맞춤은 쪽 폭이 무대 폭에, 쪽 맞춤은 한 쪽 전체가 무대에 들어온다', () => {
  const stage = { width: PAGE_W + STAGE_PAD * 2, height: 900 };
  assert.equal(fitZoom('width', stage), 1);
  const z = fitZoom('page', stage);
  assert.ok(PAGE_H * z <= 900 - STAGE_PAD * 2 + 0.5 && z < 1);
  assert.equal(fitZoom('width', { width: 100, height: 100 }), 0.5); // 아주 좁아도 50% 아래로 안 간다
});

test('포인터 자리 기준 확대 — 그 자리가 가리키던 문서 지점이 확대 뒤에도 같은 자리', () => {
  const before = { scrollLeft: 120, scrollTop: 900 }, p = { x: 300, y: 200 };
  const docPoint = (s, z, w = 0) => ({ x: (s.scrollLeft + p.x - STAGE_PAD - Math.max(0, (w - STAGE_PAD * 2 - PAGE_W * z) / 2)) / z, y: (s.scrollTop + p.y - STAGE_PAD) / z });
  const after = zoomAt(before, p, 1, 2);
  const a = docPoint(before, 1), b = docPoint(after, 2);
  assert.ok(Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9);
  // 넓은 무대(쪽이 가운데) → 확대해 무대보다 넓어져도 같은 지점
  const W = 1400, q = { x: 700, y: 300 }, s0 = { scrollLeft: 0, scrollTop: 0 }, s1 = zoomAt(s0, q, 1, 2.5, W);
  const pt = (s, z) => ({ x: (s.scrollLeft + q.x - STAGE_PAD - Math.max(0, (W - STAGE_PAD * 2 - PAGE_W * z) / 2)) / z, y: (s.scrollTop + q.y - STAGE_PAD) / z });
  const c = pt(s0, 1), d = pt(s1, 2.5);
  assert.ok(Math.abs(c.x - d.x) < 1e-9 && Math.abs(c.y - d.y) < 1e-9);
  const out = zoomAt({ scrollLeft: 0, scrollTop: 0 }, { x: 400, y: 400 }, 2, 0.5); assert.ok(out.scrollLeft === 0 && out.scrollTop === 0); // 줄일 때 음수로 안 간다
});

test('쪽 번호 — 스크롤 위치로 지금 쪽을, 1~쪽 수 안에서', () => {
  assert.equal(pageAt(0, 1, 3), 1);
  assert.equal(pageAt(STAGE_PAD + PAGE_H + PAGE_GAP + 10, 1, 3), 2);
  assert.equal(pageAt(99999, 1, 3), 3);
  assert.equal(pageAt(STAGE_PAD + (PAGE_H * 2 + PAGE_GAP) + 5, 2, 3), 2);
});
