import test from 'node:test';
import assert from 'node:assert/strict';
import { GoTrueClient } from '@supabase/supabase-js';
import { authCleanupState } from '../src/auth-storage.mjs';
import { createSessionRecovery } from '../src/session-recovery.mjs';
import { attachNativeNotificationTaps, createNativeRealtimeCoordinator, createNativeSessionApplier } from '../src/native-realtime.mjs';

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

const within = async (promise) => {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('native lifecycle did not settle')), 1_000);
    })]);
  } finally { clearTimeout(timer); }
};

const jwt = (exp) => [
  { alg: 'HS256', typ: 'JWT' }, { exp, sub: 'fixture-user' },
].map((value) => Buffer.from(JSON.stringify(value)).toString('base64url')).concat(Buffer.from('fixture-signature').toString('base64url')).join('.');

test('real SDK rejected native refresh awaits native cleanup without deadlocking its SIGNED_OUT subscriber', async (t) => {
  const key = 'native-lifecycle-fixture';
  const now = Math.floor(Date.now() / 1000);
  const initial = { user: { id: 'fixture-user' }, access_token: jwt(now + 3_600), refresh_token: 'fixture-initial', expires_at: now + 3_600, token_type: 'bearer' };
  const values = new Map([[key, JSON.stringify(initial)]]);
  const storage = { getItem: (name) => values.get(name) ?? null, setItem: (name, value) => values.set(name, value), removeItem: (name) => values.delete(name) };
  const auth = new GoTrueClient({
    url: 'https://fixture.invalid/auth/v1', headers: {}, storageKey: key, storage,
    persistSession: true, autoRefreshToken: false, detectSessionInUrl: false,
    fetch: async () => new Response(JSON.stringify({ error_code: 'refresh_token_not_found', msg: 'fixture session expired' }), {
      status: 400, headers: { 'content-type': 'application/json' },
    }),
  });
  await auth.getSession();
  const stopStarted = deferred();
  const stopFinished = deferred();
  const calls = [];
  const applied = [];
  const waiting = [];
  const coordinator = createNativeRealtimeCoordinator({
    enabled: true, auth, supabaseUrl: 'https://fixture.invalid', anonKey: 'fixture-public', lang: 'en', getContext: () => ({}),
    invoke: async (command, args) => {
      calls.push(command);
      if (command === 'native_realtime_start') return { generation: 1, userId: args.session.userId };
      if (command === 'native_realtime_stop') { stopStarted.resolve(); await stopFinished.promise; }
      return { status: 'stopped' };
    },
  });
  const applier = createNativeSessionApplier({ native: Promise.resolve(coordinator), applySession: (value) => applied.push(value) });
  const recovery = createSessionRecovery({
    auth, cleanupState: authCleanupState(key, storage), hasStoredSession: () => values.has(key), applySession: applier.apply,
    setWaiting: (value) => waiting.push(value), addEventListener() {}, removeEventListener() {}, addVisibilityListener() {}, removeVisibilityListener() {},
  });
  const sub = auth.onAuthStateChange((event, value) => recovery.onAuthStateChange(event, value));
  t.after(async () => {
    stopFinished.resolve(); recovery.stop(); applier.dispose(); sub.data.subscription.unsubscribe(); await auth.stopAutoRefresh();
  });
  await recovery.start();
  await coordinator.updateContext();
  calls.length = 0; applied.length = 0; waiting.length = 0;
  values.set(key, JSON.stringify({ ...initial, access_token: jwt(now - 3_600), expires_at: now - 3_600 }));

  const syncing = coordinator.handleNativeSession({ generation: 1, accessToken: jwt(now - 10), refreshToken: 'fixture-expired', expiresAt: now - 10 });
  await within(stopStarted.promise);
  assert.deepEqual(applied, []);
  assert.deepEqual(waiting, []);
  stopFinished.resolve();
  await within(syncing);
  await within(coordinator.updateContext());

  assert.equal(calls.filter((command) => command === 'native_realtime_stop').length, 1);
  assert.deepEqual(applied, [null]);
  assert.equal(waiting.at(-1), false);
  assert.equal(values.has(key), false);
});

test('native sync completion cannot reclaim refresh ownership after a subscriber stops its generation', async () => {
  const calls = [];
  let coordinator;
  coordinator = createNativeRealtimeCoordinator({
    enabled: true, supabaseUrl: 'https://fixture.invalid', anonKey: 'fixture-public', lang: 'en', getContext: () => ({}),
    auth: {
      stopAutoRefresh: () => calls.push('stopAutoRefresh'), startAutoRefresh: () => calls.push('startAutoRefresh'),
      setSession: async () => { await coordinator.handleAuth('SIGNED_OUT', null); return { error: null }; },
    },
    invoke: async (command, args) => {
      calls.push(command);
      return command === 'native_realtime_start' ? { generation: 1, userId: args.session.userId } : { status: 'stopped' };
    },
  });
  await coordinator.handleAuth('SIGNED_IN', { user: { id: 'fixture-user' }, access_token: 'fixture-old', refresh_token: 'fixture-refresh' });
  calls.length = 0;

  await within(coordinator.handleNativeSession({ generation: 1, accessToken: 'fixture-new', refreshToken: 'fixture-new-refresh' }));

  assert.deepEqual(calls, ['native_realtime_stop', 'startAutoRefresh']);
});

const tapHarness = () => {
  let listener;
  let pending = null;
  const navigated = [];
  const listen = async (_event, callback) => { listener = callback; return () => {}; };
  const invoke = async () => { const tap = pending; pending = null; return tap; };
  return {
    options: { listen, invoke, onTap: (tap) => navigated.push(tap.channelId) }, navigated,
    emit: async (tap) => { pending = tap; await listener({ payload: tap }); },
  };
};

test('a live notification tap is consumed before a remount can replay it', async () => {
  const { options, navigated, emit } = tapHarness();
  const detach = await attachNativeNotificationTaps(options);
  await emit({ channelId: 'fixture-channel', messageId: 'message:42' });
  detach();

  const detachAgain = await attachNativeNotificationTaps(options);
  detachAgain();

  assert.deepEqual(navigated, ['fixture-channel']);
});

test('a consumed tap finishing during a listener gap is retained for the next mount', async () => {
  let listener;
  let pending = Promise.resolve(null);
  const response = deferred();
  const navigated = [];
  const options = {
    listen: async (_event, callback) => { listener = callback; return () => {}; },
    invoke: async () => { const value = pending; pending = Promise.resolve(null); return value; },
    onTap: (tap) => navigated.push(tap.channelId),
  };
  const detach = await attachNativeNotificationTaps(options);
  pending = response.promise;
  const consuming = listener({ payload: { channelId: 'fixture-channel', messageId: 'message:43' } });
  detach();
  response.resolve({ channelId: 'fixture-channel', messageId: 'message:43' });
  await consuming;
  assert.deepEqual(navigated, []);

  const detachAgain = await attachNativeNotificationTaps(options);
  detachAgain();

  assert.deepEqual(navigated, ['fixture-channel']);
});
