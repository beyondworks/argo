// 지시 처리 디스크 큐(at-least-once) + 장시간 작업 큐(jobs) 적재 — gateway.mjs 분해.
// 파일 I/O·1초 워커 타이머만 있어 네트워크·텔레그램 없이 임시 ARGO_ROOT로 단위 테스트 가능한 이음매.
// 잡 실행 핸들러(makeTgGatewayHandler·makeJobHandler 등)는 네트워크·chat 의존이라 gateway.mjs에 남는다.
// 옮긴 코드는 gateway.mjs 원문 그대로(행동 불변) — 설계 주석 동반 이동.
import { readdir, rename, stat, unlink, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { paths, getDeviceId } from '../workspace.mjs';
import { writeJsonAtomic, readJsonLenient } from '../jsonstore.mjs';
import { withDirLock } from '../mutex.mjs';

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
export const CLAIM_MAX_AGE_MS = 5 * 60_000; // 선점(.claimed) 최대 연령 — 살아 있는 선점은 60초 심박으로 mtime이 늘 신선하므로 5분이면 충분(35분이던 때는 재기동 뒤 진행 중이던 잡이 35분 침묵 — 검수 5R). 넘으면 죽은 워커의 잔재로 보고 되돌린다(재실행 = at-least-once)
export function queueDir(wsId, key) { return join(paths(wsId).root, `.gw-queue-${key}`); } // (export: 회귀 테스트용)
export async function enqueueJob(wsId, key, id, job) { // (export: 회귀 테스트용)
  const dev = await getDeviceId().catch(() => null); // 적재 기기 태그 — 이 기기의 워커만 이 잡을 실행한다
  await writeJsonAtomic(join(queueDir(wsId, key), `${id}.json`), dev ? { ...job, dev } : job); // 원자적 — 부분 쓰기가 워커에 보이지 않는다
}
/** 큐 드레인 워커 — 1초 폴. handler(job)이 정상 반환하면 파일 삭제(처리 완료), 던지면 유지(다음 틱 재시도·재기동 복구). (export: 회귀 테스트용) */
/** 핸들러가 이 값을 반환하면 "아직 차례가 아니다" — 선점을 풀어 다음 틱에 다시 집는다(로그 없음, 슬롯 점유 없음). 순서 대기(msgr after)용. */
export const DEFER = Symbol('queue.defer');
export const DEFER_BACKOFF_MS = 3000; // DEFER 잡의 재검사 간격(순서 대기의 DB 조회 = 잡당 3초에 한 번)
/* ─── 실패 분류(F1, 2026-10-05) — 영구 오류를 1초마다 끝없이 재시도하던 결함 ───
   영구 = 다시 해도 같은 결과가 나오는 오류: Postgres SQLSTATE 22(데이터 형식 — uuid 형변환 22P02 등)·23(제약 위반)·
   42(문법·권한 — RLS 42501), PostgREST 요청 오류(PGRST1xx·PGRST2xx), 명시 표지(e.permanent).
   일시 = 그 밖 전부(연결 PGRST0xx·JWT PGRST3xx·직렬화·교착·시간 초과·코드 없음) — 지우지 않고 지수 간격으로 재시도한다.
   스키마 어긋남(H1, 2026-10-05) = PGRST202·204·205(함수·열·표 없음)·42883·42703·42P01 — 앱이 라이브 마이그레이션보다 먼저 나간 동안의 오류라
   마이그레이션이 적용되면 같은 잡이 성공한다. 저장소의 다른 곳(msgr.mjs·msgr-routines.mjs·msgr-work.mjs)도 이 코드를 '옛 서버'로 본다.
   그래서 영구가 아니라 일시처럼 기다리되(5분 상한 간격), 무한 대기가 되지 않게 잡 나이가 SCHEMA_SKEW_MAX_AGE_MS를 넘으면 버린다(onAbandon 안내).
   영구 오류 잡은 큐 폴더 안 `<이름>.failed`로 남긴다(큐 폴더는 동기화 제외 — sync.mjs isExcluded). 보존 7일·최대 50건. */
const SCHEMA_SKEW_CODES = new Set(['PGRST202', 'PGRST204', 'PGRST205', '42883', '42703', '42P01']);
export const SCHEMA_SKEW_MAX_AGE_MS = 24 * 3_600_000; // 메신저 STALE_MS(24시간 넘게 기다린 지시는 실행하지 않고 다시 지시를 안내)와 같은 기준
export function isSchemaSkewError(e) {
  return !!e && e.permanent !== true && SCHEMA_SKEW_CODES.has(e.code);
}
export function isPermanentQueueError(e) {
  if (!e) return false;
  if (e.permanent === true) return true;
  if (isSchemaSkewError(e)) return false;
  const code = typeof e.code === 'string' ? e.code : '';
  return /^(22|23|42)[0-9A-Z]{3}$/.test(code) || /^PGRST[12]\d\d$/.test(code);
}
export const QUEUE_RETRY_MAX_MS = 5 * 60_000;
/** n번째 연속 실패 뒤 다음 시도까지 — 1초(다음 틱)부터 두 배씩, 5분 상한. 프로세스 메모리 값이라 재시작하면 처음부터. baseMs는 테스트가 줄이거나 늘린다. */
export function queueRetryDelayMs(failures, baseMs = 1000) {
  return Math.min(QUEUE_RETRY_MAX_MS, baseMs * 2 ** Math.max(0, Math.min(20, failures - 1)));
}
export const RECOVERY_RESET_MIN_MS = 60_000; // 복구 신호로 대기 중인 잡의 간격을 푸는 최소 주기(워커당) — 계속 실패하는 잡이 성공하는 잡 옆에서 매 틱 재시도되지 않게
export const SCHEMA_SKEW_NOTICE_AFTER_MS = 10 * 60_000; // 스키마 어긋남으로 이만큼 막힌 잡은 보낸 사람에게 "늦어지고 있다"고 한 번 알린다(onStalled) — 24시간 상한까지 아무 표시도 없던 것(2차 검수 LOW-3)
export const NOTICE_RETRY_MAX = 5; // 안내 미전송 기록 하나당 다시 보내는 시도 상한 — 계속 실패하는 안내가 영원히 호출을 만들지 않게(DB 위생)
const FAILED_KEEP_MS = 7 * 86_400_000;
const FAILED_KEEP_MAX = 50;
/** `.failed` 보존 정리 — 실패 기록이 쌓이기만 하지 않게(DB 위생 규칙 4와 같은 원칙의 로컬판). 실패가 날 때와 워커가 시작할 때 돈다(새 주기 작업 없음). */
async function pruneFailedJobs(dir) {
  try {
    const now = Date.now();
    const recs = [];
    for (const f of (await readdir(dir)).filter((x) => x.endsWith('.failed'))) {
      const mt = (await stat(join(dir, f)).catch(() => null))?.mtimeMs ?? 0;
      recs.push([f, mt]);
    }
    recs.sort((a, b) => b[1] - a[1]);
    for (const [i, [f, mt]] of recs.entries()) if (i >= FAILED_KEEP_MAX || now - mt > FAILED_KEEP_MS) await unlink(join(dir, f)).catch(() => {});
  } catch { /* 정리 실패는 다음 실패·다음 시작 때 다시 */ }
}
async function recordFailedJob(dir, n, fp, e, reason, noticePending) {
  const job = await readJsonLenient(fp, null);
  // noticePending = 안내 훅이 있어 아직 못 보냈다(보낸 뒤 꺼진다) — 기록을 먼저 쓰므로 안내 전에 죽어도 다음 시작 때 다시 보낸다(LOW-4)
  await writeJsonAtomic(join(dir, `${n}.failed`), { failedAt: new Date().toISOString(), code: e?.code ?? null, reason, error: String(e?.message ?? e).slice(0, 500), job, noticePending: !!noticePending, noticeTries: 0 });
  await pruneFailedJobs(dir);
}
/** 안내 결과를 .failed에 반영 — 보냈으면 표지를 끄고, 못 보냈으면 시도 수를 올린다(NOTICE_RETRY_MAX에 닿으면 포기 표지). */
async function settleNotice(dir, n, delivered) {
  const fp = join(dir, `${n}.failed`);
  const r = await readJsonLenient(fp, null);
  if (!r) return;
  const tries = (r.noticeTries ?? 0) + (delivered ? 0 : 1);
  const gaveUp = !delivered && tries >= NOTICE_RETRY_MAX;
  await writeJsonAtomic(fp, { ...r, noticePending: !delivered && !gaveUp, noticeTries: tries, ...(delivered ? { noticeSentAt: new Date().toISOString() } : {}), ...(gaveUp ? { noticeGaveUp: true } : {}) }).catch(() => {});
}
/** 안내 미전송(.failed의 noticePending) 기록을 다시 보낸다 — 워커 시작 때와 다음 성공 처리 때(60초에 한 번). 안내 키가 멱등이라 이미 들어간 것은 DB가 걸러 중복이 없다.
    반환 = 아직 미전송으로 남은 기록 수(0이면 더 볼 것이 없다). */
async function retryPendingNotices(dir, onAbandon, where) {
  let files = [];
  try { files = (await readdir(dir)).filter((f) => f.endsWith('.failed')); } catch { return 0; }
  let left = 0;
  for (const f of files) {
    const r = await readJsonLenient(join(dir, f), null);
    if (!r?.noticePending || !r.job) continue;
    if ((r.noticeTries ?? 0) >= NOTICE_RETRY_MAX) continue;
    const n = f.slice(0, -'.failed'.length);
    const e = Object.assign(new Error(r.error ?? ''), r.code ? { code: r.code } : {});
    const delivered = await callHook(onAbandon, r.job, e, { name: n, reason: r.reason ?? 'permanent', retry: true }, where);
    await settleNotice(dir, n, delivered);
    if (!delivered) left += 1;
  }
  return left;
}
const NOTICE_HOOK_TIMEOUT_MS = 15_000;
/** 안내 훅(onAbandon·onStalled) 호출 — 던지거나 멈춰도 큐는 계속 돈다(실패 = 로그만, 슬롯은 시간 상한까지만 점유). 반환 true = 보냈다(또는 보낼 것이 없다), false = 못 보냈다(던짐·시간 초과·훅이 false 반환). */
async function callHook(hook, job, e, info, where) {
  if (typeof hook !== 'function' || !job) return true;
  let timer;
  try {
    const r = await Promise.race([hook(job, e, info), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('안내 시간 초과')), NOTICE_HOOK_TIMEOUT_MS); timer.unref?.(); })]);
    return r !== false;
  } catch (x) {
    console.error(`[argo] 큐 안내를 남기지 못했습니다(${where}/${info.name}):`, x?.message ?? x);
    return false;
  } finally { clearTimeout(timer); }
}

