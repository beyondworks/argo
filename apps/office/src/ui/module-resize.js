// 높이(아래 가장자리)·열 경계선 끌기(9차, 유건 10/2 노션식) — 처음 다가갈 때 불러온다(첫 화면 묶음 밖).
// 높이: 그 모듈만 바뀌고(8px 눈금, 다른 모듈 아래 끝 6px 안이면 맞춘다), 그 아래 모듈은 끄는 동안에도 따라 내려간다. Esc = 취소, 두 번 누르기 = 높이 되돌리기.
// 열 경계선: 두 열 폭을 나눈다(합 유지, 1/24 눈금, 최소 폭은 지킨다). 끄는 동안 바로 보이고 손을 떼면 한 번 저장. 두 번 누르기 = 그 줄 열 폭 똑같이. 키보드 ←/→ = 1/24.
import { minHeight, placeRows, colMin } from '../core/layout.js';
import { snapH, stepH, magnet, applySizes, resetPatch, STEP_H } from '../core/module-size.js';
import { settle, resizeCols, equalize, same } from '../core/block-move.js';

/** 지금 화면 — 모듈 노드·높이(px)·틈·좁은 폭(한 줄에 하나) 여부 */
function readGrid(grid, ctx) {
  const nodes = new Map([...grid.children].filter((node) => node.dataset.mod).map((node) => [node.dataset.mod, node]));
  const byId = new Map(ctx.items.map((it) => [it.id, it]));
  return { grid, nodes, byId, gap: parseFloat(getComputedStyle(grid).rowGap) || 12, narrow: getComputedStyle(grid).display === 'grid', h: (id) => nodes.get(id)?.offsetHeight ?? 0, minOf: (id) => colMin(ctx.modOf(byId.get(id))) };
}

/** 끄는 동안 그 줄 목록대로 자리를 바로 그린다(React가 쓰는 변수는 건드리지 않고 inline 값으로 덮는다 — 끝나면 지운다) */
const PROPS = ['top', 'left', 'width', 'height'];
function preview(g, rows, hOf) {
  if (g.narrow) return;
  const { pos, height } = placeRows(rows, hOf, g.gap), col = (g.grid.clientWidth + g.gap) / 24;
  for (const [id, p] of pos) Object.assign(g.nodes.get(id).style, { top: `${p.top}px`, left: `${p.x * col}px`, width: `${p.w * col - g.gap}px` });
  g.grid.style.height = `${height}px`;
}
function restore(g) { for (const node of g.nodes.values()) PROPS.forEach((name) => node.style.removeProperty(name)); g.grid.style.removeProperty('height'); }

const save = (ctx, g, rows, items, hOf) => ctx.commit(settle(items, rows, hOf, g.gap, ctx.modOf));

// ── 높이(아래 가장자리) ──
function planOf(ctx) {
  const g = readGrid(ctx.el.parentElement, ctx), id = ctx.el.dataset.mod, mod = ctx.modOf(g.byId.get(id));
  return { ...g, ctx, id, from: ctx.el.offsetHeight, min: minHeight(mod, ctx.el.querySelector(':scope > .module-head')?.offsetHeight ?? 0) };
}
const changed = (pl, cur) => Math.abs(cur - pl.from) >= STEP_H / 2; // 반 눈금 미만이면 그대로(살짝 누른 것으로 높이가 고정되지 않게)
function show(pl, cur, keep) {
  const el = pl.ctx.el;
  for (const name of ['sized-h', 'own-h']) if (!el.classList.contains(name)) { el.classList.add(name); keep.push(name); } // 정한 높이 안에서 본문이 스크롤되게
  el.style.height = `${cur}px`;
  el.querySelector(':scope > .edge-b')?.setAttribute('aria-valuenow', cur);
  preview(pl, pl.ctx.rows, (id) => (id === pl.id ? cur : pl.h(id)));
}
function unshow(pl, keep) { restore(pl); keep.forEach((name) => pl.ctx.el.classList.remove(name)); }
/** 한 번 저장 — 이 모듈 높이만 바꾸고 모두의 자리(옛 앱용 x·y·t 포함)를 저장한다. 미리 보인 모습은 저장 요청 직후 걷는다(그 자리에서 다시 그린다) */
function saveH(pl, cur, keep) {
  const items = applySizes(pl.ctx.items, { [pl.id]: { h: cur } }, pl.ctx.modOf), h = pl.h;
  save(pl.ctx, pl, pl.ctx.rows, items, (id) => (id === pl.id ? cur : h(id)));
  unshow(pl, keep);
}

