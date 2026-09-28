// Real SDK/native CLI/Bash closure. Model responses are local fixtures; sandbox-exec
// restricts the CLI and every descendant to the local fixture port before they start.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { SHIM_SRC, withNoDock } from '../src/no-dock.mjs';
import { sdkNoDockOptions } from '../src/sdk-no-dock.mjs';

// Apple's "localhost" includes all addresses owned by this machine; SBPL only
// supports localhost or * here. Restrict the port too (server binds 127.0.0.1).
const localPortOnly = port => `(version 1)(allow default)(deny network-outbound)(allow network-outbound (remote ip "localhost:${port}"))`;
const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
const sse = (res, events) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const [event, value] of events) res.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
  res.end();
};

test('real SDK CLI Bash preserves adopted shim after SDK env sanitization', { skip: process.platform !== 'darwin', timeout: 60000 }, async (t) => {
  const sdkPackage = JSON.parse(await readFile(new URL('../node_modules/@anthropic-ai/claude-agent-sdk/package.json', import.meta.url), 'utf8'));
  t.diagnostic(`SDK ${sdkPackage.version}; native CLI; local-fixture-port-only process sandbox`);
  // Probe only an address assigned to this machine (kernel local route, never a
  // remote host). EPERM distinguishes the policy denial from ECONNREFUSED.
  const ownAddress = Object.values(networkInterfaces()).flat().find(x => x.family === 'IPv4' && !x.internal)?.address;
  if (!ownAddress) {
    t.skip('offline host has no non-loopback IPv4 address for the local egress-policy smoke');
    return;
  }
  const smoke = spawn('/usr/bin/sandbox-exec', ['-p', localPortOnly(1), process.execPath, '-e',
    `const s=require('node:net').connect({host:${JSON.stringify(ownAddress)},port:9});s.on('error',e=>{console.log(e.code);});s.on('connect',()=>{console.log('unexpected-connect');s.destroy();});setTimeout(()=>s.destroy(),1000).unref();`],
  { env: { PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let smokeOut = ''; let smokeErr = '';
  smoke.stdout.on('data', d => { smokeOut += d; }); smoke.stderr.on('data', d => { smokeErr += d; });
  assert.deepEqual(await once(smoke, 'close'), [0, null], smokeErr);
  assert.equal(smokeOut.trim(), 'EPERM', 'sandbox must reject other ports before starting the real CLI');
  t.diagnostic('network policy smoke: own-interface port 9 denied with EPERM when only local port 1 allowed');
  const root = await mkdtemp(join(tmpdir(), 'argo-sdk-bash-dock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const fixed of [false, true]) {
    const home = join(root, fixed ? 'fixed' : 'baseline');
    await mkdir(home);
    const path = join(home, 'no-dock.cjs');
    await writeFile(path, SHIM_SRC);
    // Baseline never writes process.title: it reports the missing setter only.
    const script = `const d=Object.getOwnPropertyDescriptor(process,'title');const setter=typeof d.set==='function';let blocked=null;if(setter){const before=process.title;process.title='argo-fixture-title';blocked=process.title===before;}console.log('ARGO_DOCK_RESULT:'+JSON.stringify({setter,blocked,preload:!!process.env.NODE_OPTIONS}));`;
    const command = `${shellQuote(process.execPath)} -e ${shellQuote(script)}`;
    const toolResults = [];
    let modelRequests = 0;
    const server = createServer((req, res) => {
      let body = ''; req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        if (req.method !== 'POST' || !req.url.startsWith('/v1/messages')) {
          res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); return;
        }
        modelRequests += 1;
        const data = JSON.parse(body);
        const last = data.messages?.at(-1);
        const results = Array.isArray(last?.content) ? last.content.filter(x => x.type === 'tool_result') : [];
        toolResults.push(...results);
        const useTool = toolResults.length === 0;
        const block = useTool ? { type: 'tool_use', id: 'dock-bash-1', name: 'Bash', input: {} } : { type: 'text', text: '' };
        sse(res, [
          ['message_start', { type: 'message_start', message: { id: `fixture-${modelRequests}`, type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } }],
          ['content_block_start', { type: 'content_block_start', index: 0, content_block: block }],
          ['content_block_delta', { type: 'content_block_delta', index: 0, delta: useTool
            ? { type: 'input_json_delta', partial_json: JSON.stringify({ command, description: 'Report isolated Node preload descriptor', timeout: 10000 }) }
            : { type: 'text_delta', text: 'fixture complete' } }],
          ['content_block_stop', { type: 'content_block_stop', index: 0 }],
          ['message_delta', { type: 'message_delta', delta: { stop_reason: useTool ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 1 } }],
          ['message_stop', { type: 'message_stop' }],
        ]);
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const env = {
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: home, USERPROFILE: home, TMPDIR: home,
      CLAUDE_CONFIG_DIR: join(home, 'claude'), SHELL: '/bin/bash',
      ANTHROPIC_API_KEY: 'local-fixture-not-a-real-key',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
      NODE_OPTIONS: withNoDock('', path),
      DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_MAX_RETRIES: '0',
      ENABLE_TOOL_SEARCH: 'false',
    };
    let stderr = '';
    const onStderr = d => { stderr = (stderr + d).slice(-2000); };
    let cliPath;
    const sandboxSpawn = (executable, args, options) => {
      cliPath = executable;
      return spawn('/usr/bin/sandbox-exec', ['-p', localPortOnly(server.address().port), executable, ...args], options);
    };
    const restore = sdkNoDockOptions({ parentEnv: env, path, stderr: onStderr, spawnFn: sandboxSpawn });
    const baselineSpawn = ({ command: executable, args, cwd, env: sdkEnv, signal }) => {
      const child = sandboxSpawn(executable, args, { cwd, env: sdkEnv, signal, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      child.stderr.on('data', d => onStderr(d.toString())); return child;
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25000);
    const q = query({ prompt: 'Run the one supplied local fixture command and finish.', options: {
      cwd: home, env, abortController: controller, settingSources: [], strictMcpConfig: true, mcpServers: {},
      persistSession: false, tools: ['Bash'], maxTurns: 3, model: 'claude-sonnet-4-5',
      canUseTool: async (tool, input) => tool === 'Bash' && input.command === command
        ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'Only the fixture command is allowed' },
      spawnClaudeCodeProcess: fixed ? restore.spawnClaudeCodeProcess : baselineSpawn,
    } });
    let result;
    try {
      for await (const msg of q) if (msg.type === 'result') result = msg;
    } finally {
      clearTimeout(timer); q.close();
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    }
    assert.match(cliPath, /claude-agent-sdk-darwin-(?:arm64|x64)\/claude$/);
    assert.equal(result?.is_error, false, `${fixed ? 'fixed' : 'baseline'} result=${result?.subtype}; ${stderr}`);
    assert.ok(modelRequests >= 2, 'local model received tool_use and tool_result round trip');
    assert.equal(toolResults.length, 1);
    const content = typeof toolResults[0].content === 'string' ? toolResults[0].content : JSON.stringify(toolResults[0].content);
    const marker = content.match(/ARGO_DOCK_RESULT:(\{[^\n]*?\})/);
    assert.ok(marker, `missing child output: ${content}`);
    const observation = JSON.parse(marker[1]);
    assert.deepEqual(observation, { setter: fixed, blocked: fixed ? true : null, preload: fixed });
    assert.equal(toolResults[0].is_error ?? false, false);
    t.diagnostic(`${fixed ? 'fixed' : 'baseline'}: ${JSON.stringify(observation)}, local model requests=${modelRequests}`);
  }
});
