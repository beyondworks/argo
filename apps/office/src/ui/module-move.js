// 모듈 옮기기(유건 10/1 저녁 추가사항 1, 노션·OS 폴더 방식) — 옮기기 손잡이에 처음 다가갈 때 불러온다(첫 화면 묶음 밖).
// 끄는 동안 원래 모듈과 다른 모듈은 그대로 있고, 12열 눈금과 놓일 자리 윤곽(반투명)만 칸에 맞춰 따라온다.
// 손을 떼면 그 높이에 그대로 놓이고(7차 — 위로 붙지 않는다, 빈칸 허용) 겹친 모듈만 아래로 밀린다. 같은 줄 모듈 위에 놓으면 둘이 자리를 바꾼다 —
// 바뀌어 가거나 밀려날 모듈이 갈 자리는 점선 윤곽으로 같이 보인다. Esc·격자 밖에서 놓기 = 취소(아무것도 안 바뀐다).
// 키보드: 손잡이에서 Space/Enter로 들고 ←/→ = 한 열, ↑/↓ = 같은 열 모듈의 위 끝으로(그 모듈과 자리 바꾸기)·처음 자리로, Enter/Space = 놓기, Esc·Tab = 취소. 스크린리더에 자리를 알린다.
// 좁은 폭(한 줄에 하나)은 순서만 바꾼다.
import { registerDict, t } from '../core/i18n.js';
import { landing, insertAt, stepY, stepOrder, settle } from '../core/grid-move.js';
import { readGrid, say } from './grid-dom.js';
import { GRID_DICT } from './grid-i18n.js';

registerDict(GRID_DICT);
let active = null; // 한 번에 하나

/** 놓일 자리 비교용 — 모두의 열·위치가 같으면 같은 자리(순서만 다르고 모양이 같은 경우 저장하지 않는다) */
const shape = (placed) => placed.map((b) => `${b.id}:${b.x}:${Math.round(b.top)}`).sort().join();

function begin(ctx) {
  const g = readGrid(ctx.el, ctx.items), me = g.boxes.find((b) => b.id === ctx.el.dataset.mod);
  if (!me) return null;
  const base = g.grid.offsetHeight, slot = g.grid.appendChild(document.createElement('div'));
  slot.className = 'grid-slot fresh'; // 처음 자리에는 미끄러지지 않고 바로 — 왼쪽 위에서 날아오지 않게(update)
  ctx.el.classList.add('dragging'); g.grid.classList.add('move-on'); document.body.classList.add('module-moving');
  return { ...g, ctx, me, slot, ghosts: new Map(), tx: me.x, ty: me.top, base, inside: true };
}

const draw = (s, node, b) => { node.style.cssText = `transform:translate(${b.x * s.col}px,${b.top}px);width:${b.w * s.col - s.gap}px;height:${b.h}px`; };

/** 지금 tx·ty로 놓일 자리를 계산해 윤곽을 옮긴다 — 다른 모듈은 건드리지 않는다. 넓은 화면의 ty = 놓을 위 끝(px), 좁은 폭은 포인터 높이 */
function update(s) {
  s.placed = s.narrow ? insertAt(s.boxes, s.me.id, s.ty, s.gap) : landing(s.boxes, s.me.id, s.tx, s.ty, s.gap);
  const b = s.placed.find((p) => p.id === s.me.id);
  draw(s, s.slot, b);
  s.slot.classList.toggle('off', !s.inside);
  if (s.slot.classList.contains('fresh')) { void s.slot.offsetWidth; s.slot.classList.remove('fresh'); } // 첫 자리를 그린 뒤부터 칸 사이를 미끄러진다
  // 바뀌어 가거나 밀려날 모듈이 갈 자리(점선) — 넓은 화면만(좁은 폭은 순서만 바뀐다)
  const was = new Map(s.boxes.map((p) => [p.id, p])), shown = new Set();
  if (!s.narrow && s.inside) for (const p of s.placed) {
    const o = was.get(p.id);
    if (p.id === s.me.id || (o.x === p.x && o.top === p.top)) continue;
    let node = s.ghosts.get(p.id);
    if (!node) { node = s.grid.appendChild(document.createElement('div')); node.className = 'grid-slot ghost fresh'; s.ghosts.set(p.id, node); }
    draw(s, node, p); shown.add(p.id);
    if (node.classList.contains('fresh')) { void node.offsetWidth; node.classList.remove('fresh'); }
  }
  for (const [id, node] of s.ghosts) if (!shown.has(id)) { node.remove(); s.ghosts.delete(id); }
  s.grid.style.minHeight = `${Math.max(s.base, ...s.placed.map((p) => p.top + p.h))}px`; // 맨 아래에 놓을 때도 눈금·윤곽이 격자 안에
  return b;
}

