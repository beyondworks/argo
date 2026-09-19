import test from 'node:test';
import assert from 'node:assert/strict';
import { AuthApiError, AuthRetryableFetchError } from '@supabase/supabase-js';
import { createSessionRecovery } from '../src/session-recovery.mjs';

const SESSION = { user: { id: 'review-user' }, access_token: 'fresh' };
const OLD_SESSION = { user: { id: 'old-user' }, access_token: 'stale' };
const NEW_SESSION = { user: { id: 'new-user' }, access_token: 'new' };

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture(reads, { stored = true, getSession = null, signOut = async () => ({ error: null }) } = {}) {
  const applied = [];
  const waiting = [];
  const failures = [];
  const timers = new Map();
  const listeners = new Map();
  let timerId = 0;
  const auth = { getSession: getSession ?? (async () => reads.shift()), signOut };
  const recovery = createSessionRecovery({
    auth,
    hasStoredSession: () => stored,
    applySession: (session) => applied.push(session),
    setWaiting: (value) => waiting.push(value),
    setFailure: (error) => failures.push(error),
    addEventListener: (name, handler) => listeners.set(name, handler),
    removeEventListener: (name) => listeners.delete(name),
    setTimer: (handler) => { const id = ++timerId; timers.set(id, handler); return id; },
    clearTimer: (id) => timers.delete(id),
  });
  const runTimer = async () => {
    const entry = timers.entries().next().value;
    assert.ok(entry, 'a retry is scheduled');
    timers.delete(entry[0]);
    await entry[1]();
  };
  return { recovery, applied, waiting, failures, timers, listeners, runTimer };
}

test('stored session + retryable refresh failure waits, then recovers automatically', async () => {
  // Given an expired session still stored locally and a temporary refresh outage.
  const f = fixture([
    { data: { session: null }, error: new AuthRetryableFetchError('offline', 503) },
    { data: { session: SESSION }, error: null },
  ]);

  // When the cold-start read fails and the scheduled retry later succeeds.
  await f.recovery.start();

  // Then the app keeps authentication indeterminate instead of showing Auth.
  assert.deepEqual(f.applied, []);
  assert.deepEqual(f.waiting, [true]);
  await f.runTimer();
  assert.deepEqual(f.applied, [SESSION]);
  assert.deepEqual(f.waiting, [true, false]);
  f.recovery.stop();
});

test('online event retries immediately while waiting', async () => {
  // Given a cold start currently waiting on a retryable network error.
  const f = fixture([
    { data: { session: null }, error: new AuthRetryableFetchError('offline', 503) },
    { data: { session: SESSION }, error: null },
  ]);
  await f.recovery.start();

  // When the browser reports that the network returned.
  await f.listeners.get('online')();

  // Then the stored session is refreshed without a reload.
  assert.deepEqual(f.applied, [SESSION]);
  assert.equal(f.timers.size, 0);
  f.recovery.stop();
});

test('SIGNED_OUT always leaves waiting state and preserves the D10 path', async () => {
  // Given bootstrap is waiting after a retryable refresh failure.
  const f = fixture([{ data: { session: null }, error: new AuthRetryableFetchError('offline', 503) }]);
  await f.recovery.start();

  // INITIAL_SESSION null is ambiguous while credentials remain stored.
  f.recovery.onAuthStateChange('INITIAL_SESSION', null);
  assert.deepEqual(f.applied, []);

  // When Supabase reports an actual sign-out.
  f.recovery.onAuthStateChange('SIGNED_OUT', null);

  // Then null is applied immediately; INITIAL_SESSION null alone does not do this.
  assert.deepEqual(f.applied, [null]);
  assert.equal(f.waiting.at(-1), false);
  assert.equal(f.timers.size, 0);
  f.recovery.stop();
});

test('late INITIAL_SESSION null applies Auth after rejected credentials were removed', () => {
  // Given auth-js removed rejected credentials before this subscriber attached.
  const f = fixture([], { stored: false });

  // When the late subscriber receives only INITIAL_SESSION null.
  f.recovery.onAuthStateChange('INITIAL_SESSION', null);

  // Then the app still reaches the D10/Auth path without needing the missed SIGNED_OUT event.
  assert.deepEqual(f.applied, [null]);
});

