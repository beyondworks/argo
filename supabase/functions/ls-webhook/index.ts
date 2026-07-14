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

  let evt: { meta?: { event_name?: string; custom_data?: { user_id?: string } }; data?: { attributes?: { status?: string } } };
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
  // FK(auth.users)가 쓰레기 user_id를 거른다 — 실패는 500으로 드러내 LS가 재시도하게 둔다
  const { error } = await sb.from('entitlements').upsert({ user_id: userId, plan, updated_at: new Date().toISOString() });
  if (error) return new Response('db error', { status: 500 });
  return new Response(JSON.stringify({ ok: true, plan }), { headers: { 'content-type': 'application/json' } });
});
