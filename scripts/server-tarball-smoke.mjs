#!/usr/bin/env node
// Test the extracted Linux distribution, not the checkout or developer HOME.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';

const tarball = resolve(process.argv[2]);
const temporary = await mkdtemp(join(tmpdir(), 'argo-server-release-'));
let child;
try {
  execFileSync('tar', ['-xzf', tarball, '-C', temporary]);
  const server = join(temporary, 'argo-server');
  const home = join(temporary, 'home');
  const data = join(temporary, 'data');
  await mkdir(home); await mkdir(data);
  const version = JSON.parse(await readFile(join(server, 'package.json'), 'utf8')).version;
  const buildId = (await readFile(join(server, '.next/BUILD_ID'), 'utf8')).trim();
  assert(buildId);
  const probe = createServer();
  probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(r => probe.close(r));
  // Deliberate allowlist: no inherited vendor keys, device sessions, or account HOME.
  const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'),
    ARGO_ROOT: data, ARGO_LOCAL_BIND_PROOF: '127.0.0.1', PORT: String(port), HOSTNAME: '127.0.0.1', NODE_ENV: 'production', ARGO_MODEL_CATALOG: 'off',
    NEXT_PUBLIC_SUPABASE_URL: '', NEXT_PUBLIC_SUPABASE_ANON_KEY: '', SUPABASE_SERVICE_ROLE_KEY: '' };
  child = spawn(process.execPath, ['server.js'], { cwd: server, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', d => { output = (output + d).slice(-8000); }); child.stderr.on('data', d => { output = (output + d).slice(-8000); });
  const base = `http://127.0.0.1:${port}`;
  let ping;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Server exited (${child.exitCode}): ${output}`);
    try { const r = await fetch(`${base}/api/ping`, { signal: AbortSignal.timeout(2000) }); if (r.ok) { ping = await r.json(); break; } } catch { /* startup */ }
    await new Promise(r => setTimeout(r, 500));
  }
  assert.deepEqual(ping, { argo: true, version, buildId }, `Distribution identity mismatch: ${output}`);
  const me = await fetch(`${base}/api/me`, { signal: AbortSignal.timeout(10000) });
  assert.equal(me.status, 200);
  const identity = await me.json();
  assert.equal(identity.authOn, false); assert.equal(identity.user?.id, 'local');
  assert.equal((await fetch(base, { signal: AbortSignal.timeout(10000) })).status, 200);
  const assets = await fetch(`${base}/api/local-assets`, { signal: AbortSignal.timeout(10000) });
  assert.equal(assets.status, 200, `Local import dependencies/route unavailable: ${await assets.clone().text()}`);
  assert.equal((await assets.json()).count, 0, 'Clean HOME must not discover developer assets');
  const foreignHostStatus = await new Promise((accept, reject) => {
    const req = request(`${base}/api/me`, { headers: { Host: 'foreign.invalid' } }, res => { res.resume(); accept(res.statusCode); });
    req.setTimeout(10000, () => req.destroy(new Error('Foreign Host check timed out')));
    req.on('error', reject); req.end();
  });
  assert.equal(foreignHostStatus, 421, 'Local mode must reject a foreign Host');
  console.log(`Server tarball smoke OK: ${version}; clean HOME; HTTP 200; local identity; foreign Host 421; empty local import discovery`);
} finally {
  if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
  await rm(temporary, { recursive: true, force: true });
}
