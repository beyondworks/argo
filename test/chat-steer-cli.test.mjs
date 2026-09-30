// 끼워 넣기 — 한 번 실행하고 끝나는 CLI 러너(codex exec·gemini·antigravity) 경로를 chat()째 실행으로 잠근다.
// 실행 중에는 입력 통로가 없어, 받아 둔 메시지로 같은 턴 안에서 곧바로 이어 실행하고 답을 합친다(사장이 멈추라고 한 게 아니다).
// 가짜 externalExec는 msgr-dm-context.test.mjs와 같은 로더 훅 기법으로 끼운다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from './helpers/tmp.mjs';

process.env.HOME = process.env.USERPROFILE = await mkdtemp(join(tmpdir(), 'argo-steer-cli-home-'));
process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-steer-cli-'));
process.env.ARGO_CACHE_DIR = join(process.env.ARGO_ROOT, 'cache');
process.env.ARGO_MODEL_CATALOG = process.env.ARGO_NATIVE_RUNNERS = 'off';
const fetchBefore = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('Network disabled in steer CLI test'); };
const calls = [];
let onCall = async () => 'reply';
globalThis.__steerCliExec = async (args) => { calls.push(args); return onCall(calls.length, args); };
const real = new URL('../src/runners.mjs', import.meta.url).href;
const wrapper = `data:text/javascript,${encodeURIComponent(`export * from ${JSON.stringify(real)};
  export const resolveRunner = async () => ({runner:'codex',available:true,fellBack:false});
  export const runnerCredType = async () => 'host'; export const runnerCredEnv = async () => ({});
  export const isBilledRunner = async () => false;
  export const externalExec = (args) => globalThis.__steerCliExec(args);`)}`;
const connectors = `data:text/javascript,${encodeURIComponent(`export * from ${JSON.stringify(new URL('../src/connectors.mjs', import.meta.url).href)}; export const connectorBriefing = async () => [];`)}`;
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.endsWith('/src/chat.mjs') && specifier === './runners.mjs') return { url: wrapper, shortCircuit: true };
  if (context.parentURL?.endsWith('/src/chat.mjs') && specifier === './connectors.mjs') return { url: connectors, shortCircuit: true };
  return next(specifier, context);
} });
after(() => { hooks.deregister(); globalThis.fetch = fetchBefore; delete globalThis.__steerCliExec; });
const { createCompany, paths } = await import('../src/workspace.mjs');
const { chat } = await import('../src/chat.mjs');
const { steerTurn } = await import('../src/turn-abort.mjs');

async function setup(ws) {
  await createCompany(ws, 'Steer fixture', 'owner');
  await mkdir(paths(ws).agents, { recursive: true });
  await writeFile(join(paths(ws).agents, 'alpha.md'), '---\nname: Alpha\nrunner: codex\n---\nFixture agent');
}

