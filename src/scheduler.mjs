// 루틴 스케줄러 — 첫 API 호출 시 1회 기동, 매분 전체 워크스페이스의 due 루틴을 실행.
// (nodejs 런타임 라우트에서만 로드되므로 node: 임포트가 안전하다. P1에서 워커로 분리)
import { listCompanies } from './hub.mjs';
import { loadRoutines, runRoutine, isDue } from './routines.mjs';
import { consolidateMemory, rollupJournals } from './consolidate.mjs';
import { daemonLease } from './lock.mjs';
import { isCloudLeader } from './sync.mjs';
import { writeJsonAtomic, readJson } from './jsonstore.mjs';
import { withLock } from './mutex.mjs';
import { paths } from './workspace.mjs';
import { join } from 'node:path';

const CONSOLIDATE_AT = '04:00'; // 새벽 정리 — 사람 뇌의 수면 정리처럼
// 하루 1회 실행 스탬프 — 정각(hhmm===) 일치는 그 1분에 기기가 수면·앱 종료면 그날 정리가 영영 스킵된다.
// "04:00 이후 첫 틱에 아직 오늘 안 돌았으면 실행"으로 캐치업한다(랩탑 현실 대응).
const RUN_STAMP = (wsId) => join(paths(wsId).vault, '.consolidate-run.json');

// 실행 직전 lastRun 선점(원자적 CAS) — 리더 교체·클라우드 리스 45s 지연으로 두 리더가 겹치는 창에서
// 같은 루틴을 각자 실행(이중 과금)하는 것을 막는다. withLock으로 같은 프로세스의 동시 클레임을 직렬화하고,
// 락 안에서 isDue를 재확인해 이미 이 분에 선점된 루틴이면 스킵한다. writeJsonAtomic으로 부분 쓰기 오염을 막는다.
// (기기 간 완전 상호배제는 sync.mjs의 클라우드 리스 CAS 몫 — 여기선 "실행 직전 lastRun 선점"으로 방어한다.)
async function claimRoutine(wsId, routineId, now) {
  return withLock(`routines:${wsId}`, async () => {
    const file = paths(wsId).routines;
    let routines;
    try {
      routines = await readJson(file, []); // 손상 시 throw → 아래서 스킵(빈 배열로 덮어써 루틴을 지우지 않는다)
    } catch {
      return false; // 부재/손상 — 이번 주기 스킵, 다음 주기 재시도
    }
    const r = routines.find((x) => x.id === routineId);
    if (!r || !isDue(r, now)) return false; // 락 안 재확인 — 다른 워커가 이미 lastRun을 선점했으면 isDue=false
    r.lastRun = now.toISOString(); // 선점 마킹 — 경쟁 워커가 이 파일을 다시 읽으면 isDue=false로 걸러진다
    await writeJsonAtomic(file, routines);
    return true;
  });
}

export function ensureScheduler() {
  if (globalThis.__argoScheduler) return;
  globalThis.__argoScheduler = true;
  const lease = daemonLease('scheduler'); // Next 멀티 워커에서도 실행 주체는 하나만
  console.log('[argo] 루틴 스케줄러 시작 (60s 폴)');
  setInterval(async () => {
    if (!lease.isLeader() || !isCloudLeader()) return; // 루틴도 기기 간 단일 실행
    try {
      const companies = await listCompanies();
      const now = new Date();
      const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      for (const c of companies) {
        for (const r of await loadRoutines(c.id)) {
          if (!isDue(r, now)) continue;
          // 실행 직전 lastRun을 원자적으로 선점 — 실패(이미 이 주기에 실행됨)면 스킵해 이중 실행을 막는다
          if (!(await claimRoutine(c.id, r.id, now))) continue;
          console.log(`[argo] 루틴 실행: ${c.id}/${r.title}`);
          runRoutine(c.id, r.id).catch((e) => console.error(`[argo] 루틴 실패 ${r.id}:`, e.message));
        }
        if (hhmm >= CONSOLIDATE_AT) {
          const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
          let st = { day: '' };
          try { st = await readJson(RUN_STAMP(c.id), { day: '' }); } catch { /* 부재/손상 — 오늘 미실행으로 간주 */ }
          if ((st.day ?? '') < today) {
            await writeJsonAtomic(RUN_STAMP(c.id), { day: today }); // 실행 전 선점 — 리더 겹침 창 이중 실행 방지(claimRoutine과 동일 원칙)
            console.log(`[argo] 기억 정리: ${c.id}`);
            consolidateMemory(c.id)
              .then(() => rollupJournals(c.id)) // 정제가 소화한 일지만 주간으로 접힌다
              .catch((e) => console.error(`[argo] 기억 정리 실패 ${c.id}:`, e.message));
          }
        }
      }
    } catch (e) {
      console.error('[argo] 스케줄러 오류:', e.message);
    }
  }, 60_000);
}
