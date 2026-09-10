import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { createMobileAuth, createMobileAuthRuntime, parseMobileAuthCallback, MOBILE_AUTH_CALLBACK, MOBILE_AUTH_TIMEOUT_MS, MOBILE_AUTH_STORAGE_KEY } from '../apps/messenger/src/mobile-auth.mjs';

const nonce = '12345678-1234-4123-8123-123456789abc';
const otherNonce = '12345678-1234-4123-8123-123456789abd';
const origin = 'https://mobile-test.supabase.co';
function memory() { const data = new Map(); return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, v), removeItem: (k) => data.delete(k) }; }
function deferred() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; }
function fixture(extra = {}) {
  const storage = extra.storage ?? memory();
  const calls = { started: [], opened: [], exchanged: [] };
  let time = 1000;
  const auth = {
    async signInWithOAuth(input) {
      calls.started.push(input);
      const url = new URL(`${origin}/auth/v1/authorize`);
      url.searchParams.set('provider', input.provider);
      url.searchParams.set('redirect_to', input.options.redirectTo);
      url.searchParams.set('code_challenge', 'a'.repeat(43));
      url.searchParams.set('code_challenge_method', 's256');
      return { data: { url: url.href }, error: null };
    },
    async exchangeCodeForSession(code) { calls.exchanged.push(code); return { data: { session: {}, user: {} }, error: null }; },
    ...extra.auth,
  };
  const deps = { auth, storage, supabaseUrl: origin, openUrl: async (url) => { calls.opened.push(url); }, now: () => time, randomUUID: () => nonce, ...extra, auth };
  const controller = createMobileAuth(deps);
  return { controller, calls, deps, storage, advance: (ms) => { time += ms; } };
}
const callback = (state = nonce) => `${MOBILE_AUTH_CALLBACK}?argo_state=${state}&code=one-time-code`;

test('strict callback rejects foreign destinations, token URLs, fragments, duplicates and normalized-path tricks', () => {
  assert.equal(parseMobileAuthCallback(callback()).code, 'one-time-code');
  for (const url of [
    'https://auth/callback?code=x', callback().replace('auth/', 'foreign/'), callback().replace('/callback', '/callback/'),
    callback().replace('/callback', '/x/../callback'), callback().replace('/callback', '/%63allback'),
    callback().replace('auth/', 'user@auth/'), callback().replace('auth/', 'auth:80/'),
    `${callback()}#access_token=fixture`, `${callback()}#`, `${callback()}&access_token=fixture`, `${callback()}&refresh_token=fixture`,
    `${callback()}&code=duplicate`, `${callback()}&argo_state=${nonce}`, `${callback()}&next=https://foreign.example`,
    callback().replace('one-time-code', '%0aevil'), callback().replace(nonce, 'guessable'), `${callback()}&error=denied`,
  ]) assert.equal(parseMobileAuthCallback(url), null, url);
});

test('unsolicited and wrong-nonce callbacks cannot reach the SDK or destroy a legitimate pending flow', async () => {
  const f = fixture();
  assert.equal((await f.controller.consume(callback())).status, 'ignored');
  await f.controller.start('google');
  assert.equal((await f.controller.consume(callback(otherNonce))).status, 'ignored');
  assert.equal(f.controller.pending().provider, 'google');
  assert.equal(f.calls.exchanged.length, 0);
});

test('cold start resumes the same persisted intent; SDK owns the only code exchange', async () => {
  const f = fixture();
  await f.controller.start('github');
  assert.equal(f.calls.started[0].options.skipBrowserRedirect, true);
  assert.equal(f.calls.started[0].options.redirectTo, `${MOBILE_AUTH_CALLBACK}?argo_state=${nonce}`);
  assert.deepEqual(await createMobileAuth(f.deps).consume(callback()), { status: 'signed_in' });
  assert.deepEqual(f.calls.exchanged, ['one-time-code']);
  assert.equal(f.storage.getItem(MOBILE_AUTH_STORAGE_KEY), null);
  assert.equal((await f.controller.consume(callback())).status, 'ignored');
});

test('single pending flow prevents verifier overwrite; cancel permits a fresh flow', async () => {
  const f = fixture();
  await f.controller.start('google');
  await assert.rejects(f.controller.start('github'), /busy/);
  assert.equal(f.calls.started.length, 1);
  assert.equal(f.controller.cancel(), true);
  assert.equal((await f.controller.consume(callback())).status, 'ignored');
  await f.controller.start('github');
  assert.equal(f.calls.started.length, 2);
});