test('non-retryable refresh rejection and first-run null both show Auth', async () => {
  // Given one rejected stored credential and one device with no stored session.
  const rejected = fixture([{ data: { session: null }, error: new AuthApiError('invalid refresh', 400, 'refresh_token_not_found') }]);
  const firstRun = fixture([{ data: { session: null }, error: null }], { stored: false });

  // When bootstrap reads each state.
  await rejected.recovery.start();
  await firstRun.recovery.start();

  // Then neither state is mislabeled as a connection wait.
  assert.deepEqual(rejected.applied, [null]);
  assert.deepEqual(firstRun.applied, [null]);
  assert.equal(rejected.waiting.at(-1), false);
  assert.equal(firstRun.waiting.at(-1), false);
  rejected.recovery.stop();
  firstRun.recovery.stop();
});

test('delayed initial read cannot restore a session after SIGNED_OUT', async () => {
  // Given the cold-start read is still pending.
  const pending = deferred();
  const f = fixture([], { getSession: () => pending.promise });
  const starting = f.recovery.start();

  // When a later authoritative SIGNED_OUT arrives before the old read finishes.
  f.recovery.onAuthStateChange('SIGNED_OUT', null);
  pending.resolve({ data: { session: OLD_SESSION }, error: null });
  await starting;

  // Then the stale initial result cannot sign the user back in.
  assert.deepEqual(f.applied, [null]);
  f.recovery.stop();
});

test('verified local sign-out cancels a delayed initial read before showing Auth', async () => {
  // Given the cold-start read is still pending.
  const pending = deferred();
  const f = fixture([], { getSession: () => pending.promise });
  const starting = f.recovery.start();

  // When the user chooses the waiting screen's re-login action.
  const result = await f.recovery.restartSignIn();
  pending.resolve({ data: { session: OLD_SESSION }, error: null });
  await starting;

  // Then the stale stored identity cannot replace the Auth screen.
  assert.equal(result.error, null);
  assert.deepEqual(f.applied, [null]);
  f.recovery.stop();
});

test('failed local sign-out stays waiting and a later retry can finish cleanup', async () => {
  // Given stored credentials and a first local sign-out that cannot clean them.
  const calls = [];
  let attempt = 0;
  const failure = new TypeError('storage blocked');
  const f = fixture([
    { data: { session: null }, error: new AuthRetryableFetchError('offline', 503) },
  ], { signOut: async (options) => { calls.push(options); attempt += 1; return { error: attempt === 1 ? failure : null }; } });
  await f.recovery.start();

  // When the user retries after the first cleanup failure.
  const first = await f.recovery.restartSignIn();
  const second = await f.recovery.restartSignIn();

  // Then Auth is applied only after the verified local cleanup succeeds.
  assert.equal(first.error, failure);
  assert.equal(second.error, null);
  assert.deepEqual(f.applied, [null]);
  assert.deepEqual(calls, [{ scope: 'local' }, { scope: 'local' }]);
  assert.equal(f.waiting.at(-1), false);
  f.recovery.stop();
});

test('auth-js SIGNED_OUT event owns the transition without a duplicate fallback apply', async () => {
  // Given auth-js broadcasts SIGNED_OUT before its local sign-out promise resolves.
  let f;
  f = fixture([
    { data: { session: null }, error: new AuthRetryableFetchError('offline', 503) },
  ], { signOut: async () => { f.recovery.onAuthStateChange('SIGNED_OUT', null); return { error: null }; } });
  await f.recovery.start();

  // When the user asks for a fresh sign-in.
  await f.recovery.restartSignIn();

  // Then the event is authoritative and the success fallback does not apply null twice.
  assert.deepEqual(f.applied, [null]);
  f.recovery.stop();
});

test('arbitrary thrown TypeError with stored credentials stops automatic retry and surfaces failure', async () => {
  // Given getSession throws a non-Supabase TypeError while credentials remain.
  const failure = new TypeError('storage implementation failed');
  const f = fixture([], { getSession: async () => { throw failure; } });

  // When cold-start recovery reads the session.
  await f.recovery.start();

  // Then it stays fail-closed without scheduling an infinite retry loop.
  assert.deepEqual(f.applied, []);
  assert.equal(f.waiting.at(-1), true);
  assert.equal(f.failures.at(-1), failure);
  assert.equal(f.timers.size, 0);
  f.recovery.stop();
});

test('new auth event wins over a delayed initial read from the previous identity', async () => {
  // Given the old cold-start read is still pending.
  const pending = deferred();
  const f = fixture([], { getSession: () => pending.promise });
  const starting = f.recovery.start();

  // When a new identity signs in before the old read finishes.
  f.recovery.onAuthStateChange('SIGNED_IN', NEW_SESSION);
  pending.resolve({ data: { session: OLD_SESSION }, error: null });
  await starting;

  // Then the newer auth event remains authoritative.
  assert.deepEqual(f.applied, [NEW_SESSION]);
  f.recovery.stop();
});
