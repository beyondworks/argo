// Real chat, permission gate, MCP transport and native loop; only vendor turns are stubbed.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from './helpers/tmp.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { parse as parseToml } from 'smol-toml';

const root = await mkdtemp(join(tmpdir(), 'argo-browser-chat-'));
const fixtureHome = join(root, 'home');
await mkdir(fixtureHome, {recursive:true});
process.env.HOME = fixtureHome;
process.env.USERPROFILE = fixtureHome;
process.env.ARGO_ROOT = join(root, 'workspaces');
process.env.ARGO_CACHE_DIR = join(root, 'cache');
process.env.ARGO_MODEL_CATALOG = 'off';
process.env.ARGO_NATIVE_RUNNERS = 'off';
process.env.ARGO_BROWSER_HEADLESS = '1';
process.env.ARGO_BROWSER_PROVIDER = 'chromium';
for (const key of ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']) process.env[key] = '';
const actualFetch = globalThis.fetch;
globalThis.fetch = (url, options) => {
  if (new URL(String(url)).hostname !== '127.0.0.1') throw new Error('External network disabled in browser integration test');
  return actualFetch(url, options);
};
let runner = 'codex'; let vendorTurn;
globalThis.__browserQaRunner = () => runner;
globalThis.__browserQaTurn = (...args) => vendorTurn(...args);
const wrappers = new Map();
for (const [specifier, replacements] of [
  ['./runners.mjs', `export const resolveRunner = async () => ({runner: globalThis.__browserQaRunner(), available:true, fellBack:false});
    export const runnerCredType = async () => 'host'; export const runnerCredEnv = async () => ({});
    export const sdkEnvFor = async () => ({}); export const isBilledRunner = async () => false;
    export const externalExec = (opts) => globalThis.__browserQaTurn(opts);`],
  ['./connectors.mjs', 'export const connectorBriefing = async () => [];'],
  ['./runners/catalog-remote.mjs', 'export const loadRemoteCatalog = async () => null;'],
]) {
  const real = new URL(`../src/${specifier.slice(2)}`, import.meta.url).href;
  wrappers.set(specifier, `data:text/javascript,${encodeURIComponent(`export * from ${JSON.stringify(real)}; ${replacements}`)}`);
}
const sdk = import.meta.resolve('@anthropic-ai/claude-agent-sdk');
wrappers.set('@anthropic-ai/claude-agent-sdk', `data:text/javascript,${encodeURIComponent(`export * from ${JSON.stringify(sdk)};
  export function query(opts) { const iterator = (async function* () {
    await globalThis.__browserQaTurn(opts.options);
    yield {type:'assistant', message:{content:[{type:'text',text:'fixture finished'}]}};
    yield {type:'result', subtype:'success', session_id:'fixture-sdk', result:'fixture finished', usage:{input_tokens:1,output_tokens:1},total_cost_usd:0};
  })(); iterator.interrupt = async () => {}; return iterator; }`)}`);
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.endsWith('/src/chat.mjs') && wrappers.has(specifier)) return {url:wrappers.get(specifier),shortCircuit:true};
  return next(specifier, context);
} });
const { chat } = await import('../src/chat.mjs');
const { createCompany, paths } = await import('../src/workspace.mjs');
const { closeAllBrowsers, findChrome, _sessionsForTest, BrowserSession } = await import('../src/engine/browser-tools.mjs');
const { nativeQuery } = await import('../src/engine/native-query.mjs');
const { writeCodexTurnConfig } = await import('../src/runners/codex.mjs');
const { geminiMcpServers } = await import('../src/runners/gemini.mjs');
after(async () => { hooks.deregister(); globalThis.fetch = actualFetch; delete globalThis.__browserQaRunner; delete globalThis.__browserQaTurn; await closeAllBrowsers(); });
let sequence = 0;
async function setup() {
  const ws = `browser-qa-${++sequence}`;
  await createCompany(ws, 'Browser QA', 'owner'); await mkdir(paths(ws).agents, {recursive:true});
  await writeFile(join(paths(ws).agents, 'alpha.md'), `---\nname: Alpha\nrunner: ${runner}\n---\nQA fixture`);
  return ws;
}
for (const selected of ['codex', 'gemini', 'claude']) {
  for (const failure of [false, true]) {
    test(`${selected} actual chat injects scoped MCP and closes relay on ${failure ? 'vendor failure' : 'success'}`, async () => {
      runner = selected; const ws = await setup(); let relay; let calls = 0;
      vendorTurn = async (opts) => {
        calls++;
        const descriptor = opts.mcpServers?.argo_browser;
        assert.ok(descriptor, 'actual chat must inject the descriptor');
        assert.ok(!descriptor.args[0].startsWith(paths(ws).root), 'company working directory cannot supply the browser worker');
        assert.match(opts.systemPrompt ?? opts.prompt, /mcp__argo_browser__browser_status/);
        relay = descriptor.env.ARGO_BROWSER_RELAY_URL;
        if (selected === 'claude') {
          const blocked = await opts.canUseTool('mcp__argo_browser__browser_navigate', {url:'about:blank', path:join(paths(ws).root, 'capabilities.json')});
          assert.equal(blocked.behavior, 'deny', 'SDK outer gate still protects local policy paths');
        }
        const client = new Client({name:'browser-chat-qa',version:'1'});
        let configured = descriptor;
        if (selected === 'codex') {
          const cliHome = join(root, `cli-${ws}`); await mkdir(cliHome,{recursive:true});
          await writeCodexTurnConfig(cliHome,opts.mcpServers);
          configured = parseToml(await readFile(join(cliHome,'config.toml'),'utf8')).mcp_servers.argo_browser;
        } else if (selected === 'gemini') configured = geminiMcpServers(opts.mcpServers).argo_browser;
        assert.deepEqual(configured,descriptor,'actual CLI config conversion retains the scoped capability');
        const transport = new StdioClientTransport({...configured, stderr:'ignore'});
        try {
          await client.connect(transport);
          assert.equal((await client.listTools()).tools.length, 11);
          const status = JSON.parse((await client.callTool({name:'browser_status',arguments:{}})).content[0].text);
          assert.equal(status.agentProfileIsolated,true); assert.equal(status.workTabIsolated,true);
          assert.equal(status.connected,false,'status must not launch the browser');
          const login = await client.callTool({name:'browser_request_login',arguments:{}});
          assert.equal(login.isError,true,'cannot claim a human login tab exists before navigation');
          const policy = await client.callTool({name:'browser_navigate',arguments:{url:'about:blank',path:join(paths(ws).root,'capabilities.json')}});
          assert.equal(policy.isError, true, 'host relay rechecks the real permission gate');
          const local = await client.callTool({name:'browser_navigate',arguments:{url:'file:///etc/passwd'}});
          assert.equal(local.isError, true, 'local file navigation must not escape the browser boundary');
          const unauth = await fetch(relay, {method:'POST',body:'{}'}); assert.equal(unauth.status,403);
        } finally { await client.close(); await transport.close(); }
        if (failure) throw new Error('fixture vendor stopped');
        return 'fixture finished';
      };
      if (failure) await assert.rejects(chat(ws,'alpha','fixture',null,{journal:{off:true}}), /fixture vendor stopped/);
      else assert.equal((await chat(ws,'alpha','fixture',null,{journal:{off:true}})).reply,'fixture finished');
      assert.equal(calls,1); await assert.rejects(fetch(relay), 'turn finally must revoke the capability');
    });
  }
}

