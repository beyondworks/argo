// install.sh 맥 갈래 — argo 명령 단독 설치(2026-10-06 유건 승인: node를 담은 자산·해시 확인·~/.argo-selfhost/app·~/.local/bin/argo·
// 앱이 있으면 거절·PATH는 안내만·업데이트는 재실행). 경우 표: artifacts/rc-0195/cli-standalone-case-table.md A1~A11.
// uname·sysctl·curl을 가짜로 바꿔 리눅스·맥 어디서든 맥 갈래를 탄다. 자산의 node는 이 테스트의 node를 가리키는 링크다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const installer = new URL('../scripts/install.sh', import.meta.url).pathname;
const available = process.platform !== 'win32';

async function fixture(t, { arch = 'arm64', arm64Chip = arch === 'arm64', version = '2.0.0', badSum = false, noSum = false, noAsset = false, statusFail = false, oldApp = false, app = false, appCopy = false, messengerApp = false, svc = false, appShim = false, shim = null, foreignInPath = false, cliBusy = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'argo-mac-installer-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home'), base = join(home, '.argo-selfhost'), bin = join(root, 'bin'), apps = join(root, 'Applications');
  const put = async (file, text, mode) => { await mkdir(dirname(file), { recursive: true }); await writeFile(file, text, { mode }); };
  const asset = async (dir, v) => {
    await mkdir(dir, { recursive: true });
    await symlink(process.execPath, join(dir, 'node'));
    await put(join(dir, 'package.json'), JSON.stringify({ name: 'argo', version: v }));
    await put(join(dir, 'bin/argo.mjs'), `if(process.argv[2]==='status'){if(process.env.ARGO_CLI_APP!=='0'){console.error('app mode');process.exit(2)}console.log('fixture status ${v}');process.exit(process.env.CLI_STATUS_FAIL?1:0)}console.log('args:'+process.argv.slice(2).join(' '))`);
  };
  const plat = arch === 'arm64' || arm64Chip ? 'macos-arm64' : 'macos-x64';
  await asset(join(root, 'pkg/argo-cli'), version);
  const tar = join(root, `argo-cli-${version}-${plat}.tar.gz`);
  assert.equal(spawnSync('tar', ['-czf', tar, '-C', join(root, 'pkg'), 'argo-cli']).status, 0);
  const sum = createHash('sha256').update(await readFile(tar)).digest('hex');
  await writeFile(`${tar}.sha256`, `${badSum ? '0'.repeat(64) : sum}  argo-cli-${version}-${plat}.tar.gz\n`);
  if (oldApp) await asset(join(base, 'app'), '1.0.0');
  if (app) await mkdir(join(apps, 'argo.app'), { recursive: true });
  const plist = (id) => `<?xml version="1.0"?><plist><dict><key>CFBundleIdentifier</key><string>${id}</string></dict></plist>`;
  if (appCopy) await put(join(apps, 'argo 2.app/Contents/Info.plist'), plist('com.beyondworks.argo'));
  if (messengerApp) await put(join(apps, 'Argo Messenger.app/Contents/Info.plist'), plist('com.beyondworks.argo-messenger'));
  if (svc) await put(join(home, 'Library/LaunchAgents/com.beyondworks.argo-cli.plist'), plist('x'));
  if (appShim) await put(join(home, '.local/bin/argo'), '#!/bin/sh\n# argo-cli-shim v1 com.beyondworks.argo — Argo 앱이 만든 파일입니다.\n', 0o755);
  if (shim != null) await put(join(home, '.local/bin/argo'), shim, 0o755);
  if (cliBusy) await put(join(home, '.argo/cli-workspaces/co/chats/crew.status.json'), JSON.stringify({ ts: Date.now() }));
  const other = join(root, 'other');
  if (foreignInPath) await put(join(other, 'argo'), '#!/bin/sh\necho argo-workflows-cli\n', 0o755);
  const runner = `#!${process.execPath}\n`;
  await put(join(bin, 'uname'), runner + `console.log(process.argv.includes('-m')?${JSON.stringify(arch)}:'Darwin');`, 0o755);
  await put(join(bin, 'sysctl'), `#!/bin/sh\necho ${arm64Chip ? 1 : 0}\n`, 0o755);
  // launchctl — 호출을 기록하고, 교체 중인 앱 폴더 버전을 남긴다(멈춘 뒤 교체·교체 뒤 시작 순서 확인)
  await put(join(bin, 'launchctl'), runner + `const fs=require('fs');let v='none';try{v=JSON.parse(fs.readFileSync(${JSON.stringify(join(base, 'app/package.json'))})).version}catch{}fs.appendFileSync(${JSON.stringify(join(root, 'launchctl.log'))},process.argv[2]+' '+v+'\\n');`, 0o755);
  const names = noAsset ? [] : [`argo-cli-${version}-${plat}.tar.gz`, `argo-cli-${version}-${plat}.tar.gz.sha256`, `argo-server-${version}-linux-x64.tar.gz`];
  await put(join(bin, 'curl'), runner + `
const fs=require('fs'),path=require('path'),args=process.argv.slice(2),root=${JSON.stringify(root)};
fs.appendFileSync(path.join(root,'curl.log'),args.join(' ')+'\\n');
if(args.some(a=>a.includes('api.github.com'))){console.log(JSON.stringify({assets:${JSON.stringify(names)}.map(n=>({browser_download_url:'https://example.invalid/'+n}))},null,1));process.exit(0)}
const out=args[args.indexOf('-o')+1],url=args.find(a=>a.startsWith('https://')),name=url.split('/').pop();
if(${noSum}&&name.endsWith('.sha256'))process.exit(22);
fs.copyFileSync(path.join(root,name),out);
`, 0o755);
  const PATH = [bin, ...(foreignInPath ? [other] : []), '/usr/bin', '/bin'].join(':');
  const run = (extra = {}) => spawnSync('bash', [installer], { env: { PATH, HOME: home, ARGO_HOME: base, ARGO_MAC_APP_DIRS: apps, SHELL: '/bin/zsh', ...extra }, encoding: 'utf8', timeout: 60_000 });
  return { root, home, base, apps, run, plat, curlLog: () => readFile(join(root, 'curl.log'), 'utf8').catch(() => ''), launchLog: () => readFile(join(root, 'launchctl.log'), 'utf8').catch(() => '') };
}
const shimPath = (f) => join(f.home, '.local/bin/argo');

