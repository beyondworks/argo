// 랜딩 Pro 결제 = 로그인 먼저(2026-10-10). 예전 랜딩 요금제 버튼은 LS로 바로 보내 custom user_id가 없었고, 결제 이메일 ≠ 계정 이메일·
// 결제 먼저 가입 나중이면 Pro가 연결되지 않았다(9/27·10/3·10/10). 이 테스트가 잠그는 것:
//  · 요금제 버튼은 LS가 아니라 /checkout(로그인)으로 간다. LS 주소는 landing/lib/checkout.js에만 있다.
//  · 체크아웃 주소 조립은 앱 설정 버튼(app/c/[ws]/settings/checkout-link.mjs)과 같은 결과 — custom user_id가 반드시 붙는다.
//  · 로그인은 Supabase PKCE(supabase-js와 같은 통신), 받은 세션은 저장하지 않고 끊는다.
//  · 문구가 "결제 이메일로 로그인하면 자동 연결"을 더는 약속하지 않는다(ko·en).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as landing from '../landing/lib/checkout.js';
import { checkoutUrl as appCheckoutUrl } from '../app/c/[ws]/settings/checkout-link.mjs';

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const dictEntry = (key) => {
  const re = new RegExp(`'${key.replace(/\./g, '\\.')}':\\s*\\[\\s*'((?:[^'\\\\]|\\\\.)*)',\\s*'((?:[^'\\\\]|\\\\.)*)'`);
  const m = re.exec(read('landing/lib/i18n.jsx'));
  assert.ok(m, `landing i18n에 ${key} 항목(ko·en)이 있다`);
  return { ko: m[1], en: m[2] };
};
const USER = { id: '0b8f2c1e-6d3a-4c1b-9b8e-2f7d1a3c5e90', email: 'pay@example.com' };

test('요금제 버튼은 로그인 화면(/checkout)으로 가고, LS 체크아웃 주소를 직접 걸지 않는다(월간·연간)', () => {
  const src = read('landing/components/PricingSection.jsx');
  assert.match(src, /href="\/checkout\?plan=monthly"/);
  assert.match(src, /href="\/checkout\?plan=yearly"/);
  assert.doesNotMatch(src, /lemonsqueezy\.com/, '익명 LS 링크가 남아 있지 않다');
  // 랜딩 어디에서도 LS 주소는 lib/checkout.js 한 곳뿐 — 다른 컴포넌트가 user_id 없는 링크를 다시 걸지 못하게
  for (const f of ['landing/components/Hero.jsx', 'landing/components/Nav.jsx', 'landing/components/FaqSection.jsx', 'landing/components/Footer.jsx', 'landing/app/page.jsx']) {
    assert.doesNotMatch(read(f), /lemonsqueezy\.com\/checkout/, `${f}에 LS 체크아웃 링크가 없다`);
  }
});

test('체크아웃 주소 — 앱 설정 버튼과 같은 조립(custom user_id 필수, 이메일은 올바를 때만)', () => {
  const cases = [
    [landing.LS_MONTHLY, USER],
    [landing.LS_YEARLY, USER],
    [landing.LS_MONTHLY, { id: USER.id, email: '' }],
    [landing.LS_MONTHLY, { id: USER.id, email: 'undefined' }],
    [landing.LS_MONTHLY, { id: USER.id, email: ' a+b@x.io ' }],
    [landing.LS_MONTHLY, { id: 'local', email: 'x@y.z' }],
    [landing.LS_MONTHLY, null],
    ['', USER],
  ];
  for (const [base, user] of cases) assert.equal(landing.checkoutUrl(base, user), appCheckoutUrl(base, user), JSON.stringify(user));
  const url = new URL(landing.checkoutUrl(landing.PLAN_BASE.yearly, USER));
  assert.equal(url.searchParams.get('checkout[custom][user_id]'), USER.id);
  assert.equal(url.searchParams.get('checkout[email]'), USER.email);
  assert.equal(url.searchParams.get('enabled'), '2079849', '연간 변형 그대로');
  assert.match(url.pathname, /a68219ba-/, '연간 = a68219ba 변형');
  assert.match(landing.PLAN_BASE.monthly, /8ec2b79d-/, '월간 = 8ec2b79d 변형');
  assert.equal(landing.planOf('yearly'), 'yearly');
  for (const v of [undefined, null, '', 'weekly', 'monthly']) assert.equal(landing.planOf(v), 'monthly');
});

