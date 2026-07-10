// 루틴 스케줄러 — 첫 API 호출 시 1회 기동, 매분 전체 워크스페이스의 due 루틴을 실행.
// (nodejs 런타임 라우트에서만 로드되므로 node: 임포트가 안전하다. P1에서 워커로 분리)
import { listCompanies } from './hub.mjs';
import { loadRoutines, runRoutine, isDue } from './routines.mjs';

export function ensureScheduler() {
  if (globalThis.__argoScheduler) return;
  globalThis.__argoScheduler = true;
  console.log('[argo] 루틴 스케줄러 시작 (60s 폴)');
  setInterval(async () => {
    try {
      const companies = await listCompanies();
      for (const c of companies) {
        for (const r of await loadRoutines(c.id)) {
          if (!isDue(r)) continue;
          console.log(`[argo] 루틴 실행: ${c.id}/${r.title}`);
          runRoutine(c.id, r.id).catch((e) => console.error(`[argo] 루틴 실패 ${r.id}:`, e.message));
        }
      }
    } catch (e) {
      console.error('[argo] 스케줄러 오류:', e.message);
    }
  }, 60_000);
}
