// GPT-6.1 Sol·핀 0.159.3 배선 행동 테스트(유건 결정 2026-10-08) — 가짜 codex를 PATH 맨 앞에 두고 실제 실행 경로를 태운다.
//  ① exec 경로: 6.1 Sol + 강도 비움 → `-c model_reasoning_effort=medium`(서버 기본 low 대신). 다른 모델의 비움은 강도 인자 없음(지금과 같음)
//  ② 원샷 CLI 경로: `-m gpt-6-astra` 명시 — 핀 승격으로 서버 기본 모델이 astra(0.157.1) → 6.1 Sol(0.159.3)로 바뀌는 것을 막는다
//  ③ app-server 경로: 낡은 관리본(.pin ≠ 핀)의 "ChatGPT 계정 미지원" 거절 → exec 경로와 같은 ko/en 업데이트 대기 안내.
//     핀이 최신이면 원문 유지(계정 문제 — model_unavailable)
//  ④ app-server 경로: 6.1 Sol + 강도 비움 → turn/start effort=medium
// 가짜 CLI 하네스는 test/cli-runner-turn-io.test.mjs와 같은 모양(격리 HOME·TMPDIR·ARGO_ROOT, PATH 맨 앞 가짜 실행 파일).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stubRunnerToolDirs } from './helpers/tmp.mjs';

const base = await mkdtemp(join(tmpdir(), 'argo-gpt61-wiring-'));
after(() => rm(base, { recursive: true, force: true }));
// 모듈이 import 시점에 homedir()·ARGO_ROOT로 경로를 잡으므로 import 전에 바꾼다
process.env.HOME = join(base, 'home');
process.env.TMPDIR = join(base, 'tmp');
process.env.ARGO_ROOT = join(base, 'root');
process.env.ARGO_MODEL_CATALOG = 'off';
for (const d of [process.env.HOME, process.env.TMPDIR, process.env.ARGO_ROOT]) await mkdir(d, { recursive: true });
await stubRunnerToolDirs(process.env.HOME); // 관리본 자리에 빈 파일 — saveRunnerCred의 연결 워밍업이 실물(~119MB)을 받지 않게
const bin = join(base, 'bin');
await mkdir(bin, { recursive: true });
const log = join(base, 'log.json');

const { externalExec } = await import('../src/runners.mjs');
const { runOneShot } = await import('../src/oneshot.mjs');
const { saveRunnerCred } = await import('../src/runners/creds.mjs');
const { CODEX_PIN } = await import('../src/runners/codex.mjs');
const { classifyRunnerError } = await import('../src/runners/error-class.mjs');
process.env.PATH = `${bin}:${process.env.PATH}`;
process.env.ARGO_CODEX_PREFER_PATH = '1';
process.env.FAKE_CLI_LOG = log;

// exec: argv·stdin 기록 후 --output-last-message에 답을 쓴다. app-server: JSON-RPC로 응답하고 받은 메시지를 기록한다.
// FAKE_AS_REJECT가 있으면 turn/start 뒤 그 문구로 error(willRetry:false) + turn/completed(failed)를 보낸다(벤더 400의 app-server 모양).
await writeFile(join(bin, 'codex'), `#!/usr/bin/env node
const fs = require('fs');
const a = process.argv.slice(2);
if (a[0] === '--version') { console.log('fake-codex'); process.exit(0); }
if (a[0] === 'app-server') {
  const got = [];
  const emit = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => {
    buf += d; let i;
    while ((i = buf.indexOf('\\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      const m = JSON.parse(line); got.push(m);
      fs.writeFileSync(process.env.FAKE_CLI_LOG, JSON.stringify({ argv: a, received: got }));
      if (m.method === 'initialize') emit({ id: m.id, result: { userAgent: 'fake' } });
      else if (m.method === 'thread/start') emit({ id: m.id, result: { thread: { id: 't1' } } });
      else if (m.method === 'turn/start') {
        emit({ id: m.id, result: { turn: { id: 'u1', status: 'inProgress' } } });
        if (process.env.FAKE_AS_REJECT) {
          emit({ method: 'error', params: { error: { message: process.env.FAKE_AS_REJECT }, willRetry: false } });
          emit({ method: 'turn/completed', params: { turn: { id: 'u1', status: 'failed' } } });
        } else {
          emit({ method: 'item/completed', params: { item: { type: 'agentMessage', id: 'a1', text: 'OK' } } });
          emit({ method: 'turn/completed', params: { turn: { id: 'u1', status: 'completed' } } });
        }
      }
    }
  });
  return;
}
let s = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { s += d; }).on('end', () => {
  fs.writeFileSync(process.env.FAKE_CLI_LOG, JSON.stringify({ argv: a, stdin: s }));
  const i = a.indexOf('--output-last-message');
  if (i >= 0) fs.writeFileSync(a[i + 1], 'OK');
});
`);
await chmod(join(bin, 'codex'), 0o755);
// 안전 장치 — 실제 codex(네트워크·과금)가 먼저 잡히면 여기서 멈춘다
if (process.platform !== 'win32') assert.equal(execFileSync('codex', ['--version'], { env: process.env }).toString().trim(), 'fake-codex', 'codex는 가짜여야 한다');

