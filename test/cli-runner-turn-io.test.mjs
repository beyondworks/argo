// CLI 러너 턴 입출력 행동 테스트 — 가짜 codex·agy 실행 파일을 PATH 맨 앞에 두고 externalExec를 실제로 돌린다.
// K01: codex 프롬프트는 명령줄 인자가 아니라 표준 입력으로(사용자 실측 "Codex: spawn ENAMETOOLONG").
// K10: readOnly 턴의 agy는 편집 자동 승인(accept-edits)이 아니라 plan 모드.
// K11: 턴 준비 중 실패해도 임시 CODEX_HOME(auth.json 사본 포함)이 남지 않는다.
// K13: 시간 초과인데 자식 정리 확인이 안 된 실패도 시간 초과 안내로 번역된다(중단 확인 불가 표시는 유지).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, chmod, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const base = await mkdtemp(join(tmpdir(), 'argo-cli-io-'));
after(() => rm(base, { recursive: true, force: true }));
// 격리 HOME·TMPDIR — 모듈이 import 시점에 homedir()로 경로를 잡으므로 import 전에 바꾼다.
process.env.HOME = join(base, 'home');
process.env.TMPDIR = join(base, 'tmp');
await mkdir(process.env.HOME, { recursive: true });
await mkdir(process.env.TMPDIR, { recursive: true });
const bin = join(base, 'bin');
await mkdir(bin, { recursive: true });
const log = join(base, 'argv.json');

const { externalExec, cliTurnFailure } = await import('../src/runners.mjs');
// import 뒤에 PATH 맨 앞으로 — shared.mjs가 import 때 node 디렉터리를 앞에 두고, 이후 병합은 뒤에 붙인다.
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
  const i = a.indexOf('--output-last-message');
  if (i >= 0) fs.writeFileSync(a[i + 1], s);
  else console.log('ok');
});
`;
for (const name of ['codex', 'agy']) {
  await writeFile(join(bin, name), fake(name));
  await chmod(join(bin, name), 0o755);
}
// 안전 장치 — 실제 CLI(네트워크·과금)가 먼저 잡히면 여기서 멈춘다.
for (const name of process.platform === 'win32' ? [] : ['codex', 'agy']) {
  assert.equal(execFileSync(name, ['--version'], { env: process.env }).toString().trim(), `fake-${name}`, `${name}는 가짜여야 한다`);
}

const cwd = join(base, 'cwd');
await mkdir(cwd, { recursive: true });

test('K01 codex — 2MB 프롬프트(카드 frontmatter 머리)도 표준 입력으로 전달되고 인자에는 "-"만 남는다', { skip: process.platform === 'win32' }, async () => {
  const prompt = `---\nname: crew\n---\n${'가'.repeat(700_000)}`; // UTF-8 약 2.1MB — macOS ARG_MAX 1MB·Linux 인자당 128KB 초과
  const reply = await externalExec({ runner: 'codex', cwd, prompt, timeoutMs: 60_000 });
  assert.equal(reply, prompt, '프롬프트 전문이 CLI에 도달');
  const { argv, stdin } = JSON.parse(await readFile(log, 'utf8'));
  assert.equal(stdin, prompt);
  assert.deepEqual(argv.slice(-2), ['--', '-'], '프롬프트 자리는 "-"(stdin에서 읽음, codex exec --help)');
  assert.ok(!argv.some((x) => x.includes('가가가')), '프롬프트가 명령줄에 실리지 않는다');
});

test('K10 agy — readOnly 턴은 --mode plan, 일반 턴은 accept-edits 유지', { skip: process.platform === 'win32' }, async () => {
  await externalExec({ runner: 'antigravity', cwd, prompt: 'hi', timeoutMs: 120_000, readOnly: true });
  let { argv } = JSON.parse(await readFile(log, 'utf8'));
  assert.equal(argv[argv.indexOf('--mode') + 1], 'plan');
  await externalExec({ runner: 'antigravity', cwd, prompt: 'hi', timeoutMs: 120_000, caps: { fs: true, browser: true, shell: true } });
  ({ argv } = JSON.parse(await readFile(log, 'utf8')));
  assert.equal(argv[argv.indexOf('--mode') + 1], 'accept-edits');
});

test('K11 codex — 자격 반입 뒤 턴 준비가 실패해도 임시 CODEX_HOME이 남지 않는다', { skip: process.platform === 'win32' }, async () => {
  const before = (await readdir(process.env.TMPDIR)).filter((n) => n.startsWith('argo-codex-'));
  const mcpServers = new Proxy({}, { ownKeys() { throw new Error('config 준비 실패'); } }); // writeCodexTurnConfig 예외 대리
  await assert.rejects(externalExec({ runner: 'codex', cwd, prompt: 'hi', timeoutMs: 60_000, mcpServers }), /config 준비 실패/);
  const left = (await readdir(process.env.TMPDIR)).filter((n) => n.startsWith('argo-codex-') && !before.includes(n));
  assert.deepEqual(left, [], '임시 홈(auth.json 반입본 포함) 정리');
});

test('K13 시간 초과 + 자식 정리 확인 불가 — 시간 초과 안내로 번역, 확인 불가 표시·원인은 보존', () => {
  const raw = Object.assign(new Error('Runner timed out'), { killed: true, timedOut: true, cancellationIncomplete: true, cause: new Error('verify failed') });
  const e = cliTurnFailure(raw, 'codex', 1_800_100, 1_800_000, { stage: 'exec', kind: 'chat' });
  assert.match(e.message, /시간 초과/);
  assert.equal(e.timedOut, true);
  assert.equal(e.cancellationIncomplete, true, '자동 재개 차단 신호 유지');
  // 사용자 중단은 그대로(번역하지 않는다)
  const ab = Object.assign(new Error('중단됨'), { aborted: true, cancellationIncomplete: true });
  assert.equal(cliTurnFailure(ab, 'codex', 5, 1_800_000), ab);
});
