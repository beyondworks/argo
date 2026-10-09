// 기억 그래프 2D — 라벨 배치(순수). JSX 없는 모듈이라 node 테스트가 직접 임포트한다(test/body-390.test.mjs).
// 본체 2D 렌더러(graph2d.jsx)만 쓴다 — 메신저와 함께 쓰는 graph2d-core.mjs에는 넣지 않는다.
//
// 옛 판정(2026-08 ~ 10/9)은 라벨 시작점끼리의 거리만 봤다: 세로가 겹치고 가로 시작점이 170px 안이면 건너뜀, 자리는 언제나 오른쪽.
// 실제 글자 폭을 몰라서 ① 170px보다 긴 라벨(제목 28자 ≈ 300px)이 오른쪽 라벨을 덮었고 ② 캔버스 끝을 넘는 라벨이 잘렸다
// (10/6 폰 390 실제 계정 점검, 10/9 880·1280에서도 재현). 지금은 옛 판정을 먼저 그대로 거친 뒤 실제 글자 폭 상자로 한 번 더 보고,
// 오른쪽 끝을 넘는 라벨만 노드 왼쪽(오른쪽 정렬)에 놓아 본다. 그래서 겹치거나 잘리던 라벨이 없는 화면은 종전과 똑같이 그린다.

/** 옛 판정의 가로 하한 — 세로가 겹치는 두 라벨의 시작점이 이보다 가까우면 뒤 라벨을 건너뛴다. */
export const LABEL_X_MIN = 170;

const hit = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * 라벨 자리 정하기.
 * cands: 그리는 순서의 후보 — { i, x(노드 중심), y(상자 세로 중심), gap(노드 중심에서 글자까지), w(실제 글자 폭 — 두 줄이면 긴 줄), h, em }
 *   em = 호버·원점 라벨: 막혀도 그린다(사용자가 지금 보는 것). 먼저 자리를 잡아 다른 라벨이 그 위를 덮지 않게 한다.
 * opts: { W, H(캔버스 CSS px), avoid: [{x,y,w,h}](라벨을 두지 않을 자리 — 그래프 위 칩·안내 줄), margin(좌우 여백) }
 * 반환: 놓인 라벨 [{ i, side: 'right'|'left', x(상자 왼쪽), y(상자 위), w, h }] — side가 left면 오른쪽 정렬로 그린다.
 */
export function placeLabels(cands, { W, H, avoid = [], margin = 4 } = {}) {
  const placed = [];
  const inside = (b) => b.x >= margin && b.x + b.w <= W - margin && b.y >= 0 && b.y + b.h <= H;
  const crowded = (b) => placed.some((p) => Math.abs(p.y + p.h / 2 - (b.y + b.h / 2)) < (p.h + b.h) / 2 && Math.abs(p.x - b.x) < LABEL_X_MIN);
  const free = (b) => !avoid.some((a) => hit(a, b)) && !placed.some((p) => hit(p, b)) && !crowded(b);
  const ordered = [...cands.filter((c) => c.em), ...cands.filter((c) => !c.em)];
  for (const c of ordered) {
    const top = c.y - c.h / 2;
    const right = { i: c.i, side: 'right', x: c.x + c.gap, y: top, w: c.w, h: c.h };
    const left = { i: c.i, side: 'left', x: c.x - c.gap - c.w, y: top, w: c.w, h: c.h };
    if (c.em) { placed.push(inside(right) || !inside(left) ? right : left); continue; }
    if (crowded(right)) continue; // 옛 판정 그대로 — 옛 화면이 건너뛰던 라벨은 새로 그리지 않는다
    // 왼쪽은 오른쪽이 캔버스 밖으로 나갈 때만 쓴다 — 오른쪽이 다른 라벨에 막혔다고 왼쪽으로 옮기면 데스크톱에 라벨이 늘어난다
    const b = inside(right) ? right : left;
    if (inside(b) && free(b)) placed.push(b);
  }
  return placed;
}

/** 늘 켜 두는 허브 라벨 수 — 캔버스 면적에 비례(넓은 화면은 종전 그대로 14개, 폰 폭은 줄인다). compact(데크 미니)는 허브 라벨이 없다. */
export function hubLabelCount(W, H) {
  return Math.max(4, Math.min(14, Math.floor((W * H) / 24000)));
}