test('PKCE — challenge = base64url(SHA-256(verifier)), 새 검증값은 43~128자', async () => {
  // 기대값은 openssl로 따로 계산: printf %s <verifier> | openssl dgst -sha256 -binary | openssl base64 | tr '+/' '-_' | tr -d '='
  assert.equal(await landing.pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW-gFWEMB'), 'Z6vOQcDIgYWoOxCRnwJQlVVFE9ZhZpGqJfcBTSvpVO4');
  const a = await landing.newPkce(); const b = await landing.newPkce();
  assert.notEqual(a.verifier, b.verifier);
  assert.match(a.verifier, /^[A-Za-z0-9_-]{43,128}$/);
  assert.equal(a.challenge, await landing.pkceChallenge(a.verifier));
});

test('로그인 주소 — supabase-js signInWithOAuth(pkce)와 같은 인자, "다른 계정"은 Google 계정 고르기', () => {
  const u = new URL(landing.authorizeUrl({ supabaseUrl: 'https://proj.supabase.co', provider: 'google', redirectTo: 'https://argo.ceo/checkout', challenge: 'C' }));
  assert.equal(u.origin + u.pathname, 'https://proj.supabase.co/auth/v1/authorize');
  assert.equal(u.searchParams.get('provider'), 'google');
  assert.equal(u.searchParams.get('redirect_to'), 'https://argo.ceo/checkout');
  assert.equal(u.searchParams.get('code_challenge'), 'C');
  assert.equal(u.searchParams.get('code_challenge_method'), 's256');
  assert.equal(u.searchParams.get('prompt'), null);
  const sw = new URL(landing.authorizeUrl({ supabaseUrl: 'https://p', provider: 'google', redirectTo: 'r', challenge: 'C', selectAccount: true }));
  assert.equal(sw.searchParams.get('prompt'), 'select_account');
  const gh = new URL(landing.authorizeUrl({ supabaseUrl: 'https://p', provider: 'github', redirectTo: 'r', challenge: 'C', selectAccount: true }));
  assert.equal(gh.searchParams.get('prompt'), null, 'GitHub에는 Google 전용 값을 보내지 않는다');
});

test('코드 교환 — token?grant_type=pkce로 계정 id·이메일만 받고 세션은 바로 끊는다', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url.includes('/token?grant_type=pkce')) return Response.json({ access_token: 'AT', refresh_token: 'RT', user: { id: USER.id, email: USER.email } });
    if (url.includes('/rpc/my_plan')) return plan === 'error' ? new Response('x', { status: 500 }) : Response.json({ plan });
    if (url.includes('/logout')) return new Response(null, { status: 204 });
    throw new Error(url);
  };
  let plan = 'free';
  const user = await landing.exchangeCode({ supabaseUrl: 'https://p', anonKey: 'anon', code: 'CODE', verifier: 'VER', fetchImpl });
  assert.deepEqual(user, { id: USER.id, email: USER.email, pro: false }, '토큰은 돌려주지 않는다');
  assert.equal(calls[0].url, 'https://p/auth/v1/token?grant_type=pkce');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.apikey, 'anon');
  assert.deepEqual(JSON.parse(calls[0].init.body), { auth_code: 'CODE', code_verifier: 'VER' });
  assert.equal(calls[1].url, 'https://p/rest/v1/rpc/my_plan', '앱과 같은 판정으로 이미 Pro인지 본다');
  assert.equal(calls[1].init.headers.Authorization, 'Bearer AT');
  assert.equal(calls[2].url, 'https://p/auth/v1/logout?scope=local', '판정 뒤 세션을 끊는다');
  assert.equal(calls[2].init.headers.Authorization, 'Bearer AT');
  plan = 'pro';
  assert.equal((await landing.exchangeCode({ supabaseUrl: 'https://p', anonKey: 'anon', code: 'C', verifier: 'V', fetchImpl })).pro, true);
  plan = 'trial';
  assert.equal((await landing.exchangeCode({ supabaseUrl: 'https://p', anonKey: 'anon', code: 'C', verifier: 'V', fetchImpl })).pro, false);
  plan = 'error';
  assert.equal((await landing.exchangeCode({ supabaseUrl: 'https://p', anonKey: 'anon', code: 'C', verifier: 'V', fetchImpl })).pro, null, '판정 실패는 결제를 막지 않는다');
  assert.ok(calls.at(-1).url.endsWith('/logout?scope=local'), '판정이 실패해도 세션은 끊는다');
  // 실패는 throw — 계정 없이 결제로 넘어가지 않는다
  await assert.rejects(landing.exchangeCode({ supabaseUrl: 'https://p', anonKey: 'a', code: 'x', verifier: 'y', fetchImpl: async () => new Response('bad', { status: 400 }) }), /auth 400/);
  await assert.rejects(landing.exchangeCode({ supabaseUrl: 'https://p', anonKey: 'a', code: 'x', verifier: 'y', fetchImpl: async () => Response.json({ user: null }) }), /no user/);
});

