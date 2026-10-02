// 자유 격자 옮기기·크기 바꾸기의 결과 계산(유건 10/1 저녁, 7차 10/2) — 끌기 화면 코드(ui/module-move.js·module-resize.js)만 쓴다(첫 화면 밖).
// 상자 = 지금 화면에 놓인 모듈 { id, x, w, top, h } (px). 끄는 동안 다른 모듈은 움직이지 않고, 여기서 계산한 자리(윤곽)만 보인다.
// 7차: 세로 중력이 없다 — 손을 뗀 높이에 그대로 놓이고(빈칸 허용), 겹치는 모듈만 아래로 밀린다. 같은 줄의 모듈 위에 놓으면 둘이 자리를 바꾼다.
import { pack } from './layout.js';

const byTop = (a, b) => a.top - b.top || a.x - b.x;
const cross = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w;
const clampX = (x, w) => Math.max(0, Math.min(x, 12 - w));

/** 놓을 자리(넓은 화면) — id를 시작 열 tx, 위 끝 top(격자 기준 px)에 놓으면 모두 어디에 놓이나. 그리는 규칙과 같다(layout.js pack):
 *  위 끝 순서로 top = max(그 높이, 앞에 놓인 모듈 아래 끝 + 틈) — 빈칸은 남고, 겹치는 모듈은 아래로 밀린다(위에서 시작한 모듈 아래로는 끄는 모듈이 들어간다).
 *  자리 바꾸기: 윤곽과 겹치는 모듈 T의 위 끝이 윤곽 위 끝과 T 높이의 절반 안이면(같은 줄) 윤곽은 T의 위 끝에 맞추고, T는 끌던 모듈의 원래 자리(원래 x·위 끝)로 간다.
 *  둘이 같은 열에서 위아래로 바꾸면(바꾼 뒤에도 열이 겹치면) 둘 사이에 빈칸이 생기지 않게 원래 두 자리의 위쪽부터 차례로 붙인다. 돌려주는 목록의 swap = 바꾼 모듈 id */
export function landing(boxes, id, tx, top, gap) {
  const me = boxes.find((b) => b.id === id), at = { ...me, x: clampX(tx, me.w), top: Math.max(0, top) };
  const near = (b) => Math.abs(b.top - at.top);
  const swap = boxes.filter((b) => b !== me && cross(at, b) && at.top < b.top + b.h && b.top < at.top + at.h && near(b) <= b.h / 2).sort((a, b) => near(a) - near(b))[0];
  const key = new Map(boxes.map((b) => [b.id, b.top]));
  let other = null;
  if (swap) {
    other = { ...swap, x: clampX(me.x, swap.w) };
    at.top = swap.top;
    if (cross(other, at)) { // 같은 열에서 위아래로 — 위쪽 자리부터 차례로(위로 가는 쪽이 먼저)
      const [up, down] = me.top > swap.top ? [at, other] : [other, at], first = Math.min(me.top, swap.top);
      up.top = first; down.top = first + up.h + gap;
    } else other.top = me.top;
    key.set(swap.id, other.top);
  }
  key.set(id, at.top);
  const list = boxes.map((b) => (b === me ? at : b === swap ? other : b));
  // 위 끝 순서(같으면 끄는 모듈 먼저, 그다음 왼쪽부터)로 쌓는다 — 그리는 규칙과 같은 계산이라 놓은 뒤 다시 그려도 같은 자리
  const order = list.slice().sort((a, b) => key.get(a.id) - key.get(b.id) || (b.id === id) - (a.id === id) || a.x - b.x);
  const out = pack(order.map((b) => ({ ...b, t: key.get(b.id) })), gap).map(({ t, ...b }) => b);
  out.swap = swap?.id;
  return out;
}

/** 좁은 폭(한 줄에 하나) 놓을 자리 — 순서만 바뀐다. 가운데가 포인터 높이 ty보다 위인 모듈은 앞, 나머지는 뒤 */
export function insertAt(boxes, id, ty, gap) {
  const me = boxes.find((b) => b.id === id), rest = boxes.filter((b) => b !== me).sort(byTop), above = (b) => b.top + b.h / 2 <= ty;
  return pack([...rest.filter(above), me, ...rest.filter((b) => !above(b))], gap);
}

/** 키보드 ↑/↓ 한 칸(넓은 화면, 끌기와 같이 처음 자리 기준) — 옮기는 모듈 열(tx~tx+w)에 걸친 다른 모듈의 위 끝(그 모듈과 같은 줄 → 자리 바꾸기)
 *  또는 자기 처음 위 끝으로. ↓에 더 없으면 그대로, ↑에 더 없으면 맨 위(0) */
export function stepY(boxes, id, tx, w, ty, dir) {
  const tops = boxes.filter((b) => b.id === id || (b.x < tx + w && tx < b.x + b.w)).map((b) => b.top);
  if (dir < 0) return Math.max(0, ...tops.filter((v) => v < ty));
  const below = tops.filter((v) => v > ty);
  return below.length ? Math.min(...below) : ty;
}

/** 좁은 폭 키보드 ↑/↓ — 모듈 하나를 넘는 포인터 높이(insertAt과 짝) */
export function stepOrder(boxes, id, ty, dir) {
  const mids = boxes.filter((b) => b.id !== id).map((b) => b.top + b.h / 2).sort((a, b) => a - b);
  if (dir > 0) return mids.find((m) => m > ty) ?? ty;
  const prev = mids.filter((m) => m <= ty).at(-1);
  return prev == null ? ty : prev - 0.5;
}

/** 크기를 바꾼 뒤(그 모듈만) — 그 모듈보다 완전히 위에 있는 모듈은 그대로, 그 모듈은 바꾼 자리·크기 그대로, 나머지는 제 높이에 두되 겹치면 아래로 밀린다(빈칸은 그대로) */
export function around(boxes, id, next, gap) {
  const me = boxes.find((b) => b.id === id), rest = boxes.filter((b) => b !== me).sort(byTop), above = (b) => b.top + b.h <= me.top;
  const mine = { ...me, ...next };
  return pack([...rest.filter(above), mine, ...rest.filter((b) => !above(b))].map((b) => ({ ...b, t: b.top })), gap).map(({ t, ...b }) => b);
}

/** 위 가장자리를 위로 끌 때 멈추는 높이 — 그 모듈 열 위에 있는 모듈의 아래 끝 + 틈(없으면 0) */
export const ceiling = (boxes, id, gap) => {
  const me = boxes.find((b) => b.id === id);
  return Math.max(0, ...boxes.filter((b) => b.id !== id && cross(b, me) && b.top + b.h <= me.top).map((b) => b.top + b.h + gap));
};

/** 쌓은 결과 → 저장할 항목. 보이는 모듈마다 x·y(위에서부터 순서)·t(위 끝, px)를 붙여 y→x 순으로, 숨긴 모듈은 뒤에 그대로.
 *  옛 필드(size·span·h·cfg)는 그대로 둔다 — 옛 앱은 x·y·t를 모르고 순서·열 수로 그린다. xs = 좁은 폭(순서만 바꾼다): 넓은 화면의 열(xs)과 t는 그대로 둔다 */
export function settle(items, placed, xs) {
  const order = placed.slice().sort(byTop), at = new Map(order.map((b, y) => [b.id, xs ? { x: xs.get(b.id) ?? b.x, y } : { x: b.x, y, t: Math.round(b.top) }]));
  return [...order.flatMap((b) => items.filter((it) => it.id === b.id).map((it) => ({ ...it, ...at.get(b.id) }))), ...items.filter((it) => !at.has(it.id))];
}
