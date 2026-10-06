// argo uninstall — 단독 설치가 만든 것만 지우고 데이터(~/.argo)는 남긴다(2026-10-06 유건 승인). 경우 표 U1~U4.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { uninstallStandalone, STANDALONE_MARK } from '../src/cli/uninstall.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
async function fixture(t, { record = true, shimMark = true, service = null } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'argo-uninstall-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home'), appDir = join(home, '.argo-selfhost/app'), shim = join(home, '.local/bin/argo'), data = join(home, '.argo/cli-workspaces/co/company.json');
  for (const [f, text] of [[join(appDir, 'bin/argo.mjs'), '// app'], [shim, shimMark ? `#!/bin/sh\n# ${STANDALONE_MARK} — x\n` : '#!/bin/sh\necho mine\n'], [data, '{"name":"keep"}']]) { await mkdir(dirname(f), { recursive: true }); await writeFile(f, text); }
  if (record) await writeFile(join(appDir, '.argo-install.json'), JSON.stringify({ kind: 'standalone', platform: 'macos-arm64', shim }));
  if (service) { const f = join(home, service); await mkdir(dirname(f), { recursive: true }); await writeFile(f, 'unit'); }
  return { root, home, appDir, shim, data };
}

test('U1 맥·리눅스 단독 설치 — 프로그램 폴더와 우리 argo 명령만 지우고 데이터는 남긴다', async (t) => {
  const f = await fixture(t);
  const r = uninstallStandalone({ appDir: f.appDir, home: f.home, platform: 'darwin' });
  assert.deepEqual(r, { ok: true, removed: [f.appDir, f.shim] });
  assert.ok(!existsSync(f.appDir) && !existsSync(f.shim));
  assert.equal(await readFile(f.data, 'utf8'), '{"name":"keep"}');
});

test('U1 표식이 없는 argo(사용자가 바꿔 둔 파일)는 지우지 않는다', async (t) => {
  const f = await fixture(t, { shimMark: false });
  const r = uninstallStandalone({ appDir: f.appDir, home: f.home, platform: 'linux' });
  assert.deepEqual(r.removed, [f.appDir]); assert.ok(existsSync(f.shim));
});

test('U3 설치 기록이 없으면(앱·저장소·--local) 아무것도 지우지 않는다', async (t) => {
  const f = await fixture(t, { record: false });
  assert.deepEqual(uninstallStandalone({ appDir: f.appDir, home: f.home, platform: 'darwin' }), { ok: false, reason: 'not-standalone' });
  assert.ok(existsSync(f.appDir) && existsSync(f.shim));
});

test('U4 상주가 등록돼 있으면(systemd·launchd) 지우지 않고 그 파일을 알려 준다', async (t) => {
  for (const service of ['.config/systemd/user/argo-cli.service', 'Library/LaunchAgents/com.beyondworks.argo-cli.plist']) {
    const f = await fixture(t, { service });
    const r = uninstallStandalone({ appDir: f.appDir, home: f.home, platform: 'darwin' });
    assert.equal(r.reason, 'service'); assert.equal(r.file, join(f.home, service)); assert.ok(existsSync(f.appDir));
  }
});

test('U2 윈도우 — 실행 중인 node.exe가 폴더 안이라 종료 뒤 지우는 스크립트를 띄운다(PATH 항목·shim 전달)', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.appDir, '.argo-install.json'), JSON.stringify({ kind: 'standalone', platform: 'windows-x64', shim: f.shim, pathEntry: 'C:\\U\\argo-cli\\bin', envKey: 'HKCU:\\Environment' }));
  const calls = [];
  const r = uninstallStandalone({ appDir: f.appDir, home: f.home, platform: 'win32', pid: 4242, tmp: f.root, spawnImpl: (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { unref() {} }; } });
  assert.equal(r.pending, true); assert.ok(existsSync(f.appDir), '이 프로세스가 끝나기 전에는 지우지 않는다');
  assert.equal(calls[0].cmd, 'powershell.exe');
  assert.deepEqual(calls[0].args.slice(-5), ['4242', f.appDir, f.shim, 'C:\\U\\argo-cli\\bin', 'HKCU:\\Environment']);
  assert.ok(calls[0].opts.detached && calls[0].opts.windowsHide);
  const script = await readFile(join(f.root, 'argo-uninstall-4242.ps1'), 'utf8');
  assert.ok(!/[^\x00-\x7f]/.test(script), 'PowerShell 5.1이 ANSI로 읽어도 깨지지 않게 ASCII만');
  assert.match(script, /-Type ExpandString/, 'PATH 형식(REG_EXPAND_SZ)을 지킨다');
});

test('argo uninstall 명령 — 저장소 CLI에서는 거절(종료 1), 단독 설치 트리에서는 제거', async (t) => {
  const env = { PATH: process.env.PATH, HOME: join(tmpdir(), 'argo-uninstall-home-none'), ARGO_CLI_APP: '0', ARGO_CLI_HOME: join(tmpdir(), 'argo-uninstall-cli-none'), LANG: 'ko_KR.UTF-8' };
  const repo = spawnSync(process.execPath, [join(ROOT, 'bin/argo.mjs'), 'uninstall'], { env, encoding: 'utf8', timeout: 60_000 });
  assert.equal(repo.status, 1, repo.stdout + repo.stderr); assert.match(repo.stderr, /설치 명령으로 설치한 것이 아니라 지우지 않습니다/);
  // 단독 설치 트리를 흉내 — 저장소의 bin·src·package.json을 복사하고 설치 기록을 둔다
  const f = await fixture(t);
  await rm(f.appDir, { recursive: true, force: true });
  for (const p of ['bin', 'src', 'package.json']) await cp(join(ROOT, p), join(f.appDir, p), { recursive: true });
  await writeFile(join(f.appDir, '.argo-install.json'), JSON.stringify({ kind: 'standalone', platform: 'macos-arm64', shim: f.shim }));
  const r = spawnSync(process.execPath, [join(f.appDir, 'bin/argo.mjs'), 'uninstall'], { env: { ...env, HOME: f.home, NODE_PATH: join(ROOT, 'node_modules') }, cwd: f.root, encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /argo를 제거했습니다/);
  assert.ok(!existsSync(f.appDir) && !existsSync(f.shim)); assert.ok(existsSync(f.data));
});
