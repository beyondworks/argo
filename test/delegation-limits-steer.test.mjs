// 위임 제한 스위치 — CLI 끼워 넣기(steer) 구간의 쪽지 지시 블록과 마지막 블록 처리가 **같은 턴 카운터**를 쓴다(검수 2026-10-01 MEDIUM-4).
// 구간마다 카운터가 새로 생기면 블록 6개씩 두 구간이 12건이 된다. 가짜 externalExec는 chat-steer-cli.test.mjs와 같은 로더 훅 기법.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from './helpers/tmp.mjs';

process.env.HOME = process.env.USERPROFILE = await mkdtemp(join(tmpdir(), 'argo-deleg-steer-home-'));
process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-deleg-steer-'));
process.env.ARGO_CACHE_DIR = join(process.env.ARGO_ROOT, 'cache');
process.env.ARGO_MODEL_CATALOG = process.env.ARGO_NATIVE_RUNNERS = 'off';
const fetchBefore = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('Network disabled in deleg steer test'); };
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

const { newTree } = await import('../src/delegation-limits.mjs');
const { listMail } = await import('../src/crewmail.mjs');

async function setup(ws) {
  await createCompany(ws, 'Deleg steer fixture', 'owner');
  await mkdir(paths(ws).agents, { recursive: true });
  await writeFile(join(paths(ws).agents, 'alpha.md'), '---\nname: Alpha\nrunner: codex\n---\nFixture agent');
  await writeFile(join(paths(ws).agents, 'beta.md'), '---\nname: Beta\nrunner: codex\n---\nFixture agent');
}
const blocks = (n, tag) => Array.from({ length: n }, (_, i) => '```argo\n' + JSON.stringify({ action: 'mail', to: 'beta', message: `${tag} ${i}` }) + '\n```').join('\n');

test('CLI 끼워 넣기 — 구간마다 블록 6개씩이어도 한 턴 합계가 상한을 넘지 않는다(켜짐 2건, 풀림 10건)', async () => {
  for (const [ws, opts, expected] of [['deleg-steer-on', {}, 2], ['deleg-steer-off', { delegationRelaxed: true }, 10]]) {
    await setup(ws); calls.length = 0;
    onCall = async (n) => {
      if (n === 1) { assert.equal(await steerTurn(ws, 'alpha', { text: '이어서 더 보내' }), true); return `1구간\n${blocks(6, 'a')}`; }
      return `2구간\n${blocks(6, 'b')}`;
    };
    await chat(ws, 'alpha', '쪽지 많이 보내', null, { journal: { off: true }, ...opts });
    assert.equal(calls.length, 2, '끼워 넣기로 이어 실행');
    assert.equal((await listMail(ws)).pending.length, expected, `${ws}: 두 구간 합쳐 ${expected}건`);
  }
});
