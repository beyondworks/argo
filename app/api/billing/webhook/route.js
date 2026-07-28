// 레몬스퀴지 웹훅 — 구독 상태를 entitlements로 환산하는 유일한 쓰기 지점(M-4).
// 서명 검증(HMAC X-Signature) → 상태 매핑(src/lsbilling.mjs) → 서비스 롤 upsert.
// 보안: 시크릿 미설정이면 503(fail-closed — 검증 없이 열리지 않는다). 서명 불일치 401.
// 멱등: 상태 스냅샷 upsert라 재전송 무해. 순서 역전은 ls_updated_at 비교로 스킵.
import { createClient } from '@supabase/supabase-js';
import { verifyLsSignature, mapSubscriptionEvent, isStaleEvent } from '../../../../src/lsbilling.mjs';

export async function POST(req) {
  const secret = process.env.LEMONSQUEEZY_WEBHOOK_SECRET;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret || !url || !serviceKey) {
    return Response.json({ error: 'billing not configured' }, { status: 503 });
  }
  const raw = await req.text();
  if (!verifyLsSignature(raw, req.headers.get('x-signature'), secret)) {
    return Response.json({ error: 'bad signature' }, { status: 401 });
  }
  let payload;
  try { payload = JSON.parse(raw); } catch { return Response.json({ error: 'bad json' }, { status: 400 }); }

  const eventName = payload?.meta?.event_name ?? req.headers.get('x-event-name') ?? '';
  const mapped = mapSubscriptionEvent(eventName, payload);
  if (!mapped) return Response.json({ ok: true, ignored: eventName }); // 미처리 이벤트 — 200(재시도 방지)
  if (mapped.error) {
    // 결제는 됐는데 귀속 불가(custom user_id 누락 등) — 조용히 버리면 유령 결제가 된다. 로그로 드러낸다.
    console.error('[argo] billing webhook 귀속 실패:', eventName, mapped.error, 'sub=', payload?.data?.id);
    return Response.json({ ok: true, unmatched: mapped.error });
  }

  const sb = createClient(url, serviceKey, { auth: { persistSession: false } });
  const { data: cur, error: selErr } = await sb.from('entitlements')
    .select('ls_updated_at').eq('user_id', mapped.userId).maybeSingle();
  if (selErr) return Response.json({ error: selErr.message }, { status: 500 }); // 5xx → LS가 재시도해 준다
  if (cur && isStaleEvent(mapped.ls_updated_at, cur.ls_updated_at)) {
    return Response.json({ ok: true, stale: true }); // 재시도 역전 — 최신 상태 유지
  }
  const { error: upErr } = await sb.from('entitlements').upsert({
    user_id: mapped.userId,
    plan: mapped.plan,
    ls_subscription_id: mapped.ls_subscription_id,
    ls_customer_id: mapped.ls_customer_id,
    ls_status: mapped.ls_status,
    ls_updated_at: mapped.ls_updated_at,
    ends_at: mapped.ends_at,
    portal_url: mapped.portal_url,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'user_id' });
  if (upErr) return Response.json({ error: upErr.message }, { status: 500 });
  return Response.json({ ok: true, plan: mapped.plan, status: mapped.ls_status });
}
