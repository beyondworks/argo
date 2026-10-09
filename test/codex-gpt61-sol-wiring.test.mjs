// GPT-6.1 Sol·핀 0.159.3 배선 행동 테스트(유건 결정 2026-10-08) — 가짜 codex를 PATH 맨 앞에 두고 실제 실행 경로를 태운다.
//  ① exec 경로: 6.1 Sol + 강도 비움 → `-c model_reasoning_effort=medium`(서버 기본 low 대신). 다른 모델의 비움은 강도 인자 없음(지금과 같음)
//  ② 원샷 CLI 경로: `-m gpt-6-astra` 명시 — 핀 승격으로 서버 기본 모델이 astra(0.157.1) → 6.1 Sol(0.159.3)로 바뀌는 것을 막는다
//  ③ app-server 경로: 낡은 관리본(.pin ≠ 핀)의 "ChatGPT 계정 미지원" 거절 → exec 경로와 같은 ko/en 업데이트 대기 안내.
//     핀이 최신이면 원문 유지(계정 문제 — model_unavailable)
//  ④ app-server 경로: 6.1 Sol + 강도 비움 → turn/start effort=medium
//  ⑤~⑩ 모델을 비운 턴의 고정 모델, ⑧·⑨·⑪ 핀별 관리본 폴더(버전이 다른 Argo와 예전 공용 폴더를 나눠 쓰지 않는다), ⑫ 내려받기 해시 대조
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
process.env.HOME = process.env.USERPROFILE = join(base, 'home'); // 윈도우 homedir()는 USERPROFILE을 본다
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
const { CODEX_PIN, codexToolDirFor } = await import('../src/runners/codex.mjs');
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

