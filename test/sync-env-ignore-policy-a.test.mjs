// 정책 A(2026-10-31) — 데스크톱 앱 사이드카(ARGO_PARENT_PID)와 앱 공유 CLI는 물려받은 ARGO_SYNC=0을 따르지 않는다. 셸에 남은 값 하나로 로그인한 앱의
// 동기화가 꺼졌다(2026-10-30 고객 C 추정 — src-tauri lib.rs는 부모 env를 지우지 않는다). 상주·셀프호스트·dev·타르볼 CLI는 종전대로 존중한다.
// 무시했으면 로그 한 줄과 꼬리표 .e1(값이 있을 때만 끝에 — 서버 버전 추출 영향 0).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from './helpers/tmp.mjs';
import { startFakeSupabase } from './helpers/fake-supabase-http.mjs';
import { childEnv, srcUrl, seedRoot } from './helpers/sync-child.mjs';
import { ignoreInheritedSyncOff, syncDiagTag, syncHeldView } from '../src/sync.mjs';
import { applyCliEnv } from '../src/cli/env.mjs';

const RUNNERS_SHARED = new URL('../src/runners/shared.mjs', import.meta.url).href;

const fakes = [];
after(async () => { for (const f of fakes) await f.close(); });

test('ignoreInheritedSyncOff — 사이드카 자신(ARGO_PARENT_PID = 내 ppid)에서 ARGO_SYNC=0일 때만 지운다(경우 표 P1·P3·P8·P11)', () => {
  const prev = globalThis.__argoSyncEnvIgnored;
  try {
    const side = { ARGO_PARENT_PID: '4242', ARGO_SYNC: '0' };
    assert.equal(ignoreInheritedSyncOff(side, 4242), true); assert.equal('ARGO_SYNC' in side, false, 'P1 지운다');
    assert.equal(globalThis.__argoSyncEnvIgnored, true, '꼬리표 표시');
    for (const env of [{ ARGO_SYNC: '0' }, { ARGO_PARENT_PID: '', ARGO_SYNC: '0' }, { ARGO_PARENT_PID: 'x', ARGO_SYNC: '0' }]) {
      assert.equal(ignoreInheritedSyncOff(env, 4242), false, `P3 상주·셀프호스트 ${JSON.stringify(env)}`); assert.equal(env.ARGO_SYNC, '0');
    }
    const desc = { ARGO_PARENT_PID: '4242', ARGO_SYNC: '0' };
    assert.equal(ignoreInheritedSyncOff(desc, 5151), false, 'P11 사이드카의 자손(부모가 Tauri가 아님)이 직접 준 값은 존중'); assert.equal(desc.ARGO_SYNC, '0');
    for (const v of ['1', '', undefined]) {
      const env = { ARGO_PARENT_PID: '4242', ...(v === undefined ? {} : { ARGO_SYNC: v }) };
      assert.equal(ignoreInheritedSyncOff(env, 4242), false, `P8 ARGO_SYNC=${v}`); assert.equal(env.ARGO_SYNC, v);
    }
  } finally { globalThis.__argoSyncEnvIgnored = prev; }
});

test('꼬리표 .e1 — 무시했을 때만 맨 끝에 붙는다(경우 표 P9)', () => {
  const held = syncHeldView({ phase: 'idle' }, { on: true, loopStarted: true });
  assert.equal(syncDiagTag(held, { role: 'app' }), 'sync/idle.-.-.o0f0.c0.papp');
  assert.equal(syncDiagTag(held, { role: 'app', envIgnored: true }), 'sync/idle.-.-.o0f0.c0.papp.e1');
  assert.equal(syncDiagTag(held, { envIgnored: false }), 'sync/idle.-.-.o0f0.c0');
});

