// 사내 방송 — 코어(결재·루틴)가 이벤트를 던지면 게이트웨이(메신저)가 받아 밀어준다.
// 순환 import 없이 코어→게이트웨이 단방향을 유지하기 위한 최소 팬아웃.
const handlers = new Set();

export function onNotify(fn) {
  handlers.add(fn);
  return () => handlers.delete(fn);
}

/** event: { type: 'approval'|'routine', wsId, ... } — 실패가 코어 흐름을 막으면 안 된다. */
export function emitNotify(event) {
  for (const h of handlers) {
    Promise.resolve()
      .then(() => h(event))
      .catch((e) => console.error('[argo] 알림 처리 실패:', e.message));
  }
}