test('five-minute expiry and clock rollback reject callbacks and allow restart', async () => {
  for (const offset of [MOBILE_AUTH_TIMEOUT_MS, -1001]) {
    const f = fixture(); await f.controller.start('google'); f.advance(offset);
    assert.equal(f.controller.pending(), null);
    assert.equal((await f.controller.consume(callback())).status, 'ignored');
    assert.equal(f.calls.exchanged.length, 0);
    await f.controller.start('google');
  }
});

test('callback for a different configured server cannot exchange with the wrong project', async () => {
  const f = fixture(); await f.controller.start('google');
  const changedServer = createMobileAuth({ ...f.deps, supabaseUrl: 'https://other.supabase.co' });
  assert.equal((await changedServer.consume(callback())).status, 'ignored');
  assert.equal(f.calls.exchanged.length, 0);
});

test('duplicate callbacks while exchange is in flight exchange once; cancel/start cannot race SDK session commit', async () => {
  const wait = deferred();
  const f = fixture({ auth: { exchangeCodeForSession: () => wait.promise } });
  await f.controller.start('google');
  const result = f.controller.consume(callback());
  assert.equal((await f.controller.consume(callback())).status, 'ignored');
  assert.equal(f.controller.cancel(), false);
  await assert.rejects(f.controller.start('github'), /busy/);
  wait.resolve({ data: { session: {}, user: {} }, error: null });
  assert.deepEqual(await result, { status: 'signed_in' });
});

test('cancel during provider preparation does not launch browser or exchange code', async () => {
  const wait = deferred(); const f = fixture({ auth: { signInWithOAuth: () => wait.promise } });
  const start = f.controller.start('google');
  f.controller.cancel();
  wait.resolve({ data: { url: 'https://irrelevant.example' }, error: null });
  await assert.rejects(start, /cancelled/);
  assert.equal(f.calls.opened.length, 0);
  assert.equal((await f.controller.consume(callback())).status, 'ignored');
});

test('only SDK S256 URLs at the configured Auth endpoint can open the OS browser', async () => {
  for (const url of ['https://foreign.example/auth/v1/authorize', `${origin}/other`, `${origin}/auth/v1/authorize?provider=google`]) {
    const f = fixture({ auth: { signInWithOAuth: async () => ({ data: { url }, error: null }) } });
    await assert.rejects(f.controller.start('google'), /start_failed/);
    assert.equal(f.calls.opened.length, 0);
    assert.equal(f.controller.pending(), null);
  }
});

test('provider denial and SDK errors return safe fixed codes and consume the attempt', async () => {
  const f = fixture(); await f.controller.start('google');
  await assert.rejects(f.controller.consume(`${MOBILE_AUTH_CALLBACK}?argo_state=${nonce}&error=access_denied&error_description=PRIVATE_TEXT`), /^Error: provider_denied$/);
  assert.equal(f.calls.exchanged.length, 0);
  const g = fixture({ auth: { exchangeCodeForSession: async () => { throw new Error('PRIVATE_TEXT'); } } });
  await g.controller.start('google');
  await assert.rejects(g.controller.consume(callback()), /^Error: exchange_failed$/);
  assert.equal((await g.controller.consume(callback())).status, 'ignored');
});

test('open/storage failures never leave an exchangeable pending attempt', async () => {
  const f = fixture({ openUrl: async () => { throw new Error('PRIVATE_TEXT'); } });
  await assert.rejects(f.controller.start('github'), /^Error: open_failed$/);
  assert.equal(f.controller.pending(), null);
  const g = fixture({ storage: { getItem: () => null, setItem: () => { throw new Error('denied'); } } });
  await assert.rejects(g.controller.start('google'), /^Error: storage_unavailable$/);
  assert.equal(g.calls.started.length, 0);
});

test('corrupted pending metadata recovers without touching SDK session storage', async () => {
  const f = fixture();
  f.storage.setItem(MOBILE_AUTH_STORAGE_KEY, '{broken');
  f.storage.setItem('existing-session', 'keep');
  assert.equal(f.controller.pending(), null);
  await f.controller.start('google');
  f.controller.cancel();
  assert.equal(f.storage.getItem('existing-session'), 'keep');
});

test('non-persistent storage fails before OAuth preparation', async () => {
  const f = fixture({ storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } });
  await assert.rejects(f.controller.start('google'), /^Error: storage_unavailable$/);
  assert.equal(f.calls.started.length, 0);
});

