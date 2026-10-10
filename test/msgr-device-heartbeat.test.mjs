// 기기 단위 심박(유건 2026-10-10) — 브리지 쪽. 서버 함수는 test/msgr-device-heartbeat-pg.test.mjs가 실제 Postgres로 본다.
// 여기서 잠그는 것: ① 기기 id가 있으면 관리 틱마다 요청 1건(msgr_device_beat)만 — 행 PATCH·업무 심박 요청을 따로 보내지 않는다
// ② 옛 서버(함수 없음)면 종전 PATCH로 물러나고 10분 동안 함수를 다시 부르지 않는다 ③ 다른 오류는 삼키지 않는다
// ④ 넘김 부재중 표시(crewSeen)는 기기 심박을 합친 계산 열로 읽고, 옛 서버면 행 시각으로 ⑤ 기기 id가 없으면(테스트·옛 호출) 종전과 똑같다.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-msgr-devbeat-'));
const { makeDb, drain, deviceBeatRpc } = await import('../src/gateway/msgr.mjs');
const UID = '11111111-1111-4111-8111-111111111111', O1 = 'aaaaaaaa-0000-4000-8000-000000000001', WS = 'ws-devbeat', DEV = 'mac-1234abcd';

beforeEach(() => { deviceBeatRpc.missingAt = 0; deviceBeatRpc.seenMissingAt = 0; });

/** supabase-js 흉내 — 요청마다 기록한다. rpc 결과·select 결과를 주입한다 */
function client({ rpc = () => ({ data: null, error: null }), select = () => ({ data: [], error: null }) } = {}) {
  const reqs = [];
  const chain = (rec) => { const c = { update(v) { rec.update = v; return c; }, select(v) { rec.select = v; return c; }, in(k, v) { rec.in = [k, v]; return c; }, or(f) { rec.or = f; return c; },
    then(res, rej) { return Promise.resolve(rec.select ? select(rec) : { data: null, error: null }).then(res, rej); } }; return c; };
  return { reqs, rpc: async (name, args) => { reqs.push({ rpc: name, args }); return rpc(name, args); }, from: (t) => { const rec = { from: t }; reqs.push(rec); return chain(rec); } };
}

test('기기 id가 있으면 심박은 msgr_device_beat 요청 1건 — 행 PATCH 없음, 업무 기능 표시도 그 안에서', async () => {
  const c = client();
  const r = await makeDb(c).heartbeat(['c1', 'c2'], { wsId: WS, deviceId: DEV });
  assert.deepEqual(r, { device: true });
  assert.deepEqual(c.reqs, [{ rpc: 'msgr_device_beat', args: { p_ws: WS, p_device: DEV, p_crews: ['c1', 'c2'] } }]);
});

test('옛 서버(함수 없음 PGRST202·42883)면 종전 PATCH로 물러나고, 10분 동안 함수를 다시 부르지 않는다', async () => {
  for (const code of ['PGRST202', '42883']) {
    deviceBeatRpc.missingAt = 0;
    const c = client({ rpc: () => ({ data: null, error: { code, message: 'Could not find the function public.msgr_device_beat' } }) });
    const db = makeDb(c);
    assert.equal(await db.heartbeat(['c1'], { wsId: WS, deviceId: DEV }), undefined, '종전 경로는 device 표시 없음 — 호출부가 업무 심박을 따로 보낸다');
    assert.equal(c.reqs.length, 2);
    assert.equal(c.reqs[1].from, 'msgr_crews'); assert.ok(c.reqs[1].update.last_seen_at); assert.match(c.reqs[1].or, /^last_seen_at\.is\.null,last_seen_at\.lt\./);
    await db.heartbeat(['c1'], { wsId: WS, deviceId: DEV });
    assert.equal(c.reqs.filter((x) => x.rpc).length, 1, `${code}: 두 번째 틱은 함수를 다시 부르지 않는다(틱마다 실패할 요청 0)`);
  }
});

test('함수의 다른 오류(권한·입력)는 삼키지 않는다 — 조용히 PATCH로 바꾸지 않는다', async () => {
  const c = client({ rpc: () => ({ data: null, error: { code: '42501', message: 'msgr_device_beat_forbidden' } }) });
  await assert.rejects(makeDb(c).heartbeat(['c1'], { wsId: WS, deviceId: DEV }), /msgr_device_beat_forbidden/);
  assert.equal(c.reqs.length, 1);
  assert.equal(deviceBeatRpc.missingAt, 0);
});

