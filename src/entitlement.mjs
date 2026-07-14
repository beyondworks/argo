// 요금제 경계(M-2d 스캐폴드) — plan 조회와 동기화 게이트. 강제는 ARGO_ENFORCE_PLAN=1일 때만(기본 off,
// M-4 결제 연동에서 켠다). plan 쓰기는 서버(서비스 롤) 전용 — 이 모듈은 읽기만 한다.
// fail-safe: 행 부재·조회 실패 = 'free'. 강제 on에서도 게이트는 사이클 조기 return이라 비파괴(다음 사이클 재시도).
let last = null; // 관측용 — syncStatus 노출

export const lastPlan = () => last;

/** 계정 plan. 부재/오류/오너 없음 = 'free'. */
export async function fetchPlan(sb, ownerId) {
  if (!ownerId) { last = 'free'; return 'free'; }
  try {
    const { data, error } = await sb.from('entitlements').select('plan').eq('user_id', ownerId).maybeSingle();
    if (error) throw new Error(error.message);
    last = data?.plan === 'pro' ? 'pro' : 'free';
  } catch (e) {
    console.warn('[argo] 플랜 조회 실패 — free로 간주:', e.message);
    last = 'free';
  }
  return last;
}

/** 동기화 자격 게이트 — 강제 off면 항상 통과. */
export async function syncEntitled(sb, ownerId) {
  const plan = await fetchPlan(sb, ownerId);
  if (process.env.ARGO_ENFORCE_PLAN !== '1') return { ok: true, plan };
  return { ok: plan === 'pro', plan };
}