test('real installed Supabase SDK generates S256, restores persisted verifier and exchanges without URL tokens', async () => {
  const require = createRequire(new URL('../apps/messenger/package.json', import.meta.url));
  const { createClient } = require('@supabase/supabase-js');
  const storage = memory(); const requests = []; let opened;
  const options = {
    auth: { storage, storageKey: 'isolated-mobile-sdk-test', flowType: 'pkce', detectSessionInUrl: false, autoRefreshToken: false, persistSession: true },
    global: { fetch: async (url, init) => {
      requests.push({ url, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ access_token: 'fixture-access', refresh_token: 'fixture-refresh', token_type: 'bearer', expires_in: 3600, user: { id: 'fixture-user' } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } },
  };
  const first = createClient(origin, 'public-test-key', options);
  const a = createMobileAuth({ auth: first.auth, storage, supabaseUrl: origin, openUrl: async (u) => { opened = new URL(u); } });
  await a.start('google');
  assert.equal(opened.searchParams.get('code_challenge_method').toLowerCase(), 's256');
  const back = new URL(opened.searchParams.get('redirect_to')); back.searchParams.set('code', 'sdk-test-code');
  const fresh = createClient(origin, 'public-test-key', options);
  const b = createMobileAuth({ auth: fresh.auth, storage, supabaseUrl: origin, openUrl: async () => assert.fail('cold callback must not reopen browser') });
  assert.deepEqual(await b.consume(back.href), { status: 'signed_in' });
  assert.equal(requests.length, 1);
  assert.equal(new URL(requests[0].url).searchParams.get('grant_type'), 'pkce');
  assert.equal(requests[0].body.auth_code, 'sdk-test-code');
  assert.equal(createHash('sha256').update(requests[0].body.code_verifier).digest('base64url'), opened.searchParams.get('code_challenge'));
  assert.equal((await fresh.auth.getSession()).data.session.user.id, 'fixture-user');
  assert.equal((await b.consume(back.href)).status, 'ignored');
  assert.equal(requests.length, 1);
  await first.auth.stopAutoRefresh(); await fresh.auth.stopAutoRefresh();
});


test('runtime installs warm listener before cold URLs and serializes duplicate events', async () => {
  const f = fixture(); await f.controller.start('google');
  let handler; const events = []; let stopped = 0;
  const runtime = createMobileAuthRuntime({ controller: f.controller, now: f.deps.now,
    onOpenUrl: async (fn) => { events.push('listen'); handler = fn; return () => { stopped += 1; }; },
    getCurrent: async () => { events.push('current'); handler([callback()]); return [callback()]; },
    setTimer: () => 1, clearTimer: () => {},
  });
  const states = []; const unsub = runtime.subscribe((state) => states.push(state));
  const stop = runtime.mount();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['listen', 'current']);
  assert.equal(f.calls.exchanged.length, 1);
  assert.deepEqual(runtime.getSnapshot(), { waiting: false, exchanging: false, error: null });
  assert.ok(states.some((s) => s.exchanging));
  stop(); stop(); unsub();
  assert.equal(stopped, 1);
});

test('runtime unmount before asynchronous registration releases listener and ignores late URLs', async () => {
  const f = fixture(); await f.controller.start('google'); const registration = deferred(); let stopCalls = 0; let currentCalls = 0; let handler;
  const runtime = createMobileAuthRuntime({ controller: f.controller, now: f.deps.now,
    onOpenUrl: (fn) => { handler = fn; return registration.promise; }, getCurrent: async () => { currentCalls += 1; return [callback()]; },
    setTimer: () => 1, clearTimer: () => {},
  });
  const stop = runtime.mount(); await Promise.resolve(); stop();
  registration.resolve(() => { stopCalls += 1; });
  await new Promise((resolve) => setImmediate(resolve));
  handler([callback()]); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopCalls, 1); assert.equal(currentCalls, 0); assert.equal(f.calls.exchanged.length, 0);
  assert.ok(f.controller.pending(), 'unmount is not an explicit login cancellation');
});

test('runtime expiry clears waiting state; cancellation cannot hide an in-flight exchange', async () => {
  const wait = deferred(); const f = fixture({ auth: { exchangeCodeForSession: () => wait.promise } }); let handler; let expire;
  const runtime = createMobileAuthRuntime({ controller: f.controller, now: f.deps.now,
    onOpenUrl: async (fn) => { handler = fn; return () => {}; }, getCurrent: async () => null,
    setTimer: (fn) => { expire = fn; return 1; }, clearTimer: () => {},
  });
  const stop = runtime.mount(); await runtime.start('google');
  f.advance(MOBILE_AUTH_TIMEOUT_MS); expire();
  assert.deepEqual(runtime.getSnapshot(), { waiting: false, exchanging: false, error: 'expired' });
  await runtime.start('google'); handler([callback()]); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtime.getSnapshot().exchanging, true);
  assert.equal(runtime.cancel(), false);
  wait.resolve({ data: { session: {}, user: {} }, error: null });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(runtime.getSnapshot(), { waiting: false, exchanging: false, error: null }); stop();
});


