// 표 여러 칸 고르기(유건 9/29) — 칸을 누른 채 다른 칸까지 끌면 두 칸이 만드는 사각형을 고르고, 우클릭으로 한 번에 가리기·해제.

/** 시작 칸과 끝 칸 사이의 모든 칸 [줄, 열] — 위에서 아래, 왼쪽에서 오른쪽 순서 */
export function cellsInBox([r1, c1], [r2, c2]) {
  const cells = [];
  for (let r = Math.min(r1, r2); r <= Math.max(r1, r2); r += 1) for (let c = Math.min(c1, c2); c <= Math.max(c1, c2); c += 1) cells.push([r, c]);
  return cells;
}

/** 한 번의 쓰기(redact.bulk)에 넣을 칸 — 상태가 바뀌는 칸만 */
export const bulkRedact = (rows, fields, cells, on) => cells
  .filter(([r]) => rows[r])
  .filter(([r, c]) => (rows[r].redacted ?? []).includes(fields[c]) !== on)
  .map(([r, c]) => ({ entity: 'customer', id: rows[r].id, field: fields[c], on }));
