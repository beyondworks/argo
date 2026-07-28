// 내 구독 상태 — 설정 카드의 연체 배너·구독 관리 링크 노출 판단의 원천.
// 쿠키 세션이 있으면 **사용자 클라이언트**로 조회한다 — entitlements_own_select RLS가 타인 행
// 노출을 구조적으로 막는다(서비스 롤이면 .eq 한 줄이 유일 방어선 — 재검수 M5). 기기 연동
// 세션(쿠키 없음, 데스크톱 다수)만 서비스 롤로 폴백하되 검증된 기기 세션의 user.id로만 조회.
// portal_url은 내리지 않는다 — 24시간 만료 스냅샷이라 렌더 금지(클릭 시점 발급: ./portal).
// [O2] 유실 대사: plan이 free/무행인데 LS에 활성 구독이 있으면 복구한다(웹훅 유실 최후 방어).
// 대사는 **백그라운드**(분리 검수 F7) — 응답은 현재 상태를 즉시 주고, LS 대조(최대 6초)로
// 응답을 잡아두지 않는다. 응답의 reconciling=true가 "방금 대사를 발사했다" 신호 — 클라이언트
// (설정 카드)가 잠시 뒤 1회 재조회해 복구를 리로드 없이 반영한다(웹 표면은 billing 폴링이 없다).
import { after } from 'next/server';
import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';
import { createClient } from '@supabase/supabase-js';
import { currentUser } from '../../../auth.mjs';
import { trialEnd } from '../../../../src/entitlement.mjs';
import { lsGateOpts } from '../../../../src/lsbilling.mjs';
import { reconcileDueFromRow, reconcileEntitlement } from '../../../../src/lsreconcile.mjs';

// 무행이어도 billing 객체를 반환한다 — 체험 배지(trialEndsAt)의 원천이라 null이면 대다수 체험자의
// 배지가 사라진다(#164). if (billing) 스타일 소비 금지(필드 단위로 읽을 것).
// reconciling = 이번 요청이 대사를 띄웠는가(비블록 — 클라가 잠시 후 재조회할 신호, F7).
const pick = (data, trialEndsAt = null, reconciling = false) => Response.json({
  billing: { plan: data?.plan ?? null, status: data?.ls_status ?? null, hasSub: !!data?.ls_subscription_id, endsAt: data?.ends_at ?? null, trialEndsAt },
  reconciling,
});

const cols = 'plan, ls_status, ls_subscription_id, ls_customer_id, ends_at, ls_reconciled_at, ls_reconcile_empty_at';

/** 유실 대사 백그라운드 발사 — pro가 아닌데 결제가 있을 수 있는 상황에서만. 쿨다운은 DB 공유
    (선점은 reconcileEntitlement 안의 원자 claim, 여기의 reconcileDueFromRow는 이미 읽은 행으로
    쿨다운 중 헛 쿼리를 없애는 사전 필터). after()로 응답 이후에 돌린다 — 실패는 무해(로그만,
    다음 접근 때 재시도). 반환: 발사 여부(응답의 reconciling 신호).
    emailTrusted=false(기기 세션): 로컬 파일의 이메일은 사용자가 편집 가능해 LS 조인 키로 못 쓴다
    (분리 검수 F3 — 피해자 이메일로 바꿔 타인 구독을 획득) → auth.users에서 서버 검증 이메일로 대체. */
function scheduleReconcileIfLost({ url, serviceKey, user, cur, emailTrusted }) {
  const apiKey = process.env.LEMONSQUEEZY_API_KEY;
  if (!apiKey || !serviceKey || !user?.id) return false;
  if (user.id === 'local' || user.id === 'guest') return false; // 로컬·게스트는 구독 표면 없음
  if (cur?.plan === 'pro') return false; // 이미 pro — 대사 불요(강등은 웹훅의 몫)
  if (!reconcileDueFromRow(cur)) return false; // 쿨다운 중 — 대부분의 폴은 여기서 무쿼리로 끝난다
  after(async () => {
    try {
      const sb = createClient(url, serviceKey, { auth: { persistSession: false } });
      let email = emailTrusted ? user.email : '';
      if (!emailTrusted) {
        const { data, error } = await sb.auth.admin.getUserById(user.id);
        if (error) throw new Error(error.message);
        email = data?.user?.email ?? '';
      }
      if (!email) return;
      await reconcileEntitlement({
        sb, userId: user.id, email,
        storedCustomerId: cur?.ls_customer_id || null,
        apiKey, ...lsGateOpts(),
      });
    } catch (e) {
      console.error('[argo] billing 대사 실패(무해 — 다음 접근 때 재시도):', e?.message ?? e);
    }
  });
  return true;
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
        // 쿠키 경로 이메일은 검증된 JWT에서 온 값 — 신뢰 가능
        const fired = scheduleReconcileIfLost({ url, serviceKey, user: { id: user.id, email: user.email ?? '' }, cur: data, emailTrusted: true });
        return pick(data, trialEnd(user.created_at, data?.plan), fired);
      }
    }
    // ② 기기 연동 세션 폴백 — 쿠키 세션이 없는 데스크톱. currentUser()가 기기 파일에서 검증한 id.
    const user = await currentUser();
    if (!user?.id || user.id === 'local' || user.id === 'guest' || !serviceKey) return Response.json({ billing: null });
    const sb = createClient(url, serviceKey, { auth: { persistSession: false } });
    const { data, error } = await sb.from('entitlements').select(cols).eq('user_id', user.id).maybeSingle();
    if (error) throw new Error(error.message);
    // 체험 D-day 배지(#164)의 created_at은 기기 세션에 없어 admin 조회로 얻는다 — 실패해도 배지만 생략.
    // 대사는 비블록(F7)이라 응답을 기다리지 않는다. 기기 세션 파일 이메일은 신뢰 금지(F3) →
    // emailTrusted:false로 넘겨 대사 모듈이 서버 검증본을 직접 조회하게 한다.
    let created = null;
    try {
      const r = await fetch(`${url}/auth/v1/admin/users/${encodeURIComponent(user.id)}`, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` }, signal: AbortSignal.timeout(5000) });
      if (r.ok) created = (await r.json())?.created_at ?? null;
    } catch { /* 배지 생략 */ }
    const fired = scheduleReconcileIfLost({ url, serviceKey, user, cur: data, emailTrusted: false });
    return pick(data, trialEnd(created, data?.plan), fired);
  } catch (e) {
    console.error('[argo] me/billing 조회 실패:', e?.message ?? e);
    return Response.json({ billing: null }); // 조회 실패로 설정 화면을 깨지 않는다 — 배너만 사라진다
  }
}
