// 가림 입자 계산(12차 추가 2) — 화면 없이 시험한다(test/dust.test.mjs). 그리기·루프는 dust.js. 단위는 CSS px·초.
// 참고 영상 실측(refs10/shimmer.mov): 진한 점 평균 2×2px, 띠 넓이의 15~20%가 칠해지고, 가장자리로 갈수록 듬성하다 — 5400 연속 캡처와 나란히 놓고 맞춘 값.

/** 띠 크기 → 입자 수(진한 것·옅은 것 합) */
/** 열기 중 입자 진하기 배율 — 처음 100ms는 그대로 흩어지다가 280ms까지 부드럽게 사라진다 */
export const revealFade = (ms) => { const u = Math.min(1, Math.max(0, (ms - 100) / 180)); return 1 - u * u * (3 - 2 * u); };

export const particleCount = (w, h) => Math.max(12, Math.round((w * h) / 13));
/** 입자 크기 — 1px 30%·1.5px 40%·2px 26%·3px 4%(영상의 진한 점 1~2px, 가끔 3px) */
const size = (r) => (r < 0.3 ? 1 : r < 0.7 ? 1.5 : r < 0.96 ? 2 : 3);

/** 깜빡임 — 수명 앞뒤 끝에서 나타나고 사라지고 그 사이는 거의 다 보인다(영상: 점이 대부분 또렷하고 일부만 명멸) */
export const glow = (peak, age, life) => peak * Math.min(1, 2.2 * Math.sin((Math.PI * Math.min(age, life)) / life));

/** 새 입자 — 가로는 고르게, 세로는 가운데가 짙게(삼각 분포). 가장자리 8px·위아래 끝으로 갈수록 옅고 드물어 띠 테두리가 들쭉날쭉하다. 깜빡임은 수명 동안 sin 곡선 */
export function spawn(w, h, rnd) {
  const x = rnd() * w, y = h / 2 + (rnd() + rnd() - 1) * (h / 2);
  const edge = Math.min(Math.min(1, Math.min(x, w - x) / 6), 0.35 + 0.65 * (1 - Math.abs(y - h / 2) / (h / 2)));
  const dark = rnd() < 0.65, peak = (dark ? 0.85 + 0.15 * rnd() : 0.25 + 0.3 * rnd()) * edge;
  const life = 0.5 + rnd() * 1.1, age = rnd() * life, ang = rnd() * Math.PI * 2, sp = 2 + rnd() * 6;
  return { x, y, s: size(rnd()), peak, life, age, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, alpha: glow(peak, age, life), burst: false };
}
/** dt초 지나기 — 떠다니고(2~8px/초) 수명이 다하면 새 자리에서 다시 태어난다. 흩어지는 중(burst)이면 빠르게 옅어진다 */
export function step(p, dt, w, h, rnd) {
  p.age += dt; p.x += p.vx * dt; p.y += p.vy * dt;
  if (p.burst) { p.alpha = Math.max(0, p.alpha - dt * 2.2); return p; }
  if (p.age >= p.life) Object.assign(p, spawn(w, h, rnd), { age: 0, alpha: 0 });
  else p.alpha = glow(p.peak, p.age, p.life);
  return p;
}
/** 열기 — 띠 가운데에서 바깥으로 30~70px/초로 흩어지며 옅어진다(영상: 누른 뒤 약 0.15초는 점이 흩어지고, 0.25초쯤 다 사라지며 글자가 나타난다) */
export function burst(p, w, h, rnd) {
  const dx = p.x - w / 2, dy = p.y - h / 2, d = Math.hypot(dx, dy) || 1, sp = 30 + rnd() * 40;
  p.vx = (dx / d) * sp + (rnd() - 0.5) * 20; p.vy = (dy / d) * sp * 0.6 + (rnd() - 0.5) * 20;
  p.alpha = Math.max(p.alpha, p.peak * 0.8); p.burst = true;
  return p;
}
