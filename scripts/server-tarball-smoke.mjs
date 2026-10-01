#!/usr/bin/env node
// Test the extracted Linux distribution, not the checkout or developer HOME.
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises';
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
  assert.deepEqual(ping, { argo: true, version, buildId, dockProtocol: 1 }, `Distribution identity mismatch: ${output}`);
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
  // argo CLI — 배포본 그대로 깨끗한 HOME에서. standalone 추적이 CLI 전용 모듈을 빠뜨리면 여기서 모듈 없음으로 깨진다.
  const cliHome = join(temporary, 'cli'); const cliData = join(temporary, 'cli-data');
  const cliEnv = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, ARGO_CLI_HOME: cliHome, XDG_DATA_HOME: cliData, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', ARGO_MODEL_CATALOG: 'off' };
  const cli = (...args) => spawnSync(process.execPath, [join(server, 'bin', 'argo.mjs'), ...args], { env: cliEnv, encoding: 'utf8', timeout: 90_000 });
  const noModuleError = (r) => assert.doesNotMatch(r.stdout + r.stderr, /ERR_MODULE_NOT_FOUND|Cannot find (module|package)/, `CLI 모듈 누락: ${r.stderr}`);
  const st = cli('status'); noModuleError(st); assert.equal(st.status, 0, st.stderr);
  if (process.env.EXPECT_CLI_PUBLIC === '1') await access(join(server, 'bin', 'argo-public.json')); // 발행본은 계정 모드가 가능해야 한다
  // 로컬 모드 한 턴 — 대화 코어·러너·동기화 모듈을 전부 불러온다(깨끗한 HOME이라 AI 미연결 안내로 끝난다)
  await mkdir(cliHome, { recursive: true }); await writeFile(join(cliHome, 'cli.json'), JSON.stringify({ mode: 'local' }));
  const { appDataRoot } = await import(`file://${join(server, 'src', 'cli', 'env.mjs')}`); // 플랫폼별 앱 폴더 — CLI와 같은 함수
  const appRoot = appDataRoot({ env: cliEnv, home });
  const seed = spawnSync(process.execPath, ['--input-type=module', '-e', `const { createCompany, paths } = await import(${JSON.stringify(`file://${join(server, 'src', 'workspace.mjs')}`)}); await createCompany('smoke-co', 'Smoke', 'captain', null, 'en'); (await import('node:fs')).writeFileSync(paths('smoke-co').agents + '/nova.md', '---\\nname: Nova\\nrunner: claude\\n---\\nsmoke\\n');`], { env: { ...cliEnv, ARGO_ROOT: appRoot }, encoding: 'utf8' });
  assert.equal(seed.status, 0, seed.stderr);
  const turn = cli('chat', 'nova', 'hello'); noModuleError(turn);
  // 이 문구는 대화 코어(chat.mjs)만 낸다 — 시작 안내(ensureRunners)의 /ai 문구와 구분해 코어까지 불러왔는지 본다
  assert.match(turn.stdout + turn.stderr, /No AI runner is connected/, `CLI 턴이 코어까지 가지 못했다: ${turn.stdout}${turn.stderr}`);
  console.log(`Server tarball smoke OK: ${version}; clean HOME; HTTP 200; local identity; foreign Host 421; empty local import discovery; argo CLI status + local-mode turn`);
} finally {
  if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
  await rm(temporary, { recursive: true, force: true });
}
