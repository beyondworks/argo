import test from 'node:test';
import assert from 'node:assert/strict';
import { AuthRetryableFetchError } from '@supabase/supabase-js';
import { reconcileSession } from '../src/resume-session.mjs';

test('temporary token-refresh failure preserves the current conversation and draft', async () => {
  const mounted = { session: { user: { id: 'review-user' } }, draft: 'Unsent message' };
  let replacements = 0;
  const apply = session => { replacements++; mounted.session = session; mounted.draft = ''; };
  await reconcileSession({ getSession: async () => ({ data: { session: null }, error: new AuthRetryableFetchError('offline', 503) }) }, apply);
  await reconcileSession({ getSession: async () => { throw new Error('offline'); } }, apply);
  assert.equal(replacements, 0);
  assert.equal(mounted.draft, 'Unsent message');
  const refreshed = { user: { id: 'review-user' }, expires_at: 500 };
  await reconcileSession({ getSession: async () => ({ data: { session: refreshed }, error: null }) }, apply);
  assert.equal(mounted.session, refreshed);
});

test('a successful read with no session applies sign-out', async () => {
  const changes = [];
  await reconcileSession({ getSession: async () => ({ data: { session: null }, error: null }) }, s => changes.push(s));
  assert.deepEqual(changes, [null]);
});
