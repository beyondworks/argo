// 본체 전송부(src/agent-link-host.mjs supabaseTransport) — 토큰 회전 뒤 새 클라이언트로 옮기기, 진행 방송 채널 닫기, 봉투 풀기.
// 종전: boot 때 받은 클라이언트를 끝까지 써서, 기기 세션 토큰이 회전한 뒤(게이트웨이 sessionClient가 새 클라이언트를 만든다) 옛 토큰이 만료되면 REST가 401이었다.
//       진행 방송용 v2:wk:<일> 채널은 닫지 않아 일마다 쌓였다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { supabaseTransport, unwrapEnvelope } from '../src/agent-link-host.mjs';
import { TOPICS } from '../packages/agent-link/contract/v1.mjs';
import { createLink } from '../packages/agent-link/link.mjs';

function fakeClient(name) {
  const chans = []; const calls = [];
  return {
    name, chans, calls,
    channel(topic) {
      const ch = { topic, removed: false, handlers: [], status: null,
        on(type, filter, cb) { this.handlers.push({ type, event: filter?.event, cb }); return this; },
        subscribe(cb) { this.status = cb; cb?.('SUBSCRIBED'); return this; }, async send(m) { calls.push(['send', topic, m.event]); return 'ok'; } };
      chans.push(ch); return ch;
    },
    removeChannel(ch) { ch.removed = true; },
    async rpc(fn) { calls.push(['rpc', fn]); return { data: { ok: true }, error: null, status: 200 }; },
  };
}
const live = (c) => c.chans.filter((ch) => !ch.removed).map((ch) => ch.topic);

test('봉투 풀기: {envelope} · 봉투 자체 · 봉투 아님', () => {
  const env = { v: 1, type: 'work.offer', work: 'w' };
  assert.equal(unwrapEnvelope({ envelope: env }), env);
  assert.equal(unwrapEnvelope(env), env);
  assert.equal(unwrapEnvelope({ message: { id: 1 } }), null);
  assert.equal(unwrapEnvelope(null), null);
  assert.equal(unwrapEnvelope('x'), null);
});

test('토큰 회전: 다음 요청부터 새 클라이언트를 쓰고, 구독 채널을 새 클라이언트로 옮겨 다시 connected(→ 따라잡기)', async () => {
  const A = fakeClient('A'), B = fakeClient('B');
  let current = A;
  const t = supabaseTransport(async () => current);
  const status = [];
  await t.rpc('msgr2_link_pending', {}); // 첫 요청이 클라이언트를 정한다
  const sub = t.subscribe('v2:w:u', () => {}, (s) => status.push(s));
  assert.deepEqual(live(A), ['v2:w:u']);
  assert.deepEqual(status, ['connected']);
  current = B; // 게이트웨이 sessionClient가 회전한 토큰으로 새 클라이언트를 만들었다
  await t.rpc('msgr2_link_send', {});
  assert.deepEqual(A.calls.map((c) => c[1]), ['msgr2_link_pending'], '옛 클라이언트로는 더 보내지 않는다');
  assert.deepEqual(B.calls.map((c) => c[1]), ['msgr2_link_send']);
  assert.deepEqual(live(A), [], '옛 클라이언트의 구독은 닫는다');
  assert.deepEqual(live(B), ['v2:w:u'], '새 클라이언트로 다시 구독');
  assert.deepEqual(status, ['connected', 'connected'], '다시 connected — 링크가 따라잡기를 한 번 한다');
  // 옮긴 뒤 옛 채널의 상태 알림은 무시
  A.chans[0].status('CLOSED');
  assert.deepEqual(status, ['connected', 'connected']);
  sub.close();
  assert.deepEqual(live(B), []);
});

test('토큰 그대로면 같은 클라이언트·같은 채널(요청마다 다시 구독하지 않는다)', async () => {
  const A = fakeClient('A');
  const t = supabaseTransport(async () => A);
  await t.rpc('x', {});
  t.subscribe('v2:w:u', () => {}, () => {});
  for (let i = 0; i < 5; i++) await t.rpc('x', {});
  assert.equal(A.chans.length, 1);
});

