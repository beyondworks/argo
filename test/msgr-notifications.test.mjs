import test from 'node:test';
import assert from 'node:assert/strict';
import { deliverMessengerNotifications, notificationRoutes, notificationPlan, ROUTE_SYNC_MS, IDLE_CLAIM_MS } from '../src/gateway/msgr-notifications.mjs';

const connections = {
  telegram: { enabled: true, token: 'fixture', chatId: 'fixture-chat', ownerId: 'tg-owner' },
  slack: { enabled: true, token: 'fixture', channel: 'fixture-channel', defaultCrew: 'local-default' },
};
function fixture({ rows = [], uid = 'creator', ownerId = 'creator', sendResult = { status: 'sent' }, rpcError, receipt = true } = {}) {
  const calls = []; const sent = [];
  const client = { rpc: async (name, args) => {
    calls.push({ name, args });
    if (rpcError) return { error: rpcError };
    return { data: name === 'msgr_notification_claim' ? rows : name === 'msgr_notification_finish' ? receipt : name === 'msgr_notification_authorize' ? true : [] };
  } };
  return { calls, sent, deps: {
    session: async () => ({ uid, client }), readCompany: async () => ({ name: 'My company', ownerId }),
    readConnections: async () => connections, readAgents: async () => [], readDeviceId: async () => 'my-device', attempt: 'attempt', memo: new Map(), // 동기화 기억은 시험마다 새로(2026-10-13 유휴 호출 줄이기)
    send: async (event, kind) => { sent.push({ event, kind }); return sendResult; },
  } };
}
const row = { delivery_id: 'delivery', run_id: 'run', route_id: 'route', kind: 'slack', ws_id: 'mine', title: 'Today', body: 'Summary', status: 'completed' };

