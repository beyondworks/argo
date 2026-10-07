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

// 관리본 자리(~/.argo/tools/codex-cli)에 가짜 codex를 두고 스탬프(.pin)를 정한 채 실행한다 — 모델을 비운 턴의 고정 모델은
// "핀 이상 관리본"일 때만 들어가므로 PATH 가짜(ARGO_CODEX_PREFER_PATH)로는 그 경로를 못 탄다. 내려받기(fetch)는 가짜로 막고
// 시도한 주소를 기록한다(승격·되돌림 관찰). attempt=true면 실패 스로틀(.attempt-at)을 지금으로 찍어 둔다(승격 실패 뒤 1시간 안).
const toolDir = join(process.env.HOME, '.argo', 'tools', 'codex-cli');
const managedBin = join(toolDir, 'codex');
const attemptFile = join(toolDir, '.attempt-at');
async function withManaged({ pin, attempt = false }, fn) {
  const preferPath = process.env.ARGO_CODEX_PREFER_PATH;
  delete process.env.ARGO_CODEX_PREFER_PATH;
  await writeFile(managedBin, await readFile(join(bin, 'codex')));
  await chmod(managedBin, 0o755);
  if (pin == null) await rm(pinFile, { force: true }); else await writeFile(pinFile, pin);
  if (attempt) await writeFile(attemptFile, String(Date.now())); else await rm(attemptFile, { force: true });
  const fetched = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => { fetched.push(String(url)); return { ok: false, status: 503, arrayBuffer: async () => new ArrayBuffer(0) }; };
  try { return await fn(fetched); } finally {
    globalThis.fetch = realFetch;
    process.env.ARGO_CODEX_PREFER_PATH = preferPath;
    await writeFile(managedBin, ''); // stubRunnerToolDirs 상태로 되돌린다
    await rm(pinFile, { force: true }); await rm(attemptFile, { force: true });
  }
}
const UNSET_MODEL = 'gpt-6-astra'; // 0.157.1(0.1.97 핀)이 -m 없이 쓰던 서버 기본 모델(2026-10-07 머리글 실측)