test('native loop gives browser the actual company, agent and work run then closes that tab', {skip:!findChrome() && 'Chromium unavailable'}, async () => {
  runner = 'claude'; const ws = await setup(); let calls = 0;
  const profile = BrowserSession.profileDir(ws, process.env, 'alpha');
  const q = nativeQuery({wsId:ws,slug:'alpha',browserRunId:'native-scope-fixture',cwd:paths(ws).root,prompt:'fixture',
    env:{...process.env,ANTHROPIC_API_KEY:'fixture-only',ANTHROPIC_BASE_URL:'http://127.0.0.1:1'},model:'fixture',saveSession:false,
    canUseTool:async (_,input)=>({behavior:'allow',updatedInput:input}),
    fetchImpl:async () => {
      const first = ++calls === 1;
      if (!first) { const session = _sessionsForTest().get(profile); assert.ok(session); assert.ok(session.pages.has('native-scope-fixture')); }
      return new Response(JSON.stringify({id:'fixture',role:'assistant',type:'message',content:first
        ? [{type:'tool_use',id:'b1',name:'browser_navigate',input:{url:'about:blank'}}]
        : [{type:'text',text:'done'}],stop_reason:first?'tool_use':'end_turn',usage:{input_tokens:1,output_tokens:1}}),{headers:{'content-type':'application/json'}});
    }});
  for await (const _ of q) { /* consume the real native tool loop */ }
  assert.equal(calls,2); assert.equal(_sessionsForTest().get(profile)?.pages.has('native-scope-fixture'),false);
});
