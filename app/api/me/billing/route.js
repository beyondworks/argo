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
import { getFreshDeviceSession } from '../../../../src/devicesession.mjs'; // 설치본 결제 표면 — 서비스키 없이 RLS로
import { trialEnd, reconcileUnneeded } from '../../../../src/entitlement.mjs';
import { lsGateOpts } from '../../../../src/lsbilling.mjs';
import { reconcileDueFromRow, reconcileEntitlement } from '../../../../src/lsreconcile.mjs';

// 무행이어도 billing 객체를 반환한다 — 체험 배지(trialEndsAt)의 원천이라 null이면 대다수 체험자의
// 배지가 사라진다(#164). if (billing) 스타일 소비 금지(필드 단위로 읽을 것).
// billing=null일 때는 **reason으로 원인을 갈라 준다**(분리 검수 2026-08-19 MED-A/MED-1) — 예전엔
// 네 가지 원인(클라우드 미구성·미로그인/게스트·조회 수단 없음·조회 예외)이 전부 같은 null이라
// 화면이 구분할 수 없었고, 일시 장애가 "계정 없음"으로 읽혀 ① 기기 스코프 plan으로 폴백해 남의
// Pro 배지가 뜨고 ② 앱의 유일한 체크아웃 표면이 조용히 사라졌다.
//   'no-cloud'        — 클라우드 미구성(로컬 전용). 계정 개념 자체가 없다 → 기기값 폴백이 옳다.
//   'unauthenticated' — 미로그인·게스트. 마찬가지로 계정이 없다.
//   'unavailable'     — 조회 실패(예외·수단 없음). **계정은 있을 수 있다** → 기기값으로 메우지 말고
//                       화면이 "못 불러왔다"고 말해야 한다(무음 소실 금지).
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
  // 대사 불요 = **유효 pro + 구독 식별자 존재**. 원시 plan==='pro'를 믿으면 ends_at 경과(재개 웹훅
  // 유실) 사용자의 유일한 복구가 영구히 꺼지고(분리 검수 2026-07-30 HIGH), 유효 pro만 보면 이번엔
  // 부여 Pro(구독 없는 pro)의 복구가 영구히 꺼져 결제해도 hasSub가 안 붙는다(분리 검수 2026-08-19
  // HIGH-1 — 그 상태로 결제 카드가 계속 떠 중복 청구를 유인). 판정은 entitlement의 공유 술어로 —
  // is_pro(DB)·fetchPlan(sync)과 갈리면 잠금/복구 비대칭이 생긴다. 대사가 돌면 LS 현재값
  // (active면 ends_at null)이 apply_ls_event로 덮여 자격이 복구된다(lsbilling.mjs:165 확인).
  if (reconcileUnneeded(cur)) return false; // 강등은 여전히 웹훅·ends_at 경과의 몫
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
  if (!url) return Response.json({ billing: null, reason: 'no-cloud' }); // 로컬 전용 — 결제 표면 없음
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
    if (!user?.id || user.id === 'local' || user.id === 'guest') return Response.json({ billing: null, reason: 'unauthenticated' });
    // 데스크톱 설치본에는 **서비스키가 없다**(release.yml: 앱 빌드에 넣지 않는다). 서비스키를 요구하면
    // 설치본에서 billing이 항상 null이 되고, 화면은 기기 스코프 sync.plan으로 폴백해 체험 배지·업그레이드
    // 버튼이 통째로 사라진다 — 가입 1~14일차(체험 중) 사용자에게 결제 수단이 없던 이유(발행 전 검수
    // HIGH-2, 2026-08-07). 기기 세션의 액세스 토큰으로 **사용자 스코프** 클라이언트를 만들면
    // entitlements_own_select RLS가 방어선이 되어 서비스키 없이 자기 행만 읽는다
    // (me/billing/portal의 accessToken()과 같은 패턴). created_at도 그 토큰의 GoTrue /user에서 온다.
    const sess = process.env.ARGO_TENANT_OWNER?.trim() ? null : await getFreshDeviceSession().catch(() => null);
    const userClient = sess?.access_token
      ? createClient(url, sess.anonKey ?? anon, {
        auth: { persistSession: false },
        global: { headers: { Authorization: `Bearer ${sess.access_token}` } },
      })
      : null;
    if (!userClient && !serviceKey) return Response.json({ billing: null, reason: 'unavailable' }); // 둘 다 없으면 조회 수단이 없다
    const sb = userClient ?? createClient(url, serviceKey, { auth: { persistSession: false } });
    // 사용자 스코프는 RLS(own select)가 스코프를 강제하므로 .eq 없이도 자기 행뿐 — 서비스 롤일 때만
    // .eq가 유일 방어선이라 그 경로에만 붙인다(재검수 M5와 같은 근거).
    const q = sb.from('entitlements').select(cols);
    const { data, error } = await (userClient ? q.maybeSingle() : q.eq('user_id', user.id).maybeSingle());
    if (error) throw new Error(error.message);
    // 체험 D-day 배지(#164)의 created_at은 기기 세션 파일에 없어 서버에서 얻는다 — 실패해도 배지만 생략.
    // 사용자 스코프(설치본)는 GoTrue /user가 자기 created_at을 준다 — 서비스키 불요. 서비스 롤
    // 경로(워커 등)만 admin 조회. 대사는 비블록(F7). 기기 세션 파일 이메일은 신뢰 금지(F3) →
    // emailTrusted:false로 넘겨 대사 모듈이 서버 검증본을 직접 조회하게 한다.
    let created = null;
    try {
      if (userClient) {
        created = (await userClient.auth.getUser())?.data?.user?.created_at ?? null;
      } else {
        const r = await fetch(`${url}/auth/v1/admin/users/${encodeURIComponent(user.id)}`, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` }, signal: AbortSignal.timeout(5000) });
        if (r.ok) created = (await r.json())?.created_at ?? null;
      }
    } catch { /* 배지 생략 */ }
    const fired = scheduleReconcileIfLost({ url, serviceKey, user, cur: data, emailTrusted: false });
    return pick(data, trialEnd(created, data?.plan), fired);
  } catch (e) {
    console.error('[argo] me/billing 조회 실패:', e?.message ?? e);
    return Response.json({ billing: null, reason: 'unavailable' }); // 조회 실패로 설정 화면을 깨지 않는다 — 배너만 사라진다
  }
}
