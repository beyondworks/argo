// 모듈 옮기기(9차, 유건 10/2 — 노션·Coda 블록 끌기) — 옮기기 손잡이에 처음 다가갈 때 불러온다(첫 화면 묶음 밖).
// 끄는 동안 다른 모듈은 움직이지 않고, 놓일 자리에 파란 삽입선만 뜬다: 모듈 위·아래 절반 = 그 위·아래 가로선, 모듈 왼쪽·오른쪽 끝 띠(폭의 20%, 최소 24px)
// = 그쪽에 새 열(세로선, 한 줄 4열이면 없음), 줄 사이·맨 위·맨 아래 = 새 줄 가로선, 짧은 열 아래 빈칸 = 그 열 맨 아래. 끄는 모듈의 작은 미리보기가 손을 따라온다.
// 손을 떼면 한 번 저장하고 다른 모듈은 새 자리로 미끄러진다(격자 FLIP). 자기 자리·Esc·격자 밖 = 취소(아무것도 안 바뀐다).
// 키보드: 손잡이에서 Space/Enter로 들고 ↑/↓ = 위아래 한 칸(열 안·줄 사이), ←/→ = 옆 열로, Enter/Space = 놓기, Esc·Tab = 취소. 스크린리더에 자리를 알린다.
// 좁은 폭(한 줄에 하나)은 순서만 — 같은 줄 두 모듈 사이면 앞 모듈의 열로, 아니면 새 줄.
// 여러 개(11차, 유건 10/2 정정): 고른 모듈 중 아무 손잡이나 잡으면 고른 것 전부가 원래 배치(줄·열·폭 비율·위아래) 그대로 같이 간다(core/block-move.js).
// 나란히 있는 것이 있으면(여러 열 구조) 줄 사이 전체 폭 가로선에만 놓이고(키보드는 ↑/↓만), 전부 위아래면 잡은 모듈 하나처럼 9차 규칙대로 어디든 놓여 그 자리에 위아래로 쌓인다.
// 미리보기는 겹친 카드 + 개수, 저장·되돌리기는 한 번.
import { registerDict, t } from '../core/i18n.js';
import { colMin } from '../core/layout.js';
import { drop, flatTarget, stepTarget, settle, find, same, groupOrder, collapse, expand, groupMin, shapeOf, isMulti, without, dropMany, insertShape, shapeSlot } from '../core/block-move.js';
import { GRID_DICT } from './grid-i18n.js';

registerDict(GRID_DICT);
let active = null; // 한 번에 하나

/** 스크린리더 알림(한 곳) — 같은 문장을 두 번 알려도 읽히게 비웠다가 잠시 뒤에 쓴다 */
let live;
function say(text) {
  if (!live) {
    live = document.body.appendChild(document.createElement('div'));
    live.setAttribute('role', 'status'); live.setAttribute('aria-live', 'assertive');
    live.style.cssText = 'position:fixed;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap';
  }
  live.textContent = '';
  setTimeout(() => { live.textContent = text; }, 40);
}

