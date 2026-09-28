import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { localBindProof } from '../src/local-asset-access.mjs';

const source = (await readFile(new URL('../scripts/service.mjs', import.meta.url), 'utf8'))
  .replace(/^#!.*\n/, '').replace(/^import .*;\n/gm, '').replaceAll('import.meta.url', "'file:///repo/scripts/service.mjs'");
async function install({ ping = { argo: true, version: 'release', buildId: 'release-build' }, busy = false, commandFailure = '', envRoot = false, platform = 'linux', shim = '/home/tools/no-dock.cjs' } = {}) {
  const unit = '/home/.config/systemd/user/argo.service';
  const old = '[Service]\nExecStart=/node /repo/node_modules/next/dist/bin/next start -H 127.0.0.1 -p 41234\nWorkingDirectory=/repo\nEnvironment=ARGO_ROOT=/private-data\nEnvironment=ARGO_LOCAL_BIND_PROOF=\nEnvironmentFile=/settings.env\nExecStartPre=/usr/bin/true\nNoNewPrivileges=true\n';
  const files = new Map([['/settings.env', envRoot ? 'ARGO_ROOT=/unknown-data' : 'CUSTOM_FLAG=preserved'], [unit, old], ['/repo/package.json', '{"version":"release"}'], ['/repo/.next/BUILD_ID', 'release-build']]);
  const commands = [], reads = [], requests = [], events = [];
  let exit = 0;
  const dir = (name, directory = true) => ({ name, isDirectory: () => directory, isFile: () => !directory });
  const sandbox = {
    setupNoDock: async ({ env }) => { events.push('prepare'); await Promise.resolve(); if (shim) env.NODE_OPTIONS = `--require "${shim}"`; events.push('prepared'); return shim; },
    localBindProof, process: { platform, getuid: () => 501, env: { USER: 'test', PRIVATE_FIXTURE: 'do-not-copy', NODE_OPTIONS: '--fixture-shell-option' }, execPath: '/node', argv: ['node', 'service', 'install'], stdout: { write() {} }, exit: code => { exit = code; throw new Error(`exit:${code}`); } },
    dirname: p => p.slice(0, p.lastIndexOf('/')), join: (...p) => p.join('/'), fileURLToPath: () => '/repo/scripts/service.mjs', homedir: () => '/home',
    existsSync: p => files.has(p), mkdirSync() {}, rmSync: p => files.delete(p),
    readdirSync: p => { reads.push(p); return p === '/private-data' ? [dir('company')] : p === '/private-data/company/chats' && busy ? [dir('crew.status.json', false)] : []; },
    readFileSync: p => p.endsWith('status.json') ? JSON.stringify({ ts: Date.now() }) : files.get(p),
    writeFileSync: (p, data) => { events.push('write'); files.set(p, data); },
    execFileSync: (file, args) => { const cmd = [file, ...args].join(' '); commands.push(cmd); events.push(cmd); if (cmd === commandFailure) throw new Error('fixture command failed'); return ''; },
    spawnSync: () => { throw new Error('existing fixture build must be reused'); },
    console: { log() {}, error() {} },
    fetch: async url => { requests.push(url); return { ok: true, json: async () => ping }; },
    AbortSignal, setTimeout: fn => fn(),
  };
  let error;
  try { await vm.runInNewContext(`(async () => { ${source} })()`, sandbox); } catch (e) { error = e; }
  return { files, commands, reads, requests, events, exit, error, unit, old };
}

test('macOS launchd gets validated preload before Next starts, with XML-safe path', async () => {
  const r = await install({ platform: 'darwin', shim: '/home/A & B/no-dock.cjs' });
  assert.equal(r.error, undefined);
  const plist = r.files.get('/home/Library/LaunchAgents/com.beyondworks.argo.plist');
  assert.match(plist, /<key>NODE_OPTIONS<\/key><string>--require &quot;\/home\/A &amp; B\/no-dock.cjs&quot;<\/string>/);
  assert.match(plist, /<string>\/node<\/string><string>\/repo\/node_modules\/next\/dist\/bin\/next<\/string>/);
  assert.doesNotMatch(plist, /PRIVATE_FIXTURE|do-not-copy|fixture-shell-option/);
  assert.deepEqual(r.events.slice(0, 3), ['prepare', 'prepared', 'write']);
  assert.ok(r.events.indexOf('launchctl bootstrap gui/501 /home/Library/LaunchAgents/com.beyondworks.argo.plist') > r.events.indexOf('prepared'));
});

test('macOS failed preload preparation keeps service launch fail-open', async () => {
  const r = await install({ platform: 'darwin', shim: null });
  assert.equal(r.error, undefined);
  assert.doesNotMatch(r.files.get('/home/Library/LaunchAgents/com.beyondworks.argo.plist'), /NODE_OPTIONS/);
});

test('service reinstall checks preserved data root and restarts Linux unit with current bind proof', async () => {
  const r = await install();
  assert.equal(r.error, undefined);
  for (const setting of ['EnvironmentFile=/settings.env', 'ExecStartPre=/usr/bin/true', 'NoNewPrivileges=true', 'start -H 127.0.0.1 -p 41234']) assert.ok(r.files.get(r.unit).includes(setting));
  assert.ok(r.reads.includes('/private-data/company/chats'));
  assert.match(r.files.get(r.unit), /Environment=ARGO_ROOT=\/private-data/);
  assert.match(r.files.get(r.unit), /Environment=ARGO_LOCAL_BIND_PROOF=127.0.0.1/);
  assert.ok(r.commands.indexOf('systemctl --user restart argo') > r.commands.indexOf('systemctl --user enable argo'));
  assert.deepEqual(r.requests, ['http://127.0.0.1:41234/api/ping']);
  assert.equal(r.events.includes('prepare'), false);
});
for (const ping of [{ argo: false, version: 'release', buildId: 'release-build' }, { argo: true, version: 'old', buildId: 'release-build' }, { argo: true, version: 'release', buildId: 'old' }]) {
  test(`service rejects wrong identity/version/build and restores previous registration: ${JSON.stringify(ping)}`, async () => {
    const r = await install({ ping });
    assert.equal(r.exit, 1);
    assert.equal(r.files.get(r.unit), r.old);
    assert.deepEqual(r.commands.slice(-3), ['systemctl --user stop argo', 'systemctl --user daemon-reload', 'systemctl --user start argo']);
  });
}
test('busy existing custom data root blocks any Linux service mutation', async () => {
  const r = await install({ busy: true });
  assert.match(r.error.message, /실행 중/);
  assert.deepEqual(r.commands, []);
  assert.equal(r.files.get(r.unit), r.old);
});
test('failed Linux restart restores the previous unit and active state', async () => {
  const r = await install({ commandFailure: 'systemctl --user restart argo' });
  assert.match(r.error.message, /systemd 기동 실패/);
  assert.equal(r.files.get(r.unit), r.old);
  assert.equal(r.commands.at(-1), 'systemctl --user start argo');
});

test('environment-file data root ambiguity preserves custom service without restart', async () => {
  const r = await install({ envRoot: true });
  assert.match(r.error.message, /환경 파일의 데이터 경로/);
  assert.deepEqual(r.commands, []);
  assert.equal(r.files.get(r.unit), r.old);
});
