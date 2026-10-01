// 앱을 설치하면 argo 명령이 따라온다 — 맥 shim 등록(src/cli-install.mjs, 설계 2-3, 2026-10-01).
// 전부 임시 HOME·가짜 PATH 폴더에서 한다. 실제 ~/.local/bin·~/.zprofile·로그인 셸은 건드리지도 실행하지도 않는다(M-e).
// 지키는 규칙: ① 남의 argo는 덮어쓰지도 가리지도 않는다 ② 셸 파일은 사용자가 버튼을 누를 때만 고친다 ③ 같은 상태에서는 아무것도 다시 쓰지 않는다.
import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync, lstatSync, symlinkSync, chmodSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from './helpers/tmp.mjs';
// 맥 shim 등록 — POSIX 셸 스크립트 실행·심볼릭 링크·':' PATH를 쓰는 시험이라 윈도우 러너에서는 건너뛴다(윈도우는 설치 프로그램이 등록 — test/nsis-cli-hooks.test.mjs)
const test = (name, ...rest) => nodeTest(name, ...(process.platform === 'win32' ? [{ skip: 'macOS shim — 윈도우는 설치 프로그램이 등록' }, async () => {}] : rest));
import { ensureCliInstalled, cliInstallStatus, installCli, removeCli, addPathToShell, cliInstallAction, cliInstallRequestDenied, SHIM_MARK, shimText } from '../src/cli-install.mjs';

/** 가짜 앱 번들 + 임시 HOME. node는 인자를 출력하는 셸 스크립트로 대신한다(shim이 실제로 실행하는지 보기 위해). */
async function world({ home: homeName = 'home', appDir = 'Applications' } = {}) {
  const base = await mkdtemp(join(tmpdir(), 'argo-cli-install-'));
  const home = join(base, homeName);
  const app = join(base, appDir, 'Argo.app', 'Contents');
  const node = join(app, 'MacOS', 'node');
  const serverDir = join(app, 'Resources', 'server');
  mkdirSync(home, { recursive: true }); mkdirSync(join(app, 'MacOS'), { recursive: true }); mkdirSync(join(serverDir, 'bin'), { recursive: true });
  writeFileSync(node, '#!/bin/sh\necho "NODE:$*"\necho "APP=$ARGO_CLI_APP"\necho "OPTS=$NODE_OPTIONS"\n'); chmodSync(node, 0o755);
  writeFileSync(join(serverDir, 'bin', 'argo.mjs'), '// cli');
  const stateFile = join(base, 'data', 'cli-install.json');
  const local = join(home, '.local', 'bin');
  const common = { env: { PATH: '/usr/bin:/bin', SHELL: '/bin/zsh' }, home, platform: 'darwin', execPath: node, serverDir, stateFile, candidates: [local, join(base, 'fake-brew'), join(base, 'fake-usr-local')] };
  return { base, home, node, serverDir, stateFile, local, shim: join(local, 'argo'), common };
}
const readState = (w) => JSON.parse(readFileSync(w.stateFile, 'utf8'));
const foreignScript = (p, text = '#!/bin/sh\necho argo-workflows-cli\n') => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, text); chmodSync(p, 0o755); };

test('새 설치 — 표식이 있는 실행 파일(0755) 하나만 만들고 셸 파일은 건드리지 않는다', async () => {
  const w = await world();
  const r = await ensureCliInstalled(w.common);
  assert.equal(r.status, 'installed');
  const text = readFileSync(w.shim, 'utf8');
  assert.ok(text.split('\n').slice(0, 3).join('\n').includes(SHIM_MARK), '앞 512바이트 안에 표식');
  assert.ok(text.includes(w.node) && text.includes(join(w.serverDir, 'bin', 'argo.mjs')));
  assert.equal(statSync(w.shim).mode & 0o777, 0o755);
  for (const f of ['.zprofile', '.zshrc', '.zshenv', '.bash_profile', '.profile', '.bashrc']) assert.equal(existsSync(join(w.home, f)), false, `${f}를 만들거나 고치면 안 된다(M-e)`);
  assert.equal(readState(w).status, 'installed');
  assert.deepEqual(readdirSync(w.local), ['argo'], '임시 파일이 남지 않는다');
});

