// 무료 계정도 최신 앱이면 에이전트 4명까지(유건 2026-10-11) — 브리지 쪽. 서버 판정은 test/msgr-free-new-app-pg.test.mjs가 실제 Postgres로 본다.
// 여기서 잠그는 것:
//   ① 기기 심박에 앱 버전(package.json — 번들에서는 next.config가 넣는 NEXT_PUBLIC_APP_VERSION)을 싣는다. 요청 수는 그대로 1건.
//   ② 옛 서버(버전 인자 없는 함수 — PGRST202)면 같은 틱에 버전 없이 한 번 다시 보내고 10분 기억한다. 그때 멈춘 행은 빼고 보낸다(종전 함수는 받은 행의 last_seen_at을 쓴다).
//   ③ drain: 멈춘 행만 있는 회사도 심박은 나간다(같은 조회 1건으로 멈춘 행을 함께 받는다) — 멈춘 행은 받은 글·턴을 돌리지 않는다.
//   ④ 자동 켜기: 옛 설정 화면이 꺼 둔(멈춘 행만 남은) 회사는 다시 켠다 — 사람이 해제한 회사는 그대로.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-msgr-freebeat-'));
const { makeDb, drain, deviceBeatRpc, APP_VERSION, autoEnableMsgr, appMeetsMin } = await import('../src/gateway/msgr.mjs');
const UID = '11111111-1111-4111-8111-111111111111', O1 = 'aaaaaaaa-0000-4000-8000-000000000001', WS = 'ws-freebeat', DEV = 'mac-1234abcd';
const PKG = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

beforeEach(() => { deviceBeatRpc.missingAt = 0; deviceBeatRpc.seenMissingAt = 0; deviceBeatRpc.versionMissingAt = 0; });

/** supabase-js 흉내 — 요청마다 기록한다. rpc 결과·select 결과를 주입한다 */
function client({ rpc = () => ({ data: null, error: null }), select = () => ({ data: [], error: null }) } = {}) {
  const reqs = [];
  const chain = (rec) => { const c = { update(v) { rec.update = v; return c; }, select(v) { rec.select = v; return c; }, in(k, v) { (rec.in ??= []).push([k, v]); return c; }, eq(k, v) { (rec.eq ??= []).push([k, v]); return c; }, neq(k, v) { rec.neq = [k, v]; return c; }, limit(n) { rec.limit = n; return c; }, or(f) { rec.or = f; return c; },
    then(res, rej) { return Promise.resolve(rec.select ? select(rec) : { data: null, error: null }).then(res, rej); } }; return c; };
  return { reqs, rpc: async (name, args) => { reqs.push({ rpc: name, args }); return rpc(name, args); }, from: (t) => { const rec = { from: t }; reqs.push(rec); return chain(rec); } };
}
const missing = (name, args) => ('p_app_version' in args ? { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.msgr_device_beat(p_app_version, p_crews, p_device, p_ws) in the schema cache' } } : { data: null, error: null });

test('① 앱 버전 = package.json 버전(번들 밖) — 번들(NEXT_PUBLIC_APP_VERSION이 있으면)은 그 값이 먼저', () => {
  assert.equal(APP_VERSION, PKG);
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', "const m = await import('./src/gateway/msgr.mjs'); console.log(m.APP_VERSION);"],
    { cwd: new URL('..', import.meta.url), env: { PATH: process.env.PATH, HOME: process.env.HOME, ARGO_ROOT: process.env.ARGO_ROOT, NEXT_PUBLIC_APP_VERSION: '9.8.7' }, encoding: 'utf8' });
  assert.equal(r.stdout.trim().split('\n').pop(), '9.8.7', r.stderr);
});

test('① 기기 심박 1건에 앱 버전을 싣는다 — 쉬는 동안 요청 수는 그대로', async () => {
  const c = client();
  assert.deepEqual(await makeDb(c).heartbeat(['c1'], { wsId: WS, deviceId: DEV }), { device: true });
  assert.deepEqual(c.reqs, [{ rpc: 'msgr_device_beat', args: { p_ws: WS, p_device: DEV, p_crews: ['c1'], p_app_version: PKG } }]);
});

test('② 옛 서버(버전 인자 없음): 같은 틱에 버전 없이 다시 보내고 10분 기억 — 멈춘 행은 빼고, 멈춘 행뿐이면 보내지 않는다', async () => {
  const c = client({ rpc: missing, select: () => ({ data: [{ id: 'a1', status: 'active' }, { id: 'p1', status: 'paused' }], error: null }) });
  const db = makeDb(c);
  await db.myCrews(UID, WS, { withPaused: true }); // drain이 같은 조회로 멈춘 행을 받는다
  assert.deepEqual(await db.heartbeat(['a1', 'p1'], { wsId: WS, deviceId: DEV }), { device: true });
  const rpcs = c.reqs.filter((r) => r.rpc);
  assert.deepEqual(rpcs.map((r) => r.args), [
    { p_ws: WS, p_device: DEV, p_crews: ['a1', 'p1'], p_app_version: PKG },
    { p_ws: WS, p_device: DEV, p_crews: ['a1'] },
  ], '옛 함수에는 멈춘 행을 싣지 않는다');
  await db.heartbeat(['a1', 'p1'], { wsId: WS, deviceId: DEV });
  assert.deepEqual(c.reqs.filter((r) => r.rpc).slice(2).map((r) => r.args), [{ p_ws: WS, p_device: DEV, p_crews: ['a1'] }], '두 번째 틱은 바로 옛 호출(실패할 요청 0)');
  const before = c.reqs.length;
  assert.equal(await db.heartbeat(['p1'], { wsId: WS, deviceId: DEV }), undefined);
  assert.equal(c.reqs.length, before, '멈춘 행뿐이면 옛 서버에 아무것도 보내지 않는다');
});

test('② 함수가 아예 없는 서버면 종전 PATCH — 멈춘 행은 빼고(last_seen_at을 쓰지 않는다)', async () => {
  const c = client({ rpc: () => ({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } }), select: (rec) => (rec.from === 'msgr_crews' && rec.select?.includes('status') ? { data: [{ id: 'a1', status: 'active' }, { id: 'p1', status: 'paused' }], error: null } : { data: null, error: null }) });
  const db = makeDb(c);
  await db.myCrews(UID, WS, { withPaused: true });
  await db.heartbeat(['a1', 'p1'], { wsId: WS, deviceId: DEV });
  const patch = c.reqs.find((r) => r.update);
  assert.deepEqual(patch.in, [['id', ['a1']]]);
});

