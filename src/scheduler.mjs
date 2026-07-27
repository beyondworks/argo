// 루틴 스케줄러 — 첫 API 호출 시 1회 기동, 매분 전체 워크스페이스의 due 루틴을 실행.
// (nodejs 런타임 라우트에서만 로드되므로 node: 임포트가 안전하다. P1에서 워커로 분리)
import { listCompanies } from './hub.mjs';
import { loadRoutines, runRoutine, isDue } from './routines.mjs';
import { deliverCrewMail, mailPrompt } from './crewmail.mjs';
import { chat } from './chat.mjs';
import { appendTurn } from './thread.mjs';
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

// 재시도 정책 — 일시적 실패(요청 한도 429·네트워크·LLM JSON 파싱)로 그날 정리가 통째로 날아가던 것을
// 유계 재시도로 회수한다. 무계 재시도는 금지: 워터마크가 성공 후에만 전진하므로 영속적 실패(러너
// 미연결·잔액 0)는 같은 입력으로 같은 실패를 반복한다 — 상한 없이 되돌리면 60초 폴마다 무한
// 재시도가 된다(2026-07-27 검수에서 실증돼 철회한 설계). 상한 4회 + 지수 백오프로 하루 최대
// 3회 재시도, 그 뒤엔 오늘을 포기하고 내일 새 스탬프로 재개한다.
export const CONSOLIDATE_RETRY_MS = [5, 20, 60].map((m) => m * 60_000); // 1·2·3차 실패 후 대기
export const CONSOLIDATE_MAX_ATTEMPTS = CONSOLIDATE_RETRY_MS.length + 1;

/** 지금 기억 정리를 돌릴지 판정(순수) — 돌린다면 **선점으로 기록할 스탬프**, 아니면 null.
    핵심: 선점 시점에 nextRetryAt을 미래로 써둔다. 그래서 실패해도 되돌릴 필요가 없고
    (스탬프는 하루 안에서 단조 전진), 겹친 리더가 그 스탬프를 읽으면 백오프 창에 걸려 스킵한다
    — claimRoutine의 "실행 직전 선점" 성질을 유지하면서 재시도만 얻는다.
    (export: 회귀 테스트용 — 스케줄러 콜백은 단위로 태울 수 없다) */
export function planConsolidate(st, nowMs, today) {
  const s = st ?? {};
  const day = s.day ?? '';
  // 미래 스탬프 — 하루 이내는 기기 간 시계 어긋남으로 보고 양보한다. 그보다 먼 미래는 오염이며,
  // 그대로 두면 정리가 영구 비활성화되고 스스로 못 빠져나온다 → 새 날처럼 재개한다.
  if (day > today) {
    const farFuture = new Date(nowMs + 2 * 86_400_000).toISOString().slice(0, 10);
    if (day <= farFuture) return null;
  }
  const attempt = (n) => ({
    day: today,
    attempts: n,
    // 마지막 시도엔 다음 예약이 없다 — 오늘은 여기서 종료(내일 새 날 분기로 재개)
    nextRetryAt: n < CONSOLIDATE_MAX_ATTEMPTS ? new Date(nowMs + CONSOLIDATE_RETRY_MS[n - 1]).toISOString() : null,
    done: false,
  });
  if (day !== today) return attempt(1);    // 새 날(또는 오염된 먼 미래) — 1차 시도
  if (s.done) return null;                 // 오늘 이미 성공
  const n = Math.min(CONSOLIDATE_MAX_ATTEMPTS, Math.max(0, Math.floor(Number(s.attempts) || 0))); // 오염(음수·소수·NaN) 흡수 — RETRY_MS 인덱스 이탈이 틱 전체를 죽인다
  if (n >= CONSOLIDATE_MAX_ATTEMPTS) return null;                 // 오늘 시도 소진
  if (s.nextRetryAt && nowMs < Date.parse(s.nextRetryAt)) return null; // 백오프 대기 중
  return attempt(n + 1);
}

