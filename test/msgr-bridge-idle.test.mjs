// 메신저 브리지가 쉬는 동안 DB를 거의 부르지 않는다(유건 2026-10-10 "메신저에 연결하면 무조건 DB를 쓰게 되어 있니?").
// 실측(10/10): 15초마다 받은 글·미러·자동화·심박을 조회해 기기 1대·회사 1곳이 쉬는 동안 분당 약 28건. 새 글은 이미 Realtime 방송으로 깨어나므로
// 15초 조회는 놓친 글을 위한 예비였다. 이 파일은 실제 startMsgrBridge를 가짜 시계(setInterval·Date)와 가짜 클라이언트로 돌려 호출 수를 센다.
// 잠그는 것: ① 구독 정상이면 예비 조회 2분, 심박은 약 45초(부재중 90초 안) ② 끊기거나 안 붙었으면 15초(종전) ③ 다시 붙으면 즉시 따라잡기
// ④ 방송은 즉시 처리 ⑤ 잠자기에서 깨면 즉시 조회 ⑥ 처리 보류는 15초 뒤 다시 ⑦ 쉬는 동안에도 설정 화면 상태 파일은 갱신 ⑧ 로컬 변경은 15초 안에 미러
// ⑨ 공유 채널(여러 회사)은 콜백 없이 상태로 판정 ⑩ 회사 노드는 15초 유지(비공개 채널 크루 요청 방송을 못 받는다).
import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from './helpers/tmp.mjs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-msgr-idle-')); // 격리 루트 — 실데이터 미접촉
process.env.ARGO_ENC_VAULT = '0';
const M = await import('../src/gateway/msgr.mjs');
const { createCompany, paths, updateCompany } = await import('../src/workspace.mjs');
const { createAgentCard } = await import('../src/persona.mjs');

const UID = '11111111-1111-4111-8111-111111111111';
const ORG = 'aaaaaaaa-0000-4000-8000-000000000001', CH = 'bbbbbbbb-0000-4000-8000-000000000001';
const CREW = { id: 'cccccccc-0000-4000-8000-000000000001', org_id: ORG, slug: 'c1', display_name: '크루1', allow: 'all', allow_users: [], cursor_msg_id: 10, hosting: 'local' };
const POLL = 15_000;

let wsN = 0;
afterEach(() => { mock.timers.reset(); M.wakeProtocolCache.at = -Infinity; });

/** 실제 브리지 + 가짜 클라이언트. 호출은 이름으로 센다(db 메서드, client.rpc는 'rpc:<이름>'). */
async function harness({ inbox = () => [], local = async () => 'L0', node = false, failRooms = false, crews = () => [CREW], extra = {}, card = false } = {}) {
  const ws = `idle-${++wsN}`;
  await createCompany(ws, '회사', 'x', UID);
  if (node) await updateCompany(ws, { msgr: { enabled: true, nodeOrgId: ORG } });
  if (card) await createAgentCard(ws, { name: 'newcrew', role: '시험', prompt: '시험용 에이전트' }); // 미러가 새 행을 넣게(인벤토리는 실제 카드 목록)
  const calls = []; const at = (name) => calls.filter((c) => c.name === name);
  const impl = {
    myCrews: async () => crews(),
    crewInbox: async () => inbox(),
    heartbeat: async () => ({ device: true }),
    channelAccess: async () => new Map(),
    crewPresence: async () => new Map(),
    crewMemberships: async () => { if (failRooms) throw new Error('rooms down'); return new Map([[CREW.id, { dm: new Set(), member: new Set([CH]) }]]); },
    nodeHeartbeat: async () => true,
    wakeProtocol: async () => 1, // 서버가 깨우기 방송(crew_sync)을 보낸다(20261010232100)
    ...extra,
  };
  const db = new Proxy({}, { get: (_, k) => (typeof k !== 'string' || k === 'then') ? undefined : async (...a) => { calls.push({ name: k, t: Date.now(), a }); return impl[k] ? impl[k](...a) : []; } });
  const chans = new Map();
  const client = {
    channel(topic) {
      const ch = { topic, state: 'closed', cb: null, handlers: {},
        on(_t, { event }, fn) { this.handlers[event] = fn; return this; },
        subscribe(cb) { this.cb = cb ?? null; this.state = 'joining'; return this; },
        unsubscribe() { this.state = 'closed'; } };
      chans.set(topic, ch); return ch;
    },
    rpc: async (name) => { calls.push({ name: `rpc:${name}`, t: Date.now() }); return { data: [], error: null }; },
    realtime: { up: true, kicks: 0, connects: 0, kickAt: [], isConnected() { return this.up; }, async disconnect() { this.kicks++; this.kickAt.push(Date.now()); }, connect() { this.connects++; } },
  };
  const join = (topic, { callback = true } = {}) => { const ch = chans.get(topic); assert.ok(ch, `구독 안 됨: ${topic}`); ch.state = 'joined'; if (callback) ch.cb?.('SUBSCRIBED'); };
  const drop = (topic, status = 'CHANNEL_ERROR') => { const ch = chans.get(topic); ch.state = 'errored'; ch.cb?.(status); };
  let cur = client;
  const stop = M.startMsgrBridge(ws, { session: async () => ({ uid: UID, db, client: cur }), pollMs: POLL, runnerReady: null, localState: local });
  current = { calls };
  return { ws, calls, at, chans, join, drop, stop, client, db, rt: client.realtime, setClient: (c) => { cur = c; } };
}
let current = null; // 지금 시험의 하네스 — settle이 호출 수가 멈출 때까지 기다린다
// 틱 하나가 끝날 때까지(실제 시간) — 호출 수가 30ms씩 세 번 연속 그대로면 끝난 것으로 본다(붐비는 러너에서 고정 대기는 덜 끝난 틱을 세어 흔들렸다)
const settle = async () => { let last = -1, still = 0; for (let i = 0; i < 100 && still < 3; i++) { await new Promise((r) => setTimeout(r, 30)); await new Promise((r) => setImmediate(r)); const n = current?.calls.length ?? 0; still = n === last ? still + 1 : 0; last = n; } };
async function advance(ms) { for (let t = 0; t < ms; t += POLL) { mock.timers.tick(POLL); await settle(); } }
const drains = (h) => h.at('myCrews').length; // drain은 매번 에이전트 목록부터 읽는다 = 받은 글 조회 1회
const joinAll = (h) => { h.join(`org:${ORG}`); h.join(`u:${UID}`); };

