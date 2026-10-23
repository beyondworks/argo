// 메신저 v2 링크 범위 턴의 활동 기록(events.jsonl — 개인 클라우드로 동기화) — CLI 경로·러너 실행 전 실패·예산 차단(검수 2026-10-23).
// 하네스는 agent-link-org-memory.test.mjs와 같다(실제 chat() + 가짜 외부 CLI 러너, 실 Supabase·모델·네트워크 0). SDK 경로는 link-turn-events-sdk.test.mjs.
// 핀(고치기 전에도 통과): 로컬·개인 공간 링크 턴은 gist·msg를 종전대로. 고치는 것: 팀·모름 링크 턴은 gist 고정 라벨, msg 없음.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { mkdir, writeFile, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from './helpers/tmp.mjs';

process.env.HOME = process.env.USERPROFILE = await mkdtemp(join(tmpdir(), 'argo-linkev-cli-home-'));
process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-linkev-cli-'));
process.env.ARGO_CACHE_DIR = join(process.env.ARGO_ROOT, 'cache');
process.env.ARGO_MODEL_CATALOG = process.env.ARGO_NATIVE_RUNNERS = 'off';
process.env.ARGO_ENC_VAULT = '0';
for (const key of ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'ARGO_TENANT_OWNER']) delete process.env[key];
const fetchBefore = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('Network disabled in link-events test'); };

// 가짜 러너(codex CLI 모양) — 받은 글을 모으고 짧게 답한다
const seen = [];
globalThis.__omCli = (args) => { seen.push(args.prompt); if (String(args.prompt).includes('[FAIL]')) throw new Error('fixture cli failure'); return '정리했습니다'; };
const wrappers = new Map();
for (const [relative, replacements] of [
  ['./runners.mjs', `export const resolveRunner = async () => ({runner:'codex',available:true,fellBack:false});
    export const runnerCredType = async () => 'host'; export const runnerCredEnv = async () => ({});
    export const sdkEnvFor = async () => ({}); export const isBilledRunner = async () => false;
    export const externalExec = async (args) => globalThis.__omCli(args);`],
  ['./connectors.mjs', 'export const connectorBriefing = async () => [];'],
  ['./oneshot.mjs', "export const runOneShot = async () => Promise.reject(new Error('one-shot off'));"],
]) {
  const real = new URL(`../src/${relative.slice(2)}`, import.meta.url).href;
  wrappers.set(relative, `data:text/javascript,${encodeURIComponent(`export * from ${JSON.stringify(real)}; ${replacements}`)}`);
}
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.endsWith('/src/chat.mjs') && wrappers.has(specifier)) return { url: wrappers.get(specifier), shortCircuit: true };
  return next(specifier, context);
} });
after(() => { hooks.deregister(); globalThis.fetch = fetchBefore; delete globalThis.__omCli; });

const { createCompany, paths } = await import('../src/workspace.mjs');
const { chat } = await import('../src/chat.mjs');
const { readEvents } = await import('../src/events.mjs');

const OWNER = '11111111-1111-4111-8111-111111111111';
const SPACE = 'aaaaaaaa-0000-4000-8000-000000000001';
const ROOM = 'dddddddd-0000-4000-8000-000000000001';
const WORK = 'eeeeeeee-0000-4000-8000-000000000001';
let seq = 0;
async function company() {
  const ws = `linkev-cli-${++seq}`;
  await createCompany(ws, '린', '유건', OWNER, 'ko');
  await mkdir(paths(ws).agents, { recursive: true });
  await writeFile(join(paths(ws).agents, 'seoyun.md'), '---\nname: 서윤\nrole: 비서\n---\n# 서윤\n');
  return ws;
}
const link = (extra = {}) => ({ kind: 'scope', scope: { kind: 'link', work: WORK, room: ROOM, owner: true, ...extra } });
const TEAM = link({ space: SPACE, spaceKind: 'team' });
const PERSONAL = link({ space: SPACE, spaceKind: 'personal' });
const turnRows = async (ws) => (await readEvents(ws, 50)).filter((e) => e.type === 'turn');
const raw = async (ws) => JSON.stringify(await readEvents(ws, 50));
const turn = (ws, text, opts = {}, slug = 'seoyun') => chat(ws, slug, text, null, { source: 'messenger', ...opts });
/** 이번 달 지출이 한도를 넘은 회사 — 예산 차단 갈래(모델을 부르지 않는다) */
async function overBudget(ws) {
  const c = JSON.parse(await readFile(paths(ws).company, 'utf8'));
  await writeFile(paths(ws).company, JSON.stringify({ ...c, budgetUsd: 1 }));
  await writeFile(paths(ws).usage, `${JSON.stringify({ ts: new Date().toISOString(), kind: 'chat', slug: 'seoyun', input: 1, output: 1, cacheRead: 0, cacheCreate: 0, costUsd: 5, billed: true })}\n`);
}

