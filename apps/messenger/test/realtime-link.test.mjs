// 실시간 끊김 → 다시 붙음의 짝(MSG-01·03·04, 2026-10-05 분리 검증). 구독을 새로 걸 때(복귀·조직 집합·전체 해제) '끊겼었다'를 잊으면
// 열린 방의 10초 보정 조회가 멈추지 않고(rt_up 없음), 거는 사이 온 글은 다음 글이 올 때까지 안 보였다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLinkWatch, orgSubscriptionKey, roomSignal } from '../src/realtime-link.mjs';
import { readMissed, createCatchUp } from '../src/refresh-messages.mjs';

const fakeTimers = () => {
  const q = []; let id = 0;
  return { q, timer: (fn, ms) => { q.push({ id: ++id, fn, ms }); return id; }, clear: (x) => { const i = q.findIndex((t) => t.id === x); if (i >= 0) q.splice(i, 1); }, flush() { while (q.length) q.shift().fn(); } };
};

test('MSG-04 끊긴 뒤 구독을 새로 걸어도(폰 복귀) 첫 SUBSCRIBED가 다시 붙음(up)을 낸다 — 끊김 기록이 효과 재실행을 넘어 남는다', () => {
  const w = createLinkWatch();
  assert.equal(w.status('org:a', 'CHANNEL_ERROR'), 'down');
  w.expect(['org:a', 'u:me']); // 복귀 → 구독 효과가 다시 돈다
  assert.equal(w.status('org:a', 'SUBSCRIBED'), 'up', '보정 조회를 멈추고 한 번 따라잡는다');
  assert.equal(w.status('org:a', 'SUBSCRIBED'), null, '두 번째 SUBSCRIBED는 신호가 없다');
});

test('MSG-01 구독을 다시 걸면(끊김 없이) 첫 SUBSCRIBED에서 한 번 따라잡는다 — 거는 사이 온 글이 다음 글까지 안 보이던 것', () => {
  const t = fakeTimers(); let syncs = 0;
  const w = createLinkWatch({ onSync: () => { syncs++; }, timer: t.timer, clear: t.clear });
  assert.equal(w.status('org:a', 'SUBSCRIBED'), null, '앱 첫 구독은 따라잡을 것이 없다(열 때 읽는다)');
  w.expect(['org:a']);
  assert.equal(w.status('org:a', 'SUBSCRIBED'), 'up');
  t.flush(); assert.equal(syncs, 0, '다시 걸기만 했으면 목록은 다시 읽지 않는다(호출 늘리지 않음)');
});

test('여러 구독이 한꺼번에 다시 붙으면 목록 다시 읽기는 한 번 — 조직 N개 + u: 가 각자 부르던 것', () => {
  const t = fakeTimers(); let syncs = 0;
  const w = createLinkWatch({ onSync: () => { syncs++; }, timer: t.timer, clear: t.clear });
  for (const k of ['org:a', 'org:b', 'org:c', 'u:me']) w.status(k, 'CHANNEL_ERROR');
  for (const k of ['org:a', 'org:b', 'org:c', 'u:me']) assert.equal(w.status(k, 'SUBSCRIBED'), 'up');
  t.flush(); assert.equal(syncs, 1);
});

test('복귀가 이미 목록을 다시 읽었으면 다시 붙을 때 또 읽지 않는다(신호 up은 그대로)', () => {
  const t = fakeTimers(); let syncs = 0;
  const w = createLinkWatch({ onSync: () => { syncs++; }, timer: t.timer, clear: t.clear });
  w.status('org:a', 'TIMED_OUT'); w.resumed(); w.expect(['org:a']);
  assert.equal(w.status('org:a', 'SUBSCRIBED'), 'up');
  t.flush(); assert.equal(syncs, 0);
});

test('MSG-01 토큰만 바뀌면 구독 키가 같다(다시 걸지 않는다) — 조직 집합·복귀·전체 해제만 다시 건다', () => {
  const base = { uid: 'me', orgIdsKey: 'a,b', token: 't1', resumeEpoch: 0, roomReset: 0 };
  assert.equal(orgSubscriptionKey({ ...base, token: 't2' }), orgSubscriptionKey(base));
  for (const d of [{ orgIdsKey: 'a' }, { resumeEpoch: 1 }, { roomReset: 1 }, { uid: 'you' }]) assert.notEqual(orgSubscriptionKey({ ...base, ...d }), orgSubscriptionKey(base), JSON.stringify(d));
});

