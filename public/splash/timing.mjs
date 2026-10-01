// 시작 스플래시가 닫히는 시각(순수) — 로딩 시간을 늘리지 않는다(2026-09-29 초안 공통 기준).
// 메신저(apps/messenger/src/splash.js)와 Argo 본체(public/boot-splash.mjs·app/splash-continue.jsx)가 같이 쓴다.
export const SPLASH_MIN_MS = 900; // 준비가 빨라도 이만큼은 보여 준다(모션이 끝까지 읽히게)
export const SPLASH_MAX_MS = 5000; // 준비 신호가 안 오면(오류·예외 화면) 이때 닫는다 — 스플래시가 앱을 가리지 않게
// minMs·maxMs — 본체 2단계(Next 첫 화면)는 등장을 부트 화면에서 이미 재생했으므로 최소 0으로 부른다.
export function splashExitAt(startedAt, readyAt, minMs = SPLASH_MIN_MS, maxMs = SPLASH_MAX_MS) {
  const latest = startedAt + maxMs;
  if (readyAt == null) return latest;
  return Math.min(latest, Math.max(startedAt + minMs, readyAt));
}
