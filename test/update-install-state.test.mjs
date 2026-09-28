import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const swc = require('next/dist/build/swc');
await swc.loadBindings();
const filename = fileURLToPath(new URL('../app/use-app-update.js', import.meta.url));
const { code } = swc.transformSync(readFileSync(filename, 'utf8'), {
  filename, jsc: { target: 'es2022', parser: { syntax: 'ecmascript' } }, module: { type: 'commonjs' },
});
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

function fixture({ getVersion = async () => '1.2.3', relaunch = async () => {} } = {}) {
  let active, cursor, checks = 0, downloads = 0, relaunches = 0;
  let checkImpl;
  let download = deferred();
  const instances = new Set(), intervals = new Set();
  const equal = (a, b) => a && b && a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
  const slot = create => {
    const i = cursor++, owner = active;
    owner.slots[i] ??= create();
    return owner.slots[i];
  };
  const react = {
    useState(initial) {
      const cell = slot(() => ({ value: typeof initial === 'function' ? initial() : initial }));
      cell.set ??= next => { cell.value = typeof next === 'function' ? next(cell.value) : next; };
      return [cell.value, cell.set];
    },
    useRef(initial) { return slot(() => ({ current: initial })); },
    useCallback(callback, deps) {
      const cell = slot(() => ({}));
      if (!equal(cell.deps, deps)) { cell.value = callback; cell.deps = deps; }
      return cell.value;
    },
    useEffect(effect, deps) {
      const cell = slot(() => ({}));
      if (!equal(cell.deps, deps)) {
        cell.deps = deps;
        active.effects.push(() => { cell.cleanup?.(); cell.cleanup = effect(); });
      }
    },
  };
  const update = { version: '1.2.4', downloadAndInstall: () => { downloads++; return download.promise; } };
  checkImpl = async () => update;
  const imports = {
    react,
    '@tauri-apps/api/app': { getVersion },
    '@tauri-apps/plugin-updater': { check: () => { checks++; return checkImpl(); } },
    '@tauri-apps/plugin-process': { relaunch: () => { relaunches++; return relaunch(); } },
  };
  const module = { exports: {} };
  const load = new Function('require', 'module', 'exports', 'window', 'navigator', 'process', 'setInterval', 'clearInterval', 'fetch', code);
  load(id => { assert.ok(Object.hasOwn(imports, id), `Unexpected real dependency: ${id}`); return imports[id]; },
    module, module.exports, { __TAURI_INTERNALS__: {} }, { userAgent: 'fixture Tauri' },
    { env: { NEXT_PUBLIC_APP_VERSION: '0.0.1' } },
    callback => { intervals.add(callback); return callback; }, callback => intervals.delete(callback),
    () => { throw new Error('Unexpected real fetch'); });
  const render = instance => {
    active = instance; cursor = 0; instance.effects = [];
    instance.result = module.exports.useAppUpdate();
    active = null;
    for (const effect of instance.effects) effect();
    return instance.result;
  };
  return {
    mount() { const instance = { slots: [] }; instances.add(instance); render(instance); return instance; },
    render,
    unmount(instance) { for (const cell of instance.slots) cell.cleanup?.(); instances.delete(instance); },
    close() { for (const instance of [...instances]) this.unmount(instance); assert.equal(intervals.size, 0); },
    counts: () => ({ checks, downloads, relaunches }),
    setCheck(fn) { checkImpl = fn; },
    nextDownload() { download = deferred(); return download; },
    resolveDownload() { download.resolve(); },
    rejectDownload() { download.reject(new Error('fixture download failed')); },
    update,
  };
}

