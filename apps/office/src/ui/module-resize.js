// 모듈 가장자리 끌기(유건 10/1) — 처음 가장자리에 다가갈 때 불러온다(첫 화면 묶음 밖).
// 끄는 동안은 화면(CSS 변수 --span·--rh)만 바꾸고 손을 떼면 한 번 저장한다. Esc = 취소, 두 번 누르기 = 그 방향 되돌리기.
// 줄 구성은 지금 화면에서 읽는다 — 좁은 폭(한 줄에 하나)과 넓은 폭이 같은 코드로 맞는다.
import { flipGrid } from '../core/motion.js';
import { spanOf, spanRange } from '../core/layout.js';
import { dragSpans, snapH, applySizes, resetSize, MIN_H, STEP_H } from '../core/module-size.js';

const isX = (side) => side === 'l' || side === 'r';
const itemOf = (ctx, el) => ctx.items.find((item) => item.id === el.dataset.mod);
/** 화면에서 같은 줄(같은 높이에서 시작)인 모듈. 미끄러지는 중(transform)에도 흔들리지 않게 offsetTop으로 잰다 */
const rowOf = (el) => [...el.parentElement.children].filter((node) => node.dataset.mod && Math.abs(node.offsetTop - el.offsetTop) < 2);

/** 폭: 맞닿은 옆 모듈이 있으면 그 경계(두 모듈), 줄 끝 바깥 가장자리면 이 모듈만 */
function widthPlan(ctx, side) {
  const row = rowOf(ctx.el), index = row.indexOf(ctx.el), near = row[side === 'r' ? index + 1 : index - 1];
  const [a, b] = side === 'l' && near ? [near, ctx.el] : [ctx.el, near]; // 왼쪽 경계는 앞 모듈의 오른쪽 경계와 같다
  const A = itemOf(ctx, a), B = b && itemOf(ctx, b);
  return { x: true, a, b, A, B, sign: side === 'l' && !near ? -1 : 1, from: [spanOf(A), B ? spanOf(B) : null],
    room: 12 - row.reduce((sum, node) => sum + (node === a ? 0 : spanOf(itemOf(ctx, node))), 0),
    ra: spanRange(ctx.modOf(A).sizes), rb: B && spanRange(ctx.modOf(B).sizes) };
}

/** 높이: 같은 줄은 줄 높이를 같이 쓴다 — 위 가장자리는 같은 줄 높이를 반대 방향으로 */
function heightPlan(ctx, side) {
  const row = rowOf(ctx.el);
  return { x: false, row, from: ctx.el.offsetHeight, sign: side === 'b' ? 1 : -1, min: Math.max(...row.map((node) => ctx.modOf(itemOf(ctx, node)).minH ?? MIN_H)) };
}

const nextSpans = (plan, cur, d) => dragSpans({ a: cur[0], b: cur[1], d: plan.sign * d, ra: plan.ra, rb: plan.rb, room: plan.room });
/** 바뀌었나 — 높이는 반 눈금(4px) 미만 차이면 그대로(정한 적 없는 줄의 내용 높이는 8의 배수가 아니다. 살짝 누른 것으로 줄 높이가 고정되던 결함) */
const changed = (plan, cur) => (plan.x ? cur[0] !== plan.from[0] || cur[1] !== plan.from[1] : Math.abs(cur - plan.from) >= STEP_H / 2);
const els = (plan) => (plan.x ? [plan.a, plan.b].filter(Boolean) : plan.row);
const patchOf = (plan, cur) => (plan.x ? { [plan.A.id]: { span: cur[0] }, ...(plan.B ? { [plan.B.id]: { span: cur[1] } } : {}) } : Object.fromEntries(plan.row.map((node) => [node.dataset.mod, { h: cur }])));
const valueNow = (node, axis, value) => node.querySelectorAll(`:scope > .edge-${axis}`).forEach((edge) => edge.setAttribute('aria-valuenow', value));
/** 미리 보이기 — 저장되면 React가 같은 값을 다시 그린다 */
function show(plan, cur) {
  if (plan.x) flipGrid(plan.a.parentElement, () => els(plan).forEach((node, i) => { node.style.setProperty('--span', cur[i]); valueNow(node, 'x', cur[i]); })); // 열 단위로 붙으며 옆 모듈이 미끄러진다
  else plan.row.forEach((node) => { node.classList.add('sized-h', 'own-h'); node.style.setProperty('--rh', `${cur}px`); node.style.setProperty('--mh', `${cur}px`); valueNow(node, 'y', cur); });
}
const snapshot = (nodes) => nodes.map((node) => [node, node.className, node.getAttribute('style')]);
const restore = (saved) => saved.forEach(([node, className, style]) => { node.className = className; if (style == null) node.removeAttribute('style'); else node.setAttribute('style', style); });

