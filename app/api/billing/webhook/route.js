// 레몬스퀴지 웹훅 — 구독 상태를 entitlements로 환산하는 유일한 쓰기 지점(M-4).
// 서명 검증(HMAC X-Signature) → 상태 매핑(src/lsbilling.mjs) → 서비스 롤 upsert.
// 보안: 미설정·서명 불일치 모두 401로 동일 응답(미인증 프로빙에 설정 상태를 노출하지 않는다 — 재검수 LOW).
// 멱등: 상태 스냅샷 upsert라 재전송 무해. 순서 역전은 ls_updated_at 비교로 스킵(동시 전달의 완전
// 원자화는 후속 — DB 조건부 update로 내릴 것, 재검수 M1).
// ⚠ LS 재시도는 3회·약 155초(5s→25s→125s)가 전부다 — 그 안에 200을 못 주면 이벤트는 영구 유실되고
// 재조정 경로가 없다(재검수 O2). 그래서 5xx 경로는 [유실 위험] 접두 로그로 크게 남긴다 — 후속 대사(reconcile) 예정.
import { createClient } from '@supabase/supabase-js';
import { verifyLsSignature, mapSubscriptionEvent, isStaleEvent, isOtherSubscriptionDowngrade } from '../../../../src/lsbilling.mjs';

export async function POST(req) {
  const secret = process.env.LEMONSQUEEZY_WEBHOOK_SECRET;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret || !url || !serviceKey) {
    console.error('[argo] billing webhook [유실 위험] env 미설정 — 이벤트가 155초 내 영구 유실된다:',
      { secret: !!secret, url: !!url, serviceKey: !!serviceKey });
    return Response.json({ error: 'unauthorized' }, { status: 401 }); // 프로빙에 미설정을 노출하지 않는다
  }
  if (Number(req.headers.get('content-length') || 0) > 1_000_000) {
    // 헤더 신뢰 기반 best-effort — chunked 전송은 통과한다(플랫폼 body 제한이 최종 방어)
    return Response.json({ error: 'too large' }, { status: 413 });
  }
  const raw = await req.text();
  if (!verifyLsSignature(raw, req.headers.get('x-signature'), secret)) {
    return Response.json({ error: 'bad signature' }, { status: 401 });
  }
  let payload;
  try { payload = JSON.parse(raw); } catch { return Response.json({ error: 'bad json' }, { status: 400 }); }

  const eventName = payload?.meta?.event_name ?? req.headers.get('x-event-name') ?? '';
  const allowedVariants = new Set(String(process.env.LEMONSQUEEZY_PRO_VARIANT_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean));
  const mapped = mapSubscriptionEvent(eventName, payload, {
    allowedVariants: allowedVariants.size ? allowedVariants : null,
    allowTest: process.env.LEMONSQUEEZY_ALLOW_TEST === '1',
  });
  if (!mapped) return Response.json({ ok: true, ignored: eventName }); // 미처리 이벤트 — 200(재시도 방지)
  if (mapped.error) {
    // 결제는 됐는데 귀속 불가(custom user_id 누락·상품 불일치 등) — 조용히 버리면 유령 결제가 된다.
    // other-product는 특히 오설정(PRO_VARIANT_IDS에 월간·연간 중 하나 누락)일 가능성이 높아 [유실 위험]으로.
    console.error('[argo] billing webhook [유실 위험] 귀속 실패:', eventName, mapped.error,
      'sub=', payload?.data?.id, 'email=', payload?.data?.attributes?.user_email ?? '?');
    return Response.json({ ok: true, unmatched: mapped.error });
  }

  const sb = createClient(url, serviceKey, { auth: { persistSession: false } });
  const { data: cur, error: selErr } = await sb.from('entitlements')
    .select('ls_updated_at, ls_subscription_id').eq('user_id', mapped.userId).maybeSingle();
  if (selErr) {
    console.error('[argo] billing webhook [유실 위험] 조회 실패 — LS 재시도는 3회뿐:', selErr.message);
    return Response.json({ error: selErr.message }, { status: 500 });
  }
  if (cur && isStaleEvent(mapped.ls_updated_at, cur.ls_updated_at)) {
    return Response.json({ ok: true, stale: true }); // 재시도 역전 — 최신 상태 유지
  }
  if (isOtherSubscriptionDowngrade(mapped, cur)) { // 구독 신원 가드(O1) — 로직·시나리오는 lsbilling.mjs
    return Response.json({ ok: true, otherSubscription: true });
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
  if (upErr) {
    console.error('[argo] billing webhook [유실 위험] 쓰기 실패 — LS 재시도는 3회뿐:', upErr.message);
    return Response.json({ error: upErr.message }, { status: 500 });
  }
  return Response.json({ ok: true, plan: mapped.plan, status: mapped.ls_status });
}