test('결제 화면 — 코드는 이 탭의 검증값으로만 교환하고 주소에서 지운다, 세션·토큰을 저장하지 않는다', () => {
  const src = read('landing/app/checkout/page.jsx');
  assert.match(src, /history\.replaceState\(null, '', `\/checkout\?plan=\$\{p\}`\)/, '돌아온 code를 주소에서 지운다');
  assert.match(src, /sessionStorage/, '검증값은 이 탭(sessionStorage)에만');
  assert.doesNotMatch(src, /localStorage/, '오래 남는 저장소에 넣지 않는다');
  assert.doesNotMatch(src, /access_token|refresh_token/, '토큰을 다루지 않는다(lib/checkout.js 안에서 끝난다)');
  assert.match(src, /checkoutUrl\(PLAN_BASE\[p\], user\)/, '로그인한 계정으로만 체크아웃 주소를 만든다');
  assert.match(src, /setState\(user\.pro \? 'already' : 'ready'\)/, '이미 Pro면 결제 대신 안내(구독 두 개 방지)');
  assert.match(src, /redirectTo: `\$\{window\.location\.origin\}\/checkout`/, '돌아올 주소는 /checkout 하나(허용 목록 한 줄)');
});

test('문구 — 로그인 먼저를 말하고, "결제 이메일로 로그인하면 자동 연결" 약속은 없다(ko·en)', () => {
  const note = dictEntry('pricing.buyNote');
  assert.match(note.ko, /로그인/);
  assert.match(note.en, /sign in/i);
  assert.doesNotMatch(note.ko, /결제하신 이메일/);
  assert.doesNotMatch(note.en, /email you used at checkout/);
  const src = read('landing/app/checkout/page.jsx');
  const keys = [...new Set([...src.matchAll(/t\('(checkout\.[a-zA-Z.]+)'\)/g)].map((m) => m[1]))];
  for (const p of ['monthly', 'yearly']) keys.push(`checkout.plan.${p}`, `checkout.continue.${p}`);
  keys.push('checkout.readyTitle', 'checkout.title', 'checkout.alreadyTitle');
  assert.ok(keys.length >= 15, `결제 화면 문구 키 ${keys.length}개`);
  for (const k of keys) { const e = dictEntry(k); assert.ok(e.ko && e.en, `${k} ko·en`); }
});