const cwd = join(base, 'cwd');
await mkdir(cwd, { recursive: true });
const lastArgv = async () => JSON.parse(await readFile(log, 'utf8')).argv;
const effortArg = (argv) => { const i = argv.indexOf('-c'); return i >= 0 ? argv[i + 1] : null; };
const modelArg = (argv) => { const i = argv.indexOf('-m'); return i >= 0 ? argv[i + 1] : null; };
const pinFile = join(process.env.HOME, '.argo', 'tools', 'codex-cli', '.pin');

test('① exec — 6.1 Sol + 강도 비움은 medium, 고른 강도는 그대로, 다른 모델의 비움은 강도 인자 없음', { skip: process.platform === 'win32' }, async () => {
  for (const [model, effort, want] of [
    ['gpt-6.1-sol', '', 'model_reasoning_effort=medium'],
    ['gpt-6.1-sol', 'ultra', 'model_reasoning_effort=ultra'],
    ['gpt-6-astra', 'max', 'model_reasoning_effort=max'],
    ['gpt-6-sol', '', null],
    ['gpt-6-astra', '', null],
    ['gpt-5.6-sol', '', null],
  ]) {
    const reply = await externalExec({ runner: 'codex', model, effort, cwd, prompt: 'hi', timeoutMs: 60_000 });
    assert.equal(reply, 'OK');
    const argv = await lastArgv();
    assert.equal(modelArg(argv), model, `${model}/${effort}`);
    assert.equal(effortArg(argv), want, `${model}/${effort || '(비움)'}`);
  }
});

test('② 원샷 CLI 경로 — codex에 -m gpt-6-astra를 명시하고 강도 인자는 넣지 않는다(핀 승격 뒤에도 지금과 같은 모델)', { skip: process.platform === 'win32' }, async () => {
  const ws = 'oneshot61';
  await mkdir(join(process.env.ARGO_ROOT, ws), { recursive: true });
  await saveRunnerCred(ws, 'codex', 'host', 'host');
  for (const opts of [{ pin: 'codex' }, { pin: 'codex', readOnly: true, model: 'gpt-6.1-sol' }]) { // 대화 요약(chat.mjs)은 크루 모델을 넘기지만 CLI 원샷은 지금처럼 쓰지 않는다
    const r = await runOneShot(ws, '요약해', { ...opts, timeoutMs: 60_000 });
    assert.equal(r.runner, 'codex'); assert.equal(r.text, 'OK');
    const argv = await lastArgv();
    assert.equal(modelArg(argv), 'gpt-6-astra', JSON.stringify(opts));
    assert.equal(effortArg(argv), null, '강도는 서버 기본(astra = medium) 그대로');
  }
});

const ACCOUNT_REJECT = "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.";
test('③ app-server — 낡은 관리본의 계정 미지원 거절은 업데이트 대기 안내(runner_outdated), 핀이 최신이면 원문 유지', { skip: process.platform === 'win32' }, async () => {
  process.env.ARGO_CODEX_ENGINE = 'appserver';
  process.env.FAKE_AS_REJECT = ACCOUNT_REJECT;
  try {
    await writeFile(pinFile, 'rust-v0.157.1'); // 승격 실패(오프라인·스로틀)로 옛 관리본에 머문 PC
    const stale = await externalExec({ runner: 'codex', model: 'gpt-6.1-sol', cwd, prompt: 'hi', timeoutMs: 60_000 }).then(() => null, (e) => e);
    assert.ok(stale, '거절이 실패로 올라와야 한다');
    assert.match(stale.message, /Codex 실행기 업데이트가 아직 끝나지 않아/);
    assert.match(stale.message, /Codex runner update is not finished/);
    assert.ok(stale.message.includes(ACCOUNT_REJECT), '벤더 원문 보존(진단용)');
    assert.equal(classifyRunnerError(stale.message).code, 'runner_outdated');

    await writeFile(pinFile, CODEX_PIN); // 핀이 최신 — 같은 거절은 계정 문제
    const fresh = await externalExec({ runner: 'codex', model: 'gpt-6.1-sol', cwd, prompt: 'hi', timeoutMs: 60_000 }).then(() => null, (e) => e);
    assert.ok(fresh);
    assert.doesNotMatch(fresh.message, /Codex 실행기 업데이트가 아직 끝나지 않아/);
    assert.equal(classifyRunnerError(fresh.message).code, 'model_unavailable');
  } finally {
    delete process.env.ARGO_CODEX_ENGINE; delete process.env.FAKE_AS_REJECT;
    await rm(pinFile, { force: true });
  }
});

test('④ app-server — 6.1 Sol + 강도 비움은 turn/start effort=medium, gpt-6-sol 비움은 effort 없음', { skip: process.platform === 'win32' }, async () => {
  process.env.ARGO_CODEX_ENGINE = 'appserver';
  try {
    for (const [model, want] of [['gpt-6.1-sol', 'medium'], ['gpt-6-sol', undefined]]) {
      const reply = await externalExec({ runner: 'codex', model, effort: '', cwd, prompt: 'hi', timeoutMs: 60_000 });
      assert.equal(reply, 'OK');
      const { argv, received } = JSON.parse(await readFile(log, 'utf8'));
      assert.deepEqual(argv, ['app-server']);
      assert.equal(received.find((m) => m.method === 'thread/start').params.model, model);
      assert.equal(received.find((m) => m.method === 'turn/start').params.effort, want, model);
    }
  } finally { delete process.env.ARGO_CODEX_ENGINE; }
});
