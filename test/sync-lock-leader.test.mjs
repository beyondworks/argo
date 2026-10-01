// 동기화 락을 못 얻은 프로세스의 실행 담당(리더) 판정 — 검수 M2 + 반대 검토 M-d(2026-10-01).
// 결함(수정 전, 재현 확인): cycle()이 락 획득에 실패하면 renewLease 전에 return해서 리더 기본값 true가 그대로 남았다.
//   서버에서 대화 화면(argo)이 락을 쥔 채 argo run이 다시 켜지면, 리스를 한 번도 보지 않고 게이트웨이·스케줄러를 돌렸다.
// 왜 "강등"만으로는 안 되는가(M-d): 락 주인이 관찰 전용(ARGO_NO_LEADER)이면 그 프로세스는 리스를 읽지도 쓰지도 않는다.
//   강등만 하면 아무도 메신저·루틴을 돌리지 않는다. 반대로 락 주인이 실행 담당 가능 프로세스면 이쪽이 리스를 돌리는 순간
//   같은 기기 id(데이터 루트의 .device-id 하나)라 둘 다 리더가 된다. 그래서 락 주인의 종류로 갈라 판정한다.
// 자식 프로세스 + 가짜 Supabase(로컬 HTTP)로 실제 supabase-js 경로째 돌린다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from './helpers/tmp.mjs';
import { startFakeSupabase } from './helpers/fake-supabase-http.mjs';
import { seedRoot, runSyncChild } from './helpers/sync-child.mjs';

const LEASE_KEY = 'companies/u1/_device-lease.json';
const LEASE_PUT = 'POST /storage/v1/object/companies/u1/_device-lease.json';
const MANIFEST_PUT = 'POST /storage/v1/object/companies/u1/co-1234/__manifest__.json';
const fakes = [];
after(async () => { for (const f of fakes) await f.close(); });

async function setup({ lock } = {}) {
  const fake = await startFakeSupabase({ plan: 'pro' }); fakes.push(fake);
  const root = await mkdtemp(join(tmpdir(), 'argo-synclock-'));
  seedRoot(root, { url: fake.url });
  // 살아 있는 다른 프로세스가 락을 쥐고 있다 — 이 테스트 러너의 pid를 빌린다(자식과 다르고 살아 있다)
  if (lock) writeFileSync(join(root, '.sync-process.lock'), JSON.stringify({ pid: process.pid, ts: Date.now(), ...lock }));
  return { fake, root };
}

test('락 주인이 실행 담당 가능 프로세스(옛 형식 락 포함) → 이 프로세스는 리더가 아니고 리스도 쓰지 않는다 [같은 기기 이중 실행 차단]', async () => {
  const { fake, root } = await setup({ lock: {} }); // noLeader 표기 없음 = 앱 사이드카·상주 또는 옛 버전
  const { status } = await runSyncChild({ root, env: { ARGO_PREFER_LEADER: '1' }, waitMs: 2500 });
  assert.match(status.lastError, /다른 프로세스가 동기화 중/);
  assert.equal(status.leader, false, '리스를 확인하지 않은 기본값 리더십이 남으면 안 된다(수정 전: true)');
  assert.equal(fake.count(LEASE_PUT), 0, '같은 기기 id로 리스를 쓰면 락 주인과 둘 다 리더가 된다');
  assert.equal(fake.count(MANIFEST_PUT), 0, '파일 동기화는 락 주인만');
});

test('락 주인이 관찰 전용(대화 화면) + 다른 기기 리스 없음 → 락과 관계없이 리스를 중재해 리더가 된다 [아무도 실행 안 함 방지, M-d]', async () => {
  const { fake, root } = await setup({ lock: { noLeader: true } });
  const { status } = await runSyncChild({ root, env: { ARGO_PREFER_LEADER: '1' }, waitMs: 3000 });
  assert.equal(status.leader, true, '강등만 하면 대화 화면을 열어 둔 서버에서 메신저·루틴이 멈춘다');
  assert.ok(fake.count(LEASE_PUT) >= 1, '리스를 실제로 썼어야 한다(확인된 획득)');
  assert.equal(JSON.parse(fake.store.get(LEASE_KEY).toString()).preferred, true);
  assert.equal(fake.count(MANIFEST_PUT), 0, '파일 동기화는 여전히 락 주인만 한다');
  assert.match(status.lastError, /다른 프로세스가 동기화 중/);
});

