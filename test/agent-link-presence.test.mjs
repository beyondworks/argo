// 본체 접속 표시(2026-10-25 메신저 0.1.65 결함 2 근본 수정) — 본체가 v2:pr:<주인>(약속 v1 TOPICS.presence)에 이 기기가 맡은 에이전트 id를 track한다.
// 종전: 아무도 track하지 않아 메신저 v2에는 켜짐 신호가 없었다(화면은 '꺼져 있음'·잠든 얼굴 → 임시로 상태 표시 없음).
// 잠그는 것: 들어간 직후 1번 track, 같은 상태는 다시 보내지 않음, 바뀌면 1번, 비면 채널 닫기, 토큰 회전 뒤 새 클라이언트로 다시 track,
//            끊기면 1→2→5→10분 간격으로만 다시, DB 요청 0(rpc·from 없음), 호스트가 대응표·쉼·멈춤에 맞춰 올리고 내린다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { supabaseTransport, createAgentLinkHost } from '../src/agent-link-host.mjs';
import { TOPICS } from '../packages/agent-link/contract/v1.mjs';
import { createFakeServer } from '../packages/agent-link/test/fake-server.mjs';

const UID = 'u1';
const DEV = 'c4d5e6f7-8091-4a2b-9c3d-4e5f6a7b8c03';
function fakeClient(name, { status = 'SUBSCRIBED' } = {}) {
  const chans = []; const db = [];
  return { name, chans, db,
    channel(topic, opts) {
      const ch = { topic, opts, removed: false, tracks: [], cb: null,
        on() { return this; }, subscribe(cb) { this.cb = cb; if (status) cb(status); return this; }, track(s) { this.tracks.push(s); return Promise.resolve('ok'); } };
      chans.push(ch); return ch;
    },
    removeChannel(ch) { ch.removed = true; },
    async rpc(fn) { db.push(['rpc', fn]); return { data: null, error: null }; },
    from(t) { db.push(['from', t]); return {}; } };
}
const livePr = (c) => c.chans.filter((ch) => !ch.removed && ch.topic.startsWith('v2:pr:'));

test('전송부: 들어간 직후 1번 track(기기 key, 비공개), 같은 상태 0, 바뀌면 1번, 비면 닫기 — DB 요청 0', async () => {
  const A = fakeClient('A'); const t = supabaseTransport(A);
  const topic = TOPICS.presence(UID);
  t.presence(topic, 'dev-1', { v: 1, agents: ['a1', 'a2'] });
  const ch = livePr(A)[0];
  assert.deepEqual(ch.opts, { config: { private: true, presence: { key: 'dev-1' } } });
  assert.deepEqual(ch.tracks, [{ v: 1, agents: ['a1', 'a2'] }]);
  t.presence(topic, 'dev-1', { v: 1, agents: ['a1', 'a2'] });
  assert.equal(ch.tracks.length, 1, '같은 상태는 보내지 않는다');
  t.presence(topic, 'dev-1', { v: 1, agents: ['a1'] });
  assert.equal(ch.tracks.length, 2);
  t.presence(topic, 'dev-1', null);
  assert.equal(livePr(A).length, 0, '맡은 에이전트가 없으면 채널을 닫는다(Presence가 나감을 알린다)');
  assert.deepEqual(A.db, [], 'Presence는 DB 요청이 아니다');
});

test('전송부: 토큰 회전 뒤 새 클라이언트로 다시 들어가 track, 끊기면 간격이 지난 뒤에만 다시 연다', async () => {
  const A = fakeClient('A'); const B = fakeClient('B'); let cur = A; let t0 = 0;
  const t = supabaseTransport(async () => cur, { now: () => t0 });
  await t.rpc('x', {});
  t.presence(TOPICS.presence(UID), 'dev-1', { v: 1, agents: ['a1'] });
  cur = B; await t.refresh();
  assert.equal(livePr(A).length, 0); assert.deepEqual(livePr(B)[0].tracks, [{ v: 1, agents: ['a1'] }]);
  livePr(B)[0].cb('CHANNEL_ERROR');
  await t.refresh(); assert.equal(B.chans.filter((c) => c.topic.startsWith('v2:pr:')).length, 1, '1분 전에는 다시 열지 않는다');
  t0 += 60_000; await t.refresh();
  const again = livePr(B).at(-1);
  assert.equal(B.chans.filter((c) => c.topic.startsWith('v2:pr:')).length, 2); assert.deepEqual(again.tracks, [{ v: 1, agents: ['a1'] }]);
  assert.deepEqual(B.db.filter((x) => x[0] === 'from'), []);
});

async function bootHost({ paused = false } = {}) {
  const server = createFakeServer({ now: () => Date.now(), uid: UID });
  server.opts.paused = paused;
  const rpc0 = server.transport.rpc;
  server.transport.rpc = async (name, args) => (name === 'msgr2_device_register' ? { data: { device_id: DEV }, error: null } : rpc0(name, args));
  const published = [];
  const transport = Object.assign(Object.create(server.transport), { rpc: server.transport.rpc, presence: (topic, key, state) => published.push({ topic, key, state }) });
  const host = createAgentLinkHost({
    getSession: async () => ({ client: {}, uid: UID }),
    listOwnedAgents: async () => [{ ws: 'co-1', slug: 'pm', name: 'PM' }, { ws: 'co-1', slug: 'dev', name: 'Dev' }],
    chat: async () => ({ reply: 'x' }), onNotify: () => () => {}, vaultDir: () => '/tmp', transportFor: () => transport, log: () => {},
  });
  host.start();
  for (let i = 0; i < 200 && !published.length; i++) await new Promise((r) => setTimeout(r, 5));
  return { host, published, server };
}

test('호스트: 대응표가 정해지면 내 토픽(v2:pr:<나>)에 기기 key로 맡은 에이전트 id(정렬)를 올리고, 멈추면 내린다', async () => {
  const { host, published, server } = await bootHost();
  const ids = [server.agentIds.get('co-1/pm'), server.agentIds.get('co-1/dev')].sort();
  assert.deepEqual(published[0], { topic: `v2:pr:${UID}`, key: DEV, state: { v: 1, agents: ids } });
  host.stop();
  assert.deepEqual(published.at(-1), { topic: `v2:pr:${UID}`, key: DEV, state: null });
});

test('호스트: 일을 받을 수 없는 사건(중단·기기 폐기)이 오면 접속 표시를 내리고, 중단이 풀리면 다시 올린다', async () => {
  for (const [flip, kind] of [[(sv) => { sv.opts.paused = true; }, 'paused'], [(sv) => { sv.opts.revoked = true; }, 'device_invalid']]) {
    const { host, published, server } = await bootHost();
    const up = published.at(-1);
    assert.ok(up.state?.agents?.length, '시작 때 올림');
    flip(server);
    host.link.catchUp();
    for (let i = 0; i < 200 && published.at(-1)?.state !== null; i++) await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(published.at(-1), { topic: `v2:pr:${UID}`, key: DEV, state: null }, `${kind} — 켜짐으로 남지 않는다`);
    if (kind === 'paused') {
      server.opts.paused = false;
      host.link.catchUp();
      for (let i = 0; i < 200 && published.at(-1)?.state === null; i++) await new Promise((r) => setTimeout(r, 5));
      assert.deepEqual(published.at(-1), up, '중단이 풀리면(resumed) 다시 올린다');
    }
    host.stop();
  }
});