test('route advertisement has no credentials and respects routine mute', () => {
  const routes = notificationRoutes({ name: 'Mine' }, connections);
  assert.deepEqual(routes, [{ kind: 'telegram', label: 'Mine', ready: true }, { kind: 'slack', label: 'Mine', ready: true }]);
  const muted = notificationRoutes({ name: 'Mine' }, { telegram: { ...connections.telegram, mutedEvents: ['routine'] }, slack: { ...connections.slack, mutedEvents: ['routine'] } });
  assert.deepEqual(muted.map((r) => r.ready), [false, false]);
  assert.ok(!JSON.stringify(routes).includes('fixture'));
});
test('another signed-in account or unowned workspace never advertises or claims', async () => {
  for (const ownerId of ['someone-else', null]) {
    const f = fixture({ ownerId });
    assert.equal((await deliverMessengerNotifications('mine', f.deps)).reason, 'owner');
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.sent, []);
  }
});
test('creator node sends a trusted result through creator company, not executing crew', async () => {
  const f = fixture({ rows: [row] });
  const result = await deliverMessengerNotifications('mine', f.deps);
  assert.deepEqual(result.deliveries, [{ id: 'delivery', status: 'sent' }]);
  assert.equal(f.sent.length, 1);
  assert.equal(f.calls.find((c) => c.name === 'msgr_notification_routes_sync').args.p_device, 'my-device');
  assert.equal(f.calls.find((c) => c.name === 'msgr_notification_claim').args.p_device, 'my-device');
  assert.deepEqual(f.sent[0], { kind: 'slack', event: {
    type: 'routine', wsId: 'mine', ok: true, reply: 'Summary',
    routine: { id: 'run', title: 'Today', agentSlug: 'local-default', lastRun: 'run', notifications: { channels: ['slack'] } },
  } });
  assert.deepEqual(f.calls.at(-1).args, { p_delivery: 'delivery', p_attempt: 'attempt', p_status: 'sent', p_error: null });
});
test('foreign workspace and non-external route cannot choose another destination', async () => {
  const f = fixture({ rows: [{ ...row, ws_id: 'foreign' }, { ...row, delivery_id: 'other', kind: 'msgr' }] });
  const result = await deliverMessengerNotifications('mine', f.deps);
  assert.deepEqual(f.sent, []);
  assert.ok(result.deliveries.every((d) => d.status === 'skipped'));
});
test('logout after claim suppresses the outbound send', async () => {
  const f = fixture({ rows: [row] }); const session = f.deps.session; let count = 0;
  f.deps.session = async () => ++count === 1 ? session() : null;
  assert.equal((await deliverMessengerNotifications('mine', f.deps)).deliveries[0].reason, 'owner_changed');
  assert.deepEqual(f.sent, []);
});
test('channel access revoked after claim is checked before the external request', async () => {
  const f = fixture({ rows: [row] }); const session = await f.deps.session(); const rpc = session.client.rpc;
  session.client.rpc = async (name, args) => name === 'msgr_notification_authorize' ? { data: false } : rpc(name, args);
  assert.equal((await deliverMessengerNotifications('mine', f.deps)).deliveries[0].status, 'skipped');
  assert.deepEqual(f.sent, []);
});
test('an ambiguous send is recorded once without resending', async () => {
  const f = fixture({ rows: [row] });
  f.deps.send = async () => { f.sent.push('attempt'); throw new Error('private provider details'); };
  const result = await deliverMessengerNotifications('mine', f.deps);
  assert.deepEqual(f.sent, ['attempt']);
  assert.equal(result.deliveries[0].status, 'uncertain');
  assert.equal(f.calls.at(-1).args.p_error, 'delivery_interrupted');
});
test('receipt loss after successful send does not resend or claim success', async () => {
  const f = fixture({ rows: [row], receipt: false });
  assert.deepEqual((await deliverMessengerNotifications('mine', f.deps)).deliveries, [{ id: 'delivery', status: 'uncertain', reason: 'receipt_not_saved' }]);
  assert.equal(f.sent.length, 1);
});
test('old databases degrade without interrupting Messenger or claiming sends', async () => {
  const f = fixture({ rpcError: { code: 'PGRST202' } });
  assert.equal((await deliverMessengerNotifications('mine', f.deps)).reason, 'upgrade');
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.sent, []);
});
test('failed, muted and disconnected notifications have visible distinct delivery outcomes', async () => {
  for (const [status, expected] of [['failed', 'failed'], ['muted', 'skipped'], ['unavailable', 'skipped']]) {
    const f = fixture({ rows: [{ ...row, status: 'failed' }], sendResult: { status, reason: status } });
    assert.equal((await deliverMessengerNotifications('mine', f.deps)).deliveries[0].status, expected);
    assert.equal(f.sent[0].event.ok, false);
  }
});

// ── 유휴 호출 줄이기(2026-10-13 로그 수집 과금, 총괄 결정 B) — 게이트웨이가 회사마다 30초에 한 번 부르는 것을 그대로 흉내 낸다 ──
const off = { telegram: { enabled: false }, slack: { enabled: false } }; // 경로 없음(ready 0개) — 대부분의 계정
function loop({ conns = off, rows = [] } = {}) {
  let t = 0; const calls = []; const state = { conns };
  const client = { rpc: async (name, args) => { calls.push({ name, at: t }); return { data: name === 'msgr_notification_claim' ? rows : name === 'msgr_notification_finish' ? true : name === 'msgr_notification_authorize' ? true : [] }; } };
  const deps = { session: async () => ({ uid: 'creator', client }), readCompany: async () => ({ name: 'Mine', ownerId: 'creator' }), readConnections: async () => state.conns,
    readAgents: async () => [], readDeviceId: async () => 'dev', attempt: 'a', memo: new Map(), now: () => t, send: async () => ({ status: 'sent' }) };
  const tick = () => deliverMessengerNotifications('mine', deps);
  const run = async (ms, step = 30_000) => { const end = t + ms; while (t < end) { await tick(); t += step; } }; // 기본 30초 틱(로그 다이어트 1차 전 gateway.mjs notificationTicks). 지금 게이트는 60초(NOTIFY_TICK_MS) — step으로 준다
  const count = (name, from = 0) => calls.filter((c) => c.name === name && c.at >= from).length;
  return { calls, state, tick, run, count, at: () => t, set: (v) => { t = v; } };
}