async function start(opts) {
  mock.timers.enable({ apis: ['setInterval', 'Date'], now: 1_000_000 });
  const h = await harness(opts);
  // 첫 조회(전체)와 구독 — 붐비는 러너에서는 파일 읽기가 늦다(전체 시험 동시 실행에서 60ms로는 모자랐다). 구독이 생길 때까지 실제 시간으로 최대 10초
  for (let i = 0; i < 400 && !h.chans.has(`u:${UID}`); i++) await new Promise((r) => setTimeout(r, 25));
  await settle();
  return h;
}

test('① 구독이 정상이면 10분 동안 예비 조회는 2분마다 — 15초마다 하던 받은 글·미러·자동화 조회가 사라진다', async () => {
  const h = await start();
  try {
    joinAll(h); await settle();
    const base = h.calls.length, d0 = drains(h);
    await advance(600_000);
    const d = drains(h) - d0;
    assert.ok(d >= 4 && d <= 6, `10분 동안 받은 글 조회 ${d}회(기대 5회 안팎, 종전 40회)`);
    const auto = h.at('rpc:msgr_automation_dispatch_due').length;
    assert.ok(auto <= 7, `자동화 조회 ${auto}회(종전 41회)`);
    const total = h.calls.length - base;
    assert.ok(total <= 60, `10분 동안 DB 호출 ${total}건 — 분당 ${(total / 10).toFixed(1)}건(종전 분당 약 28건)`);
  } finally { h.stop(); }
});

test('① 쉬는 동안 심박은 따로 약 45초마다 — 간격이 40~55초라 부재중 판정(90초)·서버 기록 기한(35초) 모두 지킨다', async () => {
  const h = await start();
  try {
    joinAll(h); await settle();
    await advance(600_000);
    const ts = h.at('heartbeat').map((c) => c.t);
    assert.ok(ts.length >= 11 && ts.length <= 16, `10분 심박 ${ts.length}회`);
    const gaps = ts.slice(1).map((t, i) => t - ts[i]);
    assert.ok(Math.max(...gaps) <= 55_000, `심박 최대 간격 ${Math.max(...gaps)}ms`);
    assert.ok(Math.min(...gaps) >= 40_000, `심박 최소 간격 ${Math.min(...gaps)}ms(서버 35초 기한보다 짧으면 기록이 빠진다)`);
  } finally { h.stop(); }
});

test('② 아직 붙지 않았거나 끊기면 15초 전체 조회(종전) — 다시 붙으면 즉시 한 번 따라잡고 쉬는 주기로', async () => {
  const h = await start();
  try {
    const d0 = drains(h);
    await advance(60_000); // joining 그대로
    assert.equal(drains(h) - d0, 4, '붙기 전에는 15초마다 조회');
    joinAll(h); await settle();
    const d1 = drains(h);
    assert.ok(d1 - d0 >= 5, '붙는 순간 따라잡기 조회가 틱을 기다리지 않고 나간다');
    await advance(60_000);
    assert.equal(drains(h), d1, '붙은 뒤 1분은 조회 없음');
    h.drop(`u:${UID}`, 'CHANNEL_ERROR'); await settle();
    assert.equal(drains(h) - d1, 1, '끊김을 본 순간 한 번(죽은 소켓을 알기 전 온 글의 방송은 오지 않았다)');
    await advance(45_000);
    assert.equal(drains(h) - d1, 4, '끊긴 동안 15초마다');
    h.join(`u:${UID}`); await settle();
    const d2 = drains(h);
    assert.equal(d2 - d1, 5, '다시 붙으면 즉시 1번 따라잡기');
    await advance(60_000);
    assert.equal(drains(h), d2, '다시 쉬는 주기');
  } finally { h.stop(); }
});

test('② 짧게 끊겼다 15초 틱 전에 다시 붙어도(realtime-js 자동 재접속) 붙는 순간 따라잡는다 — 끊긴 사이 방송은 다시 오지 않는다', async () => {
  const h = await start();
  try {
    joinAll(h); await settle(); await advance(30_000);
    const d = drains(h);
    h.drop(`org:${ORG}`, 'CHANNEL_ERROR'); await settle();
    assert.equal(drains(h), d + 1, '끊김을 본 순간 한 번 조회');
    h.join(`org:${ORG}`); await settle();
    assert.equal(drains(h), d + 2, '다시 붙는 순간 한 번 더 조회(끊긴 사이 방송은 다시 오지 않는다)');
  } finally { h.stop(); }
});

test('③ 쉬는 중에 온 방송은 바로 처리한다(지연 없음) — 조직 토픽·u: 토픽 모두', async () => {
  const h = await start();
  try {
    joinAll(h); await settle(); await advance(30_000);
    for (const topic of [`org:${ORG}`, `u:${UID}`]) {
      const d = drains(h);
      h.chans.get(topic).handlers.message({ payload: {} });
      await settle();
      assert.equal(drains(h), d + 1, `${topic} 방송 한 건에 틱을 기다리지 않고 조회`);
    }
  } finally { h.stop(); }
});

test('④ 잠자기에서 깨면(틱 간격이 크게 벌어짐) 구독 상태와 무관하게 즉시 전체 조회', async () => {
  const h = await start();
  try {
    joinAll(h); await settle(); await advance(30_000);
    const d = drains(h);
    mock.timers.setTime(Date.now() + 50_000); // 잠자는 동안 시계만 흘렀다(타이머는 멈춰 있었다)
    await advance(15_000);
    assert.equal(drains(h), d + 1, '깨어난 첫 틱에 조회');
  } finally { h.stop(); }
});

