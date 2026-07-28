// 구독 관리 포털 — 클릭 시점 발급(재검수 HIGH). LS 포털 URL은 발급 24시간 만료 프리사인 링크라
// 웹훅 스냅샷을 렌더하면 정상 구독자 거의 전원이 죽은 링크를 받는다(다음 웹훅은 한 달 뒤 갱신 때).
// 그래서 저장된 ls_subscription_id로 클릭 순간 LS API에서 신선한 URL을 받아 302로 보낸다.
import { currentUser } from '../../../../auth.mjs';
import { createClient } from '@supabase/supabase-js';

export async function GET() {
  const user = await currentUser();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const apiKey = process.env.LEMONSQUEEZY_API_KEY;
  // <a href> 네비게이션 대상이라 실패는 짧은 안내 텍스트로(브라우저 탭에 그대로 보인다).
  const fail = (msg) => new Response(`${msg}\n(잠시 후 다시 시도해 주세요 / Please retry shortly)`, {
    status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
  if (!user?.id || !url || !serviceKey) return fail('구독 정보를 확인할 수 없습니다 / Cannot verify subscription');
  if (!apiKey) return fail('결제 연동이 아직 설정되지 않았습니다 / Billing is not configured yet');
  try {
    const sb = createClient(url, serviceKey, { auth: { persistSession: false } });
    const { data, error } = await sb.from('entitlements')
      .select('ls_subscription_id').eq('user_id', user.id).maybeSingle();
    if (error) throw new Error(error.message);
    if (!data?.ls_subscription_id) return fail('연결된 구독이 없습니다 / No linked subscription');
    const r = await fetch(`https://api.lemonsqueezy.com/v1/subscriptions/${encodeURIComponent(data.ls_subscription_id)}`, {
      headers: { Accept: 'application/vnd.api+json', Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) throw new Error(`LS API ${r.status}`);
    const j = await r.json();
    const portal = j?.data?.attributes?.urls?.customer_portal;
    if (!portal) throw new Error('portal url 없음');
    return Response.redirect(portal, 302);
  } catch (e) {
    console.error('[argo] billing portal 발급 실패:', e?.message ?? e);
    return fail('구독 관리 페이지를 열지 못했습니다 / Could not open the subscription portal');
  }
}
