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
  // 깨어 있은 지 충분한 맥(되찾기 조건은 단위 테스트·아래 장면이 본다) — 이 장면은 읽기 오류만 본다
  const mac = spawnLeaseChild({ root: await device(fake, 'dev-mac'), name: 'mac', intervalMs: 100, awakeAgoMs: 10 * 60_000 }); kids.push(mac);
  await sleep(42_000); // 읽기 오류 주기(~1초) → 다음 주기(~9초)에 넘겨받기 쓰기 → 대기(2 × 8 + 4초) → 그 뒤 첫 주기(~33초)에 담당
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
