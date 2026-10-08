// 예비(standby) 실행 기기 — 맥이 켜진 동안은 맥이, 맥이 꺼지거나 연결이 끊기면 서버(VPS)가 실행 담당을 맡고, 맥이 다시 켜지면 맥이 되찾는다(유건 요구 2026-10-08).
// 역할 순위: 우선(argo run 기본) > 일반(맥 앱·상주·--no-prefer) > 예비(argo run --standby). 더 높은 역할의 기기는 낮은 역할이 잡은 새 리스를
// **러너가 있을 때만** 가져오고(그레이스로도 우회하지 않는다), 가져올 때는 한 주기를 기다려 앞 담당이 물러난 뒤에 담당을 시작한다(겹침 0).
// 담당이던 기기가 잠들었다 깨면 그 사이 다른 기기가 가져갔을 수 있으므로 다시 확인하기 전까지 담당이 아니다.
// 가짜 저장소로 renewLease 결선을 직접 구동한다(leader-prefer.test.mjs와 같은 방식). 쓰기 횟수는 DB 위생(storage.objects 업서트) 기준이다.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-standby-'));
process.env.ARGO_SYNC = '1';
writeFileSync(join(process.env.ARGO_ROOT, '.device-session.json'), JSON.stringify({ url: 'https://example.invalid', anonKey: 'anon', access_token: 'a.b.c', refresh_token: 'r', expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: 'u-standby', email: '' } }), { mode: 0o600 });
for (const k of ['ARGO_PREFER_LEADER', 'ARGO_NO_LEADER', 'ARGO_STANDBY_LEADER']) delete process.env[k];
const { renewLease, isCloudLeader, standbyIdle, _setSyncClientForTest, LEASE_TTL_MS, YIELD_GRACE_MS, HANDOVER_WAIT_MS } = await import('../src/sync.mjs');
const { leaseRole } = await import('../src/lease-role.mjs');
const { getDeviceId } = await import('../src/workspace.mjs');
const ME = await getDeviceId();

const fakeClient = (initialDoc = null) => {
  const calls = { upload: 0, download: 0 };
  let stored = initialDoc ? Buffer.from(JSON.stringify(initialDoc)) : null;
  const bucket = {
    async download() {
      calls.download += 1;
      if (!stored) return { data: null, error: { message: 'Object not found' } };
      const buf = stored;
      return { data: { arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) } };
    },
    async upload(_key, blob) { calls.upload += 1; stored = Buffer.from(await blob.arrayBuffer()); return { data: {}, error: null }; },
  };
  return {
    client: { storage: { from: () => bucket } }, calls,
    doc: () => (stored ? JSON.parse(stored.toString()) : null),
    set: (doc) => { stored = Buffer.from(JSON.stringify(doc)); }, // 다른 기기의 쓰기
  };
};
const lease = () => (globalThis.__argoSyncLease ??= { leader: true, checkedAt: 0, ownedAt: 0, yieldSince: 0 });
const reset = (patch = {}) => Object.assign(lease(), { leader: true, ownedAt: 0, checkedAt: 0, yieldSince: 0, pending: null }, patch);
const role = (r) => {
  delete process.env.ARGO_PREFER_LEADER; delete process.env.ARGO_STANDBY_LEADER;
  if (r === 'preferred') process.env.ARGO_PREFER_LEADER = '1';
  if (r === 'standby') process.env.ARGO_STANDBY_LEADER = '1';
};
afterEach(() => role('normal'));
const fresh = (deviceId, extra = {}) => ({ deviceId, token: `t-${deviceId}`, ts: Date.now(), assistant: 2, ...extra });
/** 넘겨받기 대기(HANDOVER_WAIT_MS)가 지난 것으로 — 내 글을 쓴 시각(메모리)만 앞당긴다. 리스 글의 ts는 그대로라 보유 시각 단언이 흔들리지 않는다. */
const elapseHandover = () => { if (lease().pending) lease().pending.ts -= HANDOVER_WAIT_MS; };

/* ── 역할 ── */

test('역할: 예비 > 우선 표지 순으로 읽고, 둘 다 없으면 일반 — 둘 다 켜져 있으면 예비(가져가지 않는 쪽)', () => {
  assert.equal(leaseRole({}), 'normal');
  assert.equal(leaseRole({ ARGO_PREFER_LEADER: '1' }), 'preferred');
  assert.equal(leaseRole({ ARGO_STANDBY_LEADER: '1' }), 'standby');
  assert.equal(leaseRole({ ARGO_PREFER_LEADER: '1', ARGO_STANDBY_LEADER: '1' }), 'standby');
});

/* ── 예비 기기(VPS) ── */

