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
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { RUNNER_AUTH, loadRunnerCred, verifyRunnerCred, runnerCredEnv, isCliTurn } from './runners.mjs';
import { GEMINI_DEFAULT_MODEL, CODEX_DEFAULT_MODEL, GLM_DEFAULT_MODEL, OPENROUTER_DEFAULT_MODEL, KIMI_DEFAULT_MODEL, GROK_DEFAULT_MODEL } from './runners/catalog.mjs';
import { grokExpired } from './runners/grok.mjs';
import { credHash, HEALTH_FILE_NAME } from './runners/shared.mjs';
import { nativeRunnerEnabled } from './engine/native-flags.mjs';
import { authFromEnv, callMessages } from './engine/messages-http.mjs';
import { ensureRequired } from './engine/native-query.mjs';
import { BUILTIN_SPECS } from './engine/builtin-tools.mjs';
import { BROWSER_SPECS } from './engine/browser-tools.mjs';
import { COMPUTER_SPECS } from './engine/computer-tools.mjs';

export const HEALTH_INTERVAL_MS = 30 * 60_000;            // 기본 30분(계획서 값)
export const HEALTH_INTERVAL_BILLED_MS = 6 * 60 * 60_000; // 과금 검증 러너는 6시간
export const HEALTH_BACKOFF_MAX = 4;                       // 2^4 = 최대 16배(30m→8h / 6h→96h는 상한이 자름)
export const HEALTH_BACKOFF_CAP_MS = 24 * 60 * 60_000;     // 백오프 상한 24시간
/** verify가 **실 벤더 과금 호출**인 러너 — grok은 POST /v1/messages(max_tokens 1)를 실제로 쏜다.
    나머지는 GET 목록·키 조회(무료) 또는 cloudcode loadCodeAssist 1콜(0토큰). 새 러너를 넣을 땐
    verifyRunnerCred의 그 갈래가 과금인지 보고 이 집합을 갱신한다. */
export const HEALTH_BILLED_RUNNERS = new Set(['grok']);

// ── 턴 모양 프로브(2026-09-06 Grok 400 제보 뒤 도입) ─────────────────────────────────────────────────────
// 자격 확인(verify)은 키가 유효한지만 본다. 벤더가 **Argo의 요청 형태**(도구 정의)를 거절하는 결함(xAI: object 스키마에 required 없으면 400 —
// v0.1.62 Grok 턴 전멸)은 verify로는 절대 안 보이고 크루 턴 실패로만 드러났다. 그래서 네이티브로 도는 러너에는 실제 대화와 같은 도구
// 목록을 실은 1턴(max_tokens 8)을 보내 카드가 먼저 말하게 한다. 비용 통제: 도구 목록·앱 버전의 지문이 바뀌었을 때(=업데이트 직후) 또는
// 하루 1회만. 판정 불가(네트워크·5xx)는 무해 스킵(제약 ②), 자격은 지우지 않는다(제약 ③).
export const HEALTH_PROBE_INTERVAL_MS = 24 * 60 * 60_000;
const PROBE_MODEL = { openrouter: OPENROUTER_DEFAULT_MODEL, glm: GLM_DEFAULT_MODEL, kimi: KIMI_DEFAULT_MODEL, grok: GROK_DEFAULT_MODEL, gemini: GEMINI_DEFAULT_MODEL, codex: CODEX_DEFAULT_MODEL };
const APP_VERSION = (() => { try { return createRequire(import.meta.url)('../package.json').version; } catch { return '0.0.0'; } })();
let probeSpecsCache = null;
/** 프로브에 싣는 도구 정의 — 실제 네이티브 턴과 같은 내장·브라우저·컴퓨터 스펙(같은 정규화 관문). 크루·MCP 도구는 회사 문맥이라 제외. */
export function probeToolSpecs() {
  if (!probeSpecsCache) probeSpecsCache = [...BUILTIN_SPECS, ...BROWSER_SPECS, ...COMPUTER_SPECS].map((t) => ({ name: t.name, description: t.description, input_schema: ensureRequired(t.input_schema) }));
  return probeSpecsCache;
}
/** 프로브 지문 — 앱 버전 + 도구 정의 전체. 바뀌면(업데이트·도구 추가) 다음 검진에서 즉시 다시 쏜다. */
export function turnProbeHash(specs = probeToolSpecs(), version = APP_VERSION) {
  return createHash('sha256').update(`${version}\n${JSON.stringify(specs)}`).digest('hex').slice(0, 16);
}
/** 프로브 차례인가(순수) — 지문이 다르거나 마지막 프로브가 intervalMs 이전. */
export function turnProbeDue(entry, hash, now, intervalMs = HEALTH_PROBE_INTERVAL_MS) {
  return entry?.probeHash !== hash || !Number.isFinite(entry?.probeAt) || now - entry.probeAt >= intervalMs;
}
/** 이 자격의 턴이 네이티브(Argo 엔진 직행)인가 — 프로브 대상. CLI·SDK 턴의 요청 형태는 그 실행기가 만든다. */
export const turnProbeApplies = (runner, credType) => Boolean(PROBE_MODEL[runner]) && nativeRunnerEnabled(runner) && !isCliTurn(runner, credType);
/** 프로브 오류 → 검진 계급(순수). 401/403 인증, 402/429 크레딧·한도, 그 밖의 4xx는 "요청 형태 거절"(schema), 5xx·네트워크는 판정 불가(null). */
export function classifyProbeError(e) {
  const status = Number(e?.status) || 0; const msg = String(e?.message || e || '').slice(0, 300);
  if (e?.authExpired || status === 401 || status === 403) return { ok: false, reason: 'auth', detail: msg };
  if (status === 402 || status === 429 || e?.quota) return { ok: false, reason: 'credit', detail: msg };
  if (status >= 400 && status < 500) return { ok: false, reason: 'schema', detail: msg };
  return { ok: null, detail: msg };
}
/** 실제 프로브 — 자격 env → 와이어 판정 → 도구 전량 광고 1턴. 결과는 {ok, reason?, detail?}. (테스트는 probeFn 주입) */
export async function runTurnProbe(wsId, runner, { fetchImpl = globalThis.fetch, timeoutMs = 30_000 } = {}) {
  const ce = await runnerCredEnv(wsId, runner);
  if (!ce?.env) return { ok: null, detail: 'no env' };
  const { wire, base, headers } = authFromEnv(ce.env);
  try {
    await callMessages({ wire, base, headers, fetchImpl, timeoutMs, retry: 0,
      body: { model: PROBE_MODEL[runner], max_tokens: 8, system: 'Health probe. Reply with "ok" only. Do not call tools.', messages: [{ role: 'user', content: 'ok' }], tools: probeToolSpecs() } });
    return { ok: true };
  } catch (e) { return classifyProbeError(e); }
}

