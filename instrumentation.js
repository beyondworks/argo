// 서버 기동 = 회사 가동. UI를 한 번도 안 열어도 텔레그램 폴러·루틴 스케줄러가
// 부팅 즉시 상주한다 (이전에는 특정 API를 건드려야 지연 기동 — 24시간 상주의 구멍).
// 중복 기동은 각 ensure*의 globalThis 가드 + daemonLease 리더 선출이 막는다.
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { ensureScheduler } = await import('./src/scheduler.mjs');
  const { ensureGateway } = await import('./src/gateway.mjs');
  ensureScheduler();
  ensureGateway();
}
