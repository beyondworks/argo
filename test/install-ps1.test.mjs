// install.ps1 — 윈도우 argo 명령 단독 설치(2026-10-06 유건 승인). 경우 표 W1~W6·U2.
// 배포본은 원본(install.src.ps1)에서 만든 ASCII 파일이어야 한다(PowerShell 5.1이 irm으로 받은 UTF-8을 잘못 읽는다) — 모든 플랫폼에서 본다.
// 실제 설치는 윈도우에서만: 로컬 가짜 릴리스 서버에서 사용자 명령과 같은 `irm … | iex`로 실행한다. PATH는 테스트용 레지스트리 키(ARGO_INSTALL_ENV_KEY)에 쓴다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, readFile, rm, copyFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildInstallPs1 } from '../scripts/build-install-ps1.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const shipped = readFileSync(join(ROOT, 'scripts/install.ps1'), 'utf8');

test('배포본 install.ps1은 원본에서 만든 그대로다 — 다르면 node scripts/build-install-ps1.mjs', () => {
  assert.equal(shipped, buildInstallPs1(readFileSync(join(ROOT, 'scripts/install.src.ps1'), 'utf8')));
});
test('배포본은 ASCII만 — 한글은 \\u 이스케이프로, 원본의 한글 문구가 그대로 되살아난다', () => {
  assert.ok(!/[^\x00-\x7f]/.test(shipped));
  const texts = [...shipped.matchAll(/Unescape\('([^']+)'\)/g)].map((m) => JSON.parse(`"${m[1]}"`)).join(' ');
  assert.match(texts, /데스크톱 앱이 설치돼 있습니다/); assert.match(texts, /해시가 맞지 않아/);
  assert.doesNotMatch(shipped, /(^|[;{}])\s*exit(\s|$)/im, 'iex로 실행되므로 PowerShell exit 문을 쓰지 않는다(사용자 PowerShell 창이 닫힌다)');
});

const win = process.platform === 'win32';
const ps = (cmd, env) => spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', cmd], { env, encoding: 'utf8', timeout: 180_000 });

async function fixture(t, { badSum = false, app = false, foreign = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'argo-ps1-'));
  const local = join(root, 'Local'), profile = join(root, 'Profile');
  const envKey = `HKCU:\\Software\\ArgoInstallTest\\${randomBytes(4).toString('hex')}`;
  t.after(async () => { ps(`Remove-Item -Path '${envKey}' -Recurse -Force -ErrorAction SilentlyContinue`, process.env); await rm(root, { recursive: true, force: true }); });
  const pkg = join(root, 'pkg/argo-cli');
  await mkdir(join(pkg, 'bin'), { recursive: true });
  await copyFile(process.execPath, join(pkg, 'node.exe'));
  await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: 'argo', version: '2.0.0' }));
  await writeFile(join(pkg, 'bin/argo.mjs'), `if(process.argv[2]==='status'){process.exit(process.env.ARGO_CLI_APP==='0'?0:2)}console.log('args:'+process.argv.slice(2).join(' '))`);
  const zip = join(root, 'argo-cli-2.0.0-windows-x64.zip');
  assert.equal(spawnSync('tar', ['-a', '-cf', zip, '-C', join(root, 'pkg'), 'argo-cli']).status, 0);
  const sum = createHash('sha256').update(await readFile(zip)).digest('hex');
  const files = { '/install.ps1': shipped, '/argo-cli-2.0.0-windows-x64.zip': await readFile(zip), '/argo-cli-2.0.0-windows-x64.zip.sha256': `${badSum ? '0'.repeat(64) : sum}  argo-cli-2.0.0-windows-x64.zip\n` };
  const server = createServer((req, res) => {
    if (req.url === '/api') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ assets: Object.keys(files).filter((k) => k.endsWith('.zip') || k.endsWith('.sha256')).map((k) => ({ browser_download_url: `http://127.0.0.1:${server.address().port}${k}` })) })); }
    const body = files[req.url]; if (!body) { res.statusCode = 404; return res.end(); }
    res.setHeader('content-type', 'application/octet-stream'); res.end(body); // GitHub 릴리스 자산과 같은 형식 — irm이 문자열로 읽는 경로
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); t.after(() => server.close());
  if (app) { await mkdir(join(local, 'com.beyondworks.argo'), { recursive: true }); await writeFile(join(local, 'com.beyondworks.argo/cli-install.json'), '{"status":"installed"}'); }
  const other = join(root, 'other');
  if (foreign) { await mkdir(other, { recursive: true }); await writeFile(join(other, 'argo.cmd'), '@echo off\r\necho argo-workflows\r\n'); }
  const env = { ...process.env, LOCALAPPDATA: local, USERPROFILE: profile, ARGO_INSTALL_API: `http://127.0.0.1:${server.address().port}/api`, ARGO_INSTALL_ENV_KEY: envKey, PATH: foreign ? `${other};${process.env.PATH}` : process.env.PATH };
  const run = () => ps(`irm http://127.0.0.1:${server.address().port}/install.ps1 | iex`, env);
  const pathValue = () => ps(`$k = Get-Item -Path '${envKey}' -ErrorAction SilentlyContinue; if ($k) { $k.GetValue('Path', '', 'DoNotExpandEnvironmentNames') + '|' + $k.GetValueKind('Path') }`, process.env).stdout.trim();
  return { root, local, profile, env, run, pathValue, app: join(local, 'argo-cli/app'), shim: join(local, 'argo-cli/bin/argo.cmd'), bin: join(local, 'argo-cli/bin') };
}

