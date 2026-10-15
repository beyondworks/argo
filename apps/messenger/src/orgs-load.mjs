// 첫 조직 목록 불러오기(D8, 2026-10-15 — 링크 감사 D8, 설계 artifacts/msgr-d8/design.md). 조직 목록이 오기 전에는 화면을 열지 않는데(App의 orgs === null),
// 첫 조회가 두 번 실패하거나 응답이 없으면 끝이었고 회복 신호(online·복귀·재연결)도 조직 목록을 다시 읽지 않아 "불러오는 중…"에서 벗어날 수 없었다.
// 이 모듈 = 첫 조회 한 번만의 상태 기계(한 번에 하나, 실패 뒤에만 재시도, 간격 상한, 회복 신호는 즉시 한 번). 목록을 받은 뒤의 흐름은 App 종전 그대로.
export const ORGS_SLOW_MS = 8_000;        // 이만큼 기다리면 "응답이 늦어요" — 요청은 끊지 않는다(늦게라도 성공하면 연다)
export const ORGS_RETRY_UI_MS = 20_000;   // 이만큼 기다리면 [다시 시도]도 보인다
export const ORGS_RETRY_STEPS = [5_000, 10_000, 20_000, 40_000, 60_000]; // 실패 뒤 자동 재시도 간격(마지막 값에서 멈춘다)
export const ORGS_RETRY_MAX = 10;         // 자동 재시도 상한 — 넘으면 [다시 시도]와 회복 신호만

/** 오류 종류 — 'offline' | 'auth' | 'server'. e = { message, status, code }(App이 원 응답의 status·code를 붙여 던진다) */
export function orgsLoadError(e, online = true) {
  const msg = String(e?.message ?? e ?? ''), status = Number(e?.status ?? 0);
  if (online === false) return 'offline';
  if (/session_refreshing/i.test(msg)) return 'offline'; // anon-guard SESSION_REFRESHING(D50) = 로그인은 살아 있고 토큰 갱신만 잠시 실패 — 자동 재시도 대상. 'auth'면 [다시 로그인] → signOut이 저장 초안을 지운다(검수 2 #1039)
  if (status === 401 || e?.code === 'PGRST301' || /JWT expired/i.test(msg)) return 'auth';
  if (!status && /Failed to fetch|Load failed|NetworkError|fetch failed|network/i.test(msg)) return 'offline';
  return 'server';
}
/** 실패 tries번째(1부터) 뒤 다음 자동 시도까지 — 상한을 넘으면 null */
export function orgsRetryDelay(tries) {
  if (!(tries >= 1) || tries > ORGS_RETRY_MAX) return null;
  return ORGS_RETRY_STEPS[Math.min(tries, ORGS_RETRY_STEPS.length) - 1];
}

/** run() = 첫 조직 목록 조회(성공하면 App이 orgs를 채운다). onState(s) — s = { phase: 'loading'|'ready'|'error', kind, tries, slow, retryUi } */
export function makeOrgsLoader({ run, onState, online = () => true, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let s = { phase: 'loading', kind: null, tries: 0, slow: false, retryUi: false };
  let inFlight = null, retryT = null, slowT = null, uiT = null, disposed = false;
  const emit = (patch) => { s = { ...s, ...patch }; if (!disposed) onState(s); };
  const clearWait = () => { if (slowT) clearTimer(slowT); if (uiT) clearTimer(uiT); slowT = uiT = null; };
  const start = () => {
    if (disposed || inFlight || s.phase === 'ready') return inFlight;
    if (retryT) { clearTimer(retryT); retryT = null; }
    emit({ phase: 'loading', slow: false, retryUi: false });
    slowT = setTimer(() => { if (inFlight) emit({ slow: true }); }, ORGS_SLOW_MS);
    uiT = setTimer(() => { if (inFlight) emit({ retryUi: true }); }, ORGS_RETRY_UI_MS);
    inFlight = Promise.resolve().then(run).then(() => { clearWait(); emit({ phase: 'ready', kind: null, slow: false, retryUi: false }); }, (e) => {
      clearWait();
      const tries = s.tries + 1, kind = orgsLoadError(e, online());
      emit({ phase: 'error', kind, tries, slow: false, retryUi: true });
      const wait = kind === 'auth' ? null : orgsRetryDelay(tries); // 로그인 만료는 자동 재시도하지 않는다 — 토큰이 갈리면(TOKEN_REFRESHED) App이 signal()
      if (wait != null && !disposed) retryT = setTimer(() => { retryT = null; start(); }, wait);
    }).finally(() => { inFlight = null; });
    return inFlight;
  };
  return {
    start,
    /** 회복 신호(online·복귀·재연결·토큰 갱신) — 실패 상태일 때만 즉시 한 번(예약을 당긴다). 진행 중·성공 뒤면 아무것도 안 한다 */
    signal() { if (s.phase === 'error' && !inFlight) start(); },
    /** [다시 시도] — 진행 중이면 그대로 기다린다(한 번에 하나) */
    retry() { if (!inFlight) start(); },
    state: () => s,
    dispose() { disposed = true; clearWait(); if (retryT) clearTimer(retryT); retryT = null; },
  };
}