test('applyCliEnv — 앱 공유 CLI는 물려받은 ARGO_SYNC=0을 지우고, 타르볼·저장소·폴더를 직접 준 CLI는 존중한다(경우 표 P2·P5)', async () => {
  const base = await mkdtemp(join(tmpdir(), 'argo-policyA-cli-'));
  const shared = { HOME: join(base, 'h'), ARGO_CLI_HOME: join(base, 'c1'), ARGO_CLI_APP: '1', ARGO_SYNC: '0' };
  applyCliEnv({ repoRoot: base, env: shared, platform: 'darwin', execPath: '/usr/bin/node' });
  assert.equal('ARGO_SYNC' in shared, false, 'P2 앱 공유 CLI'); assert.equal(shared.ARGO_SYNC_YIELD_TO_APP, '1');
  const srv = { HOME: join(base, 'h'), ARGO_CLI_HOME: join(base, 'c2'), ARGO_SYNC: '0' };
  applyCliEnv({ repoRoot: base, env: srv, platform: 'linux', execPath: '/usr/bin/node' });
  assert.equal(srv.ARGO_SYNC, '0', 'P5 서버 타르볼·저장소 CLI');
  const own = { HOME: join(base, 'h'), ARGO_CLI_HOME: join(base, 'c3'), ARGO_CLI_APP: '1', ARGO_ROOT: join(base, 'mine'), ARGO_SYNC: '0' };
  applyCliEnv({ repoRoot: base, env: own, platform: 'darwin', execPath: '/usr/bin/node' });
  assert.equal(own.ARGO_SYNC, '0', '앱 폴더를 같이 쓰지 않으면 앱 공유가 아니다');
  const desc = { HOME: join(base, 'h'), ARGO_CLI_HOME: join(base, 'c4'), ARGO_CLI_APP: '1', ARGO_PARENT_PID: '4242', ARGO_SYNC: '0' };
  applyCliEnv({ repoRoot: base, env: desc, platform: 'darwin', execPath: '/usr/bin/node' });
  assert.equal(desc.ARGO_SYNC, '0', 'P12 앱이 띄운 자손(크루 Bash의 argo)이 직접 준 값은 존중 — 사이드카는 자기 env에서 이미 지웠다');
});

/* ─── 실제 기동(instrumentation-node.mjs) ─── */
function boot(root, env) {
  const body = `
globalThis.__argoRunnerProbe = { ts: Date.now(), ok: true };
await import(${JSON.stringify(new URL('../instrumentation-node.mjs', import.meta.url).href)});
await new Promise((r) => setTimeout(r, 2500));
const sync = await import(${JSON.stringify(srcUrl('sync.mjs'))});
const s = sync.syncStatus();
process.stdout.write('\\n@@' + JSON.stringify({ on: s.on, held: s.held, tag: globalThis.__argoSyncDiagTag?.() ?? null, envSync: process.env.ARGO_SYNC ?? null }) + '\\n');
process.exit(0);`;
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', body], { env: childEnv(root, { ARGO_AGENT_LINK: '0', ARGO_SYNC: '0', NODE_TEST_CONTEXT: '', ...env }), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (c) => { out += c; }); p.stderr.on('data', (c) => { out += c; });
    const t = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`timeout\n${out.slice(-2000)}`)); }, 60_000);
    p.on('exit', () => {
      clearTimeout(t);
      const line = out.split('\n').find((l) => l.startsWith('@@'));
      if (!line) return reject(new Error(`no result\n${out.slice(-2000)}`));
      resolve({ r: JSON.parse(line.slice(2)), out });
    });
  });
}
const IGNORED_LOG = '[argo] sync: 데스크톱 앱은 ARGO_SYNC=0을 따르지 않습니다(무시)';

test('사이드카 기동 + 물려받은 ARGO_SYNC=0 + 기기 세션 — 로그 한 줄, 동기화가 돌고 꼬리표 .papp.e1(경우 표 P1, 고객 C)', async () => {
  const fake = await startFakeSupabase({ plan: 'pro' }); fakes.push(fake);
  const root = await mkdtemp(join(tmpdir(), 'argo-policyA-side-'));
  seedRoot(root, { url: fake.url, wsId: 'co-a' });
  const { r, out } = await boot(root, { ARGO_PARENT_PID: String(process.pid) });
  assert.equal(out.split('\n').filter((l) => l.startsWith(IGNORED_LOG)).length, 1, out.slice(-1500));
  assert.equal(r.envSync, null, '자기 process.env에서 지웠다 — 뒤에 뜨는 자식(러너·MCP)도 물려받지 않는다(P7)');
  assert.equal(r.on, true); assert.notEqual(r.held.phase, 'off'); assert.notEqual(r.held.errorCode, 'env', '설정 카드에 환경변수 문구가 나오지 않는다');
  assert.match(r.tag, /\.papp\.e1$/, r.tag);
  assert.ok(fake.hits.some((h) => h.k.includes('/storage/')), '실제로 저장소 요청이 나갔다(동기화가 돈다)');
});

test('상주·셀프호스트(ARGO_PARENT_PID 없음) + ARGO_SYNC=0 — 종전대로 꺼짐(off.env), 무시 로그 없음(경우 표 P3·P4)', async () => {
  const fake = await startFakeSupabase({ plan: 'pro' }); fakes.push(fake);
  const root = await mkdtemp(join(tmpdir(), 'argo-policyA-resident-'));
  seedRoot(root, { url: fake.url, wsId: 'co-b' });
  const { r, out } = await boot(root, {});
  assert.equal(out.includes(IGNORED_LOG), false);
  assert.equal(r.envSync, '0'); assert.equal(r.on, false); assert.equal(r.held.errorCode, 'env');
  assert.equal(fake.hits.filter((h) => h.k.includes('/storage/')).length, 0);
});

