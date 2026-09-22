// K01(D6) gemini — 프롬프트는 명령줄 인자가 아니라 표준 입력으로(`-p ''` + stdin, gemini 0.51.0 --help "-p … Appended to
//   input on stdin"). 인자로 넘기면 Windows 32,767자·Linux 인자당 128KB를 넘는 턴이 spawn에서 죽는다.
// K76 codex app-server — 자격 반입 뒤 턴 준비(설정·조달·스폰)가 실패해도 임시 CODEX_HOME(auth.json 사본 포함)이 남지 않는다.
// 가짜 CLI 하네스는 test/cli-runner-turn-io.test.mjs와 같은 모양(격리 HOME·TMPDIR, PATH 맨 앞 가짜 실행 파일).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, chmod, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const base = await mkdtemp(join(tmpdir(), 'argo-gemini-io-'));
after(() => rm(base, { recursive: true, force: true }));
process.env.HOME = join(base, 'home');
process.env.TMPDIR = join(base, 'tmp');
await mkdir(process.env.HOME, { recursive: true });
await mkdir(process.env.TMPDIR, { recursive: true });
const bin = join(base, 'bin');
await mkdir(bin, { recursive: true });
const log = join(base, 'argv.json');

const { externalExec } = await import('../src/runners.mjs');
const { execCodexAppServer } = await import('../src/runners/codex-appserver.mjs');
process.env.PATH = `${bin}:${process.env.PATH}`;
process.env.ARGO_CODEX_PREFER_PATH = '1';
process.env.FAKE_CLI_LOG = log;

const fake = (name) => `#!/usr/bin/env node
const fs = require('fs');
const a = process.argv.slice(2);
if (a[0] === '--version') { console.log('fake-${name}'); process.exit(0); }
let s = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { s += d; }).on('end', () => {
  fs.writeFileSync(process.env.FAKE_CLI_LOG, JSON.stringify({ argv: a, stdin: s }));
  process.stdout.write(s);
});
`;
for (const name of ['gemini', 'codex']) {
  await writeFile(join(bin, name), fake(name));
  await chmod(join(bin, name), 0o755);
}
for (const name of ['gemini', 'codex']) { // 실제 CLI(네트워크·과금)가 먼저 잡히면 여기서 멈춘다
  assert.equal(execFileSync(name, ['--version'], { env: process.env }).toString().trim(), `fake-${name}`, `${name}는 가짜여야 한다`);
}
const cwd = join(base, 'cwd');
await mkdir(cwd, { recursive: true });

test('K01 gemini — 200KB 프롬프트가 표준 입력으로 전달되고 인자는 -p \'\' -m … --approval-mode yolo', { skip: process.platform === 'win32' }, async () => {
  const prompt = `---\nname: crew\n---\n${'가나다 abc '.repeat(20_000)}`.trim(); // 약 260KB — Linux 인자당 128KB 초과
  const reply = await externalExec({ runner: 'gemini', model: 'gemini-x', cwd, prompt, timeoutMs: 60_000 });
  assert.equal(reply, prompt, '프롬프트 전문이 CLI에 도달');
  const { argv, stdin } = JSON.parse(await readFile(log, 'utf8'));
  assert.equal(stdin, prompt);
  assert.deepEqual(argv, ['-p', '', '-m', 'gemini-x', '--approval-mode', 'yolo']);
});

test('K76 codex app-server — 자격 반입 뒤 턴 준비가 실패해도 임시 CODEX_HOME이 남지 않는다', { skip: process.platform === 'win32' }, async () => {
  const before = (await readdir(process.env.TMPDIR)).filter((n) => n.startsWith('argo-codex-as-'));
  const mcpServers = new Proxy({}, { ownKeys() { throw new Error('config 준비 실패'); } }); // writeCodexTurnConfig 예외 대리
  await assert.rejects(execCodexAppServer({ cwd, prompt: 'hi', timeoutMs: 60_000, mcpServers }), /config 준비 실패/);
  const left = (await readdir(process.env.TMPDIR)).filter((n) => n.startsWith('argo-codex-as-') && !before.includes(n));
  assert.deepEqual(left, [], '임시 홈(auth.json 반입본 포함) 정리');
});
