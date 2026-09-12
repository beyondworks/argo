import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createPushSession, mountPushListeners } from '../src/push-lifecycle.mjs';

const deferred = () => { let resolve; let reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const flush = () => new Promise((resolve) => setImmediate(resolve));
function fixture(overrides = {}) {
  let user = 'a'; const calls = [];
  const deps = {
    getSession: async () => ({ user: { id: user }, access_token: `fixture-${user}` }),
    getToken: async (prompt) => { calls.push(['native', prompt]); return { token: 'fixture-device' }; },
    registerToken: async (token, session) => { calls.push(['register', token, session.user.id]); },
    unregisterToken: async (token, session) => { calls.push(['unregister', token, session.user.id]); },
    timeoutMs: 50, ...overrides,
  };
  return { manager: createPushSession(deps), calls, user: (value) => { user = value; } };
}

test('registration is detached under its owner before logout, with no token persistence', async () => {
  const { manager, calls } = fixture(); manager.activate('a');
  assert.equal(await manager.register(), 'registered');
  assert.deepEqual(await manager.detach('a'), { warning: false });
  assert.deepEqual(calls, [['native', true], ['register', 'fixture-device', 'a'], ['unregister', 'fixture-device', 'a']]);
  assert.equal(await manager.register(), 'cancelled');
});

test('logout before permission/token resolves never registers later', async () => {
  const token = deferred();
  const { manager, calls } = fixture({ getToken: (prompt) => prompt ? token.promise : Promise.resolve({ token: 'fixture-device' }) });
  manager.activate('a'); const registering = manager.register(); await flush();
  assert.deepEqual(await manager.detach('a'), { warning: false });
  token.resolve({ token: 'fixture-device' });
  assert.equal(await registering, 'cancelled');
  assert.deepEqual(calls, [['unregister', 'fixture-device', 'a']]);
});

test('logout waits for an already sent registration, then unregisters', async () => {
  const request = deferred(); const order = [];
  const { manager } = fixture({ registerToken: async () => { order.push('register'); await request.promise; }, unregisterToken: async () => order.push('unregister') });
  manager.activate('a'); const registering = manager.register(); await flush();
  const detaching = manager.detach('a'); await flush();
  assert.deepEqual(order, ['register']);
  request.resolve(); await registering;
  assert.deepEqual(await detaching, { warning: false });
  assert.deepEqual(order, ['register', 'unregister']);
});

test('same-user React remount still tracks the prior pending registration during logout', async () => {
  const request = deferred(); const order = [];
  const { manager } = fixture({ registerToken: async () => { order.push('register'); await request.promise; }, unregisterToken: async () => order.push('unregister') });
  manager.activate('a'); const registering = manager.register(); await flush();
  manager.deactivate('a'); manager.activate('a');
  const detaching = manager.detach('a'); await flush(); assert.deepEqual(order, ['register']);
  request.resolve(); await registering; await detaching;
  assert.deepEqual(order, ['register', 'unregister']);
});

test('restarted app obtains its native token without a new permission prompt', async () => {
  const { manager, calls } = fixture();
  assert.deepEqual(await manager.detach('a'), { warning: false });
  assert.deepEqual(calls, [['native', false], ['unregister', 'fixture-device', 'a']]);
});

test('different account cannot unregister the previous account token', async () => {
  const { manager, calls, user } = fixture(); manager.activate('a'); await manager.register(); user('b');
  assert.deepEqual(await manager.detach('a'), { warning: true });
  assert.equal(calls.filter(([name]) => name === 'unregister').length, 0);
});

test('an earlier account request finishes before a new account claims the token', async () => {
  const first = deferred(); const order = [];
  const { manager, user } = fixture({ registerToken: async (_token, session) => { order.push(session.user.id); if (session.user.id === 'a') await first.promise; } });
  manager.activate('a'); const a = manager.register(); await flush();
  user('b'); manager.activate('b'); const b = manager.register(); await flush();
  assert.deepEqual(order, ['a']); first.resolve();
  assert.equal(await a, 'cancelled'); assert.equal(await b, 'registered');
  assert.deepEqual(order, ['a', 'b']);
});

test('server coordinators keep token ownership isolated', async () => {
  const a = fixture(); const b = fixture(); a.manager.activate('a'); b.manager.activate('a');
  await a.manager.register(); await b.manager.register(); await a.manager.detach('a');
  assert.equal(b.calls.some(([name]) => name === 'unregister'), false);
  assert.equal(await b.manager.register(), 'registered');
});

test('unavailable token or failed removal returns a warning rather than hanging logout', async () => {
  const unavailable = fixture({ getToken: async () => ({ status: 'denied' }) });
  assert.deepEqual(await unavailable.manager.detach('a'), { warning: true });
  const failure = fixture({ unregisterToken: async () => { throw new Error('offline'); } });
  assert.deepEqual(await failure.manager.detach('a'), { warning: true });
  const hung = fixture({ unregisterToken: () => new Promise(() => {}), timeoutMs: 5 });
  assert.deepEqual(await hung.manager.detach('a'), { warning: true });
});

test('native listeners resolving after cleanup are immediately removed and cannot deliver callbacks', async () => {
  const pending = deferred(); let received = 0; let disposed = 0; let handlers;
  const stop = mountPushListeners((callbacks) => { handlers = callbacks; return pending.promise; }, { onTap: () => received++ });
  await flush(); stop(); handlers.onTap({ channel_id: 'fixture' }); pending.resolve(() => disposed++); await flush();
  assert.equal(received, 0); assert.equal(disposed, 1);
});

test('resolved native listeners receive events only while mounted, and cleanup is idempotent', async () => {
  let handlers; let received = 0; let disposed = 0;
  const stop = mountPushListeners(async (callbacks) => { handlers = callbacks; return () => disposed++; }, { onForeground: () => received++ });
  await flush(); handlers.onForeground({ body: 'fixture' }); stop(); stop(); handlers.onForeground({ body: 'fixture' });
  assert.equal(received, 1); assert.equal(disposed, 1);
});

test('App logout proceeds after push cleanup warning and reports it on the signed-out screen', async () => {
  const source = fs.readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const start = source.indexOf('  const signOut = async () => {');
  const body = source.slice(start, source.indexOf('  useMobileViewport();', start)).replace('const signOut =', 'globalThis.signOut =');
  const calls = []; let notice;
  const context = { logoutPending: { current: false }, session: { user: { id: 'fixture' } }, setSigningOut: () => {}, setLogoutNotice: (v) => { notice = v; },
    detachPush: async () => { calls.push('detach'); return { warning: true }; },
    supabase: { auth: { signOut: async (options) => { calls.push(options.scope); return {}; } } }, activatePush: () => calls.push('activate') };
  vm.runInNewContext(body, context); await context.signOut();
  assert.deepEqual(calls, ['detach', 'local']); assert.equal(notice, 'push.logout.detachFailed');
});

test('App failed logout re-registers the current account token without disposing the composer', async () => {
  const source = fs.readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const start = source.indexOf('  const signOut = async () => {');
  const body = source.slice(start, source.indexOf('  useMobileViewport();', start)).replace('const signOut =', 'globalThis.signOut =');
  let notice; let cleared = false; const order = [];
  const context = { logoutPending: { current: false }, session: { user: { id: 'fixture' } }, setSigningOut: () => {}, setLogoutNotice: (v) => { notice = v; }, clearComposerSessions: () => { cleared = true; },
    detachPush: async () => { order.push('detach'); return { warning: false }; },
    supabase: { auth: { signOut: async () => { order.push('signout'); return { error: { message: 'offline' } }; }, getSession: async () => ({ data: { session: { user: { id: 'fixture' } } } }) } },
    activatePush: () => order.push('activate'), registerPush: async () => { order.push('register'); return 'registered'; } };
  vm.runInNewContext(body, context); await context.signOut();
  assert.equal(cleared, false); assert.deepEqual(order, ['detach', 'signout', 'activate', 'register']); assert.equal(notice, 'push.logout.failed');
});

test('App failed logout never restores the previous account after another account signs in', async () => {
  const source = fs.readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const start = source.indexOf('  const signOut = async () => {');
  const body = source.slice(start, source.indexOf('  useMobileViewport();', start)).replace('const signOut =', 'globalThis.signOut =');
  const calls = [];
  const context = { logoutPending: { current: false }, session: { user: { id: 'old-user' } }, setSigningOut: () => {}, setLogoutNotice: () => {},
    detachPush: async () => ({ warning: false }), supabase: { auth: { signOut: async () => { throw new Error('offline'); }, getSession: async () => ({ data: { session: { user: { id: 'new-user' } } } }) } },
    activatePush: () => calls.push('activate'), registerPush: async () => { calls.push('register'); return 'registered'; } };
  vm.runInNewContext(body, context); await context.signOut(); assert.deepEqual(calls, []);
});

test('App reports a failed push restore after failed logout', async () => {
  const source = fs.readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const start = source.indexOf('  const signOut = async () => {');
  const body = source.slice(start, source.indexOf('  useMobileViewport();', start)).replace('const signOut =', 'globalThis.signOut =');
  let notice;
  const context = { logoutPending: { current: false }, session: { user: { id: 'fixture' } }, setSigningOut: () => {}, setLogoutNotice: (v) => { notice = v; },
    detachPush: async () => ({ warning: false }), supabase: { auth: { signOut: async () => ({ error: { message: 'offline' } }), getSession: async () => ({ data: { session: { user: { id: 'fixture' } } } }) } },
    activatePush: () => {}, registerPush: async () => 'error:registration' };
  vm.runInNewContext(body, context); await context.signOut(); assert.equal(notice, 'push.logout.restoreFailed');
});
