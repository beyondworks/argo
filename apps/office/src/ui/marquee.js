// 선택 상자 본체(11·12차, 유건 10/2 — 노션·파일 탐색기처럼 끌어 감싸 고르기). 첫 끌기가 4px를 넘을 때 받는다(core/selection.js가 넘긴다, 첫 화면 150KB 상한).
// 시작: 빈 곳·틈이면 바로 사각형, 항목(모듈·행) 글자 위면 처음에는 평소 글자 선택 — 포인터가 처음 누른 항목 밖으로 나가는 순간 글자 선택을 지우고 사각형으로 바꾼다.
// 무엇을 고르나(12차): 기본 끌기 = 사각형에 걸친 칸만(가릴 수 있는 칸 [data-sel-cell]이 있는 화면 — 표·카드), ⇧ + 끌기 = 줄(행·카드·모듈) 통째,
// ⌘ + 끌기 = 기존 선택에 영역 하나 더(이미 고른 것 위에 다시 그리면 빠진다 — 파일 탐색기 관례). 모듈·편집기 블록 화면([data-sel-units])은 칸이 없어 기본·⇧ 둘 다 모듈·블록.
// 묶음 안에 묶음이 있으면(모듈 안 보기 목록) 포인터가 들어 있는 가장 안쪽 묶음, 밖으로 나가면 바깥 묶음. 끄는 중 화면 위·아래 48px 안이면 스크롤한다.
// 사각형은 시작한 묶음(표·목록) 밖으로 그리지 않는다(12차 제보 — 줄을 따라 끌면 가는 막대가 표 밖으로 튀어나왔다). 한 번에 한 묶음만 고른다. 스크린리더에 고른 수를 알린다.
import { registerDict, t } from '../core/i18n.js';
import { SCOPES, CELLS, emit, activeScope, startKind, blockOf } from '../core/selection.js';
import { openMenu } from './Menu.jsx';
import { showToast } from './Overlay.jsx';
import { CELL_REG, cellPlan } from '../business/cell-pick.js';
import { SELECT_DICT } from './select-i18n.js';
import { hits, combine, sameSet, rectOf, pickRoot, clampRect, rangeKeys, dragMode } from './marquee-model.js';
import './selection.css';

registerDict(SELECT_DICT);

const inside = (box, p) => p.x >= box.left && p.x < box.right && p.y >= box.top && p.y < box.bottom;

// ── 화면 ──
const scopeOf = (el) => el?.closest?.('[data-sel-scope]') ?? null;
const entry = (root) => root && SCOPES.get(root.dataset.selScope);
/** 그 묶음의 항목 — 안쪽 다른 묶음의 항목은 뺀다 */
const itemsIn = (root) => [...root.querySelectorAll('[data-sel]')].filter((el) => scopeOf(el) === root);
const box = (el, key) => { const b = el.getBoundingClientRect(); return { key, left: b.left, top: b.top, right: b.right, bottom: b.bottom }; };
/** 항목 상자 — 묶음이 직접 주면(편집기 블록: boxes) 그것, 아니면 [data-sel] 요소 */
const boxesOf = (root, s) => s.opts().boxes?.() ?? itemsIn(root).map((el) => box(el, el.dataset.sel));
const chainOf = (el) => { const out = []; for (let s = scopeOf(el); s; s = scopeOf(s.parentElement)) out.push(s); return out; };
/** 화면의 맨 바깥 묶음 — 묶음 밖 여백에서 시작했을 때 */
const tops = () => [...document.querySelectorAll('.content [data-sel-scope]')].filter((s) => !scopeOf(s.parentElement));
/** 칸 — 화면의 가릴 수 있는 칸(모듈·블록 화면 안은 빼고) */
const cellEls = () => [...document.querySelectorAll('.content [data-sel-cell]')].filter((el) => !el.closest('[data-sel-units]'));
/** 다른 묶음을 비운다 — 한 번에 한 묶음만(칸 선택도) */
const only = (root) => { const keep = entry(root); for (const s of SCOPES.values()) if (s !== keep && s.get().size) s.set(new Set()); if (CELLS.keys.size) setCells(new Set()); };

