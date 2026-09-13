import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from './helpers/tmp.mjs';

process.env.HOME = process.env.USERPROFILE = await mkdtemp(join(tmpdir(), 'argo-dm-context-home-'));
process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-dm-context-'));
process.env.ARGO_CACHE_DIR = join(process.env.ARGO_ROOT, 'cache');
process.env.ARGO_MODEL_CATALOG = process.env.ARGO_NATIVE_RUNNERS = 'off';
const fetchBefore = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('Network disabled in DM context test'); };
let runner = 'codex';
let captured;
let execute = async () => 'Fixture answer';
let prepare = async () => {};
let sdkInterrupted = () => {};
globalThis.__stopPrepare = () => prepare();
globalThis.__stopSdkInterrupt = () => sdkInterrupted();
globalThis.__dmContextRunner = () => runner;
globalThis.__dmContextCapture = (args) => { captured = args; return execute(args); };
const wrappers = new Map();
for (const [relative, replacements] of [
  ['./runners.mjs', `export const resolveRunner = async () => { await globalThis.__stopPrepare(); return {runner:globalThis.__dmContextRunner(),available:true,fellBack:false}; };
    export const runnerCredType = async () => 'host'; export const runnerCredEnv = async () => ({});
    export const sdkEnvFor = async () => ({}); export const isBilledRunner = async () => false;
    export const externalExec = async (args) => await globalThis.__dmContextCapture(args);`],
  ['./connectors.mjs', 'export const connectorBriefing = async () => [];'],
]) {
  const real = new URL(`../src/${relative.slice(2)}`, import.meta.url).href;
  wrappers.set(relative, `data:text/javascript,${encodeURIComponent(`export * from ${JSON.stringify(real)}; ${replacements}`)}`);
}
const sdk = import.meta.resolve('@anthropic-ai/claude-agent-sdk');
wrappers.set('@anthropic-ai/claude-agent-sdk', `data:text/javascript,${encodeURIComponent(`export * from ${JSON.stringify(sdk)};
  export function query(args) { const iterator = (async function* () {
    await globalThis.__dmContextCapture(args);
    yield {type:'system',subtype:'init',session_id:'private-provider-session',mcp_servers:[]};
    yield {type:'assistant',message:{content:[{type:'text',text:'Fixture answer'}]}};
    yield {type:'result',subtype:'success',session_id:'private-provider-session',result:'Fixture answer',usage:{input_tokens:1,output_tokens:1},total_cost_usd:0};
  })(); iterator.interrupt = async () => globalThis.__stopSdkInterrupt(); return iterator; }`)}`);
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.endsWith('/src/chat.mjs') && wrappers.has(specifier)) return {url:wrappers.get(specifier),shortCircuit:true};
  return next(specifier, context);
} });
after(() => { hooks.deregister(); globalThis.fetch = fetchBefore; delete globalThis.__dmContextRunner; delete globalThis.__dmContextCapture; });
const { createCompany, paths } = await import('../src/workspace.mjs');
const { appendTurn, beginTurn, appendSharedNote, loadThread } = await import('../src/thread.mjs');
const { chat } = await import('../src/chat.mjs');

const { interruptTurn } = await import('../src/turn-abort.mjs');
const { spawn } = await import('node:child_process');
let sequence = 0;
async function setup() {
  const ws = `stop-runtime-${++sequence}`;
  await createCompany(ws, 'Stop fixture', 'owner');
  await mkdir(paths(ws).agents, {recursive:true});
  await writeFile(join(paths(ws).agents, 'alpha.md'), `---\nname: Alpha\nrunner: ${runner}\n---\nFixture agent`);
  return ws;
}
const deferred = () => { let resolve; const promise = new Promise(r => {resolve=r;}); return {promise,resolve}; };
for (const selected of ['codex', 'claude']) {
  test(`${selected}: interrupt normal-success completion is aborted, no continuation or successful result`, async () => {
    runner = selected; const ws = await setup(); const started = deferred(), end = deferred(); let calls = 0;
    execute = async ({signal}) => { calls++; signal?.addEventListener('abort', end.resolve, {once:true}); started.resolve(); await end.promise; return 'stopped'; };
    sdkInterrupted = end.resolve;
    const work = chat(ws,'alpha','controlled work',null,{journal:{off:true}});
    const rejected = assert.rejects(work, e => e.aborted === true);
    await started.promise;
    assert.equal(await interruptTurn(ws,'alpha'),true);
    await rejected; await new Promise(r=>setTimeout(r,100));
    assert.equal(calls,1);
    assert.equal(await interruptTurn(ws,'alpha'),false);
    execute = async () => { calls++; return 'new instruction'; };
    assert.ok((await chat(ws,'alpha','new explicit work',null,{journal:{off:true}})).reply);
    assert.equal(calls,2,'a new explicit instruction remains possible');
  });
}
test('cancel during setup prevents provider invocation', async () => {
  runner='codex'; const ws = await setup(); const started=deferred(), end=deferred(); let calls=0;
  prepare=async()=>{started.resolve(); await end.promise;}; execute=async()=>{calls++; return 'unexpected';};
  const work=chat(ws,'alpha','setup work',null,{journal:{off:true}});
  const rejected=assert.rejects(work,e=>e.aborted===true);
  await started.promise; assert.equal(await interruptTurn(ws,'alpha'),true); end.resolve(); await rejected;
  assert.equal(calls,0); prepare=async()=>{};
});
test('actual chat preserves uncertain process cleanup in error and event journal',async()=>{
 runner='codex';const ws=await setup();
 execute=async()=>{
  await interruptTurn(ws,'alpha');
  throw Object.assign(new Error('cleanup uncertain'),{aborted:true,cancellationIncomplete:true});
 };
 await assert.rejects(chat(ws,'alpha','fixture work',null,{journal:{off:true}}),e=>e.aborted===true&&e.cancellationIncomplete===true);
 const {readEvents}=await import('../src/events.mjs');
 assert.ok((await readEvents(ws)).some(e=>e.aborted&&e.cancellationIncomplete));
 await appendTurn(ws,'alpha',{userMsg:'fixture work',failed:'중단됨',aborted:true,cancellationIncomplete:true});
 assert.ok((await loadThread(ws,'alpha')).messages.some(m=>m.aborted&&m.cancellationIncomplete));
});
test('controlled real child process is terminated and does not restart after cancel', async () => {
  runner='codex'; const ws=await setup(); const started=deferred(); let calls=0,beats=0;
  execute=({signal})=>new Promise(resolve=>{
    calls++;
    const child=spawn(process.execPath,['-e',"setInterval(()=>process.stdout.write('beat\\n'),25)"],{stdio:['ignore','pipe','ignore']});
    child.stdout.on('data',()=>{beats++;started.resolve();});
    signal.addEventListener('abort',()=>child.kill('SIGTERM'),{once:true});
    child.once('exit',()=>resolve('normal completion after interrupt'));
  });
  const work=chat(ws,'alpha','controlled child work',null,{journal:{off:true}});
  const rejected=assert.rejects(work,e=>e.aborted===true);
  await started.promise; await interruptTurn(ws,'alpha'); await rejected;
  const atStop=beats; await new Promise(r=>setTimeout(r,2200));
  assert.equal(beats,atStop);assert.equal(calls,1);
});
