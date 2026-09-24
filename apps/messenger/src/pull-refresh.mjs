// 폰 당겨서 새로고침(pull-to-refresh) — 순수 판정 로직만 여기. 실제 터치 배선은 App.jsx의 usePullToRefresh.
// 유건 결정: 새로고침 = location.reload()(로그인 유지), 임계 거리 약 70px, 목록·대화 맨 위에서만.
export const REFRESH_THRESHOLD = 70; // 이 거리 넘겨 놓으면 손을 떼는 순간 새로고침
export const REFRESH_MAX = 120; // 표시상 당김 한도(고무줄 — 그 뒤로는 서서히만 늘어난다)

// 손가락이 내려간 실거리(dy) → 화면에 보여줄 당김 거리. 임계 전엔 1:1, 넘으면 저항을 준다(끝없이 늘어나지 않게).
export function pullDistance(dy) {
  if (dy <= 0) return 0;
  if (dy <= REFRESH_THRESHOLD) return dy;
  const over = dy - REFRESH_THRESHOLD;
  return Math.min(REFRESH_MAX, REFRESH_THRESHOLD + over * 0.4);
}

// 손을 뗄 때 새로고침을 실행할지 — 화면상 당김 거리(가공값)가 아니라 원 거리(dy) 기준으로 임계 판정.
export function shouldRefresh(dy) {
  return dy >= REFRESH_THRESHOLD;
}

// 당김 제스처를 시작해도 되는가 — 스크롤 컨테이너가 맨 위(scrollTop 0 근방)이고 손가락 하나일 때만.
// 대화 화면의 "이전 기록 불러오기"(scrollTop < 120에서 발동)와 겹치지 않도록, 이 판정은 scrollTop이 정확히 0일 때만 참이다.
export function canStartPull(scrollTop, touches) {
  return scrollTop <= 0 && touches === 1;
}
