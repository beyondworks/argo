// 내 구독 상태 — 설정 카드의 연체 배너·구독 관리 링크 노출 판단의 원천.
// 쿠키 세션이 있으면 **사용자 클라이언트**로 조회한다 — entitlements_own_select RLS가 타인 행
// 노출을 구조적으로 막는다(서비스 롤이면 .eq 한 줄이 유일 방어선 — 재검수 M5). 기기 연동
// 세션(쿠키 없음, 데스크톱 다수)만 서비스 롤로 폴백하되 검증된 기기 세션의 user.id로만 조회.
// portal_url은 내리지 않는다 — 24시간 만료 스냅샷이라 렌더 금지(클릭 시점 발급: ./portal).
import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';
import { createClient } from '@supabase/supabase-js';
import { currentUser } from '../../../auth.mjs';
import { TRIAL_DAYS } from '../../../../src/entitlement.mjs';

const pick = (data, trialEndsAt = null) => Response.json({
  billing: { plan: data?.plan ?? null, status: data?.ls_status ?? null, hasSub: !!data?.ls_subscription_id, endsAt: data?.ends_at ?? null, trialEndsAt },
});

/** 가입 시각 → 체험 종료 시각(entitlement.mjs fetchPlan·서버 is_pro의 14일 창과 동일 계산).
    pro면 의미 없어 null. 종료 임박 독려 배너의 원천. */
const trialEnd = (createdAt, plan) => {
  if (plan === 'pro') return null;
  const c = Date.parse(createdAt ?? '');
  return Number.isFinite(c) ? new Date(c + TRIAL_DAYS * 86_400_000).toISOString() : null;
};

export async function GET() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url) return Response.json({ billing: null }); // 로컬 전용 — 결제 표면 없음
  const cols = 'plan, ls_status, ls_subscription_id, ends_at';
  try {
    if (anon) {
      // ① 쿠키 세션 경로 — RLS(own select)가 방어선
      const store = await cookies();
      const sb = createServerClient(url, anon, {
        cookies: { getAll: () => store.getAll(), setAll: () => { /* 갱신은 미들웨어 담당 */ } },
      });
      const { data: { user } } = await sb.auth.getUser();
      if (user) {
        const { data, error } = await sb.from('entitlements').select(cols).maybeSingle();
        if (error) throw new Error(error.message);
        return pick(data, trialEnd(user.created_at, data?.plan));
      }
    }
    // ② 기기 연동 세션 폴백 — 쿠키 세션이 없는 데스크톱. currentUser()가 기기 파일에서 검증한 id.
    const user = await currentUser();
    if (!user?.id || user.id === 'local' || user.id === 'guest' || !serviceKey) return Response.json({ billing: null });
    const sb = createClient(url, serviceKey, { auth: { persistSession: false } });
    const { data, error } = await sb.from('entitlements').select(cols).eq('user_id', user.id).maybeSingle();
    if (error) throw new Error(error.message);
    // 기기 세션엔 created_at이 없어 admin 조회 — 실패해도 배너만 빠질 뿐 화면은 유지
    let created = null;
    try {
      const r = await fetch(`${url}/auth/v1/admin/users/${user.id}`, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` }, signal: AbortSignal.timeout(5000) });
      if (r.ok) created = (await r.json())?.created_at ?? null;
    } catch { /* 배너 생략 */ }
    return pick(data, trialEnd(created, data?.plan));
  } catch (e) {
    console.error('[argo] me/billing 조회 실패:', e?.message ?? e);
    return Response.json({ billing: null }); // 조회 실패로 설정 화면을 깨지 않는다 — 배너만 사라진다
  }
}
