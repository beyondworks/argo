// 순수 로직 — "지금 확인해도 되나"·"막대를 다시 띄워야 하나"의 판정만. 타이머·fetch는 update.jsx/mobile-update.jsx가 가진다.

export const CHECK_INTERVAL_MS = 30 * 60 * 1000; // 유건 결정 — 30분마다 + 포커스 복귀 시
// GitHub 비인증 호출 한도는 시간당 60회 — 포커스·시작(새로고침 포함)이 몰리면 금방 닳는다. 이유가 뭐든 5분 안에 두 번은 안 한다.
export const MIN_CHECK_GAP_MS = 5 * 60 * 1000;

/** 데스크톱: 이미 막대가 떠 있거나(available) 설치 중이면 중복 확인하지 않는다. 주기(interval)는 30분,
 *  포커스 복귀(focus)는 즉시 확인하되 최소 간격(5분)은 지킨다 — 창을 자주 들락거려도 호출이 안 몰린다. */
export function shouldCheckDesktop({ phase, now, lastCheckAt, reason, intervalMs = CHECK_INTERVAL_MS, minGapMs = MIN_CHECK_GAP_MS }) {
  if (phase === 'available' || phase === 'installing' || phase === 'ready') return false;
  if (lastCheckAt == null) return true;
  const elapsed = now - lastCheckAt;
  if (reason === 'interval') return elapsed >= intervalMs;
  return elapsed >= minGapMs; // focus 등
}

/** "나중에"를 누른 버전은 이번 실행 동안 다시 띄우지 않되, 더 새 버전이 나오면 띄운다.
 *  dismissedVersion은 세션 메모리(재시작하면 사라짐 — 새로 켠 앱은 다시 알려준다). */
export function shouldShowVersion(latestVersion, dismissedVersion) {
  return !!latestVersion && latestVersion !== dismissedVersion;
}

/** 모바일: 시작(새로고침 포함)·포그라운드 복귀는 최소 간격(5분)만 지키면 확인하고, 포그라운드로 있는 동안은
 *  30분 주기. 백그라운드 중엔 확인하지 않는다(부하 최소화). lastCheckAt은 sessionStorage에 둬서 새로고침
 *  직후의 'start'가 간격 판정을 우회하지 못하게 한다(호출부 책임 — 이 함수는 받은 값만 본다). */
export function shouldCheckMobile({ reason, foreground, now, lastCheckAt, intervalMs = CHECK_INTERVAL_MS, minGapMs = MIN_CHECK_GAP_MS }) {
  if (!foreground) return false;
  if (lastCheckAt == null) return true;
  const elapsed = now - lastCheckAt;
  if (reason === 'interval') return elapsed >= intervalMs;
  return elapsed >= minGapMs; // start·foreground
}
