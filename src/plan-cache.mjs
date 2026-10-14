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

// 업로드 보류를 푸는 때(2026-10-14 무료 계정 POST 400 폭주 후속) — 거절 뒤 걸린 10분 보류·회사 재시도 대기는 플랜이 Pro·체험으로
// 올라가거나 계정이 바뀌면 바로 풀어야 한다(결제하고 돌아왔는데 최대 10분 안 올라가던 것). 같은 판정이 10분마다 다시 와도 풀지 않는다.
// seen = 마지막으로 실제 조회한 { key, plan } — 캐시와 같은 globalThis에 둔다(라우트·동기화 번들 공유).
export const lastPlanSeen = () => state.seen ?? null;
export const notePlanSeen = (seen) => { state.seen = seen; };
export function planResumes(prev, next) {
  if (!prev || prev.key !== next.key) return true;
  return (next.plan === 'pro' || next.plan === 'trial') && prev.plan !== next.plan;
}