test('MSG-03 개인 공간의 열린 방은 끊김과 다시 붙음을 둘 다 알린다 — 다른 방·조직 방은 알리지 않는다', () => {
  const P = '__personal__';
  const open = { roomId: 'r1', openId: 'r1', roomSpace: P, activeSpace: P, personal: P };
  assert.equal(roomSignal('down', open), 'rt_down');
  assert.equal(roomSignal('up', open), 'rt_up', '다시 붙으면 보정 조회를 멈춘다');
  assert.equal(roomSignal('up', { ...open, roomId: 'r2' }), null, '열려 있지 않은 방 50개가 각자 따라잡기를 부르지 않게');
  assert.equal(roomSignal('down', { ...open, roomId: 'r2' }), null);
  assert.equal(roomSignal('up', { ...open, roomSpace: 'org-1', activeSpace: 'org-1' }), null, '조직 방은 조직 구독이 알린다');
  assert.equal(roomSignal(null, open), null);
});

test('MSG-02 끊긴 동안 한 방에 100개 넘게 쌓여도 다 읽는다(쪽 상한 안에서)', async () => {
  const server = Array.from({ length: 450 }, (_, i) => ({ id: i + 1 }));
  let calls = 0;
  const fetchPage = async (cursor, limit) => { calls++; return server.filter((m) => m.id > cursor).slice(0, limit); };
  const r = await readMissed({ afterId: 200, pageSize: 100, maxPages: 5, fetchPage });
  assert.deepEqual([r.rows.length, r.rows[0].id, r.rows.at(-1).id, r.more], [250, 201, 450, false]);
  assert.equal(calls, 3);
});

test('MSG-02 상한을 넘으면 more=true — 화면은 최신 쪽으로 옮기고 사이는 이전 기록 불러오기가 잇는다', async () => {
  const server = Array.from({ length: 2000 }, (_, i) => ({ id: i + 1 }));
  const fetchPage = async (cursor, limit) => server.filter((m) => m.id > cursor).slice(0, limit);
  const r = await readMissed({ afterId: 10, pageSize: 100, maxPages: 5, fetchPage });
  assert.equal(r.rows.length, 500); assert.equal(r.more, true);
});

test('MSG-02 평소(쪽이 덜 찬 경우)는 요청 한 번 — 글 방송마다 부르는 경로라 호출 수가 늘지 않는다', async () => {
  let calls = 0;
  const r = await readMissed({ afterId: 5, pageSize: 100, maxPages: 5, fetchPage: async () => { calls++; return [{ id: 6 }]; } });
  assert.deepEqual([calls, r.rows.length, r.more], [1, 1, false]);
});

// 분리 검수 L3(2026-10-05): 정확히 500개(5쪽 × 100) 밀렸으면 다 읽고도 more=true라 500개를 버리고 최신으로 옮겼다 — 마지막 쪽은 하나 더 물어 남은 글을 판정한다.
test('L3 정확히 상한만큼(500개) 밀렸으면 다 읽고 more=false — 하나라도 더 있으면 more=true', async () => {
  for (const [missing, more] of [[500, false], [501, true]]) {
    const server = Array.from({ length: 10 + missing }, (_, i) => ({ id: i + 1 }));
    const r = await readMissed({ afterId: 10, pageSize: 100, maxPages: 5, fetchPage: async (cursor, limit) => server.filter((m) => m.id > cursor).slice(0, limit) });
    assert.deepEqual([r.more, more ? null : r.rows.length], [more, more ? null : 500], `${missing}개 밀림`);
  }
});

// 분리 검수 L3(2026-10-05): 글 방송마다 따라잡기(load(lastId))를 부르는데 진행 중 확인이 없어 겹쳤다 — 500개 넘게 밀리면 '최신으로 옮겼다' 안내가 겹친 수만큼 떴다.
test('L3 따라잡기는 한 번에 하나 — 도는 중에 온 요청은 끝난 뒤 한 번으로 모은다', async () => {
  let runs = 0; let release; const gates = [];
  const go = createCatchUp(() => { runs++; return new Promise((r) => { gates.push(r); }); });
  const p1 = go(); go(); go(); // 방송 세 건이 겹쳐 왔다
  assert.equal(runs, 1, '도는 중에는 새로 시작하지 않는다');
  gates[0](); await new Promise((r) => setTimeout(r, 0));
  assert.equal(runs, 2, '끝난 뒤 한 번 더(그 사이 온 글을 놓치지 않게)');
  gates[1](); await p1;
  assert.equal(runs, 2, '두 번 더가 아니라 한 번');
  go(); assert.equal(runs, 3, '끝난 뒤 새 요청은 바로 돈다'); gates[2]();
  release = createCatchUp(async () => { throw new Error('net'); });
  await assert.rejects(release(), /net/); await assert.rejects(release(), /net/, '실패 뒤에도 다음 요청은 돈다');
});