/** 끝 — 바뀐 자리면 한 번 저장(모두의 x·y·t), 아니면 그대로. 화면 표시는 저장 요청 직후 걷는다(모듈은 그 자리에서 미끄러진다).
 *  좁은 폭은 순서만 바뀐다 — 넓은 화면의 세로 위치(t)는 그 순서와 맞지 않아 지운다(넓은 화면은 새 순서로 위로 붙여 그린다) */
function finish(s, keep) {
  const { ctx } = s;
  let moved = keep && s.inside && ctx.el.isConnected && shape(s.placed) !== s.first;
  if (moved) moved = ctx.commit(s.narrow ? settle(ctx.items, s.placed, s.xs).map(({ t: _, ...it }) => it) : settle(ctx.items, s.placed)) !== false;
  s.slot.remove(); s.ghosts.forEach((node) => node.remove()); s.grid.style.minHeight = '';
  ctx.el.classList.remove('dragging'); s.grid.classList.remove('move-on'); document.body.classList.remove('module-moving');
  active = null;
  return moved;
}

const rank = (s, b) => s.placed.filter((p) => p.top < b.top || (p.top === b.top && p.x < b.x)).length + 1;
const nameOf = (ctx, id) => ctx.modOf(ctx.items.find((it) => it.id === id)).title;
const announce = (s, b) => say(`${s.placed.swap ? `${t('grid.swap', { name: nameOf(s.ctx, s.placed.swap) })} ` : ''}${t('grid.at', { col: b.x + 1, n: rank(s, b) })}`);

/** 끄는 동안 화면 가장자리에 가면 그 방향으로 스크롤한다(긴 홈) */
function scroller(el) {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const o = getComputedStyle(node).overflowY;
    if ((o === 'auto' || o === 'scroll') && node.scrollHeight > node.clientHeight) return node;
  }
  return document.scrollingElement;
}