test('② 버전을 실은 호출의 다른 오류(권한·입력)는 삼키지 않는다', async () => {
  const c = client({ rpc: () => ({ data: null, error: { code: '22023', message: 'msgr_device_beat_invalid' } }) });
  await assert.rejects(makeDb(c).heartbeat(['c1'], { wsId: WS, deviceId: DEV }), /msgr_device_beat_invalid/);
  assert.equal(c.reqs.length, 1); assert.equal(deviceBeatRpc.versionMissingAt, 0);
});

test('③ myCrews: 기본은 활성 행만(다른 호출부 그대로), withPaused는 같은 한 조회로 멈춘 행도', async () => {
  const c = client({ select: () => ({ data: [], error: null }) });
  const db = makeDb(c);
  await db.myCrews(UID, WS);
  await db.myCrews(UID, WS, { withPaused: true });
  assert.deepEqual(c.reqs[0].eq, [['owner_user_id', UID], ['ws_id', WS], ['status', 'active']], '기본은 종전 요청 그대로');
  assert.equal(c.reqs[0].in, undefined);
  assert.deepEqual(c.reqs[1].in, [['status', ['active', 'paused']]]);
  assert.doesNotMatch(c.reqs[0].select, /status/); assert.match(c.reqs[1].select, /, status$/);
});

const fakeDb = (rows) => { const calls = []; return { calls,
  async myCrews(uid, ws, opt) { calls.push(['myCrews', opt ?? null]); return rows; }, async personalCrewsInRooms() { return new Set(); }, async crewChannels(id) { calls.push(['crewChannels', id]); return []; }, async crewScope() { return new Set(); },
  async crewInbox(id) { calls.push(['crewInbox', id]); return []; }, async inboxMany(ids) { calls.push(['inboxMany', ids]); return []; },
  async heartbeat(ids, beat) { calls.push(['heartbeat', ids, beat]); return { device: true }; }, async workHeartbeat(ids) { calls.push(['workHeartbeat', ids]); }, async setCursor() {}, async approvalsByIds() { return []; }, async channelAccess() { return new Map(); }, async crewMemory() { return null; },
  async myOrgIds() { return [O1]; }, async myCrewRows() { return rows; }, async orgAllowDefaults() { return {}; }, async upsertAvailable() {}, async updateCrewInfo() {}, async deleteCrews() {} }; };
const run = (db) => drain(WS, { db, uid: UID, enqueue: async () => {}, housekeeping: true, inventory: async () => [{ slug: 'jun', name: '준', role: null }, { slug: 'mia', name: '미아', role: null }], commandsFor: null, deviceId: DEV });
const row = (id, slug, status, org = O1) => ({ id, org_id: org, slug, display_name: slug, allow: 'owner', allow_users: [], cursor_msg_id: 0, hosting: 'local', status });