test('shim 실행 — 앱 번들 node로 argo.mjs를 실행하고 ARGO_CLI_APP=1을 넘긴다, 인자는 그대로', async () => {
  const w = await world();
  await ensureCliInstalled(w.common);
  const r = spawnSync(w.shim, ['chat', 'a b', "it's"], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: w.home } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`NODE:${join(w.serverDir, 'bin', 'argo.mjs').replace(/[/.]/g, '\\$&')} chat a b it's`));
  assert.match(r.stdout, /APP=1/);
});

test('앱이 사라지면 shim은 두 언어 안내와 종료 코드 127', async () => {
  const w = await world();
  await ensureCliInstalled(w.common);
  rmSync(w.node);
  const r = spawnSync(w.shim, [], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: w.home } });
  assert.equal(r.status, 127);
  assert.match(r.stderr, /Argo 앱을 찾을 수 없습니다/);
  assert.match(r.stderr, /Argo app not found/);
});

test('경로에 따옴표·$·공백이 든 앱·홈에서도 shim이 그대로 실행된다', async () => {
  const w = await world({ home: "ho'me $x `y`", appDir: "App $s'q" });
  await ensureCliInstalled(w.common);
  const r = spawnSync(w.shim, ['status'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: w.home } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /NODE:.*status/);
  assert.equal(r.stdout.includes('OPTS=--require'), false, '안전하지 않은 HOME 문자에서는 NODE_OPTIONS를 조립하지 않는다');
});

test('Dock 아이콘 억제 — 심 파일이 있고 HOME이 안전하면 NODE_OPTIONS에 프리로드를 넣는다(번들 node의 MCP·npx 자식용)', async () => {
  const w = await world();
  await ensureCliInstalled(w.common);
  mkdirSync(join(w.home, '.argo', 'tools'), { recursive: true }); writeFileSync(join(w.home, '.argo', 'tools', 'no-dock.cjs'), '');
  const r = spawnSync(w.shim, [], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: w.home, NODE_OPTIONS: '--max-old-space-size=512' } });
  assert.match(r.stdout, new RegExp(`OPTS=--require ${join(w.home, '.argo', 'tools', 'no-dock.cjs').replace(/[/.]/g, '\\$&')} --max-old-space-size=512`));
});

test('같은 상태에서 다시 실행하면 shim·상태 파일 모두 바이트·mtime이 같다(쓰기 0)', async () => {
  const w = await world();
  await ensureCliInstalled(w.common);
  const before = [w.shim, w.stateFile].map((f) => [readFileSync(f, 'utf8'), statSync(f).mtimeMs]);
  await new Promise((r) => setTimeout(r, 30));
  await ensureCliInstalled(w.common);
  const after = [w.shim, w.stateFile].map((f) => [readFileSync(f, 'utf8'), statSync(f).mtimeMs]);
  assert.deepEqual(after, before);
});

test('남의 ~/.local/bin/argo는 덮어쓰지 않고 conflict로 남긴다(검수 M1 재발 방지)', async () => {
  const w = await world();
  foreignScript(w.shim);
  const r = await ensureCliInstalled(w.common);
  assert.equal(r.status, 'conflict');
  assert.equal(readFileSync(w.shim, 'utf8'), '#!/bin/sh\necho argo-workflows-cli\n');
  assert.deepEqual(readState(w).others.map((o) => o.path), [w.shim]);
  assert.equal(readState(w).others[0].kind, 'foreign');
});

test('다른 고정 후보 경로나 PATH 폴더에 남의 argo가 있으면 우리 shim을 만들지 않는다(가리지 않음)', async () => {
  for (const where of ['candidate', 'path']) {
    const w = await world();
    const dir = join(w.base, where === 'candidate' ? 'fake-brew' : 'path-dir');
    foreignScript(join(dir, 'argo'));
    const common = where === 'path' ? { ...w.common, env: { ...w.common.env, PATH: `${dir}:/usr/bin` } } : w.common;
    const r = await ensureCliInstalled(common);
    assert.equal(r.status, 'conflict', where);
    assert.equal(existsSync(w.shim), false, `${where}: shim을 만들면 남의 argo가 가려진다`);
    assert.equal(readState(w).others[0].path, join(dir, 'argo'));
  }
});

