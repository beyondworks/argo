import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as policy from '../src/core/desktop-auth-policy.js';

if (!vm.SourceTextModule) {
  test('desktop controller lifecycle in isolated module runtime', () => {
    const run = spawnSync(process.execPath, ['--experimental-vm-modules', '--test', fileURLToPath(import.meta.url)], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stdout + run.stderr);
  });
} else {
  const tick = async () => { for (let i = 0; i < 8; i++) await new Promise(setImmediate); };
  const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
  const session = { data: { session: { user: { id: 'u1' } } } };
  async function harness() {
    const store = new Map(), timers = new Map(), sessions = [], finishes = [], exchanges = [];
    let handler;
    const context = vm.createContext({ URL, URLSearchParams, Event, AbortSignal, console, window: { dispatchEvent() {} }, localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) }, setTimeout: (fn) => { const id = {}; timers.set(id, fn); return id; }, clearTimeout: (id) => timers.delete(id) });
    const exportsByPath = {
      '../../../messenger/src/oauth-handoff.mjs': { handoff() {} },
      './supabase.js': { getClient: async () => ({ auth: { getSession: () => sessions.shift()?.promise ?? Promise.resolve(session) } }), supabaseUrl: 'http://localhost:54321', devPasswordLogin: false },
      './platform.js': { isDesktop: () => true, apiUrl: (v) => v, openExternal: async () => {} },
      './i18n.js': { t: (v) => v }, './desktop-auth-policy.js': policy,
      '@tauri-apps/plugin-deep-link': { onOpenUrl: async (fn) => { handler = fn; }, getCurrent: async () => null },
      './mail.js': { finishConnect: (_code, state) => { exchanges.push(state); return finishes.shift()?.promise ?? Promise.resolve({ address: 'fixture@example.test' }); }, loadAccounts: async () => {} },
      './router.jsx': { navigate() {} }, '../ui/Overlay.jsx': { showToast() {} },
    };
    const modules = new Map();
    async function dependency(path) {
      if (modules.has(path)) return modules.get(path);
      const values = exportsByPath[path];
      assert.ok(values, path);
      const module = new vm.SyntheticModule(Object.keys(values), function () { for (const [key, value] of Object.entries(values)) this.setExport(key, value); }, { context });
      modules.set(path, module); await module.link(() => {}); await module.evaluate(); return module;
    }
    const module = new vm.SourceTextModule(readFileSync(new URL('../src/core/desktop-auth.js', import.meta.url), 'utf8'), { context, initializeImportMeta(meta) { meta.env = {}; }, importModuleDynamically: dependency });
    await module.link(dependency); await module.evaluate(); await module.namespace.initDesktopAuth();
    return { api: module.namespace, store, sessions, finishes, exchanges, deliver: (state) => handler([`argo-office://mail/callback?state=${state}&code=c`]) };
  }
  const authUrl = (state) => `https://accounts.google.com/o/oauth2/v2/auth?state=${state}`;
  test('double start is rejected while session read waits; cancelled launch cannot overwrite newer state', async () => {
    const h = await harness(), first = deferred(), second = deferred();
    h.sessions.push(first);
    const a = h.api.startDesktopMail(authUrl('first')).catch((e) => e.code);
    await tick();
    await assert.rejects(h.api.startDesktopMail(authUrl('duplicate')), { code: 'busy' });
    h.api.cancelDesktopMail();
    h.sessions.push(second);
    const b = h.api.startDesktopMail(authUrl('second')).catch((e) => e.code);
    await tick(); first.resolve(session); assert.equal(await a, 'cancelled');
    second.resolve(session); await tick();
    assert.equal(JSON.parse(h.store.get('argo-office-mail-pending')).state, 'second');
    h.api.cancelDesktopMail(); assert.equal(await b, 'cancelled');
  });
  test('old failed exchange cannot clear newer pending request; queued duplicate exchanges only once', async () => {
    const h = await harness(), finish = deferred(); h.finishes.push(finish);
    const a = h.api.startDesktopMail(authUrl('first')).catch((e) => e.code); await tick();
    h.deliver('first'); h.deliver('first'); await tick();
    assert.equal(h.finishes.length, 0);
    h.api.cancelDesktopMail(); assert.equal(await a, 'cancelled');
    const b = h.api.startDesktopMail(authUrl('second')).catch((e) => e.code); await tick();
    finish.reject(new Error('network')); await tick();
    assert.equal(JSON.parse(h.store.get('argo-office-mail-pending')).state, 'second');
    h.deliver('second'); assert.equal((await b).address, 'fixture@example.test');
    assert.deepEqual(h.exchanges, ['first', 'second']);
    assert.equal(h.store.has('argo-office-mail-pending'), false);
  });
  test('session read rejection settles active wait and later deliveries recover', async () => {
    const h = await harness();
    const a = h.api.startDesktopMail(authUrl('first')).catch((e) => e.message); await tick();
    const read = deferred(); h.sessions.push(read); h.deliver('first'); await tick(); read.reject(new Error('offline'));
    assert.equal(await a, 'offline');
    const b = h.api.startDesktopMail(authUrl('second')); await tick(); h.deliver('second');
    assert.equal((await b).address, 'fixture@example.test');
  });
}
