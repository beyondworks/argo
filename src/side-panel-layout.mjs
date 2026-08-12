// Codex식 우측 도구 패널의 수평 리사이즈 계산.
// UI 이벤트와 분리해 포인터·키보드·창 크기 변경이 같은 경계를 공유하고 회귀 테스트할 수 있게 한다.
export const PANEL_DEFAULT_WIDTH = 540;
export const PANEL_MIN_WIDTH = 360;
export const PANEL_MAX_WIDTH = 900;
export const PANEL_OVERLAY_BREAKPOINT = 1699;

export const FILE_TREE_DEFAULT_WIDTH = 220;
export const FILE_TREE_MIN_WIDTH = 150;
export const FILE_TREE_MAX_WIDTH = 420;
export const FILE_DOCUMENT_MIN_WIDTH = 180;
export const FILE_SPLITTER_WIDTH = 6;

export const clampWidth = (value, min, max) => {
  const numeric = Number(value);
  const safe = Number.isFinite(numeric) ? numeric : min;
  return Math.round(Math.min(Math.max(safe, min), max));
};

/** 도킹에서는 채팅 읽기 폭을 남기고, 오버레이에서는 화면 폭 안에서 자유롭게 조절한다. */
export function panelWidthBounds(viewportWidth) {
  const viewport = Math.max(280, Number(viewportWidth) || PANEL_DEFAULT_WIDTH);
  const overlay = viewport <= PANEL_OVERLAY_BREAKPOINT;
  const max = overlay
    ? Math.min(PANEL_MAX_WIDTH, viewport)
    : Math.max(PANEL_MIN_WIDTH, Math.min(PANEL_MAX_WIDTH, viewport - 1080));
  return { min: Math.min(PANEL_MIN_WIDTH, max), max };
}

/** 오른쪽에 놓인 영역의 왼쪽 경계를 왼쪽으로 끌면 폭이 커진다. */
export function widthFromLeftDrag(startWidth, startX, currentX, bounds) {
  return clampWidth(Number(startWidth) + Number(startX) - Number(currentX), bounds.min, bounds.max);
}

/** 열린 파일 문서가 사라지지 않도록 실제 도구 폭에서 트리 최대값을 계산한다. */
export function fileTreeWidthBounds(containerWidth) {
  const container = Math.max(0, Number(containerWidth) || 0);
  const available = container - FILE_DOCUMENT_MIN_WIDTH - FILE_SPLITTER_WIDTH;
  const max = Math.max(0, Math.min(FILE_TREE_MAX_WIDTH, available));
  return { min: Math.min(FILE_TREE_MIN_WIDTH, max), max };
}