test('세션이 없으면 요청은 오류 값으로(던지지 않음), 구독은 disconnected', async () => {
  const t = supabaseTransport(async () => null);
  const r = await t.rpc('x', {});
  assert.equal(r.error.code, 'no_session');
  const st = [];
  t.subscribe('v2:w:u', () => {}, (s) => st.push(s));
  await new Promise((res) => setTimeout(res, 0));
  assert.deepEqual(st, ['disconnected']);
});

test('진행 방송 채널은 일마다 하나를 다시 쓰고 release로 닫는다(링크가 일 끝에 부르는 것은 packages/agent-link/test/link.test.mjs)', async () => {
  const A = fakeClient('A');
  const t = supabaseTransport(A);
  await t.broadcast(TOPICS.work('w1'), { v: 1, type: 'work.progress' });
  await t.broadcast(TOPICS.work('w1'), { v: 1, type: 'work.progress' });
  assert.equal(t.openChannels, 1, '같은 일은 채널 하나를 다시 쓴다');
  t.release(TOPICS.work('w1'));
  assert.equal(t.openChannels, 0);
  assert.equal(A.chans[0].removed, true);
});

test('쉬는 본체: 요청 없이 토큰이 회전해도 refresh()가 구독을 새 클라이언트로 옮기고 connected를 한 번 다시 낸다', async () => {
  const A = fakeClient('A'), B = fakeClient('B');
  let current = A;
  const t = supabaseTransport(async () => current);
  await t.refresh();
  const status = [];
  t.subscribe('v2:w:u', () => {}, (s) => status.push(s));
  current = B; // 요청 없이 회전
  await t.refresh();
  assert.deepEqual({ liveOnA: live(A), liveOnB: live(B) }, { liveOnA: [], liveOnB: ['v2:w:u'] });
  assert.deepEqual(status, ['connected', 'connected']);
  assert.equal(A.calls.length + B.calls.length, 0, 'refresh는 네트워크 요청이 아니다');
  await t.refresh(); // 그대로면 아무것도 안 바꾼다
  assert.equal(B.chans.length, 1);
});

test('끊긴 구독은 1분 뒤 refresh에서 다시 붙고(그 전 refresh는 채널만 떼어 realtime-js 재시도를 멈춘다), 살아 있으면 그대로', async () => {
  const A = fakeClient('A');
  let t0 = 0;
  const t = supabaseTransport(A, { now: () => t0 });
  const status = [];
  t.subscribe('v2:w:u', () => {}, (s) => status.push(s));
  await t.refresh();
  assert.equal(A.chans.length, 1, '살아 있는 구독은 다시 붙이지 않는다');
  A.chans[0].status('CHANNEL_ERROR'); // 옛 토큰 만료 등으로 서버가 닫았다
  assert.deepEqual(status, ['connected', 'disconnected']);
  t0 = 10_000; await t.refresh();
  assert.deepEqual(live(A), [], '끊긴 채널을 뗐다');
  assert.equal(A.chans.length, 1, '1분 전에는 다시 열지 않는다');
  t0 = 60_000; await t.refresh();
  assert.deepEqual(live(A), ['v2:w:u']);
  assert.equal(A.chans.length, 2);
  assert.deepEqual(status, ['connected', 'disconnected', 'connected']);
});

// 계속 거부하는 서버: 가입하면 늘 CHANNEL_ERROR
function denyingClient() {
  const c = fakeClient('deny');
  const ch0 = c.channel.bind(c);
  c.channel = (topic) => { const ch = ch0(topic); ch.subscribe = function (cb) { this.status = cb; cb?.('CHANNEL_ERROR'); return this; }; return ch; };
  return c;
}

