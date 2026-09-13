import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWorkReply, workPrompt, workCanContinue, workDb, workPeers } from '../src/gateway/msgr-work.mjs';
const work = { id: 'work', goal: 'Find and compare three suppliers', completion_criteria: 'Three sources and a price comparison', lead_crew_id: 'lead', status: 'running' };
const peers = [{ id: 'lead', display_name: '총괄', role_text: '조정' }, { id: 'remote', display_name: 'Research', role_text: 'Research on another device' }];

test('the permanent goal, criteria, lead and remote roles accompany each work turn', () => {
  for (const lang of ['ko','en']) for (const crew of ['lead','remote']) {
    const prompt = workPrompt(work, peers, crew, lang);
    assert.ok(prompt.includes(work.goal)); assert.ok(prompt.includes(work.completion_criteria));
    assert.ok(prompt.includes('@총괄')); assert.ok(prompt.includes('Research on another device'));
    assert.ok(prompt.includes('MSGR: handoff') || prompt.includes('WORK: completed'));
  }
  assert.equal(workPrompt(null, peers,'lead'), '');
});
test('only the lead terminal decision ends the whole work; specialist done and unmarked plans do not', () => {
  const reply='Result\nWORK: completed\nMSGR: done';
  assert.deepEqual(parseWorkReply(work,'lead',reply), { text: 'Result\nMSGR: done', status: 'completed' });
  assert.equal(parseWorkReply(work,'remote',reply).status, null);
  assert.equal(parseWorkReply(work,'lead','Plan only\nMSGR: done').status, null);
  assert.equal(parseWorkReply(work,'lead','Blocked: missing access\nWORK: blocked\nMSGR: done').status,'blocked');
  assert.equal(parseWorkReply(work,'lead','WORK: completed\nMSGR: handoff').status,null);
  assert.equal(parseWorkReply(null,'lead',reply).text,reply);
});
test('quoted and fenced markers do not finish work, closed code blocks can precede a real decision', () => {
  for(const value of ['```\nWORK: completed\nMSGR: done','Result\n> WORK: completed\nMSGR: done','~~~\nWORK: blocked\nMSGR: done'])
    assert.equal(parseWorkReply(work,'lead',value).status,null);
  assert.equal(parseWorkReply(work,'lead','```js\nresult\n```\nWORK: completed\nMSGR: done').status,'completed');
});
test('cancelled, blocked and completed work never starts another turn; ordinary chat stays enabled', () => {
  assert.equal(workCanContinue(null),true); assert.equal(workCanContinue(work),true);
  for(const status of ['cancelled','blocked','completed']) assert.equal(workCanContinue({...work,status}),false);
});
test('work lookup scopes the persisted root and channel and fails visibly on storage failure', async () => {
  const seen=[]; const chain={ select:()=>chain, eq:(key,value)=>{ seen.push([key,value]); return chain; }, maybeSingle:async()=>({data:work}) };
  const db=workDb({from:(name)=>{ assert.equal(name,'msgr_work_runs'); return chain; }});
  assert.equal(await db.workRun(10,'channel'),work);
  assert.deepEqual(seen,[['root_message_id',10],['channel_id','channel']]);
  chain.maybeSingle=async()=>({error:{message:'offline'}});
  await assert.rejects(db.workRun(10,'channel'),/offline/);
});


test('unsupported or unauthorized peers are not proposed; bots and both-owner-authorized native peers remain available', async()=>{
  const candidates=[{id:'old',work_protocol:0},{id:'new',work_protocol:1},{id:'bot',hosting:'bot'},{id:'denied',work_protocol:1}];
  const db={instructCheck:async(id,uid)=>id==='denied'&&uid==='sender'?'crew_allow':'ok'};
  assert.deepEqual((await workPeers(db,{created_by:'requester'},candidates,'channel','sender')).map((p)=>p.id),['new','bot']);
  assert.equal(await workPeers({},null,candidates,'channel','sender'),candidates);
});
test('missing optional capability RPC on an older self-hosted server does not fail ordinary heartbeat', async()=>{
  for(const code of ['PGRST202','42883'])await workDb({rpc:async()=>({error:{code,message:'unknown function'}})}).workHeartbeat(['lead']);
  await assert.rejects(workDb({rpc:async()=>({error:{code:'42501',message:'forbidden'}})}).workHeartbeat(['lead']),/forbidden/);
});
test('resuming work rejects queued sources from the previous authorized round',()=>{
  const resumed={...work,last_resume_message_id:100};
  assert.equal(workCanContinue(resumed,99),false); assert.equal(workCanContinue(resumed,100),true); assert.equal(workCanContinue(resumed,101),true);
});