test('npm link로 걸린 개발용 argo는 종류를 argo-dev로 구분하되 역시 건너뛴다', async () => {
  const w = await world();
  const repo = join(w.base, 'repo'); mkdirSync(join(repo, 'bin'), { recursive: true });
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'argo', bin: { argo: 'bin/argo.mjs' } })); writeFileSync(join(repo, 'bin', 'argo.mjs'), '#!/usr/bin/env node\n');
  mkdirSync(join(w.base, 'fake-usr-local'), { recursive: true }); symlinkSync(join(repo, 'bin', 'argo.mjs'), join(w.base, 'fake-usr-local', 'argo'));
  const r = await ensureCliInstalled(w.common);
  assert.equal(r.status, 'conflict');
  assert.equal(readState(w).others[0].kind, 'argo-dev');
  assert.equal(existsSync(w.shim), false);
});

test('심볼릭 링크가 걸린 자리는 따라가서 덮지 않는다', async () => {
  const w = await world();
  const target = join(w.base, 'elsewhere'); foreignScript(target);
  mkdirSync(w.local, { recursive: true }); symlinkSync(target, w.shim);
  const r = await ensureCliInstalled(w.common);
  assert.equal(r.status, 'conflict');
  assert.equal(readFileSync(target, 'utf8'), '#!/bin/sh\necho argo-workflows-cli\n');
  assert.ok(lstatSync(w.shim).isSymbolicLink());
});

test('우리 shim이 있는데 나중에 남의 argo가 생기면 shim은 그대로 두고 others로 보인다(뒤에 생긴 경우, 검토 L-c)', async () => {
  const w = await world();
  await ensureCliInstalled(w.common);
  const bytes = readFileSync(w.shim, 'utf8');
  foreignScript(join(w.base, 'fake-brew', 'argo'));
  const r = await ensureCliInstalled(w.common);
  assert.equal(r.status, 'installed');
  assert.equal(readFileSync(w.shim, 'utf8'), bytes);
  assert.deepEqual(readState(w).others.map((o) => o.path), [join(w.base, 'fake-brew', 'argo')]);
});

test('앱을 옮겨 shim이 옛 앱 경로를 가리키면 다음 실행에서 우리 표식이 있는 파일만 갱신한다', async () => {
  const w = await world();
  writeFileSync(join(w.base, 'x'), ''); mkdirSync(w.local, { recursive: true });
  writeFileSync(w.shim, shimText({ node: '/Applications/Old.app/Contents/MacOS/node', cli: '/Applications/Old.app/Contents/Resources/server/bin/argo.mjs' })); chmodSync(w.shim, 0o755);
  const r = await ensureCliInstalled(w.common);
  assert.equal(r.status, 'installed');
  assert.ok(readFileSync(w.shim, 'utf8').includes(w.node) && !readFileSync(w.shim, 'utf8').includes('Old.app'));
});

test('dmg·다운로드 폴더에서 바로 실행하면(Translocation·/Volumes) 등록하지 않는다', async () => {
  for (const execPath of ['/private/var/folders/xx/AppTranslocation/ABC/d/Argo.app/Contents/MacOS/node', '/Volumes/Argo 0.1.92/Argo.app/Contents/MacOS/node']) {
    const w = await world();
    const r = await ensureCliInstalled({ ...w.common, execPath });
    assert.equal(r.status, 'translocated');
    assert.equal(existsSync(w.shim), false);
  }
});

test('앱 번들에 CLI가 없으면(개발 서버) 등록하지 않는다', async () => {
  const w = await world();
  rmSync(join(w.serverDir, 'bin', 'argo.mjs'));
  const r = await ensureCliInstalled(w.common);
  assert.equal(r.status, 'unavailable');
  assert.equal(existsSync(w.shim), false);
});

test('맥이 아니면 이 모듈은 아무것도 하지 않는다(윈도우는 설치 프로그램, 리눅스는 install.sh)', async () => {
  const w = await world();
  for (const platform of ['win32', 'linux']) assert.equal((await ensureCliInstalled({ ...w.common, platform })).status, 'unsupported');
  assert.equal(existsSync(w.shim), false);
});

