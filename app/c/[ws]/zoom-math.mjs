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

/** DropUp 열림 패널의 좌우 클램프(CSS px) — 패널은 트리거 래퍼 기준 absolute로, 폭이 아래로는
    minWidth(≥190), 위로는 무상한(옵션 라벨 nowrap max-content 성장 — #357 검수 실측 404 CSS px)이라
    좁은 열·우측 끝 트리거에서 뷰포트를 뚫는다(#357 검증 실측: en·1280 배율 2에서 패널 right 1415 >
    clientWidth 1264 → 문서 가로 스크롤). rect(트리거 래퍼)·viewportW는 뷰포트 px, panelW는 CSS px
    (offsetWidth — 등장 transform 무시 **실측** 자연 폭이라 max-content 성장분까지 그대로 회수된다).
    반환 { shift, maxW }(둘 다 CSS px): maxW = 뷰포트 − 양쪽 여백 상한(패널이 뷰포트보다 넓은
    극단의 바닥 — 100vw 근사는 스크롤바 폭만큼 새서(실측 1280 vs cw 1264) clientWidth로 계산한다),
    shift = 유효 폭(min(panelW, maxW)) 기준으로 뚫린 만큼 안쪽으로 미는 앵커 오프셋. 넘침이 없으면
    shift 0 — 일반 폭의 소비자 9곳(경쟁 4·쪽지 1·루틴 4)은 종전 위치 그대로다. 좌우 동시 넘침은
    왼쪽 가장자리 우선. */
export const dropUpClamp = (rect, viewportW, panelW, alignRight = false) => {
  const z = dispZoom();
  const M = 8 * z; // 가장자리 여백 8 CSS px(뷰포트 px 환산)
  const maxW = Math.floor((viewportW - 2 * M) / z); // 패널 폭 상한(CSS px)
  const w = Math.min(panelW, maxW) * z; // 유효 패널 폭(뷰포트 px)
  const left0 = alignRight ? rect.right - w : rect.left; // 시프트 0일 때 패널 왼쪽 끝(뷰포트 px)
  let dx = 0;
  if (left0 + w > viewportW - M) dx = viewportW - M - (left0 + w);
  if (left0 + dx < M) dx = M - left0;
  return { shift: Math.round(dx / z), maxW };
};
