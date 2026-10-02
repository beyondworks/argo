// 모듈 가장자리 끌기(유건 10/1, 10/1 저녁 자유 격자) — 처음 가장자리에 다가갈 때 불러온다(첫 화면 묶음 밖).
// 늘 그 모듈만 바뀐다(옆 모듈과 경계를 같이 끌지 않는다). 끄는 동안은 그 모듈만 크기가 바뀌어 보이고 다른 모듈은 제자리에 있다.
// 손을 떼면 한 번 저장하고, 새 크기와 겹친 모듈만 아래로 밀린다(7차 — 위로 붙지 않는다, 줄이면 빈칸). Esc = 취소, 두 번 누르기 = 그 방향 되돌리기(그 모듈만).
// 위 가장자리(넓은 화면)는 위 끝이 움직이고 아래 끝은 그대로다(유건 7차 3) — 위로는 위 모듈 아래 끝 + 틈에서 멈춘다. 좁은 폭(한 줄에 하나)은 높이만.
import { spanOf, spanRange, minHeight } from '../core/layout.js';
import { resizeX, snapH, stepH, magnet, applySizes, resetPatch, STEP_H, MAX_H } from '../core/module-size.js';
import { around, ceiling, settle } from '../core/grid-move.js';
import { readGrid } from './grid-dom.js';

const isX = (side) => side === 'l' || side === 'r';

/** 이 모듈과 지금 격자 — 폭은 { x, w }(열), 높이는 px. 왼쪽·위 가장자리는 끄는 방향과 크기가 반대다 */
function planOf(ctx, side) {
  const g = readGrid(ctx.el, ctx.items), id = ctx.el.dataset.mod, me = g.boxes.find((b) => b.id === id), mod = ctx.modOf(ctx.items.find((it) => it.id === id));
  // 최소 높이 = 머리 + 본문 최소(머리를 숨긴 모양이면 0)
  const pl = { ...g, ctx, id, me, side, x: isX(side), ra: spanRange(mod.sizes), min: minHeight(mod, ctx.el.querySelector(':scope > .module-head')?.offsetHeight ?? 0), from: isX(side) ? { x: me.x, w: me.w } : me.h };
  // 위 가장자리(넓은 화면): 아래 끝 고정, 위 끝은 ceil(위 모듈 아래 끝 + 틈) ~ 아래 끝 - 최소 높이
  if (side === 't' && !g.narrow) Object.assign(pl, { top: true, bottom: me.top + me.h, ceil: ceiling(g.boxes, id, g.gap), tops: g.boxes.filter((b) => b.id !== id).map((b) => b.top) });
  return pl;
}

/** 위 가장자리 높이 — 위 끝(8px 눈금)을 위 모듈 아래 끝 + 틈과 최대 높이 사이로, 다른 모듈 위 끝 6px 안이면 맞춘다. 돌려주는 값 = 높이(아래 끝 - 위 끝) */
function topH(pl, top) {
  const lo = Math.max(pl.ceil, pl.bottom - MAX_H), hi = pl.bottom - pl.min, at = Math.max(lo, Math.min(hi, Math.round(top / STEP_H) * STEP_H));
  const near = pl.tops.find((v) => Math.abs(v - at) <= 6 && v >= lo && v <= hi);
  return pl.bottom - (near ?? at);
}

const changed = (pl, cur) => (pl.x ? cur.x !== pl.from.x || cur.w !== pl.from.w : Math.abs(cur - pl.from) >= STEP_H / 2); // 반 눈금 미만이면 그대로(살짝 누른 것으로 높이가 고정되지 않게)
const valueNow = (node, axis, value) => node.querySelectorAll(`:scope > .edge-${axis}`).forEach((edge) => edge.setAttribute('aria-valuenow', value));

/** 넓은 화면이면 모든 모듈을 지금 자리에 고정한다 — 이 모듈 크기만 바뀌고 다른 모듈은 움직이지 않게. 걷을 때는 끄는 코드가 더한 것만 지운다:
 *  React가 쓰는 값(--y 같은 변수·className)은 끄는 도중에도 다시 그려질 수 있어(내용 높이 재기), 통째로 되돌리면 최신 자리를 옛 값으로 덮는다(10/1 저녁 실측: 겹침) */
