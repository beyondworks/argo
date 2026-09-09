// 지시 처리 디스크 큐(at-least-once) + 장시간 작업 큐(jobs) 적재 — gateway.mjs 분해.
// 파일 I/O·1초 워커 타이머만 있어 네트워크·텔레그램 없이 임시 ARGO_ROOT로 단위 테스트 가능한 이음매.
// 잡 실행 핸들러(makeTgGatewayHandler·makeJobHandler 등)는 네트워크·chat 의존이라 gateway.mjs에 남는다.
// 옮긴 코드는 gateway.mjs 원문 그대로(행동 불변) — 설계 주석 동반 이동.
import { readdir, rename, stat, unlink, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { paths, getDeviceId } from '../workspace.mjs';
import { writeJsonAtomic, readJsonLenient } from '../jsonstore.mjs';

/* ─── 지시 처리 큐 (at-least-once) ───
   문제(감사 D5): 텔레그램 폴러가 offset을 처리 for-루프 '앞'에서 커밋하고, 실제 턴(runWithAtts/run)은
   await 없는 fire-and-forget이라 offset 저장 후 크래시 시 그 지시가 재수신·재처리 안 되고 영구 유실(at-most-once).

   처방(디스크 큐): 폴 루프는 update를 디스크 큐에 '적재한 직후'에만 offset을 전진시킨다(=Telegram에 수신 확정).
   별도 워커가 큐를 드레인해 턴을 실행하고 '성공적으로 끝난 뒤에만' 파일을 삭제한다. 처리 도중 크래시면
   파일이 남아 재기동 시 재처리된다. 파일명 = update_id라 재수신 시 재적재가 멱등(중복 큐 항목 없음).
   트레이드오프: 응답 전송 후 unlink 전에 크래시하면 재기동 때 같은 지시를 한 번 더 처리(중복 응답 가능).
   at-most-once(유실)보다 at-least-once(중복)를 택한다 — 지시 유실이 훨씬 치명적이다.
   블로킹 회피: 폴 루프는 '빠른 디스크 적재'만 await하고 긴 턴은 워커가 뒤에서 돌리므로, 결재 버튼 콜백을
   막지 않는다(권한 게이트 데드락 방지 — 기존 논블로킹 성질 보존).

   소유권(백로그: 리더 전환 시 큐잉 지시 멈춤): 워커는 폴러가 아니라 매니저(ensureGateway)가 소유하고
   클라우드 리더 여부와 무관하게 상시 돈다 — 리더를 양보한(또는 죽었다 살아난) 기기에 남은 잡도 그 기기가
   끝까지 처리한다. 잡은 적재한 기기에만 있고(큐는 동기화 제외) dev 태그로 그 사실을 강제해,
   과거 동기화로 흘러든 다른 기기의 잡 사본이 이중 실행되는 것을 막는다. */
const GW_MAX_INFLIGHT = 2; // 동시 크루 턴 상한 — 큐가 쌓여도 비용 폭주를 막는다
const LEGACY_JOB_MAX_AGE_MS = 24 * 3_600_000; // dev 태그 없는 구형식 잡의 실행 허용 연령 — 넘으면 좀비 실행 방지 위해 폐기
export const CLAIM_MAX_AGE_MS = 35 * 60_000; // 선점(.claimed) 최대 연령 — 턴 상한(30분)보다 길게. 넘으면 죽은 워커의 잔재로 보고 되돌린다(재실행 = at-least-once 유지)
export function queueDir(wsId, key) { return join(paths(wsId).root, `.gw-queue-${key}`); } // (export: 회귀 테스트용)
export async function enqueueJob(wsId, key, id, job) { // (export: 회귀 테스트용)
  const dev = await getDeviceId().catch(() => null); // 적재 기기 태그 — 이 기기의 워커만 이 잡을 실행한다
  await writeJsonAtomic(join(queueDir(wsId, key), `${id}.json`), dev ? { ...job, dev } : job); // 원자적 — 부분 쓰기가 워커에 보이지 않는다
}
/** 큐 드레인 워커 — 1초 폴. handler(job)이 정상 반환하면 파일 삭제(처리 완료), 던지면 유지(다음 틱 재시도·재기동 복구). (export: 회귀 테스트용) */
/** 핸들러가 이 값을 반환하면 "아직 차례가 아니다" — 선점을 풀어 다음 틱에 다시 집는다(로그 없음, 슬롯 점유 없음). 순서 대기(msgr after)용. */
export const DEFER = Symbol('queue.defer');
export const DEFER_BACKOFF_MS = 3000; // DEFER 잡의 재검사 간격(순서 대기의 DB 조회 = 잡당 3초에 한 번)
export function startQueueWorker(wsId, key, handler, { maxInflight = GW_MAX_INFLIGHT } = {}) {
  let stopped = false;
  let me = null; // 이 기기 id — 해석 전(null)에는 잡을 집지 않는다(남의 사본 오실행 방지). 실패 시 ''(판정 생략, 전부 실행)
  getDeviceId().then((d) => { me = d; }).catch(() => { me = ''; });
  const busy = new Set();
  const deferUntil = new Map(); // DEFER 반환 잡 → 다음 검사 시각. 백오프 동안은 스캔에서 빠지고, 검사 차례도 일반 잡 뒤로(슬롯 굶김 방지 — 검수 2R M-5)
  const iv = setInterval(async () => {
    if (stopped || me === null) return;
    let names = [];
    try { names = await readdir(queueDir(wsId, key)); } catch { return; } // 큐 디렉터리 없음 — 할 일 없음
    // 죽은 워커의 선점 잔재 회수 — .claimed가 CLAIM_MAX_AGE_MS를 넘으면 .json으로 되돌려 다음 틱에 재실행
    for (const n of names.filter((x) => x.endsWith('.json.claimed'))) {
      const fp = join(queueDir(wsId, key), n); const mt = (await stat(fp).catch(() => null))?.mtimeMs ?? 0;
      if (mt && Date.now() - mt > CLAIM_MAX_AGE_MS) { await rename(fp, fp.replace(/\.claimed$/, '')).catch(() => {}); console.log(`[argo] 큐 선점 회수(${wsId}/${key}/${n}): ${Math.round(CLAIM_MAX_AGE_MS / 60_000)}분 넘은 선점 — 재실행`); }
    }
    const tick = Date.now();
    const due = new Set(); // 백오프가 끝난 DEFER 잡 — 이번 틱 검사 차례는 일반 잡 뒤
    for (const [n, t] of deferUntil) if (t <= tick) { due.add(n); deferUntil.delete(n); }
    names = names.filter((n) => n.endsWith('.json') && !n.startsWith('.'))
      .sort((a, b) => ((parseInt(a, 10) || 0) - (parseInt(b, 10) || 0)) || a.localeCompare(b)); // 도착 순서 근사(동값은 사전순 고정)
    names = [...names.filter((n) => !deferUntil.has(n) && !due.has(n)), ...names.filter((n) => due.has(n))]; // 백오프 중인 잡은 제외, 검사 차례는 맨 뒤
    for (const n of names) {
      if (busy.has(n)) continue;
      if (busy.size >= maxInflight) break; // 상한 도달 — 남은 잡은 다음 틱(큐별로 다르다: 장시간 작업은 1)
      busy.add(n);
      (async () => {
        const fp0 = join(queueDir(wsId, key), n);
        // 선점 — 같은 큐 폴더를 보는 워커가 둘이면(상주 서버 + 같은 워크스페이스의 개발 서버) 한쪽이 처리하는 동안 다른 쪽이 같은 파일을 집어
        // 같은 멘션이 두 번(유료 턴 ×2, 두 번째 답글은 멱등 키로 버려지고 '입력 중'만 남는다 — 실사고 2026-09-09 페퍼 50s+124s). rename은 원자적이라 한쪽만 이긴다.
        const fp = `${fp0}.claimed`;
        try { await rename(fp0, fp); } catch { busy.delete(n); return; } // 이미 다른 워커가 선점(ENOENT) — 조용히 물러난다
        let done = false;
        const hb = setInterval(() => { const t = new Date(); utimes(fp, t, t).catch(() => {}); }, 60_000); hb.unref?.(); // 선점 심박 — 살아 있는 긴 턴(30분 넘는 사고 과정·장시간 잡)이 CLAIM_MAX_AGE_MS 회수에 걸리지 않게
        try {
          const job = await readJsonLenient(fp, null); // 손상 잡은 null → 처리 스킵 후 삭제(무한 재시도 방지)
          if (job?.dev && me && job.dev !== me) {
            // 다른 기기가 적재한 잡의 사본(과거 큐가 동기화되던 시절의 잔재) — 원 기기가 실행하므로 정리만
            console.log(`[argo] 큐 정리(${wsId}/${key}/${n}): 다른 기기(${String(job.dev).slice(0, 8)})의 잡 사본 — 실행 없이 제거`);
          } else if (job && !job.dev && Date.now() - (((await stat(fp).catch(() => null))?.mtimeMs) ?? 0) > LEGACY_JOB_MAX_AGE_MS) {
            // dev 태그 없는 구형식 잡이 너무 오래됨 — 어느 기기 것인지 알 수 없어 좀비 실행 대신 폐기(로그로 관측)
            console.log(`[argo] 큐 정리(${wsId}/${key}/${n}): ${Math.round(LEGACY_JOB_MAX_AGE_MS / 3_600_000)}시간 넘은 구형식 잡 — 실행 없이 제거`);
          } else if (job) {
            if (await handler(job, { path: fp }) === DEFER) { deferUntil.set(n, Date.now() + DEFER_BACKOFF_MS); return; } // 차례 아님 — finally가 선점을 풀고 백오프 뒤 다시 집는다. path = 선점 뒤 실제 파일(장시간 잡 tries 마커가 원래 이름에 쓰이던 회귀 방지)
          }
          done = true;
          await unlink(fp).catch(() => {}); // 처리 완료분만 제거. 처리 중 크래시면 .claimed가 남아 CLAIM_MAX_AGE_MS 뒤 회수·재처리
        } catch (e) {
          console.error(`[argo] 큐 처리 실패(${wsId}/${key}/${n}):`, e.message); // 인프라 예외 — 선점을 풀어 다음 틱 재시도
        } finally {
          clearInterval(hb);
          if (!done) await rename(fp, fp0).catch(() => {});
          busy.delete(n);
        }
      })();
    }
  }, 1000);
  iv.unref?.();
  return () => { stopped = true; clearInterval(iv); };
}

/* ─── 장시간 작업 큐(jobs) — 10분 초과 작업의 패리티 갭을 닫는다 ───
   설계: docs/long-job-queue-design.md. 크루가 start_long_task로 적재하면 이 워커가 턴 밖에서
   chat()을 끝까지 돌린다(워커 경로엔 HTTP 5분 상한이 없어 몇 시간도 가능). 완료되면 결과가 대화에
   남고 메신저로 배달된다 — 사장은 기다리지 않고, 기기를 덮어도(재기동 후) 결과를 받는다.

   재실행 규칙(게이트웨이 큐와 다른 점): 잡에는 발송·구매 같은 부작용이 들어갈 수 있어 크래시 후
   무제한 재시도가 위험하다. 실행 직전에 tries를 올려 파일에 기록하고, 다시 집혔을 때 tries>=1이면
   **자동 재실행하지 않고** "중단된 작업"으로 남겨 사장이 재시작을 결정한다
   ("되돌릴 수 없는 것은 사람이 잠근다"와 같은 방향). 실행 핸들러(makeJobHandler)는 gateway.mjs. */
export const JOBS_QUEUE = 'jobs';
export const JOBS_MAX_INFLIGHT = 1;  // 회사당 동시 1 — 장시간 작업이 메신저 응답을 굶기지 않게 큐 분리
export const JOBS_MAX_PENDING = 10;  // 대기 상한 — 비용 폭주·큐 폭발 방지

/** 크루 도구용 적재 — 대기 상한을 넘으면 거절(에러 메시지가 크루에게 그대로 간다). (export: 도구·테스트 공용) */
export async function enqueueLongJob(wsId, { slug, title, prompt }) {
  let pending = 0;
  try { pending = (await readdir(queueDir(wsId, JOBS_QUEUE))).filter((n) => n.endsWith('.json')).length; } catch { /* 큐 없음 = 0 */ }
  if (pending >= JOBS_MAX_PENDING) throw new Error(`대기 중인 장시간 작업이 이미 ${pending}건입니다 — 끝나기를 기다리거나 사장에게 정리를 요청하라`);
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  await enqueueJob(wsId, JOBS_QUEUE, id, { id, slug, title, prompt, createdAt: new Date().toISOString(), tries: 0 });
  return { id, pending: pending + 1 };
}
