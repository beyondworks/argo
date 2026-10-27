import test from 'node:test';
import assert from 'node:assert/strict';
import { GoTrueClient } from '@supabase/supabase-js';
import { createNativeRealtimeCoordinator } from '../src/native-realtime.mjs';

// 네이티브(Rust)가 /auth/v1/token 영구 거부(400·401)를 받고 멈춘 뒤의 JS 쪽 행동.
// 근거: 거부를 끝없이 재시도해 숨긴 맥 창 하나가 분당 약 2회 /token을 보냈다(2026-10-26 조사).

const jwt = (exp) => [
  { alg: 'HS256', typ: 'JWT' }, { exp, sub: 'fixture-user' },
].map((value) => Buffer.from(JSON.stringify(value)).toString('base64url')).concat(Buffer.from('fixture-signature').toString('base64url')).join('.');

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

// 실제 auth-js(GoTrueClient)에 가짜 fetch를 물려 /token 호출 수를 센다. /token은 늘 400(세션 종료).
const realAuth = async (t, stored) => {
  const key = 'native-rejected-fixture';
  const now = Math.floor(Date.now() / 1000);
  // 초기화 때 auth-js가 스스로 갱신하지 않게 넉넉한 세션으로 띄운 뒤, 시나리오 세션으로 바꾼다.
  const values = new Map([[key, JSON.stringify({ ...stored, access_token: jwt(now + 3_600), expires_at: now + 3_600 })]]);
  const storage = { getItem: (name) => values.get(name) ?? null, setItem: (name, value) => values.set(name, value), removeItem: (name) => values.delete(name) };
  const token = [];
  const auth = new GoTrueClient({
    url: 'https://fixture.invalid/auth/v1', headers: {}, storageKey: key, storage,
    persistSession: true, autoRefreshToken: false, detectSessionInUrl: false,
    fetch: async (url) => {
      if (String(url).includes('/token')) token.push(String(url));
      return new Response(JSON.stringify({ error_code: 'refresh_token_already_used', msg: 'Invalid Refresh Token: Already Used' }), {
        status: 400, headers: { 'content-type': 'application/json' },
      });
    },
  });
  const events = [];
  const sub = auth.onAuthStateChange((event) => { events.push(event); });
  await auth.getSession();
  await settle(); // 구독 직후 INITIAL_SESSION이 세션을 한 번 읽는다 — 시나리오 세션으로 바꾸기 전에 끝낸다
  events.length = 0;
  values.set(key, JSON.stringify(stored));
  t.after(async () => { sub.data.subscription.unsubscribe(); await auth.stopAutoRefresh(); });
  assert.equal(token.length, 0, 'fixture init must not refresh');
  return { auth, token, events, values, key };
};

const nativeInvoke = (calls, snapshot = () => ({ status: 'connected', generation: 1, userId: 'fixture-user' })) => async (command, args) => {
  calls.push([command, args]);
  if (command === 'native_realtime_start') return { generation: calls.filter(([name]) => name === 'native_realtime_start').length, userId: args.session.userId };
  if (command === 'native_realtime_snapshot') return snapshot();
  return { status: 'stopped' };
};

const coordinatorFor = (auth, invoke) => createNativeRealtimeCoordinator({
  enabled: true, auth, invoke, supabaseUrl: 'https://fixture.invalid', anonKey: 'fixture-public', lang: 'ko', getContext: () => ({}),
});

const named = (calls, name) => calls.filter(([command]) => command === name);

test('rejected native refresh with the same token: native stays stopped, JS tries once, no restart loop', async (t) => {
  const now = Math.floor(Date.now() / 1000);
  // 네이티브가 갱신하는 90초 창 안: 접근 토큰은 아직 유효(60초 남음), 리프레시 토큰은 서버가 끝낸 것.
  const stored = { user: { id: 'fixture-user' }, access_token: jwt(now + 60), refresh_token: 'fixture-dead', expires_at: now + 60, token_type: 'bearer' };
  const { auth, token } = await realAuth(t, stored);
  const calls = [];
  const coordinator = coordinatorFor(auth, nativeInvoke(calls));
  await coordinator.handleAuth('SIGNED_IN', stored);
  assert.equal(named(calls, 'native_realtime_start').length, 1);

  await coordinator.handleNativeRejected({ generation: 1 });
  await settle();

  assert.deepEqual(named(calls, 'native_realtime_stop').map(([, args]) => args), [{ generation: 1 }]);
  assert.equal(named(calls, 'native_realtime_start').length, 1, 'same dead token must not restart native (would reject again)');
  assert.equal(token.length, 1, `JS refresh owner tries the token once, got ${token.length}`);
});

test('rejected native refresh with an expired session goes down the SIGNED_OUT path', async (t) => {
  const now = Math.floor(Date.now() / 1000);
  const stored = { user: { id: 'fixture-user' }, access_token: jwt(now - 10), refresh_token: 'fixture-dead', expires_at: now - 10, token_type: 'bearer' };
  const { auth, token, events, values, key } = await realAuth(t, stored);
  const calls = [];
  const coordinator = coordinatorFor(auth, nativeInvoke(calls));
  await coordinator.handleAuth('SIGNED_IN', stored);

  await coordinator.handleNativeRejected({ generation: 1 });
  await settle();

  assert.ok(events.includes('SIGNED_OUT'), `expected SIGNED_OUT, got ${events.join(',')}`);
  assert.equal(values.has(key), false);
  assert.equal(token.length, 1);
  assert.equal(named(calls, 'native_realtime_start').length, 1);
});

