// 구독 관리 포털 — 발급은 Edge Function(ls-portal)이 한다. **이 서버는 LS API 키를 갖지 않는다.**
//
// 왜: 데스크톱 앱은 사용자 기기에서 이 Next 서버를 돌린다. 여기에 LEMONSQUEEZY_API_KEY를 실으면
// 전 사용자에게 우리 결제 API 키가 배포된다(그 키로 남의 구독 조회·변경 가능).
// 그래서 키는 함수에만 두고, 이 라우트는 **사용자 토큰으로 함수를 부른 뒤 302만** 보낸다.
// 설계 정본: docs/billing-portal-design.md
//
// 왜 이 라우트가 남아 있나: `<a href>` 네비게이션은 Authorization 헤더를 못 싣는다. 함수를 직접
// 링크하면 인증이 실리지 않아 401이 된다. 그래서 앱 서버가 대신 부른다.
//
// 포털 URL은 24시간 만료 프리사인 링크라 저장·렌더하지 않고 **클릭 시점에** 발급한다.
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { currentUser } from '../../../../auth.mjs';
import { getFreshDeviceSession } from '../../../../../src/devicesession.mjs';

/** <a href> 네비게이션 대상이라 실패는 짧은 안내 텍스트로(브라우저 탭에 그대로 보인다). */
const fail = (msg, status = 503) => new Response(`${msg}\n(잠시 후 다시 시도해 주세요 / Please retry shortly)`, {
  status, headers: { 'content-type': 'text/plain; charset=utf-8' },
});

/** 사용자 액세스 토큰 — currentUser()와 같은 순서 계약: **쿠키 세션 > 기기 세션**(2026-08-06).
    기기 세션을 먼저 보면, 비루프백 노출 구성에서 쿠키로 로그인한 B에게 기기 주인 A의 토큰으로
    포털(구독 조회·결제수단·해지) 서명 링크가 발급된다 — 분리 검수 HIGH(fail-open). 토큰의
    소유자 id를 함께 돌려줘 라우트가 currentUser와 대조한다(불일치=fail-closed, cloudexport
    requesterId 대조와 같은 집 관례 — 두 해석이 미래에 갈려도 남의 토큰이 나가지 않는다). */
async function accessToken() {
  const store = await cookies();
  if (store.getAll().some((c) => c.name.startsWith('sb-'))) {
    const sb = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      { cookies: { getAll: () => store.getAll(), setAll: () => { /* 라우트에서는 세션 갱신 안 함 */ } } },
    );
    const { data } = await sb.auth.getSession();
    if (data?.session?.access_token) return { token: data.session.access_token, uid: data.session.user?.id ?? null };
  }
  if (!process.env.ARGO_TENANT_OWNER?.trim()) {
    const sess = await getFreshDeviceSession(); // 만료 임박 시 자체 회전
    if (sess?.access_token) return { token: sess.access_token, uid: sess.user?.id ?? null };
  }
  return null;
}

export async function GET() {
  const user = await currentUser();
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!user?.id || user.id === 'local' || user.id === 'guest' || !base) {
    return fail('구독 정보를 확인할 수 없습니다 / Cannot verify subscription'); // 로컬·게스트는 구독 표면 없음
  }
  const cred = await accessToken();
  if (!cred?.token) return fail('로그인이 필요합니다 / Please sign in', 401);
  // 신원=토큰 소유자 대조 — 인가(currentUser)와 토큰 조달이 다른 계정이면 발급 중단(fail-closed)
  if (cred.uid && cred.uid !== user.id) return fail('로그인이 만료됐습니다 — 다시 로그인해 주세요 / Session expired — please sign in again', 401);
  const token = cred.token;

  let r, j;
  try {
    r = await fetch(`${base}/functions/v1/ls-portal`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(9000),
    });
    j = await r.json().catch(() => null);
  } catch (e) {
    console.error('[argo] billing portal 호출 실패:', e?.message ?? e);
    return fail('구독 관리 페이지를 열지 못했습니다 / Could not open the subscription portal');
  }

  if (r.ok && j?.url) {
    // 개인별 서명 링크 — 중간 캐시에 남지 않게 명시(재검수 LOW)
    return new Response(null, { status: 302, headers: { Location: j.url, 'Cache-Control': 'no-store, private' } });
  }

  // 원인별 안내 — "안 됩니다"로 끝내지 않는다(막다른 길 금지). code는 함수가 내려주는 분류값.
  if (j?.code === 'no-sub') return fail('연결된 구독이 없습니다 — 설정에서 업그레이드할 수 있습니다 / No linked subscription — you can upgrade in Settings', 404);
  if (j?.code === 'no-api-key') return fail('결제 연동이 아직 설정되지 않았습니다 / Billing is not configured yet');
  if (j?.code === 'no-token' || j?.code === 'bad-token') return fail('로그인이 만료됐습니다 — 다시 로그인해 주세요 / Session expired — please sign in again', 401);
  console.error('[argo] billing portal 발급 실패:', r?.status, j?.code ?? j?.error ?? '');
  return fail('구독 관리 페이지를 열지 못했습니다 / Could not open the subscription portal');
}
