// 표시 배율(zoom) 좌표·치수 보정의 계산부 — JSX 없는 코어(테스트가 직접 임포트, graph2d-core.mjs 선례).
// zoom은 이벤트 좌표(뷰포트 px)와 CSS 좌표계(px)를 어긋나게 하므로, 여기서만 환산한다.
// 배율 1이면 전부 항등 — 종전 동작과 완전 동일해야 한다(#334 제약: 비례 확대·레이아웃 유지).

/** 현재 표시 배율 — zoomBoot(layout.jsx)·cmd +/-(i18n.jsx)가 documentElement.style.zoom에 쓴 값을 읽는다. */
export const dispZoom = () => parseFloat(document.documentElement.style.zoom) || 1;

/** 보조 패널 폭 클램프 — 하한 360px, 상한 뷰포트 폭(CSS px = 뷰포트 px ÷ 배율)의 60%. */
export const PANE_W_MIN = 360;
export const clampPaneW = (w) => Math.max(PANE_W_MIN, Math.min(Math.round(window.innerWidth / dispZoom() * 0.6), Math.round(w)));

/** 이벤트 좌표(뷰포트 px) → 요소 좌표계(CSS px). rect는 배율이 곱해진 크기, clientWidth는 CSS px라
    비율 k로 환산한다(배율 1 = k 1 = 종전 동일). rect.width 0(미레이아웃)은 k 1로 관용. */
export const zoomedEvPos = (rect, clientWidth, clientX, clientY) => {
  const k = rect.width ? clientWidth / rect.width : 1;
  return [(clientX - rect.left) * k, (clientY - rect.top) * k];
};