function begin(ctx) {
  const grid = ctx.el.parentElement, me = ctx.el.dataset.mod, byId = new Map(ctx.items.map((it) => [it.id, it]));
  const nodes = [...grid.children].filter((node) => node.dataset.mod);
  if (!nodes.includes(ctx.el)) return null;
  const boxes = nodes.map((node) => ({ id: node.dataset.mod, x: node.offsetLeft, top: node.offsetTop, w: node.offsetWidth, h: node.offsetHeight }));
  const gap = parseFloat(getComputedStyle(grid).rowGap) || 12, narrow = getComputedStyle(grid).display === 'grid';
  const minOf = (id) => colMin(ctx.modOf(byId.get(id)));
  // 같이 가는 모듈 — 고른 것(화면에 있는 것만, 원래 순서). 잡은 모듈이 고른 것이 아니면 그 하나만
  const shown = new Set(nodes.map((node) => node.dataset.mod)), picked = ctx.group?.includes(me) ? groupOrder(ctx.rows, new Set(ctx.group.filter((id) => shown.has(id)))) : [];
  const list = picked.length > 1 ? picked : [me], group = new Set(list), many = list.length > 1, multi = many && isMulti(shapeOf(ctx.rows, group));
  // 놓일 자리 — 여러 열 구조는 고른 것을 모두 뺀 줄 목록의 줄 사이, 한 열 구조는 잡은 모듈 하나처럼(나머지 고른 모듈만 뺀 줄 목록 위에서)
  const rows = multi ? without(ctx.rows, group, minOf) : many ? collapse(ctx.rows, me, group, minOf) : ctx.rows;
  const line = grid.appendChild(document.createElement('div'));
  line.className = 'drop-line off';
  for (const node of nodes) if (group.has(node.dataset.mod)) node.classList.add('dragging');
  document.body.classList.add('module-moving');
  // 줄마다 위·아래 끝(지금 화면) — 줄 사이 틈과 짧은 열 아래 빈칸을 가른다
  const lines = rows.map((row) => { const bs = row.flatMap((col) => col.ids).map((id) => boxes.find((b) => b.id === id)); const top = Math.min(...bs.map((b) => b.top)); return { top, h: Math.max(...bs.map((b) => b.top + b.h)) - top }; });
  return { ctx, grid, me, list, group, many, multi, nodes, boxes, gap, narrow, line, minOf: many ? groupMin(me, list, minOf) : minOf, realMin: minOf, lines, rows, box: (id) => boxes.find((b) => b.id === id), next: null };
}
/** 놓은 결과(잡은 모듈 하나 기준) → 실제 줄 목록 — 여러 개면 잡은 모듈 자리에 고른 것 전부를 차례로 */
const full = (s, rows) => (s.many && !s.multi ? expand(rows, s.me, s.list, s.realMin) : rows);
/** 여러 열 구조 — 포인터 높이에 가장 가까운 줄 사이(그 줄 위 절반이면 앞, 아래 절반이면 뒤, 마지막 줄 아래면 맨 아래) */
function rowTarget(s, py) {
  const r = s.lines.findIndex((l) => py < l.top + l.h + s.gap / 2);
  if (r < 0) return { kind: 'row', anchor: null, after: true };
  const l = s.lines[r];
  return { kind: 'row', anchor: s.rows[r][0].ids[0], after: py >= l.top && py > l.top + l.h / 2 };
}

/** 포인터(격자 기준 px) 아래 놓을 자리 — 없으면 null(자기 자리) */
function targetAt(s, px, py) {
  const { rows, me } = s;
  if (s.multi) return rowTarget(s, py);
  if (s.narrow) return flatTarget(rows, me, s.boxes.filter((b) => !s.group.has(b.id) && b.top + b.h / 2 < py).length);
  const hit = s.boxes.find((b) => px >= b.x && px < b.x + b.w && py >= b.top && py < b.top + b.h);
  if (hit) {
    if (s.group.has(hit.id)) return null; // 자기(고른 모듈) 위
    const band = Math.max(24, hit.w * 0.2), side = px < hit.x + band ? 'l' : px > hit.x + hit.w - band ? 'r' : null;
    if (side) { const tg = { kind: 'side', anchor: hit.id, after: side === 'r' }; if (drop(rows, me, tg, s.minOf)) return tg; }
    return { kind: 'col', anchor: hit.id, after: py > hit.top + hit.h / 2 };
  }
  const r = s.lines.findIndex((l) => py >= l.top && py < l.top + l.h);
  if (r >= 0 && rows[r].length > 1) { // 줄 안 빈칸(짧은 열 아래) — 가장 가까운 열 맨 아래
    const near = rows[r].map((col) => ({ col, mid: (s.box(col.ids[0]).x * 2 + s.box(col.ids[0]).w) / 2 })).sort((a, b) => Math.abs(px - a.mid) - Math.abs(px - b.mid))[0];
    const ids = near.col.ids.filter((id) => id !== me);
    return ids.length ? { kind: 'col', anchor: ids.at(-1), after: true } : null;
  }
  const k = s.lines.findIndex((l) => py < l.top); // 다음 줄 — 없으면 맨 아래
  const ids = k < 0 ? [] : rows.slice(k).flatMap((row) => row.flatMap((col) => col.ids)).filter((id) => id !== me);
  return ids.length ? { kind: 'row', anchor: ids[0], after: false } : { kind: 'row', anchor: null, after: true };
}

