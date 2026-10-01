// 토스트 자리(LA-04 재검수 #801) — 화면 위쪽 고정(52/72px)은 화면마다 머리 높이가 달라(폰 방 62·홈 안전 영역 47+큰 제목, 데스크톱 두 줄 머리·열린 시트) 머리·제목·시트를 가렸다.
// 아래쪽에 깔린 것(탭 바·새 대화 단추·입력창 받침)의 윗선 바로 위에, 가로는 입력창 열(없으면 본문 열) 가운데에 놓는다.
// 순수 계산 — 재는 건 호출하는 쪽(App.jsx Shell).
export function toastPlace({ viewW, viewH, boxW, anchorTop, colLeft, colRight, gap = 12, edge = 16 }) {
  const cx = (colLeft + colRight) / 2;
  const left = Math.max(edge, Math.min(cx - boxW / 2, viewW - boxW - edge)); // 화면 가장자리에서 edge 안쪽
  const bottom = Math.max(edge, viewH - anchorTop + gap); // 받침이 없으면(anchorTop = viewH) 바닥에서 gap
  return { left: Math.round(left), bottom: Math.round(bottom) };
}

/** 상자 최대 폭 — 입력창 열(시트가 열려 좁아진 열 포함)보다 넓게 만들지 않는다. 좁은 열이면 글이 줄바꿈된다(하한 240, 화면 가장자리 안쪽, 기존 상한 560). */
export function toastMaxWidth({ viewW, colLeft, colRight, edge = 16 }) {
  return Math.round(Math.max(240, Math.min(560, colRight - colLeft, viewW - edge * 2)));
}
