// 끊긴 동안의 보정 조회 박자(2026-10-25 유휴 읽기 줄이기, 총괄 지시 — M1 조회: 열린 화면마다 약 10~15초마다 글·결재를 다시 읽는 것이 메신저 REST의 상위).
// 채널 화면은 실시간이 끊겼다고 알려진 동안(rt_down — v1 구독 끊김, v2 연결 상태 기계가 ready가 아님) 놓친 글·결재를 주기적으로 다시 읽는다.
// v2는 앱이 백그라운드로 가면 상태가 background(ready 아님)가 되어, 숨겨진 창이 10초마다 계속 읽고 있었다.
//   · 창이 숨겨져 있으면 읽지 않는다 — 돌아오는 순간은 onForeground(instant-delivery.mjs)가 한 번 따라잡는다.
//   · 변화가 없으면 간격을 늘린다: 10 → 20 → 40 → 80 → 160 → 300초(상한 5분). 새 글이 오면(부르는 쪽 효과가 lastId로 다시 시작) 10초부터.
// 쓰기 없음, 순수 함수(시험: test/idle-poll.test.mjs).

export const IDLE_POLL_DELAYS = [10_000, 20_000, 40_000, 80_000, 160_000, 300_000];

/** run을 박자대로 부른다. 반환 = 멈추기. hidden() 참이면 그 칸은 건너뛰고(요청 0) 같은 간격으로 다시 잰다. */
export function startIdlePoll(run, { delays = IDLE_POLL_DELAYS, hidden = () => globalThis.document?.visibilityState === 'hidden', setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let i = 0; let t = null; let stopped = false;
  const next = () => { if (!stopped) t = setTimer(tick, delays[Math.min(i, delays.length - 1)]); };
  function tick() {
    t = null;
    if (stopped) return;
    if (!hidden()) { i += 1; run(); }
    next();
  }
  next();
  return () => { stopped = true; if (t != null) clearTimer(t); t = null; };
}
