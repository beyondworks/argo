// 루틴 스케줄러 — 첫 API 호출 시 1회 기동, 매분 전체 워크스페이스의 due 루틴을 실행.
// (nodejs 런타임 라우트에서만 로드되므로 node: 임포트가 안전하다. P1에서 워커로 분리)
import { listCompanies } from './hub.mjs';
import { loadRoutines, runRoutine, isDue } from './routines.mjs';
import { consolidateMemory, rollupJournals } from './consolidate.mjs';
import { daemonLease } from './lock.mjs';

const CONSOLIDATE_AT = '04:00'; // 새벽 정리 — 사람 뇌의 수면 정리처럼

export function ensureScheduler() {
  if (globalThis.__argoScheduler) return;
  globalThis.__argoScheduler = true;
  const lease = daemonLease('scheduler'); // Next 멀티 워커에서도 실행 주체는 하나만
  console.log('[argo] 루틴 스케줄러 시작 (60s 폴)');
  setInterval(async () => {
    if (!lease.isLeader()) return;
    try {
      const companies = await listCompanies();
      const now = new Date();
      const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      for (const c of companies) {
        for (const r of await loadRoutines(c.id)) {
          if (!isDue(r)) continue;
          console.log(`[argo] 루틴 실행: ${c.id}/${r.title}`);
          runRoutine(c.id, r.id).catch((e) => console.error(`[argo] 루틴 실패 ${r.id}:`, e.message));
        }
        if (hhmm === CONSOLIDATE_AT) {
          console.log(`[argo] 기억 정리: ${c.id}`);
          consolidateMemory(c.id)
            .then(() => rollupJournals(c.id)) // 정제가 소화한 일지만 주간으로 접힌다
            .catch((e) => console.error(`[argo] 기억 정리 실패 ${c.id}:`, e.message));
        }
      }
    } catch (e) {
      console.error('[argo] 스케줄러 오류:', e.message);
    }
  }, 60_000);
}
