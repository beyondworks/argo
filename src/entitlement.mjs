// 요금제 경계 — plan 조회와 동기화 게이트. 집행 권위는 서버(Storage RLS의 is_pro, 20260723..._companies_sync_pro_gate).
// 이 모듈은 우아한 페이월 UX용 pre-flight일 뿐 — 수정된 클라이언트가 건너뛰어도 RLS가 무료 계정의 쓰기를 거부한다.
// 강제(클라 UX)는 ARGO_ENFORCE_PLAN=1일 때만(기본 off, 런치에서 RLS 적용과 함께 켠다). plan 쓰기는 서버(서비스 롤) 전용 — 여긴 읽기만.
// 강제 on에서도 게이트는 사이클 조기 return이라 비파괴(다음 사이클 재시도).

/** 계정 plan. 'pro' | 'free'(무행=무료, RLS is_pro=false와 일치) | null(조회 실패·오너 미상=미확인).
    조회 실패를 'free'가 아닌 null로 두어, 일시적 실패로 유료 사용자를 오차단하지 않는다(아래 syncEntitled). */
export async function fetchPlan(sb, ownerId) {
  if (!ownerId) return null; // 오너 미상 — 미확인(낙관 진행)
  try {
    const { data, error } = await sb.from('entitlements').select('plan').eq('user_id', ownerId).maybeSingle();
    if (error) throw new Error(error.message);
    return data?.plan === 'pro' ? 'pro' : 'free'; // 행 없음/'free' → 무료(RLS is_pro=false와 일치)
  } catch (e) {
    console.warn('[argo] 플랜 조회 실패 — 미확인(낙관 진행):', e.message);
    return null;
  }
}

/** 동기화 자격 게이트(우아한 페이월 pre-flight). 강제 off면 항상 통과.
    강제 on이면 '확정 free'만 차단 — pro·미확인(null)은 통과시키고 최종 집행은 서버 RLS에 맡긴다(유료 오차단 방지). */
export async function syncEntitled(sb, ownerId) {
  const plan = await fetchPlan(sb, ownerId);
  if (process.env.ARGO_ENFORCE_PLAN !== '1') return { ok: true, plan };
  return { ok: plan !== 'free', plan };
}
