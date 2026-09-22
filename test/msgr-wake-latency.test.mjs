// 메신저 '입력 중'이 5~10초 늦게 뜨던 것(유건 제보 2026-09-23) — 라이브 실측: 메시지 → 실행 시작(픽업) 4~7초, 가끔 15~20초.
// 원인: 새 메시지 방송이 깨운 tick도 관리 작업(미러·하트비트·조직 문서)과 크루별 조회 3회를 **순서대로** 돌았고(크루 12명 ≈ 45왕복),
// tick이 도는 중에 온 깨우기는 busy로 버려져 다음 15초 폴까지 밀렸다. 이 파일은 그 세 가지를 행동으로 잠근다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-msgr-wake-'));
process.env.ARGO_ENC_VAULT = '0';
const M = await import('../src/gateway/msgr.mjs');
const { paths } = await import('../src/workspace.mjs');

const WS = 'wake-ws';
const OWNER = '11111111-1111-4111-8111-111111111111';
const ORG = 'aaaaaaaa-0000-4000-8000-000000000001', CH = 'bbbbbbbb-0000-4000-8000-000000000001';
const p = paths(WS);
for (const d of [p.root, join(p.root, 'chats'), join(p.root, 'agents'), p.journal, p.files]) await mkdir(d, { recursive: true });
await writeFile(p.company, JSON.stringify({ id: WS, name: '웨이크', lang: 'ko', created: '2026-09-23', ownerId: OWNER }));

const crew = (n) => ({ id: `cccccccc-0000-4000-8000-00000000000${n}`, org_id: ORG, slug: `c${n}`, display_name: `크루${n}`, allow: 'all', allow_users: [], cursor_msg_id: 10, hosting: 'local' });
const CREWS = [crew(1), crew(2)];
const msgTo = (id, c) => ({ id, channel_id: CH, author_kind: 'user', author_user_id: OWNER, crew_id: null, kind: 'text', body: `m${id}`,
  mentions: [{ kind: 'crew', id: c.id }], reply_to: null, thread_root: null, created_at: new Date().toISOString() });

function fakeDb({ scopeGate = null } = {}) {
  const calls = [];
  const rec = (...a) => calls.push(a);
  return {
    calls,
    async myCrews() { rec('myCrews'); return CREWS; },
    async myOrgIds() { return []; },
    async heartbeat(ids) { rec('heartbeat', ids); },
    async workHeartbeat(ids) { rec('workHeartbeat', ids); },
    async setCursor(id, n) { rec('setCursor', id, n); },
    async crewChannels(id) { rec('crewChannels', id); return []; },
    async crewScope(id) { rec('crewScope', id); if (scopeGate) await scopeGate(id); return new Set([CH]); },
    async messagesAfter() { return [msgTo(11, CREWS[0]), msgTo(12, CREWS[1])]; },
    async message() { return null; },
    async channel(id) { return { id, org_id: ORG, kind: 'public', name: 'general', crew_memory: true }; },
    async instructCheck() { return 'ok'; },
    async crewOwner() { return OWNER; },
    async settled() { return false; },
    async autoTurnsIn() { return 0; },
    async approvalsByIds() { return []; },
    async org() { rec('org'); return { id: ORG, slug: 'wake', name: '웨이크' }; },
    async docsIndex() { rec('docsIndex'); return []; },
    async docsByIds() { return []; },
  };
}
const enqueueRec = () => { const jobs = []; const fn = async (_ws, _k, _id, job) => { jobs.push(job); }; fn.jobs = jobs; return fn; };

test('깨우기 tick(housekeeping:false)은 미러·하트비트·조직 문서를 건너뛰고 새 메시지는 그대로 큐에 넣는다', async () => {
  const db = fakeDb(); const enq = enqueueRec(); const mirrored = [];
  const r = await M.drain(WS, { db, uid: OWNER, enqueue: enq, housekeeping: false,
    inventory: async () => { mirrored.push('inventory'); return []; }, commandsFor: async () => { mirrored.push('commands'); return []; } });
  assert.equal(r.queued, 2);
  assert.deepEqual(enq.jobs.map((j) => j.msgId), [11, 12]);
  assert.deepEqual(mirrored, [], '깨우기 tick이 인벤토리·커맨더 미러를 돌았다');
  const kinds = db.calls.map((c) => c[0]);
  for (const k of ['heartbeat', 'workHeartbeat', 'docsIndex']) assert.ok(!kinds.includes(k), `깨우기 tick이 ${k}를 불렀다`);
});

test('주기 tick(기본값)은 종전대로 하트비트·조직 문서 미러를 돈다 — 부재중 판정(last_seen_at)이 끊기지 않는다', async () => {
  const db = fakeDb(); const enq = enqueueRec();
  await M.drain(WS, { db, uid: OWNER, enqueue: enq, inventory: null, commandsFor: null });
  const kinds = db.calls.map((c) => c[0]);
  assert.ok(kinds.includes('heartbeat'));
  assert.ok(kinds.includes('docsIndex'));
});

