// LS(Lemon Squeezy) 결제 웹훅 — entitlements의 유일한 쓰기 경로(서비스 롤).
// 서명(X-Signature, HMAC-SHA256 hex) 검증 실패는 401 — 위조 페이로드로 plan을 못 바꾼다.
// 이벤트: 라이프사이클 이벤트만 화이트리스트 처리(LIFECYCLE). subscription_payment_*는 인보이스
//       객체라 status 시맨틱이 달라 명시 제외 — 안 그러면 payment_success(status:'paid')가
//       구독 상태로 오인되어 유료 사용자를 강등시킬 수 있다. 화이트리스트 밖은 200 무시.
// 매핑: status가 active/on_trial/past_due/cancelled(말일까지 이용 유지) → pro,
//       expired/unpaid/paused → free. 그 외 미지 상태는 쓰기 없이 200 무시(신규 상태 방어).
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

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });
  const secret = Deno.env.get('LS_WEBHOOK_SECRET');
  if (!secret) return new Response('webhook not configured', { status: 500 });
  const raw = await req.text();
  const sig = req.headers.get('x-signature') ?? '';
  if (!safeEqual(await hmacHex(secret, raw), sig)) return new Response('invalid signature', { status: 401 });

  let evt: { meta?: { event_name?: string; custom_data?: { user_id?: string } }; data?: { id?: string; attributes?: { status?: string; ends_at?: string | null; customer_id?: number; updated_at?: string } } };
  try { evt = JSON.parse(raw); } catch { return new Response('bad json', { status: 400 }); }
  const name = String(evt?.meta?.event_name ?? '');
  if (!LIFECYCLE.has(name)) return new Response('ignored', { status: 200 });
  const userId = evt?.meta?.custom_data?.user_id;
  if (!userId) return new Response('missing user_id', { status: 400 });
  const status = String(evt?.data?.attributes?.status ?? '');
  let plan: string;
  if (PRO_STATUS.has(status)) plan = 'pro';
  else if (FREE_STATUS.has(status)) plan = 'free';
  else return new Response('unknown status ignored', { status: 200 }); // 미지 상태 — 강등 금지(순서 역전·신규 상태 방어)

  const sb = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  );
  // FK(auth.users)가 쓰레기 user_id를 거른다 — 실패는 500으로 드러내 LS가 재시도하게 둔다.
  // ends_at 동반 필수(2026-07-30) — is_pro가 ends_at을 집행하게 되면서, plan만 쓰면 해지→재개 시
  // 옛 해지일이 행에 남아 그 날짜에 결정론적으로 잠긴다(분리 검수 MEDIUM: PostgREST upsert는
  // 페이로드에 있는 컬럼만 갱신). LS 계약: active류는 ends_at null, cancelled/expired만 시각.
  // ls_* 동반(재검수 MEDIUM-D) — 이 경로만 쓰면 hasSub·status가 비어 해지 유예 안내·구독 관리 링크가
  // 렌더되지 않는다(접근 회수 예고 없는 잠금). 정본 경로(apply_ls_event)와 같은 필드를 채운다.
  // ⚠ 이 함수는 레거시 수신자 — 정본은 /api/billing/webhook(apply_ls_event 경유, docs/billing-setup.md).
  //   LS 대시보드가 어느 URL을 가리키는지 확정 전까지 두 수신자를 같은 필드 계약으로 유지한다.
  const a = evt?.data?.attributes ?? {};
  const { error } = await sb.from('entitlements').upsert({
    user_id: userId, plan,
    ends_at: a.ends_at ?? null,
    ls_subscription_id: evt?.data?.id ?? null,
    ls_customer_id: a.customer_id != null ? String(a.customer_id) : null,
    ls_status: status,
    ls_updated_at: a.updated_at ?? new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  if (error) return new Response('db error', { status: 500 });
  return new Response(JSON.stringify({ ok: true, plan }), { headers: { 'content-type': 'application/json' } });
});
