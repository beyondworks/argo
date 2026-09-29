// 시작 스플래시가 닫히는 시각(순수) — 로딩 시간을 늘리지 않는다(2026-09-29 초안 공통 기준).
export const SPLASH_MIN_MS = 900; // 준비가 빨라도 이만큼은 보여 준다(모션이 끝까지 읽히게)
export const SPLASH_MAX_MS = 5000; // 준비 신호가 안 오면(오류·예외 화면) 이때 닫는다 — 스플래시가 앱을 가리지 않게
export function splashExitAt(startedAt, readyAt) {
  const latest = startedAt + SPLASH_MAX_MS;
  if (readyAt == null) return latest;
  return Math.min(latest, Math.max(startedAt + SPLASH_MIN_MS, readyAt));
}