/** 고른 칸 — 화면 표시(data-cell-on)와 같이 바꾼다. 칸은 React 상태가 아니라 이 한 곳이 가진다 */
export function setCells(next) {
  for (const el of document.querySelectorAll('[data-cell-on]')) if (!next.has(el.dataset.selCell)) el.removeAttribute('data-cell-on');
  for (const k of next) for (const el of document.querySelectorAll(`[data-sel-cell="${CSS.escape(k)}"]`)) el.setAttribute('data-cell-on', '');
  CELLS.keys = next; emit();
}

let live;
function say(text) {
  if (!live) {
    live = document.body.appendChild(document.createElement('div'));
    live.setAttribute('role', 'status'); live.setAttribute('aria-live', 'polite');
    live.style.cssText = 'position:fixed;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap';
  }
  live.textContent = '';
  setTimeout(() => { live.textContent = text; }, 40);
}
const announce = (n, cells) => say(n ? t(cells ? 'sel.cellsN' : 'sel.n', { n }) : t('sel.cleared'));

function scroller(el) {
  for (let node = el?.parentElement; node; node = node.parentElement) {
    const o = getComputedStyle(node).overflowY;
    if ((o === 'auto' || o === 'scroll') && node.scrollHeight > node.clientHeight) return node;
  }
  return document.scrollingElement;
}

let active = null, swallowing = false;
const anchors = new Map(); // 묶음 → 마지막으로 고른 항목(⇧ 클릭 범위의 시작)