const healthFile = (wsId) => join(paths(wsId).root, HEALTH_FILE_NAME);
/** 상태 저장 실패 시의 프로세스 내 폴백(검수 MEDIUM-2) — 디스크가 정본, 이건 폭주 방지용 백스톱뿐. */
const memoState = new Map();
/** 회사·러너별 결정적 지터(0 ~ 기본 간격의 10%) — 동시 발사 분산용(검수 LOW). 랜덤이 아니라
    해시라 같은 조합은 항상 같은 값이다(테스트 결정성 유지). */
function jitterFor(wsId, runner) {
  const key = `${wsId}/${runner}`;
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  const base = HEALTH_BILLED_RUNNERS.has(runner) ? HEALTH_INTERVAL_BILLED_MS : HEALTH_INTERVAL_MS;
  return h % Math.floor(base * 0.1);
}

/** 이 러너를 지금 검진할 차례인가(순수). entry = 이전 결과({ at, ok, fails }), now = ms.
    간격 = 기본(러너별) × 2^연속실패, 24시간 상한. 이전 기록이 없으면 즉시 대상. */
export function healthDue(entry, runner, now, { intervalMs, billedIntervalMs, jitterMs = 0 } = {}) {
  const base = HEALTH_BILLED_RUNNERS.has(runner)
    ? (billedIntervalMs ?? HEALTH_INTERVAL_BILLED_MS)
    : (intervalMs ?? HEALTH_INTERVAL_MS);
  const at = Number(entry?.at);
  if (!(at > 0)) return true;
  const fails = Math.min(Math.max(Number(entry?.fails) || 0, 0), HEALTH_BACKOFF_MAX);
  // 지터 — 첫 틱에 전 회사가 같은 at으로 각인되면 이후 경계마다 회사 수만큼 동시 발사된다(검수 LOW).
  // 회사 id 해시로 0~간격의 10% 오프셋을 얹어 분산한다(결정적 — 같은 회사는 항상 같은 오프셋).
  const wait = Math.min(base * 2 ** fails, HEALTH_BACKOFF_CAP_MS) + Math.max(0, jitterMs);
  return now - at >= wait;
}