test('actual hook shares installing/ready across instances and prevents duplicate install', async t => {
  const f = fixture(); t.after(() => f.close());
  const shell = f.mount(), settings = f.mount();
  assert.equal(shell.result.versionReady, false);
  await flush();
  assert.equal(f.render(shell).current, '1.2.3');
  assert.equal(f.render(settings).versionReady, true);
  const install = shell.result.install();
  await settings.result.install();
  assert.equal(f.render(shell).phase, 'installing');
  assert.equal(f.render(settings).phase, 'installing');
  assert.equal(f.counts().downloads, 1);
  const checks = f.counts().checks;
  await settings.result.check();
  assert.equal(f.counts().checks, checks, 'busy install prevents new checks');
  const lateMount = f.mount();
  assert.equal(f.render(lateMount).phase, 'installing');
  f.resolveDownload(); await install;
  for (const instance of [shell, settings, lateMount]) assert.equal(f.render(instance).phase, 'ready');
  assert.equal(f.counts().relaunches, 1);
  await settings.result.install();
  assert.equal(f.counts().downloads, 1, 'ready also prevents another install');
});

test('late check success or failure cannot overwrite an active shared install', async t => {
  for (const fails of [false, true]) {
    await t.test(fails ? 'rejected late check' : 'resolved late check', async () => {
      const f = fixture();
      try {
        const shell = f.mount(), settings = f.mount(); await flush();
        const pending = deferred(); f.setCheck(() => pending.promise);
        const check = settings.result.check(); await flush();
        const install = shell.result.install();
        if (fails) pending.reject(new Error('fixture check failed')); else pending.resolve(f.update);
        await check;
        assert.equal(f.render(settings).phase, 'installing');
        f.resolveDownload(); await install;
        assert.equal(f.render(settings).phase, 'ready');
      } finally { f.close(); }
    });
  }
});

test('simultaneous install requests with no update handle still download only once', async t => {
  const f = fixture(); t.after(() => f.close());
  const pending = deferred(); f.setCheck(() => pending.promise);
  const shell = f.mount(), settings = f.mount();
  const first = shell.result.install(), second = settings.result.install();
  await flush();
  assert.equal(f.counts().downloads, 0);
  pending.resolve(f.update); await flush();
  assert.equal(f.counts().downloads, 1);
  assert.equal(f.render(shell).phase, 'installing');
  assert.equal(f.render(settings).phase, 'installing');
  f.resolveDownload(); await Promise.all([first, second]);
  assert.equal(f.render(shell).phase, 'ready');
  assert.equal(f.counts().relaunches, 1);
});

test('download/relaunch errors reach both hook instances; failed download can retry', async t => {
  for (const failsAt of ['download', 'relaunch']) {
    await t.test(failsAt, async () => {
      const f = fixture({ relaunch: async () => { if (failsAt === 'relaunch') throw new Error('fixture relaunch failed'); } });
      try {
        const shell = f.mount(), settings = f.mount(); await flush();
        const install = settings.result.install();
        if (failsAt === 'download') f.rejectDownload(); else f.resolveDownload();
        await install;
        assert.equal(f.render(shell).phase, 'error'); assert.equal(f.render(settings).phase, 'error');
        if (failsAt === 'download') {
          const next = f.nextDownload();
          const retry = shell.result.install();
          assert.equal(f.render(settings).phase, 'installing');
          next.resolve(); await retry;
          assert.equal(f.render(settings).phase, 'ready'); assert.equal(f.counts().downloads, 2);
        }
      } finally { f.close(); }
    });
  }
});

test('native version failure does not turn the build-time fallback into ready identity', async t => {
  for (const getVersion of [async () => { throw new Error('fixture version failure'); }, async () => '']) {
    const f = fixture({ getVersion }); t.after(() => f.close());
    const hook = f.mount(); await flush();
    assert.equal(f.render(hook).isApp, true);
    assert.equal(hook.result.current, '0.0.1');
    assert.equal(hook.result.versionReady, false);
    assert.equal(hook.result.checked, true, 'successful update check does not prove installed identity');
  }
});

test('unmounted hook unsubscribes and ignores a late native version response', async () => {
  const version = deferred();
  const f = fixture({ getVersion: () => version.promise });
  try {
    const removed = f.mount(); await flush(); f.unmount(removed);
    const active = f.mount(); await flush();
    version.resolve('1.2.3'); await flush();
    assert.equal(f.render(removed).versionReady, false);
    assert.equal(f.render(active).versionReady, true);
    const before = removed.result.phase;
    const install = active.result.install();
    assert.equal(f.render(removed).phase, before);
    f.resolveDownload(); await install;
  } finally { f.close(); }
});