/** 삽입선 — 넓은 화면은 지금 화면 자리에(다른 모듈은 움직이지 않는다). 가로선 = 열 폭(놓은 뒤 그 줄이 열 하나면 전체 폭), 세로선 = 이웃 모듈 높이 */
function drawLine(s, tg, next) {
  const { line } = s;
  line.classList.toggle('off', !next);
  if (!next) return;
  const half = s.gap / 2, W = s.grid.clientWidth, a = tg.anchor != null && s.box(tg.anchor);
  let x = 0, y, w = W, h = 3;
  if (s.narrow && !s.multi) {
    const list = s.boxes.filter((b) => !s.group.has(b.id)).sort((p, q) => p.top - q.top), k = flatIndex(next, s.me), prev = list[k - 1];
    y = prev ? prev.top + prev.h + half : (list[0]?.top ?? 0) - half;
  } else if (tg.kind === 'side') { x = tg.after ? a.x + a.w + half : a.x - half; y = a.top; w = 3; h = a.h; x -= 1.5; }
  else if (tg.kind === 'col' && next[find(next, tg.anchor).r].length > 1) { x = a.x; w = a.w; y = tg.after ? a.top + a.h + half : a.top - half; }
  else if (a) { const l = s.lines[find(s.rows, tg.anchor).r]; y = tg.after ? l.top + l.h + half : l.top - half; }
  else y = tg.after ? Math.max(0, ...s.lines.map((l) => l.top + l.h)) + half : -half;
  if (w === W || h === 3) y -= 1.5;
  line.style.cssText = `transform:translate(${x}px,${y}px);width:${w}px;height:${h}px`;
}
const flatIndex = (rows, id) => rows.flatMap((row) => row.flatMap((col) => col.ids)).indexOf(id);

/** 놓을 자리를 정한다 — 놓은 결과가 지금과 같으면(자기 자리) 선을 숨기고 놓아도 아무것도 안 한다 */
function aim(s, tg) {
  const next = tg && (s.multi ? dropMany(s.ctx.rows, s.me, s.list, tg, s.realMin) : drop(s.rows, s.me, tg, s.minOf));
  s.next = next && !same(full(s, next), s.ctx.rows) ? next : null;
  drawLine(s, tg, s.next);
}

/** 끝 — 바뀐 자리면 한 번 저장(줄·열과 옛 필드), 아니면 그대로. 표시는 저장 요청 직후 걷는다(다른 모듈은 새 자리로 미끄러진다) */
function finish(s, keep) {
  const { ctx } = s, h = (id) => s.box(id)?.h ?? 0;
  let moved = !!(keep && s.next && ctx.el.isConnected);
  if (moved) moved = ctx.commit(settle(ctx.items, full(s, s.next), h, s.gap, ctx.modOf)) !== false; // 여러 개도 저장·되돌리기 한 번
  s.line.remove(); s.ghost?.remove();
  for (const node of s.nodes) node.classList.remove('dragging');
  document.body.classList.remove('module-moving');
  active = null;
  return moved;
}

/** 끄는 동안 화면 가장자리에 가면 그 방향으로 스크롤한다(긴 홈) */
function scroller(el) {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const o = getComputedStyle(node).overflowY;
    if ((o === 'auto' || o === 'scroll') && node.scrollHeight > node.clientHeight) return node;
  }
  return document.scrollingElement;
}

