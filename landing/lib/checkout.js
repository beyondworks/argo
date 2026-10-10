// 랜딩 결제 — 로그인한 Argo 계정 id를 붙인 레몬스퀴지 체크아웃(2026-10-10).
// 예전 랜딩 버튼은 로그인 없이 LS로 바로 보내 custom user_id가 없었고, 결제 이메일 ≠ 계정 이메일이거나 결제 먼저·가입 나중이면
// Pro가 연결되지 않았다(9/27·10/3·10/10 실사고). 이제 /checkout에서 먼저 로그인하고, 그 계정 id로 체크아웃 주소를 만든다.
// 이 파일과 landing/app/checkout/page.jsx만 결제 주소를 안다.

// 공개 링크(시크릿 아님) — 앱 릴리스 빌드에 주입되는 것과 같은 상품(Argo Pro $12/월 · $120/년, 2026-08-05 라이브 승인).
export const LS_MONTHLY = 'https://argo-agent.lemonsqueezy.com/checkout/buy/8ec2b79d-6d8b-415e-bae0-4563cc07cb83?enabled=2079807';
export const LS_YEARLY = 'https://argo-agent.lemonsqueezy.com/checkout/buy/a68219ba-6885-4613-83b9-68045af86241?enabled=2079849'; // buy/ 뒤 값 = 변형(연간 a68219ba). 월간 값을 쓰면 US$12가 담긴다(2026-09-26 에드나 확정)
export const PLAN_BASE = { monthly: LS_MONTHLY, yearly: LS_YEARLY };
export const planOf = (v) => (v === 'yearly' ? 'yearly' : 'monthly');

// 앱 설정 결제 버튼(app/c/[ws]/settings/checkout-link.mjs checkoutUrl)과 같은 조립 — 랜딩은 따로 배포되는 Next 앱이라
// 그 파일을 가져오지 않고 같은 코드를 둔다. test/landing-checkout-login.test.mjs가 두 함수의 결과를 같은 입력으로 대조한다.
// 실측 2026-09-25: checkout[email]이 빈 값·'undefined'면 LS가 422 → 이메일은 올바를 때만 붙인다.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function checkoutUrl(base, user) {
  if (!base || !user?.id || user.id === 'local') return null;
  const email = typeof user.email === 'string' ? user.email.trim() : '';
  const q = `checkout[custom][user_id]=${encodeURIComponent(user.id)}${EMAIL.test(email) ? `&checkout[email]=${encodeURIComponent(email)}` : ''}`;
  return `${base}${base.includes('?') ? '&' : '?'}${q}`;
}

// ── 로그인 — Supabase Auth PKCE를 라이브러리 없이(랜딩 의존성을 늘리지 않는다). supabase-js signInWithOAuth(flowType pkce)와 같은 통신:
//   1) /auth/v1/authorize?provider&redirect_to&code_challenge&code_challenge_method=s256 → 공급자 로그인(계정이 없으면 이때 가입)
//   2) redirect_to?code=… 로 돌아오면 /auth/v1/token?grant_type=pkce {auth_code, code_verifier} → 세션(user 포함)
//   3) 계정 id·이메일만 읽고 세션은 바로 /auth/v1/logout으로 끊는다 — 랜딩은 세션을 저장하지 않는다.
const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export async function pkceChallenge(verifier, cryptoImpl = globalThis.crypto) {
  const digest = await cryptoImpl.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return b64url(new Uint8Array(digest));
}

export async function newPkce(cryptoImpl = globalThis.crypto) {
  const verifier = b64url(cryptoImpl.getRandomValues(new Uint8Array(48))); // 64자 — RFC 7636 43~128자
  return { verifier, challenge: await pkceChallenge(verifier, cryptoImpl) };
}

export function authorizeUrl({ supabaseUrl, provider, redirectTo, challenge, selectAccount = false }) {
  const q = new URLSearchParams({ provider, redirect_to: redirectTo, code_challenge: challenge, code_challenge_method: 's256' });
  if (selectAccount && provider === 'google') q.set('prompt', 'select_account'); // "다른 계정으로" — Google이 마지막 계정을 자동으로 고르지 않게
  return `${supabaseUrl}/auth/v1/authorize?${q}`;
}

/** code → { id, email }. 실패는 throw. 받은 세션은 저장하지 않고 끊는다(끊기 실패는 무시 — 토큰은 이 함수 밖으로 나가지 않는다). */
export async function exchangeCode({ supabaseUrl, anonKey, code, verifier, fetchImpl = fetch }) {
  const res = await fetchImpl(`${supabaseUrl}/auth/v1/token?grant_type=pkce`, {
    method: 'POST',
    headers: { apikey: anonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ auth_code: code, code_verifier: verifier }),
  });
  if (!res.ok) throw new Error(`auth ${res.status}`);
  const data = await res.json();
  const id = data?.user?.id;
  if (typeof id !== 'string' || !id) throw new Error('auth: no user');
  if (data.access_token) {
    await fetchImpl(`${supabaseUrl}/auth/v1/logout?scope=local`, {
      method: 'POST', headers: { apikey: anonKey, Authorization: `Bearer ${data.access_token}` },
    }).catch(() => null);
  }
  return { id, email: typeof data.user.email === 'string' ? data.user.email : '' };
}
