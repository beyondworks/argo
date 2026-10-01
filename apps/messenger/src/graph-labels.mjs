// 기억 그래프에서 이름을 그릴 점 — 허브(연결 3 이상)·집중·호버·이웃만 그리면 점 11개 중 3개만 이름이 붙어 나머지가 무엇인지 알 수 없었다(검수 E, 2026-10-01).
// 점이 적으면(SMALL_GRAPH 이하) 처음부터 전부 이름을 그린다. 많으면 종전대로 — 이름이 겹쳐 읽을 수 없게 된다.
export const SMALL_GRAPH = 30;
export function graphLabelVisible({ i, hover, focus, hoverNeighbor, near, deg, n }) {
  if (i === hover || i === focus) return true;
  if (hover >= 0) return !!hoverNeighbor;
  return near ? near.has(i) : deg >= 3 || n <= SMALL_GRAPH;
}

/** 이름 상자끼리 겹치면 우선순위가 낮은 쪽은 그리지 않는다(LA-24) — 점 둘이 화면에서 같은 자리에 놓이면(3D 투영) 이름 둘이 겹쳐 둘 다 읽을 수 없었다.
 *  호버·집중한 점(force)은 항상 그리고, 나머지는 pri 큰 순(같으면 카메라에 가까운 순 = z 작은 순)으로 자리를 잡는다. 못 그린 이름은 그 점에 호버하면 나타난다.
 *  cands: [{ i, x, y, w, h, pri, z, force }] — (x, y)는 상자 왼쪽 위. 돌려주는 값: 그릴 i의 Set. */
export function placeLabels(cands, pad = 2) {
  const placed = []; const out = new Set();
  const hit = (a, b) => a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad;
  for (const c of [...cands].sort((a, b) => (b.force ? 1 : 0) - (a.force ? 1 : 0) || b.pri - a.pri || a.z - b.z)) {
    if (c.force || !placed.some((p) => hit(c, p))) { placed.push(c); out.add(c.i); }
  }
  return out;
}