export function drag(ctx, p) {
  if (!p.target.hasPointerCapture(p.id)) return; // 불러오는 사이에 손을 뗐다
  if (!ctx.canEdit) { p.target.releasePointerCapture(p.id); return; } // 저장 중(aria-disabled) — 끌어도 저장되지 않으니 시작하지 않는다
  const pl = planOf(ctx), keep = [];
  // 높이 자석 대상 = 다른 모듈들의 아래 끝(넓은 화면, 격자 기준 px)
  const edges = pl.narrow ? [] : [...pl.nodes.values()].filter((node) => node !== ctx.el).map((node) => node.offsetTop + node.offsetHeight);
  let cur = pl.from, started = false;
  p.target.classList.add('on');
  const move = (e) => {
    if (e.pointerId !== p.id) return;
    if (!started) { if (Math.abs(e.clientY - p.y) < 4) return; started = true; ctx.el.classList.add('resizing'); document.body.classList.add('edge-drag-y'); }
    const next = magnet(snapH(pl.from + e.clientY - p.y, pl.min), ctx.el.offsetTop, edges, pl.min);
    if (next !== cur) { cur = next; show(pl, cur, keep); }
  };
  const end = (ok) => {
    window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', cancel); window.removeEventListener('keydown', esc, true);
    p.target.classList.remove('on'); ctx.el.classList.remove('resizing'); document.body.classList.remove('edge-drag-y');
    if (p.target.hasPointerCapture(p.id)) p.target.releasePointerCapture(p.id);
    if (!started) return;
    if (ok && changed(pl, cur) && ctx.el.isConnected) saveH(pl, cur, keep); else unshow(pl, keep);
  };
  const up = (e) => { if (e.pointerId === p.id) end(true); };
  const cancel = (e) => { if (e.pointerId === p.id) end(false); };
  const esc = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); end(false); } };
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', cancel); window.addEventListener('keydown', esc, true);
}

/** 키보드 ↑/↓ = 16px. 누를 때마다 바로 보이고, 손을 멈추면(0.4초) 한 번 저장한다 — 빠르게 누르면 다시 그리기 전의 높이를 읽어 단계가 빠지던 결함 */
let typing = null;
function flush() {
  const k = typing;
  typing = null;
  if (!k) return;
  clearTimeout(k.timer);
  if (changed(k.pl, k.cur) && k.pl.ctx.el.isConnected) saveH(k.pl, k.cur, k.keep); else unshow(k.pl, k.keep);
}
export function key(ctx, { key: name }) {
  if (!ctx.canEdit) return; // 저장 중에는 받지 않는다 — 받아 두면 저장이 거절되어 말없이 되돌아갔다(검수 10/1 재현). 초점은 손잡이에 남는다
  if (typing && typing.pl.ctx.el !== ctx.el) flush();
  if (!typing) { const pl = planOf(ctx); typing = { pl, cur: pl.from, keep: [] }; }
  const k = typing, next = stepH(k.cur, name === 'ArrowDown' ? 1 : -1, k.pl.min);
  k.pl.ctx = ctx;
  if (next !== k.cur) { k.cur = next; show(k.pl, next, k.keep); }
  clearTimeout(k.timer);
  k.timer = setTimeout(flush, 400);
}
/** 높이 손잡이에 초점 — 알리는 값(지금 높이)과 최소(이 모듈 최소)를 끌기·키보드와 같은 계산으로 */
export function focus(ctx, target) {
  const pl = planOf(ctx);
  target.setAttribute('aria-valuenow', Math.round(pl.from / STEP_H) * STEP_H); target.setAttribute('aria-valuemin', pl.min);
}
/** 초점이 손잡이를 떠나면 기다리지 않고 저장 */
export const blur = () => { flush(); flushCols(); };