test('⑤ 처리 보류(방 목록 조회 실패 — 커서 유지)는 2분을 기다리지 않고 15초 뒤 다시', async () => {
  let n = 0;
  const msg = () => [{ id: 11, channel_id: CH, author_kind: 'user', author_user_id: UID, crew_id: null, kind: 'text', body: 'x', mentions: [{ kind: 'crew', id: CREW.id }], reply_to: null, thread_root: null, created_at: new Date().toISOString() }];
  const h = await start({ inbox: () => (n++ >= 0 ? msg() : []), failRooms: true });
  try {
    joinAll(h); await settle();
    const d = drains(h);
    await advance(45_000);
    assert.equal(drains(h) - d, 3, '보류 중에는 15초마다 다시 조회');
  } finally { h.stop(); }
});

test('⑥ 쉬는 15초 틱마다 설정 화면 상태 파일(40초 창)을 다시 쓴다 — DB는 부르지 않는다', async () => {
  const h = await start();
  try {
    joinAll(h); await settle(); await advance(30_000);
    const f = join(paths(h.ws).root, '.gateway-msgr.json');
    const before = JSON.parse(await readFile(f, 'utf8'));
    const c0 = h.calls.length;
    await advance(15_000);
    const after = JSON.parse(await readFile(f, 'utf8'));
    assert.equal(after.ok, true);
    assert.ok(after.ts > before.ts, '상태 파일 시각이 갱신되지 않으면 설정 화면이 40초 뒤 "응답 없음"');
    assert.ok(h.calls.slice(c0).every((c) => c.name === 'heartbeat'), `쉬는 틱의 DB 호출은 심박뿐 (${h.calls.slice(c0).map((c) => c.name)})`);
  } finally { h.stop(); }
});

test('⑦ 로컬 변경(에이전트 고용·커맨더·루틴)은 15초 안에 전체 조회로 미러한다', async () => {
  let sig = 'L0';
  const h = await start({ local: async () => sig });
  try {
    joinAll(h); await settle(); await advance(30_000);
    const d = drains(h);
    sig = 'L1';
    await advance(15_000);
    assert.equal(drains(h), d + 1, '로컬 변경 → 다음 틱 전체 조회');
    assert.ok(h.at('myCrewRows').length > 0, '전체 조회가 인벤토리 미러를 돈다');
    await advance(30_000);
    assert.equal(drains(h), d + 1, '바뀐 것을 반영한 뒤에는 다시 쉰다');
  } finally { h.stop(); }
});

test('⑧ 여러 회사가 같은 채널 객체를 쓰면(구독 콜백이 안 온다) 채널 상태로 판정 — 붙은 것을 본 틱에 따라잡고 쉰다', async () => {
  const h = await start();
  try {
    const d0 = drains(h);
    h.join(`org:${ORG}`, { callback: false }); h.join(`u:${UID}`, { callback: false });
    await advance(15_000);
    const d1 = drains(h);
    assert.equal(d1 - d0, 1, '붙은 것을 본 틱에 한 번 따라잡기');
    await advance(90_000);
    assert.equal(drains(h), d1, '그 뒤에는 쉬는 주기');
  } finally { h.stop(); }
});

test('⑨ 조직이 빠지면(그 조직 에이전트 행이 없음) 그 조직 채널의 오류는 쉬는 주기를 붙잡지 않는다', async () => {
  let list = [CREW];
  const h = await start({ crews: () => list });
  try {
    joinAll(h); await settle(); await advance(30_000);
    list = []; h.drop(`org:${ORG}`);
    await advance(15_000); // 끊김을 본 틱 — 전체 조회로 지금 필요한 조직(없음)을 다시 정한다
    const d = drains(h);
    await advance(90_000);
    assert.equal(drains(h), d, '빠진 조직 채널 오류로 15초 조회가 이어졌다');
  } finally { h.stop(); }
});

test('⑨ 닫힌 채널(같은 토픽을 쓰던 다른 회사가 해제)은 다음 조회에서 다시 구독한다 — 그 사이는 15초', async () => {
  const h = await start();
  try {
    joinAll(h); await settle(); await advance(30_000);
    const old = h.chans.get(`u:${UID}`);
    old.state = 'closed'; // 콜백 없이 닫힘
    const d = drains(h);
    await advance(15_000);
    assert.equal(drains(h), d + 1, '닫힌 것을 본 틱에 전체 조회');
    assert.notEqual(h.chans.get(`u:${UID}`), old, 'u: 토픽을 새 채널로 다시 구독');
    h.join(`u:${UID}`); await settle();
    const d2 = drains(h);
    await advance(60_000);
    assert.equal(drains(h), d2, '다시 붙은 뒤 쉬는 주기');
  } finally { h.stop(); }
});

test('⑪ Realtime 소켓이 1분 넘게 끊겨 있으면(스스로 다시 붙지 않는 realtime-js) 끊었다 다시 연결한다 — 붙어 있으면 건드리지 않는다', async () => {
  const h = await start();
  try {
    joinAll(h); await settle(); await advance(120_000);
    assert.equal(h.rt.kicks, 0, '붙어 있는 동안 다시 연결하지 않는다');
    h.rt.up = false; h.drop(`org:${ORG}`); h.drop(`u:${UID}`);
    await advance(45_000);
    assert.equal(h.rt.kicks, 0, '1분 전에는 기다린다');
    await advance(30_000);
    assert.equal(h.rt.kicks, 1, '1분 넘게 끊기면 한 번 다시 연결');
    assert.equal(h.rt.connects, 1, '끊은 뒤 다시 연결한다(disconnect만으로는 붙지 않는다)');
    await advance(30_000);
    assert.equal(h.rt.kicks, 1, '다음 시도는 1분 뒤');
  } finally { h.stop(); }
});