test('③ drain: 멈춘 행만 있는 회사도 심박이 나간다(새 앱을 서버에 알린다) — 받은 글·턴은 돌리지 않는다', async () => {
  const d = fakeDb([row('p-jun', 'jun', 'paused'), row('p-mia', 'mia', 'paused')]);
  const out = await run(d);
  assert.equal(out.crews, 0);
  assert.deepEqual(d.calls.find(([k]) => k === 'myCrews'), ['myCrews', { withPaused: true }]);
  assert.deepEqual(d.calls.find(([k]) => k === 'heartbeat'), ['heartbeat', ['p-jun', 'p-mia'], { wsId: WS, deviceId: DEV }]);
  assert.equal(d.calls.some(([k]) => ['crewInbox', 'inboxMany', 'crewChannels'].includes(k)), false, '멈춘 행은 받은 글을 읽지 않는다');
});

test('③ drain: 활성 행이 있으면 지금과 같다 — 멈춘 행은 턴 대상이 아니다, 상태 없는 행(옛 흉내)은 활성으로', async () => {
  const d = fakeDb([row('a-jun', 'jun', 'active'), row('p-mia', 'mia', 'paused')]);
  const out = await run(d);
  assert.equal(out.crews, 1); assert.deepEqual(out.list.map((c) => c.id), ['a-jun']);
  assert.deepEqual(d.calls.find(([k]) => k === 'heartbeat')[1], ['a-jun'], '조직 활성 행이 있으면 기기 행은 그 행으로 선다(멈춘 행을 더 싣지 않는다)');
  const d2 = fakeDb([{ ...row('x-jun', 'jun', undefined) }]);
  assert.equal((await run(d2)).crews, 1);
});

test('④ 자동 켜기: 멈춘 행만 남아 꺼진 회사는 다시 켠다 — 행이 있어도 멈춘 행이 없으면(사람이 해제) 그대로', async () => {
  const mk = (paused, minApp = PKG) => { const calls = { updates: [], pausedAsked: 0 }; return { calls, deps: {
    probes: new Map(), orgCache: new Map(), now: () => 1_000_000, timeoutMs: 50, log: () => {},
    session: async () => ({ uid: 'u1', db: { myOrgIds: async () => ['org-1'], hasAnyCrew: async () => true, hasPausedCrew: async (uid, ws) => { calls.pausedAsked += 1; assert.equal(ws, 'ws-a'); return paused; }, myAgentPause: async () => (minApp === null ? null : { min_app: minApp }) } }),
    load: async (ws) => ({ id: ws, msgr: { enabled: false } }),
    update: async (ws, patch) => { calls.updates.push(typeof patch === 'function' ? patch({ msgr: { enabled: false } }) : patch); } } }; };
  const on = mk(true);
  assert.equal(await autoEnableMsgr('ws-a', { company: { id: 'ws-a', ownerId: 'u1', msgr: { enabled: false } }, ...on.deps }), true);
  assert.deepEqual(on.calls.updates, [{ msgr: { enabled: true } }]);
  const offc = mk(false);
  assert.equal(await autoEnableMsgr('ws-a', { company: { id: 'ws-a', ownerId: 'u1', msgr: { enabled: false } }, ...offc.deps }), false);
  assert.deepEqual(offc.calls.updates, []); assert.equal(offc.calls.pausedAsked, 1);
});

test('④ hasPausedCrew: 이 회사의 내 멈춘 사람 에이전트 행 1건 조회', async () => {
  const c = client({ select: () => ({ data: [{ id: 'p1' }], error: null }) });
  assert.equal(await makeDb(c).hasPausedCrew(UID, WS), true);
  assert.deepEqual(c.reqs[0].eq, [['owner_user_id', UID], ['ws_id', WS], ['status', 'paused']]);
});

test('⑤ 심박이 재개 신호(resume)를 주면 msgr_free_resume을 따로 부른다 — 재개가 실패해도 심박은 성공(검수 #945 LOW-6)', async () => {
  for (const resumeErr of [null, { code: '57014', message: 'canceling statement due to statement timeout' }]) {
    const c = client({ rpc: (name) => (name === 'msgr_device_beat' ? { data: { resume: true }, error: null } : { data: null, error: resumeErr }) });
    assert.deepEqual(await makeDb(c).heartbeat(['p1'], { wsId: WS, deviceId: DEV }), { device: true });
    assert.deepEqual(c.reqs.map((r) => r.rpc), ['msgr_device_beat', 'msgr_free_resume']);
  }
  const quiet = client({ rpc: () => ({ data: {}, error: null }) });
  await makeDb(quiet).heartbeat(['a1'], { wsId: WS, deviceId: DEV });
  assert.deepEqual(quiet.reqs.map((r) => r.rpc), ['msgr_device_beat'], '신호가 없으면 요청 1건 그대로');
});

