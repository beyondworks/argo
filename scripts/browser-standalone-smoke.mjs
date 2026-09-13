#!/usr/bin/env node
// Portable artifact probe: copy the built standalone outside the checkout, then use its
// actual stdio worker and schema dependencies. No vendor turns or account credentials.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { cp, mkdtemp, readdir, readlink, rm, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const built = join(root, '.next', 'standalone');
const scratch = await mkdtemp(join(tmpdir(), 'argo-browser-portable-'));
const staged = join(scratch, 'app');
let client; let transport; let child; let fake;
const messages = [];
const relayCalls = [];
const relay = createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  assert.equal(req.headers.authorization, 'Bearer fixture-relay-token');
  const call = JSON.parse(Buffer.concat(chunks)); relayCalls.push(call);
  res.writeHead(200, {'content-type':'application/json'});
  res.end(JSON.stringify({isError:true,content:[{type:'text',text:'Fixture policy denied'}]}));
});
async function rejectEscapingLinks(dir) {
  for (const entry of await readdir(dir,{withFileTypes:true})) {
    const path = join(dir,entry.name);
    if (entry.isSymbolicLink()) {
      const target = resolve(dir, await readlink(path));
      assert.ok(!relative(staged,target).startsWith('..'), `Nonportable symlink: ${relative(staged,path)}`);
    } else if (entry.isDirectory()) await rejectEscapingLinks(path);
  }
}
try {
  await cp(built, staged, {recursive:true,verbatimSymlinks:true});
  await rejectEscapingLinks(staged);
  await new Promise(resolve=>relay.listen(0,'127.0.0.1',resolve));
  const env = {PATH:process.env.PATH, ARGO_ROOT:join(scratch,'workspaces'), ARGO_MODEL_CATALOG:'off',
    NEXT_PUBLIC_SUPABASE_URL:'',NEXT_PUBLIC_SUPABASE_ANON_KEY:'',SUPABASE_SERVICE_ROLE_KEY:'',
    ARGO_BROWSER_RELAY_URL:`http://127.0.0.1:${relay.address().port}/`, ARGO_BROWSER_RELAY_TOKEN:'fixture-relay-token'};
  client = new Client({name:'standalone-browser-qa',version:'1'});
  transport = new StdioClientTransport({command:process.execPath,args:[join(staged,'src','engine','browser-mcp-stdio.mjs')],cwd:staged,env,stderr:'pipe'});
  let stderr = ''; const connecting = client.connect(transport);
  transport.stderr?.on('data',d=>{stderr+=d;});
  try { await connecting; } catch { throw new Error(`Portable browser worker failed: ${stderr.slice(-1500)}`); }
  const tools = await client.listTools(); assert.equal(tools.tools.length,11);
  const result = await client.callTool({name:'browser_navigate',arguments:{url:'about:blank'}});
  assert.equal(result.isError,true); assert.equal(result.content[0].text,'Fixture policy denied');
  assert.equal(relayCalls.length,1);
  await client.close(); client=null; await transport.close(); transport=null;
  // Start the actual standalone server too, with empty cloud config and ephemeral port.
  const portProbe=createServer(); await new Promise(resolve=>portProbe.listen(0,'127.0.0.1',resolve));
  const port=portProbe.address().port; await new Promise(resolve=>portProbe.close(resolve));
  process.env.ARGO_ROOT=env.ARGO_ROOT;
  process.env.ARGO_MODEL_CATALOG='off';
  const {createCompany,paths}=await import('../src/workspace.mjs');
  const {saveRunnerCred}=await import('../src/runners/creds.mjs');
  const ws='portable-browser-qa';
  await createCompany(ws,'Portable browser QA','Fixture');
  await mkdir(paths(ws).agents,{recursive:true});
  await writeFile(join(paths(ws).agents,'alpha.md'),'---\nname: Alpha\nrunner: openrouter\nmodel: fake/model\n---\nQA fixture');
  await saveRunnerCred(ws,'openrouter','apikey','fixture-only-not-a-real-key');
  fake=createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    messages.push(JSON.parse(Buffer.concat(chunks)));const first=messages.length===1;
    res.writeHead(200,{'content-type':'application/json'});
    res.end(JSON.stringify({id:'fixture',type:'message',role:'assistant',model:'fake/model',content:first
      ? [{type:'tool_use',id:'b1',name:'browser_status',input:{}}]
      : [{type:'text',text:'portable browser checked'}],stop_reason:first?'tool_use':'end_turn',usage:{input_tokens:1,output_tokens:1}}));
  });
  await new Promise(resolve=>fake.listen(0,'127.0.0.1',resolve));
  env.ARGO_NATIVE_RUNNERS='openrouter';env.OPENROUTER_BASE_URL=`http://127.0.0.1:${fake.address().port}`;
  env.ARGO_BROWSER_PROVIDER='chromium';
  child=spawn(process.execPath,['server.js'],{cwd:staged,env:{...env,PORT:String(port),HOSTNAME:'127.0.0.1'},stdio:['ignore','pipe','pipe']});
  let serverLog=''; child.stdout.on('data',d=>{serverLog+=d;});child.stderr.on('data',d=>{serverLog+=d;});
  let up=false;
  for(let attempt=0;attempt<80&&!up;attempt++) { try {up=(await fetch(`http://127.0.0.1:${port}/api/ping`)).ok;}catch{} if(!up)await new Promise(resolve=>setTimeout(resolve,250)); }
  assert.ok(up,`Portable standalone did not boot: ${serverLog.slice(-1500)}`);
  const response=await fetch(`http://127.0.0.1:${port}/api/companies/${ws}/chat`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({slug:'alpha',message:'Check this agent browser status'})});
  const reply=await response.json();assert.equal(reply.reply,'portable browser checked');
  const toolResult=messages[1]?.messages.at(-1)?.content?.[0];
  assert.ok(toolResult && !toolResult.is_error, 'bundled native browser tool must execute');
  const status=JSON.parse(toolResult.content);assert.equal(status.agentProfileIsolated,true);assert.equal(status.workTabIsolated,true);
  assert.equal(status.connected,false);assert.equal(status.provider,'chromium');
  console.log('PASS: copied standalone boots; packaged stdio lists 11 schemas and relays denied call; real bundled chat executes scoped browser_status; no checkout dependency resolution, no real vendor turn.');
} finally {
  if(child && child.exitCode === null && child.signalCode === null){child.kill('SIGKILL');await new Promise(resolve=>child.once('exit',resolve));}
  await client?.close();await transport?.close();if(fake)await new Promise(resolve=>fake.close(resolve));await new Promise(resolve=>relay.close(resolve));
  await rm(scratch,{recursive:true,force:true});
}