test('⑫ 미러가 이번 틱에 새 조직 행을 넣으면(새 에이전트 첫 파견·되살림) 그 조직 토픽을 구독하기 전에 쉬지 않는다 — 다음 받은 글 조회까지 15초 이내(검수 MEDIUM-1)', async () => {
  let list = [], sig = 'L0';
  const h = await start({ crews: () => list, local: async () => sig, extra: {
    myOrgIds: async () => [ORG], myCrewRows: async () => [], canInsertCrews: async () => true,
    upsertAvailable: async (rows) => { list = [CREW]; return rows; }, insertPersonal: async (rows) => rows,
  } });
  try {
    h.join(`u:${UID}`); await settle(); await advance(30_000); // 에이전트 0명 — u:만 붙어 쉬는 중
    assert.equal(h.at('upsertAvailable').length, 0, '전제: 아직 넣은 행 없음');
    await createAgentCard(h.ws, { name: 'newcrew', role: '시험', prompt: '시험용 에이전트' }); sig = 'L1'; // 에이전트 고용 → 다음 틱 관리 작업이 새 조직 행을 넣는다
    await advance(15_000);
    assert.ok(h.at('upsertAvailable').length >= 1, '전제: 관리 틱이 새 조직 행을 넣었다');
    const t0 = Date.now(), d = drains(h);
    await advance(15_000);
    assert.ok(drains(h) > d, `행을 넣은 뒤 ${Date.now() - t0}ms 안에 받은 글 조회가 없었다(조직 토픽 없이 쉬는 주기로 넘어감)`);
    assert.ok(h.chans.has(`org:${ORG}`), '새 조직 토픽을 구독');
  } finally { h.stop(); }
});

test('⑫ 에이전트 목록의 조직 집합이 바뀐 틱(서버 쪽 재개·파견 — 방송 없음)은 쉬는 판정에서 뺀다 — 새 조직 토픽이 붙을 때까지 15초', async () => {
  let list = [];
  const h = await start({ crews: () => list });
  try {
    h.join(`u:${UID}`); await settle(); await advance(30_000);
    list = [CREW]; // 서버가 이 에이전트를 재개(paused → active) — 방송은 오지 않는다. 다음 예비 조회(2분 안)에서 본다
    await advance(120_000);
    assert.ok(h.chans.has(`org:${ORG}`), '예비 조회가 새 조직을 보고 구독');
    const d = drains(h);
    await advance(30_000);
    assert.ok(drains(h) - d >= 2, '새 조직 토픽이 붙기 전에는 15초 조회');
  } finally { h.stop(); }
});

test('⑬ 다시 연결해도 계속 안 붙으면(Realtime이 없는 환경) 간격을 1분 → 2분 → 4분 → 8분 → 10분으로 늘리고, 붙으면 처음으로(검수 LOW-4)', async () => {
  const h = await start();
  try {
    joinAll(h); await settle();
    h.rt.up = false; h.drop(`org:${ORG}`); h.drop(`u:${UID}`);
    await advance(30 * 60_000);
    const gaps = h.rt.kickAt.slice(1).map((t, i) => Math.round((t - h.rt.kickAt[i]) / 1000));
    assert.ok(h.rt.kicks >= 5 && h.rt.kicks <= 8, `30분 동안 다시 연결 ${h.rt.kicks}회(1분마다면 29회) — 간격 ${gaps}`);
    assert.ok(gaps.every((g, i) => i === 0 || g >= gaps[i - 1]), `간격이 줄지 않는다 ${gaps}`);
    assert.ok(Math.max(...gaps) <= 615, `최대 10분 ${gaps}`);
    h.rt.up = true; joinAll(h); await advance(30_000);
    h.rt.up = false; h.drop(`org:${ORG}`); h.drop(`u:${UID}`);
    const k = h.rt.kicks;
    await advance(90_000);
    assert.equal(h.rt.kicks, k + 1, '붙었다 다시 끊기면 1분 뒤부터 다시');
  } finally { h.stop(); }
});

test('⑭ 같은 클라이언트(같은 계정)를 쓰는 회사 둘이 같이 끊김을 봐도 다시 연결은 클라이언트당 한 번', async () => {
  const h = await start();
  const ws2 = `idle-${++wsN}`; await createCompany(ws2, '회사2', 'x', UID);
  const stop2 = M.startMsgrBridge(ws2, { session: async () => ({ uid: UID, db: h.db, client: h.client }), pollMs: POLL, runnerReady: null, localState: async () => 'L0' });
  try {
    for (let i = 0; i < 400 && !h.chans.has(`u:${UID}`); i++) await new Promise((r) => setTimeout(r, 25));
    joinAll(h); await settle(); await advance(30_000);
    h.rt.up = false; h.drop(`org:${ORG}`); h.drop(`u:${UID}`);
    await advance(75_000);
    assert.equal(h.rt.kicks, 1, `두 회사가 각자 다시 연결했다(${h.rt.kicks}회) — 같은 소켓을 연달아 끊는다`);
  } finally { h.stop(); stop2(); }
});

test('⑮ 실행 중에 깨우기가 기다리는 동안 15초 틱이 와도 깨우기는 사라지지 않는다(합치기는 더 큰 일 — poll > wake > fire)', async () => {
  let gate = null;
  const h = await start({ extra: { myCrews: async () => { if (gate) await gate.p; return [CREW]; } } });
  try {
    joinAll(h); await settle(); await advance(30_000);
    let open; gate = { p: new Promise((r) => { open = r; }) };
    const d = drains(h);
    h.chans.get(`u:${UID}`).handlers.message({ payload: {} }); await settle(); // 첫 깨우기 — drain이 에이전트 목록에서 멈춤
    h.chans.get(`u:${UID}`).handlers.message({ payload: {} }); // 실행 중 도착한 두 번째 깨우기(대기)
    mock.timers.tick(POLL); // 15초 틱도 대기에 합쳐진다
    gate = null; open(); await settle();
    assert.equal(drains(h), d + 2, '대기 중이던 깨우기가 15초 틱(쉬는 판정)에 묻혀 사라졌다');
  } finally { h.stop(); }
});

