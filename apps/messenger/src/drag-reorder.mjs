// 길게 눌러 끌어 옮기기 — 드롭 위치 판정(순수). 실제 순서 재계산은 rail-state.mjs의 reorderFavorites를 그대로 재사용한다
// (dropBeforeIdAtY가 돌려주는 id를 reorderFavorites(ids, draggedId, beforeId)의 before로 넘기면 된다).
import { reorderFavorites } from './rail-state.mjs';
// rows: 위에서 아래로 쌓인 행의 {id, top, height}(getBoundingClientRect 기준, 끌고 있는 행은 호출자가 제외해서 넘긴다).
export function dropBeforeIdAtY(rows, y) {
  const hit = rows.find((r) => y < r.top + r.height / 2);
  return hit ? hit.id : null; // null = 마지막 행 중간선도 지났다 → 맨 뒤에 넣는다
}
// 걸러 보이는 일부(visibleIds)에서 끌어 놓은 결과를 전체 순서(fullIds)에 반영한다. beforeId가 null(보이는 마지막 뒤)이면
// 전체 맨 뒤가 아니라 보이는 마지막 행 바로 뒤로 — 안 보이는 항목의 상대 순서는 그대로 둔다.
export function reorderVisibleInFull(fullIds, visibleIds, dragId, beforeId = null) {
  if (beforeId == null) {
    const at = fullIds.indexOf(visibleIds.filter((id) => id !== dragId).at(-1));
    if (fullIds.indexOf(dragId) > at) return fullIds; // 이미 보이는 마지막 행 뒤에 있다 — 안 보이는 항목과의 순서를 건드리지 않는다
    beforeId = at < 0 ? null : fullIds.slice(at + 1).find((id) => id !== dragId) ?? null;
  }
  return reorderFavorites(fullIds, dragId, beforeId);
}
