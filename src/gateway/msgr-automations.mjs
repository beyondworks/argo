// Scheduling only publishes an authorized channel command. Existing Messenger workers
// retain execution ownership, approval checks and result delivery.
//
// 회사별 60초 제한(2026-10-16 로그 수집 과금: 하루 6.4만 건) — 서버 크론(scripts/sql/msgr-automation-scheduler.sql)이 매분 같은 일을 하고 일정 최소 단위가
// 5분/HH:MM이라, 기기 쪽 예비 호출은 15초 틱마다 부를 이유가 없다. 실패(오류·옛 DB)도 같은 간격으로 쉰다(요청 예산).
export const AUTOMATION_DISPATCH_MIN_MS = 60_000;
const lastDispatch = new Map(); // wsId → 마지막 호출 시각(프로세스 메모리 — 재시작하면 첫 틱에 한 번 부른다)
export async function dispatchMessengerAutomations(client, wsId, { now = Date.now } = {}) {
  const t = now();
  const prev = lastDispatch.get(wsId);
  if (prev !== undefined && t - prev < AUTOMATION_DISPATCH_MIN_MS) return { available: true, runs: [], skipped: true };
  lastDispatch.set(wsId, t);
  while (lastDispatch.size > 1000) lastDispatch.delete(lastDispatch.keys().next().value); // 회사 수 상한
  const { data, error } = await client.rpc('msgr_automation_dispatch_due', { p_ws: wsId });
  // Rolling upgrades: an older database must not stop ordinary message delivery.
  if (error?.code === 'PGRST202' || error?.code === '42883') return { available: false, runs: [] };
  if (error) throw new Error(`msgr automation: ${error.message}`);
  return { available: true, runs: Array.isArray(data) ? data : [] };
}
