// 0.1.123 — 앱과 데이터 폴더를 같이 쓰는 argo CLI는 앱 서버가 없을 때만 동기화한다(고객 C 2026-10-30: 0.1.122 꼬리표 sync/off — CLI가 ARGO_SYNC=0이라
// 앱을 켜지 않고 CLI로만 쓴 회사가 클라우드에 올라가지 않았다). 사이클마다 앱 서버 표식(.server-presence.json)을 보고, 앱이 살아 있으면 요청 없이 물러나며
// 내 잠금을 놓는다. 앱이 없으면 같은 .sync-process.lock으로 동기화하고, 끝나면 내 잠금을 지운다.
// 자식 프로세스 + 가짜 Supabase로 실제 루프(ensureSync)를 돈다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from './helpers/tmp.mjs';
import { startFakeSupabase } from './helpers/fake-supabase-http.mjs';
import { childEnv, srcUrl, seedRoot } from './helpers/sync-child.mjs';
import { syncDiagTag } from '../src/sync.mjs';

const fakes = [];
after(async () => { for (const f of fakes) await f.close(); });
const uploads = (fake, from = 0, to = Infinity) => fake.hits.filter((h) => h.t >= from && h.t < to && /^(POST|PUT) \/storage\/v1\/object\/companies\//.test(h.k)).length;
const anyHits = (fake, from, to) => fake.hits.filter((h) => h.t >= from && h.t < to).length;

function runChild(root, script, env = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', script], { env: childEnv(root, { ARGO_AGENT_LINK: '0', ARGO_SYNC_CYCLE_MS: '300', ARGO_SYNC_YIELD_TO_APP: '1', ...env }), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    p.stdout.on('data', (c) => { out += c; }); p.stderr.on('data', (c) => { err += c; });
    const t = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`child timeout\n${err.slice(-1500)}`)); }, 60_000);
    p.on('exit', () => {
      clearTimeout(t);
      const marks = Object.fromEntries(out.split('\n').filter((l) => l.startsWith('@@')).map((l) => JSON.parse(l.slice(2))).map((m) => [m.at, m]));
      resolve({ marks, out: out + err });
    });
  });
}

