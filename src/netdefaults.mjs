// 아웃바운드 네트워크 기본값 — Node 20+의 happy-eyeballs 시도 제한(autoSelectFamilyAttemptTimeout)은
// 기본 250ms라, 왕복 250ms를 넘는 원격지(예: api.telegram.org — EU 데이터센터, 실측 TCP 266~332ms)로는
// 모든 connect 시도가 절단돼 undici fetch가 ETIMEDOUT("fetch failed")로 전멸한다. curl·브라우저는 되는데
// Node만 안 되는 전형 패턴(실측 2026-07-24: 기본값 fetch 5/5 실패 → 2000ms에서 3/3 성공).
// workspace.mjs가 이 모듈을 side-effect import하므로 코어(src/*)를 쓰는 모든 프로세스(웹 API 라우트·
// standalone 사이드카·게이트웨이 폴러·러너 검증)에 조기 적용된다. 듀얼스택 폴백(happy-eyeballs)은 유지.
import net from 'node:net';

export const AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS = 2000;

try {
  net.setDefaultAutoSelectFamilyAttemptTimeout(AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS);
} catch { /* Node <18.18 — API 부재 시 기본값 유지(구버전에는 happy-eyeballs 자체가 없어 문제도 없다) */ }