test('사용자가 제거하면 우리 표식이 있는 파일만 지우고 다음 실행에서 다시 등록하지 않는다 — 버튼으로만 다시 등록', async () => {
  const w = await world();
  await ensureCliInstalled(w.common);
  assert.equal((await removeCli(w.common)).status, 'removed');
  assert.equal(existsSync(w.shim), false);
  assert.equal((await ensureCliInstalled(w.common)).status, 'removed');
  assert.equal(existsSync(w.shim), false, '사용자가 지운 것을 앱이 다시 만들면 안 된다');
  assert.equal((await installCli(w.common)).status, 'installed');
  assert.ok(existsSync(w.shim));
});

test('제거는 남의 파일을 지우지 않는다', async () => {
  const w = await world();
  foreignScript(w.shim);
  await removeCli(w.common);
  assert.equal(readFileSync(w.shim, 'utf8'), '#!/bin/sh\necho argo-workflows-cli\n');
});

test('상태 조회 — 등록됨·PATH 줄 필요 여부·직접 실행 경로를 알려 준다(셸을 실행하지 않고 파일만 본다)', async () => {
  const w = await world();
  await ensureCliInstalled(w.common);
  let s = await cliInstallStatus(w.common);
  assert.equal(s.status, 'installed');
  assert.equal(s.shim, w.shim);
  assert.equal(s.pathReady, false, '셸 설정 어디에도 ~/.local/bin이 없고 PATH에도 없다');
  assert.equal(s.run, w.shim, '직접 실행하는 방법');
  writeFileSync(join(w.home, '.zshrc'), 'export PATH="$HOME/.local/bin:$PATH"\n');
  s = await cliInstallStatus(w.common);
  assert.equal(s.pathReady, true);
  // 사이드카의 process.env.PATH는 믿지 않는다 — src/runners/shared.mjs가 GUI 최소 PATH를 보강하며 ~/.local/bin을 스스로 합친다(실측: 부팅 직후 항상 "이미 있음"이 됐다)
  rmSync(join(w.home, '.zshrc'));
  s = await cliInstallStatus({ ...w.common, env: { ...w.common.env, PATH: `${w.local}:/usr/bin` } });
  assert.equal(s.pathReady, false, '앱이 PATH에 합쳐 둔 ~/.local/bin을 "터미널 PATH에 있음"으로 오판하면 버튼이 영영 안 나온다');
  writeFileSync(join(w.home, '.zshrc'), '# export PATH="$HOME/.local/bin:$PATH"\n');
  assert.equal((await cliInstallStatus(w.common)).pathReady, false, '주석 줄은 설정이 아니다');
  writeFileSync(join(w.home, '.zshrc'), '. "$HOME/.local/bin/env"\n'); // uv 설치기가 넣는 줄 — 이 줄이 ~/.local/bin을 PATH에 넣는다
  assert.equal((await cliInstallStatus(w.common)).pathReady, true);
});

test('PATH 버튼(zsh) — ~/.zprofile 끝에 표식 주석과 한 줄만 덧붙이고, 심볼릭 링크·기존 내용을 그대로 둔다', async () => {
  const w = await world();
  const real = join(w.base, 'dotfiles', 'zprofile'); mkdirSync(join(real, '..'), { recursive: true }); writeFileSync(real, 'export A=1'); // 개행으로 끝나지 않음
  symlinkSync(real, join(w.home, '.zprofile'));
  await ensureCliInstalled(w.common);
  const r = await addPathToShell(w.common);
  assert.equal(r.result, 'added'); assert.equal(r.file, join(w.home, '.zprofile'));
  const text = readFileSync(real, 'utf8');
  assert.ok(text.startsWith('export A=1\n# Argo'), '개행으로 끝나지 않던 파일은 개행부터');
  assert.ok(text.endsWith('export PATH="$PATH:$HOME/.local/bin"\n'), 'PATH 끝에 붙인다(다른 도구의 명령 순서를 바꾸지 않는다)');
  assert.ok(lstatSync(join(w.home, '.zprofile')).isSymbolicLink(), '링크가 일반 파일로 바뀌면 안 된다');
  const again = await addPathToShell(w.common);
  assert.equal(again.result, 'already');
  assert.equal(readFileSync(real, 'utf8'), text, '두 번 눌러도 한 줄');
});