/** 검진 결과를 상태에 반영(순수) — ok:null은 시각만 갱신하고 연속 실패는 건드리지 않는다(제약 ②). */
export function applyHealthResult(entry, result, now, hash = null) {
  const prev = Number(entry?.fails) || 0;
  const probe = entry?.probeAt ? { probeAt: entry.probeAt, probeHash: entry.probeHash } : {}; // 프로브 기록은 verify 판정과 독립(하루 1회 통제 유지)
  // credHash = 실패가 **어느 자격**에 대한 것인지(턴 전 게이트가 대조). 자격이 바뀌면 지문이 달라 게이트가 안 탄다.
  if (result?.ok === false) return { ...probe, at: now, ok: false, fails: prev + 1, ...(result.reason ? { reason: result.reason } : {}), ...(result.detail ? { detail: String(result.detail).slice(0, 300) } : {}), ...(hash ? { credHash: hash } : {}) };
  if (result?.ok === true) return { ...probe, at: now, ok: true, fails: 0 };
  return { ...(entry ?? {}), at: now }; // 판정 불가 — 직전 판정(ok/fails/reason/credHash)을 그대로 보존
}

/** 턴 실패가 **인증 실패로 확정**됐을 때 chat.mjs가 부른다 — 다음 턴의 턴 전 게이트(creds.mjs runnerCredEnv)가
    같은 자격으로 다시 쏘지 않게 한다(OpenClaw "must fail loudly" 불변식의 Argo판). 30분 검진을 기다리지 않는다.
    자격은 지우지 않는다(제약 ③). 전이 이벤트는 검진과 같은 규칙(실패 진입 1회만). */
export async function markRunnerAuthFail(wsId, runner, credValue, { nowMs = Date.now() } = {}) {
  const file = healthFile(wsId);
  const state = await readJson(file, {});
  const entry = state[runner];
  const wasFail = entry?.ok === false;
  state[runner] = applyHealthResult(entry, { ok: false, reason: 'auth' }, nowMs, credHash(credValue));
  await writeJsonAtomic(file, state);
  if (!wasFail) await appendEvent(wsId, { type: 'runner-health', runner, ok: false, reason: 'auth', source: 'turn' }).catch(() => {});
  return state[runner];
}

/** 한 회사의 연결된 러너를 검진한다. 상태 파일 갱신 + ok:false만 활동 이벤트.
    주입(verifyFn·loadCredFn·nowMs)은 테스트 전용 — 실행 경로는 기본값을 쓴다. */
