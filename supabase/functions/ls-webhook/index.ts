// LS(Lemon Squeezy) 결제 웹훅 — 운영에서 결제를 받는 유일한 수신자(서비스 롤). entitlements 쓰기는 정본 RPC
// apply_ls_event 하나로만 한다(순서 역전·구독 신원·granted 가드가 그 안에서 행 잠금과 함께 판정된다).
// 서명(X-Signature, HMAC-SHA256 hex) 검증 실패는 401 — 위조 페이로드로 plan을 못 바꾼다.
// 이벤트: 라이프사이클 이벤트만 화이트리스트 처리(LIFECYCLE). subscription_payment_*는 인보이스
//       객체라 status 시맨틱이 달라 명시 제외 — 안 그러면 payment_success(status:'paid')가
//       구독 상태로 오인되어 유료 사용자를 강등시킬 수 있다. 화이트리스트 밖은 200 무시.
// 매핑: status가 active/on_trial/past_due/cancelled(말일까지 이용 유지) → pro,
//       expired/unpaid/paused → free. 그 외 미지 상태는 쓰기 없이 200 무시(신규 상태 방어).
// 계정 연결(2026-10-03): 앱 설정의 결제 버튼은 custom user_id를 붙이지만 랜딩 결제 링크는 붙이지 않는다.
//   예전에는 user_id가 없으면 400으로 끝나 실결제 2건(9/27·10/3)이 Pro에 연결되지 않았고 기록도 남지 않았다.
//   ① user_id가 있으면 그 계정 — 같은 구독이 이미 다른 계정에 붙어 있으면 적용하지 않는다(1결제 N계정 Pro 차단 —
//   대사 src/lsreconcile.mjs의 duplicate-attribution 가드와 같은 조회).
//   ② user_id가 없으면 먼저 그 구독 번호에 이미 연결된 계정(entitlements.ls_subscription_id). 정확히 한 계정이면 그 계정 —
//   서명된 웹훅이나 운영자가 만든 연결이라 믿는다(결제 이메일 ≠ 계정 이메일이라 손으로 연결한 구독의 해지·만료도
//   그 계정에 반영되게). 두 계정 이상이면(정상이면 없다) 적용하지 않는다. 구독 번호가 비면 건너뛴다.
//   ③ 연결된 계정이 없으면 결제 이메일과 같은 이메일로 인증된 계정이 정확히 하나일 때만(public.ls_user_by_email).
//   못 찾았거나 연결하지 않은 건은 billing_unmatched에 남기고 200 — LS가 재시도해도 결과가 같다.
//   로그에는 구독 번호와 가린 이메일만 남긴다.
// 응답: stale·other_subscription은 셀프호스트 수신자(app/api/billing/webhook/route.js)와 같은 200 본문.
//       DB 오류는 500 — LS 재시도(3회·약 155초)로 한 번 더 기회를 준다.
// 테스트: test/ls-webhook-edge.test.mjs(이 파일을 타입만 지워 node vm에서 실행),
//         test/billing-pg-integration.test.mjs(같은 실행을 실제 Postgres 마이그레이션에 붙여서).
import { createClient } from 'npm:@supabase/supabase-js@2';

const enc = new TextEncoder();

async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(body));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// 타이밍 안전 비교 — 길이가 달라도 동일 시간 소모
function safeEqual(a: string, b: string): boolean {
  const ab = enc.encode(a), bb = enc.encode(b);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < Math.max(ab.length, bb.length, 1); i++) {
    diff |= (ab[i % (ab.length || 1)] ?? 0) ^ (bb[i % (bb.length || 1)] ?? 0);
  }
  return diff === 0;
}

