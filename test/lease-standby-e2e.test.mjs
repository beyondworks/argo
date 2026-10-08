// 맥 우선·서버 예비 — 두 기기를 실제 프로세스로 띄워 본다(같은 계정, 같은 가짜 Supabase, 데이터 폴더·기기 id는 따로).
// ① VPS(예비)가 먼저 담당 → 맥(일반)이 켜지면 맥이 되찾고 VPS는 물러난다. 넘어가는 동안 둘이 함께 담당인 순간이 없어야 한다.
//    맥에서 대화를 보내 동기화 주기가 연달아 돌아도(nudgeSync) 같아야 한다(운영 주기 8초 그대로).
//    세션이 끊겨 리스를 확인하지 못하는 예비 기기는 시간이 지나도 맥과 함께 담당이 되지 않는다.
// ② 팀 메신저 브리지는 리스와 무관하게 모든 기기에서 돈다(9/6부터, 실행권은 서버 클레임이 하나로 묶는다). 예비 기기만 담당일 때만 돈다 —
//    VPS가 맥과 함께 켜져 있어도 메신저 일은 맥이 맡게. 일반 기기의 종전 동작은 그대로다(핀).
// 리스 만료(120초)를 기다리는 장면(맥 전원 끔·잠자기)은 테스트 시간이 길어 여기서 돌리지 않는다 — 단위 테스트(lease-standby.test.mjs)와 PR의 실측 기록이 맡는다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from './helpers/tmp.mjs';
import { startFakeSupabase } from './helpers/fake-supabase-http.mjs';
import { seedRoot, spawnLeaseChild, runnersAt, childEnv, srcUrl } from './helpers/sync-child.mjs';

const LEASE_KEY = 'companies/u1/_device-lease.json';
const LEASE_PUT = 'POST /storage/v1/object/companies/u1/_device-lease.json';
const FAST = { ARGO_SYNC_CYCLE_MS: '1000' };
const fakes = []; const kids = [];
after(async () => { for (const k of kids) await k.kill(); for (const f of fakes) await f.close(); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const leaseDoc = (fake) => { const b = fake.store.get(LEASE_KEY); return b ? JSON.parse(b.toString()) : null; };

async function device(fake, deviceId, { msgr = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), `argo-standby-${deviceId}-`));
  seedRoot(root, { url: fake.url });
  writeFileSync(join(root, '.device-id'), deviceId);
  if (msgr) writeFileSync(join(root, 'co-1234', 'company.json'), JSON.stringify({ id: 'co-1234', name: 'Fixture', ownerId: 'u1', msgr: { enabled: true } }));
  return root;
}

test('VPS(예비)가 담당 중에 맥(일반)이 켜지면 맥이 되찾고, 넘어가는 동안 둘이 함께 담당인 순간이 없다 — 이후 리스 쓰기는 담당 기기만 30초에 1번', { timeout: 90_000 }, async () => {
  const fake = await startFakeSupabase({ plan: 'pro' }); fakes.push(fake);
  const vps = spawnLeaseChild({ root: await device(fake, 'dev-vps'), env: { ...FAST, ARGO_STANDBY_LEADER: '1' }, name: 'vps' }); kids.push(vps);
  await sleep(5000);
  assert.equal(vps.last()?.cloud, true, `혼자일 때는 예비 기기가 담당 ${vps.err.slice(-400)}`);
  assert.equal(leaseDoc(fake).standby, true);
  const macAt = Date.now();
  const mac = spawnLeaseChild({ root: await device(fake, 'dev-mac'), env: FAST, name: 'mac' }); kids.push(mac);
  await sleep(9000);
  assert.equal(mac.last()?.proc && mac.last()?.cloud, true, `맥이 되찾는다 ${mac.err.slice(-400)}`);
  assert.equal(vps.last()?.cloud, false, 'VPS는 물러난다');
  assert.equal(leaseDoc(fake).deviceId, 'dev-mac');
  let max = 0;
  for (let t = macAt; t <= Date.now() - 300; t += 100) max = Math.max(max, runnersAt([vps, mac], t));
  assert.equal(max <= 1, true, `넘어가는 동안 담당이 ${max}개 — 이중 실행`);
  const from = Date.now(); const puts0 = fake.count(LEASE_PUT, from);
  await sleep(12_000);
  assert.ok(fake.count(LEASE_PUT, from) - puts0 <= 1, `12초 동안 리스 쓰기 ${fake.count(LEASE_PUT, from)}번 — 담당 기기 30초에 1번을 넘었다`);
  assert.equal(runnersAt([vps, mac], Date.now() - 300), 1);
  await vps.kill(); await mac.kill(); // 다음 장면(운영 주기 타이밍)에 CPU를 나눠 쓰지 않게
});

