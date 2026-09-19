import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from './helpers/tmp.mjs';
import { execTurnFile } from '../src/runners/process-tree.mjs';
import { runInNewContext } from 'node:vm';
const delay = ms => new Promise(r => setTimeout(r,ms));
const waitFor = async fn => { const until=Date.now()+8000; while(Date.now()<until){if(await fn())return;await delay(40);}throw new Error('fixture timeout'); };
const size = path => readFile(path).then(b=>b.length,()=>0);

for(const mode of ['abort','timeout']) test(`${mode} ends detached descendants and preserves an unrelated fixture`,async()=>{
 const dir=await mkdtemp(join(tmpdir(),'argo-owned-tree-'));
 const beat=join(dir,'beat'),otherBeat=join(dir,'other'),pidfile=join(dir,'pids');
 const leaf=join(dir,'leaf.cjs'),branch=join(dir,'branch.cjs'),root=join(dir,'root.cjs');
 await writeFile(leaf,`const fs=require('fs');fs.appendFileSync(process.argv[3],process.pid+'\\n');setInterval(()=>fs.appendFileSync(process.argv[2],'x'),40);`);
 await writeFile(branch,`const {spawn}=require('child_process');require('fs').appendFileSync(process.argv[4],process.pid+'\\n');const child=spawn(process.execPath,[process.argv[2],process.argv[3],process.argv[4]],{detached:true,stdio:'ignore'});child.unref();setInterval(()=>{},1000);`);
 await writeFile(root,`const {spawn}=require('child_process');require('fs').appendFileSync(process.argv[5],process.pid+'\\n');const child=spawn(process.execPath,[process.argv[2],process.argv[3],process.argv[4],process.argv[5]],{detached:true,stdio:'ignore'});child.unref();setInterval(()=>{},1000);`);
 const other=spawn(process.execPath,['-e',`setInterval(()=>require('fs').appendFileSync(process.argv[1],'x'),40)`,otherBeat],{stdio:'ignore'});
 const ac=new AbortController();
 const run=execTurnFile(process.execPath,[root,branch,leaf,beat,pidfile],{signal:ac.signal,timeout:mode==='timeout'?1000:10000});
 const rejected=assert.rejects(run,e=>mode==='abort'?e.aborted===true:e.timedOut===true&&e.killed===true);
 try {
  await waitFor(async()=> (await size(beat))>2);
  assert.equal((await readFile(pidfile,'utf8')).trim().split('\n').filter(v=>/^\d+$/.test(v)).length,3,'fixture PID file has three newline-delimited process IDs');
  if(mode==='abort') ac.abort();
  await rejected;
  const stopped=await size(beat),otherAt=await size(otherBeat);
  await delay(700);
  assert.equal(await size(beat),stopped);
  assert.ok((await size(otherBeat))>otherAt,'unrelated process still works');
 } finally {
  other.kill('SIGKILL');run.child?.kill('SIGKILL');
  for(const pid of (await readFile(pidfile,'utf8').catch(()=>'' )).trim().split('\n').map(Number).filter(Boolean))try{process.kill(pid,'SIGKILL');}catch{}
 }
});
test('already aborted signal does not spawn a child',async()=>{
 const ac=new AbortController();ac.abort();
 const run=execTurnFile(process.execPath,['-e','throw new Error("must not run")'],{signal:ac.signal});
 await assert.rejects(run,e=>e.aborted===true);assert.equal(run.child,undefined);
});
test('a detached child observed before root exit is stopped and uncertainty stays explicit', {skip:process.platform==='win32'}, async()=>{
 const dir=await mkdtemp(join(tmpdir(),'argo-root-exited-')); const beat=join(dir,'beat'); const go=join(dir,'go');
 const ac=new AbortController();
 // 루트는 go 파일이 생길 때까지 산다 — 시험이 소유 기록에 자식이 들어온 것(= 루트 종료 전 관찰)을 확인한 뒤 만든다.
 // 종전에는 650ms 시계였고, 병렬 부하로 500ms 공유 스냅샷이 늦으면 관찰 전에 루트가 끝나 자식이 멈추지 않았다(8회 중 2회 red, 2026-09-19).
 const script=`const {spawn}=require('child_process');const fs=require('fs');const child=spawn(process.execPath,['-e',"setInterval(()=>require('fs').appendFileSync(process.argv[1],'x'),40)",process.argv[1]],{detached:true,stdio:['ignore',process.stdout,process.stderr]});process.stdout.write(String(child.pid)+'\\n');child.unref();const t=setInterval(()=>{if(fs.existsSync(process.argv[2])){clearInterval(t);process.exit(0);}},20);`;
 const run=execTurnFile(process.execPath,['-e',script,beat,go],{signal:ac.signal});let descendant;
 run.child.stdout.on('data',d=>{descendant=Number(String(d).trim());});
 const rejected=assert.rejects(run,e=>e.aborted===true&&e.cancellationIncomplete===true);
 try {
  await waitFor(()=>Number.isInteger(descendant)&&run.ownership.records.has(descendant));
  await writeFile(go,'');
  await waitFor(()=>run.child.exitCode===0);ac.abort();await rejected;
  const atStop=await size(beat);await delay(500);assert.equal(await size(beat),atStop);
 } finally { if(Number.isInteger(descendant))try{process.kill(descendant,'SIGKILL');}catch{} }
});