test('A1 맥 arm64 새 설치 — 해시 확인 → ~/.argo-selfhost/app → 실행 확인 → ~/.local/bin/argo, PATH는 안내만', { skip: !available }, async (t) => {
  const f = await fixture(t), r = f.run();
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(await f.curlLog(), /argo-cli-2\.0\.0-macos-arm64\.tar\.gz -o .*\n.*argo-cli-2\.0\.0-macos-arm64\.tar\.gz\.sha256 -o /);
  const shim = await readFile(shimPath(f), 'utf8');
  assert.match(shim, /argo-cli-shim v1 argo-selfhost/);
  const run = spawnSync(shimPath(f), ['chat', 'nova'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
  assert.equal(run.stdout.trim(), 'args:chat nova', '담은 node로 실행되고 인자가 그대로 간다(시스템 node 없이)');
  assert.deepEqual(JSON.parse(await readFile(join(f.base, 'app/.argo-install.json'), 'utf8')), { kind: 'standalone', platform: 'macos-arm64', shim: shimPath(f) });
  assert.match(r.stdout, /~\/\.zprofile 에 이 줄을 추가/);
  assert.ok(!existsSync(join(f.home, '.zprofile')), '셸 설정 파일은 고치지 않는다');
  assert.ok(!(await readdir(f.base)).some((n) => n.startsWith('.install.')), '임시 폴더를 남기지 않는다');
});

test('A2 Intel 맥은 macos-x64, Rosetta 셸(uname x86_64·칩 arm64)은 arm64 자산', { skip: !available }, async (t) => {
  const intel = await fixture(t, { arch: 'x86_64', arm64Chip: false });
  assert.equal(intel.run().status, 0); assert.match(await intel.curlLog(), /macos-x64\.tar\.gz/);
  const rosetta = await fixture(t, { arch: 'x86_64', arm64Chip: true });
  assert.equal(rosetta.run().status, 0); assert.match(await rosetta.curlLog(), /macos-arm64\.tar\.gz/);
});

test('A3·A5 지원하지 않는 아키텍처·자산 없는 옛 릴리스는 아무것도 바꾸지 않고 안내', { skip: !available }, async (t) => {
  const odd = await fixture(t, { arch: 'ppc', arm64Chip: false }), r1 = odd.run();
  assert.equal(r1.status, 1); assert.match(r1.stderr, /미지원 아키텍처/);
  const old = await fixture(t, { noAsset: true }), r2 = old.run();
  assert.equal(r2.status, 1); assert.match(r2.stderr, /맥용 argo 명령\(macos-arm64\)이 없습니다/);
  assert.ok(!existsSync(join(old.base, 'app')) && !existsSync(shimPath(old)));
});

test('A4 해시가 다르거나 .sha256이 없으면 설치하지 않고 이전 설치를 그대로 둔다', { skip: !available }, async (t) => {
  for (const opt of [{ badSum: true }, { noSum: true }]) {
    const f = await fixture(t, { ...opt, oldApp: true }), r = f.run();
    assert.equal(r.status, 1, JSON.stringify(opt));
    assert.match(r.stderr, opt.badSum ? /해시가 맞지 않아/ : /해시 파일/);
    assert.equal(JSON.parse(await readFile(join(f.base, 'app/package.json'), 'utf8')).version, '1.0.0');
  }
});

test('A6·A8 다시 실행하면 교체하고, 실행 확인이 실패하면 이전 설치로 복구', { skip: !available }, async (t) => {
  const up = await fixture(t, { oldApp: true }), r = up.run();
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /버전: 2\.0\.0/);
  assert.equal(JSON.parse(await readFile(join(up.base, 'app/package.json'), 'utf8')).version, '2.0.0');
  const bad = await fixture(t, { oldApp: true }), r2 = bad.run({ CLI_STATUS_FAIL: '1' });
  assert.equal(r2.status, 1); assert.match(r2.stdout, /이전 설치를 복구/);
  assert.equal(JSON.parse(await readFile(join(bad.base, 'app/package.json'), 'utf8')).version, '1.0.0');
});

test('A7 크루가 답하는 중이면 교체하지 않는다', { skip: !available }, async (t) => {
  const f = await fixture(t, { oldApp: true, cliBusy: true }), r = f.run();
  assert.equal(r.status, 1); assert.match(r.stderr, /답하는 중/);
  assert.equal(JSON.parse(await readFile(join(f.base, 'app/package.json'), 'utf8')).version, '1.0.0');
});

test('A9 데스크톱 앱이 있거나 앱이 등록한 argo가 있으면 설치하지 않고 앱 설정을 안내', { skip: !available }, async (t) => {
  for (const opt of [{ app: true }, { appShim: true }]) {
    const f = await fixture(t, opt), r = f.run();
    assert.equal(r.status, 1, JSON.stringify(opt)); assert.match(r.stderr, /데스크톱 앱/);
    assert.ok(!existsSync(join(f.base, 'app')), '아무것도 설치하지 않는다');
    assert.equal(await f.curlLog(), '', '내려받지도 않는다');
  }
});

test('A9 이름이 바뀐 앱 사본(번들 id com.beyondworks.argo)도 감지, 메신저 앱(다른 id)은 막지 않는다', { skip: !available }, async (t) => {
  const copy = await fixture(t, { appCopy: true }), r = copy.run();
  assert.equal(r.status, 1); assert.match(r.stderr, /argo 2\.app/);
  const msgr = await fixture(t, { messengerApp: true });
  assert.equal(msgr.run().status, 0, '메신저만 있으면 설치한다');
});

test('A13 argo service install(launchd) 상주 — 교체 전에 멈추고 교체 뒤 다시 시작, 실패하면 이전 앱으로 되돌리고 다시 시작', { skip: !available }, async (t) => {
  const f = await fixture(t, { oldApp: true, svc: true }), r = f.run();
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(await f.launchLog(), 'print 1.0.0\nbootout 1.0.0\nbootstrap 2.0.0\n', '멈춘 뒤 교체하고 새 버전으로 다시 시작');
  assert.match(r.stdout, /새 버전으로 다시 시작/);
  const bad = await fixture(t, { oldApp: true, svc: true }), r2 = bad.run({ CLI_STATUS_FAIL: '1' });
  assert.equal(r2.status, 1);
  assert.equal(await bad.launchLog(), 'print 1.0.0\nbootout 1.0.0\nbootstrap 1.0.0\n', '복구한 이전 앱으로 다시 시작');
  const none = await fixture(t, { oldApp: true });
  assert.equal(none.run().status, 0); assert.equal(await none.launchLog(), '', '상주가 없으면 launchctl을 부르지 않는다');
});

test('A10 남의 argo는 덮지도 가리지도 않고 직접 실행 명령을 안내, 우리 shim은 갱신', { skip: !available }, async (t) => {
  const foreign = await fixture(t, { shim: '#!/bin/sh\necho argo-workflows\n' }), r = foreign.run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(await readFile(shimPath(foreign), 'utf8'), '#!/bin/sh\necho argo-workflows\n');
  assert.match(r.stdout, /다른 프로그램의 argo 명령이 있어/); assert.match(r.stdout, /ARGO_CLI_APP=0 '.*\/app\/node'/);
  assert.equal(JSON.parse(await readFile(join(foreign.base, 'app/.argo-install.json'), 'utf8')).shim, null, '지울 shim이 없다');
  const inPath = await fixture(t, { foreignInPath: true });
  assert.equal(inPath.run().status, 0); assert.ok(!existsSync(shimPath(inPath)), 'PATH의 남의 argo를 가리지 않는다');
  const ours = await fixture(t, { shim: '#!/bin/sh\n# argo-cli-shim v1 argo-selfhost — old\n' });
  assert.equal(ours.run().status, 0); assert.match(await readFile(shimPath(ours), 'utf8'), /\.argo-selfhost\/app\/node/);
});

test('A11 PATH에 ~/.local/bin이 있으면 안내하지 않고, bash 사용자는 ~/.bash_profile을 안내', { skip: !available }, async (t) => {
  const f = await fixture(t);
  const r = f.run({ PATH: `${join(f.root, 'bin')}:${join(f.home, '.local/bin')}:/usr/bin:/bin` });
  assert.equal(r.status, 0, r.stderr); assert.doesNotMatch(r.stdout, /PATH에 .* 이 없습니다/);
  const b = await fixture(t), rb = b.run({ SHELL: '/bin/bash' });
  assert.match(rb.stdout, /~\/\.bash_profile 에 이 줄을 추가/);
});

test('맥에서 --local은 거절', { skip: !available }, async (t) => {
  const f = await fixture(t);
  const r = spawnSync('bash', [installer, '--local'], { env: { PATH: [join(f.root, 'bin'), '/usr/bin', '/bin'].join(':'), HOME: f.home, ARGO_HOME: f.base, ARGO_MAC_APP_DIRS: f.apps }, encoding: 'utf8' });
  assert.equal(r.status, 1); assert.match(r.stderr, /--local\(로컬 웹 서버\)을 지원하지 않습니다/);
});