test('운영 주기(8초)에서 맥이 켜지자마자 대화를 보내도(nudgeSync로 주기가 연달아 돎) 넘어가는 동안 둘이 함께 담당인 순간이 없다', { timeout: 90_000 }, async () => {
  // D 1차 검수: 넘겨받기 대기를 "내 다음 주기"로 세서, nudge가 다음 주기를 바로 돌리면 대기가 사라졌다 — 맥 1.1초 만에 담당, VPS는 3.1초에 물러나 겹침 2초.
  const fake = await startFakeSupabase({ plan: 'pro' }); fakes.push(fake);
  const vps = spawnLeaseChild({ root: await device(fake, 'dev-vps'), env: { ARGO_STANDBY_LEADER: '1' }, name: 'vps', intervalMs: 100 }); kids.push(vps);
  await sleep(6000);
  assert.equal(vps.last()?.cloud, true, `혼자일 때는 예비 기기가 담당 ${vps.err.slice(-400)}`);
  const macAt = Date.now();
  const mac = spawnLeaseChild({ root: await device(fake, 'dev-mac'), name: 'mac', intervalMs: 100, nudgeForMs: 4000 }); kids.push(mac);
  await sleep(22_000);
  assert.equal(mac.last()?.proc && mac.last()?.cloud, true, `맥이 되찾는다 ${mac.err.slice(-400)}`);
  assert.equal(vps.last()?.cloud, false, 'VPS는 물러난다');
  let max = 0;
  for (let t = macAt; t <= Date.now() - 300; t += 100) max = Math.max(max, runnersAt([vps, mac], t));
  assert.equal(max <= 1, true, `넘어가는 동안 담당이 ${max}개 — 맥 담당 시작 ${(mac.samples.find((x) => x.proc && x.cloud)?.t - macAt) / 1000}초, VPS 마지막 담당 ${([...vps.samples].reverse().find((x) => x.cloud)?.t - macAt) / 1000}초`);
  assert.equal(fake.count(LEASE_PUT, macAt), 1, '넘겨받기 쓰기 1번 — 기다리는 주기는 읽기만 한다');
  await vps.kill(); await mac.kill();
});

