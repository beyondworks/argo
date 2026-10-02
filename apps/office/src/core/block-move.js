// 블록 배치 바꾸기(9차, 유건 10/2 — 노션식) — 옮기기·열 경계선·높이·모듈 맞춤 화면 코드만 쓴다(첫 화면 밖).
// 줄 목록 = [[{ w, ids }]] (layout.js layoutRows). 놓을 자리(target) = { kind, anchor, after }:
//   row  = anchor가 있는 줄 앞/뒤에 새 줄(anchor가 없으면 맨 위/맨 아래)
//   col  = anchor 열 안에서 anchor 앞/뒤(그 줄이 열 하나면 새 줄과 같다)
//   side = anchor 열 왼쪽/오른쪽에 새 열(한 줄 최대 4열, 모듈 최소 폭을 지킬 수 있을 때만)
import { tidy, placeRows, spanRange } from './layout.js';
import { applySizes } from './module-size.js';

/** id가 있는 곳 { r, c, i } */
export function find(rows, id) {
  for (let r = 0; r < rows.length; r++) for (let c = 0; c < rows[r].length; c++) {
    const i = rows[r][c].ids.indexOf(id);
    if (i >= 0) return { r, c, i };
  }
  return null;
}
export const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const flat = (rows) => rows.flatMap((row) => row.flatMap((col) => col.ids));

/** id를 target에 놓은 줄 목록(정리됨). 놓을 수 없으면 null. minOf(id) = 모듈 최소 폭(24분의 몇) */
export function drop(rows, id, target, minOf) {
  const at = find(rows, id), { kind, anchor, after } = target;
  if (!at || anchor === id) return null;
  const next = rows.map((row) => row.map((col) => ({ w: col.w, ids: col.ids.slice() }))), src = next[at.r], col = src[at.c];
  const sameRow = anchor != null && rows[at.r].some((c) => c.ids.includes(anchor)), alone = col.ids.length === 1;
  // 빠진 자리는 비우되 다른 열 폭(비율)은 그대로 — 같은 줄 안에서 열 순서만 바꾸면 원래 폭으로 돌아온다
  col.ids.splice(at.i, 1);
  if (alone) src.splice(at.c, 1);
  if (!src.length) next.splice(at.r, 1);
  if (anchor == null) { next.splice(after ? next.length : 0, 0, [{ w: 24, ids: [id] }]); return tidy(next, minOf); }
  const a = find(next, anchor), row = next[a.r];
  if (kind === 'side') {
    if (row.length > 3) return null;
    const total = row.reduce((s, c) => s + c.w, 0);
    row.splice(a.c + (after ? 1 : 0), 0, { w: sameRow && alone ? col.w : total / row.length, ids: [id] });
    if (row.reduce((s, c) => s + Math.max(...c.ids.map(minOf)), 0) > 24) return null; // 최소 폭을 지킬 수 없다
  } else if (kind === 'col' && row.length > 1) row[a.c].ids.splice(a.i + (after ? 1 : 0), 0, id);
  else next.splice(a.r + (after ? 1 : 0), 0, [{ w: 24, ids: [id] }]);
  return tidy(next, minOf);
}

/** 좁은 폭(한 줄에 하나) — 다른 모듈 사이 k번째(0 = 맨 위)에 놓는 자리. 같은 줄 두 모듈 사이면 앞 모듈의 열로, 아니면 새 줄 */
export function flatTarget(rows, id, k) {
  const list = flat(rows).filter((x) => x !== id), prev = list[k - 1], next = list[k];
  if (prev == null) return { kind: 'row', anchor: next ?? null, after: false };
  const a = find(rows, prev), b = next != null && find(rows, next);
  return { kind: b && a.r === b.r ? 'col' : 'row', anchor: prev, after: true };
}

/** 키보드 한 칸 — ↑/↓ = 열 안에서 한 칸, 열 맨 위·아래에서는 그 줄 위·아래 새 줄로, 한 줄짜리는 옆 줄을 넘거나(열이 여럿인 줄이면 기억한 열 pc로 들어간다).
 *  ←/→ = 옆 열로(같은 높이 순서), 끝 열이면 그쪽에 새 열(그 열에 다른 모듈이 있을 때). 한 줄을 다 쓰는 모듈은 위 줄(없으면 아래 줄) 옆에 새 열로. 더 갈 곳이 없으면 null */
