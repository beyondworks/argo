// 요금제 조회 캐시 — 동기화 주기(8초)마다 GET /auth/v1/user + rpc/my_plan을 다시 보내던 것을 계정별 10분으로 묶는다.
// 실측(2026-10-01 가짜 Supabase): 바뀐 게 없는 동기화 프로세스가 주기마다 두 요청을 보냈다 — 기본 8초 주기면 프로세스당 분당 15건.
// 상태는 globalThis에 둔다 — Next가 instrumentation(동기화 루프)과 API 라우트(결제 화면)를 따로 번들해도 같은 캐시를 지운다.
// 지우는 때: 계정·오너가 바뀜(키 불일치) · 업로드 거절(sync.mjs) · 결제 화면 조회(app/api/me/billing — 결제·요금제 변경 뒤 돌아온 탭).
export const PLAN_TTL_MS = 10 * 60_000;
export const PLAN_FAIL_TTL_MS = 60_000; // 조회 실패(plan=null) — 장애 중 매 주기 재시도 폭주는 막되 복구는 1분 안에

const state = (globalThis.__argoPlanCache ??= { key: '', at: 0, ent: null });

/** 캐시된 결과 또는 null(없음·만료·키 불일치). key = "<세션 사용자>|<오너>" — 계정이 바뀌면 자동으로 빗나간다. */
export function cachedPlan(key, now = Date.now()) {
  if (!state.ent || state.key !== key) return null;
  const ttl = state.ent.plan == null ? PLAN_FAIL_TTL_MS : PLAN_TTL_MS;
  return now - state.at < ttl ? state.ent : null;
}

export function rememberPlan(key, ent, now = Date.now()) {
  state.key = key; state.at = now; state.ent = ent;
}

export function invalidatePlanCache() {
  state.key = ''; state.at = 0; state.ent = null;
}
