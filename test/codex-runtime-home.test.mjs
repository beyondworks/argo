// Codex Linux 샌드박스 런타임 홈 회귀:
// codex-cli 0.145+는 시스템 임시 폴더 아래 CODEX_HOME에서 helper alias 생성을 거부한다.
// externalExec가 /tmp/argo-codex-*로 회귀하면 모든 셸·파일 편집이 시작 전에 실패한다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'argo-codexruntime-test-'));
const fakeHome = join(root, 'user-home');
const fakeBin = join(root, 'bin');
const capture = join(root, 'captured-home.txt');
await mkdir(fakeHome, { recursive: true });
await mkdir(fakeBin, { recursive: true });

const fakeCodex = join(fakeBin, process.platform === 'win32' ? 'codex.cmd' : 'codex');
if (process.platform === 'win32') {
  await writeFile(fakeCodex, '@echo off\r\nexit /b 1\r\n');
} else {
  await writeFile(fakeCodex, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
if (process.argv.includes('--version')) {
  process.stdout.write('codex-cli test\\n');
  process.exit(0);
}
const i = process.argv.indexOf('--output-last-message');
writeFileSync(process.env.ARGO_CODEX_TEST_CAPTURE, process.env.CODEX_HOME);
writeFileSync(process.argv[i + 1], 'runtime-home-ok\\n');
`);
  await chmod(fakeCodex, 0o755);
}

process.env.ARGO_ROOT = join(root, 'workspaces');
process.env.HOME = process.env.USERPROFILE = fakeHome;
process.env.ARGO_CODEX_TEST_CAPTURE = capture;
process.env.PATH = `${fakeBin}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`;

const { codexTurnRuntimeRoot, externalExec } = await import('../src/runners.mjs');

after(async () => {
  await rm(root, { recursive: true, force: true });
});

test('Codex 턴 홈 기본 경로는 시스템 tmp 직속이 아니라 사용자 홈의 Argo 런타임 아래다', () => {
  assert.equal(
    codexTurnRuntimeRoot('/home/example', ''),
    join('/home/example', '.argo', 'runtime', 'codex-turns'),
  );
  assert.equal(
    codexTurnRuntimeRoot('/home/example', '/var/lib/argo/codex-runtime'),
    '/var/lib/argo/codex-runtime',
    '임시 HOME을 쓰는 컨테이너는 운영자가 안전한 영속 경로를 지정할 수 있어야 한다',
  );
});

test('externalExec는 홈 아래 격리 CODEX_HOME을 전달하고 턴 뒤 정리한다', {
  skip: process.platform === 'win32' ? 'POSIX 실행 파일 기반 스모크' : false,
}, async () => {
  const cwd = join(root, 'workspace');
  await mkdir(cwd, { recursive: true });

  const reply = await externalExec({
    runner: 'codex',
    cwd,
    prompt: 'runtime smoke',
    timeoutMs: 10_000,
  });

  assert.equal(reply, 'runtime-home-ok');
  const turnHome = await readFile(capture, 'utf8');
  const expectedRoot = resolve(codexTurnRuntimeRoot(fakeHome, '')) + sep;
  assert.ok(resolve(turnHome).startsWith(expectedRoot), `${turnHome} must be below ${expectedRoot}`);
  assert.equal(dirname(turnHome).startsWith(resolve(fakeHome)), true);
  await assert.rejects(() => access(turnHome), { code: 'ENOENT' }, '턴 완료 후 자격·설정 임시 홈을 남기지 않는다');
});
