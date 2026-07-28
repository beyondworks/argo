// 요금제 경계 — plan 조회와 동기화 게이트. 집행 권위는 서버(Storage RLS의 is_pro, 20260723..._companies_sync_pro_gate).
// 이 모듈은 우아한 페이월 UX용 pre-flight일 뿐 — 수정된 클라이언트가 건너뛰어도 RLS가 무료 계정의 쓰기를 거부한다.
// 강제(클라 UX)는 ARGO_ENFORCE_PLAN=1일 때만(기본 off, 런치에서 RLS 적용과 함께 켠다). plan 쓰기는 서버(서비스 롤) 전용 — 여긴 읽기만.
// 강제 on에서도 게이트는 사이클 조기 return이라 비파괴(다음 사이클 재시도).

export const TRIAL_DAYS = 14; // 가입 후 무료 체험(2026-07-24 유건 확정: 2주 Free → Pro $16/월). 서버 is_pro와 대칭 유지.

/** 가입 시각 → 체험 종료 시각(fetchPlan·서버 is_pro의 14일 창과 동일 계산 — 대칭 유지가 계약).
    pro면 null(의미 없음), 파싱 불가도 null. D-day 배지·임박 배너의 단일 원천. (export: 회귀 테스트용) */
export const trialEnd = (createdAt, plan) => {
  if (plan === 'pro') return null;
  const c = Date.parse(createdAt ?? '');
  return Number.isFinite(c) ? new Date(c + TRIAL_DAYS * 86_400_000).toISOString() : null;
};

/** 체험 배지·임박 배너 상태(순수) — 설정 SyncCard의 유일한 판정. **만료 하한이 핵심**:
    만료된 무료 사용자에게 'D-0'과 임박 배너가 영구 표시되던 회귀(분리 검수 H1 실측 2026-07-28)를
    이 함수와 테스트가 잠근다. daysLeft는 최소 1(살아 있는데 D-0이 없게 — 의미 모호성 제거). */
export const trialBadgeState = (trialEndsAt, plan, now = Date.now()) => {
  const msLeft = trialEndsAt ? Date.parse(trialEndsAt) - now : NaN;
  const active = Number.isFinite(msLeft) && msLeft > 0 && plan !== 'pro';
  return {
    active,
    imminent: active && msLeft < 3 * 86_400_000,
    daysLeft: active ? Math.max(1, Math.ceil(msLeft / 86_400_000)) : null,
  };
};

/** 계정 plan. 'pro' | 'trial'(가입 14일 이내 무료 체험 — 서버 is_pro와 대칭) | 'free' | null(조회 실패·오너 미상=미확인).
    조회 실패를 'free'가 아닌 null로 두어, 일시적 실패로 유료 사용자를 오차단하지 않는다(아래 syncEntitled). */
export async function fetchPlan(sb, ownerId) {
  if (!ownerId) return null; // 오너 미상 — 미확인(낙관 진행)
  try {
    const { data, error } = await sb.from('entitlements').select('plan').eq('user_id', ownerId).maybeSingle();
    if (error) throw new Error(error.message);
    if (data?.plan === 'pro') return 'pro';
    // 무행/free — 가입 14일 무료 체험 창인지 판정(서버 is_pro의 OR 조건과 대칭). 세션 본인일 때만 확인 가능.
    // 일시 실패(네트워크·GoTrue 오류)는 파일 불변식대로 null(미확인 낙관) — 체험 중 사용자를 오차단하지 않는다
    // (검수 MEDIUM 2026-07-24). auth 자체가 없는 클라(mock·서비스 모드)만 free 폴백 — 최종 집행은 서버 RLS.
    try {
      const { data: u, error: aerr } = await sb.auth.getUser();
      if (aerr) return null; // 일시 실패 — 미확인(낙관), 다음 사이클 재판정
      const created = u?.user?.id === ownerId ? Date.parse(u.user.created_at) : NaN;
      if (Number.isFinite(created) && Date.now() - created < TRIAL_DAYS * 86_400_000) return 'trial';
    } catch { /* auth 미지원 클라(mock·서비스 모드) — free 폴백 */ }
    return 'free'; // 행 없음/'free' + 체험 종료 → 무료(RLS is_pro=false와 일치)
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
