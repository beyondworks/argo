// 길게 눌러 끌어 옮기기 — 드롭 위치 판정(순수). 실제 순서 재계산은 rail-state.mjs의 reorderFavorites를 그대로 재사용한다
// (dropBeforeIdAtY가 돌려주는 id를 reorderFavorites(ids, draggedId, beforeId)의 before로 넘기면 된다).
// rows: 위에서 아래로 쌓인 행의 {id, top, height}(getBoundingClientRect 기준, 끌고 있는 행은 호출자가 제외해서 넘긴다).
export function dropBeforeIdAtY(rows, y) {
  const hit = rows.find((r) => y < r.top + r.height / 2);
  return hit ? hit.id : null; // null = 마지막 행 중간선도 지났다 → 맨 뒤에 넣는다
}