const LIFECYCLE = new Set([
  'subscription_created',
  'subscription_updated',
  'subscription_cancelled',
  'subscription_resumed',
  'subscription_expired',
  'subscription_paused',
  'subscription_unpaused',
  'subscription_plan_changed',
]);
const PRO_STATUS = new Set(['active', 'on_trial', 'past_due', 'cancelled']); // cancelled = 말일까지 유지
const FREE_STATUS = new Set(['expired', 'unpaid', 'paused']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type LsEvent = {
  meta?: { event_name?: string; custom_data?: { user_id?: unknown } | null };
  data?: {
    id?: string | number;
    attributes?: {
      status?: string; ends_at?: string | null; customer_id?: number | string | null; updated_at?: string | null;
      test_mode?: boolean; user_email?: string | null; urls?: { customer_portal?: string | null } | null;
    };
  };
};

// 로그용 — 결제 이메일은 첫 글자와 도메인만 남긴다(pay@example.com → p***@example.com).
function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1) return email ? '***' : '?';
  return `${email[0]}***${email.slice(at)}`;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });
  const secret = Deno.env.get('LS_WEBHOOK_SECRET');
  if (!secret) return new Response('webhook not configured', { status: 500 });
  const raw = await req.text();
  const sig = req.headers.get('x-signature') ?? '';
  if (!safeEqual(await hmacHex(secret, raw), sig)) return new Response('invalid signature', { status: 401 });

  let evt: LsEvent;
  try { evt = JSON.parse(raw); } catch { return new Response('bad json', { status: 400 }); }
  // test_mode 결제는 실 Pro를 부여하지 않는다 — 정본(src/lsbilling.mjs)과 같은 계약.
  // 이 수신자에만 게이트가 없어 실사고가 났다(2026-09-01: 테스트 주문 9356084 → 실 계정 pro 부여,
  // LS 정산액 0). LS_ALLOW_TEST=1을 명시한 스테이징에서만 수용한다. 200 = LS 무한 재시도 방지.
  if (evt?.data?.attributes?.test_mode && Deno.env.get('LS_ALLOW_TEST') !== '1') {
    return new Response('test mode ignored', { status: 200 });
  }
  const name = String(evt?.meta?.event_name ?? '');
  if (!LIFECYCLE.has(name)) return new Response('ignored', { status: 200 });
  const a = evt?.data?.attributes ?? {};
  const status = String(a.status ?? '');
  // 상태 판정을 계정 찾기보다 먼저 한다 — 미지 상태는 DB를 읽지도 쓰지도 않고 끝낸다(순서 역전·신규 상태 방어).
  const plan = PRO_STATUS.has(status) ? 'pro' : FREE_STATUS.has(status) ? 'free' : null;
  if (!plan) return new Response('unknown status ignored', { status: 200 });

  const subId = String(evt?.data?.id ?? '');
  const email = String(a.user_email ?? '').trim();
  const tag = `sub=${subId || '?'} email=${maskEmail(email)}`;
  const sb = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  );
  const dbError = (what: string, message: string) => {
    console.error(`[ls-webhook] [유실 위험] ${what} 실패 ${tag}: ${message}`);
    return new Response('db error', { status: 500 });
  };
  // 연결하지 못한 결제 — 수동 연결의 근거로 billing_unmatched에 남긴다(src/lsbilling.mjs unmatchedRow와 같은 필드).
  // 같은 (구독, 사유)는 1행. 기록 실패는 로그만 — 셀프호스트 수신자와 같다(여기서 5xx를 주면 재시도만 늘고 결과는 같다).
  const unmatched = async (reason: string) => {
    const { error } = await sb.from('billing_unmatched').upsert({
      event_name: name,
      reason,
      ls_subscription_id: subId,
      ls_customer_id: String(a.customer_id ?? ''),
      user_email: String(a.user_email ?? ''),
    }, { onConflict: 'ls_subscription_id,reason', ignoreDuplicates: true });
    if (error) console.error(`[ls-webhook] 미연결 기록 실패(수동 연결 근거 없음) ${tag}: ${error.message}`);
    console.warn(`[ls-webhook] 연결 안 함(${reason}) — billing_unmatched ${tag}`);
    return json({ ok: true, unmatched: reason });
  };

  // 구독 번호로 entitlements를 볼 때는 번호가 있을 때만 — 빈 값으로 조회하면 구독 번호 없는 옛 행 전부가 걸린다.
  // ① custom user_id — 앱 설정의 결제 버튼(app/c/[ws]/settings/checkout-link.mjs)이 붙인다. 정본과 같이 UUID일 때만 쓴다.
  const customId = evt?.meta?.custom_data?.user_id;
  let userId = typeof customId === 'string' && UUID_RE.test(customId) ? customId.toLowerCase() : null;
  let via = 'user_id';
  if (userId) {
    // 같은 구독이 이미 다른 계정에 붙어 있으면 적용하지 않는다.
    if (subId) {
      const { data: dupes, error } = await sb.from('entitlements')
        .select('user_id').eq('ls_subscription_id', subId).neq('user_id', userId).limit(1);
      if (error) return dbError('중복 연결 확인', error.message);
      if (dupes?.length) return unmatched('duplicate-attribution');
    }
  } else {
    // ② user_id가 없으면(랜딩 결제 링크) 먼저 그 구독에 이미 연결된 계정 — 정확히 한 계정이면 그 계정.
    if (subId) {
      const { data: linked, error } = await sb.from('entitlements')
        .select('user_id').eq('ls_subscription_id', subId).limit(2);
      if (error) return dbError('구독 연결 확인', error.message);
      if ((linked?.length ?? 0) > 1) return unmatched('duplicate-attribution');
      if (linked?.length === 1) { userId = String(linked[0].user_id); via = 'subscription'; }
    }
    // ③ 연결된 계정이 없으면 결제 이메일로 — 인증된 계정이 정확히 하나일 때만 id가 온다.
    //    (②에서 이 구독에 연결된 계정이 없음을 봤으니 다른 계정 연결 확인은 다시 하지 않는다.)
    if (!userId) {
      via = 'email';
      if (!email) return unmatched('no-user');
      const { data, error } = await sb.rpc('ls_user_by_email', { p_email: email });
      if (error) return dbError('계정 찾기', error.message);
      if (typeof data !== 'string' || !UUID_RE.test(data)) return unmatched('no-user');
      userId = data.toLowerCase();
    }
  }
  // 적용 — 인자는 정본 src/lsbilling.mjs mapSubscriptionEvent·applyLsEvent와 같다
  // (test/ls-webhook-edge.test.mjs가 같은 페이로드로 두 쪽 인자를 대조한다).
  const { data: result, error } = await sb.rpc('apply_ls_event', {
    p_user_id: userId,
    p_plan: plan,
    p_sub_id: subId,
    p_customer_id: String(a.customer_id ?? ''),
    p_status: status,
    // null 폴백 — now()를 넣으면 "알 수 없음"이 "확실히 최신"이 되어 이후 진짜 이벤트가 stale로 버려진다(재검수 MEDIUM-G).
    p_updated_at: a.updated_at ?? null,
    p_ends_at: a.ends_at ?? null,
    p_portal_url: a.urls?.customer_portal ?? null,
  });
  if (error) return dbError('적용', error.message);
  console.log(`[ls-webhook] ${result} via=${via} plan=${plan} status=${status} ${tag}`);
  if (result === 'stale') return json({ ok: true, stale: true }); // 재시도 역전 — 최신 상태 유지
  if (result === 'other_subscription') return json({ ok: true, otherSubscription: true }); // 다른 구독의 강등 차단(O1)
  return json({ ok: true, plan, status });
});
