// LS(Lemon Squeezy) 결제 웹훅 — entitlements의 유일한 쓰기 경로(서비스 롤).
// 서명(X-Signature, HMAC-SHA256 hex) 검증 실패는 401 — 위조 페이로드로 plan을 못 바꾼다.
// 매핑: subscription_* 이벤트 status가 active/on_trial/past_due/cancelled(말일까지 이용 유지) → pro,
//       그 외(expired/paused/unpaid…) → free. subscription_* 외 이벤트는 200 무시(LS 재전송 폭주 방지).
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

const PRO_STATUS = new Set(['active', 'on_trial', 'past_due', 'cancelled']);

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
  if (!name.startsWith('subscription_')) return new Response('ignored', { status: 200 });
  const userId = evt?.meta?.custom_data?.user_id;
  if (!userId) return new Response('missing user_id', { status: 400 });
  const status = String(evt?.data?.attributes?.status ?? '');
  const plan = PRO_STATUS.has(status) ? 'pro' : 'free';

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