test('예비 기기는 다른 기기(일반·우선·예비)가 잡은 새 리스에 양보한다 — 쓰기 0', async () => {
  role('standby');
  for (const doc of [fresh('mac'), fresh('srv', { preferred: true }), fresh('vps2', { standby: true })]) {
    const f = fakeClient(doc); _setSyncClientForTest(f.client); reset();
    for (let i = 0; i < 3; i++) await renewLease('owner-s1', { runnerUsable: true });
    assert.equal(lease().leader, false, `${doc.deviceId}에 양보`);
    assert.equal(f.calls.upload, 0);
  }
});

test('예비 기기는 리스가 만료됐을 때만 가져오고, 리스 글에 standby 표지를 남긴다', async () => {
  role('standby');
  const f = fakeClient({ ...fresh('mac'), ts: Date.now() - LEASE_TTL_MS - 1_000 });
  _setSyncClientForTest(f.client); reset();
  await renewLease('owner-s2', { runnerUsable: true });
  assert.equal(lease().leader, true);
  assert.equal(f.calls.upload, 1);
  assert.equal(f.doc().standby, true);
  assert.equal(f.doc().preferred, undefined);
});

test('예비 기기가 담당일 때 갱신 간격은 일반 기기와 같다 — 30초 안에는 쓰지 않는다(DB 위생)', async () => {
  role('standby');
  const f = fakeClient(fresh(ME, { standby: true }));
  _setSyncClientForTest(f.client); reset({ leader: true, ownedAt: Date.now() - 5_000 });
  await renewLease('owner-s3', { runnerUsable: true });
  assert.equal(f.calls.upload, 0);
  assert.equal(lease().leader, true);
  reset({ leader: true, ownedAt: Date.now() - (LEASE_TTL_MS / 4 + 1_000) });
  await renewLease('owner-s3', { runnerUsable: true });
  assert.equal(f.calls.upload, 1);
  assert.equal(f.doc().standby, true, '갱신 글에도 표지가 남는다');
});

/* ── 일반 기기(맥)의 되찾기 ── */

test('맥(일반·러너 있음)은 예비 기기가 잡은 새 리스를 되찾는다 — 가져온 주기는 쓰기만 하고 담당이 아니며, 넘겨받기 대기(한 주기 + 2초) 뒤 그 글이 그대로면 담당(쓰기 합계 1)', async () => {
  const f = fakeClient(fresh('vps', { standby: true }));
  _setSyncClientForTest(f.client); reset({ leader: false });
  await renewLease('owner-m1', { runnerUsable: true });
  assert.equal(lease().leader, false, '앞 담당(VPS)이 다음 주기에 이 글을 읽고 물러날 때까지 담당을 시작하지 않는다 — 둘이 겹치지 않게');
  assert.equal(f.calls.upload, 1);
  assert.equal(f.doc().deviceId, ME);
  assert.equal(f.doc().standby, undefined);
  elapseHandover();
  await renewLease('owner-m1', { runnerUsable: true });
  assert.equal(lease().leader, true);
  assert.equal(f.calls.upload, 1, '확인 주기는 쓰지 않는다');
  assert.ok(Date.now() - lease().ownedAt < 5_000, '보유 시각 = 넘겨받은 글을 쓴 시각(30초 갱신 규칙의 기준)');
});

test('넘겨받기 대기는 주기 수가 아니라 시간으로 센다 — 맥에서 대화를 보내 동기화 주기가 연달아 돌아도(nudgeSync) 대기 시간 전에는 담당이 아니고 쓰지 않는다', async () => {
  for (const [label, r, doc] of [['맥(일반) ← 예비', 'normal', fresh('vps', { standby: true })], ['우선 ← 일반', 'preferred', fresh('mac-app')]]) {
    role(r);
    const f = fakeClient(doc);
    _setSyncClientForTest(f.client); reset({ leader: false });
    for (let i = 0; i < 6; i++) await renewLease('owner-h1', { runnerUsable: true });
    assert.equal(lease().leader, false, `${label}: 앞 담당이 리스를 다시 읽을 시간(한 주기 + 2초)이 지나기 전에는 담당을 시작하지 않는다 — 둘이 함께 담당인 창`);
    assert.equal(isCloudLeader(), false, label);
    assert.equal(f.calls.upload, 1, `${label}: 기다리는 주기는 읽기만 한다(쓰기 합계 1)`);
    assert.ok(f.calls.download >= 6, label);
    elapseHandover();
    await renewLease('owner-h1', { runnerUsable: true });
    assert.equal(lease().leader, true, `${label}: 대기 시간이 지난 뒤 그 글이 그대로면 담당`);
    assert.equal(f.calls.upload, 1, label);
  }
  assert.ok(HANDOVER_WAIT_MS > 8_000, '운영 주기(8초)보다 길다');
});