test('핀: 로컬·개인 공간 CLI 턴은 gist를 종전대로(CLI 행에는 원래 msg가 없다)', async () => {
  const ws = await company();
  await chat(ws, 'seoyun', 'LOCAL_CLI 정리해 줘', null, {});
  await turn(ws, 'PERSONAL_CLI 정리', { mirrorCtx: PERSONAL });
  const [p, l] = await turnRows(ws);
  assert.match(l.gist, /LOCAL_CLI/);
  assert.match(p.gist, /PERSONAL_CLI/);
  assert.equal(p.ok, true);
});

test('팀·모름 링크 CLI 턴 — 성공·실패 행 모두 고정 라벨', async () => {
  const ws = await company();
  await turn(ws, 'TEAM_CLI_SECRET 회의록', { mirrorCtx: TEAM });
  await turn(ws, 'UNKNOWN_CLI_SECRET 회의록', { mirrorCtx: link() });
  await assert.rejects(turn(ws, '[FAIL] TEAM_CLI_FAIL_SECRET', { mirrorCtx: TEAM }));
  const [fail, unknown, team] = await turnRows(ws);
  assert.equal(team.gist, '조직 방 지시 (dddddddd)'); assert.equal(team.ok, true);
  assert.equal(unknown.gist, '메신저 방 지시 (dddddddd)');
  assert.equal(fail.ok, false); assert.equal(fail.gist, '조직 방 지시 (dddddddd)');
  for (const e of [team, unknown, fail]) assert.equal('msg' in e, false);
  assert.doesNotMatch(await raw(ws), /_SECRET/);
});

test('러너 실행 전 실패(카드 없음) — 팀 방은 라벨·msg 없음, 로컬은 종전대로 gist·msg', async () => {
  const ws = await company();
  await assert.rejects(turn(ws, 'TEAM_PRE_SECRET', { mirrorCtx: TEAM }, 'nobody'));
  await assert.rejects(chat(ws, 'nobody', 'LOCAL_PRE 지시', null, {}));
  const [local, team] = await turnRows(ws);
  assert.equal(team.preRun, true); assert.equal(team.gist, '조직 방 지시 (dddddddd)'); assert.equal('msg' in team, false);
  assert.equal(local.preRun, true); assert.match(local.gist, /LOCAL_PRE/); assert.match(local.msg, /LOCAL_PRE/, '핀: 로컬은 msg를 남긴다');
  assert.doesNotMatch(await raw(ws), /TEAM_PRE_SECRET/);
});

test('예산 차단 — 팀 방은 라벨, 로컬은 종전대로 gist', async () => {
  const ws = await company();
  await overBudget(ws);
  const r = await turn(ws, 'TEAM_BUDGET_SECRET', { mirrorCtx: TEAM });
  assert.match(r.reply, /지출 한도/, '전제: 예산 차단 갈래');
  await chat(ws, 'seoyun', 'LOCAL_BUDGET 지시', null, {});
  const [local, team] = await turnRows(ws);
  assert.equal(team.budgetBlocked, true); assert.equal(team.gist, '조직 방 지시 (dddddddd)');
  assert.equal(local.budgetBlocked, true); assert.match(local.gist, /LOCAL_BUDGET/);
  assert.doesNotMatch(await raw(ws), /TEAM_BUDGET_SECRET/);
});