// Fault injection at process inspection, without sending signals to the test host.
const treeSource = (await readFile(new URL('../src/runners/process-tree.mjs', import.meta.url), 'utf8'))
 .replace(/^import .*;\n/gm,'').replace(/^export /gm,'');
for (const failAt of [1,3,5]) test(`inspection failure ${failAt} settles cancellation and releases known stopped children`,async()=>{
 const signals=[];let inspect=0;
 const table='200 100 Sun Sep 13 00:00:00 2026\n201 200 Sun Sep 13 00:00:01 2026\n';
 const child={pid:200,exitCode:null,signalCode:null,stdin:{end(){}},kill:sig=>signals.push([200,sig])};
 const {execTurnFile:execFixture}=runInNewContext(`${treeSource}\n({execTurnFile})`,{
  execFile:()=>child,promisify:()=>async()=>{if(++inspect>=failAt)throw new Error('inspection unavailable');return {stdout:table};},
  process:{pid:100,platform:'darwin',kill:(pid,sig)=>signals.push([pid,sig])},setTimeout,clearTimeout,setInterval,clearInterval,
 });
 const ac=new AbortController();const run=execFixture('fixture',[],{signal:ac.signal});ac.abort();
 await assert.rejects(run,e=>e.aborted===true&&e.cancellationIncomplete===true);
 for(const [pid,signal] of signals.filter(([,signal])=>signal==='SIGSTOP')) {
  assert.ok(signals.some(([killed,sig])=>killed===pid&&sig==='SIGKILL'),`stopped ${pid} released after ${signal}`);
 }
 assert.ok(signals.every(([pid])=>pid===200||pid===201));
});
for (const tracked of [false,true]) test(`a replaced root identity is never signalled (tracked=${tracked})`,async()=>{
 const signals=[];let inspect=0;
 const {terminateOwnedProcessTree:terminate}=runInNewContext(`${treeSource}\n({terminateOwnedProcessTree})`,{
  execFile:()=>{},promisify:()=>async()=>({stdout:`200 100 ${++inspect===1?'original':'replacement'}\n`}),
  process:{pid:100,platform:'darwin',kill:(pid,sig)=>signals.push([pid,sig])},setTimeout,clearTimeout,setInterval,clearInterval,
 });
 const ownership=tracked?{records:new Map([[200,{pid:200,parent:100,birth:'original'}]]),stop:async()=>{}}:null;
 await assert.rejects(terminate({pid:200,exitCode:null,signalCode:null},ownership),e=>e.ownershipUnverified===true);assert.deepEqual(signals,[]);
});
test('empty process inspection warns without signalling an unverified PID',async()=>{
 const signals=[];
 const child={pid:200,exitCode:null,signalCode:null,stdin:{end(){}},kill:sig=>signals.push([200,sig])};
 const {execTurnFile:execute}=runInNewContext(`${treeSource}\n({execTurnFile})`,{
  execFile:()=>child,promisify:()=>async()=>({stdout:''}),
  process:{pid:100,platform:'darwin',kill:(pid,sig)=>signals.push([pid,sig])},setTimeout,clearTimeout,setInterval,clearInterval,
 });
 const ac=new AbortController();const run=execute('fixture',[],{signal:ac.signal});ac.abort();
 await assert.rejects(run,e=>e.aborted===true&&e.cancellationIncomplete===true);assert.deepEqual(signals,[]);
});