/** 끌기 시작(감지 코드가 4px를 넘은 뒤 부른다) — d = { x, y, target, id, shift, toggle, up }, ev = 넘은 순간의 pointermove */
export function start(d, ev) {
  if (d.up || active) return;
  const kind = startKind(d.target);
  if (kind === 'native' || !d.target.isConnected) return;
  const own = chainOf(d.target);
  const chain = own.length ? own : tops().slice(0, 1); // 여백에서 — 그 화면의 바깥 묶음(없으면 사각형만)
  // 칸 고르기 — 기본 끌기이고, 모듈·블록 화면이 아니고, 화면에 가릴 수 있는 칸이 있을 때
  const cells = dragMode({ shift: d.shift, units: own.some((s) => s.hasAttribute('data-sel-units')) || !!d.target.closest('[data-sel-units]'), hasCells: cellEls().length > 0 }) === 'cells';
  // 글자 위에서 시작했으면 처음 누른 칸(칸 고르기)·항목 밖으로 나갈 때 사각형으로 — 칸 하나 안에서 끄는 동안은 글자 선택 그대로
  const item0 = kind !== 'item' ? null : (cells && d.target.closest('[data-sel-cell], td')) || d.target.closest('[data-sel]') || blockOf(d.target);
  const clamp = chain[0] ?? null; // 사각형은 그 화면의 묶음(표·목록) 밖으로 그리지 않는다(12차 제보 19 — 표 밖에서 시작해 줄을 따라 끌어도)
  const sc = scroller(chain[0] ?? d.target), sx = sc.scrollLeft, sy = sc.scrollTop;
  const orig = new Map(); // 끌기 전 선택(Esc면 되돌린다)
  for (const [id, s] of SCOPES) orig.set(id, s.get());
  const origCells = CELLS.keys;
  let on = false, cur = null, base = new Set(), last = { x: ev.clientX, y: ev.clientY }, raf = 0, band = null;
  const pick = (prev, found) => (d.toggle ? combine(prev, found, 'xor') : new Set(found)); // ⌘ = 기존 선택에 토글, 아니면 새로

  const begin = () => {
    on = true;
    getSelection()?.removeAllRanges();
    document.body.classList.add('sel-banding');
    band = document.body.appendChild(document.createElement('div'));
    band.className = 'sel-band'; band.setAttribute('aria-hidden', 'true');
    try { d.target.setPointerCapture(d.id); } catch { /* 이미 뗐다 */ }
    if (cells) { for (const s of SCOPES.values()) if (s.get().size) s.set(new Set()); base = d.toggle ? new Set(origCells) : new Set(); }
  };
  const update = () => {
    const r = rectOf({ x: d.x - (sc.scrollLeft - sx), y: d.y - (sc.scrollTop - sy) }, last);
    const shown = clamp?.isConnected ? clampRect(r, clamp.getBoundingClientRect()) : r;
    band.style.cssText = `transform:translate(${shown.l}px,${shown.t}px);width:${Math.max(0, shown.r - shown.l)}px;height:${Math.max(0, shown.b - shown.t)}px`;
    if (cells) { const next = pick(base, hits(r, cellEls().map((el) => box(el, el.dataset.selCell)))); if (!sameSet(next, CELLS.keys)) setCells(next); return; }
    const live = chain.filter((root) => root.isConnected);
    const root = live.length ? live[pickRoot(live.map((el) => el.getBoundingClientRect()), last)] : null;
    if (root !== cur) { // 다른 묶음으로 — 떠난 묶음은 끌기 전으로, 새 묶음 기준을 잡는다
      const prev = entry(cur);
      if (prev) prev.set(d.toggle ? orig.get(cur.dataset.selScope) ?? new Set() : new Set());
      cur = root;
      if (cur) { only(cur); base = d.toggle ? new Set(orig.get(cur.dataset.selScope) ?? []) : new Set(); }
    }
    const s = entry(cur);
    if (!s) return;
    const next = pick(base, hits(r, boxesOf(cur, s)));
    if (!sameSet(next, s.get())) s.set(next);
  };
  const tick = () => { // 위·아래 48px 안이면 거리만큼 빨리
    raf = 0;
    if (!active) return;
    const b = sc === document.scrollingElement ? { top: 0, bottom: innerHeight } : sc.getBoundingClientRect();
    const dy = last.y < b.top + 48 ? last.y - b.top - 48 : last.y > b.bottom - 48 ? last.y - b.bottom + 48 : 0;
    if (!dy) return;
    const before = sc.scrollTop;
    sc.scrollTop += Math.max(-24, Math.min(24, dy / 2));
    if (sc.scrollTop === before) return; // 끝까지 갔다
    update();
    raf = requestAnimationFrame(tick);
  };
  const move = (e) => {
    if (e.pointerId !== d.id) return;
    last = { x: e.clientX, y: e.clientY };
    if (!on) { // 글자 선택 중 — 처음 누른 항목 안에 있는 동안은 그대로
      if (item0?.isConnected && inside(item0.getBoundingClientRect(), last)) return;
      begin();
    }
    update();
    if (!raf) raf = requestAnimationFrame(tick);
  };
  const end = (cancel) => {
    removeEventListener('pointermove', move); removeEventListener('pointerup', up); removeEventListener('pointercancel', stop); removeEventListener('keydown', esc, true);
    cancelAnimationFrame(raf);
    active = null;
    if (!on) return;
    band.remove(); document.body.classList.remove('sel-banding');
    try { if (d.target.hasPointerCapture?.(d.id)) d.target.releasePointerCapture(d.id); } catch { /* 없다 */ }
    if (cancel) {
      for (const [id, s] of SCOPES) if (orig.has(id) && !sameSet(orig.get(id), s.get())) s.set(orig.get(id));
      if (!sameSet(origCells, CELLS.keys)) setCells(origCells);
      return;
    }
    swallowing = true; setTimeout(() => { swallowing = false; }, 0); // 손을 뗀 자리의 클릭(행 열기·빈 곳 해제)은 삼킨다
    if (cells) { announce(CELLS.keys.size, true); return; }
    entry(cur)?.opts().onEnd?.(); // 편집기: 고른 블록을 편집기 선택으로도 잡고 초점을 돌려준다
    announce(entry(cur)?.get().size ?? 0);
  };
  const up = (e) => { if (e.pointerId === d.id) end(false); };
  const stop = (e) => { if (e.pointerId === d.id) end(true); };
  const esc = (e) => { if (e.key === 'Escape' && on) { e.preventDefault(); e.stopImmediatePropagation(); end(true); } };
  active = { end };
  addEventListener('pointermove', move); addEventListener('pointerup', up); addEventListener('pointercancel', stop); addEventListener('keydown', esc, true);
  if (kind === 'box') begin();
  move(ev);
}

/** 선택 상자를 끝낸 직후의 클릭 — 삼켰으면 true */
export function swallow(e) {
  if (!swallowing) return false;
  swallowing = false; e.preventDefault(); e.stopPropagation();
  return true;
}