test('경로가 없으면(ready 0개) 첫 틱에 동기화·확인 1번씩, 그 뒤 30분 동안 RPC 0 — 유휴 호출·쓰기 0', async () => {
  const w = loop();
  await w.run(30 * 60_000 - 1); // 30초 틱 60번
  assert.equal(w.count('msgr_notification_routes_sync'), 1, '목록이 안 바뀌면 다시 동기화하지 않는다');
  assert.equal(w.count('msgr_notification_claim'), 1, '정리 주기(30분) 전에는 확인하지 않는다');
  assert.equal(w.calls.length, 2, '종전 120번 → 2번');
  await w.run(30_000);
  assert.equal(w.count('msgr_notification_claim'), 2, '30분마다 한 번은 확인한다 — 오래된 claimed·pending 정리(배포본 동작 보존)');
  assert.equal(w.count('msgr_notification_routes_sync'), 1);
  assert.equal(IDLE_CLAIM_MS, 30 * 60_000);
});

test('ready 경로가 있으면 확인은 틱마다(60초 게이트), 동기화는 120초 지난 첫 틱마다(서버 60초 생략 기준보다 길게, 3분 신선도 안)', async () => {
  const w = loop({ conns: connections });
  await w.run(10 * 60_000, 60_000); // 60초 틱 10번
  assert.equal(w.count('msgr_notification_claim'), 10, '매 틱 확인');
  assert.equal(ROUTE_SYNC_MS, 120_000);
  const syncs = w.calls.filter((c) => c.name === 'msgr_notification_routes_sync').map((c) => c.at);
  assert.deepEqual(syncs, [0, 120_000, 240_000, 360_000, 480_000], '60초 틱에서는 120초마다(120초가 지난 첫 틱)');
  const gaps = syncs.slice(1).map((at, i) => at - syncs[i]);
  assert.ok(gaps.every((g) => g > 60_000), '서버가 쓰기를 건너뛰는 60초 이하로 부르지 않는다');
  assert.ok(gaps.every((g) => g < 180_000), '서버 3분 신선도 안에서 다시 쓴다');
});

test('동기화 간격은 서버 쓰기 생략 기준(마이그레이션의 60초)보다 길어야 한다 — 같거나 짧으면 서버가 건너뛰어 갱신이 두 배로 밀린다(검수 1, #996)', async () => {
  const { readFileSync } = await import('node:fs');
  const sql = readFileSync(new URL('../supabase/migrations/20260923210000_msgr_notification_routes_quiet.sql', import.meta.url), 'utf8');
  const secs = [...sql.matchAll(/last_seen_at < now\(\)-interval '(\d+) seconds'/g)].map((m) => Number(m[1]));
  assert.ok(secs.length >= 2, '서버의 쓰기 생략 기준(route·node)을 찾는다');
  for (const s of secs) assert.ok(ROUTE_SYNC_MS > s * 1000 + 2_000, `ROUTE_SYNC_MS(${ROUTE_SYNC_MS}ms)는 서버 기준 ${s}초 + 흔들림 여유 2초보다 길다`);
  const fresh = Number(sql.match(/n\.last_seen_at>=now\(\)-interval '(\d+) minutes'/)[1]);
  assert.ok(ROUTE_SYNC_MS + 20_000 < fresh * 60_000, '틱이 70초까지 벌어져도(10초 루프의 60초 게이트) 동기화 간격은 서버 신선도(분) 안 — 140초 < 180초');
});

test('경로가 막 ready가 된 순간 — 그 틱에 바로 동기화하고 확인한다(첫 알림이 늦지 않는다)', async () => {
  const w = loop({ rows: [] });
  await w.run(5 * 60_000);
  const t0 = w.at();
  w.state.conns = connections; // 사용자가 슬랙·텔레그램을 연결했다
  await w.tick();
  assert.equal(w.count('msgr_notification_routes_sync', t0), 1, '목록이 바뀌어 바로 동기화');
  assert.equal(w.count('msgr_notification_claim', t0), 1, '같은 틱에 확인 — 30분 정리 주기를 기다리지 않는다');
  assert.ok(w.calls.findIndex((c) => c.at === t0 && c.name === 'msgr_notification_routes_sync') < w.calls.findIndex((c) => c.at === t0 && c.name === 'msgr_notification_claim'), '동기화(노드 ready·신선) 뒤에 확인');
});