function providerErrorCallback(state = nonce) {
  const query = new URLSearchParams({ argo_state: state, error: 'access_denied', error_code: 'provider_error', error_description: 'User denied access' });
  const fragment = new URLSearchParams({ error: 'access_denied', error_code: 'provider_error', error_description: 'User denied access', sb: '' });
  return `${MOBILE_AUTH_CALLBACK}?${query}#${fragment}`;
}

test('actual Supabase redirectErrors format consumes provider cancellation immediately with no SDK exchange', async () => {
  const f = fixture(); await f.controller.start('google');
  assert.deepEqual(parseMobileAuthCallback(providerErrorCallback()), { nonce, denied: true });
  assert.equal((await f.controller.consume(providerErrorCallback(otherNonce))).status, 'ignored');
  assert.ok(f.controller.pending());
  await assert.rejects(f.controller.consume(providerErrorCallback()), /^Error: provider_denied$/);
  assert.equal(f.controller.pending(), null);
  assert.equal(f.calls.exchanged.length, 0);
  assert.equal((await f.controller.consume(providerErrorCallback())).status, 'ignored');
});

test('error fragments must exactly mirror query errors, contain only one empty sb marker and never carry tokens or codes', async () => {
  const good = providerErrorCallback(); const [query, fragment] = good.split('#');
  const bad = [
    `${query}#`, `${query}#${fragment.replace('sb=', 'sb=spoof')}`, `${query}#${fragment.replace('&sb=', '')}`,
    `${query}#${fragment}&sb=`, `${query}#${fragment}&error=access_denied`,
    `${query}#${fragment.replace('access_denied', 'server_error')}`,
    `${query}#${fragment.replace('provider_error', 'different_error')}`,
    `${query}#${fragment.replace('User+denied+access', 'Other+description')}`,
    `${query}#${fragment}&access_token=fixture`, `${query}#${fragment}&refresh_token=fixture`,
    `${query}#${fragment}&code=fixture`, `${query}#${fragment}&argo_state=${nonce}`,
    `${query}&code=fixture#${fragment}`, `${query}&access_token=fixture#${fragment}`,
    `${MOBILE_AUTH_CALLBACK}?argo_state=${nonce}#${fragment}`,
    `${callback()}#${fragment}`, `${query}#error=access_denied&sb=`,
    `${query}#${fragment}&unknown=value`,
  ];
  const f = fixture(); await f.controller.start('google');
  for (const url of bad) {
    assert.equal(parseMobileAuthCallback(url), null, url);
    assert.equal((await f.controller.consume(url)).status, 'ignored');
  }
  assert.ok(f.controller.pending()); assert.equal(f.calls.exchanged.length, 0);
});

test('runtime provider cancellation clears waiting without waiting for the timeout', async () => {
  const f = fixture(); let handler;
  const runtime = createMobileAuthRuntime({ controller: f.controller, now: f.deps.now,
    onOpenUrl: async (fn) => { handler = fn; return () => {}; }, getCurrent: async () => null,
    setTimer: () => 1, clearTimer: () => {},
  });
  const stop = runtime.mount(); await runtime.start('google'); handler([providerErrorCallback()]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(runtime.getSnapshot(), { waiting: false, exchanging: false, error: 'provider_denied' });
  assert.equal(f.calls.exchanged.length, 0); stop();
});

test('missing mobile controller stays neutral and never registers native plugins or timers', async () => {
  const runtime = createMobileAuthRuntime({ controller: null,
    onOpenUrl: () => assert.fail('no native plugin without a mobile controller'),
    getCurrent: () => assert.fail('no native plugin without a mobile controller'),
    setTimer: () => assert.fail('no waiting timer'), clearTimer: () => {},
  });
  const stop = runtime.mount();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(runtime.getSnapshot(), { waiting: false, exchanging: false, error: null });
  stop();
  assert.equal(await runtime.start('google'), false);
  assert.deepEqual(runtime.getSnapshot(), { waiting: false, exchanging: false, error: 'start_failed' });
});
