import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, writeFile, rm, realpath, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { sdkNoDockOptions } from '../src/sdk-no-dock.mjs';
import { SHIM_SRC, withNoDock } from '../src/no-dock.mjs';

test('only adopted macOS preload enables the SDK override', () => {
  const path = '/tmp/argo-no-dock.cjs';
  assert.deepEqual(sdkNoDockOptions({ platform: 'linux', path, parentEnv: { NODE_OPTIONS: `--require ${path}` } }), {});
  assert.deepEqual(sdkNoDockOptions({ platform: 'darwin', path, parentEnv: {} }), {});
});

test('SDK fixture preload encoding supports Windows drive paths with spaces', () => {
  const path = String.raw`C:\Users\runner\Temp\no dock.cjs`;
  const encoded = withNoDock('--trace-warnings', path);
  assert.equal(encoded, String.raw`--require "C:\\Users\\runner\\Temp\\no dock.cjs" --trace-warnings`);
  assert.equal(typeof sdkNoDockOptions({ platform: 'darwin', path, parentEnv: { NODE_OPTIONS: encoded } }).spawnClaudeCodeProcess, 'function');
});

test('spawn preserves SDK contract and captured preload, not parent flags or credentials', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'argo-sdk-spawn-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const path = join(home, 'no dock.cjs');
  await writeFile(path, `${SHIM_SRC}\nprocess.env.ARGO_DOCK_PRELOADED="yes";`);
  const parentEnv = { NODE_OPTIONS: withNoDock('--trace-warnings', path), PARENT_ONLY: 'excluded' };
  let forwarded;
  let stderr = '';
  const { spawnClaudeCodeProcess } = sdkNoDockOptions({
    platform: 'darwin', path, parentEnv, stderr: d => { stderr += d; },
    spawnFn: (command, args, options) => { forwarded = { command, args, options }; return spawn(command, args, options); },
  });
  delete parentEnv.NODE_OPTIONS; // SDK mutates its env before invoking the hook.
  const signal = new AbortController().signal;
  const env = { PATH: process.env.PATH, SDK_MARKER: 'preserved', NODE_OPTIONS: '--no-warnings' };
  const args = ['-e', 'process.stderr.write("한글 진단"); console.log(JSON.stringify({preloaded:process.env.ARGO_DOCK_PRELOADED,marker:process.env.SDK_MARKER,parent:process.env.PARENT_ONLY,cwd:process.cwd()}));'];
  const child = spawnClaudeCodeProcess({ command: process.execPath, args, cwd: home, env, signal });
  let out = ''; child.stdout.on('data', d => { out += d; });
  assert.deepEqual(await once(child, 'exit'), [0, null]);
  assert.deepEqual(JSON.parse(out), { preloaded: 'yes', marker: 'preserved', cwd: await realpath(home) });
  assert.equal(stderr, '한글 진단');
  assert.equal(forwarded.command, process.execPath);
  assert.equal(forwarded.args, args);
  assert.equal(forwarded.options.signal, signal);
  assert.equal(forwarded.options.windowsHide, true);
  assert.deepEqual(forwarded.options.stdio, ['pipe', 'pipe', 'pipe']);
  assert.equal(forwarded.options.env.NODE_OPTIONS, withNoDock('--no-warnings', path));
  assert.equal(env.NODE_OPTIONS, '--no-warnings');
});

test('exit waits for split UTF-8 stderr and forwards process errors and cancellation', async (t) => {
  const child = new EventEmitter();
  Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null, killed: false,
    kill(signal) { this.killed = true; this.signalCode = signal; return true; } });
  t.after(() => { child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); });
  let stderr = '';
  const { spawnClaudeCodeProcess } = sdkNoDockOptions({
    platform: 'darwin', path: '/tmp/no-dock.cjs', parentEnv: { NODE_OPTIONS: '--require /tmp/no-dock.cjs' },
    stderr: d => { stderr += d; }, spawnFn: () => child,
  });
  const proc = spawnClaudeCodeProcess({ env: {} });
  const error = new Error('spawn failed');
  let received; proc.once('error', e => { received = e; });
  child.emit('error', error);
  assert.equal(received, error);
  assert.equal(proc.kill('SIGTERM'), true);
  assert.equal(proc.killed, true);
  assert.equal(proc.signalCode, 'SIGTERM');
  child.exitCode = 7;
  let delivered = false;
  const exited = once(proc, 'exit').then(args => { delivered = true; return args; });
  child.emit('exit', 7, 'SIGTERM');
  assert.equal(delivered, false);
  const bytes = Buffer.from('진단');
  child.stderr.write(bytes.subarray(0, 2));
  child.stderr.write(bytes.subarray(2));
  child.stderr.destroy();
  assert.deepEqual(await exited, [7, 'SIGTERM']);
  assert.equal(stderr, '진단');
});