export function stepTarget(rows, id, key, pc = 0) {
  const { r, c, i } = find(rows, id), row = rows[r], col = row[c], multi = row.length > 1;
  if (key === 'ArrowUp' || key === 'ArrowDown') {
    const up = key === 'ArrowUp';
    if (multi) {
      const j = col.ids[i + (up ? -1 : 1)];
      return j != null ? { kind: 'col', anchor: j, after: !up } : { kind: 'row', anchor: flat([row]).find((x) => x !== id), after: !up };
    }
    const near = rows[r + (up ? -1 : 1)];
    if (!near) return null;
    if (near.length < 2) return { kind: 'row', anchor: near[0].ids[0], after: !up };
    const ids = near[Math.min(pc, near.length - 1)].ids;
    return { kind: 'col', anchor: up ? ids.at(-1) : ids[0], after: up };
  }
  const right = key === 'ArrowRight';
  if (multi) {
    const side = row[c + (right ? 1 : -1)];
    if (side) return side.ids[i] != null ? { kind: 'col', anchor: side.ids[i], after: false } : { kind: 'col', anchor: side.ids.at(-1), after: true };
    const other = col.ids.find((x) => x !== id);
    return other == null ? null : { kind: 'side', anchor: other, after: right };
  }
  const near = rows[r - 1] ?? rows[r + 1];
  return near ? { kind: 'side', anchor: near[right ? near.length - 1 : 0].ids[0], after: right } : null;
}

/** 열 경계선 — r줄의 k-1번째와 k번째 열 사이를 d(24분의 몇)만큼 옮긴다. 두 열 합은 그대로, 각자 최소 폭 밑으로는 안 간다 */
export function resizeCols(rows, r, k, d, minOf) {
  const row = rows[r], a = row[k - 1], b = row[k], lo = (col) => Math.max(...col.ids.map(minOf));
  const w = Math.max(lo(a), Math.min(a.w + b.w - lo(b), a.w + d));
  return rows.map((rw, i) => (i !== r ? rw : rw.map((col, j) => (j === k - 1 ? { ...col, w } : j === k ? { ...col, w: a.w + b.w - w } : col))));
}

/** 두 번 누르기 = 그 줄 열 폭을 똑같이(최소 폭은 지킨다) */
export const equalize = (rows, r, minOf) => tidy(rows.map((row, i) => (i !== r ? row : row.map((col) => ({ ...col, w: 1 })))), minOf);

/**
 * 줄 목록 → 저장할 항목. 보이는 모듈마다 r·c·cw(9차)를 붙이고 줄→열→위아래 순으로 놓는다. 옛 앱용으로 x·y·t·span(·size·baseSize)도 같이 쓴다:
 * span = 열 폭을 12열로 반올림(그 모듈 열 범위 안), x = 열 시작, y = 순서, t = 그린 위 끝(px). 숨긴 모듈은 뒤에 — 줄·열은 지운다(되살리면 맨 아래 새 줄).
 * hOf(id) = 높이, modOf(item) = 등록부 정의
 */
export function settle(items, rows, hOf, gap, modOf) {
  const { pos } = placeRows(rows, hOf, gap), byId = new Map(items.map((it) => [it.id, it])), out = [];
  let y = 0;
  rows.forEach((row, r) => row.forEach((col, c) => col.ids.forEach((id) => {
    const it = byId.get(id), p = pos.get(id), [lo, hi] = spanRange(modOf(it).sizes), span = Math.max(lo, Math.min(hi, Math.round(col.w / 2)));
    out.push({ ...applySizes([it], { [id]: { span } }, modOf)[0], r, c, cw: col.w, x: Math.min(Math.round(p.x / 2), 12 - span), y: y++, t: Math.round(p.top) });
  })));
  for (const it of items) if (!pos.has(it.id)) { const { r: _r, c: _c, cw: _w, ...rest } = it; out.push(rest); }
  return out;
}
