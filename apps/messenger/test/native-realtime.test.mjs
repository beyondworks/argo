import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createNativeRealtimeCoordinator, createNativeSessionApplier, attachNativeRealtimeLifecycle, attachNativeNotificationTaps, claimNativeNotification } from '../src/native-realtime.mjs';
import { createSessionRecovery } from '../src/session-recovery.mjs';

const session = (userId, accessToken = `access-${userId}`, refreshToken = `refresh-${userId}`) => ({
  user: { id: userId }, access_token: accessToken, refresh_token: refreshToken, expires_at: 2_000_000_000,
});

const harness = ({ startResult, currentSession = null } = {}) => {
  const calls = [];
  const auth = {
    stopAutoRefresh: () => calls.push(['stopAutoRefresh']),
    startAutoRefresh: () => calls.push(['startAutoRefresh']),
    setSession: async (value) => { calls.push(['setSession', value]); return { data: { session: value }, error: null }; },
  };
  const invoke = async (command, args) => {
    calls.push([command, args]);
    if (command === 'native_realtime_start') return startResult ?? { status: 'connected', generation: 1, userId: args.session.userId };
    if (command === 'native_realtime_snapshot') return { status: 'connected', generation: 1, userId: 'u1' };
    if (command === 'native_realtime_current_session') return currentSession;
    return { status: 'stopped' };
  };
  const context = () => ({ foreground: true, visible: true, focused: true, sound: 'wood-knock', currentChannel: 'c1', mutedChannelIds: ['c2'], quietFrom: 22, quietTo: 7 });
  const coordinator = createNativeRealtimeCoordinator({ enabled: true, auth, invoke, supabaseUrl: 'https://example.invalid', anonKey: 'public-anon', lang: 'ko', getContext: context });
  return { coordinator, calls };
};

test('initial session hands refresh ownership to native only after native start succeeds', async () => {
  // Given
  const { coordinator, calls } = harness();
  // When
  await coordinator.handleAuth('INITIAL_SESSION', session('u1'));
  // Then
  assert.equal(calls[0][0], 'native_realtime_start');
  assert.deepEqual(calls[0][1].session, { accessToken: 'access-u1', refreshToken: 'refresh-u1', expiresAt: 2_000_000_000, userId: 'u1' });
  assert.equal(calls[1][0], 'stopAutoRefresh');
});

test('failed native start leaves refresh ownership with supabase js', async () => {
  // Given
  const { coordinator, calls } = harness({ startResult: { status: 'unsupported' } });
  // When
  await coordinator.handleAuth('INITIAL_SESSION', session('u1'));
  // Then
  assert.deepEqual(calls.map(([name]) => name), ['native_realtime_start', 'startAutoRefresh']);
});

test('account switch stops the old generation before starting the new account without a js refresh race', async () => {
  // Given
  const { coordinator, calls } = harness();
  await coordinator.handleAuth('INITIAL_SESSION', session('u1'));
  calls.length = 0;
  // When
  await coordinator.handleAuth('SIGNED_IN', session('u2'));
  // Then
  assert.deepEqual(calls.map(([name]) => name), ['native_realtime_stop', 'native_realtime_start', 'stopAutoRefresh']);
  assert.equal(calls[0][1].generation, 1);
  assert.equal(calls[1][1].session.userId, 'u2');
  assert.equal(calls.some(([name]) => name === 'startAutoRefresh'), false);
});

test('signed out stops native before restoring supabase js refresh ownership', async () => {
  // Given
  const { coordinator, calls } = harness();
  await coordinator.handleAuth('INITIAL_SESSION', session('u1'));
  calls.length = 0;
  // When
  await coordinator.handleAuth('SIGNED_OUT', null);
  // Then
  assert.deepEqual(calls.map(([name]) => name), ['native_realtime_stop', 'startAutoRefresh']);
});

