// 오피스 패널 턴에는 회사 외부 MCP(mcp.json)를 붙이지 않는다(0.1.105, 총괄 정책 결정 2026-10-13 — 패널은 오피스 작업 전용,
// 유건 10/11 '쓰기 기본값: 늘 확인 카드'를 러너와 관계없이 지킨다). 상주 2026-10-13 잡 6393: 패널 턴의 codex 에이전트가 인트라넷 MCP tasks_add를
// 확인 카드 없이 실행했다 — 확인 카드 관문(office-proposals.mjs)은 오피스 도구만 거르고, 외부 MCP는 SDK에선 권한 게이트 mcp 분기(금지 경로만 막음),
// codex·gemini에선 CLI 설정으로 바로 붙어 Argo가 가로채지 못한다. 그래서 도구별 판정이 아니라 서버를 붙이지 않는다.
// 실제 chat()·권한 게이트·MCP 주입 경로를 그대로 돌리고 공급사 턴만 가짜로 둔다(browser-runner-integration.test.mjs와 같은 틀). 라이브 DB·네트워크 0.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from './helpers/tmp.mjs';

const root = await mkdtemp(join(tmpdir(), 'argo-panel-mcp-'));
const fixtureHome = join(root, 'home');
await mkdir(fixtureHome, { recursive: true });
process.env.HOME = fixtureHome;
process.env.USERPROFILE = fixtureHome;
process.env.ARGO_ROOT = join(root, 'workspaces');
process.env.ARGO_CACHE_DIR = join(root, 'cache');
process.env.ARGO_MODEL_CATALOG = 'off';
process.env.ARGO_NATIVE_RUNNERS = 'off';
for (const key of ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']) process.env[key] = '';
const actualFetch = globalThis.fetch;
globalThis.fetch = (url, options) => {
  if (new URL(String(url)).hostname !== '127.0.0.1') throw new Error('External network disabled in panel MCP test');
  return actualFetch(url, options);
};
let runner = 'codex'; let seen = null;
globalThis.__panelMcpRunner = () => runner;
globalThis.__panelMcpTurn = async (opts) => { seen = { servers: Object.keys(opts.mcpServers ?? {}), prompt: String(opts.systemPrompt ?? opts.prompt ?? '') }; return 'fixture finished'; };
const wrappers = new Map();
for (const [specifier, replacements] of [
  ['./runners.mjs', `export const resolveRunner = async () => ({runner: globalThis.__panelMcpRunner(), available:true, fellBack:false});
    export const runnerCredType = async () => 'host'; export const runnerCredEnv = async () => ({});
    export const sdkEnvFor = async () => ({}); export const isBilledRunner = async () => false;
    export const externalExec = (opts) => globalThis.__panelMcpTurn(opts);`],
  ['./connectors.mjs', 'export const connectorBriefing = async () => [];'],
  ['./runners/catalog-remote.mjs', 'export const loadRemoteCatalog = async () => null;'],
]) {
  const real = new URL(`../src/${specifier.slice(2)}`, import.meta.url).href;
  wrappers.set(specifier, `data:text/javascript,${encodeURIComponent(`export * from ${JSON.stringify(real)}; ${replacements}`)}`);
}
const sdk = import.meta.resolve('@anthropic-ai/claude-agent-sdk');
wrappers.set('@anthropic-ai/claude-agent-sdk', `data:text/javascript,${encodeURIComponent(`export * from ${JSON.stringify(sdk)};
  export function query(opts) { const iterator = (async function* () {
    await globalThis.__panelMcpTurn(opts.options);
    yield {type:'assistant', message:{content:[{type:'text',text:'fixture finished'}]}};
    yield {type:'result', subtype:'success', session_id:'fixture-sdk', result:'fixture finished', usage:{input_tokens:1,output_tokens:1},total_cost_usd:0};
  })(); iterator.interrupt = async () => {}; return iterator; }`)}`);
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.endsWith('/src/chat.mjs') && wrappers.has(specifier)) return { url: wrappers.get(specifier), shortCircuit: true };
  return next(specifier, context);
} });
const { chat, delegateRulesCtx } = await import('../src/chat.mjs');
const { createCompany, paths } = await import('../src/workspace.mjs');
const { closeAllBrowsers } = await import('../src/engine/browser-tools.mjs');
after(async () => { hooks.deregister(); globalThis.fetch = actualFetch; delete globalThis.__panelMcpRunner; delete globalThis.__panelMcpTurn; await closeAllBrowsers(); });