test('⑯ 토큰 회전으로 세션 클라이언트가 바뀌면 옛 클라이언트의 채널은 붙은 것으로 보지 않는다 — 다음 틱 전체 조회로 새 클라이언트에 다시 구독', async () => {
  const h = await start();
  try {
    joinAll(h); await settle(); await advance(30_000);
    const fresh = { ...h.client, channel: h.client.channel.bind(h.client), realtime: h.client.realtime };
    h.setClient(fresh);
    const d = drains(h), old = h.chans.get(`u:${UID}`);
    await advance(15_000);
    assert.equal(drains(h), d + 1, '새 클라이언트로 바뀐 틱에 쉬었다(옛 채널을 붙은 것으로 봄)');
    assert.notEqual(h.chans.get(`u:${UID}`), old, '새 클라이언트로 다시 구독');
  } finally { h.stop(); }
});

test('⑰ 미러가 실패하면 로컬 상태 기준을 옮기지 않는다 — 바뀐 로컬 상태는 다음 15초 틱에 다시 미러(검수 LOW-3)', async () => {
  let sig = 'L0', fail = false;
  const h = await start({ local: async () => sig, extra: { myOrgIds: async () => [ORG], myCrewRows: async () => { if (fail) { fail = false; throw new Error('network'); } return []; } } });
  try {
    joinAll(h); await settle(); await advance(30_000);
    sig = 'L1'; fail = true;
    await advance(15_000);
    const n = h.at('myCrewRows').length;
    await advance(15_000);
    assert.equal(h.at('myCrewRows').length, n + 1, '실패한 미러를 다음 틱에 다시 하지 않았다(예비 조회 2분까지 밀림)');
    await advance(30_000);
    assert.equal(h.at('myCrewRows').length, n + 1, '성공한 뒤에는 다시 쉰다');
  } finally { h.stop(); }
});

test('⑱ 쉬는 주기의 예비 조회가 깨우기 없이 새 글을 찾으면 한 줄 로그 — 같은 채널이면 한 번만(검수 LOW-2)', async () => {
  let give = false;
  const msg = { id: 99, channel_id: CH, author_kind: 'user', author_user_id: UID, crew_id: null, kind: 'text', body: '잡담', mentions: [], reply_to: null, thread_root: null, created_at: new Date().toISOString() };
  const h = await start({ inbox: () => (give ? [msg] : []) });
  const warn = mock.method(console, 'warn', () => {});
  try {
    joinAll(h); await settle(); await advance(30_000);
    const lines = () => warn.mock.calls.map((c) => String(c.arguments[0])).filter((l) => l.includes('깨우기 방송 없이'));
    give = true; await advance(120_000); give = false;
    assert.equal(lines().length, 1, `예비 조회가 방송 없이 찾은 글 로그 ${lines().length}줄`);
    assert.match(lines()[0], new RegExp(CH));
    give = true; await advance(120_000); give = false;
    assert.equal(lines().length, 1, '같은 원인은 한 번만');
    h.chans.get(`u:${UID}`).handlers.message({ payload: {} }); give = true; await settle(); give = false;
    assert.equal(lines().length, 1, '방송이 깨운 조회는 로그 없음');
  } finally { warn.mock.restore(); h.stop(); }
});

test('⑫ 조직 집합이 바뀐 틱(빠졌던 조직의 에이전트가 서버에서 재개 — 채널은 남아 있어 붙은 상태)은 쉬는 판정에서 빼고 15초 뒤 한 번 더 조회', async () => {
  let list = [CREW];
  const h = await start({ crews: () => list });
  try {
    joinAll(h); await settle(); await advance(30_000);
    list = []; await advance(120_000); // 예비 조회가 에이전트 0명을 본다(조직 채널은 그대로 붙어 있다)
    list = [CREW]; // 서버가 재개 — 방송 없음. 다음 예비 조회가 다시 그 조직을 본다
    const d0 = drains(h);
    for (let i = 0; i < 10 && drains(h) === d0; i++) await advance(15_000); // 그 예비 조회가 나간 틱까지
    assert.equal(drains(h), d0 + 1, '전제: 예비 조회 한 번');
    const d = drains(h);
    await advance(15_000);
    assert.equal(drains(h), d + 1, '조직 집합이 바뀐 다음 틱에 다시 조회하지 않았다');
  } finally { h.stop(); }
});

test('⑱ 예비 조회 도중 온 방송이 그 조회와 같은 글을 가리키면 놓친 방송 로그를 남기지 않는다', async () => {
  let give = false, gate = null;
  const msg = { id: 77, channel_id: CH, author_kind: 'user', author_user_id: UID, crew_id: null, kind: 'text', body: '잡담', mentions: [], reply_to: null, thread_root: null, created_at: new Date().toISOString() };
  const h = await start({ inbox: () => (give ? [msg] : []), extra: { myCrews: async () => { if (gate) await gate.p; return [CREW]; } } });
  const warn = mock.method(console, 'warn', () => {});
  try {
    joinAll(h); await settle(); await advance(30_000);
    let open; gate = { p: new Promise((r) => { open = r; }) };
    await advance(90_000); // 2분 예비 조회가 에이전트 목록에서 멈춘다
    give = true; h.chans.get(`u:${UID}`).handlers.message({ payload: {} }); // 그 사이 새 글과 방송
    gate = null; open(); await settle(); give = false; await settle();
    assert.equal(warn.mock.calls.filter((c) => String(c.arguments[0]).includes('깨우기 방송 없이')).length, 0, '방송이 왔는데 놓친 방송으로 적었다');
  } finally { warn.mock.restore(); h.stop(); }
});