test('되찾는 사이 VPS가 마침 갱신해 내 글을 덮었으면 다시 넘겨받기를 시도한다(담당 시작 안 함)', async () => {
  const f = fakeClient(fresh('vps', { standby: true }));
  _setSyncClientForTest(f.client); reset({ leader: false });
  await renewLease('owner-m2', { runnerUsable: true });
  f.set(fresh('vps', { standby: true, token: 't-vps-renew' })); // VPS의 30초 갱신이 내 글 뒤에 도착
  await renewLease('owner-m2', { runnerUsable: true });
  assert.equal(lease().leader, false);
  assert.equal(f.calls.upload, 2);
  assert.equal(f.doc().deviceId, ME);
  elapseHandover();
  await renewLease('owner-m2', { runnerUsable: true });
  assert.equal(lease().leader, true);
  assert.equal(f.calls.upload, 2);
});

test('맥에 러너가 없으면 예비 기기의 새 리스를 가져오지 않는다 — 그레이스가 지나도(답할 수 없는 기기가 담당을 뺏으면 안 된다)', async () => {
  const f = fakeClient(fresh('vps', { standby: true }));
  _setSyncClientForTest(f.client); reset({ leader: false });
  await renewLease('owner-m3', { runnerUsable: false });
  Object.assign(lease(), { yieldSince: Date.now() - YIELD_GRACE_MS - 1_000 });
  f.set(fresh('vps', { standby: true }));
  await renewLease('owner-m3', { runnerUsable: false });
  assert.equal(lease().leader, false);
  assert.equal(f.calls.upload, 0);
});

test('일반 기기끼리는 종전대로 먼저 잡은 쪽을 존중한다 — 맥 두 대가 서로 뺏지 않는다', async () => {
  const f = fakeClient(fresh('macbook'));
  _setSyncClientForTest(f.client); reset({ leader: false });
  for (let i = 0; i < 3; i++) await renewLease('owner-m4', { runnerUsable: true });
  assert.equal(lease().leader, false);
  assert.equal(f.calls.upload, 0);
});

/* ── 우선 기기 ── */

test('우선 기기는 예비 기기의 새 리스도 가져온다(우선 > 예비)', async () => {
  role('preferred');
  const f = fakeClient(fresh('vps', { standby: true }));
  _setSyncClientForTest(f.client); reset({ leader: false });
  await renewLease('owner-p1', { runnerUsable: true });
  elapseHandover();
  await renewLease('owner-p1', { runnerUsable: true });
  assert.equal(lease().leader, true);
  assert.equal(f.doc().preferred, true);
  assert.equal(f.calls.upload, 1);
});

test('러너 없는 우선 기기는 그레이스(160초)가 지나도 러너 있는 일반 기기의 새 리스를 빼앗지 않는다(배포본: 그레이스 뒤 빼앗았다)', async () => {
  role('preferred');
  const f = fakeClient(fresh('mac-with-runner'));
  _setSyncClientForTest(f.client); reset({ leader: false });
  await renewLease('owner-p2', { runnerUsable: false });
  Object.assign(lease(), { yieldSince: Date.now() - YIELD_GRACE_MS - 1_000 });
  f.set(fresh('mac-with-runner'));
  await renewLease('owner-p2', { runnerUsable: false });
  assert.equal(lease().leader, false);
  assert.equal(f.calls.upload, 0);
});

/* ── 잠들었다 깬 담당 ── */

test('담당이던 기기가 리스 TTL보다 오래 리스를 다시 쓰지 못했으면(잠자기·멈춘 동기화) 다시 확인하기 전까지 담당이 아니다', () => {
  reset({ leader: true, ownedAt: Date.now() - LEASE_TTL_MS - 1_000, checkedAt: Date.now() - LEASE_TTL_MS - 1_000 });
  assert.equal(isCloudLeader(), false, '깬 직후 첫 스케줄러 틱이 낡은 표시로 루틴을 다시 돌리면 안 된다 — 그 사이 다른 기기가 돌렸을 수 있다');
  reset({ leader: true, ownedAt: Date.now() - 40_000, checkedAt: Date.now() - 2_000 });
  assert.equal(isCloudLeader(), true, '정상 보유자(30초마다 갱신)는 그대로');
});

test('기동 직후(리스 확인 전 기본값)는 첫 확인까지 담당이 아니다 — 다른 기기가 담당인데 맥 앱이 켜진 몇 초 동안 둘이 함께 담당이던 창. 30초 안에 확인하지 못하면 종전대로 담당', () => {
  reset();
  assert.equal(isCloudLeader(), false, '첫 리스 확인 전');
  assert.equal(isCloudLeader(Date.now() + 31_000), true, '30초 안에 리스까지 못 가면(세션 만료 등) 종전대로 담당 — 단일 기기 루틴이 멈추지 않게');
  reset({ leader: true, ownedAt: 0, checkedAt: Date.now() });
  assert.equal(isCloudLeader(), true, '리스를 확인했는데 기본값이 남은 경우(로컬 회사 0개 등)');
});

