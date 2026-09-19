import test from 'node:test';
import assert from 'node:assert/strict';
import { authCleanupState, hasStoredAuthSession } from '../src/auth-storage.mjs';

const KEY = 'sb-fixture-auth-token';
const store = (value) => {
  const values = new Map(value === undefined ? [] : [[KEY, value]]);
  return { getItem: (key) => values.get(key) ?? null, removeItem: (key) => values.delete(key), values };
};

test('expired but structurally valid stored credentials count as recoverable', () => {
  const storage = store(JSON.stringify({ access_token: 'access', refresh_token: 'refresh', expires_at: 1 }));
  assert.equal(hasStoredAuthSession(KEY, storage), true);
});

test('cleanup marker is durable and matches only its own storage event', () => {
  const values = new Map([[KEY, 'old-session']]);
  const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
  const state = authCleanupState(KEY, storage);
  state.begin();
  assert.equal(state.read(), 'pending');
  assert.equal(state.matches({ key: `${KEY}-argo-cleanup-pending` }), true);
  assert.equal(state.matches({ key: KEY }), false);
  state.complete();
  assert.equal(state.read(), 'complete');
  assert.equal(state.hasNewSession(), false);
  values.set(KEY, 'new-session');
  assert.equal(state.hasNewSession(), true);
  state.clear();
  assert.equal(state.read(), null);
});

test('malformed or incomplete storage is not mistaken for a recoverable session', () => {
  for (const value of ['', 'null', '[]', '{}', '{', JSON.stringify({ access_token: 'access', refresh_token: 2, expires_at: 1 })]) {
    assert.equal(hasStoredAuthSession(KEY, store(value)), false, value);
  }
  assert.equal(hasStoredAuthSession('sb-other-auth-token', store(JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_at: 1 }))), false);
  assert.equal(hasStoredAuthSession(KEY, { getItem() { throw new Error('blocked'); } }), false);
});