const PINNED = ['position', 'left', 'top', 'width', 'height'];
function pin(pl) {
  const nodes = [...pl.grid.children].filter((node) => node.dataset.mod);
  const keep = { el: pl.ctx.el, grid: pl.grid, nodes, added: [], edges: [...pl.ctx.el.querySelectorAll(':scope > .edge')].map((edge) => [edge, edge.getAttribute('aria-valuenow')]) };
  if (!pl.narrow) {
    const rects = nodes.map((node) => [node, node.offsetLeft, node.offsetTop, node.offsetWidth, node.offsetHeight]);
    pl.grid.style.height = `${pl.grid.offsetHeight}px`;
    for (const [node, l, top, w, h] of rects) Object.assign(node.style, { position: 'absolute', left: `${l}px`, top: `${top}px`, width: `${w}px`, height: `${h}px` });
  }
  return keep;
}
const unpin = (keep) => {
  for (const node of keep.nodes) PINNED.forEach((name) => node.style.removeProperty(name));
  keep.grid.style.removeProperty('height');
  keep.added.forEach((name) => keep.el.classList.remove(name));
  keep.edges.forEach(([edge, value]) => (value == null ? edge.removeAttribute('aria-valuenow') : edge.setAttribute('aria-valuenow', value)));
};

/** 열 눈금을 끄는 모듈의 위·아래 틈에 둔다(base.css .grid::before) */
function ruler(el) { el.parentElement.style.setProperty('--ruler-top', `${el.offsetTop}px`); el.parentElement.style.setProperty('--ruler-h', `${el.offsetHeight}px`); }

/** 미리 보이기 — 이 모듈만 */
function show(pl, cur, keep) {
  const el = pl.ctx.el;
  if (pl.x) { Object.assign(el.style, { left: `${cur.x * pl.col}px`, width: `${cur.w * pl.col - pl.gap}px` }); valueNow(el, 'x', cur.w); ruler(el); return; }
  for (const name of ['sized-h', 'own-h']) if (!el.classList.contains(name)) { el.classList.add(name); keep.added.push(name); } // 정한 높이 안에서 본문이 스크롤되게
  el.style.height = `${cur}px`; valueNow(el, 'y', cur);
  if (pl.top) el.style.top = `${pl.bottom - cur}px`; // 위 가장자리: 아래 끝은 그대로
}

/** 한 번 저장 — 이 모듈 크기만 바꾸고(옛 앱용 size·span도 같이), 모두의 자리(x·y)를 다시 쌓아 저장한다. 미리 보인 모습은 저장 요청 직후(다시 그리기 전) 걷는다 — 그 자리에서 미끄러진다 */
function save(pl, cur, keep) {
  const { ctx, id } = pl, patch = pl.x ? { span: cur.w } : { h: cur };
  const items = applySizes(ctx.items, { [id]: patch }, ctx.modOf);
  const placed = pl.narrow ? pl.boxes.map((b) => (b.id === id ? { ...b, h: cur } : b)) : around(pl.boxes, id, pl.x ? cur : pl.top ? { h: cur, top: pl.bottom - cur } : { h: cur }, pl.gap);
  ctx.commit(settle(items, placed, pl.narrow ? pl.xs : null));
  unpin(keep);
}