// 관리본 자리에 가짜 codex를 두고 실행한다 — 모델을 비운 턴의 고정 모델은 "이 핀 관리본"일 때만 들어가므로 PATH 가짜
// (ARGO_CODEX_PREFER_PATH)로는 그 경로를 못 탄다. 관리본은 핀마다 폴더가 따로다(~/.argo/tools/codex-cli-<핀>). 예전 공용 폴더
// (~/.argo/tools/codex-cli)는 0.1.97 이하가 쓰는 자리라 legacy로 따로 심는다. 내려받기(fetch)는 가짜로 막고 시도한 주소를 기록한다.
//  own: 이 핀 관리본을 둔다(false면 없음), ownStamp: 설치 완료 스탬프(.pin), legacy: 예전 공용 관리본의 스탬프(null이면 폴더 없음),
//  attempt: 이 핀 폴더의 실패 스로틀(.attempt-at)을 지금으로(승격 실패 뒤 1시간 안), legacyAttempt: 옛 Argo가 공용 폴더에 남긴 스로틀.
const toolDir = codexToolDirFor(process.env.HOME);
const managedBin = join(toolDir, 'codex');
const pinFile = join(toolDir, '.pin');
const attemptFile = join(toolDir, '.attempt-at');
const legacyDir = join(process.env.HOME, '.argo', 'tools', 'codex-cli');
const legacyBin = join(legacyDir, 'codex');
const FAKE_LEGACY = '#!/bin/sh\n# legacy 0.157.1 자리\n';
async function withManaged({ own = true, ownStamp = true, legacy = null, attempt = false, legacyAttempt = false }, fn) {
  const preferPath = process.env.ARGO_CODEX_PREFER_PATH;
  delete process.env.ARGO_CODEX_PREFER_PATH;
  const fake = await readFile(join(bin, 'codex'));
  if (own) { await writeFile(managedBin, fake); await chmod(managedBin, 0o755); } else await rm(managedBin, { force: true });
  if (own && ownStamp) await writeFile(pinFile, CODEX_PIN); else await rm(pinFile, { force: true });
  if (attempt) await writeFile(attemptFile, String(Date.now())); else await rm(attemptFile, { force: true });
  if (legacy != null) {
    await mkdir(legacyDir, { recursive: true });
    await writeFile(legacyBin, fake); await chmod(legacyBin, 0o755); // 실행은 같은 가짜(버전 판정은 어느 폴더를 골랐는가로 본다)
    await writeFile(join(legacyDir, '.pin'), legacy);
    if (legacyAttempt) await writeFile(join(legacyDir, '.attempt-at'), String(Date.now()));
  }
  const fetched = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => { fetched.push(String(url)); return { ok: false, status: 503, arrayBuffer: async () => new ArrayBuffer(0) }; };
  try { return await fn(fetched); } finally {
    globalThis.fetch = realFetch;
    process.env.ARGO_CODEX_PREFER_PATH = preferPath;
    await mkdir(toolDir, { recursive: true });
    await writeFile(managedBin, ''); await writeFile(pinFile, CODEX_PIN); // stubRunnerToolDirs 상태로 되돌린다
    await rm(attemptFile, { force: true });
    await rm(join(toolDir, 'codex-code-mode-host'), { force: true });
    await rm(legacyDir, { recursive: true, force: true });
  }
}
// 예전 공용 폴더의 내용 — 새 Argo는 이 폴더에 쓰지도 지우지도 않는다(0.1.97 이하가 그 폴더의 주인)
const legacySnapshot = async () => {
  const { readdir } = await import('node:fs/promises');
  const names = (await readdir(legacyDir).catch(() => [])).sort();
  return Promise.all(names.map(async (n) => `${n}=${(await readFile(join(legacyDir, n)).catch(() => Buffer.from('?'))).toString('base64')}`));
};
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
    await rm(managedBin, { force: true }); // 이 핀을 아직 못 받은(오프라인·스로틀) PC — 이 핀 관리본이 없다
    const stale = await externalExec({ runner: 'codex', model: 'gpt-6.1-sol', cwd, prompt: 'hi', timeoutMs: 60_000 }).then(() => null, (e) => e);
    assert.ok(stale, '거절이 실패로 올라와야 한다');
    assert.match(stale.message, /Codex 실행기 업데이트가 아직 끝나지 않아/);
    assert.match(stale.message, /Codex runner update is not finished/);
    assert.ok(stale.message.includes(ACCOUNT_REJECT), '벤더 원문 보존(진단용)');
    assert.equal(classifyRunnerError(stale.message).code, 'runner_outdated');

    await writeFile(managedBin, ''); // 이 핀 관리본이 있다 — 같은 거절은 계정 문제
    const fresh = await externalExec({ runner: 'codex', model: 'gpt-6.1-sol', cwd, prompt: 'hi', timeoutMs: 60_000 }).then(() => null, (e) => e);
    assert.ok(fresh);
    assert.doesNotMatch(fresh.message, /Codex 실행기 업데이트가 아직 끝나지 않아/);
    assert.equal(classifyRunnerError(fresh.message).code, 'model_unavailable');
  } finally {
    delete process.env.ARGO_CODEX_ENGINE; delete process.env.FAKE_AS_REJECT;
    await writeFile(managedBin, ''); // stubRunnerToolDirs 상태
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

test('⑧ 버전을 모르는 실행 파일은 지금처럼 -m 없이 — 이 핀을 못 받아 빌려 쓰는 예전 공용 관리본·PATH 설치본(크루 턴·원샷 모두)', { skip: process.platform === 'win32' }, async () => {
  const ws = 'oneshot-stale';
  await mkdir(join(process.env.ARGO_ROOT, ws), { recursive: true });
  await saveRunnerCred(ws, 'codex', 'host', 'host');
  const runBoth = async (label, wantFile) => {
    assert.equal(await externalExec({ runner: 'codex', model: '', cwd, prompt: 'hi', timeoutMs: 60_000 }), 'OK');
    assert.equal(modelArg(await lastArgv()), null, `${label} — 크루 턴`);
    const r = await runOneShot(ws, '요약해', { pin: 'codex', timeoutMs: 60_000 });
    assert.equal(r.text, 'OK');
    assert.equal(modelArg(await lastArgv()), null, `${label} — 원샷`);
  };
  // 이 핀 관리본을 받으려다 실패해 1시간 스로틀 안 — 예전 공용 관리본(0.157.1)을 그대로 빌린다(그 버전 기본 모델 = Astra)
  await withManaged({ own: false, legacy: 'rust-v0.157.1', attempt: true }, async (fetched) => {
    const before = await legacySnapshot();
    await runBoth('예전 공용 관리본');
    assert.deepEqual(fetched, [], '스로틀 안에서는 다시 받지 않는다');
    assert.deepEqual(await legacySnapshot(), before, '예전 공용 폴더에 쓰지 않는다');
  });
  // 관리본을 못 받아 PATH의 사용자 설치본으로 도는 경우(여기선 PREFER_PATH 가짜) — 버전 미상
  await runBoth('PATH 설치본');
});

// ⑨ 검수(2026-10-08 재검수 MEDIUM) — 관리본을 한 폴더로 나눠 쓰면 0.1.97(핀 0.157.1)과 이 버전(0.159.3)이 1시간마다 서로 되돌리고,
// 그 사이 옛 쪽은 새 바이너리로 -m 없이 돌아 6.1 Sol·low가 됐다. 핀마다 폴더를 나눴으므로 새 Argo는 예전 공용 폴더를 건드리지 않고,
// 옛 Argo가 그 폴더를 무엇으로 바꾸든(되돌림·더 높은 핀·스로틀 기록) 새 Argo의 실행 파일·모델·스로틀은 그대로다.
test('⑨ 버전이 섞인 기기 — 새 Argo는 자기 핀 폴더만 쓰고, 예전 공용 폴더는 읽지도 덮지도 않는다(옛 Argo의 되돌림이 새 Argo에 닿지 않는다)', { skip: process.platform === 'win32' }, async () => {
  const codex = await import('../src/runners/codex.mjs');
  for (const legacy of ['rust-v0.157.1', 'rust-v0.160.0', '', 'garbage']) { // 옛 Argo가 남긴 어떤 상태든
    await withManaged({ own: true, legacy, legacyAttempt: true }, async (fetched) => {
      const before = await legacySnapshot();
      assert.equal(await externalExec({ runner: 'codex', model: '', cwd, prompt: 'hi', timeoutMs: 60_000 }), 'OK');
      assert.equal(modelArg(await lastArgv()), UNSET_MODEL, `${legacy || '(빈 스탬프)'} — 자기 핀 관리본이라 고정 모델`);
      assert.equal(await codex.codexPinStale(), false);
      // 도구 잠김 자가치유(L2 — reprovisionRunner)의 강제 재조달도 자기 핀 폴더에만 — 공용 폴더는 그대로
      await codex.reprovisionCodexCli().catch(() => {});
      assert.ok(fetched.every((u) => u.includes(`/download/${CODEX_PIN}/`)), `다른 핀을 받지 않는다: ${fetched.join(', ')}`);
      assert.deepEqual(await legacySnapshot(), before, `${legacy || '(빈 스탬프)'} — 예전 공용 폴더에 쓰지 않는다`);
    });
  }
  // 이 핀 폴더가 아직 없는 첫 턴 — 이 핀을 받으려 하고(실패 → 예전 공용 관리본으로 계속), 옛 Argo가 공용 폴더에 남긴 스로틀에 막히지 않는다
  await withManaged({ own: false, legacy: 'rust-v0.157.1', legacyAttempt: true }, async (fetched) => {
    const before = await legacySnapshot();
    assert.equal(await externalExec({ runner: 'codex', model: '', cwd, prompt: 'hi', timeoutMs: 60_000 }), 'OK');
    assert.ok(fetched.some((u) => u.includes(`/download/${CODEX_PIN}/`)), `이 핀 관리본 준비 시도: ${fetched.join(', ')}`);
    assert.equal(modelArg(await lastArgv()), null, '받지 못함 — 공용 관리본(버전 미상)은 비운 채로');
    assert.equal(await codex.codexPinStale(), true);
    const n = fetched.length;
    assert.equal(await externalExec({ runner: 'codex', model: '', cwd, prompt: 'hi', timeoutMs: 60_000 }), 'OK');
    assert.equal(fetched.length, n, '실패 뒤 1시간은 턴마다 다시 받지 않는다(이 핀 폴더의 스로틀)');
    assert.deepEqual(await legacySnapshot(), before, '예전 공용 폴더에 쓰지 않는다(host 보강 포함)');
  });
});

// ⑪ 검수(재검수 LOW) — 스탬프만 보고 판정하면 기록 실패·윈도우 EBUSY로 .pin만 비었을 때 이 핀 실행 파일인데도 -m 없이 돌았다.
// 핀 폴더에는 이 핀만 들어가므로 실행 파일이 있으면 이 핀이다 — 스탬프가 비면 host 보강만 시도한다.
test('⑪ 스탬프가 빈 이 핀 관리본 — 여전히 이 핀(-m gpt-6-astra, 낡지 않음), host가 없으면 보강을 시도한다', { skip: process.platform === 'win32' }, async () => {
  const codex = await import('../src/runners/codex.mjs');
  await withManaged({ own: true, ownStamp: false }, async (fetched) => {
    assert.equal(await externalExec({ runner: 'codex', model: '', cwd, prompt: 'hi', timeoutMs: 60_000 }), 'OK');
    assert.equal(modelArg(await lastArgv()), UNSET_MODEL);
    assert.equal(await codex.codexPinStale(), false);
    assert.ok(fetched.some((u) => u.includes('codex-code-mode-host-')), `host 보강 시도: ${fetched.join(', ')}`);
  });
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

// ⑬ GPT-5.5 종료(Codex 서버 목록 upgrade.retirement_at 2026-10-14T19:00Z) — 목록에서 뺀 뒤에도 이미 gpt-5.5를 고른 에이전트는 실패하지 않고
// GPT-5.6 Sol로 돈다(원격 카탈로그 없이도 — catalog.mjs RETIRED_MODEL_ALIASES). 대체표가 없으면 목록 밖 모델이라 ⑦ codex-unknown처럼
// 고정 모델(gpt-6-astra)로 강등되고 '모델 대체' 안내가 붙는다. 6.1 Sol로 보내지 않는 이유: 핀 0.157.1 옛 앱에서 400(catalog.mjs 주석).
// 강도(분리 검수 MEDIUM, 총괄 결정 c): 빈 강도는 인자 없이 서버 기본을 쓰는데 서버 기본이 gpt-5.5 = medium, 5.6 Sol = low
// (~/.codex/models_cache.json default_reasoning_level)라 옮기기만 하면 말없이 low로 내려간다. 대체표로 옮겨진 카드의 빈 강도만 옛 기본(medium)을
// 넘기고, 원래 5.6 Sol을 고른 카드의 빈 강도·직접 고른 강도는 그대로 둔다.
const OLD55 = {
  old55: ['---\nname: 바\nrole: 일\nrunner: codex\nmodel: gpt-5.5\n---\n일한다.\n', 'model_reasoning_effort=medium', 'medium'],
  old55high: ['---\nname: 사\nrole: 일\nrunner: codex\nmodel: gpt-5.5\neffort: high\n---\n일한다.\n', 'model_reasoning_effort=high', 'high'],
  old55max: ['---\nname: 아\nrole: 일\nrunner: codex\nmodel: gpt-5.5\neffort: max\n---\n일한다.\n', 'model_reasoning_effort=xhigh', 'xhigh'], // 5.6 Sol은 옛 사상(max→xhigh)
  sol56: ['---\nname: 자\nrole: 일\nrunner: codex\nmodel: gpt-5.6-sol\n---\n일한다.\n', null, undefined], // 원래 5.6 Sol — 빈 강도는 서버 기본 그대로
};
async function old55Company(ws) {
  const { createCompany, paths } = await import('../src/workspace.mjs');
  await createCompany(ws, 'GPT-5.5 종료', 'captain', null, 'ko');
  await mkdir(paths(ws).agents, { recursive: true });
  for (const [slug, [md]] of Object.entries(OLD55)) await writeFile(join(paths(ws).agents, `${slug}.md`), md);
  await saveRunnerCred(ws, 'codex', 'apikey', 'sk-test-fake');
}
test('⑬ 실제 chat() exec — gpt-5.5 카드는 -m gpt-5.6-sol, 빈 강도는 medium, 고른 강도는 그대로, 원래 5.6 Sol 빈 강도는 인자 없음, 모델 대체 안내 없음', { skip: process.platform === 'win32' }, async () => {
  const { chat } = await import('../src/chat.mjs');
  const ws = 'gpt55retire';
  await old55Company(ws);
  await withManaged({ pin: CODEX_PIN }, async () => {
    for (const [slug, [, wantEffort]] of Object.entries(OLD55)) {
      const r = await chat(ws, slug, '안녕', null, {});
      assert.equal(r.reply, 'OK', slug);
      const argv = await lastArgv();
      assert.equal(modelArg(argv), 'gpt-5.6-sol', `${slug} — 대체 모델로 실행`);
      assert.equal(effortArg(argv), wantEffort, `${slug} — 강도`);
      assert.equal(r.modelFallback, undefined, `${slug} — 대체표로 옮긴 모델은 목록 안 모델이라 강등 안내가 없다`);
    }
  });
});

test('⑬-b 실제 chat() app-server — gpt-5.5 빈 강도 카드는 thread/start model=gpt-5.6-sol·turn/start effort=medium, 원래 5.6 Sol 빈 강도는 effort 없음', { skip: process.platform === 'win32' }, async () => {
  const { chat } = await import('../src/chat.mjs');
  const ws = 'gpt55retire-as';
  await old55Company(ws);
  process.env.ARGO_CODEX_ENGINE = 'appserver';
  try {
    await withManaged({ pin: CODEX_PIN }, async () => {
      for (const [slug, [, , wantEffort]] of Object.entries(OLD55)) {
        const r = await chat(ws, slug, '안녕', null, {});
        assert.equal(r.reply, 'OK', slug);
        const { argv, received } = JSON.parse(await readFile(log, 'utf8'));
        assert.deepEqual(argv, ['app-server']);
        assert.equal(received.find((m) => m.method === 'thread/start').params.model, 'gpt-5.6-sol', slug);
        assert.equal(received.find((m) => m.method === 'turn/start').params.effort, wantEffort, slug);
      }
    });
  } finally { delete process.env.ARGO_CODEX_ENGINE; }
});

// ⑭ 카드 저장(편집 화면은 이름만 고쳐도 model을 같이 보낸다)이 gpt-5.5를 5.6 Sol로 바꿔 저장할 때 빈 강도는 medium을 같이 저장한다 —
// 저장 뒤에는 원래 5.6 Sol 카드와 구별되지 않으므로, 저장 때 강도를 남기지 않으면 다음 턴부터 low로 내려간다.
test('⑭ 카드 저장 뒤 다음 턴도 medium — gpt-5.5 빈 강도 카드를 저장하면 5.6 Sol + medium으로 저장되고, 원래 5.6 Sol 카드는 빈 강도 그대로', { skip: process.platform === 'win32' }, async () => {
  const { chat } = await import('../src/chat.mjs');
  const { updateAgentMeta, readAgentCard } = await import('../src/persona.mjs');
  const ws = 'gpt55retire-save';
  await old55Company(ws);
  await updateAgentMeta(ws, 'old55', { name: '바뀐 이름', role: '일', model: 'gpt-5.5' });
  await updateAgentMeta(ws, 'sol56', { name: '바뀐 이름2', role: '일', model: 'gpt-5.6-sol' });
  const saved = (await readAgentCard(ws, 'old55')).meta;
  assert.equal(saved.model, 'gpt-5.6-sol'); assert.equal(saved.effort, 'medium');
  assert.equal((await readAgentCard(ws, 'sol56')).meta.effort || '', '', '원래 5.6 Sol 카드에는 강도를 박지 않는다');
  await withManaged({ pin: CODEX_PIN }, async () => {
    assert.equal((await chat(ws, 'old55', '안녕', null, {})).reply, 'OK');
    const argv = await lastArgv();
    assert.equal(modelArg(argv), 'gpt-5.6-sol');
    assert.equal(effortArg(argv), 'model_reasoning_effort=medium', '저장 뒤 다음 턴도 medium');
    assert.equal((await chat(ws, 'sol56', '안녕', null, {})).reply, 'OK');
    assert.equal(effortArg(await lastArgv()), null);
  });
});

// ⑫ 검수(재검수 LOW) — 예전엔 내려받은 타르볼을 부팅·크기로만 봐서 손상·변조본도 부팅만 하면 채택됐다. 풀기 전에 핀 표의 sha256과 대조한다.
// 윈도우에서도 돈다(가짜 실행 파일 없이 조달 함수만 부른다 — 해시 대조는 tar 전에 끝난다).
test('⑫ 내려받은 자산의 해시가 표와 다르면 채택하지 않는다 — 이 핀 관리본이 생기지 않고 원인이 드러난다', async () => {
  const codex = await import('../src/runners/codex.mjs');
  const { existsSync } = await import('node:fs');
  const exe = join(toolDir, process.platform === 'win32' ? 'codex.exe' : 'codex');
  await rm(exe, { force: true }); await rm(join(toolDir, '.pin'), { force: true });
  const realFetch = globalThis.fetch;
  const fetched = [];
  globalThis.fetch = async (url) => { fetched.push(String(url)); return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode('not the real tarball').buffer }; };
  try {
    const err = await codex.provisionCodexCli().then(() => null, (e) => e);
    assert.ok(err, '해시가 다른데 조달이 성공했다');
    assert.match(err.message, /해시가 맞지 않습니다/);
    assert.ok(fetched.length >= 1 && fetched[0].includes(`/download/${CODEX_PIN}/`), fetched.join(', '));
    assert.equal(existsSync(exe), false, '검증 실패본이 관리본 자리에 들어갔다');
  } finally {
    globalThis.fetch = realFetch;
    await mkdir(toolDir, { recursive: true });
    await writeFile(exe, ''); await writeFile(join(toolDir, '.pin'), CODEX_PIN);
  }
});

// 핀 폴더 이름(순수) — 윈도우 CI에서도 돈다(재검수 LOW: 배선 테스트가 전부 win32 skip이라 경로 규칙이 윈도우에서 한 번도 안 돌았다).
test('핀 폴더는 핀마다 다르고 예전 공용 폴더(codex-cli)와 겹치지 않는다', () => {
  const home = join(base, 'h');
  const a = codexToolDirFor(home, 'rust-v0.157.1'), b = codexToolDirFor(home, 'rust-v0.159.3');
  assert.notEqual(a, b);
  assert.equal(codexToolDirFor(home), codexToolDirFor(home, CODEX_PIN));
  for (const d of [a, b]) {
    assert.notEqual(d, join(home, '.argo', 'tools', 'codex-cli'));
    assert.ok(d.startsWith(join(home, '.argo', 'tools') + (process.platform === 'win32' ? '\\' : '/')), d);
  }
  assert.ok(b.endsWith('codex-cli-rust-v0.159.3'), b);
});
