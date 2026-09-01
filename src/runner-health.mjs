// 러너 주기 건강 검진 — P1-2 후속(계획서 runner-resilience "연결 시 + 주기적"의 주기 축).
//
// 왜: verifyRunnerCred는 저장 시점 1회, [연결 확인]은 사용자가 누를 때만 돈다. 그 사이 만료·철회·
// 구독 차단은 **크루 턴 실패로만** 드러났다. 30분 주기로 조용히 확인해 카드가 먼저 말하게 한다.
//
// 절대 제약(세 가지 — 어기면 이 기능이 사고가 된다):
//  ① **과금 호출 스로틀**: grok verify는 실 벤더 POST(/v1/messages)라 호출마다 청구·레이트를 먹는다
//     (#378 분리 검수 지적). 그런 러너는 기본 간격을 6시간으로 늘리고, 실패 시 백오프를 24시간까지 민다.
//  ② **판정 불가(ok:null)는 무해 스킵**: 오프라인·일시 오류·원격 판정 불가 방식은 실패로 세지 않는다
//     (연속 실패 카운터를 건드리지 않아 백오프도 안 민다 — 비행기 모드 하루가 자격을 의심하게 두지 않는다).
//  ③ **자격을 지우지 않는다**: 검진은 표시만 바꾼다. 일시 장애가 연결 해제로 둔갑하는 것이 creds.mjs가
//     명시적으로 금지한 실패 모드다(refreshGrokOnce 주석과 같은 원칙).
import { join } from 'node:path';
import { paths } from './workspace.mjs';
import { readJson, writeJsonAtomic } from './jsonstore.mjs';
import { appendEvent } from './events.mjs';
import { RUNNER_AUTH, loadRunnerCred, verifyRunnerCred } from './runners.mjs';

export const HEALTH_INTERVAL_MS = 30 * 60_000;            // 기본 30분(계획서 값)
export const HEALTH_INTERVAL_BILLED_MS = 6 * 60 * 60_000; // 과금 검증 러너는 6시간
export const HEALTH_BACKOFF_MAX = 4;                       // 2^4 = 최대 16배(30m→8h / 6h→96h는 상한이 자름)
export const HEALTH_BACKOFF_CAP_MS = 24 * 60 * 60_000;     // 백오프 상한 24시간
/** verify가 **실 벤더 과금 호출**인 러너 — grok은 POST /v1/messages(max_tokens 1)를 실제로 쏜다.
    나머지는 GET 목록·키 조회(무료) 또는 cloudcode loadCodeAssist 1콜(0토큰). 새 러너를 넣을 땐
    verifyRunnerCred의 그 갈래가 과금인지 보고 이 집합을 갱신한다. */
export const HEALTH_BILLED_RUNNERS = new Set(['grok']);

const healthFile = (wsId) => join(paths(wsId).root, '.runner-health.json');

/** 이 러너를 지금 검진할 차례인가(순수). entry = 이전 결과({ at, ok, fails }), now = ms.
    간격 = 기본(러너별) × 2^연속실패, 24시간 상한. 이전 기록이 없으면 즉시 대상. */
export function healthDue(entry, runner, now, { intervalMs, billedIntervalMs } = {}) {
  const base = HEALTH_BILLED_RUNNERS.has(runner)
    ? (billedIntervalMs ?? HEALTH_INTERVAL_BILLED_MS)
    : (intervalMs ?? HEALTH_INTERVAL_MS);
  const at = Number(entry?.at);
  if (!(at > 0)) return true;
  const fails = Math.min(Math.max(Number(entry?.fails) || 0, 0), HEALTH_BACKOFF_MAX);
  const wait = Math.min(base * 2 ** fails, HEALTH_BACKOFF_CAP_MS);
  return now - at >= wait;
}

/** 검진 결과를 상태에 반영(순수) — ok:null은 시각만 갱신하고 연속 실패는 건드리지 않는다(제약 ②). */
export function applyHealthResult(entry, result, now) {
  const prev = Number(entry?.fails) || 0;
  if (result?.ok === false) return { at: now, ok: false, fails: prev + 1, ...(result.reason ? { reason: result.reason } : {}) };
  if (result?.ok === true) return { at: now, ok: true, fails: 0 };
  return { ...(entry ?? {}), at: now }; // 판정 불가 — 직전 판정(ok/fails/reason)을 그대로 보존
}

/** 한 회사의 연결된 러너를 검진한다. 상태 파일 갱신 + ok:false만 활동 이벤트.
    주입(verifyFn·loadCredFn·nowMs)은 테스트 전용 — 실행 경로는 기본값을 쓴다. */
export async function runHealthChecks(wsId, {
  verifyFn = verifyRunnerCred, loadCredFn = loadRunnerCred, nowMs = Date.now(),
  intervalMs, billedIntervalMs,
} = {}) {
  const file = healthFile(wsId);
  const state = await readJson(file, {});
  let changed = false;
  const checked = [];
  for (const runner of Object.keys(RUNNER_AUTH)) {
    const entry = state[runner];
    if (!healthDue(entry, runner, nowMs, { intervalMs, billedIntervalMs })) continue;
    const cred = await loadCredFn(wsId, runner).catch(() => null);
    if (!cred) { // 미연결 — 기록도 남기지 않는다(연결 시 첫 검진이 즉시 돈다)
      if (entry) { delete state[runner]; changed = true; }
      continue;
    }
    // host 마커는 이 컴퓨터의 CLI 로그인이라 원격 판정 대상이 아니다(verify 라우트와 같은 계약)
    if (cred.type === 'host') { state[runner] = { ...(entry ?? {}), at: nowMs }; changed = true; continue; }
    const r = await verifyFn(runner, cred.type, cred.value).catch(() => ({ ok: null }));
    const next = applyHealthResult(entry, r, nowMs);
    state[runner] = next; changed = true;
    checked.push({ runner, ok: r?.ok ?? null, reason: r?.reason ?? null });
    // 이벤트는 **확정 실패만** — 판정 불가로 활동 화면을 채우지 않는다. 자격은 그대로 둔다(제약 ③).
    if (r?.ok === false) {
      await appendEvent(wsId, { type: 'runner-health', runner, ok: false, ...(r.reason ? { reason: r.reason } : {}) }).catch(() => {});
    }
  }
  if (changed) await writeJsonAtomic(file, state).catch(() => {});
  return checked;
}
