// 내 구독 상태 — 설정 카드의 연체 배너·구독 관리 링크 노출 판단의 원천.
// 쿠키 세션이 있으면 **사용자 클라이언트**로 조회한다 — entitlements_own_select RLS가 타인 행
// 노출을 구조적으로 막는다(서비스 롤이면 .eq 한 줄이 유일 방어선 — 재검수 M5). 기기 연동
// 세션(쿠키 없음, 데스크톱 다수)만 서비스 롤로 폴백하되 검증된 기기 세션의 user.id로만 조회.
// portal_url은 내리지 않는다 — 24시간 만료 스냅샷이라 렌더 금지(클릭 시점 발급: ./portal).
// [O2] 유실 대사: plan이 free/무행인데 LS에 활성 구독이 있으면 여기서 복구한다(웹훅 유실 최후 방어).
import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';
import { createClient } from '@supabase/supabase-js';
import { currentUser } from '../../../auth.mjs';
import { trialEnd } from '../../../../src/entitlement.mjs';
import { lsGateOpts } from '../../../../src/lsbilling.mjs';
import { reconcileEntitlement } from '../../../../src/lsreconcile.mjs';

// 무행이어도 billing 객체를 반환한다 — 체험 배지(trialEndsAt)의 원천이라 null이면 대다수 체험자의
// 배지가 사라진다. if (billing) 스타일 소비 금지(필드 단위로 읽을 것).
const pick = (data, trialEndsAt = null) => Response.json({
  billing: { plan: data?.plan ?? null, status: data?.ls_status ?? null, hasSub: !!data?.ls_subscription_id, endsAt: data?.ends_at ?? null, trialEndsAt },
});

const cols = 'plan, ls_status, ls_subscription_id, ls_customer_id, ends_at';

/** 유실 대사 폴백 — pro가 아닌데 결제가 있을 수 있는 상황에서만 LS API 대조(10분 쿨다운은 모듈이 관리).
    복구되면 재조회한 행을, 아니면 null을 돌려준다. 실패는 무해(다음 접근 때 재시도) — 응답을 깨지 않는다. */
async function reconcileIfLost({ url, serviceKey, user, cur }) {
  const apiKey = process.env.LEMONSQUEEZY_API_KEY;
  if (!apiKey || !serviceKey || !user?.id || !user.email) return null;
  if (user.id === 'local' || user.id === 'guest') return null; // 로컬·게스트는 구독 표면 없음
  if (cur?.plan === 'pro') return null; // 이미 pro — 대사 불요(강등은 웹훅의 몫)
  try {
    const sb = createClient(url, serviceKey, { auth: { persistSession: false } });
    const r = await reconcileEntitlement({
      sb, userId: user.id, email: user.email,
      storedCustomerId: cur?.ls_customer_id || null,
      apiKey, ...lsGateOpts(),
    });
    if (r?.result !== 'applied') return null;
    const { data } = await sb.from('entitlements').select(cols).eq('user_id', user.id).maybeSingle();
    return data ?? null;
  } catch (e) {
    console.error('[argo] billing 대사 실패(무해 — 다음 접근 때 재시도):', e?.message ?? e);
    return null;
  }
}

export async function GET() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url) return Response.json({ billing: null }); // 로컬 전용 — 결제 표면 없음
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
        const recovered = await reconcileIfLost({ url, serviceKey, user: { id: user.id, email: user.email ?? '' }, cur: data });
        return pick(recovered ?? data, trialEnd(user.created_at, (recovered ?? data)?.plan));
      }
    }
    // ② 기기 연동 세션 폴백 — 쿠키 세션이 없는 데스크톱. currentUser()가 기기 파일에서 검증한 id.
    const user = await currentUser();
    if (!user?.id || user.id === 'local' || user.id === 'guest' || !serviceKey) return Response.json({ billing: null });
    const sb = createClient(url, serviceKey, { auth: { persistSession: false } });
    const { data, error } = await sb.from('entitlements').select(cols).eq('user_id', user.id).maybeSingle();
    if (error) throw new Error(error.message);
    // 기기 세션엔 created_at이 없어 admin 조회 — 실패해도 배너만 빠질 뿐 화면은 유지.
    // admin 응답의 email은 **서버 검증본**이라 대사 조인 키로 안전하다 — 기기 세션 파일의 이메일은
    // 사용자가 편집 가능해 신뢰하면 안 된다(#163 검수 F3). 조회 실패 시 이메일 없이 호출돼 대사가 스킵된다.
    let created = null; let verifiedEmail = null;
    try {
      const r = await fetch(`${url}/auth/v1/admin/users/${encodeURIComponent(user.id)}`, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` }, signal: AbortSignal.timeout(5000) });
      if (r.ok) { const j = await r.json(); created = j?.created_at ?? null; verifiedEmail = j?.email ?? null; }
    } catch { /* 배너·대사 생략 */ }
    const recovered = await reconcileIfLost({ url, serviceKey, user: { id: user.id, email: verifiedEmail ?? '' }, cur: data });
    return pick(recovered ?? data, trialEnd(created, (recovered ?? data)?.plan));
  } catch (e) {
    console.error('[argo] me/billing 조회 실패:', e?.message ?? e);
    return Response.json({ billing: null }); // 조회 실패로 설정 화면을 깨지 않는다 — 배너만 사라진다
  }
}
