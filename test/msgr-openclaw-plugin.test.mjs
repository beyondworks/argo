import { mkdtemp, readdir, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
// 오픈클로 채널 플러그인의 전송 계층(integrations/openclaw-argo-msgr/src/api.js) — 가짜 fetch로 주소·봉투·롱폴·401 정지를 잠근다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApi, pollLoop, ArgoMsgrError } from '../integrations/openclaw-argo-msgr/src/api.js';

const T = 'argo_bot_' + 'b'.repeat(48);
const fakeFetch = (routes) => { const calls = []; const f = async (url, init) => { calls.push([url, init]); const key = url.split('/').pop().split('?')[0]; const r = routes[key]; const body = typeof r === 'function' ? r(url, init, calls.length) : r; return { status: body.ok ? 200 : (body.error_code ?? 500), json: async () => body }; }; f.calls = calls; return f; };

test('주소는 /bot<token>/<method>, GET 쿼리·POST JSON, {ok,result} 풀기, 오류는 ArgoMsgrError(status)', async () => {
  const f = fakeFetch({ getMe: { ok: true, result: { id: 'b1' } }, getUpdates: { ok: true, result: [] }, sendMessage: { ok: true, result: { message_id: 7 } }, bad: { ok: false, error_code: 403, description: 'nope' } });
  const api = makeApi({ url: 'https://x.supabase.co/functions/v1/msgr-bot/', token: T, fetchImpl: f });
  assert.deepEqual(await api.getMe(), { id: 'b1' });
  assert.equal(f.calls[0][0], `https://x.supabase.co/functions/v1/msgr-bot/bot${T}/getMe`);
  await api.getUpdates(5); assert.match(f.calls[1][0], /getUpdates\?offset=5&limit=1&timeout=20$/);
  assert.equal((await api.sendMessage('c1', '네', 3)).message_id, 7);
  assert.deepEqual(JSON.parse(f.calls[2][1].body), { chat_id: 'c1', text: '네', reply_to_message_id: 3 }); assert.equal(f.calls[2][1].method, 'POST');
  await api.sendMessage('c1', '평문'); assert.equal('reply_to_message_id' in JSON.parse(f.calls[3][1].body), false);
  const f2 = fakeFetch({ getMe: { ok: false, error_code: 401, description: 'Unauthorized' } });
  await assert.rejects(makeApi({ url: 'https://x', token: T, fetchImpl: f2 }).getMe(), (e) => e instanceof ArgoMsgrError && e.status === 401);
});

test('pollLoop: offset=마지막 update_id+1(ack) · 순서대로 onMessage · 401이면 멈춤 · 일반 오류는 백오프 재시도', async () => {
  const seen = []; let n = 0;
  const f = fakeFetch({ getUpdates: (url) => { n++; if (n === 1) return { ok: true, result: [{ update_id: 3, message: { text: 'a' } }, { update_id: 4, message: { text: 'b' } }] }; if (n === 2) { assert.match(url, /offset=5/); return { ok: false, error_code: 500, description: 'boom' }; } return { ok: false, error_code: 401, description: 'Unauthorized' }; } });
  const logs = []; const sleeps = [];
  await pollLoop(makeApi({ url: 'https://x', token: T, fetchImpl: f }), { onMessage: (m) => { seen.push(m.text); }, log: (s) => logs.push(s), sleep: async (ms) => { sleeps.push(ms); } });
  assert.deepEqual(seen, ['a', 'b']); assert.deepEqual(sleeps, [1000]); assert.equal(n, 3);
  assert.match(logs.at(-1), /token rejected/);
});

test('relay parses explicit final disposition, suppresses completion mentions, and binds the response to its claim', async (t) => {
  const outboxDir=await mkdtemp(join(tmpdir(),'argo-protocol-'));
  t.after(()=>rm(outboxDir,{recursive:true,force:true}));
  const {relayReply, parseMessengerDisposition} = await import('../integrations/openclaw-argo-msgr/src/api.js');
  const {parseMessengerDisposition: resident} = await import('../src/gateway/msgr-handoff.mjs');
  const m={execution_attempt:'attempt',peers:[{id:'crew',name:'서윤'},{id:'other',name:'A+B'}]};
  for (const text of ['@서윤 next\nMSGR: handoff','@서윤 thanks\nMSGR: done','6','```\nMSGR: handoff','> MSGR: done','MSGR: done','~~~\nx\n~~~\nMSGR: done']) {
    assert.deepEqual(parseMessengerDisposition(text),resident(text));
  }
  assert.deepEqual(relayReply('@서윤 next\nMSGR: handoff',m),{text:'@서윤 next',execution:{execution_attempt:'attempt',disposition:'handoff',mentions:[{kind:'crew',id:'crew'}]}});
  assert.deepEqual(relayReply('@서윤 thanks\nMSGR: done',m).execution.mentions,[]);
  assert.deepEqual(relayReply('@서윤 next',m).execution.mentions,[]);
  assert.deepEqual(relayReply('@A+B next\nMSGR: handoff',m).execution.mentions,[{kind:'crew',id:'other'}]);
  assert.deepEqual(relayReply('@서윤 next\nMSGR: handoff',{...m,peers:[...m.peers,{id:'duplicate',name:'서윤'}]}).execution.mentions,[]);
  const f=fakeFetch({sendMessage:{ok:true,result:{message_id:99}}});
  const answer=relayReply('@서윤 next\nMSGR: handoff',m);
  await makeApi({url:'https://x',token:T,fetchImpl:f,outboxDir}).sendMessage('channel',answer.text,7,answer.execution);
  assert.deepEqual(JSON.parse(f.calls[0][1].body),{chat_id:'channel',text:'@서윤 next',reply_to_message_id:7,...answer.execution});
});


test('saved OpenClaw final reply is retried after process/transport replacement without another model call', async () => {
  const dir=await mkdtemp(join(tmpdir(),'argo-outbox-'));
  try {
    const first=makeApi({url:'https://outbox.test',token:T,outboxDir:dir,fetchImpl:async()=>{throw new Error('offline');}});
    await assert.rejects(first.sendMessage('chat','finished answer',7,{execution_attempt:'a',disposition:'done',mentions:[]}),/offline/);
    assert.equal((await readdir(dir)).filter(f=>f.endsWith('.json')).length,1);
    const savedFile=join(dir,(await readdir(dir)).find(f=>f.endsWith('.json')));
    assert.equal((await readFile(savedFile,'utf8')).includes(T),false,'bot token is never persisted');
    if(process.platform!=='win32') assert.equal((await stat(savedFile)).mode & 0o777,0o600);
    const otherCalls=[];
    const other=makeApi({url:'https://outbox.test',token:'another-bot',outboxDir:dir,fetchImpl:async(url)=>{otherCalls.push(url);return {status:200,json:async()=>({ok:true,result:[]})}}});
    await other.getUpdates(0);
    assert.equal(otherCalls.length,1); assert.match(otherCalls[0],/getUpdates/,'another bot never drains this final answer');
    assert.equal((await readdir(dir)).filter(f=>f.endsWith('.json')).length,1);

    const calls=[];
    const next=makeApi({url:'https://outbox.test',token:T,outboxDir:dir,fetchImpl:async(url,init)=>{
      calls.push([url,init]);return {status:200,json:async()=>({ok:true,result:url.endsWith('sendMessage')?{message_id:9}:[]})};
    }});
    await next.getUpdates(0);
    assert.equal(JSON.parse(calls[0][1].body).text,'finished answer');
    assert.match(calls[1][0],/getUpdates/);
    assert.deepEqual(await readdir(dir),[]);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('actual OpenClaw inbound handler excludes tool/draft/reasoning and finishes one complete response', async () => {
  const dir=await mkdtemp(join(tmpdir(),'argo-channel-'));
  const previousFetch=globalThis.fetch, previousOutbox=process.env.ARGO_MSGR_OUTBOX_DIR;
  try {
    process.env.ARGO_MSGR_OUTBOX_DIR=dir;
    const file=new URL('../integrations/openclaw-argo-msgr/src/channel.ts',import.meta.url);
    let source=stripTypeScriptTypes(await readFile(file,'utf8'));
    source=source.replace(/import \{[\s\S]*?\} from "openclaw\/plugin-sdk";/, `const {buildBaseAccountStatusSnapshot,buildBaseChannelStatusSummary,createReplyPrefixOptions,DEFAULT_ACCOUNT_ID,deleteAccountFromConfigSection,formatTextWithAttachmentLinks,resolveOutboundMediaUrls,setAccountEnabledInConfigSection}=globalThis.__argoSdkFixture;`);
    source=source.replace('"./api.js"',JSON.stringify(new URL('../integrations/openclaw-argo-msgr/src/api.js',import.meta.url).href));
    source+='\nexport {handleInbound};';
    globalThis.__argoSdkFixture={createReplyPrefixOptions:()=>({}),formatTextWithAttachmentLinks:t=>t,resolveOutboundMediaUrls:()=>[],DEFAULT_ACCOUNT_ID:'default'};
    const channel=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
    const calls=[];
    globalThis.fetch=async(url,init)=>{calls.push(JSON.parse(init.body));return {status:200,json:async()=>({ok:true,result:{message_id:99}})};};
    channel.setArgoRuntime({channel:{activity:{record(){}},routing:{resolveAgentRoute:()=>({agentId:'a',sessionKey:'s',accountId:'default'})},session:{resolveStorePath:()=>dir,readSessionUpdatedAt:()=>null,recordInboundSession:async()=>{}},reply:{formatAgentEnvelope:o=>o.body,resolveEnvelopeFormatOptions:()=>({}),finalizeInboundContext:o=>o,dispatchReplyWithBufferedBlockDispatcher:async({dispatcherOptions:d,replyOptions:r})=>{
      assert.equal(r.disableBlockStreaming,true);
      await d.deliver({text:'private tool output'},{kind:'tool'});
      await d.deliver({text:'partial'},{kind:'block'});
      await d.deliver({text:'reasoning',isReasoning:true},{kind:'final'});
      await d.deliver({text:'@Peer next\nMSGR: handoff'},{kind:'final'});
    }}}});
    await channel.handleInbound({m:{message_id:5,text:'go',chat:{id:'chat'},from:{id:'user'},execution_attempt:'claim',peers:[{id:'peer',name:'Peer'}]},account:{url:'https://channel.test',token:T,accountId:'default'},cfg:{},log:()=>{}});
    assert.equal(calls.length,1); assert.equal(calls[0].text,'@Peer next');
    assert.equal(calls[0].execution_attempt,'claim');assert.equal(calls[0].reply_to_message_id,5);
    assert.deepEqual(calls[0].mentions,[{kind:'crew',id:'peer'}]);
  } finally {
    globalThis.fetch=previousFetch; delete globalThis.__argoSdkFixture;
    if(previousOutbox===undefined)delete process.env.ARGO_MSGR_OUTBOX_DIR;else process.env.ARGO_MSGR_OUTBOX_DIR=previousOutbox;
    await rm(dir,{recursive:true,force:true});
  }
});

test('permanent outbox rejection is preserved separately and does not block new authorized messages', async () => {
  const dir=await mkdtemp(join(tmpdir(),'argo-outbox-rejected-'));
  try {
    const first=makeApi({url:'https://rejected.test',token:T,outboxDir:dir,fetchImpl:async()=>{throw new Error('offline');}});
    await assert.rejects(first.sendMessage('chat','retained answer',7,{execution_attempt:'a',disposition:'done'}),/offline/);
    const calls=[];
    const next=makeApi({url:'https://rejected.test',token:T,outboxDir:dir,fetchImpl:async(url)=>{
      calls.push(url); return {status:url.endsWith('sendMessage')?403:200,json:async()=>url.endsWith('sendMessage')?{ok:false,error_code:403,description:'policy revoked'}:{ok:true,result:[{update_id:8,message:{text:'new owner request'}}]}};
    }});
    const updates=await next.getUpdates(0);
    assert.equal(updates[0].update_id,8);assert.match(calls[1],/getUpdates/);
    assert.equal((await readdir(dir)).filter(f=>f.endsWith('.json')).length,0);
    const rejected=await readdir(join(dir,'failed'));assert.equal(rejected.length,1);
    assert.equal(JSON.parse(await readFile(join(dir,'failed',rejected[0]),'utf8')).text,'retained answer');
  } finally {await rm(dir,{recursive:true,force:true});}
});