export function drag(ctx, p, side) {
  if (!p.target.hasPointerCapture(p.id)) return; // 불러오는 사이에 손을 뗐다
  if (!ctx.canEdit) { p.target.releasePointerCapture(p.id); return; } // 저장 중(aria-disabled) — 끌어도 저장되지 않으니 시작하지 않는다
  const pl = planOf(ctx, side), { el } = ctx, { grid } = pl;
  let cur = pl.from, saved = null;
  const states = [[el, 'resizing'], [grid, pl.x ? 'cols-on' : 'rows-on'], [document.body, `edge-drag-${pl.x ? 'x' : 'y'}`]];
  p.target.classList.add('on');
  // 높이 자석 대상 = 다른 모듈들의 아래 끝(넓은 화면)
  const edges = pl.narrow ? [] : pl.boxes.filter((b) => b.id !== pl.id).map((b) => b.top + b.h);
  const move = (e) => {
    if (e.pointerId !== p.id) return;
    if (!saved) { // 4px 넘게 움직여야 끌기 — 누르기·두 번 누르기가 크기를 바꾸지 않게
      if (Math.hypot(e.clientX - p.x, e.clientY - p.y) < 4) return;
      saved = pin(pl); states.forEach(([node, name]) => node.classList.add(name)); if (pl.x) ruler(el);
    }
    const next = pl.x ? resizeX({ ...pl.from, d: Math.round((e.clientX - p.x) / pl.col), side, ra: pl.ra })
      : pl.top ? topH(pl, pl.me.top + e.clientY - p.y)
      : magnet(snapH(pl.from + (side === 'b' ? 1 : -1) * (e.clientY - p.y), pl.min), pl.me.top, edges, pl.min);
    if (pl.x ? next.x === cur.x && next.w === cur.w : next === cur) return;
    cur = next; show(pl, cur, saved);
  };
  const end = (keep) => {
    window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', cancel); window.removeEventListener('keydown', esc, true);
    states.forEach(([node, name]) => node.classList.remove(name)); p.target.classList.remove('on');
    if (p.target.hasPointerCapture(p.id)) p.target.releasePointerCapture(p.id);
    if (!saved) return;
    if (keep && changed(pl, cur) && el.isConnected) save(pl, cur, saved);
    else unpin(saved);
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
  if (changed(k.pl, k.cur) && k.pl.ctx.el.isConnected) save(k.pl, k.cur, k.saved);
  else unpin(k.saved);
}
export function key(ctx, { key: name }, side) {
  if (!ctx.canEdit) return; // 저장 중에는 받지 않는다 — 받아 두면 저장이 거절되어 말없이 되돌아갔다(검수 10/1 재현). 초점은 손잡이에 남는다
  const x = isX(side), dir = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 1, ArrowUp: -1 }[name];
  if (x !== (name === 'ArrowRight' || name === 'ArrowLeft')) return;
  if (typing && (typing.pl.ctx.el !== ctx.el || typing.side !== side)) flush();
  if (!typing) { const pl = planOf(ctx, side); typing = { pl, side, cur: pl.from, saved: pin(pl) }; }
  const k = typing, { pl } = k;
  pl.ctx = ctx;
  // 오른쪽 가장자리 →는 넓게, 왼쪽 가장자리 ←는 넓게(시작 열이 왼쪽으로). 높이: 아래 가장자리 ↓·위 가장자리 ↑가 높게
  const next = x ? resizeX({ ...k.cur, d: dir, side, ra: pl.ra }) : pl.top ? topH(pl, pl.bottom - k.cur + dir * 16) : stepH(k.cur, (side === 'b' ? 1 : -1) * dir, pl.min);
  if (x ? next.x !== k.cur.x || next.w !== k.cur.w : next !== k.cur) { k.cur = next; show(pl, next, k.saved); }
  clearTimeout(k.timer);
  k.timer = setTimeout(flush, 400);
}
/** 높이 손잡이에 초점 — 알리는 값(지금 높이)과 최소(이 모듈 최소)를 끌기·키보드와 같은 계산으로 */
export function focus(ctx, target, side) {
  const pl = planOf(ctx, side);
  target.setAttribute('aria-valuenow', Math.round(pl.from / STEP_H) * STEP_H); target.setAttribute('aria-valuemin', pl.min);
}
/** 초점이 손잡이를 떠나면 기다리지 않고 저장 */
export const blur = () => flush();

/** 되돌리기 — 그 모듈만, 바꾼 게 없으면 저장하지 않는다. 폭을 되돌려 옆과 겹치면 겹친 모듈이 아래로 밀린다 */
function undo(ctx, axis) {
  const id = ctx.el.dataset.mod, patch = resetPatch(ctx.items, id, axis);
  if (!patch[id]) return;
  const pl = planOf(ctx, 'r'), items = applySizes(ctx.items, patch, ctx.modOf), back = items.find((it) => it.id === id);
  const placed = pl.narrow ? pl.boxes : around(pl.boxes, id, { w: spanOf(back) }, pl.gap);
  ctx.commit(settle(items, placed, pl.narrow ? pl.xs : null));
}
/** 두 번 누르기 — 그 방향만 */
export const reset = (ctx, _, side) => undo(ctx, isX(side) ? 'span' : 'h');
/** ⋯ 크기 되돌리기 — 폭·높이 둘 다 */
export const resetAll = (ctx) => undo(ctx);
