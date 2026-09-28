import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { posix as path } from 'node:path';

const source = await readFile(new URL('../scripts/e2e-runner-parity.mjs', import.meta.url), 'utf8');
const imports = source.match(/^import .*;$/gm) ?? [];
assert.ok(imports.every(line => /from 'node:(fs\/promises|os|path|child_process)'/.test(line)));
const body = source.replace(/^import .*;\n/gm, '');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const runScript = new AsyncFunction('mkdtemp', 'rm', 'readFile', 'unlink', 'tmpdir', 'homedir', 'join',
  'spawn', 'process', 'console', 'fetch', 'setTimeout', 'mkdir', body);
let serial = 0;

async function fixture({ outside = false, runners = 'claude,codex', disconnected = [], cleanupFails = false } = {}) {
  const homeProbe = '/fixture/user-home/argo-parity-probe.txt';
  const files = new Map([[homeProbe, 'existing user content']]);
  const roots = [], removed = [], writes = [], messages = [], events = [];
  let serverEnv, killed = false, exited = null, chatCalls = 0;
  const response = (status, json) => ({ status, ok: status === 200, text: async () => JSON.stringify(json) });
  const env = { PARITY_RUNNERS: runners, ...(outside ? { PARITY_TASK: 'outside' } : {}) };
  const fakeFetch = async (url, options = {}) => {
    assert.ok(url.startsWith('http://127.0.0.1:3171/'), 'only fixture API calls are accepted');
    const route = new URL(url).pathname;
    const payload = options.body ? JSON.parse(options.body) : {};
    if (route === '/api/ping') return response(200, {});
    if (route === '/api/account/keys') return response(disconnected.includes(payload.runner) ? 400 : 200, {});
    if (route === '/api/companies') return response(200, { company: { id: 'fixture-company' } });
    if (route.endsWith('/agents')) return response(200, { agent: { slug: 'fixture-agent' } });
    if (route.endsWith('/agents/fixture-agent')) return response(200, {});
    if (route.endsWith('/chat')) {
      chatCalls++;
      messages.push(payload.message);
      const tag = payload.message.match(/"(parity-[^"]*)"/)?.[1];
      assert.ok(tag);
      if (outside) {
        const destination = payload.message.match(/(\/[^\s]+) 파일에/)?.[1];
        assert.ok(destination);
        files.set(destination, tag); writes.push(destination);
      } else {
        const destination = path.join(serverEnv.ARGO_ROOT, 'fixture-company', 'routines.json');
        const routines = JSON.parse(files.get(destination) ?? '[]');
        routines.push({ title: tag }); files.set(destination, JSON.stringify(routines));
      }
      return response(200, { reply: 'fixture success' });
    }
    throw new Error(`Unexpected fixture API route ${route}`);
  };
  const exit = code => { events.push('exit'); exited = code; throw new Error('fixture exit'); };
  try {
    await runScript(
      async prefix => { const root = `${prefix}${++serial}`; roots.push(root); return root; },
      async destination => {
        events.push('cleanup-start');
        await Promise.resolve();
        if (cleanupFails) throw new Error('fixture cleanup failed');
        removed.push(destination);
        for (const name of files.keys()) if (name === destination || name.startsWith(`${destination}/`)) files.delete(name);
        events.push('cleanup-end');
      },
      async destination => { if (!files.has(destination)) throw new Error('fixture ENOENT'); return files.get(destination); },
      async destination => { removed.push(destination); files.delete(destination); },
      () => '/fixture/tmp', () => '/fixture/user-home', path.join,
      (_command, _args, options) => { serverEnv = options.env; return { stdout: { on() {} }, stderr: { on() {} }, kill() { killed = true; } }; },
      { env, exit, stdout: { write() {} }, stderr: { write() {} } }, { log() {}, error() {} }, fakeFetch,
      callback => callback(), async () => {},
    );
  } catch (error) {
    if (error.message !== 'fixture exit') throw error;
  }
  assert.equal(killed, true);
  return { files, homeProbe, roots, removed, writes, messages, serverEnv, exited, chatCalls, events };
}

test('default parity never removes the user home probe and cleans only its own temporary root', async () => {
  const run = await fixture();
  assert.equal(run.exited, 0);
  assert.equal(run.files.get(run.homeProbe), 'existing user content');
  assert.ok(run.removed.every(name => run.roots.some(root => name === root || name.startsWith(`${root}/`))));
  assert.ok(run.roots.every(root => run.removed.includes(root)));
  assert.deepEqual(run.events, ['cleanup-start', 'cleanup-end', 'exit']);
});

test('outside mode uses a per-run temporary sibling of ARGO_ROOT, never a fixed user home file', async () => {
  const first = await fixture({ outside: true }), second = await fixture({ outside: true });
  for (const run of [first, second]) {
    assert.equal(run.exited, 0);
    assert.equal(run.files.get(run.homeProbe), 'existing user content');
    assert.equal(new Set(run.writes).size, 2, 'each runner gets a fresh probe');
    for (const name of run.writes) {
      assert.ok(run.roots.some(root => name.startsWith(`${root}/`)));
      assert.ok(!name.startsWith(`${run.serverEnv.ARGO_ROOT}/`), 'outside probe is outside workspace root');
    }
    assert.ok(run.removed.every(name => run.roots.some(root => name === root || name.startsWith(`${root}/`))));
  }
  assert.ok(first.writes.every(name => !second.writes.includes(name)));
});

test('every required runner must run: all skipped and partial skipped both exit nonzero', async () => {
  for (const disconnected of [['claude', 'codex'], ['codex']]) {
    const run = await fixture({ disconnected });
    assert.notEqual(run.exited, 0);
    assert.equal(run.chatCalls, 2 - disconnected.length);
  }
});

test('an empty requested runner set cannot produce a passing parity result', async () => {
  const run = await fixture({ runners: ', ,' });
  assert.notEqual(run.exited, 0);
});

test('cleanup failure cannot be reported as a successful parity run', async () => {
  const run = await fixture({ cleanupFails: true });
  assert.notEqual(run.exited, 0);
  assert.equal(run.files.get(run.homeProbe), 'existing user content');
  assert.deepEqual(run.events, ['cleanup-start', 'exit']);
});
