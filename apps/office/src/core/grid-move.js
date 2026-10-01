// 자유 격자 옮기기·크기 바꾸기의 결과 계산(유건 10/1 저녁) — 끌기 화면 코드(ui/module-move.js·module-resize.js)만 쓴다(첫 화면 밖).
// 상자 = 지금 화면에 놓인 모듈 { id, x, w, top, h } (px). 끄는 동안 다른 모듈은 움직이지 않고, 여기서 계산한 자리(윤곽)만 보인다.
import { pack } from './layout.js';

const byTop = (a, b) => a.top - b.top || a.x - b.x;

/** 놓을 자리 — id를 시작 열 tx, 포인터 높이 ty(격자 기준 px)에 놓으면 모두 어디에 놓이나(쌓는 순서대로).
 *  가운데가 ty보다 위인 모듈은 앞(그대로 위), 나머지는 뒤 — 놓인 자리와 겹치는 모듈은 아래로 밀리고, 빈 곳은 위로 붙는다. */
export function landing(boxes, id, tx, ty, gap) {
  const me = boxes.find((b) => b.id === id), rest = boxes.filter((b) => b !== me).sort(byTop), above = (b) => b.top + b.h / 2 <= ty;
  return pack([...rest.filter(above), { ...me, x: tx }, ...rest.filter((b) => !above(b))], gap);
}

/** 키보드 ↑/↓ 한 칸 — 옮기는 모듈 열(tx~tx+w)에 걸친 다른 모듈 하나를 넘는 높이. 넘을 것이 없으면 그대로 */
export function stepY(boxes, id, tx, w, ty, dir) {
  const mids = boxes.filter((b) => b.id !== id && b.x < tx + w && tx < b.x + b.w).map((b) => b.top + b.h / 2).sort((a, b) => a - b);
  if (dir > 0) return mids.find((m) => m > ty) ?? ty;
  const prev = mids.filter((m) => m <= ty).at(-1);
  return prev == null ? ty : prev - 0.5;
}

/** 크기를 바꾼 뒤 다시 쌓기 — 그 모듈보다 완전히 위에 있는 모듈만 앞, 나머지는 뒤라 새 크기와 겹치는 모듈은 아래로 밀린다 */
export function around(boxes, id, next, gap) {
  const me = boxes.find((b) => b.id === id), rest = boxes.filter((b) => b !== me).sort(byTop), above = (b) => b.top + b.h <= me.top;
  return pack([...rest.filter(above), { ...me, ...next }, ...rest.filter((b) => !above(b))], gap);
}

/** 쌓은 결과 → 저장할 항목. 보이는 모듈마다 x와 y(위에서부터 순서)를 붙여 y→x 순으로, 숨긴 모듈은 뒤에 그대로.
 *  옛 필드(size·span·h·cfg)는 그대로 둔다 — 옛 앱은 x·y를 모르고 순서·열 수로 그린다. xs = 열을 따로 정할 때(좁은 폭은 순서만 바꾼다) */
export function settle(items, placed, xs) {
  const order = placed.slice().sort(byTop), at = new Map(order.map((b, y) => [b.id, { x: xs?.get(b.id) ?? b.x, y }]));
  return [...order.flatMap((b) => items.filter((it) => it.id === b.id).map((it) => ({ ...it, ...at.get(b.id) }))), ...items.filter((it) => !at.has(it.id))];
}