test('W1·W4 새 설치 → 해시 확인·실행 확인·argo.cmd·PATH 한 번(REG_EXPAND_SZ), 다시 실행해도 PATH 중복 없음, U2 제거', { skip: !win, timeout: 300_000 }, async (t) => {
  const f = await fixture(t);
  const r = f.run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(existsSync(join(f.app, 'node.exe')));
  assert.match(await readFile(f.shim, 'utf8'), /argo-cli-shim v1 argo-selfhost/);
  assert.equal(f.pathValue(), `${f.bin}|ExpandString`);
  const run = spawnSync('cmd.exe', ['/d', '/c', f.shim, 'chat', 'nova'], { encoding: 'utf8' });
  assert.equal(run.stdout.trim(), 'args:chat nova');
  const rec = JSON.parse(await readFile(join(f.app, '.argo-install.json'), 'utf8'));
  assert.deepEqual({ kind: rec.kind, shim: rec.shim, pathEntry: rec.pathEntry }, { kind: 'standalone', shim: f.shim, pathEntry: f.bin });
  assert.equal(f.run().status, 0, '다시 실행(업데이트)');
  assert.equal(f.pathValue(), `${f.bin}|ExpandString`, 'PATH 중복 없음');
  // U2 — 실제 제거 스크립트(src/cli/uninstall.mjs)를 이 설치에 대고 실행: 종료 뒤 폴더·shim·PATH 항목이 지워진다
  const { uninstallStandalone } = await import('../src/cli/uninstall.mjs');
  const u = uninstallStandalone({ appDir: f.app, home: f.profile, platform: 'win32', pid: 999999 });
  assert.equal(u.pending, true);
  for (let i = 0; i < 60 && existsSync(f.app); i++) await new Promise((res) => setTimeout(res, 500));
  assert.ok(!existsSync(f.app) && !existsSync(f.shim), '프로그램 폴더·argo.cmd 삭제');
  assert.equal(f.pathValue(), '|ExpandString', '우리 PATH 항목만 지운다');
});

test('W3 해시가 다르면 설치하지 않는다', { skip: !win, timeout: 300_000 }, async (t) => {
  const f = await fixture(t, { badSum: true }), r = f.run();
  assert.notEqual(r.status, 0); assert.ok(!existsSync(f.app)); assert.equal(f.pathValue(), '');
});

test('W5 데스크톱 앱이 있으면 설치하지 않는다', { skip: !win, timeout: 300_000 }, async (t) => {
  const f = await fixture(t, { app: true }), r = f.run();
  assert.notEqual(r.status, 0); assert.ok(!existsSync(f.app));
});

test('W6 PATH에 남의 argo가 있으면 PATH에 넣지 않고 직접 실행 경로를 안내', { skip: !win, timeout: 300_000 }, async (t) => {
  const f = await fixture(t, { foreign: true }), r = f.run();
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.ok(existsSync(f.shim)); assert.equal(f.pathValue(), '');
  assert.equal(JSON.parse(await readFile(join(f.app, '.argo-install.json'), 'utf8')).pathEntry, null);
});
