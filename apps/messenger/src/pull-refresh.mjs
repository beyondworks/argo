// 폰 당겨서 새로고침(pull-to-refresh) — 순수 판정 로직만 여기. 실제 터치 배선은 App.jsx의 usePullToRefresh.
// 유건 결정: 새로고침 = location.reload()(로그인 유지), 목록·대화 맨 위에서만.
// 유건 제보(2026-09-26): "너무 민감하다" — 임계를 iOS 기본 앱 수준(약 110px)으로 올리고, 저항(고무줄) 한도도 같은 비율로 맞췄다(옛 70px 기준 120px과 같은 비율).
export const REFRESH_THRESHOLD = 110; // 이 거리 넘겨 놓으면 손을 떼는 순간 새로고침
export const REFRESH_MAX = 190; // 표시상 당김 한도(고무줄 — 그 뒤로는 서서히만 늘어난다)
// 스크롤이 멎은 직후 이 시간(ms) 안에 시작한 터치는 당김으로 보지 않는다 — 관성 스크롤로 맨 위에 막 닿은 순간과
// 진짜 정지를 구분한다(유건 제보: "최적화가 안 된 느낌" — 목록이 아직 흔들리는데 당김이 시작되던 것).
export const PULL_QUIET_MS = 250;

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

// 당김 제스처를 시작해도 되는가 — 스크롤 컨테이너가 맨 위(scrollTop 0 근방)이고 손가락 하나이고,
// 최근(PULL_QUIET_MS 안) 스크롤이 없었을 때만. 대화 화면의 "이전 기록 불러오기"(scrollTop < 120에서 발동)와
// 겹치지 않도록, scrollTop 판정은 0일 때만 참이다. msSinceScroll 기본값 Infinity = "스크롤한 적 없음"(항상 허용).
export function canStartPull(scrollTop, touches, msSinceScroll = Infinity) {
  return scrollTop <= 0 && touches === 1 && msSinceScroll >= PULL_QUIET_MS;
}

// 당김은 세로 제스처일 때만 — 목록 맨 위에서 탭 스와이프·가장자리 뒤로가기를 비스듬히 내린 경우는 새로고침이 아니다(검수 2026-09-24).
export function isVerticalPull(dx, dy) {
  return dy > 0 && dy > Math.abs(dx);
}
