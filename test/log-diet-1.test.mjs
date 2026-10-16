// 로그 다이어트 1차(2026-10-16) — Supabase 로그 수집 과금(요청 1건 = 로그 1줄)을 줄이는 주기 호출 제한. 기능 동작은 그대로.
// ① wrapped_deks 음성 백오프 ② 자동화 디스패치 회사별 60초 ④ 알림 claim·경로 동기화 간격 ⑤ 진단 헤더. (③ poll 심박은 msgr-bridge-idle.test.mjs ㉑)
// 행동 테스트: 가짜 시계·가짜 클라이언트로 호출 횟수를 센다(소스 문자열 단언 아님).
import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-logdiet1-'));
process.env.ARGO_ENC_VAULT = '0';
const E = await import('../src/e2ee.mjs');
const { dispatchMessengerAutomations } = await import('../src/gateway/msgr-automations.mjs');
const N = await import('../src/gateway/msgr-notifications.mjs');
const { msgrClientOptions, APP_VERSION } = await import('../src/gateway/msgr.mjs');
const { syncClientOptions } = await import('../src/sync.mjs');

afterEach(() => mock.timers.reset());
const MIN = 60_000;

/* ── ① wrapped_deks 음성 백오프 ── */
function wrapSb(state) {
  return { from: (tbl) => { assert.equal(tbl, 'wrapped_deks'); return { select: () => ({ eq: () => ({ maybeSingle: async () => { state.selects++; return { data: state.row, error: null }; } }) }) }; } };
}
test('① 행이 없는 기기의 wrapped_deks 확인: 60초→5분→15분→30분 상한 — 1시간에 5번(종전 60번)', async () => {
  mock.timers.enable({ apis: ['Date'], now: 10_000_000 });
  const root = await mkdtemp(join(tmpdir(), 'argo-logdiet1-e-'));
  E.clearDekCache(); E._resetClaimForTest();
  await E.loadDeviceE2ee({ root });
  const st = { selects: 0, row: null }; const sb = wrapSb(st);
  const at = [];
  for (let s = 0; s <= 3600; s += 10) { const before = st.selects; await E.tryClaimDek(sb, 'dev-1', { root }); if (st.selects > before) at.push(s); mock.timers.tick(10_000); }
  assert.deepEqual(at, [0, 60, 360, 1260, 3060], '0초, +60초(첫 확인 후 60초 간격), +5분, +15분, +30분 — 1시간 5번(종전 60번)');
});
test('① force:true(설정 화면 버튼)는 백오프 중에도 즉시 확인한다', async () => {
  mock.timers.enable({ apis: ['Date'], now: 20_000_000 });
  const root = await mkdtemp(join(tmpdir(), 'argo-logdiet1-e-'));
  E.clearDekCache(); E._resetClaimForTest();
  await E.loadDeviceE2ee({ root });
  const st = { selects: 0, row: null }; const sb = wrapSb(st);
  await E.tryClaimDek(sb, 'dev-1', { root }); mock.timers.tick(MIN); await E.tryClaimDek(sb, 'dev-1', { root });
  assert.equal(st.selects, 2);
  await E.tryClaimDek(sb, 'dev-1', { root }); assert.equal(st.selects, 2, '백오프 중 자동 확인은 건너뛴다');
  await E.tryClaimDek(sb, 'dev-1', { root, force: true }); assert.equal(st.selects, 3, 'force는 즉시');
});
test('① 인접 핀: 백오프 중 행이 생기면 다음 확인 때 잠김이 풀리고, 풀린 뒤 다시 잠기면 간격이 60초부터 시작한다', async () => {
  mock.timers.enable({ apis: ['Date'], now: 30_000_000 });
  const root = await mkdtemp(join(tmpdir(), 'argo-logdiet1-e-'));
  E.clearDekCache(); E._resetClaimForTest();
  const me = await E.loadDeviceE2ee({ root });
  const DEK = Buffer.alloc(32, 9);
  const st = { selects: 0, row: null }; const sb = wrapSb(st);
  await E.tryClaimDek(sb, 'dev-1', { root }); mock.timers.tick(MIN); await E.tryClaimDek(sb, 'dev-1', { root }); // 행 없음 2번 → 다음은 5분 뒤
  st.row = { wrap: E.wrapDekFor(me.pub, DEK).toString('base64'), wrapped_by: 'dev-other' };
  mock.timers.tick(2 * MIN); assert.equal(await E.tryClaimDek(sb, 'dev-1', { root }), false, '5분 전에는 확인하지 않는다');
  mock.timers.tick(3 * MIN); assert.equal(await E.tryClaimDek(sb, 'dev-1', { root }), true, '다음 확인에서 풀린다');
  assert.deepEqual(E.dek(), DEK);
  // 백오프 초기화 — 행을 찾았으니 DEK를 잃고 행도 없어진 뒤의 첫 간격은 다시 60초
  E.clearDekCache(); st.row = null;
  const root2 = await mkdtemp(join(tmpdir(), 'argo-logdiet1-e-')); await E.loadDeviceE2ee({ root: root2 });
  mock.timers.tick(MIN);
  const s0 = st.selects; await E.tryClaimDek(sb, 'dev-1', { root: root2 }); mock.timers.tick(MIN); await E.tryClaimDek(sb, 'dev-1', { root: root2 });
  assert.equal(st.selects - s0, 2, '초기화 뒤 첫 간격은 60초');
});

