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
