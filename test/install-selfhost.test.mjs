import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { localAssetRequestDenied } from '../src/local-asset-access.mjs';

const installer = new URL('../scripts/install.sh', import.meta.url);
const available = process.platform !== 'win32';
async function fixture(t, { existing = false, mismatch = '', busy = false, customRoot = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'argo-installer-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home'), base = join(home, '.argo-selfhost'), bin = join(root, 'bin');
  const unit = join(home, '.config/systemd/user/argo.service');
  const workspaces = customRoot ? join(root, 'custom-workspaces') : join(base, 'data/workspaces');
  const put = async (file, text, mode) => { await mkdir(dirname(file), { recursive: true }); await writeFile(file, text, { mode }); };
  const packageAt = async (dir, version, build) => {
    await put(join(dir, 'server.js'), '// isolated fixture, never executed');
    await put(join(dir, 'package.json'), JSON.stringify({ version }));
    await put(join(dir, '.next/BUILD_ID'), build);
  };
  await packageAt(join(root, 'argo-server'), '2.0.0', 'new-build');
  const tar = join(root, 'server.tar.gz');
  assert.equal(spawnSync('tar', ['-czf', tar, '-C', root, 'argo-server']).status, 0);
  if (existing) {
    await packageAt(join(base, 'app'), '1.0.0', 'old-build');
    await put(join(base, 'app/.env.local'), 'CUSTOM_FLAG=preserved');
    await put(unit, `[Service]\nExecStart=${process.execPath} ${base}/app/server.js\nWorkingDirectory=${base}/app\nEnvironment=PORT=41234\nEnvironment=HOSTNAME=127.0.0.1\nEnvironment=ARGO_ROOT=${workspaces}\nEnvironment=CUSTOM_SETTING=preserved\n`);
  }
  await put(join(base, 'data/workspaces/company/company.json'), '{"name":"Preserve my company"}');
  if (busy) await put(join(workspaces, 'company/chats/crew.status.json'), JSON.stringify({ ts: Date.now(), stage: 'work' }));
  await put(join(root, 'state.json'), JSON.stringify({ active: existing, enabled: existing }));
  const runner = `#!${process.execPath}\n`;
  await put(join(bin, 'uname'), runner + `console.log(process.argv.includes('-m')?'x86_64':'Linux');`, 0o755);
  await put(join(bin, 'sleep'), '#!/bin/sh\nexit 0\n', 0o755);
  await put(join(bin, 'loginctl'), '#!/bin/sh\nexit 0\n', 0o755);
  await put(join(bin, 'systemctl'), runner + `
const fs=require('fs'),path=require('path'),root=process.env.FIXTURE_ROOT,base=process.env.ARGO_HOME;
const args=process.argv.slice(2).filter(x=>x!=='--user'&&x!=='--quiet');
const stateFile=path.join(root,'state.json'),s=JSON.parse(fs.readFileSync(stateFile));
fs.appendFileSync(path.join(root,'calls.log'),args.join(' ')+'\\n');
if(args[0]==='is-active')process.exit(s.active?0:3);
if(args[0]==='is-enabled')process.exit(s.enabled?0:1);
if(args[0]==='stop')s.active=false;
if(args[0]==='enable')s.enabled=true;
if(args[0]==='disable')s.enabled=false;
if(args[0]==='start'){
 s.active=true; const app=path.join(base,'app');
 s.ping={argo:true,version:JSON.parse(fs.readFileSync(path.join(app,'package.json'))).version,buildId:fs.readFileSync(path.join(app,'.next/BUILD_ID'),'utf8')};
 if(s.ping.buildId==='new-build'&&process.env.MISMATCH==='build')s.ping.buildId='old-build';
 if(s.ping.buildId==='new-build'&&process.env.MISMATCH==='version')s.ping.version='1.0.0';
}
fs.writeFileSync(stateFile,JSON.stringify(s));
`, 0o755);
  await put(join(bin, 'curl'), runner + `
const fs=require('fs'),path=require('path'),args=process.argv.slice(2),root=process.env.FIXTURE_ROOT;
if(args.some(a=>a.includes('api.github.com')))console.log(JSON.stringify({assets:[{browser_download_url:'https://example.invalid/argo-server-2.0.0-linux-x64.tar.gz'}]}));
else if(args.includes('-o'))fs.copyFileSync(path.join(root,'server.tar.gz'),args[args.indexOf('-o')+1]);
else{const s=JSON.parse(fs.readFileSync(path.join(root,'state.json')));if(!s.active||!s.ping)process.exit(7);console.log(JSON.stringify(s.ping));}
`, 0o755);
  const run = () => spawnSync('bash', [installer.pathname], { env: { ...process.env, PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH}`, HOME: home, ARGO_HOME: base, FIXTURE_ROOT: root, MISMATCH: mismatch }, encoding: 'utf8', timeout: 30_000 });
  return { root, base, unit, run, state: async () => JSON.parse(await readFile(join(root, 'state.json'))), calls: () => readFile(join(root, 'calls.log'), 'utf8') };
}

test('fresh Linux install grants local import capability and starts exact release', { skip: !available }, async t => {
  const f = await fixture(t), r = f.run();
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const unit = await readFile(f.unit, 'utf8');
  const env = Object.fromEntries([...unit.matchAll(/^Environment=([^=]+)=(.*)$/gm)].map(m => [m[1], m[2]]));
  assert.equal(localAssetRequestDenied(new Request('http://127.0.0.1:3001/api/local-assets', { headers: { host: '127.0.0.1:3001' } }), env), null);
  assert.deepEqual((await f.state()).ping, { argo: true, version: '2.0.0', buildId: 'new-build' });
  assert.ok(!(await readdir(f.base)).some(n => n.startsWith('.install.')));
});
test('running update stops then starts new build and preserves company/config/custom unit settings', { skip: !available }, async t => {
  const f = await fixture(t, { existing: true }), r = f.run();
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(await f.calls(), /stop argo.service\ndaemon-reload\nenable argo.service\nstart argo.service/);
  assert.equal((await f.state()).ping.buildId, 'new-build');
  assert.equal(await readFile(join(f.base, 'app/.env.local'), 'utf8'), 'CUSTOM_FLAG=preserved');
  assert.match(await readFile(f.unit, 'utf8'), /CUSTOM_SETTING=preserved/);
  assert.equal(await readFile(join(f.base, 'data/workspaces/company/company.json'), 'utf8'), '{"name":"Preserve my company"}');
});
for (const mismatch of ['build', 'version']) test(`mismatched ${mismatch} health restores prior running install`, { skip: !available }, async t => {
  const f = await fixture(t, { existing: true, mismatch }), oldUnit = await readFile(f.unit, 'utf8'), r = f.run();
  assert.equal(r.status, 1, r.stdout);
  assert.deepEqual((await f.state()).ping, { argo: true, version: '1.0.0', buildId: 'old-build' });
  assert.equal(await readFile(f.unit, 'utf8'), oldUnit);
  assert.equal(await readFile(join(f.base, 'app/.env.local'), 'utf8'), 'CUSTOM_FLAG=preserved');
});
test('failed fresh install removes new registration while preserving data', { skip: !available }, async t => {
  const f = await fixture(t, { mismatch: 'build' }), r = f.run();
  assert.equal(r.status, 1);
  assert.equal((await f.state()).active, false);
  assert.equal((await f.state()).enabled, false);
  await assert.rejects(readFile(f.unit), { code: 'ENOENT' });
  assert.ok(await readFile(join(f.base, 'data/workspaces/company/company.json')));
});
test('live turn defers update before changing or stopping current install', { skip: !available }, async t => {
  const f = await fixture(t, { existing: true, busy: true, customRoot: true }), oldUnit = await readFile(f.unit, 'utf8'), r = f.run();
  assert.equal(r.status, 1);
  assert.ok(!(await f.calls()).includes('stop'));
  assert.equal(await readFile(f.unit, 'utf8'), oldUnit);
  assert.equal(await readFile(join(f.base, 'app/.next/BUILD_ID'), 'utf8'), 'old-build');
});
