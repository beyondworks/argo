// 본체 전송부(src/agent-link-host.mjs supabaseTransport) — 토큰 회전 뒤 새 클라이언트로 옮기기, 진행 방송 채널 닫기, 봉투 풀기.
// 종전: boot 때 받은 클라이언트를 끝까지 써서, 기기 세션 토큰이 회전한 뒤(게이트웨이 sessionClient가 새 클라이언트를 만든다) 옛 토큰이 만료되면 REST가 401이었다.
//       진행 방송용 v2:wk:<일> 채널은 닫지 않아 일마다 쌓였다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { supabaseTransport, unwrapEnvelope } from '../src/agent-link-host.mjs';
import { TOPICS } from '../packages/agent-link/contract/v1.mjs';

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