test('⑥ 이 앱이 서버의 무료 최소 버전 이상일 때만 멈춘 회사의 브리지를 켠다(검수 #945 MEDIUM-2) — 옛 서버(값 없음)는 꺼 둔다', async () => {
  assert.equal(appMeetsMin('0.1.102', '0.1.102'), true); assert.equal(appMeetsMin('0.1.102', '0.1.110'), true);
  assert.equal(appMeetsMin('0.1.110', '0.1.102'), false); assert.equal(appMeetsMin(null, '0.1.102'), false); assert.equal(appMeetsMin('0.1.102', null), false);
  const run2 = async (minApp) => { const calls = []; const ok = await autoEnableMsgr('ws-a', { company: { id: 'ws-a', ownerId: 'u1', msgr: { enabled: false } }, probes: new Map(), orgCache: new Map(), now: () => 1, timeoutMs: 50, log: () => {},
    session: async () => ({ uid: 'u1', db: { myOrgIds: async () => ['o'], hasAnyCrew: async () => true, hasPausedCrew: async () => true, myAgentPause: async () => (minApp === null ? null : { min_app: minApp }) } }),
    load: async (ws) => ({ id: ws, msgr: {} }), update: async (ws, patch) => { calls.push(patch); } }); return { ok, calls }; };
  assert.equal((await run2('999.0.0')).ok, false, '이 앱이 최소 버전보다 낮다');
  assert.equal((await run2(null)).ok, false, '옛 서버');
  assert.equal((await run2('0.0.1')).ok, true);
});

// 앱↔메신저 연결 감사 D3(2026-10-15): 무료 계정 첫 연결에서 미러가 행을 넣는 첫 틱은 심박 대상을 미러 전에 읽어 비어 있었다 — 심박 0.
// 다음 15초 틱은 Realtime이 붙어 있으면 관리 틱이 아니라(held → 'wake') 심박이 다음 관리 틱(120초)까지 밀렸고, 그동안 서버는 새 앱을 몰라 업데이트를 요구했다.
// 고친 뒤: 미러가 행을 넣은 틱은 같은 틱에 넣은 행까지 심박한다(행 다시 읽기 1건 — 넣은 틱에만).
const firstConnectDb = ({ org = true } = {}) => { const d = fakeDb([]); let rows = []; let n = 0;
  d.myCrews = async (uid, ws, opt) => { d.calls.push(['myCrews', opt ?? null]); return rows.map((r) => ({ ...r })); };
  d.myCrewRows = async () => rows.map((r) => ({ ...r }));
  d.myOrgIds = async () => (org ? [O1] : []);
  d.upsertAvailable = async (ins) => { d.calls.push(['upsertAvailable', ins.length]); for (const r of ins) rows.push(row(`new-${++n}`, r.slug, 'paused', r.org_id)); }; // 서버 관문: 새 앱 심박 전 무료 insert는 paused
  d.insertPersonal = async (ins) => { d.calls.push(['insertPersonal', ins.length]); for (const r of ins) rows.push(row(`newp-${++n}`, r.slug, 'paused', null)); };
  d.myCrewLooks = async () => []; d.crewLooks = async () => new Map();
  return d; };

test('⑦ D3 첫 연결: 미러가 행을 넣은 첫 틱에 넣은 행으로 심박한다 — 다음 관리 틱(120초)까지 기다리지 않는다', async () => {
  const d = firstConnectDb();
  const report = {};
  await drain(WS, { db: d, uid: UID, enqueue: async () => {}, housekeeping: true, inventory: async () => [{ slug: 'jun', name: '준', role: null }, { slug: 'mia', name: '미아', role: null }], commandsFor: null, deviceId: DEV, report });
  const beats = d.calls.filter(([k]) => k === 'heartbeat');
  assert.equal(beats.length, 1, `첫 틱 심박 1건 (${d.calls.map(([k]) => k)})`);
  assert.deepEqual(beats[0][1].slice().sort(), ['new-3', 'new-4', 'newp-1', 'newp-2'], '방금 넣은 멈춘 행(개인·조직)으로');
  assert.deepEqual(beats[0][2], { wsId: WS, deviceId: DEV });
  assert.ok(report.beatAt != null, '성공한 심박 시각을 남긴다(브리지가 다음 심박 기한을 센다)');
  assert.deepEqual(report.beat.ids.slice().sort(), ['new-3', 'new-4', 'newp-1', 'newp-2'], '쉬는 틱 심박 대상도 같은 행');
  assert.equal(report.held, true, '다음 15초 틱에 다시 drain(목록·구독 맞추기 — 종전 그대로)');
});

test('⑦ D3 유휴: 미러가 넣은 것이 없는 틱은 행을 다시 읽지 않는다(조회 수 종전 그대로)', async () => {
  const d = fakeDb([row('p-jun', 'jun', 'paused'), row('p-mia', 'mia', 'paused')]);
  await run(d);
  assert.equal(d.calls.filter(([k]) => k === 'myCrews').length, 1);
  assert.equal(d.calls.filter(([k]) => k === 'heartbeat').length, 1);
});