test('CLI: 실행 중 받은 메시지로 같은 턴에서 이어 실행하고 답을 합친다 — 턴이 끝나면 더는 받지 않는다', async () => {
  const ws = 'steer-cli-1'; await setup(ws); calls.length = 0;
  onCall = async (n) => {
    if (n === 1) { assert.equal(await steerTurn(ws, 'alpha', { text: '방향 바꿔' }), true, '실행 중이면 받는다'); return '첫 답'; }
    return '이어진 답';
  };
  const r = await chat(ws, 'alpha', '원래 지시', null, { journal: { off: true } });
  assert.equal(calls.length, 2, '멈추지 않고 한 번 더 실행');
  assert.match(calls[1].prompt, /원래 지시[\s\S]*## 너의 방금 답\n첫 답[\s\S]*## 사장이 작업 중에 보낸 새 메시지\n방향 바꿔/);
  assert.equal(calls[1].kind, 'chat');
  assert.equal(r.reply, '첫 답\n\n이어진 답');
  assert.equal(await steerTurn(ws, 'alpha', { text: '늦음' }), false, '끝난 턴 — 호출부가 대기열에 남긴다');
});

test('CLI: 크래시로 자동 재시도하면 받은 끼워 넣기가 재시도로 넘어간다 — 조용히 사라지지 않는다(검수 1)', async () => {
  const ws = 'steer-cli-3'; await setup(ws); calls.length = 0;
  onCall = async (n) => {
    if (n === 1) { assert.equal(await steerTurn(ws, 'alpha', { text: '크래시 전 끼워 넣기' }), true); throw new Error('codex exited with code 139'); }
    return '재시도 답';
  };
  const r = await chat(ws, 'alpha', '원래 지시', null, { journal: { off: true } });
  // 재시도가 통로를 달면 되돌린 메시지를 넘겨받는다 — 실행 전에 받았으니 재시도 첫 실행 프롬프트에 바로 실린다(L1: 이어 실행을 한 번 더 돌지 않는다)
  assert.equal(calls.length, 2, '크래시 → 재시도 1회(메시지 포함)');
  assert.match(calls[1].prompt, /## 사장이 이어서 보낸 메시지\n크래시 전 끼워 넣기/);
  assert.equal(r.reply, '재시도 답');
});

test('CLI: 실행 전(준비 중)에 받은 끼워 넣기는 첫 실행에 바로 싣는다 — 전체를 한 번 더 돌지 않는다(총괄 검수 L1)', async () => {
  const ws = 'steer-cli-5'; await setup(ws); calls.length = 0;
  onCall = async () => '한 번에 답';
  const turn = chat(ws, 'alpha', '원래 지시', null, { journal: { off: true } });
  assert.equal(await steerTurn(ws, 'alpha', { text: '준비 중 끼워 넣기' }), true);
  const r = await turn;
  assert.equal(calls.length, 1);
  assert.match(calls[0].prompt, /원래 지시[\s\S]*## 사장이 이어서 보낸 메시지\n준비 중 끼워 넣기/);
  assert.equal(r.reply, '한 번에 답');
});

test('CLI: 첫 답의 argo 블록은 이어 실행 전에 한 번만 실행되고, 이어 실행에는 결과가 사실로 넘어간다(총괄 검수 M-3)', async () => {
  const ws = 'steer-cli-6'; await setup(ws); calls.length = 0;
  const block = (prompt) => '```argo\n' + JSON.stringify({ action: 'schedule', every: '30m', title: prompt, prompt }) + '\n```';
  onCall = async (n) => {
    if (n === 1) { assert.equal(await steerTurn(ws, 'alpha', { text: '하나 더 예약해' }), true); return `예약합니다.\n${block('첫 예약')}`; }
    return `추가로 예약합니다.\n${block('둘째 예약')}`;
  };
  const r = await chat(ws, 'alpha', '예약 부탁', null, { journal: { off: true } });
  assert.equal(calls.length, 2);
  assert.doesNotMatch(calls[1].prompt, /```argo/, '이미 실행한 블록 원문을 다시 넘기지 않는다');
  assert.match(calls[1].prompt, /✓ 루틴 등록됨/, '실행 결과를 사실로 넘긴다');
  const { loadRoutines } = await import('../src/routines.mjs');
  const titles = (await loadRoutines(ws)).map((x) => x.prompt).sort();
  assert.deepEqual(titles, ['둘째 예약', '첫 예약'], '각 블록이 정확히 한 번씩 — 합친 답을 다시 파싱해 첫 예약이 두 번 생기면 안 된다');
  assert.doesNotMatch(r.reply, /```argo/);
});

test('CLI: 이어 실행이 실패해도 이미 끝난 첫 답은 남고, 첫 실행을 다시 돌리지 않는다 — 실패는 끼워 넣은 쪽에만(총괄 검수 M-1)', async () => {
  const ws = 'steer-cli-4'; await setup(ws); calls.length = 0;
  onCall = async (n) => {
    if (n === 1) { assert.equal(await steerTurn(ws, 'alpha', { text: '이어서 할 일' }), true); return '첫 답(명령 실행 완료)'; }
    throw new Error('codex exited with code 139');
  };
  const r = await chat(ws, 'alpha', '원래 지시', null, { journal: { off: true } });
  assert.equal(calls.length, 2, `첫 실행(danger-full-access 명령 포함)을 크래시 재시도로 다시 돌리면 안 된다 — 실행 ${calls.length}회`);
  assert.equal(r.reply, '첫 답(명령 실행 완료)');
  assert.match(String(r.steerFailed?.reason ?? ''), /139/, '끼워 넣은 쪽 실패 사유');
  assert.deepEqual(r.steerFailed?.texts, ['이어서 할 일']);
});

test('CLI: 끼워 넣기가 없으면 실행은 한 번(기존 동작 그대로)', async () => {
  const ws = 'steer-cli-2'; await setup(ws); calls.length = 0;
  onCall = async () => '답';
  const r = await chat(ws, 'alpha', '지시', null, { journal: { off: true } });
  assert.equal(calls.length, 1);
  assert.equal(r.reply, '답');
});