test('⑩ 회사 노드(msgr.nodeOrgId)는 구독이 정상이어도 15초 — 비공개 채널 크루 요청 방송이 노드 계정에 닿지 않을 수 있다', async () => {
  const h = await start({ node: true });
  const until = async (ok) => { for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 25)); }; // 노드 정보(러너 감지)는 실제 시간으로 최대 3초
  try {
    await until(() => h.chans.has(`u:${UID}`));
    joinAll(h); await until(() => !h.calls.length || drains(h) >= 2); await settle();
    for (let i = 0; i < 4; i++) {
      const d = drains(h);
      mock.timers.tick(POLL);
      await until(() => drains(h) > d);
      assert.equal(drains(h), d + 1, `${i + 1}번째 틱도 조회`);
    }
  } finally { h.stop(); }
});

test('계획(순수): 끊김·노드·잠자기·로컬 변경·2분 경과 → 전체, 보류·재연결 → 받은 글만, 나머지 → 쉼', () => {
  const base = { now: 1_000_000, lastFireAt: 985_000, lastHousekeeping: 950_000, healthy: true, rejoined: false, held: false, nodeCompany: false, localChanged: false, pollMs: POLL, idlePollMs: M.IDLE_POLL_MS };
  assert.equal(M.msgrTickPlan(base), 'idle');
  assert.equal(M.msgrTickPlan({ ...base, healthy: false }), 'poll');
  assert.equal(M.msgrTickPlan({ ...base, nodeCompany: true }), 'poll');
  assert.equal(M.msgrTickPlan({ ...base, lastFireAt: 900_000 }), 'poll');
  assert.equal(M.msgrTickPlan({ ...base, localChanged: true }), 'poll');
  assert.equal(M.msgrTickPlan({ ...base, lastHousekeeping: 1_000_000 - M.IDLE_POLL_MS }), 'poll');
  assert.equal(M.msgrTickPlan({ ...base, held: true }), 'wake');
  assert.equal(M.msgrTickPlan({ ...base, rejoined: true }), 'wake');
  assert.equal(M.IDLE_POLL_MS, 120_000);
});

// ── 권한으로 거절된 조직 토픽(2026-10-13 Supabase 로그 과금 점검 C) ─────────────────────────────────────────────
// 조직 토픽 하나가 서버 권한 판정으로 거절되면(탈퇴·권한 회수 뒤 남은 행) 그 토픽은 영영 붙지 않는다. 종전에는 그것 하나로 rtHealthy가 늘 거짓이라
// 기기가 15초 전체 조회(관리 작업 포함 분당 약 32건)를 멈추지 않았다. 이제 그 토픽은 판정에서 빼고 받은 글만 15초마다 본다(같은 지연).
const ORG2 = 'aaaaaaaa-0000-4000-8000-000000000002';
const CREW2 = { ...CREW, id: 'cccccccc-0000-4000-8000-000000000002', org_id: ORG2, slug: 'c2', display_name: '크루2' };
const twoOrgs = () => [CREW, CREW2];
const DENY = () => new Error('Unauthorized: You do not have permissions to read from this Channel topic: org:x');
// realtime-js처럼: 거절된 채널은 errored로 두고 재가입이 실패할 때마다 같은 콜백을 다시 부른다
const deny = (h, topic) => { const ch = h.chans.get(topic); assert.ok(ch, `구독 안 됨: ${topic}`); ch.state = 'errored'; ch.cb?.('CHANNEL_ERROR', DENY()); };
// 쓰기 요청(심박 제외) — 쉬는·거절 확인 틱이 이것을 부르면 안 된다
const WRITES = /^(advance|setCursor|cursor|mirror|upsert|insert|update|delete|enqueue|ack|claim|post|send|nodeHeartbeat|workHeartbeat)/i;

test('⑲ 조직 토픽 하나가 권한으로 거절돼도 15초 전체 조회에 갇히지 않는다 — 받은 글만 15초, 관리 작업은 2분, 재가입 실패마다 추가 조회 없음', async () => {
  const warn = mock.method(console, 'warn', () => {});
  const h = await start({ crews: twoOrgs });
  try {
    joinAll(h); deny(h, `org:${ORG2}`); await settle();
    await advance(30_000); // 거절 뒤 첫 틱의 따라잡기까지 지난다
    const d0 = drains(h), a0 = h.at('rpc:msgr_automation_dispatch_due').length;
    for (let i = 0; i < 40; i++) { mock.timers.tick(POLL); if (i % 2) deny(h, `org:${ORG2}`); await settle(); } // 10분, 재가입 실패 알림 20번
    const d = drains(h) - d0, auto = h.at('rpc:msgr_automation_dispatch_due').length - a0;
    assert.ok(d >= 39 && d <= 41, `10분 동안 받은 글 조회 ${d}회(15초마다 40회 — 거절된 조직 글도 종전 지연 그대로, 재가입 실패로 늘지 않는다)`);
    assert.ok(auto <= 7, `관리 작업(자동화 조회) ${auto}회(종전 15초 전체 조회면 40회)`);
    const lines = warn.mock.calls.map((c) => String(c.arguments[0])).filter((l) => l.includes('구독이 안 붙음') && l.includes(ORG2));
    assert.equal(lines.length, 1, `진단 로그는 한 번만 (${lines.length}줄)`);
    assert.match(lines[0], /Unauthorized/);
  } finally { warn.mock.restore(); h.stop(); }
});

test('⑲ 거절된 토픽이 있는 동안 관리 틱이 아닌 15초 틱은 쓰기 요청 0(심박만 기한마다) — 받을 글이 없으면 DB를 바꾸지 않는다', async () => {
  const warn = mock.method(console, 'warn', () => {});
  const h = await start({ crews: twoOrgs });
  try {
    joinAll(h); deny(h, `org:${ORG2}`); await settle();
    await advance(30_000);
    const c0 = h.calls.length;
    await advance(90_000); // 관리 틱(2분) 사이의 15초 틱들
    const names = h.calls.slice(c0).map((c) => c.name);
    const writes = names.filter((n) => WRITES.test(n));
    assert.deepEqual(writes, [], `쓰기 요청 ${writes}`);
    assert.ok(names.filter((n) => n === 'heartbeat').length <= 3, `심박 ${names.filter((n) => n === 'heartbeat').length}회(약 45초마다)`);
  } finally { warn.mock.restore(); h.stop(); }
});