/* ── ② 자동화 디스패치 회사별 60초 ── */
test('② msgr_automation_dispatch_due: 같은 회사는 60초 안에 다시 부르지 않고, 60초 뒤엔 부른다 — 회사끼리는 따로', async () => {
  const calls = [];
  const client = { rpc: async (name, args) => { calls.push({ name, ws: args.p_ws }); return { data: [{ id: 1 }], error: null }; } };
  const r1 = await dispatchMessengerAutomations(client, 'ws-a', { now: () => 1_000_000 });
  assert.deepEqual(r1, { available: true, runs: [{ id: 1 }] });
  for (const t of [1_015_000, 1_030_000, 1_045_000, 1_059_999]) {
    const r = await dispatchMessengerAutomations(client, 'ws-a', { now: () => t });
    assert.equal(r.available, true); assert.deepEqual(r.runs, [], '건너뛴 틱은 실행 없음');
  }
  assert.equal(calls.length, 1, '15초 틱 4번 모두 건너뜀');
  await dispatchMessengerAutomations(client, 'ws-b', { now: () => 1_015_000 });
  assert.equal(calls.length, 2, '다른 회사는 따로');
  await dispatchMessengerAutomations(client, 'ws-a', { now: () => 1_060_000 });
  assert.equal(calls.filter((c) => c.ws === 'ws-a').length, 2, '60초 뒤 다시 부른다');
});
test('② 호출이 실패해도 60초 안에는 다시 부르지 않는다(실패도 요청 예산) — 옛 DB(PGRST202)도 같다', async () => {
  let n = 0;
  const client = { rpc: async () => { n++; return { data: null, error: { code: n === 1 ? '500' : 'PGRST202', message: 'x' } }; } };
  await assert.rejects(() => dispatchMessengerAutomations(client, 'ws-err', { now: () => 5_000_000 }), /msgr automation/);
  await dispatchMessengerAutomations(client, 'ws-err', { now: () => 5_015_000 });
  assert.equal(n, 1);
  const r = await dispatchMessengerAutomations(client, 'ws-err', { now: () => 5_060_000 });
  assert.equal(n, 2); assert.equal(r.available, false);
});

