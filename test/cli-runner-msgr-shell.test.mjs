// 메신저 문맥 CLI 턴의 고위험 셸(2026-10-26 총괄 감사 축 A) — SDK 러너만 shellGateMsgr로 결재 카드가 떴고, codex·gemini·antigravity는
// 러너 자체 셸이 게이트 밖이라 메신저 지시의 `rm -rf`가 결재 없이 실행될 수 있었다.
// 처방: codex app-server는 판정자에 메신저 목적지를 넘겨 SDK와 같은 카드, 게이트 밖 엔진(codex exec·gemini·antigravity)은 메신저 지시에서 셸을 끈다.
// 데스크톱 턴은 종전 그대로. 가짜 externalExec는 chat-steer-cli.test.mjs와 같은 로더 훅 기법이다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from './helpers/tmp.mjs';

process.env.HOME = process.env.USERPROFILE = await mkdtemp(join(tmpdir(), 'argo-cli-msgr-home-'));
process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-cli-msgr-'));
process.env.ARGO_CACHE_DIR = join(process.env.ARGO_ROOT, 'cache');
process.env.ARGO_MODEL_CATALOG = process.env.ARGO_NATIVE_RUNNERS = 'off';
const fetchBefore = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('Network disabled in cli msgr shell test'); };
const calls = [];
globalThis.__cliMsgrRunner = 'codex';
globalThis.__cliMsgrExec = async (args) => { calls.push(args); return '답'; };
const real = new URL('../src/runners.mjs', import.meta.url).href;
const wrapper = `data:text/javascript,${encodeURIComponent(`export * from ${JSON.stringify(real)};
  export const resolveRunner = async () => ({runner:globalThis.__cliMsgrRunner,available:true,fellBack:false});
  export const runnerCredType = async () => 'host'; export const runnerCredEnv = async () => ({});
  export const isBilledRunner = async () => false;
  export const externalExec = (args) => globalThis.__cliMsgrExec(args);`)}`;
const connectors = `data:text/javascript,${encodeURIComponent(`export * from ${JSON.stringify(new URL('../src/connectors.mjs', import.meta.url).href)}; export const connectorBriefing = async () => [];`)}`;
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.endsWith('/src/chat.mjs') && specifier === './runners.mjs') return { url: wrapper, shortCircuit: true };
  if (context.parentURL?.endsWith('/src/chat.mjs') && specifier === './connectors.mjs') return { url: connectors, shortCircuit: true };
  return next(specifier, context);
} });
after(() => { hooks.deregister(); globalThis.fetch = fetchBefore; delete globalThis.__cliMsgrExec; delete process.env.ARGO_CODEX_ENGINE; });
const { createCompany, paths } = await import('../src/workspace.mjs');
const { chat, cliMsgrShellLimit } = await import('../src/chat.mjs');
const { makeApprovalJudge } = await import('../src/runners/codex-appserver.mjs');
const { loadApprovals } = await import('../src/approvals.mjs');

const MSGR = { orgId: 'org-1', channelId: 'ch-1', crewId: 'crew-1' };
const FULL = Object.freeze({ fs: true, browser: true, shell: true, bypass: true });

// 경우 표 — 러너 × 문맥. 손님 턴은 CLI 경로 앞에서 guestCliRefusal로 거절(변경 없음, 기존 시험)
const CASES = [
  // [이름, runner, gated(app-server), msgr, 기대 caps.shell, 기대 readOnly, 기대 limited]
  ['codex exec · 데스크톱', 'codex', false, null, true, false, false],
  ['codex exec · 메신저 주인', 'codex', false, MSGR, false, true, true],
  ['codex app-server · 데스크톱', 'codex', true, null, true, false, false],
  ['codex app-server · 메신저 주인(결재 카드)', 'codex', true, MSGR, true, false, false],
  ['gemini · 데스크톱', 'gemini', false, null, true, false, false],
  ['gemini · 메신저 주인', 'gemini', false, MSGR, false, false, true],
  ['antigravity · 데스크톱', 'antigravity', false, null, true, false, false],
  ['antigravity · 메신저 주인', 'antigravity', false, MSGR, false, false, true],
  ['gemini · 메신저 문맥 불완전({})', 'gemini', false, {}, false, false, true],
];