test('⑲ 권한이 돌아와 거절됐던 토픽이 붙으면 한 번 따라잡고 쉬는 주기로', async () => {
  const warn = mock.method(console, 'warn', () => {});
  const h = await start({ crews: twoOrgs });
  try {
    joinAll(h); deny(h, `org:${ORG2}`); await settle(); await advance(30_000);
    const d0 = drains(h);
    h.join(`org:${ORG2}`); await settle();
    assert.ok(drains(h) - d0 >= 1, '붙는 순간 틱을 기다리지 않고 받은 글을 따라잡는다(거절된 동안 그 조직 방송은 오지 않았다 — 검수 2)');
    await advance(15_000); // 다음 틱이 붙은 상태를 본다(쉬는 주기 — 거절 표지가 풀렸다)
    const d = drains(h);
    await advance(60_000);
    assert.equal(drains(h), d, '붙은 뒤 1분은 조회 없음(쉬는 주기)');
  } finally { warn.mock.restore(); h.stop(); }
});

test('⑲ 권한 거절이 아닌 실패(연결 끊김·시간 초과)와 u: 토픽 거절은 종전대로 15초 전체 조회', async () => {
  const warn = mock.method(console, 'warn', () => {});
  for (const [topic, err] of [[`org:${ORG2}`, new Error('channel error: connection lost')], [`u:${UID}`, DENY()]]) {
    const h = await start({ crews: twoOrgs });
    try {
      h.join(`org:${ORG}`); h.join(`org:${ORG2}`); h.join(`u:${UID}`); await settle(); await advance(30_000);
      const ch = h.chans.get(topic); ch.state = 'errored'; ch.cb?.('CHANNEL_ERROR', err); await settle();
      const a0 = drains(h); // 15초 전체 조회 = drain(자동화 호출은 로그 다이어트 1차부터 회사별 60초 제한이라 조회 수의 대리 지표가 아니다)
      await advance(60_000);
      assert.ok(drains(h) - a0 >= 4, `${topic} ${err.message}: 1분 동안 15초마다 전체 조회`);
    } finally { h.stop(); mock.timers.reset(); }
  }
  warn.mock.restore();
});

test('⑲ 토큰 회전(새 클라이언트)이면 옛 클라이언트의 거절 표지는 쓰지 않는다 — 새 채널이 붙거나 다시 거절될 때까지 15초 전체 조회', async () => {
  const warn = mock.method(console, 'warn', () => {});
  const h = await start({ crews: twoOrgs });
  try {
    joinAll(h); deny(h, `org:${ORG2}`); await settle(); await advance(30_000);
    const old = h.chans.get(`org:${ORG2}`);
    const c2 = { ...h.client, channel: h.client.channel, realtime: h.client.realtime }; h.setClient(c2);
    const a0 = drains(h);
    await advance(30_000);
    assert.notEqual(h.chans.get(`org:${ORG2}`), old, '새 클라이언트로 다시 구독');
    assert.ok(drains(h) - a0 >= 2, '새 채널이 판정되기 전에는 15초 전체 조회');
  } finally { warn.mock.restore(); h.stop(); }
});

test('구독 실패 진단 로그(순수): 같은 토픽·상태·사유는 한 번, 해제(CLOSED)·붙음은 남기지 않는다', () => {
  const lines = []; const log = (l) => lines.push(l);
  assert.equal(M.noteRtFailure('org:t1', 'CHANNEL_ERROR', DENY(), log), true);
  assert.equal(M.noteRtFailure('org:t1', 'CHANNEL_ERROR', DENY(), log), false);
  assert.equal(M.noteRtFailure('org:t1', 'TIMED_OUT', undefined, log), true);
  assert.equal(M.noteRtFailure('org:t1', 'CLOSED', undefined, log), false);
  assert.equal(M.noteRtFailure('org:t1', 'SUBSCRIBED', undefined, log), false);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /org:t1.*Unauthorized.*15초마다 확인/);
  assert.match(lines[1], /TIMED_OUT.*전체 조회/);
});

test('계획(순수): 거절된 조직 토픽이 있으면(degraded) 쉬지 않고 받은 글만 — 2분 경과·끊김은 종전대로 전체', () => {
  const base = { now: 1_000_000, lastFireAt: 985_000, lastHousekeeping: 950_000, healthy: true, rejoined: false, held: false, nodeCompany: false, localChanged: false, pollMs: POLL, idlePollMs: M.IDLE_POLL_MS };
  assert.equal(M.msgrTickPlan({ ...base, degraded: true }), 'wake');
  assert.equal(M.msgrTickPlan({ ...base, degraded: true, lastHousekeeping: 1_000_000 - M.IDLE_POLL_MS }), 'poll');
  assert.equal(M.msgrTickPlan({ ...base, degraded: true, healthy: false }), 'poll');
});

// ㉑ 로그 다이어트 1차(2026-10-16) — 15초 전체 조회(poll) 모드도 접속 심박은 BEAT_EVERY_MS(40초) 기한마다만. 서버(msgr_device_beat)가 35초 미만 요청은 기록하지 않으니
// 15초마다 보내던 요청 3개 중 2개는 로그만 쌓았다. 기록 간격(약 45초)·부재중 판정(90초)·54.6초 한도는 그대로다.
test('㉑ 구독이 안 붙은 15초 조회 모드의 심박은 40초 기한마다 — 5분에 7회 안팎(종전 20회), 최대 간격 54.6초 안, 15초 조회는 그대로', async () => {
  const h = await start();
  try {
    const d0 = drains(h);
    await advance(300_000); // joining 그대로 = poll 모드
    assert.equal(drains(h) - d0, 20, '받은 글 조회는 15초마다(종전 그대로)');
    const ts = h.at('heartbeat').map((c) => c.t);
    assert.ok(ts.length >= 6 && ts.length <= 9, `5분 심박 ${ts.length}회(15초마다면 21회)`);
    const gaps = ts.slice(1).map((t, i) => t - ts[i]);
    assert.ok(Math.max(...gaps) <= 54_600, `심박 최대 간격 ${Math.max(...gaps)}ms`);
    assert.ok(Math.min(...gaps) >= 40_000, `심박 최소 간격 ${Math.min(...gaps)}ms(서버 35초 기한보다 짧으면 기록이 빠진다)`);
  } finally { h.stop(); }
});