test('사이드카, 로그인 없음 — ARGO_SYNC는 지우지만 세션이 없어 off.nosess(종전 안내)(경우 표 P6)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'argo-policyA-nosess-')); mkdirSync(root, { recursive: true });
  const { r } = await boot(root, { ARGO_PARENT_PID: String(process.pid) });
  assert.equal(r.envSync, null); assert.equal(r.on, false); assert.equal(r.held.errorCode, 'nosess');
});

test('사이드카의 자손(크루 Bash가 띄운 dev·셀프호스트 서버)이 ARGO_SYNC=0을 직접 주면 존중 — 무시 로그 없음, 꺼짐, 저장소 요청 0(경우 표 P11, PR #1196 검수 I1)', async () => {
  const fake = await startFakeSupabase({ plan: 'pro' }); fakes.push(fake);
  const rootA = await mkdtemp(join(tmpdir(), 'argo-policyA-descA-')); mkdirSync(rootA, { recursive: true });
  const rootB = await mkdtemp(join(tmpdir(), 'argo-policyA-descB-'));
  seedRoot(rootB, { url: fake.url, wsId: 'co-d' });
  // A = 사이드카(ARGO_PARENT_PID = 이 시험 프로세스 = A의 ppid). A는 기동한 뒤 러너 env(scrubServerSecrets)에 ARGO_SYNC=0을 직접 넣어 B(서버)를 띄운다.
  const bBody = `globalThis.__argoRunnerProbe = { ts: Date.now(), ok: true };
await import(${JSON.stringify(new URL('../instrumentation-node.mjs', import.meta.url).href)});
await new Promise((r) => setTimeout(r, 2500));
const sync = await import(${JSON.stringify(srcUrl('sync.mjs'))});
const s = sync.syncStatus();
process.stdout.write('\\n@@' + JSON.stringify({ on: s.on, held: s.held, envSync: process.env.ARGO_SYNC ?? null, inherited: process.env.ARGO_PARENT_PID ?? null }) + '\\n');
process.exit(0);`;
  const aBody = `
await import(${JSON.stringify(new URL('../instrumentation-node.mjs', import.meta.url).href)});
const { scrubServerSecrets } = await import(${JSON.stringify(RUNNERS_SHARED)});
const { spawnSync } = await import('node:child_process');
const env = { ...scrubServerSecrets(process.env, 'claude'), ARGO_ROOT: ${JSON.stringify(rootB)}, HOME: ${JSON.stringify(rootB)}, ARGO_SYNC: '0' };
const r = spawnSync(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(bBody)}], { env, encoding: 'utf8', timeout: 50_000 });
const line = (r.stdout || '').split('\\n').find((l) => l.startsWith('@@'));
process.stdout.write('\\nBLOG ' + JSON.stringify(r.stdout + r.stderr) + '\\n');
process.stdout.write('\\n' + (line ?? '@@null') + '\\n');
process.exit(0);`;
  const { r, out } = await new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', aBody], { env: childEnv(rootA, { ARGO_AGENT_LINK: '0', ARGO_SYNC: '0', NODE_TEST_CONTEXT: '', ARGO_PARENT_PID: String(process.pid) }), stdio: ['ignore', 'pipe', 'pipe'] });
    let o = '';
    p.stdout.on('data', (c) => { o += c; }); p.stderr.on('data', (c) => { o += c; });
    const t = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`timeout\n${o.slice(-2000)}`)); }, 60_000);
    p.on('exit', () => { clearTimeout(t); const line = o.split('\n').filter((l) => l.startsWith('@@')).at(-1); if (!line || line === '@@null') return reject(new Error(`no result\n${o.slice(-2000)}`)); resolve({ r: JSON.parse(line.slice(2)), out: o }); });
  });
  const bLog = JSON.parse(out.split('\n').find((l) => l.startsWith('BLOG ')).slice(5));
  assert.equal(out.split('\n').filter((l) => l.startsWith(IGNORED_LOG)).length, 1, 'A(사이드카)는 무시한다');
  assert.equal(r.inherited, String(process.pid), 'B는 ARGO_PARENT_PID를 물려받았다(재현 조건)');
  assert.equal(bLog.includes(IGNORED_LOG), false, 'B는 무시 로그를 남기지 않는다');
  assert.equal(r.envSync, '0'); assert.equal(r.on, false); assert.equal(r.held.errorCode, 'env');
  assert.equal(fake.hits.filter((h) => h.k.includes('/storage/')).length, 0, '저장소 요청 0');
});
