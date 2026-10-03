// 실행 담당(클라우드 리더) 판정은 **실행 리스(daemonLease — 게이트웨이·스케줄러)를 가진 프로세스**만 한다 — 검수 M2, 반대 검토 M-d,
// #791 독립 검수 HIGH-1(2026-10-01).
// 실제 실행 조건은 procLeader && isCloudLeader()다(gateway.mjs ensureGateway, scheduler.mjs ensureScheduler). 프로세스 단위 주인은
// daemonLease(.gateway.lock·.scheduler.lock)이고 동기화 락(.sync-process.lock) 주인과 다른 프로세스로 갈릴 수 있다.
// - 원래 결함(M2): 동기화 락을 못 얻으면 리스 확인 없이 기본값 리더(true)로 남았다 → 이중 실행.
// - #791 1차 수정의 결함(HIGH-1): 동기화 락 주인만 클라우드 리더로 만들어, 락 주인과 게이트웨이 리스 주인이 갈리면 아무도 실행하지 않았다.
// 불변식: 같은 데이터 루트에서 "게이트웨이 리스 && 클라우드 리더"인 프로세스는 정확히 하나(다른 기기가 리스를 쥐면 0).
// 자식 프로세스 + 가짜 Supabase(로컬 HTTP)로 실제 supabase-js·daemonLease 경로째 돌린다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from './helpers/tmp.mjs';
import { startFakeSupabase } from './helpers/fake-supabase-http.mjs';
import { seedRoot, spawnLeaseChild, runnersAt } from './helpers/sync-child.mjs';

