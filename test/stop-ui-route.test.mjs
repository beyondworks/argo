import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { parse } from 'espree';
import { interruptTurn, withTurnControl } from '../src/turn-abort.mjs';
import { isStopCommand } from '../src/stop-command.mjs';

const ui=await readFile(new URL('../app/c/[ws]/crew/[slug]/page.jsx',import.meta.url),'utf8');
function findFunction(source,name){
 const ast=parse(source,{ecmaVersion:'latest',sourceType:'module',ecmaFeatures:{jsx:true},range:true});
 let found;
 const visit=n=>{if(!n||typeof n!=='object')return;if(n.type==='FunctionDeclaration'&&n.id.name===name)found=source.slice(...n.range);for(const v of Object.values(n)){if(Array.isArray(v))v.forEach(visit);else if(v&&typeof v==='object')visit(v);}};
 visit(ast);assert.ok(found,name);return found;
}
test('actual composer standalone stop bypasses busy queue, holds queued work immediately',async()=>{
 const queued=[],states=[],calls=[];
 const ctx=vm.createContext({isStopCommand,busy:true,working:true,aborting:false,uploading:false,slashMatches:[],input:'멈춰줘',att:[],histIdx:{current:0},ws:'w',slug:'alpha',
  setInput:()=>{},setAtt:()=>{},setQueue:q=>queued.push(q),setQueueHeld:b=>states.push(b),setAborting:()=>{},setError:()=>{},
  api:async(url)=>calls.push(url), sendMessage:()=>{throw new Error('must not run model');}});
 vm.runInContext(findFunction(ui,'abortTurn')+';'+findFunction(ui,'send'),ctx);
 await ctx.send({preventDefault(){}});
 assert.equal(queued.length,0);assert.ok(states.every(Boolean));assert.deepEqual(calls,['/api/companies/w/chat/abort']);
});
test('actual composer preserves non-control negation and attachment messages in queue',async()=>{
 for(const [input,att] of [['멈추지마',[]],['stop',[{rel:'files/instructions.txt'}]]]){
  const queued=[];const ctx=vm.createContext({isStopCommand,busy:true,working:true,uploading:false,slashMatches:[],input,att,histIdx:{current:0},setInput:()=>{},setAtt:()=>{},
   setQueue:fn=>queued.push(...fn([])),abortTurn:()=>{throw new Error('false stop');},setQueueHeld:()=>{throw new Error('false hold');}});
  vm.runInContext(findFunction(ui,'send'),ctx);await ctx.send({preventDefault(){}});assert.equal(queued[0].text,input);
 }
});
test('actual stop button holds queue before HTTP cancellation and exposes failure',async()=>{
 const states=[];const ctx=vm.createContext({aborting:false,busy:true,ws:'w',slug:'a',setQueueHeld:()=>states.push('held'),setAborting:()=>{},setError:e=>states.push(e),api:async()=>{states.push('http');throw new Error('unavailable');}});
 vm.runInContext(findFunction(ui,'abortTurn'),ctx);await ctx.abortTurn();assert.deepEqual(states,['held','http','unavailable']);
});
const route=await readFile(new URL('../app/api/companies/[ws]/chat/route.js',import.meta.url),'utf8');
test('actual authenticated chat route executes standalone stop without invoking model',async()=>{
 let cancelled=0,models=0;const saved=[];
 const ctx=vm.createContext({Response,console,isStopCommand,guardCompany:async()=>null,interruptTurn:async()=>{cancelled++;return true;},
  beginTurn:async()=> 'turn-id',nudgeSync:()=>{},loadCompany:async()=>({lang:'ko'}),chat:async()=>{models++;throw new Error('unexpected model');},appendTurn:async(...args)=>saved.push(args)});
 vm.runInContext(findFunction(route,'POST'),ctx);
 const response=await ctx.POST({json:async()=>({slug:'alpha',message:'멈춰',sessionId:'session'})},{params:Promise.resolve({ws:'w'})});
 assert.equal(response.status,200);assert.equal(cancelled,1);assert.equal(models,0);assert.match((await response.json()).reply,/중단/);assert.equal(saved.length,1);
});
test('actual route retains incomplete cancellation in response and stored conversation',async()=>{
 const saved=[];
 const ctx=vm.createContext({Response,console,isStopCommand,guardCompany:async()=>null,
  beginTurn:async()=> 'turn-id',nudgeSync:()=>{},loadCompany:async()=>({lang:'ko'}),
  chat:async()=>{throw Object.assign(new Error('중단됨'),{aborted:true,cancellationIncomplete:true});},
  appendTurn:async(...args)=>saved.push(args)});
 vm.runInContext(findFunction(route,'POST'),ctx);
 const response=await ctx.POST({json:async()=>({slug:'alpha',message:'fixture work'})},{params:Promise.resolve({ws:'w'})});
 const result=await response.json();assert.equal(result.cancellationIncomplete,true);assert.equal(result.aborted,true);
 assert.equal(saved[0][2].cancellationIncomplete,true);
});


test('actual directive batch stops before its second side effect',async()=>{
 const source=await readFile(new URL('../src/cli-directives.mjs',import.meta.url),'utf8');
 const executed=[];
 const ctx=vm.createContext({TOOL_RESULT_BUDGET_BYTES:24000,handledByTool:()=>false /* K94 이중 실행 판정 — 다리 없는 턴 */,listAgents:async()=>[],normalizeSchedule:x=>x,toSchedule:()=>({type:'daily',time:'09:00'}),messengerOrigin:()=>null,
  addRoutine:async(_ws,data)=>{executed.push(data.title);await interruptTurn('batch','alpha',{source:'chat'});return {id:'one',schedule:{type:'daily',time:'09:00'}};}});
 vm.runInContext(findFunction(source,'runDirectives'),ctx);
 await assert.rejects(withTurnControl('batch','alpha',null,control=>ctx.runDirectives('batch','alpha',[
  {action:'schedule',title:'first',prompt:'first'},{action:'schedule',title:'second',prompt:'second'}
 ],{turnControl:control})),e=>e.aborted===true);
 assert.deepEqual(executed,['first']);
});