/** 실행 직전 선점 — 락 안에서 읽고 판정하고 쓴다(claimRoutine과 같은 원칙). 반환 = 쓴 스탬프 또는 null. */
export async function claimConsolidate(wsId, nowMs, today) { // export: 회귀 테스트용(스탬프 실제 기록 여부)
  return withLock(`consolidate:${wsId}`, async () => {
    let st = {};
    try { st = await readJson(RUN_STAMP(wsId), {}); } catch { /* 부재/손상 — 오늘 미실행으로 간주 */ }
    const next = planConsolidate(st, nowMs, today);
    if (!next) return null;
    await writeJsonAtomic(RUN_STAMP(wsId), next);
    return next;
  });
}

/** 성공 마킹 — CAS: 스탬프가 아직 오늘 것일 때만 쓴다. RUN_STAMP는 vault 안이라 기기 간 동기화
    대상이고, 자정을 넘겼거나 다른 기기가 새 날 스탬프를 올렸으면 덮어쓰면 안 된다.
    (기기 간 완전 상호배제는 sync의 리스 CAS 몫 — 여기선 마지막 쓰기의 오염만 막는다.) */
export async function markConsolidateDone(wsId, today) { // export: 회귀 테스트용(CAS·attempts 보존)
  return withLock(`consolidate:${wsId}`, async () => {
    let cur = {};
    try { cur = await readJson(RUN_STAMP(wsId), {}); } catch { return; }
    if ((cur.day ?? '') !== today) return;
    await writeJsonAtomic(RUN_STAMP(wsId), { ...cur, done: true, nextRetryAt: null });
  });
}

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

// 진행 중인 기억 정리 — SDK 경로엔 타임아웃이 없어 실행이 백오프(5분)를 넘길 수 있고, 그러면
// 다음 폴이 2차를 선점해 **같은 워크스페이스에서 동시 실행**된다(검수 2026-07-27 HIGH-2:
// consolidate·memory에 락이 없어 LLM 이중 호출·saveNote lost update·워터마크 경쟁). 이 프로세스
// 안의 겹침은 여기서 막고, 기기 간은 리스(isCloudLeader)가 담당한다.
const consolidating = new Set();

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
        // 크루 우편 배달 — 비동기 쪽지(send_to_crew)를 수신 크루의 새 턴으로. 회사당 틱 상한은
        // crewmail이 강제. 턴 결과는 delegate와 같은 문법으로 수신 크루 스레드에 남긴다(웹에서 보임).
        await deliverCrewMail(c.id, async (slug, msg, opts) => {
          const prompt = mailPrompt(msg);
          const t = await chat(c.id, slug, prompt, null, { from: opts.from, hop: opts.hop, chain: opts.chain, source: 'crewmail' });
          await appendTurn(c.id, slug, { userMsg: prompt, reply: t.reply, handover: t.handover, sessionId: null }).catch(() => {});
        }).catch((e) => console.error(`[argo] 크루 우편 배달 오류(${c.id}):`, e.message));
        if (hhmm >= CONSOLIDATE_AT) {
          const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
          // 진행 중이면 시도 횟수를 태우지 않고 그냥 넘긴다(선점 자체를 하지 않는다)
          const claimed = consolidating.has(c.id) ? null : await claimConsolidate(c.id, now.getTime(), today);
          if (claimed) {
            consolidating.add(c.id);
            const nth = `${claimed.attempts}/${CONSOLIDATE_MAX_ATTEMPTS}회차`;
            console.log(`[argo] 기억 정리: ${c.id} (${nth})`);
            // 재시도는 consolidate부터 다시 탄다 — 워터마크가 성공 후에만 전진하므로 이미 정제된
            // 구간은 조기 반환(LLM 호출 0)이고, rollup은 주간 블록 중복 append를 자체 차단한다.
            consolidateMemory(c.id)
              .then(() => rollupJournals(c.id)) // 정제가 소화한 일지만 주간으로 접힌다
              .then(() => markConsolidateDone(c.id, today))
              .catch((e) => console.error(
                `[argo] 기억 정리 실패 ${c.id} (${nth}, 다음 재시도 ${claimed.nextRetryAt ?? '없음 — 오늘은 종료'}):`, e.message))
              .finally(() => consolidating.delete(c.id));
          }
        }
      }
    } catch (e) {
      console.error('[argo] 스케줄러 오류:', e.message);
    }
  }, 60_000);
}