let sequence = 0;
async function setup() {
  const ws = `panel-mcp-${++sequence}`;
  await createCompany(ws, 'Panel MCP', 'owner'); await mkdir(paths(ws).agents, { recursive: true });
  await writeFile(join(paths(ws).agents, 'alpha.md'), `---\nname: Alpha\nrunner: ${runner}\n---\nQA fixture`);
  await writeFile(paths(ws).mcp, JSON.stringify({ servers: { 'intranet-shuri': { type: 'http', url: 'http://127.0.0.1:3060/mcp/shuri' } } }));
  return ws;
}
// 메신저 1:1 턴의 맥락(msgr.mjs가 만드는 모양) — 패널 표지만 칸마다 바꾼다
const dm = (extra = {}) => ({ kind: 'msgr', chatType: 'group', uid: 'u1', origin: 'u1', channelKind: 'dm', channelId: 'ch', crewId: 'c', orgId: 'o', handoffs: [], peers: [], ...extra });
async function turn(mirrorCtx) {
  seen = null; const ws = await setup();
  await chat(ws, 'alpha', 'fixture', null, { source: 'messenger', mirrorCtx, journal: { off: true } });
  assert.ok(seen, 'vendor turn ran');
  return seen;
}
const NOTE = /외부 도구.*메신저.*1:1|External tools.*1:1/;

for (const selected of ['codex', 'gemini', 'claude']) {
  test(`${selected}: 일반 메신저 1:1 턴은 지금 그대로 외부 MCP가 붙는다(회귀 0)`, async () => {
    runner = selected;
    const s = await turn(dm());
    assert.ok(s.servers.includes('intranet-shuri'), s.servers.join(','));
    assert.doesNotMatch(s.prompt, NOTE);
  });
  test(`${selected}: 패널 턴(바로 실행 꺼짐)에는 외부 MCP가 붙지 않고 메신저 1:1 안내가 실린다`, async () => {
    runner = selected;
    const s = await turn(dm({ officePanel: true, proposals: [] }));
    assert.ok(!s.servers.includes('intranet-shuri'), s.servers.join(','));
    assert.doesNotMatch(s.prompt, /intranet-shuri/, '없는 도구를 안내하지 않는다');
    assert.match(s.prompt, NOTE);
  });
  test(`${selected}: 패널 사슬 턴(패널에서 시작한 다른 턴)도 붙지 않는다`, async () => {
    runner = selected;
    const s = await turn(dm({ officePanelChain: true }));
    assert.ok(!s.servers.includes('intranet-shuri'), s.servers.join(','));
  });
  test(`${selected}: 패널 턴이라도 바로 실행을 켰으면 지금 그대로 붙는다`, async () => {
    runner = selected;
    const s = await turn(dm({ officePanel: true, officeAuto: true, proposals: [] }));
    assert.ok(s.servers.includes('intranet-shuri'), s.servers.join(','));
  });
}

test('패널 조율자의 동기 위임 — 동료 턴 맥락도 외부 MCP를 막는다(바로 실행 켜짐이면 막지 않는다)', () => {
  const rules = { kind: 'msgr-rules', orgSlug: 'x', channelName: '' };
  assert.equal(delegateRulesCtx(rules, dm({ officePanel: true, officePanelSolo: true, proposals: [] })).panelNoMcp, true);
  assert.equal(delegateRulesCtx(rules, dm({ officePanel: true, officePanelSolo: true, officeAuto: true, proposals: [] })).panelNoMcp, undefined);
  assert.equal(delegateRulesCtx(rules, dm()).panelNoMcp, undefined, '일반 메신저 위임은 그대로');
});

test('codex: 패널 위임 동료 턴(panelNoMcp 맥락)에도 외부 MCP가 붙지 않는다', async () => {
  runner = 'codex';
  const s = await turn({ kind: 'msgr-rules', orgSlug: 'x', channelName: '', panelNoMcp: true });
  assert.ok(!s.servers.includes('intranet-shuri'), s.servers.join(','));
});
