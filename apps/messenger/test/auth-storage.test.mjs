import test from 'node:test';
import assert from 'node:assert/strict';
import { hasStoredAuthSession } from '../src/auth-storage.mjs';

const KEY = 'sb-fixture-auth-token';
const store = (value) => {
  const values = new Map(value === undefined ? [] : [[KEY, value]]);
  return { getItem: (key) => values.get(key) ?? null, removeItem: (key) => values.delete(key), values };
};

test('expired but structurally valid stored credentials count as recoverable', () => {
  const storage = store(JSON.stringify({ access_token: 'access', refresh_token: 'refresh', expires_at: 1 }));
  assert.equal(hasStoredAuthSession(KEY, storage), true);
});

test('malformed or incomplete storage is not mistaken for a recoverable session', () => {
  for (const value of ['', 'null', '[]', '{}', '{', JSON.stringify({ access_token: 'access', refresh_token: 2, expires_at: 1 })]) {
    assert.equal(hasStoredAuthSession(KEY, store(value)), false, value);
  }
  assert.equal(hasStoredAuthSession('sb-other-auth-token', store(JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_at: 1 }))), false);
  assert.equal(hasStoredAuthSession(KEY, { getItem() { throw new Error('blocked'); } }), false);
});