test('경우 표 — 게이트 밖 엔진은 메신저 지시에서 셸을 끄고(codex exec는 read-only), 데스크톱·app-server는 그대로', () => {
  for (const [name, runner, gated, msgr, shell, readOnly, limited] of CASES) {
    const r = cliMsgrShellLimit({ runner, gated, msgr, caps: FULL });
    assert.deepEqual([r.caps.shell, r.readOnly, r.limited], [shell, readOnly, limited], name);
    if (!limited) assert.equal(r.caps, FULL, `${name}: 능력 값 그대로(같은 객체)`);
  }
});

async function setup(ws, runner) {
  await createCompany(ws, 'CLI msgr fixture', 'owner');
  await mkdir(paths(ws).agents, { recursive: true });
  await writeFile(join(paths(ws).agents, 'alpha.md'), `---\nname: Alpha\nrunner: ${runner}\n---\nFixture agent`);
}

for (const runner of ['codex', 'gemini', 'antigravity']) {
  test(`chat() ${runner}: 메신저 문맥이면 셸을 끈 능력으로 실행하고 프롬프트도 같은 능력을 안내한다, 데스크톱은 종전 그대로`, async () => {
    delete process.env.ARGO_CODEX_ENGINE;
    const ws = `cli-msgr-${runner}`; await setup(ws, runner); globalThis.__cliMsgrRunner = runner;
    calls.length = 0;
    await chat(ws, 'alpha', 'rm -rf ./old-reports 해 줘', null, { journal: { off: true } });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].caps.shell, true, '데스크톱: 셸 그대로');
    assert.equal(calls[0].readOnly, false, '데스크톱: 읽기 전용 아님');
    assert.equal(calls[0].msgrGate, null);
    assert.match(calls[0].prompt, /오래 걸리는 명령/, '데스크톱 프롬프트: 셸 안내 있음');
    calls.length = 0;
    await chat(ws, 'alpha', 'rm -rf ./old-reports 해 줘', null, { journal: { off: true }, msgrShellGate: MSGR });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].caps.shell, false, '메신저: 셸 꺼짐');
    assert.equal(calls[0].readOnly, runner === 'codex', 'codex exec만 read-only 샌드박스');
    assert.equal(calls[0].msgrGate, null, 'exec 엔진은 판정자가 없다');
    assert.doesNotMatch(calls[0].prompt, /오래 걸리는 명령/, '메신저 프롬프트: 셸 안내 없음(같은 능력 값으로 안내)');
  });
}

test('chat() codex app-server: 메신저 문맥이면 판정자에 메신저 목적지를 넘기고 셸은 끄지 않는다(결재 카드가 막는다)', async () => {
  process.env.ARGO_CODEX_ENGINE = 'appserver';
  const ws = 'cli-msgr-appserver'; await setup(ws, 'codex'); globalThis.__cliMsgrRunner = 'codex';
  calls.length = 0;
  await chat(ws, 'alpha', 'rm -rf ./old-reports 해 줘', null, { journal: { off: true }, msgrShellGate: MSGR });
  assert.equal(calls[0].caps.shell, true);
  assert.equal(calls[0].readOnly, false);
  assert.deepEqual([calls[0].msgrGate?.wsId, calls[0].msgrGate?.slug, calls[0].msgrGate?.msgr], [ws, 'alpha', MSGR]);
  calls.length = 0;
  await chat(ws, 'alpha', '정리해 줘', null, { journal: { off: true } });
  assert.equal(calls[0].msgrGate, null, '데스크톱 턴은 목적지 없음');
  delete process.env.ARGO_CODEX_ENGINE;
});

test('app-server 판정자: 메신저 목적지가 있으면 rm -rf를 거절하고 결재 카드를 만든다, 없으면(데스크톱) 종전처럼 허용', async () => {
  const ws = 'cli-msgr-judge'; await setup(ws, 'codex');
  const root = paths(ws).root;
  const desk = makeApprovalJudge(root);
  assert.equal(await desk('exec', { command: 'rm -rf ./old-reports' }), 'accept', '데스크톱 종전 그대로');
  const msgr = makeApprovalJudge(root, { msgrGate: { wsId: ws, slug: 'alpha', from: null, msgr: MSGR } });
  assert.equal(await msgr('exec', { command: 'ls -la' }), 'accept', '저위험은 그대로');
  assert.equal(await msgr('exec', { command: 'rm -rf ./old-reports' }), 'decline', '고위험은 거절');
  const cards = (await loadApprovals(ws)).filter((a) => a.payload?.shell);
  assert.deepEqual(cards.map((a) => [a.slug, a.payload.shell, a.payload.rule, a.msgr?.channelId]), [['alpha', 'rm -rf ./old-reports', 'recursive-delete', 'ch-1']]);
});