const CONTROL = 'input, textarea, select, button, a[href], label, [role="button"], [role="checkbox"], [role="switch"], [role="menuitem"], [role="option"], [role="tab"], [contenteditable], [role="dialog"], .menu, .sel-bar';
/** 빈 곳 한 번 클릭 = 선택 해제 — 단추·링크·입력칸·막대·창 위의 클릭은 그 동작(선택 그대로) */
export function clickAway(e) {
  if (!activeScope() || !e.target.closest?.('.content') || e.target.closest(CONTROL) || e.target.closest('.redact')) return;
  clearAll();
}

/** ⌘ + 클릭 — 그 항목 하나 더하기·빼기 */
export function toggle(item) {
  const root = scopeOf(item), s = entry(root);
  if (!s || !item.isConnected) return;
  only(root);
  const next = new Set(s.get()), key = item.dataset.sel;
  if (next.has(key)) next.delete(key); else next.add(key);
  anchors.set(root, key);
  s.set(next);
  announce(next.size);
}

/** ⇧ + 클릭 — 마지막으로 고른 항목부터 여기까지(화면 순서). 시작점이 없으면 하나 더하기 */
export function range(item) {
  const root = scopeOf(item), s = entry(root), from = anchors.get(root);
  if (!s || !item.isConnected) return;
  const keys = itemsIn(root).map((el) => el.dataset.sel);
  if (from == null || !keys.includes(from)) { toggle(item); return; }
  only(root);
  const next = new Set(rangeKeys(keys, from, item.dataset.sel));
  s.set(next);
  announce(next.size);
}

/** ⌘A — 지금 고른 묶음(없으면 화면의 바깥 묶음) 전체 */
export function selectAll() {
  const id = activeScope(), root = id && id !== '__cells' ? document.querySelector(`[data-sel-scope="${CSS.escape(id)}"]`) : tops()[0], s = entry(root);
  if (!s) return;
  only(root);
  const next = new Set(boxesOf(root, s).map((b) => b.key));
  s.set(next);
  announce(next.size);
}

export function clearAll() {
  let had = false;
  for (const s of SCOPES.values()) if (s.get().size) { s.set(new Set()); had = true; }
  if (CELLS.keys.size) { setCells(new Set()); had = true; }
  if (had) announce(0);
}

/** 고른 칸 → 가리기·가림 해제(가릴 수 있는 칸만 센다). 칸마다 그 데이터의 원래 저장 방식(행의 redacted 목록·항목 저장·내 화면 가림)으로, 같은 쓰기는 한 번에(batch).
 *  토스트 '되돌리기' 한 번으로 통째로 돌린다 */
export function cellActions(keys, clear) {
  const list = keys.map((k) => CELL_REG.get(k)).filter(Boolean);
  if (!list.length) return [];
  const hidden = list.filter((c) => c.on()).length;
  const go = (on) => async () => {
    const changed = list.filter((c) => c.on() !== on), apply = (cs, v) => Promise.all(cellPlan(cs, v).map((job) => job()));
    try { await apply(changed, on); } catch { return; }
    clear?.();
    showToast(t(on ? 'sel.redacted' : 'sel.unredacted', { n: changed.length }), { undo: () => apply(changed, !on).catch(() => {}) });
  };
  return [hidden < list.length && { label: t('bizui.redact'), icon: 'eyeOff', run: go(true) }, hidden > 0 && { label: t('bizui.unredact'), icon: 'eye', run: go(false) }];
}

// Esc = 선택 해제(창·메뉴가 떠 있거나 입력 중이면 그쪽 차례). 끄는 중 Esc는 위 esc가 먼저 받는다(취소)
addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing || !activeScope() || document.querySelector('[role="dialog"], .menu')) return;
  const el = e.target;
  if (el?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el?.tagName ?? '')) return;
  clearAll();
});
// 고른 칸 위 우클릭 = 고른 칸 전체 가리기·가림 해제(값 하나 메뉴는 Redact가 이때 비켜 준다)
addEventListener('contextmenu', (e) => {
  const cell = e.target.closest?.('[data-sel-cell]');
  if (!cell || !CELLS.keys.has(cell.dataset.selCell)) return;
  const items = cellActions([...CELLS.keys], () => setCells(new Set())).filter(Boolean);
  if (!items.length) return;
  e.preventDefault();
  openMenu(e, [{ heading: t('sel.cells', { n: CELLS.keys.size }) }, ...items]);
});
