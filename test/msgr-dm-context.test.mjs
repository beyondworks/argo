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
globalThis.__dmContextRunner = () => runner;
globalThis.__dmContextCapture = (args) => { captured = args; return 'Fixture answer'; };
const wrappers = new Map();
for (const [relative, replacements] of [
  ['./runners.mjs', `export const resolveRunner = async () => ({runner:globalThis.__dmContextRunner(),available:true,fellBack:false});
    export const runnerCredType = async () => 'host'; export const runnerCredEnv = async () => ({});
    export const sdkEnvFor = async () => ({}); export const isBilledRunner = async () => false;
    export const externalExec = (args) => globalThis.__dmContextCapture(args);`],
  ['./connectors.mjs', 'export const connectorBriefing = async () => [];'],
]) {
  const real = new URL(`../src/${relative.slice(2)}`, import.meta.url).href;
  wrappers.set(relative, `data:text/javascript,${encodeURIComponent(`export * from ${JSON.stringify(real)}; ${replacements}`)}`);
}
const sdk = import.meta.resolve('@anthropic-ai/claude-agent-sdk');
wrappers.set('@anthropic-ai/claude-agent-sdk', `data:text/javascript,${encodeURIComponent(`export * from ${JSON.stringify(sdk)};
  export function query(args) { const iterator = (async function* () {
    globalThis.__dmContextCapture(args);
    yield {type:'system',subtype:'init',session_id:'private-provider-session',mcp_servers:[]};
    yield {type:'assistant',message:{content:[{type:'text',text:'Fixture answer'}]}};
    yield {type:'result',subtype:'success',session_id:'private-provider-session',result:'Fixture answer',usage:{input_tokens:1,output_tokens:1},total_cost_usd:0};
  })(); iterator.interrupt = async () => {}; return iterator; }`)}`);
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.endsWith('/src/chat.mjs') && wrappers.has(specifier)) return {url:wrappers.get(specifier),shortCircuit:true};
  return next(specifier, context);
} });
after(() => { hooks.deregister(); globalThis.fetch = fetchBefore; delete globalThis.__dmContextRunner; delete globalThis.__dmContextCapture; });
const { createCompany, paths } = await import('../src/workspace.mjs');
const { appendTurn, beginTurn, appendSharedNote, loadThread } = await import('../src/thread.mjs');
const { chat } = await import('../src/chat.mjs');
let sequence = 0;
const scope = {kind:'msgr-dm',channelId:'private-dm-a',threadRoot:42};
async function setup() {
  const ws = `dm-context-${++sequence}`;
  await createCompany(ws, 'Context fixture', 'owner');
  await mkdir(paths(ws).agents, {recursive:true});
  await writeFile(join(paths(ws).agents, 'alpha.md'), `---\nname: Alpha\nrunner: ${runner}\n---\nFixture agent`);
  await appendTurn(ws, 'alpha', {userMsg:'PUBLIC_HISTORY_INPUT',reply:'PUBLIC_HISTORY_REPLY',sessionId:'public-session'});
  await appendTurn(ws, 'alpha', {userMsg:'PRIVATE_DM_INPUT',reply:'PRIVATE_DM_REPLY',sessionId:'private-session',contextScope:scope});
  await appendSharedNote(ws, 'alpha', 'UNRELATED_CC_NOTE');
  return ws;
}
test('DM audit keeps both sides with scope and preserves the normal provider session', async () => {
  const ws = await setup();
  const t = await loadThread(ws,'alpha');
  assert.equal(t.sessionId, 'public-session');
  assert.deepEqual(t.messages.filter(m=>m.text.startsWith('PRIVATE_DM')).map(m=>m.contextScope),[scope,scope]);
  const turnId = await beginTurn(ws,'alpha',{userMsg:'PRIVATE_PENDING',contextScope:scope});
  await appendTurn(ws,'alpha',{turnId,reply:'PRIVATE_COMPLETED',sessionId:'another-private'});
  const ended = await loadThread(ws,'alpha');
  assert.equal(ended.sessionId,'public-session');
  assert.deepEqual(ended.messages.slice(-2).map(m=>m.contextScope),[scope,scope]);
});
for (const selected of ['codex','claude']) {
  for (const freshRetry of [false,true]) {
    test(`${selected} DM ${freshRetry?'fresh retry':'first turn'} only injects the authorized envelope`, async () => {
      runner=selected;
      const ws = await setup();
      const result = await chat(ws,'alpha','AUTHORIZED_DM_ENVELOPE','public-session',{source:'messenger',mirrorCtx:{kind:'msgr',channelKind:'dm',channelId:scope.channelId,threadRoot:scope.threadRoot,peers:[]},journal:{off:false},__freshRetry:freshRetry,__seedNotes:['RETRY_FOREIGN_NOTE']});
      assert.match(captured.prompt,/AUTHORIZED_DM_ENVELOPE/);
      assert.doesNotMatch(captured.prompt,/PUBLIC_HISTORY|PRIVATE_DM_|UNRELATED_CC|RETRY_FOREIGN/);
      assert.equal(captured.options?.resume,undefined);
      assert.equal(result.handover,null,'DM text cannot be automatically promoted into shared journals');
      assert.equal(result.sessionId,null,'DM provider session cannot be reused by an unscoped caller');
      assert.deepEqual(result.contextScope,scope);
      assert.equal((await loadThread(ws,'alpha')).messages.find(m=>m.shared).pending,true,'DM must not consume another channel cc note');
    });
  }
  test(`${selected} regular context still includes normal history and cc but excludes DM audit`, async () => {
    runner=selected; const ws = await setup();
    await beginTurn(ws,'alpha',{userMsg:'PENDING_NOT_HISTORY'});
    await chat(ws,'alpha','PUBLIC_NEW_MESSAGE',null,{journal:{off:true},__freshRetry:selected==='claude'});
    assert.match(captured.prompt,/PUBLIC_HISTORY_INPUT/);
    assert.match(captured.prompt,/PUBLIC_HISTORY_REPLY/);
    assert.match(captured.prompt,/UNRELATED_CC_NOTE/);
    assert.doesNotMatch(captured.prompt,/PRIVATE_DM_INPUT|PRIVATE_DM_REPLY|PENDING_NOT_HISTORY/);
    assert.equal((await loadThread(ws,'alpha')).messages.find(m=>m.shared).pending,undefined);
  });
}


