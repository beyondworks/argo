// 순수 로직 — "지금 확인해도 되나"·"막대를 다시 띄워야 하나"의 판정만. 타이머·fetch는 update.jsx/mobile-update.jsx가 가진다.

export const CHECK_INTERVAL_MS = 30 * 60 * 1000; // 유건 결정 — 30분마다 + 포커스 복귀 시

/** 데스크톱: 이미 막대가 떠 있거나(available) 설치 중이면 중복 확인하지 않는다. 그 외엔
 *  주기가 지났거나(interval) 포커스가 막 돌아왔으면(reason==='focus') 확인한다. */
export function shouldCheckDesktop({ phase, now, lastCheckAt, reason, intervalMs = CHECK_INTERVAL_MS }) {
  if (phase === 'available' || phase === 'installing' || phase === 'ready') return false;
  if (reason === 'focus') return true;
  if (lastCheckAt == null) return true;
  return now - lastCheckAt >= intervalMs;
}

/** "나중에"를 누른 버전은 이번 실행 동안 다시 띄우지 않되, 더 새 버전이 나오면 띄운다.
 *  dismissedVersion은 세션 메모리(재시작하면 사라짐 — 새로 켠 앱은 다시 알려준다). */
export function shouldShowVersion(latestVersion, dismissedVersion) {
  return !!latestVersion && latestVersion !== dismissedVersion;
}

/** 모바일: 시작 1회, 포그라운드 복귀, 그리고 포그라운드로 있는 동안 30분 주기. 백그라운드 중엔 확인하지 않는다(부하 최소화). */
export function shouldCheckMobile({ reason, foreground, now, lastCheckAt, intervalMs = CHECK_INTERVAL_MS }) {
  if (!foreground) return false;
  if (reason === 'start' || reason === 'foreground') return true;
  if (lastCheckAt == null) return true;
  return now - lastCheckAt >= intervalMs;
}