test('② 원샷 CLI 경로 — 핀 관리본이면 codex에 -m gpt-6-astra, 강도 인자 없음(핀 승격 뒤에도 0.1.97과 같은 모델)', { skip: process.platform === 'win32' }, async () => {
  const ws = 'oneshot61';
  await mkdir(join(process.env.ARGO_ROOT, ws), { recursive: true });
  await saveRunnerCred(ws, 'codex', 'host', 'host');
  await withManaged({ pin: CODEX_PIN }, async (fetched) => {
    for (const opts of [{ pin: 'codex' }, { pin: 'codex', readOnly: true, model: 'gpt-6.1-sol' }]) { // 대화 요약(chat.mjs)은 크루 모델을 넘기지만 CLI 원샷은 지금처럼 쓰지 않는다
      const r = await runOneShot(ws, '요약해', { ...opts, timeoutMs: 60_000 });
      assert.equal(r.runner, 'codex'); assert.equal(r.text, 'OK');
      const argv = await lastArgv();
      assert.equal(modelArg(argv), UNSET_MODEL, JSON.stringify(opts));
      assert.equal(effortArg(argv), null, '강도는 서버 기본(astra = medium) 그대로');
    }
    assert.deepEqual(fetched, [], '핀 관리본이면 내려받지 않는다');
  });
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

// ⑤~⑨ 검수(2026-10-08) 반영 — 모델을 비운 codex 턴(프롬프트로 영입한 자동 에이전트·러너 대체·목록 밖 모델)은 -m 없이 돌아
// 서버 기본 모델을 썼고, 그 기본이 바이너리 버전마다 바뀐다(0.157.1 = gpt-6-astra, 0.159.3 = gpt-6.1-sol). 핀 승격이 이 에이전트들의
// 모델·강도를 말없이 바꾸지 않게 핀 이상 관리본에서는 gpt-6-astra를 넣는다. 강도는 크루 값 그대로(0.1.97과 같은 인자 — 비움은 인자 없음,
// max는 xhigh). 버전을 모르는 실행 파일(PATH 설치본·승격 못 한 옛 관리본)은 지금처럼 비운다(옛 codex가 Astra를 거절하지 않게).
test('⑤ exec — 모델을 비운 턴은 핀 관리본에서 -m gpt-6-astra, 강도는 크루 값 그대로(0.1.97과 같은 인자)', { skip: process.platform === 'win32' }, async () => {
  await withManaged({ pin: CODEX_PIN }, async (fetched) => {
    for (const [model, effort, wantModel, wantEffort] of [
      ['', '', UNSET_MODEL, null],
      ['', 'max', UNSET_MODEL, 'model_reasoning_effort=xhigh'], // 0.1.97: 모델 없음 → 옛 사상(max→xhigh)
      ['', 'high', UNSET_MODEL, 'model_reasoning_effort=high'],
      ['gpt-6.1-sol', '', 'gpt-6.1-sol', 'model_reasoning_effort=medium'], // 이름 있는 모델은 그대로
      ['gpt-5.6-sol', '', 'gpt-5.6-sol', null],
    ]) {
      assert.equal(await externalExec({ runner: 'codex', model, effort, cwd, prompt: 'hi', timeoutMs: 60_000 }), 'OK');
      const argv = await lastArgv();
      assert.equal(modelArg(argv), wantModel, `${model || '(비움)'}/${effort || '(비움)'}`);
      assert.equal(effortArg(argv), wantEffort, `${model || '(비움)'}/${effort || '(비움)'}`);
    }
    assert.deepEqual(fetched, []);
  });
});

test('⑥ app-server — 모델을 비운 턴은 핀 관리본에서 thread/start model=gpt-6-astra, 강도는 크루 값 그대로', { skip: process.platform === 'win32' }, async () => {
  process.env.ARGO_CODEX_ENGINE = 'appserver';
  try {
    await withManaged({ pin: CODEX_PIN }, async () => {
      for (const [model, effort, wantModel, wantEffort] of [
        ['', '', UNSET_MODEL, undefined],
        ['', 'max', UNSET_MODEL, 'xhigh'],
        ['gpt-6.1-sol', '', 'gpt-6.1-sol', 'medium'],
      ]) {
        assert.equal(await externalExec({ runner: 'codex', model, effort, cwd, prompt: 'hi', timeoutMs: 60_000 }), 'OK');
        const { argv, received } = JSON.parse(await readFile(log, 'utf8'));
        assert.deepEqual(argv, ['app-server']);
        assert.equal(received.find((m) => m.method === 'thread/start').params.model, wantModel, `${model || '(비움)'}/${effort || '(비움)'}`);
        assert.equal(received.find((m) => m.method === 'turn/start').params.effort, wantEffort, `${model || '(비움)'}/${effort || '(비움)'}`);
      }
    });
  } finally { delete process.env.ARGO_CODEX_ENGINE; }
});

test('⑦ 실제 chat() — 자동 에이전트·모델 없는 codex 카드·claude→codex 대체가 모두 -m gpt-6-astra, 6.1 Sol 카드는 그대로', { skip: process.platform === 'win32' }, async () => {
  const { createCompany, paths } = await import('../src/workspace.mjs');
  const { chat } = await import('../src/chat.mjs');
  const ws = 'unsetmodel';
  await createCompany(ws, '모델 비움', 'captain', null, 'ko');
  await mkdir(paths(ws).agents, { recursive: true });
  const cards = {
    'auto-crew': ['---\nname: 가\nrole: 일\n---\n일한다.\n', UNSET_MODEL, null], // 프롬프트로 영입한 에이전트 모양(runner·model 없음)
    'codex-nomodel': ['---\nname: 나\nrole: 일\nrunner: codex\n---\n일한다.\n', UNSET_MODEL, null],
    'claude-fallback': ['---\nname: 다\nrole: 일\nrunner: claude\nmodel: claude-opus-5-5\neffort: max\n---\n일한다.\n', UNSET_MODEL, 'model_reasoning_effort=xhigh'],
    'codex-unknown': ['---\nname: 마\nrole: 일\nrunner: codex\nmodel: gpt-9-nope\n---\n일한다.\n', UNSET_MODEL, null], // 목록 밖 모델(폐기·오타) — chat이 비운 모델로 강등
    'sol61': ['---\nname: 라\nrole: 일\nrunner: codex\nmodel: gpt-6.1-sol\n---\n일한다.\n', 'gpt-6.1-sol', 'model_reasoning_effort=medium'],
  };
  for (const [slug, [md]] of Object.entries(cards)) await writeFile(join(paths(ws).agents, `${slug}.md`), md);
  await saveRunnerCred(ws, 'codex', 'apikey', 'sk-test-fake'); // claude는 연결하지 않는다 — claude 카드는 codex로 대체된다
  await withManaged({ pin: CODEX_PIN }, async () => {
    for (const [slug, [, wantModel, wantEffort]] of Object.entries(cards)) {
      const r = await chat(ws, slug, '안녕', null, {});
      assert.equal(r.reply, 'OK', slug);
      const argv = await lastArgv();
      assert.equal(modelArg(argv), wantModel, slug);
      assert.equal(effortArg(argv), wantEffort, slug);
    }
  });
});

test('⑧ 버전을 모르는 실행 파일은 지금처럼 -m 없이 — 승격 못 한 옛 관리본·PATH 설치본(크루 턴·원샷 모두)', { skip: process.platform === 'win32' }, async () => {
  const ws = 'oneshot-stale';
  await mkdir(join(process.env.ARGO_ROOT, ws), { recursive: true });
  await saveRunnerCred(ws, 'codex', 'host', 'host');
  const runBoth = async (label) => {
    assert.equal(await externalExec({ runner: 'codex', model: '', cwd, prompt: 'hi', timeoutMs: 60_000 }), 'OK');
    assert.equal(modelArg(await lastArgv()), null, `${label} — 크루 턴`);
    const r = await runOneShot(ws, '요약해', { pin: 'codex', timeoutMs: 60_000 });
    assert.equal(r.text, 'OK');
    assert.equal(modelArg(await lastArgv()), null, `${label} — 원샷`);
  };
  // 승격이 실패해 1시간 스로틀 안에 있는 옛 관리본(0.157.1) — 그 버전의 기본 모델 그대로(0.157.1이면 Astra)
  await withManaged({ pin: 'rust-v0.157.1', attempt: true }, async (fetched) => {
    await runBoth('옛 관리본');
    assert.deepEqual(fetched, [], '스로틀 안에서는 다시 받지 않는다');
  });
  // 관리본을 못 받아 PATH의 사용자 설치본으로 도는 경우(여기선 PREFER_PATH 가짜) — 버전 미상
  await runBoth('PATH 설치본');
});

test('⑨ 관리본 스탬프는 한 방향으로만 승격 — 더 높은 핀(새 Argo가 설치)은 되돌리지 않고, 낮은 핀만 다시 받는다', { skip: process.platform === 'win32' }, async () => {
  const codex = await import('../src/runners/codex.mjs');
  const [maj, min] = CODEX_PIN.replace(/^rust-v/, '').split('.').map(Number);
  const higher = `rust-v${maj}.${min + 1}.0`;
  // 같은 기기의 더 새 Argo(상주 등)가 올려 둔 관리본 — 이 프로세스가 내려받아 되돌리면 두 프로세스가 1시간마다 서로 덮는다(검수 MEDIUM)
  await withManaged({ pin: higher }, async (fetched) => {
    assert.equal(await externalExec({ runner: 'codex', model: '', cwd, prompt: 'hi', timeoutMs: 60_000 }), 'OK');
    assert.deepEqual(fetched, [], '더 높은 핀을 되돌리려고 내려받지 않는다');
    assert.equal((await readFile(pinFile, 'utf8')).trim(), higher, '스탬프 유지');
    assert.equal(modelArg(await lastArgv()), UNSET_MODEL, '핀 이상 관리본 — 고정 모델');
    assert.equal(await codex.codexPinStale(), false, '더 높은 핀은 낡은 관리본이 아니다');
    // 도구 잠김 자가치유(L2 — reprovisionRunner)의 강제 재조달도 더 높은 핀을 되돌리지 않는다
    await codex.reprovisionCodexCli().catch(() => {});
    assert.deepEqual(fetched, [], '강제 재조달도 더 높은 핀을 내려받아 덮지 않는다');
    assert.equal((await readFile(pinFile, 'utf8')).trim(), higher);
  });
  // 낮은 핀(0.1.97이 남긴 관리본)은 지금처럼 핀 버전 승격을 시도한다(여기선 내려받기 실패 → 옛 관리본으로 계속)
  await withManaged({ pin: 'rust-v0.157.1' }, async (fetched) => {
    assert.equal(await externalExec({ runner: 'codex', model: '', cwd, prompt: 'hi', timeoutMs: 60_000 }), 'OK');
    assert.ok(fetched.some((u) => u.includes(`/download/${CODEX_PIN}/`)), `핀 버전 승격 시도: ${fetched.join(', ')}`);
    assert.equal(modelArg(await lastArgv()), null, '승격 실패 — 버전을 모르니 비운 채로');
    assert.equal(await codex.codexPinStale(), true);
  });
  // 스탬프 비교는 숫자 단위(사전순 아님), 형식이 다르면 낡은 것으로 본다(다시 받는다 — 지금과 같음)
  for (const [stamp, want] of [
    ['rust-v0.159.3', true], ['rust-v0.159.10', true], ['rust-v0.160.0', true], ['rust-v1.0.0', true],
    ['rust-v0.159.2', false], ['rust-v0.157.1', false], ['rust-v0.99.9', false], ['', false], ['garbage', false], ['rust-v0.159.4-alpha.1', false],
  ]) assert.equal(codex.codexStampCurrent(stamp, 'rust-v0.159.3'), want, stamp || '(빈 스탬프)');
});

test('⑩ 고정 모델도 원격 카탈로그 alias를 따른다(모델 폐기 때 앱 발행 없이 옮길 길) — 이름 있는 모델은 그대로', { skip: process.platform === 'win32' }, async () => {
  const remote = await import('../src/runners/catalog-remote.mjs');
  remote._resetForTest();
  const overlay = { schema: 1, runners: { codex: { add: [], retire: [], alias: { [UNSET_MODEL]: 'gpt-6-sol' } } } };
  await remote.loadRemoteCatalog({ fetchImpl: async () => ({ ok: true, json: async () => overlay }), now: Date.now() });
  try {
    await withManaged({ pin: CODEX_PIN }, async () => {
      assert.equal(await externalExec({ runner: 'codex', model: '', cwd, prompt: 'hi', timeoutMs: 60_000 }), 'OK');
      assert.equal(modelArg(await lastArgv()), 'gpt-6-sol', 'alias 목적지');
      assert.equal(await externalExec({ runner: 'codex', model: 'gpt-6.1-sol', cwd, prompt: 'hi', timeoutMs: 60_000 }), 'OK');
      assert.equal(modelArg(await lastArgv()), 'gpt-6.1-sol');
    });
  } finally {
    remote._resetForTest();
    await rm(remote.cacheFile(), { force: true }); // 디스크 캐시가 다음 테스트의 첫 로드에 섞이지 않게
  }
});