/** 한 번 저장 — 미리 보인 화면 그대로 저장해 놓고, 저장이 거절되면 원래 모습으로 */
function save(ctx, patch, saved) {
  if (!Object.keys(patch).length) return;
  Promise.resolve(ctx.commit(applySizes(ctx.items, patch, ctx.modOf))).then((ok) => { if (!ok && saved) restore(saved); });
}

export function drag(ctx, p, side) {
  if (!p.target.hasPointerCapture(p.id)) return; // 불러오는 사이에 손을 뗐다
  const { el } = ctx, grid = el.parentElement, x = isX(side);
  const plan = x ? widthPlan(ctx, side) : heightPlan(ctx, side);
  const saved = snapshot(els(plan));
  const gap = parseFloat(getComputedStyle(grid).columnGap) || 0, col = (grid.getBoundingClientRect().width + gap) / 12;
  let cur = plan.from, live = false;
  const states = [[el, 'resizing'], [grid, x ? 'cols-on' : 'rows-on'], [document.body, `edge-drag-${x ? 'x' : 'y'}`]];
  p.target.classList.add('on');
  const move = (e) => {
    if (e.pointerId !== p.id) return;
    if (!live) { // 4px 넘게 움직여야 끌기 — 누르기·두 번 누르기가 크기를 바꾸지 않게
      if (Math.hypot(e.clientX - p.x, e.clientY - p.y) < 4) return;
      live = true; states.forEach(([node, name]) => node.classList.add(name));
    }
    const next = x ? nextSpans(plan, plan.from, Math.round((e.clientX - p.x) / col)) : snapH(plan.from + plan.sign * (e.clientY - p.y), plan.min);
    if (x ? next[0] === cur[0] && next[1] === cur[1] : next === cur) return;
    cur = next; show(plan, cur);
  };
  const end = (keep) => {
    window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', cancel); window.removeEventListener('keydown', esc, true);
    states.forEach(([node, name]) => node.classList.remove(name)); p.target.classList.remove('on');
    if (p.target.hasPointerCapture(p.id)) p.target.releasePointerCapture(p.id);
    if (keep && changed(plan, cur) && el.isConnected) save(ctx, patchOf(plan, cur), saved);
    else if (cur !== plan.from) flipGrid(grid, () => restore(saved));
  };
  const up = (e) => { if (e.pointerId === p.id) end(true); };
  const cancel = (e) => { if (e.pointerId === p.id) end(false); };
  const esc = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); end(false); } };
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', cancel); window.addEventListener('keydown', esc, true);
}

/** 키보드: 폭 손잡이 ←/→ = 1열, 높이 손잡이 ↑/↓ = 16px. 화살표는 가장자리가 움직이는 쪽.
 *  누를 때마다 바로 보이고, 손을 멈추면(0.4초) 한 번 저장한다 — 빠르게 누르면 다시 그리기 전의 높이를 읽어 단계가 빠지던 결함 */
let typing = null;
function flush() {
  const k = typing;
  typing = null;
  if (!k) return;
  clearTimeout(k.timer);
  if (changed(k.plan, k.cur) && k.ctx.el.isConnected) save(k.ctx, patchOf(k.plan, k.cur), k.saved);
  else if (k.cur !== k.plan.from) restore(k.saved);
}
export function key(ctx, { key: name }, side) {
  const x = isX(side), dir = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 1, ArrowUp: -1 }[name];
  if (x !== (name === 'ArrowRight' || name === 'ArrowLeft')) return;
  if (typing && (typing.ctx.el !== ctx.el || typing.side !== side)) flush();
  if (!typing) { const plan = x ? widthPlan(ctx, side) : heightPlan(ctx, side); typing = { plan, side, cur: plan.from, saved: snapshot(els(plan)) }; }
  const k = typing, { plan } = k;
  k.ctx = ctx;
  const next = x ? nextSpans(plan, k.cur, dir) : snapH(k.cur + plan.sign * dir * 16, plan.min);
  if (x ? next[0] !== k.cur[0] || next[1] !== k.cur[1] : next !== k.cur) { k.cur = next; show(plan, next); }
  clearTimeout(k.timer);
  k.timer = setTimeout(flush, 400);
}
/** 초점이 손잡이를 떠나면 기다리지 않고 저장 */
export const blur = () => flush();

/** 두 번 누르기 — 그 방향 크기만 되돌린다(폭: 경계를 같이 쓰는 두 모듈, 높이: 그 줄) */
export function reset(ctx, _, side) {
  if (isX(side)) {
    const plan = widthPlan(ctx, side);
    save(ctx, Object.fromEntries([plan.A, plan.B].filter((item) => item && 'span' in item).map((item) => [item.id, { span: null }])));
  } else save(ctx, Object.fromEntries(heightPlan(ctx, side).row.map((node) => itemOf(ctx, node)).filter((item) => 'h' in item).map((item) => [item.id, { h: 0 }])));
}

/** ⋯ 크기 되돌리기 */
export const resetAll = (ctx) => ctx.commit(resetSize(ctx.items, ctx.el.dataset.mod, ctx.modOf));