const LEASE_KEY = 'companies/u1/_device-lease.json';
const LEASE_PUT = 'POST /storage/v1/object/companies/u1/_device-lease.json';
const FAST = { ARGO_SYNC_CYCLE_MS: '1000' };
const fakes = []; const kids = [];
after(async () => { for (const k of kids) await k.kill(); for (const f of fakes) await f.close(); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function setup() {
  const fake = await startFakeSupabase({ plan: 'pro' }); fakes.push(fake);
  const root = await mkdtemp(join(tmpdir(), 'argo-execlease-'));
  seedRoot(root, { url: fake.url });
  return { fake, root };
}
const child = (o) => { const c = spawnLeaseChild(o); kids.push(c); return c; };
/** 구간 [from, to]를 250ms 간격으로 훑어 게이트웨이 실행 프로세스 수의 최댓값과 마지막 값을 낸다. */
function scan(children, from, to, field = 'proc') {
  let max = 0;
  for (let t = from; t <= to; t += 250) max = Math.max(max, runnersAt(children, t, { field }));
  return { max, end: runnersAt(children, to, { field }) };
}

test('재시작 경쟁(HIGH-1 재현): A 실행 → B 실행 → A 강제 종료 → A\' 실행 — 게이트웨이를 도는 프로세스는 끝에 정확히 하나, 둘이 겹치는 순간 없음', { timeout: 150_000 }, async () => {
  // 순서를 고정한다(검수 재현과 같은 끝 상태가 나오게): B는 동기화 주기를 30초로 길게 둬서, A가 죽은 뒤 동기화 락은 A'이 먼저 잡고
  // 게이트웨이 리스(TTL 15초, 5초마다 확인)는 A'이 뜨기 전에 B가 잡는다 — 동기화 락 주인(A')과 게이트웨이 주인(B)이 갈린 상태.
  const { root } = await setup();
  const A = child({ root, env: FAST, name: 'A' });
  await sleep(4000); // A가 게이트웨이 리스·동기화 락·클라우드 리스를 잡는다
  const B = child({ root, env: { ARGO_SYNC_CYCLE_MS: '30000' }, name: 'B' });
  const bAt = Date.now();
  await sleep(4000);
  assert.equal(runnersAt([A, B], Date.now() - 300), 1, '정상 상태: 하나');
  const killedAt = Date.now(); await A.kill(); A.diedAt = killedAt;
  await sleep(Math.max(0, bAt + 25_000 - Date.now())); // B의 두 번째 동기화 주기(약 30초) 전, 게이트웨이 리스는 B가 잡은 뒤
  const A2 = child({ root, env: FAST, name: "A'" });
  await sleep(Math.max(0, bAt + 42_000 - Date.now())); // B의 두 번째 주기(실행 담당 판정) + 여유
  const all = [A, B, A2];
  const { max, end } = scan(all, killedAt, Date.now() - 300);
  assert.ok(max <= 1, `게이트웨이를 동시에 도는 프로세스가 ${max}개 — 이중 실행`);
  const leaseWarn = all.flatMap((k) => k.err.split('\n').filter((l) => l.includes('리스 갱신 실패')).map((l) => `${k.name}: ${l}`)).join(' | ');
  assert.equal(end, 1, `끝 상태 B=${JSON.stringify(B.last())} A'=${JSON.stringify(A2.last())} — 아무도 실행 안 함(#791 1차 수정: B proc:true cloud:false, A' proc:false cloud:true) 리스 경고: ${leaseWarn || '없음'}`);
  assert.equal(scan(all, Date.now() - 2000, Date.now() - 300, 'sched').end, 1, '루틴 스케줄러도 정확히 하나');
});

test('관찰 전용 동기화 락 주인(대화 화면 — 실행 리스 없음) + 실행 프로세스 → 실행 프로세스가 클라우드 리더(아무도 실행 안 함 방지, M-d)', { timeout: 60_000 }, async () => {
  const { fake, root } = await setup();
  const chat = child({ root, env: { ...FAST, ARGO_NO_LEADER: '1' }, leases: [], name: 'chat' });
  await sleep(2500); // 대화 화면이 동기화 락을 먼저 잡는다
  const run = child({ root, env: { ...FAST, ARGO_PREFER_LEADER: '1' }, name: 'run' });
  await sleep(6000);
  assert.equal(runnersAt([chat, run], Date.now() - 300), 1);
  assert.equal(run.last().proc && run.last().cloud, true);
  assert.equal(chat.last().cloud, false);
  assert.ok(fake.count(LEASE_PUT) >= 1);
  assert.equal(JSON.parse(fake.store.get(LEASE_KEY).toString()).preferred, true);
});

test('관찰 전용 락 주인 + 실행 가능 프로세스 둘 → 클라우드 리더는 게이트웨이 리스를 가진 하나뿐, 리스 쓰기도 한 프로세스만', { timeout: 60_000 }, async () => {
  const { fake, root } = await setup();
  const chat = child({ root, env: { ...FAST, ARGO_NO_LEADER: '1' }, leases: [], name: 'chat' });
  await sleep(2500);
  const B = child({ root, env: FAST, name: 'B' });
  const C = child({ root, env: FAST, name: 'C' });
  await sleep(4000);
  const t0 = Date.now(); const puts0 = fake.count(LEASE_PUT);
  await sleep(8000);
  const { max, end } = scan([chat, B, C], t0, Date.now() - 300);
  assert.equal(max, 1); assert.equal(end, 1);
  const cloudCount = [B, C].filter((k) => k.last().cloud).length;
  assert.equal(cloudCount, 1, '비주인 둘이 다 리더가 되면 리스를 두 배로 쓴다(1차 수정의 결함)');
  assert.ok(fake.count(LEASE_PUT) - puts0 <= 1, `8초 동안 리스 쓰기 ${fake.count(LEASE_PUT) - puts0}회 — 보유자는 30초마다만 쓴다`);
});

test('동기화 락을 쥐었지만 실행 리스가 없는 프로세스는 클라우드 리더가 되지 않고, 실행 리스 주인이 맡는다', { timeout: 60_000 }, async () => {
  const { root } = await setup();
  const syncOnly = child({ root, env: FAST, leases: [], name: 'syncOnly' }); // 대화 화면 표기도 없는 동기화 전용
  await sleep(2500);
  const exec = child({ root, env: FAST, name: 'exec' });
  await sleep(6000);
  assert.equal(syncOnly.last().cloud, false, '게이트웨이를 안 도는 프로세스가 리스를 쥐면 실행 주인이 리더가 못 된다');
  assert.equal(exec.last().proc && exec.last().cloud, true);
});

test('실행 리스 주인 + 다른 기기가 살아 있는 리스를 쥠(우선 기기 아님) → 양보하고 남의 리스를 덮지 않는다', { timeout: 60_000 }, async () => {
  const { fake, root } = await setup();
  fake.store.set(LEASE_KEY, Buffer.from(JSON.stringify({ deviceId: 'other-mac', token: 't0', ts: Date.now() })));
  const k = child({ root, env: FAST, name: 'k' });
  await sleep(5000);
  assert.equal(k.last().proc, true);
  assert.equal(k.last().cloud, false);
  assert.equal(fake.count(LEASE_PUT), 0);
  assert.equal(JSON.parse(fake.store.get(LEASE_KEY).toString()).deviceId, 'other-mac');
});

test('실행 리스 주인이라도 이 기기에 러너가 없으면 양보 그레이스(리스 판정의 러너 양보 그대로)', { timeout: 60_000 }, async () => {
  const { fake, root } = await setup();
  const k = child({ root, env: FAST, runnerUsable: false, name: 'k' });
  await sleep(5000);
  assert.equal(k.last().cloud, false);
  assert.equal(fake.count(LEASE_PUT), 0);
});

test('게이트웨이 리스와 스케줄러 리스가 다른 프로세스로 갈려도 각 데몬은 정확히 한 프로세스에서 돈다(둘 다 참여 — 리스 쓰기만 두 배)', { timeout: 60_000 }, async () => {
  const { root } = await setup();
  const G = child({ root, env: FAST, leases: ['gateway'], name: 'G' });
  const S = child({ root, env: FAST, leases: ['scheduler'], name: 'S' });
  await sleep(7000);
  const t = Date.now() - 300;
  assert.equal(runnersAt([G, S], t, { field: 'proc' }), 1, `게이트웨이 G=${JSON.stringify(G.last())} S=${JSON.stringify(S.last())} ${G.err.slice(-800)}`);
  assert.equal(runnersAt([G, S], t, { field: 'sched' }), 1, '스케줄러 — 한쪽만 참여시키면 다른 쪽 데몬이 멈춘다');
});

test('#791 재검수 LOW-b — 혼자 켜진 실행 프로세스는 첫 동기화 주기에 바로 클라우드 리더가 된다(실행 리스 첫 판정을 기다림 — 기본 8초 주기를 한 번 더 기다리지 않음)', { timeout: 60_000 }, async () => {
  const { fake, root } = await setup();
  const k = child({ root, name: 'solo' }); // 기본 동기화 주기(8초)
  await sleep(6000);
  const first = k.samples.find((x) => x.proc && x.cloud);
  assert.ok(first, `6초 안에 실행 담당이 되지 못했다 — 첫 주기가 리스 첫 판정(150ms)보다 먼저 와서 강등됐다: ${JSON.stringify(k.last())}`);
  assert.ok(first.t - k.startedAt < 4000, `기동 후 ${first.t - k.startedAt}ms`);
  assert.ok(fake.count(LEASE_PUT) >= 1);
});