test('계속 거부 → 다시 붙기는 1→2→5→10분 간격, 어느 1분에도 가입 1번 이하(10초마다 refresh, 20분)', async () => {
  const D = denyingClient();
  let t0 = 0; let checks = 0;
  const t = supabaseTransport(D, { now: () => t0 });
  t.subscribe('v2:w:u', () => {}, () => {});
  const joins = [0]; // 가입 시각
  let seen = 1;
  for (t0 = 10_000; t0 <= 20 * 60_000; t0 += 10_000) {
    await t.refresh({ beforeReopen: async () => { checks++; } });
    while (D.chans.length > seen) { joins.push(t0); seen++; }
  }
  assert.deepEqual(joins, [0, 60_000, 180_000, 480_000, 1_080_000], '첫 가입 + 1·2·5·10분 간격');
  for (let m = 0; m < 20; m++) assert.ok(joins.filter((x) => x >= m * 60_000 && x < (m + 1) * 60_000).length <= 1, `${m}분째`);
  assert.equal(checks, joins.length - 1, '다시 열 때마다 기기 확인 1번');
  assert.deepEqual(live(D), [], '거부된 채널은 남지 않는다(realtime-js 재시도 없음)');
});

test('세션 null(로그아웃·앱 관문 차단) → 옛 클라이언트와 채널을 버리고 다시 붙지 않는다, 세션이 돌아오면 그때 연다', async () => {
  const A = fakeClient('A');
  let current = A; let t0 = 0;
  const t = supabaseTransport(async () => current, { now: () => t0 });
  await t.refresh();
  const status = [];
  t.subscribe('v2:w:u', () => {}, (s) => status.push(s));
  assert.deepEqual(live(A), ['v2:w:u']);
  current = null; // sessionClient()가 null(관문이 채널을 닫았다)
  for (t0 = 10_000; t0 <= 30 * 60_000; t0 += 10_000) await t.refresh({ beforeReopen: async () => { throw new Error('부르면 안 된다'); } });
  assert.deepEqual(live(A), [], '옛 클라이언트의 채널을 뗐다');
  assert.equal(A.chans.length, 1, '옛 클라이언트로 다시 붙지 않았다');
  assert.equal((await t.rpc('x', {})).error.code, 'no_session', '옛 클라이언트로 요청도 보내지 않는다');
  assert.deepEqual(A.calls, []);
  assert.deepEqual(status, ['connected', 'disconnected']);
  current = A; await t.refresh();
  assert.deepEqual(live(A), ['v2:w:u'], '세션이 돌아오면 다시 연다');
});

test('기기 폐기 → 다시 붙기 전 확인(링크 따라잡기 rpc)에서 device_revoked → 링크가 멈추고 구독을 닫아 다시 열지 않는다', async () => {
  const D = denyingClient();
  D.rpc = async (fn) => { D.calls.push(['rpc', fn]); return { data: { ok: false, code: 'device_revoked' }, error: null, status: 200 }; };
  let t0 = 0;
  const t = supabaseTransport(D, { now: () => t0 });
  const events = [];
  const link = createLink({ transport: t, host: { canAccept: () => true, runTurn: async () => ({ text: 'x' }), onEvent: (n) => events.push(n) }, uid: 'u', device: 'd', agentIds: new Set() });
  link.start();
  for (t0 = 10_000; t0 <= 10 * 60_000; t0 += 10_000) await t.refresh({ beforeReopen: () => link.catchUp() });
  assert.equal(link.stopped, true, '링크가 멈췄다');
  assert.ok(events.includes('device_invalid'));
  assert.equal(D.chans.length, 1, '처음 가입 뒤 다시 열지 않았다');
  assert.deepEqual(live(D), []);
  assert.deepEqual(D.calls.map((c) => c[1]), ['msgr2_link_pending'], '확인 rpc 1번뿐');
});

test('닫은 진행 토픽에 늦게 온 진행 방송은 채널을 다시 만들지 않는다(취소로 먼저 닫힌 경쟁)', async () => {
  const A = fakeClient('A');
  let gate; const wait = new Promise((r) => { gate = r; });
  let first = true;
  const t = supabaseTransport(async () => { if (first) { first = false; await wait; } return A; });
  const p = t.broadcast(TOPICS.work('w9'), { v: 1, type: 'work.progress' }); // 클라이언트를 기다리는 중
  t.release(TOPICS.work('w9')); // 그 사이 일이 끝났다
  gate(); await p;
  assert.equal(t.openChannels, 0);
  assert.equal(A.chans.length, 0, '채널을 만들지 않았다');
  await t.broadcast(TOPICS.work('w9'), { v: 1, type: 'work.progress' });
  assert.equal(A.chans.length, 0);
});