test('크루별 조회는 동시에 시작한다 — 크루1의 범위 조회가 크루2의 조회 시작을 기다리게 해도 교착 없이 끝나고, 적재 순서는 크루 순서 그대로', async () => {
  let c2Started; const c2 = new Promise((r) => { c2Started = r; });
  const db = fakeDb({ scopeGate: async (id) => { if (id === CREWS[1].id) c2Started(); else await c2; } });
  const origChannels = db.crewChannels; db.crewChannels = async (id) => { if (id === CREWS[1].id) c2Started(); return origChannels(id); };
  const enq = enqueueRec();
  const done = M.drain(WS, { db, uid: OWNER, enqueue: enq, housekeeping: false, inventory: null, commandsFor: null });
  const r = await Promise.race([done, new Promise((res) => setTimeout(res, 2000, 'timeout'))]);
  assert.notEqual(r, 'timeout', '크루 조회가 순서대로 돌아 크루1이 크루2를 기다리다 멈췄다(순차 왕복)');
  assert.deepEqual(enq.jobs.map((j) => j.slug), ['c1', 'c2']);
});

test('실행 중에 온 깨우기는 버리지 않는다 — 끝난 뒤 한 번 더 돈다(여러 번 와도 한 번으로 합친다)', async () => {
  const releases = []; let runs = 0;
  const run = M.coalesce(async () => { runs++; await new Promise((r) => releases.push(r)); });
  const first = run();
  run(); run(); // 첫 실행 중 도착한 깨우기 두 번
  await new Promise((r) => setImmediate(r));
  releases.shift()();
  await first;
  for (let i = 0; i < 5 && !releases.length; i++) await new Promise((r) => setImmediate(r));
  assert.equal(runs, 2, `실행 중 깨우기가 ${runs === 1 ? '버려졌다' : '합쳐지지 않았다'}`);
  releases.shift()?.();
});

// ── 브리지 tick 수준 — 깨우기가 관리 작업을 건너뛰어도 연결 상태·수동 재연결은 종전과 같아야 한다(검수 M1·L1) ──
function bridgeFakes({ mirrorFails = false } = {}) {
  const db = fakeDb(); const handlers = {};
  Object.assign(db, {
    async myOrgIds() { return [ORG]; },
    async myCrewRows() { if (mirrorFails) throw new Error('msgr_ws_owned_by_other'); return []; },
    async orgAllowDefaults() { return {}; },
    async upsertCrews(rows) { return rows; },
    async listCommands() { return []; },
    async mirrorCommands() { return []; },
  });
  const client = { channel: (name) => ({ on(_k, { event }, h) { (handlers[`${name}:${event}`] ??= []).push(h); return this; }, subscribe() { return this; }, unsubscribe() {} }) };
  return { db, client, handlers, session: async () => ({ uid: OWNER, db, client }) };
}
const gatewayState = async () => JSON.parse(await (await import('node:fs/promises')).readFile(join(p.root, '.gateway-msgr.json'), 'utf8'));
const settle = async (ms = 60) => { await new Promise((r) => setTimeout(r, ms)); };

test('깨우기 tick은 연결 상태를 덮어쓰지 않는다 — 미러 실패(다른 계정 소유)는 다음 주기까지 유지(검수 M1)', async () => {
  const { session, handlers } = bridgeFakes({ mirrorFails: true });
  const stop = M.startMsgrBridge(WS, { session, pollMs: 60_000 });
  try {
    for (let i = 0; i < 40 && !(await gatewayState().catch(() => null)); i++) await settle();
    const first = await gatewayState();
    assert.equal(first.ok, false, '전제: 주기 tick이 미러 실패를 연결 실패로 기록');
    assert.match(first.error, /다른 계정 소유/);
    handlers[`org:${ORG}:message`]?.forEach((h) => h({ payload: {} })); // 새 메시지 방송 = 깨우기 tick
    await settle(300);
    const after = await gatewayState();
    assert.equal(after.ok, false, '깨우기 tick이 연결 상태를 "연결됨"으로 덮어썼다(설정 화면이 원인을 감춘다)');
    assert.match(after.error, /다른 계정 소유/);
  } finally { stop(); }
});

test('수동 재연결(nudge)은 관리 작업까지 한 번 돈다 — 네트워크 복구 뒤 하트비트가 다음 폴까지 밀리지 않는다(검수 L1)', async () => {
  const { session, db } = bridgeFakes();
  const stop = M.startMsgrBridge(WS, { session, pollMs: 60_000 });
  try {
    for (let i = 0; i < 40 && !db.calls.some((c) => c[0] === 'heartbeat'); i++) await settle();
    const before = db.calls.filter((c) => c[0] === 'heartbeat').length;
    stop.nudge();
    await settle(300);
    assert.ok(db.calls.filter((c) => c[0] === 'heartbeat').length > before, 'nudge가 깨우기로 분류돼 하트비트가 다음 폴까지 밀렸다');
  } finally { stop(); }
});