test('ordinary SDK resume still uses its own session', async () => {
  runner='claude'; const ws=await setup();
  const result=await chat(ws,'alpha','NORMAL_RESUME','public-session',{journal:{off:true}});
  assert.equal(captured.options.resume,'public-session');
  assert.equal(result.sessionId,'private-provider-session');
  assert.equal(result.contextScope,undefined);
});

test('remote DM colleagues are advertised and SDK tools resolve exact IDs without local mail', async () => {
  runner='claude'; const ws=await setup();
  const peers=[{id:'self',slug:'alpha',display_name:'Alpha'},{id:'remote-one',slug:'duplicate',display_name:'Remote one',owner_user_id:'other-owner',ws_id:'remote-workspace'},{id:'remote-two',slug:'duplicate',display_name:'Remote two'},{id:'copy-id',slug:'copy',display_name:'Copy'}];
  const ctx={kind:'msgr',channelKind:'dm',channelId:scope.channelId,threadRoot:42,crewId:'self',uid:'owner',wsId:ws,peers,handoffs:[]};
  await chat(ws,'alpha','AUTHORIZED_REMOTE_REQUEST',null,{journal:{off:true},mirrorCtx:ctx});
  assert.match(captured.options.systemPrompt,/remote-one/);
  assert.match(captured.options.systemPrompt,/remote-two/);
  const { makeCrewServer } = await import('../src/chat.mjs');
  const tools=[];
  makeCrewServer(ws,'alpha','Alpha',[],0,[],ctx,'en',[],'',tools);
  const send=tools.find(t=>t.name==='send_to_crew');
  const delegate=tools.find(t=>t.name==='delegate');
  assert.ok(send); assert.ok(delegate,'remote-only roster exposes both tools');
  assert.match((await send.handler({to:'duplicate',message:'ambiguous'})).content[0].text,/실패/);
  assert.deepEqual(ctx.handoffs,[],'ambiguous slug cannot select another owner accidentally');
  assert.match((await send.handler({to:'remote-one',cc:['not-authorized'],message:'reject missing cc'})).content[0].text,/실패/);
  assert.deepEqual(ctx.handoffs,[],'unauthorized cc must not silently disappear');
  await send.handler({to:'remote-one',cc:['copy-id'],message:'remote action'});
  await delegate.handler({to:'remote-two',task:'another remote action'});
  assert.deepEqual(ctx.handoffs.map(h=>[h.to.id,h.cc.map(p=>p.id)]),[['remote-one',['copy-id']],['remote-two',[]]]);
  const { readdir } = await import('node:fs/promises');
  assert.deepEqual(await readdir(join(paths(ws).root,'mail')).catch(()=>[]),[],'no local or Telegram mail queue is used');
});


test('two DM envelopes cannot promote a journal or bleed into a following public CLI turn', async () => {
  runner='codex'; const ws=await setup();
  for (const [channelId,threadRoot,body] of [['dm-a',21,'DM_A_SENSITIVE'],['dm-b',22,'DM_B_SENSITIVE']]) {
    const turn=await chat(ws,'alpha',body,null,{mirrorCtx:{kind:'msgr',channelKind:'dm',channelId,threadRoot,peers:[]},journal:{off:false,tag:'org-test'}});
    assert.equal(turn.handover,null);
    assert.doesNotMatch(captured.prompt,body==='DM_A_SENSITIVE'?/DM_B_SENSITIVE/:/DM_A_SENSITIVE/);
    await appendTurn(ws,'alpha',{userMsg:body,...turn});
  }
  await chat(ws,'alpha','NORMAL_AFTER_TWO_DMS',null,{journal:{off:false}});
  assert.doesNotMatch(captured.prompt,/DM_A_SENSITIVE|DM_B_SENSITIVE/);
  assert.match(captured.prompt,/PUBLIC_HISTORY_REPLY/);
  const { readdir, readFile }=await import('node:fs/promises');
  const files=await readdir(paths(ws).journal);
  assert.equal(files.length,1,'normal turns still generate their normal journal');
  const journal=await readFile(join(paths(ws).journal,files[0]),'utf8');
  assert.match(journal,/NORMAL_AFTER_TWO_DMS/);
  assert.doesNotMatch(journal,/DM_A_SENSITIVE|DM_B_SENSITIVE/);
});
