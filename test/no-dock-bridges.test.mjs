import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const exec = promisify(execFile);

test('CLI-added browser and crew bridges carry the preload through filtered MCP environments', {
  skip: process.platform !== 'darwin',
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'argo-dock-bridges-'));
  try {
    // Separate process: no global env edits or writes to the real ~/.argo.
    const script = `
      import {setupNoDock} from ${JSON.stringify(new URL('../src/no-dock.mjs', import.meta.url).href)};
      import {createBrowserMcpBridge} from ${JSON.stringify(new URL('../src/engine/browser-mcp.mjs', import.meta.url).href)};
      import {createCrewMcpBridge} from ${JSON.stringify(new URL('../src/engine/crew-mcp.mjs', import.meta.url).href)};
      import {execFileSync} from 'node:child_process';
      if (!await setupNoDock()) throw new Error('preload unavailable');
      const bridges = [await createBrowserMcpBridge({wsId:'fixture',slug:'crew',canUseTool:async()=>({behavior:'allow'})}),await createCrewMcpBridge([])];
      try {
        const result=bridges.map(({server})=>{
          const probe="const before=process.title;const active=typeof Object.getOwnPropertyDescriptor(process,'title').set==='function';if(active)process.title='argo-bridge-test';console.log(JSON.stringify({active,blocked:active&&before===process.title}));";
          // MCP transports can drop the parent's NODE_OPTIONS. Use only the
          // bridge's explicit environment to exercise that actual boundary.
          const child=JSON.parse(execFileSync(server.command,['-e',probe],{env:{PATH:'/usr/bin:/bin',...server.env},encoding:'utf8'}));
          return {...child,relayKeys:Object.keys(server.env).filter(k=>k.endsWith('_RELAY_URL')||k.endsWith('_RELAY_TOKEN')).length,unrelated:!!server.env.ARGO_TEST_PRIVATE};
        });
        console.log(JSON.stringify(result));
      } finally {await Promise.all(bridges.map(b=>b.close()));}
    `;
    const { stdout } = await exec(process.execPath, ['--input-type=module', '-e', script], {
      cwd: home, env: { HOME: home, PATH: '/usr/bin:/bin', ARGO_ROOT: join(home, 'data'), ARGO_TEST_PRIVATE: 'fixture' }, timeout: 20_000,
    });
    assert.deepEqual(JSON.parse(stdout), [
      { active: true, blocked: true, relayKeys: 2, unrelated: false },
      { active: true, blocked: true, relayKeys: 2, unrelated: false },
    ]);
  } finally { await rm(home, { recursive: true, force: true }); }
});
