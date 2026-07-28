// 레몬스퀴지 웹훅 — 구독 상태를 entitlements로 환산하는 유일한 쓰기 지점(M-4).
// 서명 검증(HMAC X-Signature) → 상태 매핑(src/lsbilling.mjs) → 서비스 롤 원자 적용.
// 보안: 미설정·서명 불일치 모두 401로 동일 응답(미인증 프로빙에 설정 상태를 노출하지 않는다 — 재검수 LOW).
// 멱등: 상태 스냅샷이라 재전송 무해. 순서 역전·구독 신원 가드는 DB 함수 apply_ls_event 한 문장에서
// 행 잠금과 함께 판정된다(M1 원자화 — 동시 전달에서 과거 상태가 최종으로 남던 race 제거).
// ⚠ LS 재시도는 3회·약 155초(5s→25s→125s)가 전부다 — 그 안에 200을 못 주면 이벤트는 유실된다.
// 그래서 5xx 경로는 [유실 위험] 접두 로그로 크게 남긴다. 유실 시 최후 방어는 /api/me/billing의
// 대사(src/lsreconcile.mjs, O2)가 LS API 대조로 복구한다.
import { createClient } from '@supabase/supabase-js';
import { verifyLsSignature, mapSubscriptionEvent, applyLsEvent, unmatchedRow, lsGateOpts } from '../../../../src/lsbilling.mjs';

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
  const mapped = mapSubscriptionEvent(eventName, payload, lsGateOpts());
  if (!mapped) return Response.json({ ok: true, ignored: eventName }); // 미처리 이벤트 — 200(재시도 방지)

  const sb = createClient(url, serviceKey, { auth: { persistSession: false } });
  if (mapped.error) {
    // 결제는 됐는데 귀속 불가(custom user_id 누락·상품 불일치 등) — 조용히 버리면 유령 결제가 된다.
    // other-product는 특히 오설정(PRO_VARIANT_IDS에 월간·연간 중 하나 누락)일 가능성이 높아 [유실 위험]으로.
    console.error('[argo] billing webhook [유실 위험] 귀속 실패:', eventName, mapped.error,
      'sub=', payload?.data?.id, 'email=', payload?.data?.attributes?.user_email ?? '?');
    // M4: billing_unmatched 적재 — 수동 귀속의 근거. 같은 (구독,사유)는 1행(dedup 인덱스).
    // 적재 실패는 로그만 — 여기서 5xx를 주면 정상 웹훅 흐름까지 LS 재시도에 말려든다.
    const { error: insErr } = await sb.from('billing_unmatched')
      .upsert(unmatchedRow(eventName, mapped.error, payload), { onConflict: 'ls_subscription_id,reason', ignoreDuplicates: true });
    if (insErr) console.error('[argo] billing webhook 미귀속 적재 실패(수동 귀속 근거 유실):', insErr.message);
    return Response.json({ ok: true, unmatched: mapped.error });
  }

  let result;
  try {
    result = await applyLsEvent(sb, mapped); // 'applied' | 'stale' | 'other_subscription'
  } catch (e) {
    console.error('[argo] billing webhook [유실 위험] 쓰기 실패 — LS 재시도는 3회뿐:', e.message);
    return Response.json({ error: e.message }, { status: 500 });
  }
  if (result === 'stale') return Response.json({ ok: true, stale: true }); // 재시도 역전 — 최신 상태 유지
  if (result === 'other_subscription') return Response.json({ ok: true, otherSubscription: true }); // 신원 가드(O1)
  return Response.json({ ok: true, plan: mapped.plan, status: mapped.ls_status });
}