/** 높이 되돌리기(두 번 누르기·⋯ 메뉴) — 그 모듈만, 정한 높이가 없으면 저장하지 않는다 */
export function reset(ctx) {
  const id = ctx.el.dataset.mod, patch = resetPatch(ctx.items, id, 'h');
  if (!patch[id]) return;
  const g = readGrid(ctx.el.parentElement, ctx);
  save(ctx, g, ctx.rows, applySizes(ctx.items, patch, ctx.modOf), g.h);
}
export const resetAll = reset;

// ── 열 경계선 ──
/** 끄는 동안 두 열 폭을 바꿔 바로 보인다 — 폭이 바뀌면 내용 높이가 바뀌므로 높이를 다시 재어 위 끝도 맞춘다 */
function showCols(g, rows, ctx, line) {
  preview(g, rows, g.h); preview(g, rows, g.h);
  const x = rows[ctx.r].slice(0, ctx.k).reduce((s, col) => s + col.w, 0);
  line.style.left = `${(x * (g.grid.clientWidth + g.gap)) / 24 - g.gap / 2 - 4}px`; // 끄는 경계선도 같이
  line.setAttribute('aria-valuenow', Math.round((x / 24) * 100));
}

export function colDrag(ctx, p) {
  if (!p.target.hasPointerCapture(p.id)) return;
  if (!ctx.canEdit) { p.target.releasePointerCapture(p.id); return; }
  const g = readGrid(ctx.el, ctx), unit = (ctx.el.clientWidth + g.gap) / 24;
  let cur = ctx.rows, started = false;
  p.target.classList.add('on');
  const move = (e) => {
    if (e.pointerId !== p.id) return;
    if (!started) { if (Math.abs(e.clientX - p.x) < 4) return; started = true; document.body.classList.add('edge-drag-x'); }
    const next = resizeCols(ctx.rows, ctx.r, ctx.k, Math.round((e.clientX - p.x) / unit), g.minOf);
    if (!same(next, cur)) { cur = next; showCols(g, cur, ctx, p.target); }
  };
  const end = (ok) => {
    window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', cancel); window.removeEventListener('keydown', esc, true);
    p.target.classList.remove('on'); document.body.classList.remove('edge-drag-x');
    if (p.target.hasPointerCapture(p.id)) p.target.releasePointerCapture(p.id);
    if (ok && started && !same(cur, ctx.rows)) save(ctx, g, cur, ctx.items, g.h);
    restore(g); p.target.style.removeProperty('left');
  };
  const up = (e) => { if (e.pointerId === p.id) end(true); };
  const cancel = (e) => { if (e.pointerId === p.id) end(false); };
  const esc = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); end(false); } };
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', cancel); window.addEventListener('keydown', esc, true);
}

/** 두 번 누르기 — 그 줄 열 폭을 똑같이(이미 같으면 저장하지 않는다) */
export function equal(ctx) {
  if (!ctx.canEdit) return;
  const g = readGrid(ctx.el, ctx), next = equalize(ctx.rows, ctx.r, g.minOf);
  if (!same(next, ctx.rows)) save(ctx, g, next, ctx.items, g.h);
}

/** 키보드 ←/→ = 1/24. 누를 때마다 바로 보이고 손을 멈추면(0.4초) 한 번 저장 */
let colTyping = null;
function flushCols() {
  const k = colTyping;
  colTyping = null;
  if (!k) return;
  clearTimeout(k.timer);
  if (!same(k.cur, k.ctx.rows)) save(k.ctx, k.g, k.cur, k.ctx.items, k.g.h);
  restore(k.g); k.line.style.removeProperty('left');
}
export function colKey(ctx, { key: name, target }) {
  if (!ctx.canEdit) return;
  if (colTyping && (colTyping.ctx.r !== ctx.r || colTyping.ctx.k !== ctx.k)) flushCols();
  if (!colTyping) colTyping = { ctx, g: readGrid(ctx.el, ctx), cur: ctx.rows, line: target };
  const k = colTyping, next = resizeCols(k.cur, ctx.r, ctx.k, name === 'ArrowRight' ? 1 : -1, k.g.minOf);
  if (!same(next, k.cur)) { k.cur = next; showCols(k.g, next, ctx, target); }
  clearTimeout(k.timer);
  k.timer = setTimeout(flushCols, 400);
}