test('예비 기기는 기동 직후 기본값으로 담당이 되지 않는다 — 리스를 확인하지 못한 채(세션 만료 등) 30초가 지나도. 확인된 신선한 보유일 때만 담당이고, 메신저 판정(standbyIdle)과 늘 같다', () => {
  role('standby');
  reset();
  assert.equal(isCloudLeader(), false);
  assert.equal(isCloudLeader(Date.now() + 31_000), false, '맥이 담당인지 알 수 없는 예비 기기가 30초 뒤 맡으면 맥과 같은 루틴을 함께 돌린다(D 1차 검수 실측)');
  assert.equal(isCloudLeader(Date.now() + 10 * 60_000), false);
  reset({ leader: true, ownedAt: 0, checkedAt: Date.now() });
  assert.equal(isCloudLeader(), false, '리스를 읽었어도 가져오지 않았으면(ownedAt 0) 담당이 아니다');
  reset({ leader: true, ownedAt: Date.now() - 5_000, checkedAt: Date.now() });
  assert.equal(isCloudLeader(), true, '리스를 가져온 예비 기기는 담당');
  const states = [{}, { leader: false, checkedAt: Date.now() }, { leader: true, ownedAt: 0, checkedAt: Date.now() }, { leader: true, ownedAt: Date.now() - 5_000 },
    { leader: true, ownedAt: Date.now() - LEASE_TTL_MS - 1, checkedAt: Date.now() - LEASE_TTL_MS - 1 }];
  for (const st of states) for (const dt of [0, 31_000]) {
    reset(st);
    assert.equal(standbyIdle(Date.now() + dt), !isCloudLeader(Date.now() + dt), `예비 기기의 스케줄러·감시(isCloudLeader)와 메신저(standbyIdle) 판정이 갈리면 안 된다 ${JSON.stringify(st)} +${dt}`);
  }
  role('normal'); reset();
  assert.equal(isCloudLeader(Date.now() + 31_000), true, '일반 기기는 종전대로 30초 뒤 담당(동기화가 안 되는 단일 기기의 루틴이 멈추지 않게) — 핀');
});

test('깬 맥이 다음 주기에 리스를 다시 확인하면 — VPS가 가져갔으면 넘겨받기, 아무도 안 가져갔으면 바로 담당', async () => {
  const f = fakeClient(fresh('vps', { standby: true }));
  _setSyncClientForTest(f.client); reset({ leader: true, ownedAt: Date.now() - 10 * 60_000, checkedAt: Date.now() - 10 * 60_000 });
  await renewLease('owner-w1', { runnerUsable: true });
  assert.equal(isCloudLeader(), false);
  elapseHandover();
  await renewLease('owner-w1', { runnerUsable: true });
  assert.equal(isCloudLeader(), true);
  const g = fakeClient({ ...fresh(ME), ts: Date.now() - 10 * 60_000 });
  _setSyncClientForTest(g.client); reset({ leader: true, ownedAt: Date.now() - 10 * 60_000, checkedAt: Date.now() - 10 * 60_000 });
  await renewLease('owner-w2', { runnerUsable: true });
  assert.equal(isCloudLeader(), true);
  assert.equal(g.calls.upload, 1);
});

/* ── 예비 기기의 메신저 ── */

test('standbyIdle — 예비 기기이고 확인된 담당이 아닐 때만 참(그때 팀 메신저를 받지 않는다). 일반·우선 기기는 늘 거짓(종전대로 메신저를 받는다)', () => {
  role('standby');
  reset(); assert.equal(standbyIdle(), true, '기동 직후 기본값(리스 확인 전)은 담당으로 치지 않는다 — 맥이 담당인데 VPS가 켜지자마자 메신저를 받으면 겹친다');
  reset({ leader: false, checkedAt: Date.now() }); assert.equal(standbyIdle(), true);
  reset({ leader: true, ownedAt: Date.now() - 10_000, checkedAt: Date.now() }); assert.equal(standbyIdle(), false);
  reset({ leader: true, ownedAt: Date.now() - LEASE_TTL_MS - 1, checkedAt: Date.now() - LEASE_TTL_MS - 1 }); assert.equal(standbyIdle(), true);
  role('normal'); reset({ leader: false, checkedAt: Date.now() }); assert.equal(standbyIdle(), false);
  role('preferred'); reset({ leader: false, checkedAt: Date.now() }); assert.equal(standbyIdle(), false);
});
