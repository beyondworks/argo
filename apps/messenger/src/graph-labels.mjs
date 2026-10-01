// 기억 그래프에서 이름을 그릴 점 — 허브(연결 3 이상)·집중·호버·이웃만 그리면 점 11개 중 3개만 이름이 붙어 나머지가 무엇인지 알 수 없었다(검수 E, 2026-10-01).
// 점이 적으면(SMALL_GRAPH 이하) 처음부터 전부 이름을 그린다. 많으면 종전대로 — 이름이 겹쳐 읽을 수 없게 된다.
export const SMALL_GRAPH = 30;
export function graphLabelVisible({ i, hover, focus, hoverNeighbor, near, deg, n }) {
  if (i === hover || i === focus) return true;
  if (hover >= 0) return !!hoverNeighbor;
  return near ? near.has(i) : deg >= 3 || n <= SMALL_GRAPH;
}