test('앱 공유 CLI — 앱 표식이 살아 있으면 물러나고(요청 0·잠금 안 잡음), 없으면 동기화하고, 앱이 켜지면 잠금을 놓고, 끝나면 내 잠금을 지운다(경우 표 K1·K3·K4·K5·K7)', async () => {
  const fake = await startFakeSupabase({ plan: 'pro' }); fakes.push(fake);
  const root = await mkdtemp(join(tmpdir(), 'argo-0123-yield-'));
  seedRoot(root, { url: fake.url, wsId: 'co-cli' });
  const lock = join(root, '.sync-process.lock');
  // 표식의 pid = 이 시험 프로세스(자식의 부모 — 살아 있는 남의 pid). 실제 앱 사이드카가 부팅 때 쓰는 것과 같은 모양(server-presence.mjs writePresence).
  const script = `
const fs = await import('node:fs');
const { join } = await import('node:path');
const pres = join(process.env.ARGO_ROOT, '.server-presence.json');
const lockF = join(process.env.ARGO_ROOT, '.sync-process.lock');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lockPid = () => { try { return JSON.parse(fs.readFileSync(lockF, 'utf8')).pid; } catch { return null; } };
const mark = (at, extra = {}) => process.stdout.write('\\n@@' + JSON.stringify({ at, t: Date.now(), phase: globalThis.__argoSyncStatus?.phase ?? null, lockPid: lockPid(), me: process.pid, ...extra }) + '\\n');
fs.writeFileSync(pres, JSON.stringify({ pid: process.ppid, at: Date.now() }));
globalThis.__argoRunnerProbe = { ts: Date.now(), ok: true };
const sync = await import(${JSON.stringify(srcUrl('sync.mjs'))});
mark('start');
sync.ensureSync();
await sleep(2000); mark('appUp');           // ① 앱이 살아 있다 — 물러남
fs.rmSync(pres); mark('appGone');
await sleep(3000); mark('cliSynced');       // ② 앱이 없다 — CLI가 동기화
fs.writeFileSync(pres, JSON.stringify({ pid: process.ppid, at: Date.now() })); mark('appBack');
await sleep(2000); mark('cliYielded');      // ③ 앱이 다시 켜졌다 — 잠금을 놓는다
fs.rmSync(pres);
await sleep(2000); mark('cliAgain');        // ④ 앱이 꺼졌다 — 다시 이어받는다
process.exit(0);                            // ⑤ 정상 종료 — 내 잠금을 지운다
`;
  const { marks, out } = await runChild(root, script);
  const m = marks;
  assert.ok(m.start && m.appUp && m.appGone && m.cliSynced && m.appBack && m.cliYielded && m.cliAgain, out.slice(-1500));
  // ①
  assert.equal(m.appUp.phase, 'yield', '앱이 살아 있으면 단계 yield');
  assert.equal(m.appUp.lockPid, null, '앱이 살아 있으면 잠금을 잡지 않는다');
  assert.equal(anyHits(fake, m.start.t, m.appUp.t), 0, '앱이 살아 있는 동안 CLI의 서버 요청 0(세션 갱신·요금제·저장소 모두)');
  // ②
  assert.equal(m.cliSynced.lockPid, m.cliSynced.me, '앱이 없으면 CLI가 같은 잠금을 잡는다');
  assert.ok(uploads(fake, m.appGone.t, m.cliSynced.t) > 0, 'CLI가 회사를 올렸다');
  // ③ — 다음 사이클(300ms) 안에 물러나 잠금을 놓고, 그 뒤 업로드는 없다
  assert.equal(m.cliYielded.phase, 'yield');
  assert.notEqual(m.cliYielded.lockPid, m.cliYielded.me, '앱이 켜지면 CLI가 잠금을 놓는다(앱이 이어받는다)');
  assert.equal(uploads(fake, m.appBack.t + 1000, m.cliYielded.t), 0, '물러난 뒤 업로드 0');
  // ④
  assert.equal(m.cliAgain.lockPid, m.cliAgain.me, '앱이 꺼지면 CLI가 다시 이어받는다');
  // ⑤
  assert.equal(existsSync(lock), false, 'CLI가 끝나면 내 잠금을 지운다 — 앱이 기다리지 않는다');
});

test('앱 공유 CLI가 아니면(앱 서버·상주) 앱 표식이 있어도 종전대로 동기화한다(경우 표 K2·K12)', async () => {
  const fake = await startFakeSupabase({ plan: 'pro' }); fakes.push(fake);
  const root = await mkdtemp(join(tmpdir(), 'argo-0123-noyield-'));
  seedRoot(root, { url: fake.url, wsId: 'co-app' });
  const script = `
const fs = await import('node:fs');
fs.writeFileSync(process.env.ARGO_ROOT + '/.server-presence.json', JSON.stringify({ pid: process.ppid, at: Date.now() }));
globalThis.__argoRunnerProbe = { ts: Date.now(), ok: true };
const sync = await import(${JSON.stringify(srcUrl('sync.mjs'))});
sync.ensureSync();
await new Promise((r) => setTimeout(r, 2500));
process.stdout.write('\\n@@' + JSON.stringify({ at: 'end', phase: globalThis.__argoSyncStatus?.phase }) + '\\n');
process.exit(0);`;
  const { marks } = await runChild(root, script, { ARGO_SYNC_YIELD_TO_APP: '' });
  assert.notEqual(marks.end.phase, 'yield');
  assert.ok(uploads(fake) > 0, '표식은 앱 공유 CLI만 본다');
});