test('세션이 끊긴 예비 기기(동기화가 리스까지 못 감)는 30초가 지나도 담당이 되지 않는다 — 맥이 담당인 동안 루틴·감시를 함께 돌리지 않게', { timeout: 90_000 }, async () => {
  // D 1차 검수: 예비 기기에도 기동 직후 30초 기본값이 적용돼, 세션 만료 + 이미 쓰인 refresh 토큰인 VPS가 30.1초 뒤 맥과 함께 담당이 됐다.
  const fake = await startFakeSupabase({ plan: 'pro' }); fakes.push(fake);
  const mac = spawnLeaseChild({ root: await device(fake, 'dev-mac'), env: FAST, name: 'mac' }); kids.push(mac);
  await sleep(3000);
  assert.equal(mac.last()?.cloud, true, `맥이 담당 ${mac.err.slice(-400)}`);
  const vRoot = await device(fake, 'dev-vps');
  const burned = 'rt-vps-burned';
  await fetch(`${fake.url}/auth/v1/token?grant_type=refresh_token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refresh_token: burned }) }); // 다른 프로그램이 먼저 회전
  writeFileSync(join(vRoot, '.device-session.json'), JSON.stringify({ url: fake.url, anonKey: 'anon-fixture', access_token: 'h.p.s', refresh_token: burned, expires_at: Math.floor(Date.now() / 1000) - 60, user: { id: 'u1', email: '' } }), { mode: 0o600 });
  const vpsAt = Date.now();
  const vps = spawnLeaseChild({ root: vRoot, env: { ...FAST, ARGO_STANDBY_LEADER: '1' }, name: 'vps' }); kids.push(vps);
  await sleep(34_000);
  assert.match(vps.err, /기기 세션 갱신 실패/, '재현 조건: 예비 기기의 동기화가 리스까지 가지 못한다');
  assert.equal(vps.samples.some((x) => x.cloud), false, `예비 기기가 맥이 담당인데 담당이 됐다 — ${((vps.samples.find((x) => x.cloud)?.t ?? 0) - vpsAt) / 1000}초`);
  assert.equal(mac.last()?.cloud, true, '맥은 계속 담당');
  let max = 0;
  for (let t = vpsAt; t <= Date.now() - 300; t += 100) max = Math.max(max, runnersAt([vps, mac], t));
  assert.equal(max, 1);
  await vps.kill(); await mac.kill();
});

/** 게이트웨이(메신저 브리지 포함) + 동기화를 도는 자식 — 이 기기의 팀 메신저 조회(GET msgr_crews = drain 한 번)를 센다. */
function gatewayChild(root, env) {
  const script = `
globalThis.__argoRunnerProbe = { ts: Date.now(), ok: true };
const sync = await import(${JSON.stringify(srcUrl('sync.mjs'))});
const gw = await import(${JSON.stringify(srcUrl('gateway.mjs'))});
sync.ensureSync(); gw.ensureGateway();
setInterval(() => process.stdout.write('\\n@@' + JSON.stringify({ t: Date.now(), cloud: sync.isCloudLeader() }) + '\\n'), 500);`;
  const p = spawn(process.execPath, ['--input-type=module', '-e', script], { env: childEnv(root, { ...FAST, ...env }), stdio: ['ignore', 'pipe', 'pipe'] });
  const samples = []; let buf = ''; let err = ''; let exited = false;
  p.stdout.on('data', (c) => { buf += c; const lines = buf.split('\n'); buf = lines.pop(); for (const l of lines) if (l.startsWith('@@')) samples.push(JSON.parse(l.slice(2))); });
  p.stderr.on('data', (c) => { err += c; });
  const done = new Promise((r) => p.on('exit', () => { exited = true; r(); }));
  const k = { samples, get err() { return err; }, last: () => samples.at(-1), kill: async () => { if (!exited) { p.kill('SIGKILL'); await done; } } };
  kids.push(k); return k;
}
const MSGR_POLL = 'GET /rest/v1/msgr_crews';

test('VPS(예비)는 맥이 담당인 동안 팀 메신저를 받지 않는다 — 메신저 조회 0(일반 기기는 종전대로 받는다: 핀)', { timeout: 90_000 }, async () => {
  for (const [label, env, expectPolls] of [['예비', { ARGO_STANDBY_LEADER: '1' }, false], ['일반', {}, true]]) {
    const fake = await startFakeSupabase({ plan: 'pro' }); fakes.push(fake);
    const macLease = () => fake.store.set(LEASE_KEY, Buffer.from(JSON.stringify({ deviceId: 'dev-mac', token: 'm', ts: Date.now(), assistant: 2 })));
    macLease(); const iv = setInterval(macLease, 20_000);
    const vps = gatewayChild(await device(fake, 'dev-vps', { msgr: true }), env);
    await sleep(16_000);
    clearInterval(iv);
    const polls = fake.count(MSGR_POLL);
    assert.equal(vps.samples.some((s) => s.cloud), false, `${label}: 맥이 담당이라 이 기기는 담당이 아니다`);
    if (expectPolls) assert.ok(polls > 0, `${label} 기기는 담당이 아니어도 메신저를 받는다(종전) — 조회 ${polls}`);
    else assert.equal(polls, 0, `${label} 기기가 맥이 담당인데 메신저를 받았다 — 조회 ${polls}번 ${vps.err.slice(-300)}`);
    await vps.kill();
  }
});

test('VPS(예비)는 담당이 되면 팀 메신저를 받기 시작하고(공백 동안 온 글은 서버 커서부터), 맥이 되찾으면 멈춘다', { timeout: 120_000 }, async () => {
  const fake = await startFakeSupabase({ plan: 'pro' }); fakes.push(fake);
  fake.store.set(LEASE_KEY, Buffer.from(JSON.stringify({ deviceId: 'dev-mac', token: 'm', ts: Date.now() - 130_000, assistant: 2 }))); // 맥이 꺼진 지 2분 넘음
  const vps = gatewayChild(await device(fake, 'dev-vps', { msgr: true }), { ARGO_STANDBY_LEADER: '1' });
  await sleep(15_000);
  assert.equal(vps.last()?.cloud, true, `만료된 리스는 예비 기기가 가져간다 ${vps.err.slice(-300)}`);
  assert.equal(leaseDoc(fake).standby, true);
  assert.ok(fake.count(MSGR_POLL) > 0, '담당이 된 예비 기기는 메신저를 받는다');
  // 맥이 켜져 리스를 되찾았다(맥의 글) — VPS는 다음 동기화 주기에 물러나고, 게이트웨이 확인(10초)에서 브리지를 내린다
  fake.store.set(LEASE_KEY, Buffer.from(JSON.stringify({ deviceId: 'dev-mac', token: 'm2', ts: Date.now(), assistant: 2 })));
  const macBack = setInterval(() => fake.store.set(LEASE_KEY, Buffer.from(JSON.stringify({ deviceId: 'dev-mac', token: 'm2', ts: Date.now(), assistant: 2 }))), 5_000);
  await sleep(14_000);
  const quietFrom = Date.now();
  await sleep(18_000); // 브리지 폴 주기(15초)보다 길게 — 브리지가 살아 있으면 이 창에 적어도 한 번 조회한다
  clearInterval(macBack);
  assert.equal(vps.last()?.cloud, false);
  assert.equal(fake.count(MSGR_POLL, quietFrom), 0, `맥이 되찾은 뒤에도 VPS가 메신저를 받는다 — ${fake.count(MSGR_POLL, quietFrom)}번`);
});
