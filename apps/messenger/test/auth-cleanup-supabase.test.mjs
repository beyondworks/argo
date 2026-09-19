import test from 'node:test';
import assert from 'node:assert/strict';
import { GoTrueClient } from '@supabase/supabase-js';
import { authCleanupState } from '../src/auth-storage.mjs';
import { createSessionRecovery } from '../src/session-recovery.mjs';

test('cleanup marker keeps a completed tombstone until a new session clears it', () => {
  const values = new Map([['sb-marker-auth-token', 'old-session']]);
  const storage = { getItem: (name) => values.get(name) ?? null, setItem: (name, value) => values.set(name, value), removeItem: (name) => values.delete(name) };
  const marker = authCleanupState('sb-marker-auth-token', storage);
  marker.begin();
  assert.equal(marker.read(), 'pending');
  marker.complete();
  assert.equal(marker.read(), 'complete');
  assert.equal(marker.hasNewSession(), false);
  values.set('sb-marker-auth-token', 'new-session');
  assert.equal(marker.hasNewSession(), true);
  marker.clear();
  assert.equal(marker.read(), null);
});

test('auth-js 2.114.0 can remove primary session before PKCE failure and skip SIGNED_OUT', async () => {
  const key = 'sb-d56-auth-token';
  const values = new Map([
    [key, JSON.stringify({
      access_token: 'not-a-real-jwt', refresh_token: 'refresh', token_type: 'bearer',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      user: { id: 'fixture-user', aud: 'authenticated', role: 'authenticated' },
    })],
    [`${key}-code-verifier`, 'verifier/recovery'],
    [`${key}-user`, JSON.stringify({ id: 'fixture-user' })],
  ]);
  let failPkceRemoval = true;
  const storage = {
    getItem: async (name) => values.get(name) ?? null,
    setItem: async (name, value) => values.set(name, value),
    removeItem: async (name) => {
      if (name === `${key}-code-verifier` && failPkceRemoval) {
        failPkceRemoval = false;
        throw new TypeError('fixture PKCE remove failure');
      }
      values.delete(name);
    },
  };
  const auth = new GoTrueClient({
    url: 'https://fixture.invalid/auth/v1', headers: {}, storageKey: key, storage,
    persistSession: true, autoRefreshToken: false, detectSessionInUrl: false,
    fetch: async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
  });
  auth.broadcastChannel = { postMessage() {}, close() {} };
  const events = [];
  auth.onAuthStateChange((event) => events.push(event));
  await assert.rejects(auth.signOut({ scope: 'local' }), /PKCE remove failure/);

  assert.equal(values.has(key), false, 'primary session is already gone');
  assert.equal(values.has(`${key}-code-verifier`), true, 'PKCE companion remains');
  assert.equal(values.has(`${key}-user`), true, 'user companion remains');
  assert.equal(events.includes('SIGNED_OUT'), false, 'failed cleanup emits no authoritative SIGNED_OUT');

  await auth.signOut({ scope: 'local' });
  assert.equal(values.has(`${key}-code-verifier`), false);
  assert.equal(values.has(`${key}-user`), false);
  assert.equal(events.includes('SIGNED_OUT'), true, 'retry completes cleanup through the SDK lifecycle');
});

test('durable recovery marker survives SDK broadcast failure until a later SIGNED_OUT', async () => {
  const key = 'sb-d56-broadcast-auth-token';
  const values = new Map([[key, JSON.stringify({
    access_token: 'not-a-real-jwt', refresh_token: 'refresh', token_type: 'bearer',
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: { id: 'fixture-user', aud: 'authenticated', role: 'authenticated' },
  })]]);
  const storage = {
    getItem: (name) => values.get(name) ?? null,
    setItem: (name, value) => values.set(name, value),
    removeItem: (name) => values.delete(name),
  };
  const auth = new GoTrueClient({
    url: 'https://fixture.invalid/auth/v1', headers: {}, storageKey: key, storage,
    persistSession: true, autoRefreshToken: false, detectSessionInUrl: false,
    fetch: async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
  });
  auth.broadcastChannel = { postMessage() {}, close() {} };
  const applied = [];
  const waiting = [];
  const marker = authCleanupState(key, storage);
  const recovery = createSessionRecovery({
    auth, cleanupState: marker, hasStoredSession: () => values.has(key),
    applySession: (session) => applied.push(session), setWaiting: (value) => waiting.push(value),
    addEventListener() {}, removeEventListener() {}, addVisibilityListener() {}, removeVisibilityListener() {},
  });
  auth.onAuthStateChange((event, session) => recovery.onAuthStateChange(event, session));
  await recovery.start();
  const originalPost = auth.broadcastChannel.postMessage.bind(auth.broadcastChannel);
  auth.broadcastChannel.postMessage = () => { throw new TypeError('fixture broadcast failure'); };

  const failed = await recovery.restartSignIn();
  assert.equal(failed.error?.message, 'fixture broadcast failure');
  assert.equal(marker.read(), 'pending');
  assert.equal(waiting.at(-1), true);
  assert.equal(applied.at(-1)?.user?.id, 'fixture-user');
  await recovery.retryNow();
  assert.equal(applied.at(-1)?.user?.id, 'fixture-user', 'clean main storage cannot bypass pending cleanup');

  auth.broadcastChannel.postMessage = originalPost;
  const completed = await recovery.restartSignIn();
  assert.equal(completed.error, null);
  assert.equal(marker.read(), 'complete');
  assert.equal(applied.at(-1), null);
  recovery.stop();
  auth.broadcastChannel?.close();
});

test('subscriber rejection after SIGNED_OUT does not restore cleanupPending', async () => {
  const key = 'sb-d56-subscriber-auth-token';
  const values = new Map([[key, JSON.stringify({
    access_token: 'not-a-real-jwt', refresh_token: 'refresh', token_type: 'bearer', expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: { id: 'fixture-user', aud: 'authenticated', role: 'authenticated' },
  })]]);
  const storage = { getItem: (name) => values.get(name) ?? null, setItem: (name, value) => values.set(name, value), removeItem: (name) => values.delete(name) };
  const auth = new GoTrueClient({ url: 'https://fixture.invalid/auth/v1', headers: {}, storageKey: key, storage,
    persistSession: true, autoRefreshToken: false, detectSessionInUrl: false,
    fetch: async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }) });
  const marker = authCleanupState(key, storage);
  const applied = [];
  const recovery = createSessionRecovery({ auth, cleanupState: marker, hasStoredSession: () => values.has(key),
    applySession: (session) => applied.push(session), setWaiting() {}, addEventListener() {}, removeEventListener() {}, addVisibilityListener() {}, removeVisibilityListener() {} });
  auth.onAuthStateChange((event, session) => recovery.onAuthStateChange(event, session));
  auth.onAuthStateChange((event) => { if (event === 'SIGNED_OUT') throw new TypeError('fixture subscriber failure'); });
  await recovery.start();
  const originalError = console.error;
  console.error = () => {};
  const result = await recovery.restartSignIn();
  console.error = originalError;
  assert.equal(result.error, null, 'delivered SIGNED_OUT remains authoritative despite a later subscriber rejection');
  assert.equal(marker.read(), 'complete');
  assert.equal(applied.at(-1), null);
  recovery.stop();
  auth.broadcastChannel?.close();
});
