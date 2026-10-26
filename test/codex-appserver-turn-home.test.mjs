// codex app-server 턴의 임시 홈·지시(맥 one 실턴 2026-10-26, #1171 보완) — 가짜 codex를 PATH 맨 앞에 두고 execCodexAppServer를 실제로 태운다.
//  ① 끝난 턴의 임시 홈(argo-codex-as-*)이 남지 않는다 — 종료 중인 codex가 잠금 파일을 다시 만들어도(실측: 턴마다 빈 thread-writer-locks·.coordination.lock 폴더)
//  ② thread/start에 승인 판정 안내(developerInstructions)가 실린다 — read-only 표시를 보고 모델이 시도를 포기하지 않게. sandbox는 read-only 그대로
// 가짜 CLI 하네스는 test/codex-gpt61-sol-wiring.test.mjs와 같은 모양(격리 HOME·TMPDIR·ARGO_ROOT, PATH 맨 앞 가짜 실행 파일).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stubRunnerToolDirs } from './helpers/tmp.mjs';

const base = await mkdtemp(join(tmpdir(), 'argo-as-home-'));
after(() => rm(base, { recursive: true, force: true }));
process.env.HOME = process.env.USERPROFILE = join(base, 'home');
process.env.TMPDIR = join(base, 'tmp');
process.env.ARGO_ROOT = join(base, 'root');
process.env.ARGO_MODEL_CATALOG = 'off';
for (const d of [process.env.HOME, process.env.TMPDIR, process.env.ARGO_ROOT]) await mkdir(d, { recursive: true });
await stubRunnerToolDirs(process.env.HOME);
const bin = join(base, 'bin');
await mkdir(bin, { recursive: true });
const log = join(base, 'log.json');
process.env.PATH = `${bin}:${process.env.PATH}`;
process.env.ARGO_CODEX_PREFER_PATH = '1';
process.env.FAKE_CLI_LOG = log;

// app-server: 받은 메시지를 기록하고 바로 완주한다. SIGTERM을 받으면 실제 codex처럼 잠깐 뒤 CODEX_HOME에 잠금 파일을 다시 만들고 끝난다.
await writeFile(join(bin, 'codex'), `#!/usr/bin/env node
const fs = require('fs'); const path = require('path');
const a = process.argv.slice(2);
if (a[0] === '--version') { console.log('fake-codex'); process.exit(0); }
if (a[0] !== 'app-server') process.exit(2);
process.on('SIGTERM', () => setTimeout(() => {
  try { const h = process.env.CODEX_HOME; fs.mkdirSync(path.join(h, 'thread-writer-locks'), { recursive: true }); fs.writeFileSync(path.join(h, '.coordination.lock'), ''); } catch {}
  process.exit(0);
}, 150));
const got = []; const emit = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
let buf = ''; process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d; let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    const m = JSON.parse(line); got.push(m);
    fs.writeFileSync(process.env.FAKE_CLI_LOG, JSON.stringify({ received: got }));
    if (m.method === 'initialize') emit({ id: m.id, result: { userAgent: 'fake' } });
    else if (m.method === 'thread/start') emit({ id: m.id, result: { thread: { id: 't1' } } });
    else if (m.method === 'turn/start') {
      emit({ id: m.id, result: { turn: { id: 'u1', status: 'inProgress' } } });
      emit({ method: 'item/completed', params: { item: { type: 'agentMessage', id: 'a1', text: 'OK' } } });
      emit({ method: 'turn/completed', params: { turn: { id: 'u1', status: 'completed' } } });
    }
  }
});
setInterval(() => {}, 1000);
`);
await chmod(join(bin, 'codex'), 0o755);

const { execCodexAppServer, APPSERVER_APPROVAL_NOTE } = await import('../src/runners/codex-appserver.mjs');
const cwd = join(base, 'work');
await mkdir(cwd, { recursive: true });
const turnHomes = async () => (await readdir(process.env.TMPDIR)).filter((n) => n.startsWith('argo-codex-as-'));

test('① 끝난 app-server 턴은 임시 홈을 남기지 않는다 — 종료 중인 codex가 잠금 파일을 다시 만들어도', { skip: process.platform === 'win32' }, async () => {
  for (let i = 0; i < 3; i++) assert.equal(await execCodexAppServer({ model: 'gpt-5.5', cwd, prompt: 'hi', timeoutMs: 30_000 }), 'OK');
  await new Promise((r) => setTimeout(r, 400)); // 늦게 다시 만들어지는 잠금 파일까지 지켜본다
  assert.deepEqual(await turnHomes(), []);
});

test('② thread/start에 승인 판정 안내가 실린다(sandbox는 read-only 그대로)', { skip: process.platform === 'win32' }, async () => {
  await execCodexAppServer({ model: 'gpt-5.5', cwd, prompt: 'hi', timeoutMs: 30_000 });
  const p = JSON.parse(await readFile(log, 'utf8')).received.find((m) => m.method === 'thread/start').params;
  assert.equal(p.sandbox, 'read-only');
  assert.equal(p.approvalPolicy, 'untrusted');
  assert.equal(p.developerInstructions, APPSERVER_APPROVAL_NOTE);
  assert.match(APPSERVER_APPROVAL_NOTE, /approval check/);
  assert.match(APPSERVER_APPROVAL_NOTE, /do not decline or stop just because the sandbox says read-only/);
});
