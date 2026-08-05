// LS(Lemon Squeezy) 구독 관리 포털 URL 발급 — **LS API 키를 쥔 유일한 곳**.
//
// 왜 함수인가: 데스크톱 앱은 사용자 기기에서 Next 서버를 돌린다. 거기에 LEMONSQUEEZY_API_KEY를
// 실으면 전 사용자에게 우리 결제 API 키가 배포된다(그 키로 남의 구독 조회·변경 가능). 그래서 키는
// 서버에만 두고, 앱은 **사용자 토큰으로 이 함수를 부른 뒤** 받은 URL로 302만 보낸다.
// 설계 정본: docs/billing-portal-design.md
//
// 왜 302가 아니라 JSON인가: 이 함수는 브라우저 네비게이션이 아니라 **앱 서버가 부른다**(<a href>는
// Authorization 헤더를 못 싣는다). 그래서 { url }을 돌려주고 리다이렉트는 호출부가 한다.
//
// 왜 매번 발급하나: LS 포털 URL은 **24시간 만료 프리사인 링크**다. 웹훅 스냅샷을 저장해 렌더하면
// 정상 구독자 대부분이 죽은 링크를 받는다(다음 웹훅은 한 달 뒤 갱신 때).
//
// 구독 id는 **클라이언트가 넘기지 않는다** — 넘기게 하면 남의 구독 id로 포털을 여는 길이 생긴다.
// 토큰에서 얻은 user_id로 우리가 조회한다.
import { createClient } from 'npm:@supabase/supabase-js@2';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method !== 'POST' && req.method !== 'GET') return json({ error: 'method not allowed' }, 405);

  const url = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const apiKey = Deno.env.get('LEMONSQUEEZY_API_KEY');
  // 설정 누락은 사용자 잘못이 아니다 — 원인을 코드로 구분해 호출부가 정확한 문구를 고르게 한다.
  if (!url || !anonKey || !serviceKey) return json({ error: 'server misconfigured', code: 'no-supabase' }, 500);
  if (!apiKey) return json({ error: 'billing not configured', code: 'no-api-key' }, 503);

  // ── 1. 본인 확인 — 토큰이 말하는 사용자만 자기 구독을 연다
  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return json({ error: 'unauthorized', code: 'no-token' }, 401);
  const asUser = createClient(url, anonKey, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data: who, error: whoErr } = await asUser.auth.getUser();
  const userId = who?.user?.id;
  if (whoErr || !userId) return json({ error: 'unauthorized', code: 'bad-token' }, 401);

  // ── 2. 그 사용자의 구독 id — 서비스 롤로 조회(RLS 우회는 여기서만, 읽기 1건)
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
  const { data: row, error: rowErr } = await admin
    .from('entitlements').select('ls_subscription_id').eq('user_id', userId).maybeSingle();
  if (rowErr) return json({ error: 'lookup failed', code: 'db' }, 502);
  const subId = row?.ls_subscription_id;
  // 구독이 없는 것은 오류가 아니다 — 호출부가 "업그레이드" 화면을 띄우도록 구분해 준다.
  if (!subId) return json({ error: 'no subscription', code: 'no-sub' }, 404);

  // ── 3. 신선한 포털 URL
  let res: Response;
  try {
    res = await fetch(`https://api.lemonsqueezy.com/v1/subscriptions/${encodeURIComponent(String(subId))}`, {
      headers: { Accept: 'application/vnd.api+json', Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    return json({ error: 'lemonsqueezy unreachable', code: 'upstream' }, 502);
  }
  // 상태코드만 넘긴다 — LS 응답 본문에 키가 섞여 돌아올 이유는 없지만, 확인 못 한 것을 흘리지 않는다.
  if (!res.ok) return json({ error: `lemonsqueezy ${res.status}`, code: 'upstream' }, 502);

  const body = await res.json().catch(() => null) as
    { data?: { attributes?: { urls?: { customer_portal?: string } } } } | null;
  const portal = body?.data?.attributes?.urls?.customer_portal;
  // 규격이 바뀌면 조용히 빈 값을 돌려주지 않는다 — 빈 링크로 보내는 것이 가장 나쁜 실패다.
  if (!portal) return json({ error: 'portal url missing', code: 'shape' }, 502);

  return json({ url: portal });
});
