// 요금제 경계 — plan 조회와 동기화 게이트. 집행 권위는 서버(Storage RLS의 is_pro, 20260723..._companies_sync_pro_gate).
// 이 모듈은 우아한 페이월 UX용 pre-flight일 뿐 — 수정된 클라이언트가 건너뛰어도 RLS가 무료 계정의 쓰기를 거부한다.
// 강제(클라 UX)는 ARGO_ENFORCE_PLAN=1일 때만(기본 off, 런치에서 RLS 적용과 함께 켠다). plan 쓰기는 서버(서비스 롤) 전용 — 여긴 읽기만.
// 강제 on에서도 게이트는 사이클 조기 return이라 비파괴(다음 사이클 재시도).
// ⚠ 이 파일은 클라이언트 번들에도 포함된다(설정 SyncCard가 trialBadgeState를 import) — node:* import·부작용 금지.

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

/** entitlements 행이 **지금 유효한 pro**인가 — 서버 is_pro(20260730050000)의 클라 공유 술어.
    ends_at 의미(LS 계약, lsbilling.mjs): 활성 = null, 해지 예약·만료 = 접근 종료 시각. 파싱 불능은
    만료로 보지 않는다(낙관 — 유료 오차단 방지). ⚠ fetchPlan과 유실 대사 게이트(app/api/me/billing)가
    **반드시 이 하나를** 쓴다 — 사본이 갈리면 깬 쪽이 잠금/복구 비대칭을 만든다(분리 검수 2026-07-30
    HIGH: 게이트가 원시 plan==='pro'를 믿어, 재개 웹훅 유실 사용자의 유일한 복구인 대사가 영구히 꺼졌다). */
export const proRowActive = (row) => row?.plan === 'pro' && !(row.ends_at && Date.parse(row.ends_at) <= Date.now());

/** 유실 대사(reconcile)가 **불요**인가 — proRowActive를 한 겹 좁힌다: 지금 유효한 pro **이면서
    구독 식별자가 붙어 있을 때만** 참. 부여 Pro(그랜드파더링: plan=pro·ends_at=null·
    ls_subscription_id=null)는 proRowActive가 늘 참이라 대사가 영구히 꺼져 있었고, 그 계정이
    실제로 결제한 뒤 웹훅이 유실되면 hasSub=false가 굳어 **이미 낸 사람에게 결제 카드가 계속**
    뜬다(분리 검수 2026-08-19 HIGH-1 — 중복 청구 유인).
    ⚠ 좁히는 방향이라 2026-07-30 HIGH(원시 plan==='pro'를 믿어 만료 pro의 복구가 꺼지던 것)와
    같은 편이다 — 대사가 도는 집합은 늘어나기만 한다. 자격 판정 자체는 여전히 proRowActive
    하나만 쓴다(is_pro·fetchPlan과 갈리면 잠금/복구 비대칭). 대사는 승격 전용이라
    (lsreconcile: "entitlements를 free로 내리는 일은 하지 않는다") 부여 Pro가 대사 결과로
    강등되지 않고, LS 호출량은 쿨다운 2컬럼(10분·24시간)이 그대로 막는다. */
export const reconcileUnneeded = (row) => proRowActive(row) && !!row?.ls_subscription_id;

/** 계정 plan. 'pro' | 'trial'(가입 14일 이내 무료 체험 — 서버 is_pro와 대칭) | 'free' | null(조회 실패·오너 미상=미확인).
    조회 실패를 'free'가 아닌 null로 두어, 일시적 실패로 유료 사용자를 오차단하지 않는다(아래 syncEntitled). */
export async function fetchPlan(sb, ownerId) {
  if (!ownerId) return null; // 오너 미상 — 미확인(낙관 진행)
  try {
    const { data, error } = await sb.from('entitlements').select('plan, ends_at').eq('user_id', ownerId).maybeSingle();
    if (error) throw new Error(error.message);
    // 서버 is_pro와 대칭(마이그레이션 20260730050000) — pro라도 ends_at이 지났으면 무효. 해지·만료
    // 웹훅 1건이 유실돼도 양쪽에서 저절로 꺼진다(전수리뷰 2026-07-30 #5). 판정은 공유 술어(위) 하나로.
    if (proRowActive(data)) return 'pro';
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

/** 결제 카드가 보여줄 CTA 한 종류(순수) — 설정 화면의 동기화 ON/OFF 두 체인이 같은 삼항문을
    중복 복사하고 있어, 한쪽만 고치면 절반의 사용자는 계속 결제를 못 한다(실사고 2026-08-19:
    구독 없는 Pro 44계정은 두 체인 모두에서 null로 떨어져 진입로가 아예 없었다).
    결정은 여기 한 곳에서만 한다.

    반환:
      'paywalled'  — 막힌 상태: 즉시 업그레이드 권유
      'trial-soon' — 체험 종료 임박(3일 이내)
      'trial'      — 체험 중(임박 전)
      'granted'    — 구독 없이 Pro가 부여된 상태(그랜드파더링 등) — 미리 결제 가능해야 한다
      'manage'     — 유료 구독자: 구독 관리(포털)
      'past-due'   — 연체 유예 중
      'upgrade'    — free: 안내 차원의 업그레이드
      null         — 아무 것도 보이지 않음
    (export: 회귀 테스트용 — 순수 함수)     ⚠ 아직 UI에 배선되지 않았다(2026-08-19). 설정 화면은 같은 판정을 JSX 삼항 체인으로 그대로
    갖고 있고, 이 함수는 **의도된 결정표 + 회귀 테스트**로만 쓰인다. 배선하면 bill=null(로컬·게스트,
    계정 없음)에서 기존 조건 `plan === 'pro' && !bill?.hasSub`이 sync.plan='pro'로 참이 되던 경로가
    사라져 동작이 바뀐다 — 그 변경은 DOM 실측이 가능할 때 별도로 한다. 그때까지 두 체인이 갈라지는
    것은 test/billing-cta.test.mjs의 구조 검사가 막는다.
*/
export function billingCta(bill, { paywalled = false, now = Date.now() } = {}) {
  const plan = bill?.plan ?? null;
  const hasSub = !!bill?.hasSub;
  if (bill?.status === 'past_due' && hasSub) return 'past-due';
  if (paywalled) return 'paywalled';
  const { active, imminent } = trialBadgeState(bill?.trialEndsAt, plan, now);
  if (imminent) return 'trial-soon';
  if (active) return 'trial';
  if (plan === 'pro' && hasSub) return 'manage';
  if (plan === 'pro' && !hasSub) return 'granted'; // 부여 Pro — 결제 진입로를 열어 둔다
  if (plan === 'free') return 'upgrade';
  return null;
}
