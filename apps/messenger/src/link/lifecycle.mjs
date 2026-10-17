// 앱 앞·뒤와 네트워크 표지를 연결 상태 기계(machine.mjs)에 잇는다 — 화면(U6)이 기계를 만든 뒤 한 번 부른다.
// visibilitychange: 숨으면 소켓을 닫고(요청 0), 보이면 구독 → 따라잡기 1회. online: nudge(대기 중인 재연결 간격은 건너뛰지 않는다).
// 타이머를 두지 않는다 — 사건이 있을 때만 움직인다(유휴 요청 0).
export function bindLifecycle(machine, win = globalThis.window) {
  const doc = win?.document;
  const vis = () => { void machine.setForeground(doc?.visibilityState !== 'hidden'); };
  const online = () => { machine.nudge(); };
  doc?.addEventListener?.('visibilitychange', vis);
  win?.addEventListener?.('online', online);
  vis();
  return () => {
    doc?.removeEventListener?.('visibilitychange', vis);
    win?.removeEventListener?.('online', online);
  };
}