/** 손을 따라오는 작은 미리보기 — 원래 모듈을 복사해 줄인다(폭 280px 이하), 잡은 점이 손 아래에. 여러 개면 뒤에 겹친 카드 + 손 옆에 개수(11차) */
function ghostOf(el, p, n = 1) {
  const r = el.getBoundingClientRect(), k = Math.min(1, 280 / r.width), g = el.cloneNode(true);
  g.classList.remove('dragging'); g.classList.add('drag-ghost'); g.setAttribute('aria-hidden', 'true'); g.inert = true;
  g.removeAttribute('data-sel-on'); g.removeAttribute('data-sel');
  g.style.cssText = `width:${r.width}px;height:${r.height}px`;
  g.querySelectorAll('.edge, .grip').forEach((node) => node.remove());
  document.body.appendChild(g);
  let badge = null;
  if (n > 1) { g.classList.add('group'); badge = document.body.appendChild(document.createElement('span')); badge.className = 'ghost-count'; badge.setAttribute('aria-hidden', 'true'); badge.textContent = n; }
  return { node: g, k, dx: (p.x - r.left) * k, dy: (p.y - r.top) * k, remove: () => { g.remove(); badge?.remove(); },
    at(x, y) { g.style.transform = `translate(${x - this.dx}px,${y - this.dy}px) scale(${k})`; if (badge) badge.style.transform = `translate(${x + 14}px,${y - 30}px)`; } };
}