test('stderr left open by descendants cannot indefinitely delay exit', async (t) => {
  const child = new EventEmitter();
  Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: 0, signalCode: null, killed: false, kill() {} });
  t.after(() => { child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); });
  const { spawnClaudeCodeProcess } = sdkNoDockOptions({ platform: 'darwin', path: '/tmp/no-dock.cjs',
    parentEnv: { NODE_OPTIONS: '--require /tmp/no-dock.cjs' }, spawnFn: () => child });
  const proc = spawnClaudeCodeProcess({ env: {} });
  const exited = once(proc, 'exit');
  child.emit('exit', 0, null);
  assert.deepEqual(await exited, [0, null]);
  assert.equal(child.stderr.destroyed, true);
});

test('actual SDK removes NODE_OPTIONS and hook restores preload before CLI initialization', { timeout: 10000 }, async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'argo-sdk-init-'));
  let q; let release; let child; let closed;
  t.after(async () => {
    release?.();
    try { q?.close(); } finally {
      try {
        if (child) {
          child.stdin.end();
          const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
          try { await closed; } finally { clearTimeout(timer); }
        }
      } finally {
        // Windows cannot remove a running child's cwd. One cleanup hook also
        // prevents a failed directory removal from skipping process cleanup.
        await rm(home, { recursive: true, force: true });
      }
    }
  });
  const path = join(home, 'no-dock.cjs');
  await writeFile(path, `${SHIM_SRC}\nprocess.env.ARGO_DOCK_PRELOADED="yes";`);
  const env = { PATH: process.env.PATH, HOME: home, NODE_OPTIONS: withNoDock('', path), SDK_MARKER: 'yes' };
  let stripped = false;
  // Local protocol fixture: no model call, credentials, or actual CLI configuration.
  const cli = `const before=process.title;process.title='argo-sdk-fixture';require('node:readline').createInterface({input:process.stdin}).on('line',l=>{const m=JSON.parse(l);if(m.type==='control_request')console.log(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:m.request_id,response:{commands:[{name:JSON.stringify({preloaded:process.env.ARGO_DOCK_PRELOADED,marker:process.env.SDK_MARKER,titleBlocked:process.title===before})}],models:[]}}}));});`;
  const options = sdkNoDockOptions({ platform: 'darwin', path, parentEnv: env,
    spawnFn: (_command, _args, opts) => {
      child = spawn(process.execPath, ['-e', cli], opts);
      closed = new Promise(resolve => child.once('close', resolve));
      return child;
    },
  });
  const hook = options.spawnClaudeCodeProcess;
  const done = new Promise(resolve => { release = resolve; });
  q = query({ prompt: (async function* () { await done; })(), options: {
    cwd: home, env, settingSources: [], persistSession: false,
    spawnClaudeCodeProcess: opts => { stripped = opts.env.NODE_OPTIONS === undefined; return hook(opts); },
  } });
  const commands = await q.supportedCommands();
  assert.equal(stripped, true);
  assert.deepEqual(JSON.parse(commands[0].name), { preloaded: 'yes', marker: 'yes', titleBlocked: process.platform === 'darwin' });
});

// Wiring guard complements the real process/SDK behavior tests above. Removal
// from either query path must fail even while the standalone helper stays green.
test('both chat and oneshot SDK options install the shared hook', async () => {
  for (const file of ['chat', 'oneshot']) {
    const source = await readFile(new URL(`../src/${file}.mjs`, import.meta.url), 'utf8');
    assert.match(source, /import \{ sdkNoDockOptions \} from '\.\/sdk-no-dock\.mjs'/);
    assert.match(source, file === 'chat'
      ? /stderr: sdkStderr,\s*\.\.\.sdkNoDockOptions\(\{ stderr: sdkStderr \}\),/
      : /\.\.\.\(sdkEnv \? \{ env: sdkEnv \} : \{\}\),\s*\.\.\.sdkNoDockOptions\(\),/);
  }
});