/* ── ④ 알림 claim·경로 동기화 간격 ── */
test('④ 회사별 알림 틱 게이트는 60초 — 10초 루프에서 6틱에 한 번(종전 30초)', () => {
  assert.equal(N.NOTIFY_TICK_MS, 60_000);
  assert.equal(N.notificationTickDue(undefined, 0), true);
  assert.equal(N.notificationTickDue({ at: 0 }, 59_999), false);
  assert.equal(N.notificationTickDue({ at: 0 }, 60_000), true);
  assert.equal(N.notificationTickDue({ busy: true, at: 0 }, 120_000), false, '진행 중인 틱은 겹치지 않는다');
});
test('④ 경로 동기화 120초: 10초 루프+60초 게이트에서 ready 경로가 있으면 동기화 간격 120~140초 — 서버 60초 생략 기준 초과·3분 신선도 안, 1시간 claim 60번(종전 120)', async () => {
  assert.equal(N.ROUTE_SYNC_MS, 120_000);
  let t = 0; const calls = [];
  const client = { rpc: async (name) => { calls.push({ name, at: t }); return { data: [], error: null }; } };
  const conns = { telegram: { enabled: true, token: 'x', chatId: '1' }, slack: { enabled: false } };
  const memo = new Map(); let gate;
  const deps = { session: async () => ({ uid: 'u', client }), readCompany: async () => ({ name: 'M', ownerId: 'u' }), readConnections: async () => conns, readAgents: async () => [], readDeviceId: async () => 'dev', attempt: 'a', memo, now: () => t, send: async () => ({ status: 'sent' }) };
  // 이 시험이 쓰는 연결은 resolveTelegramDest가 ready로 판정해야 한다 — 아니면 시험이 무의미하므로 확인한다
  assert.ok(N.notificationRoutes({ name: 'M', id: 'ws' }, conns, []).some((r) => r.ready), 'ready 경로 있음');
  for (; t < 3600_000; t += 10_000) { // gateway.mjs: 10초 루프 + 회사별 게이트
    if (!N.notificationTickDue(gate, t)) continue;
    gate = { at: t };
    await N.deliverMessengerNotifications('ws', deps);
  }
  const syncs = calls.filter((c) => c.name === 'msgr_notification_routes_sync').map((c) => c.at);
  assert.equal(calls.filter((c) => c.name === 'msgr_notification_claim').length, 60);
  const gaps = syncs.slice(1).map((a, i) => a - syncs[i]);
  assert.ok(gaps.every((g) => g >= 120_000 && g < 180_000), `동기화 간격 ${[...new Set(gaps)]}`);
  assert.ok(syncs.length <= 31, `1시간 동기화 ${syncs.length}회(종전 약 40)`);
});
test('④ 인접 핀: 경로 목록이 바뀌면 간격과 무관하게 그 틱에 바로 동기화한다', () => {
  const r1 = [{ kind: 'telegram', ready: false }], r2 = [{ kind: 'telegram', ready: true }];
  const memo = { routes: JSON.stringify(r1), syncedAt: 1000, claimedAt: 1000 };
  assert.equal(N.notificationPlan(memo, r1, 2000).sync, false);
  assert.equal(N.notificationPlan(memo, r2, 2000).sync, true, '목록이 바뀜');
  const m2 = { ...memo, routes: JSON.stringify(r2) };
  assert.equal(N.notificationPlan(m2, r2, 1000 + 119_999).sync, false);
  assert.equal(N.notificationPlan(m2, r2, 1000 + 120_000).sync, true);
});

/* ── #1050 검수 1 지적 반영 ── */
test('① 두 사본 DEK 전파: 행 없음이 8번 쌓인 sync 사본도 다른 사본(라우트)이 setDek하면 다음 호출에 디스크 DEK를 집는다 — 원격 조회 없이(종전 PR 1800초, main 60초)', async () => {
  mock.timers.enable({ apis: ['Date'], now: 40_000_000 });
  const root = await mkdtemp(join(tmpdir(), 'argo-logdiet1-e-'));
  // 번들 사본 둘(sync·instrumentation 쪽과 API 라우트 쪽) — 모듈 상태(dekBuf·claimMisses·lastClaim)를 따로 가진다
  const SYNC = await import('../src/e2ee.mjs?copy=sync');
  const ROUTE = await import('../src/e2ee.mjs?copy=route');
  SYNC.clearDekCache(); SYNC._resetClaimForTest(); ROUTE.clearDekCache();
  await SYNC.loadDeviceE2ee({ root });
  const st = { selects: 0, row: null }; const sb = wrapSb(st);
  while (st.selects < 8) { await SYNC.tryClaimDek(sb, 'dev-1', { root }); mock.timers.tick(10_000); }
  const selects = st.selects;
  mock.timers.tick(5_000);
  const key = Buffer.alloc(32, 7);
  await ROUTE.setDek(key, { root }); // 켜기·회수 버튼(force 회수도 끝에 setDek)이 라우트 사본에서 일어남
  mock.timers.tick(10_000); // 다음 sync 사이클
  assert.equal(SYNC.dek(), null, '아직 이 사본의 캐시는 비어 있다');
  assert.equal(await SYNC.tryClaimDek(sb, 'dev-1', { root }), true, '디스크 DEK를 즉시 집는다(간격 게이트와 무관)');
  assert.deepEqual(SYNC.dek(), key);
  assert.equal(st.selects, selects, 'wrapped_deks 원격 조회는 하지 않는다');
});

