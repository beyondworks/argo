// 맥 우선·서버 예비 — 장애가 낀 넘겨받기를 두 기기 실제 프로세스로 본다(같은 계정·같은 가짜 Supabase, 데이터 폴더·기기 id·접속 토큰은 따로).
// lease-standby-e2e.test.mjs와 따로 둔다: 운영 주기 장면이 길어 한 파일에 두면 그 파일이 전체 테스트의 끝을 늦춘다.
// ① 리스 읽기 오류(D 2차 검수 MEDIUM-1): supabase-js download는 오류를 던지지 않고 { data: null, error }로 준다. error를 보지 않으면 읽기 한 번 실패가
//    '리스 없음'이 되어 예비 VPS가 맥 담당 중에 가져가고(겹침), 되찾는 맥은 넘겨받기 대기 없이 담당이 됐다. 여기서는 실제 supabase-js가 500·끊긴 연결을
//    어떤 모양으로 돌려주는지까지 함께 본다(단위 테스트의 가짜 오류 모양이 실제와 같은지).
// ② 짧게 깬 맥(D 2차 검수 MEDIUM-2): 맥이 W초만 깼다 다시 잠들면(DarkWake·뚜껑 잠깐 열기) 깬 주기에 가져간 리스 때문에 VPS가 물러나고, 맥은 담당을
//    시작하기 전에 잠들어 맥의 글이 만료되는 120초 동안 아무도 맡지 않았다. 운영 값(주기 8초·깨어 있은 시간 30초) 그대로 W=6초를 본다 — 리스 쪽에서
//    보면 잠든 것과 같도록 맥은 SIGKILL로 끈다(검수 실측과 같은 방법).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from './helpers/tmp.mjs';
import { startFakeSupabase } from './helpers/fake-supabase-http.mjs';
import { seedRoot, spawnLeaseChild, runnersAt } from './helpers/sync-child.mjs';