export function drag(ctx, p) {
  if (!p.target.hasPointerCapture(p.id)) return; // 불러오는 사이에 손을 뗐다
  if (!ctx.canEdit || active) { p.target.releasePointerCapture(p.id); return; } // 저장 중 — 놓아도 저장되지 않으니 시작하지 않는다
  let s = null, last = p, raf = 0;
  const sc = scroller(ctx.el);
  const place = (cx, cy) => {
    const r = s.grid.getBoundingClientRect();
    s.ghost.at(cx, cy);
    const inside = cx > r.left - 24 && cx < r.right + 24 && cy > r.top - 48 && cy < r.bottom + 120; // 격자 밖에서 놓으면 취소 — 그동안 선을 숨긴다
    aim(s, inside ? targetAt(s, cx - r.left, cy - r.top) : null);
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
      s.ghost = ghostOf(ctx.el, p, s.list.length);
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

/** 지금(키보드로 옮긴 결과) 자리 알림 — 몇 번째 줄, 열이 여럿이면 몇 번째 열, 위에서 몇 번째 */
function where(rows, id) {
  const { r, c, i } = find(rows, id), n = rows[r].length;
  return n > 1 ? t('grid.at', { row: r + 1, col: c + 1, cols: n, n: i + 1 }) : t('grid.row', { row: r + 1 });
}

/** 키보드로 옮긴 결과를 처음 화면 위의 선으로 — 놓일 자리 바로 앞 모듈(같은 열이면 그 아래, 아니면 그 줄 아래)·바로 뒤 모듈 기준 */
function keyLine(s) {
  const rows = s.next, at = rows && find(rows, s.me), row = rows?.[at.r], col = row?.[at.c];
  const tg = !rows ? null : row.length > 1 && col.ids.length > 1 ? (at.i ? { kind: 'col', anchor: col.ids[at.i - 1], after: true } : { kind: 'col', anchor: col.ids[1], after: false })
    : row.length > 1 ? { kind: 'side', anchor: row[at.c ? at.c - 1 : 1].ids[0], after: !!at.c }
    : at.r ? { kind: 'row', anchor: rows[at.r - 1][0].ids[0], after: true } : { kind: 'row', anchor: rows[1]?.[0].ids[0] ?? null, after: false };
  drawLine(s, tg, rows);
}

export function pick(ctx, button) {
  if (!ctx.canEdit || active) return;
  const s = active = begin(ctx);
  if (!s) return;
  if (s.multi) return pickRows(s, ctx, button);
  let pc = find(s.rows, s.me).c; // ↑/↓로 열이 여럿인 줄에 들어갈 때 고를 열
  say(s.many ? t('grid.pickN', { n: s.list.length }) : `${t('grid.pick', { name: ctx.title })} ${where(s.rows, s.me)}`);
  const stop = (keep) => {
    window.removeEventListener('keydown', key, true); button.removeEventListener('blur', blur);
    const moved = finish(s, keep);
    say(moved && s.many ? t('grid.dropN', { n: s.list.length }) : t(moved ? 'grid.drop' : 'grid.cancel', { name: ctx.title }));
    // 놓은 뒤 다시 그리면 모듈 순서(DOM)가 바뀌어 초점이 빠진다 — 같은 모듈 손잡이로 돌려놓는다
    if (moved) setTimeout(() => [...s.grid.children].find((node) => node.dataset.mod === s.me)?.querySelector('.grip')?.focus(), 60);
  };
  const key = (e) => {
    if (e.isComposing) return;
    if (e.key === 'Escape' || e.key === 'Tab') stop(false);
    else if (e.key === 'Enter' || e.key === ' ') stop(true);
    else if (e.key.startsWith('Arrow')) {
      const rows = s.next ?? s.rows;
      let next = null;
      if (s.narrow) { // 좁은 폭: 위아래 한 칸만(순서)
        const k = flatIndex(rows, s.me) + (e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : NaN);
        if (k >= 0 && k < rows.flat().reduce((n, col) => n + col.ids.length, 0)) next = drop(rows, s.me, flatTarget(rows, s.me, k), s.minOf);
      }
      else { const tg = stepTarget(rows, s.me, e.key, pc); next = tg && drop(rows, s.me, tg, s.minOf); }
      if (next && !same(next, rows)) {
        s.next = same(full(s, next), s.ctx.rows) ? null : next;
        const at = find(next, s.me); if (next[at.r].length > 1) pc = at.c;
        keyLine(s);
        s.line.scrollIntoView?.({ block: 'nearest' });
        say(where(next, s.me));
      } else say(t('grid.edge'));
    } else return;
    if (e.key !== 'Tab') e.preventDefault();
    e.stopImmediatePropagation();
  };
  const blur = () => stop(false);
  window.addEventListener('keydown', key, true); button.addEventListener('blur', blur);
}

/** 여러 열 구조 키보드 — ↑/↓ = 줄 사이 자리 한 칸, ←/→ 없음(열 안에 열을 넣는 구조가 없다), Enter/Space = 놓기, Esc·Tab = 취소 */
function pickRows(s, ctx, button) {
  const n = s.rows.length, start = shapeSlot(ctx.rows, s.list, s.realMin);
  let slot = start;
  say(t('grid.pickN', { n: s.list.length }));
  const line = () => drawLine(s, slot < n ? { kind: 'row', anchor: s.rows[slot][0].ids[0], after: false } : { kind: 'row', anchor: null, after: true }, s.next);
  const stop = (keep) => {
    window.removeEventListener('keydown', key, true); button.removeEventListener('blur', blur);
    const moved = finish(s, keep);
    say(moved ? t('grid.dropN', { n: s.list.length }) : t('grid.cancel', { name: ctx.title }));
    if (moved) setTimeout(() => [...s.grid.children].find((node) => node.dataset.mod === s.me)?.querySelector('.grip')?.focus(), 60);
  };
  const key = (e) => {
    if (e.isComposing) return;
    if (e.key === 'Escape' || e.key === 'Tab') stop(false);
    else if (e.key === 'Enter' || e.key === ' ') stop(true);
    else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const to = slot + (e.key === 'ArrowUp' ? -1 : 1);
      if (to < 0 || to > n) say(t('grid.edge'));
      else { slot = to; const next = insertShape(ctx.rows, s.list, slot, s.realMin); s.next = same(next, ctx.rows) ? null : next; line(); s.line.scrollIntoView?.({ block: 'nearest' }); say(t('grid.row', { row: slot + 1 })); }
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') say(t('grid.edge'));
    else return;
    if (e.key !== 'Tab') e.preventDefault();
    e.stopImmediatePropagation();
  };
  const blur = () => stop(false);
  window.addEventListener('keydown', key, true); button.addEventListener('blur', blur);
}