export function drag(ctx, p) {
  if (!p.target.hasPointerCapture(p.id)) return; // 불러오는 사이에 손을 뗐다
  if (!ctx.canEdit || active) { p.target.releasePointerCapture(p.id); return; } // 저장 중 — 놓아도 저장되지 않으니 시작하지 않는다
  let s = null, last = p, raf = 0;
  const sc = scroller(ctx.el);
  const place = (cx, cy) => {
    const r = s.grid.getBoundingClientRect(); // 격자는 윤곽 아래 끝까지 늘어나 있다(update)
    s.tx = s.narrow ? 0 : Math.max(0, Math.min(12 - s.me.w, Math.round((cx - s.dx - r.left) / s.col)));
    s.ty = s.narrow ? cy - r.top : Math.max(0, Math.round((cy - s.dy - r.top) / 8) * 8); // 넓은 화면 = 잡은 손 위치를 뺀 위 끝(8px 눈금)
    s.inside = cx > r.left - 24 && cx < r.right + 24 && cy > r.top - 48 && cy < r.bottom + 120; // 격자 밖에서 놓으면 취소 — 그동안 윤곽을 숨긴다
    update(s);
  };
  const tick = () => { // 위·아래 48px 안이면 거리만큼 빨리
    raf = 0;
    if (!s) return;
    const r = sc === document.scrollingElement ? { top: 0, bottom: innerHeight } : sc.getBoundingClientRect();
    const d = last.y < r.top + 48 ? last.y - r.top - 48 : last.y > r.bottom - 48 ? last.y - r.bottom + 48 : 0;
    if (!d) return;
    sc.scrollTop += Math.max(-24, Math.min(24, d / 2));
    place(last.x, last.y);
    raf = requestAnimationFrame(tick);
  };
  const move = (e) => {
    if (e.pointerId !== p.id) return;
    last = { x: e.clientX, y: e.clientY };
    if (!s) { // 4px 넘게 움직여야 옮기기 — 누르기만 하면 아무 일도 없다
      if (Math.hypot(e.clientX - p.x, e.clientY - p.y) < 4) return;
      s = active = begin(ctx);
      if (!s) return end(false);
      const r = ctx.el.getBoundingClientRect();
      s.dx = p.x - r.left; s.dy = p.y - r.top;
      place(p.x, p.y); s.first = shape(s.placed); // 처음 자리 — 여기로 돌아와 놓으면 저장하지 않는다
    }
    place(last.x, last.y);
    if (!raf) raf = requestAnimationFrame(tick);
  };
  const end = (keep) => {
    window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', cancel); window.removeEventListener('keydown', esc, true);
    cancelAnimationFrame(raf);
    if (p.target.hasPointerCapture(p.id)) p.target.releasePointerCapture(p.id);
    if (s) finish(s, keep);
    s = null;
  };
  const up = (e) => { if (e.pointerId === p.id) end(true); };
  const cancel = (e) => { if (e.pointerId === p.id) end(false); };
  const esc = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); end(false); } };
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', cancel); window.addEventListener('keydown', esc, true);
}

const KEYS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

export function pick(ctx, button) {
  if (!ctx.canEdit || active) return;
  const s = active = begin(ctx);
  if (!s) return;
  const id = s.me.id;
  update(s); s.first = shape(s.placed);
  say(`${t('grid.pick', { name: ctx.title })} ${t('grid.at', { col: s.me.x + 1, n: rank(s, s.placed.find((b) => b.id === id)) })}`);
  const stop = (keep) => {
    window.removeEventListener('keydown', key, true); button.removeEventListener('blur', blur);
    const moved = finish(s, keep);
    say(t(moved ? 'grid.drop' : 'grid.cancel', { name: ctx.title }));
    // 놓은 뒤 다시 그리면 모듈 순서(DOM)가 바뀌어 초점이 빠진다 — 같은 모듈 손잡이로 돌려놓는다
    if (moved) setTimeout(() => [...s.grid.children].find((node) => node.dataset.mod === id)?.querySelector('.grip')?.focus(), 60);
  };
  const key = (e) => {
    if (e.isComposing) return;
    if (e.key === 'Escape' || e.key === 'Tab') stop(false);
    else if (e.key === 'Enter' || e.key === ' ') stop(true);
    else if (KEYS[e.key]) {
      const [dx, dy] = KEYS[e.key];
      if (s.narrow) { if (dy) s.ty = stepOrder(s.boxes, id, s.ty, dy); } // 좁은 폭: 순서만, 처음 자리 기준
      else { // 넓은 화면: 끌기와 같은 규칙 — 처음 자리 기준으로 윤곽만 옮긴다(←/→ = 한 열, ↑/↓ = 같은 열 모듈 위 끝·처음 자리로)
        if (dx) s.tx = Math.max(0, Math.min(12 - s.me.w, s.tx + dx));
        if (dy) s.ty = stepY(s.boxes, id, s.tx, s.me.w, s.ty, dy);
      }
      const b = update(s);
      s.slot.scrollIntoView?.({ block: 'nearest' });
      announce(s, b);
    } else return;
    if (e.key !== 'Tab') e.preventDefault();
    e.stopImmediatePropagation();
  };
  const blur = () => stop(false);
  window.addEventListener('keydown', key, true); button.addEventListener('blur', blur);
}