test('Auth is applied only after native sign-out cleanup and stale null cannot beat a newer identity', async () => {
  let finishStop;
  const stopped = new Promise((resolve) => { finishStop = resolve; });
  const applied = [];
  const native = Promise.resolve({ handleAuth: async (event) => { if (event === 'SIGNED_OUT') await stopped; } });
  const applier = createNativeSessionApplier({ native, applySession: (value) => applied.push(value) });

  applier.apply(null);
  await Promise.resolve();
  assert.deepEqual(applied, []);
  const newest = session('u2');
  applier.apply(newest);
  finishStop();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(applied, [newest]);
  applier.dispose();
});

test('provider sign-out then re-login transfers refresh ownership back to the new native generation', async () => {
  // Given
  const { coordinator, calls } = harness();
  await coordinator.handleAuth('SIGNED_IN', session('u1'));
  await coordinator.handleAuth('SIGNED_OUT', null);
  calls.length = 0;
  // When
  await coordinator.handleAuth('SIGNED_IN', session('u1', 'oauth-access', 'oauth-refresh'));
  // Then
  assert.deepEqual(calls.map(([name]) => name), ['native_realtime_start', 'stopAutoRefresh']);
  assert.equal(calls[0][1].session.accessToken, 'oauth-access');
});

test('session recovery forwards only the winning identity to native refresh ownership', async () => {
  // Given a cold-start read for an old identity is still pending.
  let resolveRead;
  const pendingRead = new Promise((resolve) => { resolveRead = resolve; });
  const { coordinator, calls } = harness();
  const applied = [];
  const recovery = createSessionRecovery({
    auth: { getSession: () => pendingRead },
    hasStoredSession: () => true,
    applySession: (next) => {
      applied.push(next);
      coordinator.handleAuth(next ? 'SIGNED_IN' : 'SIGNED_OUT', next);
    },
    setWaiting: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
  });
  const starting = recovery.start();

  // When a newer account event wins before the old read returns.
  const newest = session('u2', 'new-access', 'new-refresh');
  recovery.onAuthStateChange('SIGNED_IN', newest);
  resolveRead({ data: { session: session('u1') }, error: null });
  await starting;
  await coordinator.updateContext(); // drains the coordinator queue

  // Then the stale identity is never applied or handed native ownership.
  assert.deepEqual(applied, [newest]);
  const starts = calls.filter(([name]) => name === 'native_realtime_start');
  assert.equal(starts.length, 1);
  assert.equal(starts[0][1].session.userId, 'u2');
  recovery.stop();
  await coordinator.stop();
});

test('native token storage sync failure stops native before restoring js refresh ownership', async () => {
  // Given
  const failure = new Error('storage unavailable');
  const failingCalls = [];
  const failing = createNativeRealtimeCoordinator({
    enabled: true,
    auth: {
      stopAutoRefresh: () => failingCalls.push(['stopAutoRefresh']),
      startAutoRefresh: () => failingCalls.push(['startAutoRefresh']),
      setSession: async () => ({ error: failure }),
    },
    invoke: async (command, args) => {
      failingCalls.push([command, args]);
      if (command === 'native_realtime_start') return { generation: 4, userId: 'u1' };
      return { status: 'stopped' };
    },
    supabaseUrl: 'https://example.invalid', anonKey: 'public-anon', lang: 'ko', getContext: () => ({}),
  });
  await failing.handleAuth('INITIAL_SESSION', session('u1'));
  failingCalls.length = 0;
  // When
  await failing.handleNativeSession({ generation: 4, accessToken: 'new', refreshToken: 'new-r', expiresAt: 2_000_000_100 });
  // Then
  assert.deepEqual(failingCalls.map(([name]) => name), ['native_realtime_stop', 'startAutoRefresh']);
});