test('㉑ 인접 핀: 심박이 실패하면 시각을 옮기지 않아 다음 15초 틱에 다시 보낸다(폭주하지 않고, 회복하면 곧 나간다)', async () => {
  let fail = false;
  const h = await start({ extra: { heartbeat: async () => { if (fail) throw new Error('boom'); return { device: true }; } } });
  const err = mock.method(console, 'error', () => {});
  try {
    await advance(120_000);
    const b0 = h.at('heartbeat').length;
    fail = true; await advance(45_000);
    const failed = h.at('heartbeat').length - b0;
    assert.ok(failed >= 2, `실패한 심박은 다음 틱에 다시 시도한다(${failed}회)`);
    fail = false; const b1 = h.at('heartbeat').length; await advance(15_000);
    assert.ok(h.at('heartbeat').length > b1, '회복하면 다음 틱에 보낸다');
  } finally { err.mock.restore(); h.stop(); }
});

// ㉒ 메신저 서비스 일시 중단(서버 스위치 20261016170000) — 심박 응답의 paused 표지를 보면 30분 동안 틱마다 요청 0, 30분마다 심박 한 번으로만 확인, 풀리면 원래대로
const resetPause = () => { M.servicePause.since = null; M.servicePause.checkedAt = -Infinity; };
test('㉒ 서비스 중단 표지를 받으면 30분 동안 요청 0(받은 글·자동화·심박 모두), 30분마다 심박 1회로만 확인 — 풀리면 그 틱에 관리 작업까지 돌고 원래 주기로', async () => {
  let pausedNow = true;
  const h = await start({ extra: { heartbeat: async () => (pausedNow ? { device: true, paused: true, since: '2026-10-16T17:00:00+09:00' } : { device: true }) } });
  try {
    joinAll(h); await settle();
    for (let i = 0; i < 10 && !M.msgrServicePaused(); i++) await advance(15_000); // 첫 심박에서 표지를 받는다
    assert.equal(M.msgrServicePaused(), true, '심박 응답의 paused 표지로 중단 상태가 된다');
    const c0 = h.calls.length;
    await advance(25 * 60_000);
    assert.equal(h.calls.length - c0, 0, `중단 확인 뒤 25분 동안 요청 ${h.calls.length - c0}건(0이어야 한다)`);
    const c1 = h.calls.length;
    await advance(10 * 60_000); // 30분 지점을 지난다
    const during = h.calls.slice(c1).map((c) => c.name);
    assert.deepEqual(during, ['heartbeat'], `30분 지점의 확인은 심박 한 번뿐: ${during}`);
    pausedNow = false;
    const c2 = h.calls.length;
    await advance(31 * 60_000);
    assert.equal(M.msgrServicePaused(), false, '풀린 응답을 받으면 중단 상태가 풀린다');
    assert.ok(h.at('myCrews').filter((c) => h.calls.indexOf(c) >= c2).length >= 1, '풀린 뒤 받은 글 조회가 다시 돈다');
    const c3 = h.calls.length; await advance(10 * 60_000);
    const d = h.calls.slice(c3).filter((c) => c.name === 'myCrews').length;
    assert.ok(d >= 4 && d <= 6, `풀린 뒤 10분 동안 받은 글 조회 ${d}회 — 원래 쉬는 주기(2분)`);
  } finally { h.stop(); resetPause(); }
});

test('㉒ 인접 핀: 서버가 표지를 주지 않으면(스위치 없음·옛 서버) 중단 상태가 켜지지 않는다 — 10분 동안 종전과 같은 호출', async () => {
  resetPause();
  const h = await start();
  try {
    joinAll(h); await settle();
    const base = h.calls.length; await advance(600_000);
    assert.equal(M.msgrServicePaused(), false);
    const total = h.calls.length - base;
    assert.ok(total <= 60 && h.at('heartbeat').length >= 11, `10분 호출 ${total}건·심박 ${h.at('heartbeat').length}회(①과 같은 기준)`);
  } finally { h.stop(); resetPause(); }
});

test('㉒ makeDb.heartbeat — 기기 심박 응답의 paused를 { device, paused, since }로 넘기고, 풀린 응답·옛 행 심박은 표지가 없다', async () => {
  const rpc = []; let data = { paused: true, since: 's1' };
  const db = M.makeDb({ rpc: async (name, args) => { rpc.push(name); return { data, error: null }; }, from: () => { throw new Error('행 심박 경로를 타면 안 된다'); } });
  const ids = ['cccccccc-0000-4000-8000-000000000001'];
  assert.deepEqual(await db.heartbeat(ids, { wsId: 'w1', deviceId: 'dev' }), { device: true, paused: true, since: 's1' });
  data = {};
  assert.deepEqual(await db.heartbeat(ids, { wsId: 'w1', deviceId: 'dev' }), { device: true });
  assert.ok(rpc.every((n) => n === 'msgr_device_beat'), '중단 중에도 재개 RPC(msgr_free_resume) 등 다른 호출이 없다');
  resetPause(); M.noteServicePause(undefined); assert.equal(M.msgrServicePaused(), false, '옛 행 심박(응답 없음)은 판정에 쓰지 않는다');
  M.noteServicePause({ device: true, paused: true, since: 'x' }); assert.equal(M.msgrServicePaused(), true);
  M.noteServicePause({ device: true }); assert.equal(M.msgrServicePaused(), false); resetPause();
});