export async function runHealthChecks(wsId, {
  verifyFn = verifyRunnerCred, loadCredFn = loadRunnerCred, nowMs = Date.now(),
  intervalMs, billedIntervalMs, jitterMs, // jitterMs 주입 = 테스트 결정성용(실행 경로는 jitterFor 해시)
  probeFn, probeIntervalMs = HEALTH_PROBE_INTERVAL_MS, probeHash = turnProbeHash(), // 턴 모양 프로브(주입은 테스트 전용)
} = {}) {
  // verify를 주입한 호출(테스트)은 프로브도 주입해야 한다 — 기본 프로브는 실벤더 HTTP라 가짜 verify 옆에서 실호출이 새어 나간다(도입 시 실측: 기존 테스트가 xAI를 때렸다)
  const probe = probeFn ?? (verifyFn === verifyRunnerCred ? runTurnProbe : async () => ({ ok: null }));
  const file = healthFile(wsId);
  const disk = await readJson(file, {});
  // 디스크 쓰기가 실패한 적이 있으면 그때의 상태를 얹는다 — 쓰기 불가 환경에서도 스로틀 유지.
  const mem = memoState.get(wsId);
  const state = mem ? { ...disk, ...mem.state } : disk;
  let changed = false;
  const checked = [];
  for (const runner of Object.keys(RUNNER_AUTH)) {
    const entry = state[runner];
    if (!healthDue(entry, runner, nowMs, { intervalMs, billedIntervalMs, jitterMs: jitterMs ?? jitterFor(wsId, runner) })) continue;
    const cred = await loadCredFn(wsId, runner).catch(() => null);
    if (!cred) { // 미연결 — 기록도 남기지 않는다(연결 시 첫 검진이 즉시 돈다)
      if (entry) { delete state[runner]; changed = true; }
      continue;
    }
    // host 마커는 이 컴퓨터의 CLI 로그인이라 원격 판정 대상이 아니다(verify 라우트와 같은 계약).
    // fails는 리셋한다 — apikey로 되돌렸을 때 옛 실패 카운터가 첫 확인을 최대 8h 미루던 것(검수 LOW).
    if (cred.type === 'host') { state[runner] = { at: nowMs }; changed = true; continue; }
    // **로컬로 이미 아는 만료엔 유료 프로브를 쓰지 않는다**(검수 MEDIUM-1): grok BYOA의 access_token은
    // 수명 1시간인데 검진 간격은 6시간이라, 유휴 회사에선 사실상 매번 만료 토큰으로 과금 POST를 쏘고
    // 판정도 실행 경로(runnerCredEnv의 갱신)와 무관해진다. 만료는 턴 전 자격 게이트(#372)가 이미
    // 사용자에게 알린다 — 검진은 조용히 넘긴다(시각만 갱신).
    if (runner === 'grok' && cred.type === 'oauth' && grokExpired(cred.value, nowMs)) {
      state[runner] = { ...(entry ?? {}), at: nowMs }; changed = true; continue;
    }
    let r = await verifyFn(runner, cred.type, cred.value).catch(() => ({ ok: null }));
    let probed = null;
    // 자격이 유효해도 벤더가 요청 형태를 거절할 수 있다 — 네이티브 러너는 지문 변경·하루 1회 실제 턴 모양으로 확인(위 주석). 판정 불가는 기록 안 함(다음 검진에 재시도).
    if (r?.ok === true && turnProbeApplies(runner, cred.type) && turnProbeDue(entry, probeHash, nowMs, probeIntervalMs)) {
      probed = await probe(wsId, runner, cred).catch(() => ({ ok: null }));
      if (probed?.ok === false) r = { ok: false, reason: probed.reason, detail: probed.detail };
    }
    const next = applyHealthResult(entry, r, nowMs, credHash(cred.value));
    if (probed && probed.ok !== null) { next.probeAt = nowMs; next.probeHash = probeHash; }
    const wasFail = entry?.ok === false;
    state[runner] = next; changed = true;
    checked.push({ runner, ok: r?.ok ?? null, reason: r?.reason ?? null });
    // 이벤트는 **상태 전이에서만**(검수 HIGH-1·2): 실패 진입 1회 + 회복(false→true) 1회.
    //  · 지속 실패를 매 검진 적재하면 유휴 회사 타임라인이 검진 행으로 덮인다(러너 수만큼 곱).
    //  · 회복 이벤트가 없으면 재연결 뒤에도 카드가 옛 실패를 계속 읽어 "다시 연결" 경고가 굳는다
    //    (검수 재현: 성공 검진 2회 후에도 ok:false — 사용자는 재연결이 실패했다고 읽는다).
    // 판정 불가(ok:null)는 어느 쪽도 아니다 — 활동 화면을 채우지 않는다. 자격은 그대로(제약 ③).
    if (r?.ok === false && !wasFail) {
      await appendEvent(wsId, { type: 'runner-health', runner, ok: false, ...(r.reason ? { reason: r.reason } : {}), ...(r.detail ? { detail: String(r.detail).slice(0, 300) } : {}) }).catch(() => {});
    } else if (r?.ok === true && wasFail) {
      await appendEvent(wsId, { type: 'runner-health', runner, ok: true }).catch(() => {});
    }
  }
  if (changed) {
    await writeJsonAtomic(file, state).catch((e) => {
      // 조용히 삼키면 스로틀이 통째로 사라진다(검수 MEDIUM-2 실측: 매 틱 검증 = 1440회/일).
      // 드러내고, 프로세스 내 폴백 스로틀로 폭주만은 막는다(재시작 시 디스크 상태가 다시 정본).
      console.error(`[argo] 러너 검진 상태 저장 실패(${wsId}):`, e?.message ?? e);
      memoState.set(wsId, { at: nowMs, state });
    });
  }
  return checked;
}

/** 재연결 시 그 러너의 검진 상태를 지운다(검수 LOW) — 안 지우면 새 자격이 옛 백오프(최대 8h·grok
    24h)를 그대로 물려받아 한참 뒤에야 확인된다. saveRunnerCred가 동적 import로 부른다(순환 회피). */
export async function clearHealthEntry(wsId, runner) {
  const file = healthFile(wsId);
  const state = await readJson(file, {});
  if (!(runner in state)) return false;
  delete state[runner];
  memoState.delete(wsId);
  await writeJsonAtomic(file, state).catch(() => {});
  return true;
}
