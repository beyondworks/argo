// 12차 추가 2(유건 10/2) — 가림 입자를 참고 영상(refs10/shimmer.mov)과 같게. 규칙마다 이유 한 줄. node --test test/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { particleCount, spawn, step, burst, revealFade } from '../src/ui/dust-model.js';

const seq = (seed = 7) => () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };

// 이유(영상 실측·나란히 비교): 띠 넓이의 15~20%가 칠해지는 밀도(13px²에 하나) — 띠 넓이에 비례한다(가린 칸이 커도 같은 밀도)
test('밀도: 띠 넓이에 비례', () => {
  assert.equal(particleCount(108, 15), Math.round((108 * 15) / 13));
  assert.equal(particleCount(216, 15), Math.round((216 * 15) / 13));
  assert.equal(particleCount(4, 4), 12); // 아주 작은 칸도 띠로 보이게 최소 12개
});

// 이유(영상): 입자는 1~2px(가끔 3px), 띠 안에서 태어나고 가장자리로 갈수록 옅다(테두리가 들쭉날쭉) — 글자색, 점마다 진하기가 다르다
test('입자: 크기·자리·가장자리', () => {
  const rnd = seq(), w = 120, h = 16, ps = Array.from({ length: 2000 }, () => spawn(w, h, rnd));
  assert.ok(ps.every((p) => p.x >= 0 && p.x <= w && p.y >= 0 && p.y <= h && [1, 1.5, 2, 3].includes(p.s)));
  const share = (s) => ps.filter((p) => p.s === s).length / ps.length;
  assert.ok(share(3) < 0.1 && share(1) + share(1.5) > 0.6); // 1~2px, 가끔 3px
  const peak = (f) => { const xs = ps.filter(f); return xs.reduce((n, p) => n + p.peak, 0) / xs.length; };
  assert.ok(peak((p) => p.x < 3 || p.x > w - 3) < peak((p) => p.x > 20 && p.x < w - 20) * 0.6); // 양끝은 옅다
  assert.ok(peak((p) => Math.abs(p.y - h / 2) > h * 0.4) < peak((p) => Math.abs(p.y - h / 2) < h * 0.1)); // 위아래 끝도
});

// 이유(영상): 점이 떠다니고 깜빡이며(나타났다 사라짐) 수명이 다하면 새 자리에서 다시 생긴다
test('움직임: 떠다니고 깜빡이고 다시 생긴다', () => {
  const rnd = seq(3), p = spawn(100, 16, rnd);
  const x0 = p.x, life = p.life;
  p.age = 0; step(p, 0.01, 100, 16, rnd); assert.ok(p.alpha < p.peak * 0.2); // 막 태어난 점은 옅다
  p.age = life / 2 - 0.01; step(p, 0.01, 100, 16, rnd); assert.ok(Math.abs(p.alpha - p.peak) < 0.01); // 수명 가운데는 또렷하다
  assert.notEqual(p.x, x0);
  p.age = life; step(p, 0.01, 100, 16, rnd); assert.ok(p.age < 0.02); // 새로 태어났다
});

// 이유(영상 4.55~4.85초): 누르면 약 0.1초는 점이 흩어지고 0.28초쯤 다 사라진다(글자는 그 뒤 0.1초 동안 나타난다 — redact.css)
test('열기: 바깥으로 흩어지며 사라진다', () => {
  assert.equal(revealFade(0), 1); assert.equal(revealFade(100), 1); assert.ok(revealFade(190) > 0.2 && revealFade(190) < 0.8); assert.equal(revealFade(280), 0);
  const rnd = seq(11), w = 100, h = 16;
  const left = spawn(w, h, rnd); left.x = 10; left.y = 8; burst(left, w, h, rnd);
  assert.ok(left.vx < 0 && left.burst);
  let t = 0; while (t < 0.28) { step(left, 1 / 60, w, h, rnd); t += 1 / 60; }
  assert.ok(left.alpha * revealFade(280) < 0.05);
});
