// 가림 입자(12차 추가 2, 유건 10/2 — 참고 영상 refs10/shimmer.mov, 텔레그램 스포일러 계열). 가림이 처음 보일 때 받는다(Redact.jsx, 첫 화면 150KB 상한).
// 글자는 안 보이고 그 자리 줄 높이 띠 안에 1~2px(가끔 3px) 또렷한 점이 흩어져 떠다니며 깜빡이고 새로 생긴다. 띠 가장자리로 갈수록 듬성해 테두리가 들쭉날쭉하다.
// 열기(누르면) = 약 0.28초 동안 입자가 바깥으로 흩어지며 사라지고 글자는 옅게 나타나 원래 색으로(redact.css 투명도 전환). 다시 덮일 때는 반대로.
// 성능: 루프(requestAnimationFrame) 하나가 화면에 보이는 가림만 그린다 — 화면 밖(IntersectionObserver)·숨긴 탭은 멈춘다. 움직임 줄이기 설정이면 정지 입자 한 장.
// 참고 영상 실측(450×148, 글자 높이 12px): 띠 높이 ≈ 글자 높이 × 1.25, 진한 점 ≈ 32px²에 하나(평균 2×2px) + 옅은 점 비슷한 수, 띠 넓이의 15~20%가 칠해진다.
import { particleCount, spawn, step, burst } from './dust-model.js';

const DUR = 280; // 열기·덮기(ms)
const items = new Map(); // span.redact → 상태
let raf = 0, io = null, ro = null;
const opened = new WeakSet(); // 막 열렸던 가림 — 다시 덮일 때 입자가 모여드는 전환을 한다
const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

function measure(it) {
  const el = it.el, v = el.querySelector(':scope > .redact-v'), er = el.getBoundingClientRect(), vr = (v ?? el).getBoundingClientRect();
  const fs = parseFloat(getComputedStyle(el).fontSize) || 13, lh = fs * 1.25;
  const w = Math.max(vr.width, fs * 3.5), h = Math.max(lh, Math.min(vr.height, lh * 2.4)), pad = 6;
  const left = vr.left - er.left, top = vr.top - er.top + (vr.height - h) / 2;
  const dpr = devicePixelRatio || 1, c = it.canvas;
  c.style.cssText = `left:${left - pad}px;top:${top - pad}px;width:${w + pad * 2}px;height:${h + pad * 2}px`;
  c.width = Math.ceil((w + pad * 2) * dpr); c.height = Math.ceil((h + pad * 2) * dpr);
  it.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  it.w = w; it.h = h; it.pad = pad;
  const n = particleCount(w, h);
  it.parts = Array.from({ length: n }, () => spawn(w, h, Math.random));
  it.colorAt = 0;
}

function draw(it, now) {
  const { ctx, w, h, pad } = it;
  if (now - it.colorAt > 1000) { it.color = getComputedStyle(it.el.parentElement ?? it.el).color; it.colorAt = now; } // 글자색(라이트·다크·테마) — 1초마다 다시 읽는다
  ctx.clearRect(0, 0, w + pad * 2, h + pad * 2);
  ctx.fillStyle = it.color;
  const k = it.mode === 'reveal' ? 1 - Math.min(1, (now - it.t0) / DUR) : it.mode === 'cover' ? Math.min(1, (now - it.t0) / DUR) : 1;
  for (const p of it.parts) {
    const a = p.alpha * k;
    if (a < 0.02) continue;
    ctx.globalAlpha = a;
    ctx.fillRect(pad + p.x, pad + p.y, p.s, p.s);
  }
  ctx.globalAlpha = 1;
}

function frame(now) {
  raf = 0;
  if (document.hidden) return;
  let busy = false;
  for (const it of items.values()) {
    if (!it.visible || !it.parts) continue;
    const dt = Math.min(0.05, (now - (it.last ?? now)) / 1000); it.last = now;
    if (it.mode === 'reveal' && now - it.t0 > DUR) { remove(it); continue; }
    if (it.mode === 'cover' && now - it.t0 > DUR) it.mode = 'on';
    for (const p of it.parts) step(p, dt, it.w, it.h, Math.random);
    draw(it, now);
    busy = true;
  }
  if (busy && !still()) raf = requestAnimationFrame(frame);
}
const kick = () => { if (!raf && !document.hidden) raf = requestAnimationFrame(frame); };

function remove(it) {
  if (it.mode === 'reveal') opened.add(it.el);
  it.canvas.remove(); io?.unobserve(it.el); ro?.unobserve(it.el); items.delete(it.el);
}

/** 가림을 보이거나(hidden) 연다 — 바뀔 때마다 Redact가 부른다 */
export function show(el, hidden) {
  if (!el?.isConnected) return;
  let it = items.get(el);
  if (!hidden) { // 열기 — 입자가 흩어지며 사라진다
    if (!it) return;
    if (still()) { remove(it); return; }
    it.mode = 'reveal'; it.t0 = performance.now();
    for (const p of it.parts) burst(p, it.w, it.h, Math.random);
    kick();
    return;
  }
  if (!it) {
    io ??= new IntersectionObserver((list) => { for (const e of list) { const x = items.get(e.target); if (x) { x.visible = e.isIntersecting; x.last = undefined; } } kick(); });
    ro ??= new ResizeObserver((list) => { for (const e of list) { const x = items.get(e.target); if (x && x.mode !== 'reveal') { measure(x); draw(x, performance.now()); } } });
    const canvas = document.createElement('canvas');
    canvas.className = 'dust'; canvas.setAttribute('aria-hidden', 'true');
    el.appendChild(canvas);
    // 처음 그릴 때는 덮인 채로 — 모여드는 전환은 열었다 다시 덮을 때만(움직임 줄이기면 바로)
    it = { el, canvas, ctx: canvas.getContext('2d'), visible: true, mode: opened.has(el) && !still() ? 'cover' : 'on', t0: performance.now() };
    opened.delete(el);
    items.set(el, it);
    measure(it);
    io.observe(el); ro.observe(el);
  } else if (it.mode === 'reveal') { it.mode = 'cover'; it.t0 = performance.now(); for (const p of it.parts) Object.assign(p, spawn(it.w, it.h, Math.random)); }
  draw(it, performance.now());
  kick();
}
/** 가림이 화면에서 떨어질 때 */
export function drop(el) { const it = el && items.get(el); if (it) remove(it); }

document.addEventListener('visibilitychange', kick); // 탭으로 돌아오면 다시