/** 옵션 — maxInflight: 동시 처리 상한. onAbandon(job, e, { name, reason, retry? }): 큐가 잡을 버릴 때(영구 오류 'permanent'·스키마 어긋남 나이 상한 'schema-age') 불리는
    안내 훅(예: 메신저 채널에 실패 안내). 던져도 큐는 멈추지 않는다. false를 돌려주면(또는 던지면) 안내 미전송으로 .failed에 남겨 워커 시작 때·다음 성공 처리 때 다시 부른다(retry: true).
    onStalled(job, e, { name, stalledMs }): 스키마 어긋남으로 stalledAfterMs(기본 10분) 넘게 막힌 잡에 대해 — 보낸 사람에게 "늦어지고 있다"고 알리는 훅. 잡은 큐에 그대로 남는다.
    retryBaseMs: 일시 오류 재시도 첫 간격(기본 1초). 둘 다 테스트가 바꾼다. */
export function startQueueWorker(wsId, key, handler, { maxInflight = GW_MAX_INFLIGHT, onAbandon = null, onStalled = null, retryBaseMs = 1000, stalledAfterMs = SCHEMA_SKEW_NOTICE_AFTER_MS } = {}) {
  let stopped = false;
  const dirQ = queueDir(wsId, key);
  const where = `${wsId}/${key}`;
  const failures = new Map(); // 잡 이름 → 연속 일시 실패 수(성공·영구 실패면 지운다. DEFER는 지우지 않는다 — 아래 DEFER 경로 주석)
  const retryAt = new Map();  // 잡 이름 → 다음 시도 시각(지수 간격)
  const firstFail = new Map(); // 잡 이름 → 첫 일시 실패 시각 — 스키마 어긋남 나이(createdAt 없는 잡)·10분 지연 안내의 기준(프로세스 메모리)
  const skewBlocked = new Set(); // 마지막 오류가 스키마 어긋남인 잡 — 마이그레이션을 기다리는 것이지 연결이 막힌 것이 아니라 복구 신호로 풀지 않는다
  const stalledNotified = new Set(); // 10분 지연 안내를 보낸 잡(프로세스당 한 번 — 재시작하면 한 번 더 불리지만 안내 키가 멱등이라 채널엔 한 줄)
  const forget = (n) => { failures.delete(n); retryAt.delete(n); firstFail.delete(n); skewBlocked.delete(n); stalledNotified.delete(n); };
  let lastRecoveryAt = 0;
  /** 핸들러가 DEFER 아닌 정상 반환을 했다 = 연결이 살아 있다 → 간격을 기다리던 잡들을 다음 틱에 다시 시도시킨다(장애가 8분을 넘으면 간격이 5분 상한이라 복구 뒤 최대 5분 늦던 것, L5).
      DEFER는 신호가 아니다 — msgr.mjs busyCrew DEFER는 DB 왕복 없이 돌아온다(2차 검수 MEDIUM-1: DEFER 하나로 5분 간격이 60초마다 풀렸다).
      마지막 오류가 스키마 어긋남인 잡도 풀지 않는다(위 skewBlocked). 실패 횟수는 그대로 둔다(계속 실패하는 잡의 간격은 다시 1초부터 시작하지 않는다)·워커당 RECOVERY_RESET_MIN_MS에 한 번(DB 위생). */
  const noteRecovered = () => {
    const free = [...retryAt.keys()].filter((n) => !skewBlocked.has(n));
    if (!free.length) return;
    const t = Date.now(); if (t - lastRecoveryAt < RECOVERY_RESET_MIN_MS) return;
    lastRecoveryAt = t; for (const n of free) retryAt.delete(n);
  };
  // 안내 미전송(.failed noticePending) 재전송 — 시작 때 한 번, 그 뒤엔 정상 처리 뒤 60초에 한 번(세션이 늦게 생기는 경우). 보낼 것이 없으면 디스크를 다시 읽지 않는다.
  let noticesLeft = false; let noticeRetrying = false; let lastNoticeRetryAt = 0;
  const retryNotices = async () => {
    if (!onAbandon || noticeRetrying || stopped) return;
    noticeRetrying = true;
    try { noticesLeft = (await retryPendingNotices(dirQ, onAbandon, where)) > 0; } finally { noticeRetrying = false; }
  };
  const noteHandled = () => { // 핸들러 정상 반환(DEFER 제외) — 복구 신호 + 안내 재전송 기회
    noteRecovered();
    if (noticesLeft && Date.now() - lastNoticeRetryAt >= RECOVERY_RESET_MIN_MS) { lastNoticeRetryAt = Date.now(); retryNotices().catch(() => {}); }
  };
  pruneFailedJobs(dirQ).then(() => { noticesLeft = !!onAbandon; return retryNotices(); }).catch(() => {}); // 시작 때 한 번 — 실패가 더 없어도 7일·50건 상한이 지켜진다(L4)·미전송 안내를 다시 보낸다(LOW-4). 내부에서 오류를 삼킨다
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
      if (busy.has(n.replace(/\.claimed$/, ''))) continue; // 이 워커가 지금 돌리는 잡 — 회수 대상 아님(검수 4R C-1)
      const fp = join(queueDir(wsId, key), n); const fp0 = fp.replace(/\.claimed$/, '');
      await withDirLock(`${fp0}.lock`, async () => {
        const mt = (await stat(fp).catch(() => null))?.mtimeMs ?? 0;
        if (mt && Date.now() - mt > CLAIM_MAX_AGE_MS) {
          await rename(fp, fp0);
          console.log(`[argo] 큐 선점 회수(${wsId}/${key}/${n}): ${Math.round(CLAIM_MAX_AGE_MS / 60_000)}분 넘은 선점 — 재실행`);
        }
      }).catch(() => {});
    }
    const tick = Date.now();
    const due = new Set(); // 백오프가 끝난 DEFER 잡 — 이번 틱 검사 차례는 일반 잡 뒤
    for (const [n, t] of deferUntil) if (t <= tick) { due.add(n); deferUntil.delete(n); }
    names = names.filter((n) => n.endsWith('.json') && !n.startsWith('.'))
      .sort((a, b) => ((parseInt(a, 10) || 0) - (parseInt(b, 10) || 0)) || a.localeCompare(b)); // 도착 순서 근사(동값은 사전순 고정)
    names = [...names.filter((n) => !deferUntil.has(n) && !due.has(n)), ...names.filter((n) => due.has(n))]; // 백오프 중인 잡은 제외, 검사 차례는 맨 뒤
    names = names.filter((n) => !(retryAt.get(n) > tick)); // 일시 실패 뒤 간격이 안 지난 잡은 이번 틱에서 뺀다
    for (const n of names) {
      if (busy.has(n)) continue;
      if (busy.size >= maxInflight) break; // 상한 도달 — 남은 잡은 다음 틱(큐별로 다르다: 장시간 작업은 1)
      busy.add(n);
      (async () => {
        const fp0 = join(queueDir(wsId, key), n);
        // rename은 POSIX에서 기존 선점을 덮는다. 동일 ID 재적재가 활성 턴을 침범하지 않도록
        // 존재 판정·이동·첫 심박을 짧은 디렉터리 락으로 묶는다(턴 실행 중에는 락을 잡지 않는다).
        const fp = `${fp0}.claimed`;
        let st0;
        try {
          st0 = await withDirLock(`${fp0}.lock`, async () => {
            try { await stat(fp); return null; } catch (e) { if (e.code !== 'ENOENT') throw e; }
            const queued = await stat(fp0); // 선점 전 나이 보존 — 구형식 잡의 24시간 만료 판정
            await rename(fp0, fp);
            const t = new Date(); await utimes(fp, t, t); // 회수도 같은 락을 쓰므로 오래된 적재 mtime을 선점 나이로 오인하지 않는다
            return queued;
          });
        } catch { busy.delete(n); return; }
        if (!st0) { busy.delete(n); return; } // 다른 워커의 선점은 그대로, 재적재된 .json은 성공 뒤 처리

        let done = false;
        let job = null; // catch의 스키마 어긋남 나이 판정·안내 훅이 쓴다
        const hb = setInterval(() => { const t = new Date(); utimes(fp, t, t).catch(() => {}); }, 60_000); hb.unref?.(); // 선점 심박 — 살아 있는 긴 턴(30분 넘는 사고 과정·장시간 잡)이 CLAIM_MAX_AGE_MS 회수에 걸리지 않게
        try {
          job = await readJsonLenient(fp, null); // 손상 잡은 null → 처리 스킵 후 삭제(무한 재시도 방지)
          if (job?.dev && me && job.dev !== me) {
            // 다른 기기가 적재한 잡의 사본(과거 큐가 동기화되던 시절의 잔재) — 원 기기가 실행하므로 정리만
            console.log(`[argo] 큐 정리(${wsId}/${key}/${n}): 다른 기기(${String(job.dev).slice(0, 8)})의 잡 사본 — 실행 없이 제거`);
          } else if (job && !job.dev && Date.now() - (st0?.mtimeMs ?? 0) > LEGACY_JOB_MAX_AGE_MS) {
            // dev 태그 없는 구형식 잡이 너무 오래됨 — 어느 기기 것인지 알 수 없어 좀비 실행 대신 폐기(로그로 관측)
            console.log(`[argo] 큐 정리(${wsId}/${key}/${n}): ${Math.round(LEGACY_JOB_MAX_AGE_MS / 3_600_000)}시간 넘은 구형식 잡 — 실행 없이 제거`);
          } else if (job) {
            // DEFER = 차례 아님 — finally가 선점을 풀고 백오프 뒤 다시 집는다. 이 잡의 실패 횟수·간격·복구 신호는 건드리지 않는다: DEFER는 DB 확인 없이 돌아올 수 있다(msgr.mjs busyCrew) —
            // 같은 크루의 막힌 잡끼리 서로 DEFER시키며 횟수를 지워 간격이 1초부터 다시 시작했다(2차 검수 MEDIUM-1, 잡 3개 180초 46회). path = 선점 뒤 실제 파일(장시간 잡 tries 마커가 원래 이름에 쓰이던 회귀 방지)
            if (await handler(job, { path: fp }) === DEFER) { deferUntil.set(n, Date.now() + DEFER_BACKOFF_MS); return; }
            noteHandled(); // 핸들러가 던지지 않고 DEFER도 아니게 돌아왔다 — 연결이 살아 있다는 신호
          }
          done = true;
          forget(n);
          await withDirLock(`${fp0}.lock`, () => unlink(fp)).catch(() => {}); // 처리 완료분만 제거. 처리 중 크래시면 .claimed가 남아 CLAIM_MAX_AGE_MS 뒤 회수·재처리
        } catch (e) {
          const skewAge = isSchemaSkewError(e) ? Date.now() - (Date.parse(job?.createdAt) || firstFail.get(n) || Date.now()) : 0; // 스키마 어긋남은 일시처럼 기다리되 잡 나이 상한을 넘기면 버린다
          if (e?.aborted) {
            done = true;
            forget(n);
            await withDirLock(`${fp0}.lock`, () => unlink(fp)).catch(() => {});
          } else if (isPermanentQueueError(e) || skewAge > SCHEMA_SKEW_MAX_AGE_MS) {
            // 영구 오류 — 다시 해도 같은 결과(또는 스키마 어긋남이 상한을 넘김). 실패 기록을 남기고 큐에서 뺀 뒤 안내 훅을 부른다(1초마다 끝없이 재시도하던 결함 F1, 흔적 없이 사라지던 결함 H1)
            const reason = isPermanentQueueError(e) ? 'permanent' : 'schema-age';
            done = true;
            forget(n);
            await withDirLock(`${fp0}.lock`, async () => { await recordFailedJob(dirQ, n, fp, e, reason, typeof onAbandon === 'function' && !!job); await unlink(fp); }).catch(() => {});
            console.error(`[argo] 큐 처리 실패 — 재시도 안 함(${where}/${n}, ${e.code ?? 'permanent'}${reason === 'schema-age' ? ', 스키마 어긋남 24시간 초과' : ''}):`, e.message);
            if (typeof onAbandon === 'function' && job) {
              const delivered = await callHook(onAbandon, job, e, { name: n, reason }, where);
              await settleNotice(dirQ, n, delivered); // 못 보냈으면 미전송 표지가 남아 시작 때·다음 성공 때 다시 보낸다(LOW-4)
              if (!delivered) noticesLeft = true;
            }
          } else {
            // 일시 오류(인프라·스키마 어긋남) — 선점을 풀고 지수 간격 뒤 재시도(첫 재시도는 다음 틱)
            const k = (failures.get(n) ?? 0) + 1;
            failures.set(n, k); retryAt.set(n, Date.now() + queueRetryDelayMs(k, retryBaseMs) - 50);
            if (!firstFail.has(n)) firstFail.set(n, Date.now());
            console.error(`[argo] 큐 처리 실패(${where}/${n}, ${k}회째 — ${Math.round(queueRetryDelayMs(k, retryBaseMs) / 1000)}초 뒤 재시도):`, e?.message ?? e);
            if (isSchemaSkewError(e)) {
              skewBlocked.add(n);
              // 스키마 어긋남으로 오래 막힌 잡 — 보낸 사람에게 "늦어지고 있다"고 한 번 알린다(LOW-3). 못 보냈으면 다음 실패(≤5분 뒤)에 다시 시도한다
              const stalledMs = Date.now() - (firstFail.get(n) ?? Date.now());
              if (onStalled && job && !stalledNotified.has(n) && stalledMs >= stalledAfterMs) {
                if (await callHook(onStalled, job, e, { name: n, stalledMs }, where)) stalledNotified.add(n);
              }
            } else skewBlocked.delete(n);
          }
        } finally {
          clearInterval(hb);
          if (!done) await withDirLock(`${fp0}.lock`, () => rename(fp, fp0)).catch(() => {}); // 재시도는 동일 ID 재적재분보다 실행 중 저장한 체크포인트를 우선한다
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
/** 메신저 큐 동시 턴 — 단체 대화 동시 답변(2026-09-26)이 본체 회의실과 같은 폭으로 돈다(ARGO_ROOM_CONCURRENCY 공유, 기본 8·1~16).
    같은 크루는 게이트웨이 busyCrew가 한 번에 한 턴으로 묶는다. */
export const MSGR_MAX_INFLIGHT = Math.min(16, Math.max(1, Number(process.env.ARGO_ROOM_CONCURRENCY) || 8));
export const JOBS_MAX_INFLIGHT = 1;  // 회사당 동시 1 — 장시간 작업이 메신저 응답을 굶기지 않게 큐 분리
export const JOBS_MAX_PENDING = 10;  // 대기 상한 — 비용 폭주·큐 폭발 방지

/** 크루 도구용 적재 — 대기 상한을 넘으면 거절(에러 메시지가 크루에게 그대로 간다). (export: 도구·테스트 공용) */
export async function enqueueLongJob(wsId, { slug, title, prompt, msgr = null, from = null }) { // from = 이 작업을 건 턴이 사장 직접 턴이 아닐 때 그 크루(작업 턴이 이어받아 풀 오토가 아니다)
  if (msgr && (!['orgId', 'channelId', 'crewId', 'uid', 'wsId'].every((k) => typeof msgr[k] === 'string' && msgr[k]) || msgr.wsId !== wsId)) throw new Error('메신저 작업의 발신 경로가 없거나 다른 워크스페이스입니다');
  const origin = msgr ? Object.fromEntries(['orgId', 'channelId', 'crewId', 'threadRoot', 'sourceMsgId', 'uid', 'wsId', 'origin', 'hop'].filter((k) => msgr[k] !== undefined).map((k) => [k, msgr[k]])) : null;
  let pending = 0;
  try { pending = (await readdir(queueDir(wsId, JOBS_QUEUE))).filter((n) => n.endsWith('.json')).length; } catch { /* 큐 없음 = 0 */ }
  if (pending >= JOBS_MAX_PENDING) throw new Error(`대기 중인 장시간 작업이 이미 ${pending}건입니다 — 끝나기를 기다리거나 사장에게 정리를 요청하라`);
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  await enqueueJob(wsId, JOBS_QUEUE, id, { id, slug, title, prompt, createdAt: new Date().toISOString(), tries: 0, ...(origin ? { msgr: origin } : {}), ...(typeof from === 'string' && from ? { from } : {}) });
  return { id, pending: pending + 1 };
}