test('PATH 버튼 — 사용자가 그 줄을 지웠으면 앱이 저절로 다시 넣지 않는다(ensure는 셸 파일을 건드리지 않음), 버튼은 다시 넣는다', async () => {
  const w = await world();
  await ensureCliInstalled(w.common); await addPathToShell(w.common);
  writeFileSync(join(w.home, '.zprofile'), 'export B=2\n'); // 사용자가 지움
  await ensureCliInstalled(w.common);
  assert.equal(readFileSync(join(w.home, '.zprofile'), 'utf8'), 'export B=2\n');
  assert.equal((await addPathToShell(w.common)).result, 'added');
});

test('PATH 버튼(bash) — .bash_profile·.bash_login·.profile 중 처음 있는 파일에, 셋 다 없을 때만 .bash_profile을 만든다', async () => {
  const w = await world();
  const bash = { ...w.common, env: { ...w.common.env, SHELL: '/bin/bash' } };
  writeFileSync(join(w.home, '.profile'), '# p\n');
  assert.equal((await addPathToShell(bash)).file, join(w.home, '.profile'));
  assert.equal(existsSync(join(w.home, '.bash_profile')), false, '.profile만 있는데 .bash_profile을 만들면 bash가 .profile을 읽지 않게 된다');
  const w2 = await world();
  assert.equal((await addPathToShell({ ...w2.common, env: { ...w2.common.env, SHELL: '/bin/bash' } })).file, join(w2.home, '.bash_profile'));
});

test('PATH 버튼 — fish 같은 다른 셸은 파일을 고치지 않고 직접 추가할 줄을 알려 준다', async () => {
  const w = await world();
  const r = await addPathToShell({ ...w.common, env: { ...w.common.env, SHELL: '/opt/homebrew/bin/fish' } });
  assert.equal(r.result, 'manual');
  assert.match(r.line, /\.local\/bin/);
  assert.deepEqual(readdirSync(w.home), []);
});

test('같은 PATH 항목이 이미 셸 설정에 있으면 버튼을 눌러도 아무것도 쓰지 않는다', async () => {
  const w = await world();
  writeFileSync(join(w.home, '.zshenv'), 'path+=("$HOME/.local/bin")\n');
  const r = await addPathToShell(w.common);
  assert.equal(r.result, 'already');
  assert.equal(existsSync(join(w.home, '.zprofile')), false);
});

test('설정 화면 API 게이트 — 데스크톱 사이드카가 아니면 404, 루프백이 아니면 403, 다른 사이트의 요청은 403(셀프호스트 웹에서 서버 사용자의 셸 파일을 고치지 못하게)', () => {
  const ok = { env: { ARGO_PARENT_PID: '123' }, host: '127.0.0.1:3001', secFetchSite: 'same-origin' };
  assert.equal(cliInstallRequestDenied(ok), null);
  assert.equal(cliInstallRequestDenied({ ...ok, secFetchSite: undefined }), null, '헤더 없는 비브라우저(curl)는 통과 — CSRF 대상이 아니다');
  assert.equal(cliInstallRequestDenied({ ...ok, secFetchSite: 'none' }), null);
  assert.equal(cliInstallRequestDenied({ ...ok, env: {} }).status, 404, '상주·웹·개발 서버');
  assert.equal(cliInstallRequestDenied({ ...ok, host: 'argo.example.com' }).status, 403);
  assert.equal(cliInstallRequestDenied({ ...ok, host: '127.0.0.1.evil.com' }).status, 403);
  assert.equal(cliInstallRequestDenied({ ...ok, secFetchSite: 'cross-site' }).status, 403);
  assert.equal(cliInstallRequestDenied({ ...ok, secFetchSite: 'same-site' }).status, 403);
});

test('설정 화면 동작 — install·remove·path가 같은 모듈 함수로 돌고 새 상태를 돌려준다', async () => {
  const w = await world();
  let r = await cliInstallAction('install', w.common);
  assert.equal(r.status, 'installed'); assert.ok(existsSync(w.shim));
  r = await cliInstallAction('path', w.common);
  assert.equal(r.pathResult, 'added'); assert.equal(r.pathReady, true);
  r = await cliInstallAction('remove', w.common);
  assert.equal(r.status, 'removed'); assert.equal(existsSync(w.shim), false);
  await assert.rejects(cliInstallAction('format-disk', w.common), /unknown action/);
  assert.equal((await cliInstallAction('install', { ...w.common, platform: 'win32' })).status, 'unavailable', '윈도우는 설치 프로그램이 등록 — 이 모듈은 파일을 만들지 않는다');
});

