// 폰 당겨서 새로고침(pull-to-refresh) — 순수 판정 로직만 여기. 실제 터치 배선은 App.jsx의 usePullToRefresh.
// 새로고침은 현재 React 트리를 유지한 채 데이터만 갱신한다.
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

// Argo 별 심볼(App.jsx STAR_D 재사용) 회전·크기 — 당긴 거리(가공값, pullDistance 결과)에 비례해 커지며 돈다(유건 확정 2026-09-29).
const STAR_MIN_SCALE = 0.55; // 0px에서도 아주 작게 보이기 시작
const STAR_MAX_DEG = 480; // 임계보다 더 당기면 한 바퀴 반 가까이 — 새로고침 중 CSS 연속 회전으로 이어진다
export function pullRotationDeg(dist) {
  const clamped = Math.max(0, Math.min(dist, REFRESH_MAX));
  return (clamped / REFRESH_MAX) * STAR_MAX_DEG;
}
export function pullStarScale(dist) {
  const clamped = Math.max(0, Math.min(dist, REFRESH_THRESHOLD));
  return STAR_MIN_SCALE + (clamped / REFRESH_THRESHOLD) * (1 - STAR_MIN_SCALE);
}
// 튐(scale pulse) 트리거 — 아직 ready/refreshing이 아니었다가 막 그 상태로 넘어갈 때만 참(재진입마다 한 번씩만 튄다).
export function enteredReady(prevPhase, nextPhase) {
  const already = prevPhase === 'ready' || prevPhase === 'refreshing';
  const now = nextPhase === 'ready' || nextPhase === 'refreshing';
  return !already && now;
}

// Keep the gesture lifecycle testable without a browser reload or React remount.
// 조회가 빨리 끝나도 '새로고침 중'을 이만큼은 보여 준다 — 72ms만 번쩍이면 새로고침됐는지 알 수 없다(2026-09-29 실측, iOS 기본 당김도 약 0.5~1초)
export const REFRESH_MIN_MS = 600;
// 길게 누르기(long-press.js: 450ms·10px)와 같은 기준 — 그 시간 안에 이 거리를 넘겨 움직여야 당김이다.
// 가만히 누르고 있다 끌면 행 메뉴·직접 배치 끌기이지 새로고침이 아니다(2026-09-29 실측: 메뉴가 뜬 채 새로고침까지 시작).
export const PULL_HOLD_MS = 450;
export const PULL_ENGAGE_PX = 10;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function bindPullRefresh(node, { refresh, phase, error, now = Date.now, minMs = REFRESH_MIN_MS, delay = sleep }) {
  let startAt = null; let busy = false; let disposed = false; let lastScroll = -Infinity;
  const reset = () => { startAt = null; node.style.setProperty('--pull-dy', '0px'); node.style.setProperty('--pull-deg', '0'); node.style.setProperty('--pull-scale', String(pullStarScale(0))); phase('idle'); };
  const scroll = () => { lastScroll = now(); };
  const start = (e) => {
    if (busy || !canStartPull(node.scrollTop, e.touches.length, now() - lastScroll)) return;
    startAt = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: now(), engaged: false };
  };
  const move = (e) => {
    if (!startAt || busy) return;
    if (e.touches.length !== 1) { reset(); return; }
    const dx = e.touches[0].clientX - startAt.x, dy = e.touches[0].clientY - startAt.y;
    if (!startAt.engaged) {
      if (now() - startAt.t >= PULL_HOLD_MS) { startAt = null; return; } // 길게 누르기였다 — 이 터치는 끝까지 당김 아님
      if (Math.hypot(dx, dy) <= PULL_ENGAGE_PX) return;
      startAt.engaged = true;
    }
    if (!isVerticalPull(dx, dy) || node.scrollTop > 0) { reset(); return; }
    e.preventDefault();
    const dist = pullDistance(dy);
    node.style.setProperty('--pull-dy', `${Math.min(56, dist * .5)}px`);
    node.style.setProperty('--pull-deg', String(pullRotationDeg(dist)));
    node.style.setProperty('--pull-scale', String(pullStarScale(dist)));
    phase(shouldRefresh(dy) ? 'ready' : 'pulling');
  };
  const end = async (e) => {
    if (!startAt || busy) return;
    const touch = e.changedTouches?.[0];
    const accepted = touch && startAt.engaged && isVerticalPull(touch.clientX - startAt.x, touch.clientY - startAt.y) && shouldRefresh(touch.clientY - startAt.y);
    startAt = null;
    if (!accepted) { reset(); return; }
    busy = true; node.style.setProperty('--pull-dy', '44px'); phase('refreshing');
    const until = now() + minMs;
    try { await refresh(); } catch (err) { if (!disposed) error(err); }
    finally { const left = until - now(); if (left > 0 && !disposed) await delay(left); busy = false; if (!disposed) reset(); }
  };
  const cancel = () => { if (!busy) reset(); };
  const events = { scroll, touchstart: start, touchmove: move, touchend: end, touchcancel: cancel };
  for (const [type, fn] of Object.entries(events)) node.addEventListener(type, fn, { passive: type !== 'touchmove' });
  return () => { disposed = true; for (const [type, fn] of Object.entries(events)) node.removeEventListener(type, fn); node.style.removeProperty('--pull-dy'); node.style.removeProperty('--pull-deg'); node.style.removeProperty('--pull-scale'); };
}