test('④ 알림 노드 3분 경계: 틱 시작 노드 나이 115초 + 텔레그램 타임아웃 35초가 이어져도 행마다 권한 확인 직전 나이 100초 미만 — 4행 모두 배달 시도(종전 PR은 3번째부터 skipped)', async () => {
  assert.equal(N.NODE_FRESH_MS, 100_000);
  const SERVER_FRESH = 180_000; // 20260913110500 msgr_notification_authorize: node.last_seen_at >= now() - 3분
  let t = 1_000_000; let lastSeen = 0; const ages = []; const calls = [];
  const rows = [1, 2, 3, 4].map((i) => ({ delivery_id: `d${i}`, ws_id: 'ws', kind: 'telegram', status: 'completed', run_id: `r${i}`, title: 'x', body: 'b' }));
  const client = { rpc: async (name) => {
    calls.push(name);
    if (name === 'msgr_notification_routes_sync') { lastSeen = t; return { data: null, error: null }; }
    if (name === 'msgr_notification_claim') return { data: rows, error: null };
    if (name === 'msgr_notification_authorize') { ages.push(t - lastSeen); return { data: t - lastSeen <= SERVER_FRESH, error: null }; }
    return { data: true, error: null }; // finish
  } };
  const conns = { telegram: { enabled: true, token: 'x', chatId: '1' }, slack: { enabled: false } };
  const routes = N.notificationRoutes({ name: 'M', ownerId: 'u', id: 'ws' }, conns, []);
  assert.ok(routes.some((r) => r.ready), 'ready 경로 있음');
  const memo = new Map([['u:ws:dev', { routes: JSON.stringify(routes), syncedAt: t - 115_000, claimedAt: t - 60_000 }]]);
  lastSeen = t - 115_000; // 틱 사이가 불규칙해(앞 틱이 오래 걸림) 동기화 기한 120초 직전에 claim하는 경우
  const send = async () => { t += 35_000; return { status: 'uncertain', reason: 'timeout' }; }; // gateway.mjs 텔레그램 send 타임아웃 35초
  const deps = { session: async () => ({ uid: 'u', client }), readCompany: async () => ({ name: 'M', ownerId: 'u' }), readConnections: async () => conns, readAgents: async () => [], readDeviceId: async () => 'dev', attempt: 'a', memo, now: () => t, send };
  const r = await N.deliverMessengerNotifications('ws', deps);
  assert.equal(calls[0], 'msgr_notification_claim', '틱 시작에는 동기화하지 않는다(나이 115초 < 120초)');
  assert.ok(ages.every((a) => a < N.NODE_FRESH_MS), `권한 확인 시점 노드 나이 ${ages.map((a) => a / 1000)}초`);
  assert.deepEqual(r.deliveries.map((d) => d.reason), ['timeout', 'timeout', 'timeout', 'timeout'], '권한 거부(permission_or_connection_changed)로 사라지는 행이 없다');

  // 평상시(send가 빠름): 추가 동기화 없음 — 부하는 120~140초 동기화 그대로
  calls.length = 0; ages.length = 0;
  memo.set('u:ws:dev', { routes: JSON.stringify(routes), syncedAt: t - 70_000, claimedAt: t - 60_000 }); lastSeen = t - 70_000;
  await N.deliverMessengerNotifications('ws', { ...deps, send: async () => ({ status: 'sent' }) });
  assert.equal(calls.filter((c) => c === 'msgr_notification_routes_sync').length, 0, 'send가 빠르면 동기화 요청이 늘지 않는다');
});

/* ── ⑤ 진단 헤더 ── */
test('⑤ 두 Supabase 클라이언트 옵션 모두 x-argo-app-version 헤더를 싣는다 — 인증 헤더·타임아웃 fetch는 그대로', () => {
  assert.ok(APP_VERSION, '시험 환경에서 버전을 읽는다');
  const m = msgrClientOptions('tok');
  assert.equal(m.global.headers['x-argo-app-version'], APP_VERSION);
  assert.equal(m.global.headers.Authorization, 'Bearer tok');
  const s = syncClientOptions('tok2');
  assert.equal(s.global.headers['x-argo-app-version'], APP_VERSION);
  assert.equal(s.global.headers.Authorization, 'Bearer tok2');
  assert.equal(typeof s.global.fetch, 'function', '30초 타임아웃 fetch 보존');
  assert.equal(syncClientOptions().global.headers.Authorization, undefined, '서비스 모드는 인증 헤더 없이');
  assert.equal(syncClientOptions().global.headers['x-argo-app-version'], APP_VERSION);
});