test('윈도우 상태 — 설치 프로그램이 남긴 결과 파일과 실제 argo.cmd를 읽는다', async () => {
  const w = await world();
  const win = join(w.base, 'Argo'); mkdirSync(join(win, 'cli'), { recursive: true }); writeFileSync(join(win, 'node.exe'), ''); writeFileSync(join(win, 'cli', 'argo.cmd'), `@echo off\r\nrem ${SHIM_MARK} - created by the Argo installer\r\n`);
  const common = { ...w.common, platform: 'win32', execPath: join(win, 'node.exe'), stateFile: join(w.base, 'win-state.json') };
  const tools = join(w.base, 'tools'); foreignScript(join(tools, 'argo.exe'));
  writeFileSync(common.stateFile, '{"status":"conflict"}\r\n'); // 설치 프로그램이 남기는 ASCII 한 줄(+CRLF)
  const s = await cliInstallStatus({ ...common, env: { ...common.env, PATH: `${tools}:${join(win, 'cli')}` } });
  assert.equal(s.status, 'conflict'); assert.deepEqual(s.others.map((o) => o.path), [join(tools, 'argo.exe')], '다른 argo는 앱이 PATH를 직접 훑어 찾는다(우리 argo.cmd는 표식으로 제외)'); assert.equal(s.run, join(win, 'cli', 'argo.cmd'));
  assert.equal((await cliInstallStatus({ ...common, env: { ...common.env, PATH: '/usr/bin' } })).others.length, 0);
  writeFileSync(common.stateFile, '{"status":"path-skipped"}'); assert.equal((await cliInstallStatus(common)).status, 'path-skipped');
  rmSync(join(win, 'cli', 'argo.cmd'));
  assert.equal((await cliInstallStatus(common)).status, 'unavailable', 'argo.cmd가 없으면 결과 파일이 installed여도 등록됨이라 하지 않는다');
});

test('표식 주석만 남고 export 줄이 없으면(사용자가 줄만 지움) PATH 버튼은 그 한 줄만 다시 넣는다 — 이미 있다고 하지 않는다(독립 검수 #800 LOW-5)', async () => {
  const w = await world();
  writeFileSync(join(w.home, '.zprofile'), 'export A=1\n# Argo — 터미널 명령 argo (Argo 앱이 추가, 지워도 됩니다)\n');
  const r = await addPathToShell(w.common);
  assert.equal(r.result, 'added');
  const text = readFileSync(join(w.home, '.zprofile'), 'utf8');
  assert.equal(text, 'export A=1\n# Argo — 터미널 명령 argo (Argo 앱이 추가, 지워도 됩니다)\nexport PATH="$PATH:$HOME/.local/bin"\n', '주석은 두 번 쓰지 않고 export 줄만');
  assert.equal((await addPathToShell(w.common)).result, 'already');
});

test('설정 카드의 "직접 실행" 명령은 공백·특수 문자가 든 경로에서도 그대로 붙여 넣어 실행된다(따옴표, 독립 검수 #800 LOW-6)', async () => {
  const w = await world({ appDir: 'My Apps $x' });
  foreignScript(join(w.base, 'fake-brew', 'argo')); // conflict — 직접 실행 명령이 node + argo.mjs
  const s = await cliInstallStatus(w.common);
  assert.equal(s.status, 'conflict');
  const r = spawnSync('/bin/sh', ['-c', s.run], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: w.home } });
  assert.equal(r.status, 0, `${s.run}\n${r.stderr}`);
  assert.match(r.stdout, /NODE:.*argo\.mjs/);
  // 윈도우 — 공백이 든 argo.cmd 경로는 큰따옴표로
  const win = join(w.base, 'Program Files', 'Argo'); mkdirSync(join(win, 'cli'), { recursive: true }); writeFileSync(join(win, 'node.exe'), ''); writeFileSync(join(win, 'cli', 'argo.cmd'), `rem ${SHIM_MARK}\r\n`);
  const ws = await cliInstallStatus({ ...w.common, platform: 'win32', execPath: join(win, 'node.exe'), stateFile: join(w.base, 'ws.json') });
  assert.equal(ws.run, `"${join(win, 'cli', 'argo.cmd')}"`);
  assert.equal(ws.shim, join(win, 'cli', 'argo.cmd'), 'shim 값 자체는 경로 그대로');
});