test('락 주인이 관찰 전용 + 다른 기기가 살아 있는 리스를 쥠(우선 기기 아님) → 양보한다(리스 판정이 그대로 적용)', async () => {
  const { fake, root } = await setup({ lock: { noLeader: true } });
  fake.store.set(LEASE_KEY, Buffer.from(JSON.stringify({ deviceId: 'other-mac', token: 't0', ts: Date.now() })));
  const { status } = await runSyncChild({ root, waitMs: 2500 });
  assert.equal(status.leader, false);
  assert.equal(fake.count(LEASE_PUT), 0);
  assert.equal(JSON.parse(fake.store.get(LEASE_KEY).toString()).deviceId, 'other-mac', '남의 리스를 덮지 않는다');
});

test('락 주인이 관찰 전용 + 이 기기에 러너가 없음 → 양보 그레이스(리스 판정의 러너 양보도 그대로)', async () => {
  const { fake, root } = await setup({ lock: { noLeader: true } });
  const { status } = await runSyncChild({ root, waitMs: 2500, runnerUsable: false });
  assert.equal(status.leader, false);
  assert.equal(fake.count(LEASE_PUT), 0);
});

test('락을 얻은 대화 화면(ARGO_NO_LEADER=1)은 락 파일에 noLeader를 남기고 리스를 건드리지 않는다 — 위 판정의 근거 표기', async () => {
  const { fake, root } = await setup();
  const { status } = await runSyncChild({ root, env: { ARGO_NO_LEADER: '1' }, waitMs: 2500 });
  const lock = JSON.parse(readFileSync(join(root, '.sync-process.lock'), 'utf8'));
  assert.equal(lock.noLeader, true);
  assert.equal(status.leader, false);
  assert.equal(fake.count('GET /storage/v1/object/companies/u1/_device-lease.json'), 0, '관찰 전용은 리스를 읽지도 않는다');
  assert.equal(fake.count(LEASE_PUT), 0);
});

test('실행 담당 프로세스가 락을 얻으면 락 파일에 noLeader가 없다', async () => {
  const { root } = await setup();
  await runSyncChild({ root, env: { ARGO_PREFER_LEADER: '1' }, waitMs: 2000 });
  const lock = JSON.parse(readFileSync(join(root, '.sync-process.lock'), 'utf8'));
  assert.equal(lock.noLeader, undefined);
});

test('실제 두 프로세스(같은 데이터 루트, 둘 다 실행 담당 가능) → 리더는 락 주인 하나뿐이다 [M-d의 "락과 무관하게 renewLease"를 그대로 따르면 둘 다 리더]', async () => {
  const { fake, root } = await setup();
  const env = { ARGO_PREFER_LEADER: '1', ARGO_SYNC_CYCLE_MS: '1000' };
  const first = runSyncChild({ root, env, waitMs: 7000 }); // 락 주인(앱 사이드카·상주 자리)
  await new Promise((r) => setTimeout(r, 2500)); // 첫 프로세스가 락과 리스를 잡은 뒤
  const second = runSyncChild({ root, env, waitMs: 3500 }); // 뒤에 켜진 argo run 자리
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.status.leader, true, '락 주인은 리스를 확인해 리더');
  assert.equal(b.status.leader, false, '같은 기기 id로 리스를 돌리면 원격 리스가 "내 것"이라 둘 다 리더가 된다');
  assert.match(b.status.lastError, /다른 프로세스가 동기화 중/);
  assert.ok(fake.count(LEASE_PUT) >= 1);
});
