import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { localBindProof } from '../src/local-asset-access.mjs';

const source = (await readFile(new URL('../scripts/service.mjs', import.meta.url), 'utf8'))
  .replace(/^#!.*\n/, '').replace(/^import .*;\n/gm, '').replaceAll('import.meta.url', "'file:///repo/scripts/service.mjs'");
async function install({ ping = { argo: true, version: 'release', buildId: 'release-build' }, busy = false, commandFailure = '', envRoot = false } = {}) {
  const unit = '/home/.config/systemd/user/argo.service';
  const old = '[Service]\nExecStart=/node /repo/node_modules/next/dist/bin/next start -H 127.0.0.1 -p 41234\nWorkingDirectory=/repo\nEnvironment=ARGO_ROOT=/private-data\nEnvironment=ARGO_LOCAL_BIND_PROOF=\nEnvironmentFile=/settings.env\nExecStartPre=/usr/bin/true\nNoNewPrivileges=true\n';
  const files = new Map([['/settings.env', envRoot ? 'ARGO_ROOT=/unknown-data' : 'CUSTOM_FLAG=preserved'], [unit, old], ['/repo/package.json', '{"version":"release"}'], ['/repo/.next/BUILD_ID', 'release-build']]);
  const commands = [], reads = [], requests = [];
  let exit = 0;
  const dir = (name, directory = true) => ({ name, isDirectory: () => directory, isFile: () => !directory });
  const sandbox = {
    localBindProof, process: { platform: 'linux', env: { USER: 'test' }, execPath: '/node', argv: ['node', 'service', 'install'], stdout: { write() {} }, exit: code => { exit = code; throw new Error(`exit:${code}`); } },
    dirname: p => p.slice(0, p.lastIndexOf('/')), join: (...p) => p.join('/'), fileURLToPath: () => '/repo/scripts/service.mjs', homedir: () => '/home',
    existsSync: p => files.has(p), mkdirSync() {}, rmSync: p => files.delete(p),
    readdirSync: p => { reads.push(p); return p === '/private-data' ? [dir('company')] : p === '/private-data/company/chats' && busy ? [dir('crew.status.json', false)] : []; },
    readFileSync: p => p.endsWith('status.json') ? JSON.stringify({ ts: Date.now() }) : files.get(p),
    writeFileSync: (p, data) => files.set(p, data),
    execFileSync: (file, args) => { const cmd = [file, ...args].join(' '); commands.push(cmd); if (cmd === commandFailure) throw new Error('fixture command failed'); return ''; },
    spawnSync: () => { throw new Error('existing fixture build must be reused'); },
    console: { log() {}, error() {} },
    fetch: async url => { requests.push(url); return { ok: true, json: async () => ping }; },
    AbortSignal, setTimeout: fn => fn(),
  };
  let error;
  try { await vm.runInNewContext(`(async () => { ${source} })()`, sandbox); } catch (e) { error = e; }
  return { files, commands, reads, requests, exit, error, unit, old };
}

test('service reinstall checks preserved data root and restarts Linux unit with current bind proof', async () => {
  const r = await install();
  assert.equal(r.error, undefined);
  for (const setting of ['EnvironmentFile=/settings.env', 'ExecStartPre=/usr/bin/true', 'NoNewPrivileges=true', 'start -H 127.0.0.1 -p 41234']) assert.ok(r.files.get(r.unit).includes(setting));
  assert.ok(r.reads.includes('/private-data/company/chats'));
  assert.match(r.files.get(r.unit), /Environment=ARGO_ROOT=\/private-data/);
  assert.match(r.files.get(r.unit), /Environment=ARGO_LOCAL_BIND_PROOF=127.0.0.1/);
  assert.ok(r.commands.indexOf('systemctl --user restart argo') > r.commands.indexOf('systemctl --user enable argo'));
  assert.deepEqual(r.requests, ['http://127.0.0.1:41234/api/ping']);
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