const LEASE_KEY = 'companies/u1/_device-lease.json';
const LEASE_PATH = '/storage/v1/object/companies/u1/_device-lease.json';
const FAST = { ARGO_SYNC_CYCLE_MS: '1000' };
const fakes = []; const kids = [];
after(async () => { for (const k of kids) await k.kill(); for (const f of fakes) await f.close(); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const leaseDoc = (fake) => { const b = fake.store.get(LEASE_KEY); return b ? JSON.parse(b.toString()) : null; };
const auth = (deviceId) => `Bearer ${deviceId}.p.s`;
/** 그 기기의 리스 쓰기 수 — 접속 토큰으로 가른다(기기마다 다른 토큰을 깐다). */
const leasePuts = (fake, deviceId, since = 0, until = Infinity) => fake.hits.filter((h) => h.k === `POST ${LEASE_PATH}` && h.auth === auth(deviceId) && h.t >= since && h.t <= until).length;

async function device(fake, deviceId) {
  const root = await mkdtemp(join(tmpdir(), `argo-standby-fault-${deviceId}-`));
  seedRoot(root, { url: fake.url });
  writeFileSync(join(root, '.device-id'), deviceId);
  writeFileSync(join(root, '.device-session.json'), JSON.stringify({
    url: fake.url, anonKey: 'anon-fixture', access_token: `${deviceId}.p.s`, refresh_token: `rt-${deviceId}`, expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: 'u1', email: '' },
  }), { mode: 0o600 });
  return root;
}
/** 그 기기의 다음 리스 읽기(GET) 하나에 장애를 낸다 — 차례대로 { status } 또는 'reset'(연결 끊김 → fetch failed). */
function armLeaseReadFaults(fake, deviceId, faults) {
  const queue = [...faults];
  fake.fault = (req, path) => (req.method === 'GET' && path === LEASE_PATH && req.headers.authorization === auth(deviceId) && queue.length ? queue.shift() : null);
  return queue;
}
const overlapMax = (children, from, to) => { let max = 0; for (let t = from; t <= to; t += 100) max = Math.max(max, runnersAt(children, t)); return max; };

test('맥이 담당 중에 예비 VPS의 리스 읽기가 500·연결 끊김이어도 VPS는 가져가지 않는다 — 겹침 0, VPS 리스 쓰기 0', { timeout: 60_000 }, async () => {
  const fake = await startFakeSupabase({ plan: 'pro' }); fakes.push(fake);
  const mac = spawnLeaseChild({ root: await device(fake, 'dev-mac'), env: FAST, name: 'mac', intervalMs: 100 }); kids.push(mac);
  await sleep(4000);
  assert.equal(mac.last()?.cloud, true, `맥이 담당 ${mac.err.slice(-300)}`);
  const vpsAt = Date.now();
  const vps = spawnLeaseChild({ root: await device(fake, 'dev-vps'), env: { ...FAST, ARGO_STANDBY_LEADER: '1' }, name: 'vps', intervalMs: 100 }); kids.push(vps);
  for (const fault of [{ status: 500 }, 'reset']) { // 한 번씩 — 첫 읽기 하나만 실패하고 그 뒤 쓰기·재확인은 성공하는 모양(실측과 같은 조건)
    const left = armLeaseReadFaults(fake, 'dev-vps', [fault]);
    const until = Date.now() + 10_000;
    while (left.length && Date.now() < until) await sleep(100);
    assert.equal(left.length, 0, `VPS가 리스를 읽지 않았다 ${vps.err.slice(-300)}`);
    await sleep(3500);
  }
  fake.fault = null;
  const max = overlapMax([mac, vps], vpsAt, Date.now() - 300);
  assert.equal(max, 1, `담당이 ${max}개 — VPS 첫 담당 ${((vps.samples.find((s) => s.cloud)?.t ?? vpsAt) - vpsAt) / 1000}초`);
  assert.equal(vps.samples.some((s) => s.cloud), false, 'VPS가 맥 담당 중에 담당이 됐다');
  assert.equal(leasePuts(fake, 'dev-vps', vpsAt), 0, '읽기 오류로 맥의 살아 있는 리스를 덮어썼다');
  assert.equal(leaseDoc(fake).deviceId, 'dev-mac');
  assert.match(vps.err, /리스 읽기 실패/, '읽기 오류를 로그로 남긴다(supabase-js가 돌려준 오류를 본다)');
  await vps.kill(); await mac.kill();
});

test('운영 주기(8초)에서 VPS(예비)가 담당 중에 되찾는 맥의 첫 리스 읽기가 500이어도 넘겨받기 대기를 건너뛰지 않는다 — 겹침 0, 맥 리스 쓰기 1번', { timeout: 90_000 }, async () => {
  // 운영 주기로 본다: 짧은 주기(1초)에서는 VPS가 맥의 재확인 대기(800ms) 안에 읽고 물러나 수정 전 코드도 겹치지 않았다. 검수 실측(8초): 맥 1.1초에 담당, VPS 3.0초에 물러남.
  const fake = await startFakeSupabase({ plan: 'pro' }); fakes.push(fake);
  const vps = spawnLeaseChild({ root: await device(fake, 'dev-vps'), env: { ARGO_STANDBY_LEADER: '1' }, name: 'vps', intervalMs: 100 }); kids.push(vps);
  const until = Date.now() + 20_000;
  while (!vps.last()?.cloud && Date.now() < until) await sleep(200);
  assert.equal(vps.last()?.cloud, true, `혼자일 때는 예비 기기가 담당 ${vps.err.slice(-300)}`);
  const left = armLeaseReadFaults(fake, 'dev-mac', [{ status: 500 }]);
  const macAt = Date.now();
  // 깨어 있은 지 충분하고 VPS를 전에 만난 적 있는 맥(데이터 폴더 표지) — 되찾는 맥은 보통 앞서 VPS에게 넘긴 적이 있다. 이 장면은 읽기 오류만 본다.
  // 처음 만나는 맥(표지 없음)은 배포본처럼 첫 판정이 실패로 끝나면 담당이다 — 다음 읽기(8초)까지 겹칠 수 있다(PR '남은 것').
  const mRoot = await device(fake, 'dev-mac');
  writeFileSync(join(mRoot, '.lease-peer.json'), JSON.stringify({ deviceId: 'dev-vps', at: Date.now() - 86_400_000 }));
  const mac = spawnLeaseChild({ root: mRoot, name: 'mac', intervalMs: 100, awakeAgoMs: 10 * 60_000 }); kids.push(mac);
  const deadline = Date.now() + 80_000; // 읽기 오류 판정(~1초) → 다음 판정(~9초)에 넘겨받기 쓰기 → 대기(22초) → 그 뒤 첫 판정(~33초)에 담당
  while (!(mac.last()?.proc && mac.last()?.cloud && !vps.last()?.cloud) && Date.now() < deadline) await sleep(200);
  await sleep(2_000);
  fake.fault = null;
  assert.equal(left.length, 0, '맥의 첫 리스 읽기에 장애를 냈다');
  assert.equal(mac.last()?.proc && mac.last()?.cloud, true, `맥이 되찾는다 ${mac.err.slice(-300)}`);
  assert.equal(vps.last()?.cloud, false, 'VPS는 물러난다');
  const max = overlapMax([vps, mac], macAt, Date.now() - 300);
  assert.equal(max, 1, `넘어가는 동안 담당이 ${max}개 — 맥 담당 시작 ${(mac.samples.find((x) => x.proc && x.cloud)?.t - macAt) / 1000}초, VPS 마지막 담당 ${([...vps.samples].reverse().find((x) => x.cloud)?.t - macAt) / 1000}초`);
  const macLeadAt = mac.samples.find((x) => x.proc && x.cloud).t;
  assert.equal(leasePuts(fake, 'dev-mac', macAt, macLeadAt), 1, '담당이 되기까지 넘겨받기 쓰기 1번(읽기 오류 주기는 쓰지 않는다 — 그 뒤는 30초 갱신)');
  assert.match(mac.err, /리스 읽기 실패/);
  await vps.kill(); await mac.kill();
});

test('운영 값(주기 8초·깨어 있은 시간 30초)에서 맥이 6초만 깼다 다시 잠들면 VPS가 계속 맡는다 — 공백 0, 맥 리스 쓰기 0', { timeout: 90_000 }, async () => {
  const fake = await startFakeSupabase({ plan: 'pro' }); fakes.push(fake);
  const vps = spawnLeaseChild({ root: await device(fake, 'dev-vps'), env: { ARGO_STANDBY_LEADER: '1' }, name: 'vps', intervalMs: 100 }); kids.push(vps);
  const until = Date.now() + 20_000;
  while (!vps.last()?.cloud && Date.now() < until) await sleep(200);
  assert.equal(vps.last()?.cloud, true, `혼자일 때는 예비 기기가 담당 ${vps.err.slice(-300)}`);
  const macAt = Date.now();
  const mac = spawnLeaseChild({ root: await device(fake, 'dev-mac'), name: 'mac', intervalMs: 100 }); kids.push(mac);
  await sleep(6000);
  await mac.kill(); // 다시 잠듦 — 리스 쪽에서 보면 꺼진 것과 같다
  await sleep(20_000); // VPS의 동기화 주기(8초) 두 번 이상 — 맥의 글을 읽었다면 이 창에 물러난다
  const gap = vps.samples.filter((s) => s.t >= macAt && !(s.proc && s.cloud));
  assert.equal(gap.length, 0, `VPS가 담당을 놓았다 — 처음 놓은 때 ${((gap[0]?.t ?? 0) - macAt) / 1000}초 ${mac.err.slice(-300)}`);
  assert.equal(mac.samples.some((s) => s.cloud), false);
  assert.equal(leasePuts(fake, 'dev-mac', macAt), 0, '깬 지 30초가 안 된 맥이 리스를 가져갔다');
  assert.equal(leaseDoc(fake).deviceId, 'dev-vps');
  await vps.kill();
});

/* ── D 3차 검수: 리스 판정이 파일 동기화 주기에 묶여 있던 것 ──
   앞 담당(VPS)의 리스 읽기가 동기화 주기 안에 있어, 주기가 길거나(큰 파일 올리기) 리스 읽기가 걸리면(시간 초과 30초) 실패가 이어지면
   넘겨받는 맥이 대기를 마치고 시작한 뒤에도 VPS가 담당으로 남았다(검수 실측: 겹침 80초·21초·39초). 짧은 주기(1초)로 보지만 판정 구조는 운영과 같다. */

/** VPS(예비)가 혼자 담당이 된 뒤, 깨어 있은 지 오래된 맥(일반)이 켜진다 — 그 사이 VPS에 장애(faultFor)를 건다. 겹침·맥 담당 시작·VPS 마지막 담당을 돌려준다. */
async function handoverUnderFault(fake, { vpsFiles = 0, faultFor }) {
  const vRoot = await device(fake, 'dev-vps');
  for (let i = 0; i < vpsFiles; i++) writeFileSync(join(vRoot, 'co-1234', `f${i}.md`), `file ${i}\n`.repeat(20));
  let at = null; // 맥을 켠 시각 — 장애는 VPS를 켜기 전부터 건다(파일 올리기 지연은 VPS 첫 주기부터, 리스 읽기 장애는 맥을 켠 뒤부터 — faultFor가 at으로 가른다)
  fake.fault = (req, path) => faultFor(req, path, at);
  const vps = spawnLeaseChild({ root: vRoot, env: { ...FAST, ARGO_STANDBY_LEADER: '1' }, name: 'vps', intervalMs: 100 }); kids.push(vps);
  assert.equal(await waitUntil(() => vps.last()?.proc && vps.last()?.cloud, 20_000), true, `혼자일 때는 예비 기기가 담당 ${vps.err.slice(-300)}`);
  at = Date.now();
  const mac = spawnLeaseChild({ root: await device(fake, 'dev-mac'), env: FAST, name: 'mac', intervalMs: 100, awakeAgoMs: 10 * 60_000 }); kids.push(mac);
  await waitUntil(() => mac.last()?.proc && mac.last()?.cloud && !vps.last()?.cloud, 60_000);
  await sleep(2_000);
  fake.fault = null;
  const max = overlapMax([vps, mac], at, Date.now() - 300);
  const macOn = (mac.samples.find((x) => x.proc && x.cloud)?.t ?? 0) - at;
  const vpsOff = ([...vps.samples].reverse().find((x) => x.proc && x.cloud)?.t ?? 0) - at;
  await vps.kill(); await mac.kill();
  return { max, macOn, vpsOff, mac, vps, at };
}
const waitUntil = async (pred, ms) => { const u = Date.now() + ms; while (!pred() && Date.now() < u) await sleep(100); return !!pred(); };
const isVps = (req) => req.headers.authorization === auth('dev-vps');

test('앞 담당(VPS)이 긴 동기화 주기(파일 올리기) 중이어도 맥이 넘겨받는 동안 둘이 함께 담당이 되지 않는다 — 리스는 동기화 주기와 따로 돈다', { timeout: 120_000 }, async () => {
  const fake = await startFakeSupabase({ plan: 'pro' }); fakes.push(fake);
  // VPS가 올릴 파일 60개를 하나에 0.5초씩 — 리스를 잡은 첫 동기화 주기가 약 30초. 리스 쓰기·읽기는 늦추지 않는다
  const r = await handoverUnderFault(fake, { vpsFiles: 60, faultFor: (req, path) => (isVps(req) && req.method === 'POST' && path !== LEASE_PATH ? 500 : null) });
  assert.equal(r.max, 1, `넘어가는 동안 담당 ${r.max}개 — 맥 담당 시작 ${r.macOn / 1000}초, VPS 마지막 담당 ${r.vpsOff / 1000}초`);
  const ups = fake.hits.filter((h) => h.auth === auth('dev-vps') && h.k.startsWith('POST /storage/v1/object/companies/u1/co-1234/'));
  assert.ok(ups.at(-1).t >= r.at + r.macOn, `재현 조건: 맥이 담당을 시작할 때 VPS는 아직 첫 동기화 주기(파일 올리기) 중이었다 — 올리기 ${ups.length}번`);
  assert.ok(r.macOn > 0, '맥이 되찾는다');
});

test('앞 담당(VPS)의 리스 읽기가 걸려(응답 없음 → 30초 시간 초과) 맥의 넘겨받기 글을 못 읽어도 대기가 끝나기 전에 스스로 물러난다 — 겹침 0', { timeout: 120_000 }, async () => {
  const fake = await startFakeSupabase({ plan: 'pro' }); fakes.push(fake);
  let hung = false;
  const r = await handoverUnderFault(fake, { faultFor: (req, path, at) => (at && isVps(req) && req.method === 'GET' && path === LEASE_PATH && !hung ? (hung = true, 'hang') : null) });
  assert.equal(hung, true);
  assert.equal(r.max, 1, `넘어가는 동안 담당 ${r.max}개 — 맥 담당 시작 ${r.macOn / 1000}초, VPS 마지막 담당 ${r.vpsOff / 1000}초`);
  assert.ok(r.vpsOff < 25_000, `VPS는 걸린 읽기가 시간 초과(30초)로 끝나기 전에 확인 기한이 지나 물러난다 — 마지막 담당 ${r.vpsOff / 1000}초`);
});

test('앞 담당(VPS)의 리스 읽기가 20초 동안 계속 실패해도(연결 끊김) 대기가 끝나기 전에 스스로 물러난다 — 겹침 0', { timeout: 120_000 }, async () => {
  const fake = await startFakeSupabase({ plan: 'pro' }); fakes.push(fake);
  const r = await handoverUnderFault(fake, { faultFor: (req, path, at) => (at && isVps(req) && req.method === 'GET' && path === LEASE_PATH && Date.now() - at < 20_000 ? 'reset' : null) });
  assert.equal(r.max, 1, `넘어가는 동안 담당 ${r.max}개 — 맥 담당 시작 ${r.macOn / 1000}초, VPS 마지막 담당 ${r.vpsOff / 1000}초`);
});

test('세션이 끊긴 맥(일반)도 다른 기기의 리스를 본 적이 있으면 30초 기본값으로 담당이 되지 않는다 — VPS(예비)가 맡는 동안 겹침 0. 본 적 없는 단일 기기는 배포본처럼 바로 담당', { timeout: 120_000 }, async () => {
  const fake = await startFakeSupabase({ plan: 'pro' }); fakes.push(fake);
  const brokenMac = async (id, { sawPeer }) => {
    const root = await device(fake, id);
    const burned = `rt-${id}-burned`;
    await fetch(`${fake.url}/auth/v1/token?grant_type=refresh_token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refresh_token: burned }) }); // 다른 프로그램이 먼저 회전
    writeFileSync(join(root, '.device-session.json'), JSON.stringify({ url: fake.url, anonKey: 'anon-fixture', access_token: `${id}.p.s`, refresh_token: burned, expires_at: Math.floor(Date.now() / 1000) - 60, user: { id: 'u1', email: '' } }), { mode: 0o600 });
    if (sawPeer) writeFileSync(join(root, '.lease-peer.json'), JSON.stringify({ deviceId: 'dev-vps', at: Date.now() - 86_400_000 }));
    return root;
  };
  // ① 다른 기기를 본 적 없는 단일 기기 — 배포본처럼 기동하자마자 담당(동기화가 안 되는 단일 기기의 루틴이 멈추지 않게)
  const solo = spawnLeaseChild({ root: await brokenMac('dev-solo', { sawPeer: false }), env: FAST, name: 'solo', intervalMs: 100 }); kids.push(solo);
  assert.equal(await waitUntil(() => solo.last()?.proc && solo.last()?.cloud, 10_000), true, `단일 기기는 세션이 끊겨도 배포본처럼 담당 ${solo.err.slice(-300)}`);
  await solo.kill();
  // ② VPS(예비)가 담당 + 다른 기기를 본 적 있는 맥(세션 끊김) — 40초(30초 기본값을 넘김) 동안 맥은 담당이 아니다
  const vps = spawnLeaseChild({ root: await device(fake, 'dev-vps'), env: { ...FAST, ARGO_STANDBY_LEADER: '1' }, name: 'vps', intervalMs: 100 }); kids.push(vps);
  assert.equal(await waitUntil(() => vps.last()?.proc && vps.last()?.cloud, 20_000), true);
  const at = Date.now();
  const mac = spawnLeaseChild({ root: await brokenMac('dev-mac', { sawPeer: true }), env: FAST, name: 'mac', intervalMs: 100 }); kids.push(mac);
  await sleep(40_000);
  assert.match(mac.err, /기기 세션 갱신 실패/, '재현 조건: 맥의 동기화가 리스까지 가지 못한다');
  assert.equal(mac.samples.some((x) => x.proc && x.cloud), false, `세션이 끊긴 맥이 VPS가 맡는 동안 담당이 됐다 — ${((mac.samples.find((x) => x.proc && x.cloud)?.t ?? at) - at) / 1000}초`);
  assert.equal(overlapMax([vps, mac], at, Date.now() - 300), 1);
  await vps.kill(); await mac.kill();
});