test('native session event applies only the current generation token change and keeps native ownership', async () => {
  // Given
  const { coordinator, calls } = harness();
  await coordinator.handleAuth('INITIAL_SESSION', session('u1'));
  calls.length = 0;
  // When
  await coordinator.handleNativeSession({ generation: 99, accessToken: 'stale', refreshToken: 'stale-r', expiresAt: 2_000_000_001 });
  await coordinator.handleNativeSession({ generation: 1, accessToken: 'access-u1', refreshToken: 'refresh-u1', expiresAt: 2_000_000_000 });
  await coordinator.handleNativeSession({ generation: 1, accessToken: 'new-access', refreshToken: 'new-refresh', expiresAt: 2_000_000_100 });
  // Then
  assert.deepEqual(calls.map(([name]) => name), ['setSession', 'stopAutoRefresh']);
  assert.deepEqual(calls[0][1], { access_token: 'new-access', refresh_token: 'new-refresh' });
});

test('foreground reconcile recovers a native refresh event missed while the webview was hidden', async () => {
  const refreshed = { generation: 1, accessToken: 'new-access', refreshToken: 'new-refresh', expiresAt: 2_000_000_100 };
  const { coordinator, calls } = harness({ currentSession: refreshed });
  await coordinator.handleAuth('INITIAL_SESSION', session('u1'));
  calls.length = 0;

  await coordinator.reconcile();

  assert.deepEqual(calls.map(([name]) => name), ['native_realtime_snapshot', 'native_realtime_current_session', 'setSession', 'stopAutoRefresh', 'native_realtime_update']);
});

test('visibility and focus boundaries snapshot on resume and update context when hidden', async () => {
  // Given
  const events = new EventTarget();
  const doc = new EventTarget();
  doc.visibilityState = 'hidden';
  const calls = [];
  const coordinator = { reconcile: async () => calls.push('snapshot'), updateContext: async () => calls.push('update') };
  const detach = attachNativeRealtimeLifecycle(coordinator, events, doc);
  // When
  events.dispatchEvent(new Event('blur'));
  doc.dispatchEvent(new Event('visibilitychange'));
  doc.visibilityState = 'visible';
  doc.dispatchEvent(new Event('visibilitychange'));
  events.dispatchEvent(new Event('focus'));
  detach();
  events.dispatchEvent(new Event('blur'));
  // Then
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, ['update', 'update', 'snapshot', 'snapshot']);
});

test('foreground notification uses the native shared message-id claim and native sound', async () => {
  // Given
  const calls = [];
  const invoke = async (command, args) => { calls.push([command, args]); return { status: 'sent' }; };
  // When
  const result = await claimNativeNotification(invoke, { messageId: 'r:42', channelId: 'channel-7', title: 'Agent', body: 'Done', sound: 'wood-knock' });
  // Then
  assert.deepEqual(calls, [['native_notify_claim_and_send', { messageId: 'message:42', channelId: 'channel-7', title: 'Agent', body: 'Done', sound: 'wood-knock' }]]);
  assert.deepEqual(result, { ok: true, status: 'sent' });
});

test('native notification tap consumes cold-start pending tap and live event once through channel navigation', async () => {
  // Given
  const navigated = [];
  let listener = null;
  let unlistened = 0;
  const listen = async (name, callback) => { assert.equal(name, 'native-notification-tap'); listener = callback; return () => { unlistened += 1; }; };
  const invoke = async (command) => { assert.equal(command, 'native_notification_pending_tap'); return { channelId: 'cold-channel', messageId: 'message:40' }; };
  // When
  const detach = await attachNativeNotificationTaps({ listen, invoke, onTap: (tap) => navigated.push(tap.channelId) });
  listener({ payload: { channelId: 'cold-channel', messageId: 'message:40' } });
  listener({ payload: { channelId: 'live-channel', messageId: 'message:41' } });
  listener({ payload: { channelId: '', messageId: 'message:42' } });
  detach();
  listener({ payload: { channelId: 'late-channel', messageId: 'message:43' } });
  // Then
  assert.deepEqual(navigated, ['cold-channel', 'live-channel']);
  assert.equal(unlistened, 1);
});

test('Shell wires native notification taps into the existing channel navigation request', () => {
  // Given
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  // When / Then
  assert.match(app, /mountNativeNotificationTaps\([\s\S]+onTap: \(\{ channelId \}\) => \{ if \(!disposed\) setNavTo\(channelId\); \}/);
});
