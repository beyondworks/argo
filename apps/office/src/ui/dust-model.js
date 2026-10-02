// 가림 입자 계산(12차 추가 2) — 화면 없이 시험한다(test/dust.test.mjs). 그리기·루프는 dust.js. 단위는 CSS px·초.
// 참고 영상 실측(refs10/shimmer.mov): 진한 점 평균 2×2px ≈ 32px²에 하나 + 옅은 점, 띠 넓이의 15~20%가 칠해지고, 가장자리로 갈수록 듬성하다.

/** 띠 크기 → 입자 수(진한 것·옅은 것 합) */
export const particleCount = (w, h) => Math.max(12, Math.round((w * h) / 16));
/** 입자 크기 — 1px 40%·1.5px 35%·2px 20%·3px 5%(영상의 1~2px, 가끔 3px) */
const size = (r) => (r < 0.4 ? 1 : r < 0.75 ? 1.5 : r < 0.95 ? 2 : 3);

/** 새 입자 — 가로는 고르게, 세로는 가운데가 짙게(삼각 분포). 가장자리 8px·위아래 끝으로 갈수록 옅고 드물어 띠 테두리가 들쭉날쭉하다. 깜빡임은 수명 동안 sin 곡선 */
export function spawn(w, h, rnd) {
  const x = rnd() * w, y = h / 2 + (rnd() + rnd() - 1) * (h / 2);
  const edge = Math.min(Math.min(1, Math.min(x, w - x) / 8), 0.35 + 0.65 * (1 - Math.abs(y - h / 2) / (h / 2)));
  const dark = rnd() < 0.5, peak = (dark ? 0.55 + 0.45 * rnd() : 0.15 + 0.3 * rnd()) * edge;
  const life = 0.5 + rnd() * 1.1, age = rnd() * life, ang = rnd() * Math.PI * 2, sp = 2 + rnd() * 6;
  return { x, y, s: size(rnd()), peak, life, age, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, alpha: peak * Math.sin((Math.PI * age) / life), burst: false };
}
/** dt초 지나기 — 떠다니고(2~8px/초) 수명이 다하면 새 자리에서 다시 태어난다. 흩어지는 중(burst)이면 빠르게 옅어진다 */
export function step(p, dt, w, h, rnd) {
  p.age += dt; p.x += p.vx * dt; p.y += p.vy * dt;
  if (p.burst) { p.alpha = Math.max(0, p.alpha - dt * 3.6); return p; }
  if (p.age >= p.life) Object.assign(p, spawn(w, h, rnd), { age: 0, alpha: 0 });
  else p.alpha = p.peak * Math.sin((Math.PI * p.age) / p.life);
  return p;
}
/** 열기 — 띠 가운데에서 바깥으로 40~110px/초로 흩어진다(약 0.28초면 사라진다) */
export function burst(p, w, h, rnd) {
  const dx = p.x - w / 2, dy = p.y - h / 2, d = Math.hypot(dx, dy) || 1, sp = 40 + rnd() * 70;
  p.vx = (dx / d) * sp + (rnd() - 0.5) * 20; p.vy = (dy / d) * sp * 0.6 + (rnd() - 0.5) * 20;
  p.alpha = Math.max(p.alpha, p.peak * 0.8); p.burst = true;
  return p;
}
