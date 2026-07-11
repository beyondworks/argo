// 턴 중단 레지스트리 — 진행 중인 SDK 턴의 interrupt 핸들을 프로세스 안에 등록해 둔다.
// 사장이 "중단"을 누르면 해당 크루의 최신 턴을 멈춘다. (next start 단일 프로세스 전제 —
// dev HMR 다중 런타임에서는 같은 런타임의 턴만 잡힌다: 베스트에포트)
const active = new Map(); // `${wsId}:${slug}` → { interrupt, aborted }

export function registerTurn(wsId, slug, interrupt) {
  const key = `${wsId}:${slug}`;
  const entry = { interrupt, aborted: false };
  active.set(key, entry);
  return {
    wasAborted: () => entry.aborted,
    release: () => { if (active.get(key) === entry) active.delete(key); },
  };
}

/** 반환: 중단 요청이 전달됐는지. 진행 중 턴이 없으면 false. */
export async function interruptTurn(wsId, slug) {
  const entry = active.get(`${wsId}:${slug}`);
  if (!entry) return false;
  entry.aborted = true;
  try { await entry.interrupt(); } catch { /* 이미 끝난 턴 — 무시 */ }
  return true;
}
