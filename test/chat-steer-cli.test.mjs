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
  onCall = async (n, args) => {
    if (n === 1) { assert.equal(await steerTurn(ws, 'alpha', { text: '크래시 전 끼워 넣기' }), true); throw new Error('codex exited with code 139'); }
    if (n === 2) return '재시도 첫 답';
    return `이어진 답: ${args.prompt.includes('크래시 전 끼워 넣기') ? '받음' : '못 받음'}`;
  };
  const r = await chat(ws, 'alpha', '원래 지시', null, { journal: { off: true } });
  assert.equal(calls.length, 3, '크래시 → 재시도 본 실행 → 끼워 넣기 이어 실행');
  assert.equal(r.reply, '재시도 첫 답\n\n이어진 답: 받음');
});

test('CLI: 끼워 넣기가 없으면 실행은 한 번(기존 동작 그대로)', async () => {
  const ws = 'steer-cli-2'; await setup(ws); calls.length = 0;
  onCall = async () => '답';
  const r = await chat(ws, 'alpha', '지시', null, { journal: { off: true } });
  assert.equal(calls.length, 1);
  assert.equal(r.reply, '답');
});
