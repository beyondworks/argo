// Opt-in installed CLI contract checks. No model requests, auth, bundled app
// executable, launch-services inspection, or persistent user state are used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { setupNoDock } from '../src/no-dock.mjs';

const exec = promisify(execFile);
const quote = (s) => `'${String(s).replaceAll("'", "'\\''")}'`;
const probe = `const before=process.title;const setter=typeof Object.getOwnPropertyDescriptor(process,'title').set==='function';if(setter)process.title='argo-title-regression';console.log(JSON.stringify({preloaded:setter,titleBlocked:setter&&process.title===before,nodeOptions:!!process.env.NODE_OPTIONS}));`;
const shellCommand = `${quote(process.execPath)} -e ${quote(probe)}`;

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'argo-dock-cli-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = { HOME: home, CODEX_HOME: join(home, 'codex'), PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, SHELL: '/bin/sh' };
  await mkdir(env.CODEX_HOME);
  return { home, env };
}

async function codexCommand(bin, env, home) {
  const child = spawn(bin, ['app-server', '--stdio'], { cwd: home, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map(); let nextId = 0;
  child.stderr.resume();
  const rejectAll = (error) => { for (const { reject } of pending.values()) reject(error); pending.clear(); };
  child.once('error', rejectAll);
  child.once('exit', () => rejectAll(new Error('CLI exited before command response')));
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    const message = JSON.parse(line);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  });
  function send(method, params) {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }
  const timer = setTimeout(() => { rejectAll(new Error('CLI integration timeout')); child.kill('SIGKILL'); }, 25_000);
  try {
    await send('initialize', { clientInfo: { name: 'argo-dock-contract', version: '1' } });
    child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
    return await send('command/exec', {
      command: ['/bin/sh', '-c', shellCommand], cwd: home, timeoutMs: 10_000,
      sandboxPolicy: { type: 'dangerFullAccess' },
    });
  } finally {
    clearTimeout(timer); lines.close(); child.stdin.end();
    if (child.exitCode === null) {
      const closed = new Promise((resolve) => child.once('close', resolve));
      child.kill('SIGKILL'); await closed;
    }
  }
}

test('actual Codex shell policy preserves active preload without a model turn', {
  skip: process.platform !== 'darwin' || !process.env.ARGO_TEST_CODEX_BIN,
}, async (t) => {
  const { home, env } = await fixture(t);
  const baseline = await codexCommand(process.env.ARGO_TEST_CODEX_BIN, env, home);
  assert.equal(baseline.exitCode, 0, baseline.stderr);
  assert.deepEqual(JSON.parse(baseline.stdout), { preloaded: false, titleBlocked: false, nodeOptions: false });
  assert.ok(await setupNoDock({ env, path: join(home, 'no-dock.cjs') }));
  const active = await codexCommand(process.env.ARGO_TEST_CODEX_BIN, env, home);
  assert.equal(active.exitCode, 0, active.stderr);
  assert.deepEqual(JSON.parse(active.stdout), { preloaded: true, titleBlocked: true, nodeOptions: true });
});

test('actual Gemini local shell preserves preload, with pipe and PTY preference', {
  skip: process.platform !== 'darwin' || !process.env.ARGO_TEST_GEMINI_SHELL_MODULE,
}, async (t) => {
  const { home, env } = await fixture(t);
  assert.ok(await setupNoDock({ env, path: join(home, 'no-dock.cjs') }));
  for (const pty of [false, true]) {
    const script = `import {ShellExecutionService} from ${JSON.stringify(pathToFileURL(process.env.ARGO_TEST_GEMINI_SHELL_MODULE).href)};const run=await ShellExecutionService.execute(${JSON.stringify(shellCommand)},${JSON.stringify(home)},()=>{},AbortSignal.timeout(10000),${pty},{terminalWidth:80,terminalHeight:24});const result=await run.result;console.log(JSON.stringify({exitCode:result.exitCode,output:result.output,error:result.error?.message,method:result.executionMethod}));`;
    const { stdout } = await exec(process.execPath, ['--input-type=module', '-e', script], { cwd: home, env, timeout: 20_000 });
    const result = JSON.parse(stdout);
    t.diagnostic(`Gemini PTY preference ${pty}: ${result.method}`);
    assert.equal(result.exitCode, 0, JSON.stringify(result));
    assert.deepEqual(JSON.parse(result.output.trim()), { preloaded: true, titleBlocked: true, nodeOptions: true });
  }
});