test('기기 id가 없으면 종전과 같다 — PATCH 1건(30초 넘은 행만), 빈 목록이면 요청 0', async () => {
  const c = client(); const db = makeDb(c);
  await db.heartbeat([], { wsId: WS, deviceId: DEV });
  assert.equal(c.reqs.length, 0);
  await db.heartbeat(['c1']);
  assert.equal(c.reqs.length, 1); assert.equal(c.reqs[0].from, 'msgr_crews');  await db.heartbeat(['c1'], { wsId: WS, deviceId: 'x'.repeat(201) });
  assert.equal(c.reqs.length, 2); assert.equal(c.reqs[1].from, 'msgr_crews', '서버가 거절할 기기 id(200자 초과)는 종전 PATCH');
});

const crews = [{ id: 'c-jun', org_id: O1, slug: 'jun', display_name: '준', allow: 'owner', allow_users: [], cursor_msg_id: 0, hosting: 'local' }];
const fakeDb = (heartbeat) => { const calls = []; return { calls, async myCrews() { return crews; }, async personalCrewsInRooms() { return new Set(); }, async crewChannels() { return []; }, async crewScope() { return new Set(); }, async crewInbox() { return []; },
  async heartbeat(ids, beat) { calls.push(['heartbeat', ids, beat]); return heartbeat; }, async workHeartbeat(ids) { calls.push(['workHeartbeat', ids]); }, async setCursor() {}, async approvalsByIds() { return []; }, async channelAccess() { return new Map(); }, async crewMemory() { return null; },
  async myOrgIds() { return [O1]; }, async myCrewRows() { return []; }, async orgAllowDefaults() { return {}; }, async upsertAvailable() {}, async updateCrewInfo() {}, async deleteCrews() {} }; };
const run = (db, deviceId) => drain(WS, { db, uid: UID, enqueue: async () => {}, housekeeping: true, inventory: async () => [{ slug: 'jun', name: '준', role: null }], commandsFor: null, deviceId });

test('drain: 기기 id를 넘기면 심박에 (회사, 기기)를 싣고, 함수가 업무 표시까지 했으면 workHeartbeat를 보내지 않는다', async () => {
  const d = fakeDb({ device: true }); await run(d, DEV);
  assert.deepEqual(d.calls.find(([k]) => k === 'heartbeat'), ['heartbeat', ['c-jun'], { wsId: WS, deviceId: DEV }]);
  assert.equal(d.calls.some(([k]) => k === 'workHeartbeat'), false, '관리 틱 심박 요청 2건 → 1건');
});

test('drain: 옛 서버로 물러났거나(device 표시 없음) 기기 id가 없으면 종전대로 workHeartbeat도 보낸다', async () => {
  const d1 = fakeDb(undefined); await run(d1, DEV);
  assert.deepEqual(d1.calls.find(([k]) => k === 'workHeartbeat')?.[1], ['c-jun']);
  const d2 = fakeDb(undefined); await run(d2, null);
  assert.deepEqual(d2.calls.find(([k]) => k === 'heartbeat'), ['heartbeat', ['c-jun'], null], '기기 id 없음 = 종전 행 심박');
  assert.deepEqual(d2.calls.find(([k]) => k === 'workHeartbeat')?.[1], ['c-jun']);
});

test('넘김 부재중 표시(crewSeen)는 기기 심박을 합친 계산 열로 읽는다 — 옛 서버(계산 열 없음)면 행 시각으로, 10분 기억', async () => {
  const at = '2026-10-10T00:00:00.000Z';
  const c1 = client({ select: (rec) => ({ data: [{ id: 'c1', last_seen_at: at }], error: null, rec }) });
  assert.deepEqual(await makeDb(c1).crewSeen(['c1']), { c1: at });
  assert.equal(c1.reqs[0].select, 'id, last_seen_at:msgr_crew_seen');
  const c2 = client({ select: (rec) => (/msgr_crew_seen/.test(rec.select) ? { data: null, error: { code: '42703', message: 'column msgr_crews.msgr_crew_seen does not exist' } } : { data: [{ id: 'c1', last_seen_at: at }], error: null }) });
  const db2 = makeDb(c2);
  assert.deepEqual(await db2.crewSeen(['c1']), { c1: at });
  assert.deepEqual(c2.reqs.map((r) => r.select), ['id, last_seen_at:msgr_crew_seen', 'id, last_seen_at']);
  await db2.crewSeen(['c1']);
  assert.equal(c2.reqs.length, 3, '두 번째는 계산 열을 다시 시도하지 않는다');
  const c3 = client({ select: () => ({ data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } }) });
  await assert.rejects(makeDb(c3).crewSeen(['c1']), /statement timeout/, '다른 오류는 옛 서버로 오인하지 않는다');
});