test('라벨·경로가 바뀌거나 ready가 꺼지면 그 틱에 동기화한다 — 꺼진 뒤에는 다시 조용해진다', async () => {
  const w = loop({ conns: connections });
  await w.run(60_000);
  const t0 = w.at();
  w.state.conns = { ...connections, slack: { ...connections.slack, mutedEvents: ['routine'] } }; // 하나 끔
  await w.tick();
  assert.equal(w.count('msgr_notification_routes_sync', t0), 1, 'ready가 바뀐 틱에 동기화');
  w.state.conns = off; const t1 = w.at() + 30_000; w.set(t1);
  await w.tick();
  assert.equal(w.count('msgr_notification_routes_sync', t1), 1, '모두 꺼진 틱에 동기화(서버가 노드를 내린다)');
  await w.run(10 * 60_000);
  assert.equal(w.count('msgr_notification_routes_sync', t1 + 1), 0, '꺼진 뒤에는 동기화 없음');
  assert.equal(w.count('msgr_notification_claim', t1 + 1), 0, '꺼진 뒤 30분 전에는 확인 없음');
});

test('동기화가 실패하면 기억을 남기지 않아 다음 틱에 다시 한다 — 성공한 내용만 기억', async () => {
  let fail = true; const calls = [];
  const client = { rpc: async (name) => { calls.push(name); return name === 'msgr_notification_routes_sync' && fail ? { error: { message: 'timeout' } } : { data: [] }; } };
  const memo = new Map();
  const deps = { session: async () => ({ uid: 'creator', client }), readCompany: async () => ({ name: 'Mine', ownerId: 'creator' }), readConnections: async () => off,
    readAgents: async () => [], readDeviceId: async () => 'dev', memo, now: () => 0, send: async () => ({}) };
  await assert.rejects(() => deliverMessengerNotifications('mine', deps));
  assert.equal(memo.size, 0);
  fail = false;
  await deliverMessengerNotifications('mine', deps);
  assert.equal(calls.filter((n) => n === 'msgr_notification_routes_sync').length, 2, '실패 뒤 다음 틱에 다시 동기화');
});

test('기억은 회사·기기·계정마다 따로 — 다른 회사나 다른 계정은 처음처럼 동기화한다', () => {
  const routes = notificationRoutes({ name: 'X' }, off);
  const first = notificationPlan(undefined, routes, 0);
  assert.deepEqual([first.sync, first.claim], [true, true], '기억 없음 = 첫 틱');
  const memo = { routes: first.key, syncedAt: 0, claimedAt: 0 };
  assert.deepEqual([notificationPlan(memo, routes, 29 * 60_000).sync, notificationPlan(memo, routes, 29 * 60_000).claim], [false, false]);
  assert.equal(notificationPlan(memo, notificationRoutes({ name: 'Y' }, off), 1000).sync, true, '라벨이 바뀌면 동기화');
});

test('같은 기기에서 계정을 바꾸면(다른 uid) 처음처럼 동기화한다 — 남의 기억으로 건너뛰지 않는다', async () => {
  const memo = new Map(); let uid = 'creator'; const calls = [];
  const client = { rpc: async (name) => { calls.push([uid, name]); return { data: [] }; } };
  const deps = { session: async () => ({ uid, client }), readCompany: async () => ({ name: 'Mine', ownerId: uid }), readConnections: async () => off,
    readAgents: async () => [], readDeviceId: async () => 'dev', memo, now: () => 0, send: async () => ({}) };
  await deliverMessengerNotifications('mine', deps);
  uid = 'other-account';
  await deliverMessengerNotifications('mine', deps);
  assert.deepEqual(calls.filter(([, n]) => n === 'msgr_notification_routes_sync').map(([u]) => u), ['creator', 'other-account']);
});