test('rejected native refresh while JS holds a newer token restarts native with the JS session and no /token call', async (t) => {
  const now = Math.floor(Date.now() / 1000);
  const nativeSession = { user: { id: 'fixture-user' }, access_token: jwt(now + 60), refresh_token: 'fixture-native-old', expires_at: now + 60, token_type: 'bearer' };
  // JS가 먼저 갱신해 더 새 토큰을 저장소에 들고 있다(네이티브는 모른다).
  const jsSession = { ...nativeSession, access_token: jwt(now + 3_600), refresh_token: 'fixture-js-new', expires_at: now + 3_600 };
  const { auth, token } = await realAuth(t, jsSession);
  const calls = [];
  const coordinator = coordinatorFor(auth, nativeInvoke(calls));
  await coordinator.handleAuth('SIGNED_IN', nativeSession);

  await coordinator.handleNativeRejected({ generation: 1 });
  await settle();

  const starts = named(calls, 'native_realtime_start');
  assert.equal(starts.length, 2);
  assert.equal(starts[1][1].session.refreshToken, 'fixture-js-new');
  assert.equal(token.length, 0);
});

test('rejection from an old generation or after sign-out is ignored', async () => {
  const calls = [];
  const auth = {
    stopAutoRefresh: () => calls.push(['stopAutoRefresh']),
    startAutoRefresh: () => calls.push(['startAutoRefresh']),
    getSession: async () => { calls.push(['getSession']); return { data: { session: null }, error: null }; },
  };
  const coordinator = coordinatorFor(auth, nativeInvoke(calls));
  const session = { user: { id: 'fixture-user' }, access_token: 'a', refresh_token: 'r', expires_at: 2_000_000_000 };
  await coordinator.handleAuth('SIGNED_IN', session);
  await coordinator.handleNativeRejected({ generation: 99 }); // 다른 창·옛 세대의 늦은 이벤트
  assert.equal(named(calls, 'native_realtime_stop').length, 0);
  assert.equal(named(calls, 'getSession').length, 0);

  await coordinator.handleAuth('SIGNED_OUT', null);
  await coordinator.handleNativeRejected({ generation: 1 }); // 로그아웃 뒤 도착
  assert.equal(named(calls, 'native_realtime_stop').length, 1);
  assert.equal(named(calls, 'getSession').length, 0);
});

test('focus reconcile hands over a rejection whose event the hidden window missed', async () => {
  const calls = [];
  let status = 'connected';
  const auth = {
    stopAutoRefresh: () => calls.push(['stopAutoRefresh']),
    startAutoRefresh: () => calls.push(['startAutoRefresh']),
    getSession: async () => { calls.push(['getSession']); return { data: { session: null }, error: null }; },
  };
  const coordinator = coordinatorFor(auth, nativeInvoke(calls, () => ({ status, generation: 1, userId: 'fixture-user' })));
  await coordinator.handleAuth('SIGNED_IN', { user: { id: 'fixture-user' }, access_token: 'a', refresh_token: 'r', expires_at: 2_000_000_000 });
  await coordinator.reconcile();
  assert.equal(named(calls, 'native_realtime_stop').length, 0);

  status = 'rejected';
  await coordinator.reconcile();
  assert.deepEqual(named(calls, 'native_realtime_stop').map(([, args]) => args), [{ generation: 1 }]);
  assert.equal(calls.at(-2)[0], 'startAutoRefresh', 'JS takes refresh ownership back');
  assert.equal(calls.at(-1)[0], 'getSession');
});

test('sign-out or account switch while the rejected session is being read wins over the restart', async () => {
  for (const [event, next] of [['SIGNED_OUT', null], ['SIGNED_IN', { user: { id: 'fixture-other' }, access_token: 'b', refresh_token: 'r-other', expires_at: 2_000_000_000 }]]) {
    const calls = [];
    let release;
    const reading = new Promise((resolve) => { release = resolve; });
    const auth = {
      stopAutoRefresh: () => calls.push(['stopAutoRefresh']),
      startAutoRefresh: () => calls.push(['startAutoRefresh']),
      // 큐 밖 getSession이 도는 사이 사용자가 로그아웃하거나 다른 계정으로 바꾼다.
      getSession: async () => { await reading; return { data: { session: { user: { id: 'fixture-user' }, access_token: 'a2', refresh_token: 'r-newer', expires_at: 2_000_000_000 } }, error: null }; },
    };
    const coordinator = coordinatorFor(auth, nativeInvoke(calls));
    await coordinator.handleAuth('SIGNED_IN', { user: { id: 'fixture-user' }, access_token: 'a', refresh_token: 'r', expires_at: 2_000_000_000 });
    const resumed = coordinator.handleNativeRejected({ generation: 1 });
    await settle();
    await coordinator.handleAuth(event, next);
    release();
    await resumed;
    const starts = named(calls, 'native_realtime_start').map(([, args]) => args.session.userId);
    assert.deepEqual(starts, event === 'SIGNED_OUT' ? ['fixture-user'] : ['fixture-user', 'fixture-other'], event);
  }
});