test('진단 꼬리표 — 보낸 쪽(.pcli/.papp)을 값이 있을 때만 덧붙이고, 종전 형식은 그대로다(경우 표 K10)', () => {
  const held = { phase: 'idle', errorCode: '', noOwner: 0, foreignOwner: 0 };
  assert.equal(syncDiagTag(held), 'sync/idle.-.-.o0f0.c0', '값이 없으면 종전 그대로');
  assert.equal(syncDiagTag(held, { role: 'cli' }), 'sync/idle.-.-.o0f0.c0.pcli');
  assert.equal(syncDiagTag({ ...held, phase: 'yield', errorCode: 'app-running' }, { role: 'cli' }), 'sync/yield.app-running.-.o0f0.c0.pcli');
  assert.equal(syncDiagTag(held, { role: 'app', watchdog: 1 }), 'sync/idle.-.-.o0f0.c0.w1.papp');
  assert.equal(syncDiagTag(held, { role: 'x y' }), 'sync/idle.-.-.o0f0.c0', '정한 값만');
});

test('앱 공유 CLI 프로세스의 30분 확인 요청 꼬리표에 .pcli가 실리고, argo/<버전> 추출은 그대로다(고객 C 꼬리표 재현의 고친 판)', async () => {
  const fake = await startFakeSupabase({ plan: 'pro' }); fakes.push(fake);
  const xci = [];
  fake.fault = (req, path) => { if (path.endsWith('/rpc/argo_min_app_version')) xci.push(String(req.headers['x-client-info'] ?? '')); return null; };
  const root = await mkdtemp(join(tmpdir(), 'argo-0123-tag-'));
  seedRoot(root, { url: fake.url, wsId: 'co-tag' });
  const script = `
globalThis.__argoRunnerProbe = { ts: Date.now(), ok: true };
const sync = await import(${JSON.stringify(srcUrl('sync.mjs'))});
sync.ensureSync();
await new Promise((r) => setTimeout(r, 1500));
const { getFreshDeviceSession } = await import(${JSON.stringify(srcUrl('devicesession.mjs'))});
await getFreshDeviceSession();
await new Promise((r) => setTimeout(r, 800));
process.stdout.write('\\n@@' + JSON.stringify({ at: 'end' }) + '\\n');
process.exit(0);`;
  await runChild(root, script, { NODE_TEST_CONTEXT: '' });
  assert.ok(xci.length >= 1, '확인 요청이 나갔다');
  const last = xci.at(-1);
  assert.match(last, / sync\/[a-z-]+\.[^ ]*\.pcli$/, last);
  assert.doesNotMatch(last, /sync\/off\./, 'CLI 단독이면 동기화가 켜져 있다(종전 sync/off)');
  assert.equal(/ argo\/([0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4})/.exec(last)?.[1], JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
});

test('CLI 한 번 실행 명령은 동기화 루프를 띄우지 않는다 — ensureSync는 대화형 입구와 (앱 공유가 아닐 때의) 회사 찾기에만 있다(경우 표 K9)', () => {
  const src = readFileSync(new URL('../bin/argo.mjs', import.meta.url), 'utf8');
  const calls = [...src.matchAll(/ensureSync\(\)/g)].map((m) => m.index);
  assert.equal(calls.length, 2, 'bin/argo.mjs의 ensureSync 호출은 두 곳');
  const interactiveAt = src.indexOf('async function interactive()');
  const pickAt = src.indexOf('async function pickCompany(');
  const appExit = src.indexOf('if (!list.length && uid !== \'local\' && appShared) { console.error(T.appNoCompany); process.exit(1); }');
  assert.ok(appExit > pickAt && calls.some((i) => i > appExit && i < interactiveAt), '회사 찾기의 ensureSync는 앱 공유 CLI가 먼저 끝난 뒤(앱 공유는 여기서 루프를 띄우지 않는다)');
  assert.ok(calls.some((i) => i > interactiveAt), '대화형 입구');
});
