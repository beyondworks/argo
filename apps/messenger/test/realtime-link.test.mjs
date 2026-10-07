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

// 2차 검수 L-a(2026-10-05): 1회차가 실패하면 do…while이 예외로 빠져, 도는 중에 겹쳐 온 2회차(그 사이 온 글)를 버렸다 — 실시간이 살아 있어 10초 보정도 꺼져 있으니
// 그 글이 다음 신호까지 안 보였다. 회차마다 실패를 받고, 겹친 요청이 있었으면 한 번 더 돈다. 끝에 남은 실패는 던진다. 회차 상한으로 끝없이 돌지 않는다.
test('L-a 따라잡기 1회차가 실패해도 겹쳐 온 요청은 한 번 더 돈다 — 마지막 회차의 실패만 던진다', async () => {
  let runs = 0; const gates = [];
  const go = createCatchUp(() => { runs++; return new Promise((ok, no) => gates.push({ ok, no })); });
  const p = go(); go(); // 1회차가 도는 중에 방송 2가 왔다
  gates[0].no(new Error('Failed to fetch')); await new Promise((r) => setTimeout(r, 0));
  assert.equal(runs, 2, '겹친 요청이 실행됐다');
  gates[1].ok(); await p; // 2회차가 성공하면 전체는 성공
  const q = go(); gates[2].no(new Error('A')); await assert.rejects(q, /A/, '겹친 요청이 없으면 실패를 그대로 던진다');
});

test('L-a 매 회차 실패하면서 요청이 계속 겹쳐도 회차 상한에서 멈추고 마지막 실패를 던진다', async () => {
  let runs = 0; let go;
  go = createCatchUp(async () => { runs++; await null; go(); throw new Error(`fail ${runs}`); }); // 회차마다(조회 중에) 새 요청이 겹친다
  await assert.rejects(go(), /fail 3/);
  assert.equal(runs, 3, '상한 3회');
});

// ── 재연결 한 번에 목록 다시 읽기 한 번(2026-10-07 운영 데스크톱 0.1.51: 재연결 한 번에 구독 약 55개가 몇 초에 걸쳐 붙으며 고정 창(0.8초)마다
// 전체 재조회(요청 약 24건)가 7~8번 돌았다 — 23:21:54~23:24:10에 요청 576건). 조용해진 뒤 한 번 + 상한, u:가 붙는 서버에서는 방 토픽이 부르지 않는다.
// 가상 시계 — 타이머를 시각 순으로 돌린다(묶기 창·상한을 실제 시간 없이 잰다)
function clock() {
  let t = 0; let id = 0; const q = [];
  return {
    now: () => t,
    timer: (fn, ms) => { q.push({ id: ++id, fn, at: t + ms }); return id; },
    clear: (x) => { const i = q.findIndex((e) => e.id === x); if (i >= 0) q.splice(i, 1); },
    advance(ms) { const end = t + ms; for (;;) { q.sort((a, b) => a.at - b.at || a.id - b.id); if (!q.length || q[0].at > end) break; const e = q.shift(); t = e.at; e.fn(); } t = end; },
  };
}
const watchOn = (c, onSync) => createLinkWatch({ onSync, timer: c.timer, clear: c.clear, now: c.now });
const rooms = (n) => Array.from({ length: n }, (_, i) => `dm:r${i}`);

test('재연결 한 번 — 조직 2 + u: + 방 52가 150ms 간격으로 8초에 걸쳐 붙어도 목록 다시 읽기는 한 번, 방 52개를 기다리지 않는다', () => {
  const c = clock(); const at = [];
  const w = watchOn(c, () => at.push(c.now()));
  const keys = ['org:a', 'org:b', 'u:me', ...rooms(52)];
  for (const k of keys) w.status(k, 'SUBSCRIBED'); // 처음 연결 — 신호 없음
  for (const k of keys) w.status(k, 'CHANNEL_ERROR'); // 소켓이 끊겼다(하트비트 시간 초과)
  for (const k of keys) { assert.equal(w.status(k, 'SUBSCRIBED'), 'up', k); c.advance(150); }
  c.advance(20_000);
  assert.equal(at.length, 1, `목록 다시 읽기 ${at.length}번(종전: 0.8초 창마다 한 번)`);
  assert.ok(at[0] <= 3 * 150 + 800, `u:가 붙은 뒤 0.8초 안에(${at[0]}ms) — 방 토픽 52개가 다 붙을 때까지(7.8초) 미루지 않는다`);
});

test('옛 서버(u:가 한 번도 안 붙음) — 방 토픽이 끊겼다 붙으면 종전처럼 목록을 다시 읽되, 8초에 걸쳐 붙어도 한 번', () => {
  const c = clock(); let syncs = 0;
  const w = watchOn(c, () => { syncs++; });
  w.status('u:me', 'CHANNEL_ERROR'); // 서버가 u:를 거절(joinWithBackoff가 1분 뒤 다시 시도)
  for (const k of rooms(52)) w.status(k, 'SUBSCRIBED');
  for (const k of rooms(52)) w.status(k, 'CLOSED');
  for (const k of rooms(52)) { w.status(k, 'SUBSCRIBED'); c.advance(150); }
  c.advance(20_000);
  assert.equal(syncs, 1);
});

test('u:가 붙는 서버에서 방 토픽만 끊겼다 붙으면 목록은 다시 읽지 않는다 — 다시 붙음(up)은 그대로(열린 개인 방의 rt_up)', () => {
  const c = clock(); let syncs = 0;
  const w = watchOn(c, () => { syncs++; });
  for (const k of ['org:a', 'u:me', 'dm:r1']) w.status(k, 'SUBSCRIBED');
  assert.equal(w.status('dm:r1', 'CHANNEL_ERROR'), 'down');
  assert.equal(w.status('dm:r1', 'SUBSCRIBED'), 'up');
  c.advance(20_000);
  assert.equal(syncs, 0);
});

test('구독이 30초 동안 0.3초마다 끊겼다 붙어도(폭주) 목록 다시 읽기는 첫 붙음 뒤 10초마다 많아야 한 번', () => {
  const c = clock(); const at = [];
  const w = watchOn(c, () => at.push(c.now()));
  w.status('org:a', 'SUBSCRIBED'); w.status('u:me', 'SUBSCRIBED');
  for (let i = 0; i < 100; i++) { w.status('org:a', 'CHANNEL_ERROR'); w.status('org:a', 'SUBSCRIBED'); c.advance(300); }
  c.advance(20_000);
  assert.ok(at.length >= 3 && at.length <= 4, `${at.length}번(종전 약 33번)`);
  for (let i = 1; i < at.length - 1; i++) assert.ok(at[i] - at[i - 1] >= 10_000, `간격 ${at[i] - at[i - 1]}ms`);
});

// ── 검수 반영(2026-10-08): '조용해진 뒤 한 번'은 org:와 u:가 연달아 붙을 때만 한 번이었다. phoenix는 소켓이 다시 붙으면 채널을 만든 순서대로
// 다시 가입한다 — 만료 토큰 거절 뒤 joinWithBackoff가 u:를 새로 만들면 u:가 방 토픽들 뒤로 간다. 그러면 org: 뒤 0.8초에 한 번, u: 뒤에 또 한 번,
// 조직이 방 토픽 사이에 갈리면 세 번 전체 재조회가 돌았다. 아직 안 붙은 목록 키(org:·u:)가 있으면 조용함을 기다리지 않는다.
const reconnect = (order) => {
  const c = clock(); const at = []; let uUp = -1;
  const w = watchOn(c, () => at.push(c.now()));
  for (const k of order) w.status(k, 'SUBSCRIBED');
  for (const k of order) w.status(k, 'CHANNEL_ERROR');
  for (const k of order) { if (k === 'u:me') uUp = c.now(); w.status(k, 'SUBSCRIBED'); c.advance(150); }
  c.advance(20_000);
  return { at, uUp };
};
for (const [name, order] of [
  ['u 먼저', ['org:a', 'org:b', 'u:me', ...rooms(52)]],
  ['u 중간(방 25개 뒤)', ['org:a', 'org:b', ...rooms(25), 'u:me', ...rooms(27)]],
  ['u 마지막', ['org:a', 'org:b', ...rooms(52), 'u:me']],
  ['조직 사이에 방', ['org:a', ...rooms(20), 'org:b', ...rooms(32), 'u:me']],
  ['u가 조직보다 먼저', ['u:me', ...rooms(30), 'org:a', ...rooms(22), 'org:b']],
]) {
  test(`재연결 순서 '${name}' — 목록 다시 읽기는 한 번, 마지막 목록 키(org:·u:)가 붙은 뒤 0.8초`, () => {
    const { at } = reconnect(order);
    const lastList = Math.max(...order.map((k, i) => (k.startsWith('dm:') ? -1 : i))) * 150;
    assert.deepEqual(at, [lastList + 800], `목록 다시 읽기 시각(종전: org: 뒤와 u: 뒤에 각각)`);
  });
}

test('나간 조직 — 조직 집합에서 빠진 키(only)는 다시 붙기를 기다리지 않는다(종전 키가 남으면 매번 10초 상한까지 미뤄진다)', () => {
  const c = clock(); const at = [];
  const w = watchOn(c, () => at.push(c.now()));
  for (const k of ['org:a', 'org:b', 'u:me']) w.status(k, 'SUBSCRIBED');
  for (const k of ['org:a', 'org:b', 'u:me']) w.status(k, 'CHANNEL_ERROR');
  w.only(['org:a', 'u:me']); // 끊긴 동안 org:b에서 나갔다 — 구독 효과가 남은 조직으로 다시 건다
  w.status('org:a', 'SUBSCRIBED'); c.advance(150); w.status('u:me', 'SUBSCRIBED');
  c.advance(20_000);
  assert.deepEqual(at, [150 + 800]);
});

test('옛 서버(u:를 한 번도 받아 주지 않음) — 거절된 u:는 기다리지 않는다, 조직이 붙고 0.8초 뒤 한 번', () => {
  const c = clock(); const at = [];
  const w = watchOn(c, () => at.push(c.now()));
  w.status('u:me', 'CHANNEL_ERROR'); // 가입 거절 — joinWithBackoff가 1분 뒤 다시 시도
  w.status('org:a', 'SUBSCRIBED'); w.status('org:a', 'CHANNEL_ERROR');
  c.advance(1000); w.status('org:a', 'SUBSCRIBED');
  c.advance(20_000);
  assert.deepEqual(at, [1000 + 800]);
});

test('u:를 받아 주는 서버에서 u:가 거절 대기 중(1~10분)이면 — 상한(첫 키 뒤 10초)에 한 번은 부른다', () => {
  const c = clock(); const at = [];
  const w = watchOn(c, () => at.push(c.now()));
  w.status('u:me', 'SUBSCRIBED'); w.status('org:a', 'SUBSCRIBED');
  w.status('u:me', 'CHANNEL_ERROR'); w.status('org:a', 'CHANNEL_ERROR'); // 소켓이 끊겼다 — u:는 만료 토큰으로 거절돼 대기
  c.advance(500); w.status('org:a', 'SUBSCRIBED');
  c.advance(60_000);
  assert.deepEqual(at, [500 + 10_000]);
});

test('복귀(resumed)는 예약된 목록 다시 읽기를 대신한다 — 복귀가 지금 읽으니 앞서 붙은 키의 예약도 버린다(복귀 뒤 따로 한 번 더 읽던 것)', () => {
  const c = clock(); const at = [];
  const w = watchOn(c, () => at.push(c.now()));
  for (const k of ['org:a', 'u:me']) w.status(k, 'SUBSCRIBED');
  for (const k of ['org:a', 'u:me']) w.status(k, 'CHANNEL_ERROR');
  w.status('org:a', 'SUBSCRIBED'); // 목록 다시 읽기 예약(u:를 기다린다)
  c.advance(100); w.resumed(); w.expect(['org:a', 'u:me']); // 폰 복귀 — 셸이 바로 목록을 다시 읽는다
  c.advance(200); assert.equal(w.status('u:me', 'SUBSCRIBED'), 'up', '열린 방 따라잡기 신호는 그대로');
  c.advance(20_000);
  assert.deepEqual(at, []);
});

test('기다리던 조직에서 나가면(only) 예약을 바로 당긴다 — 남은 키가 다 붙었으면 0.8초 뒤', () => {
  const c = clock(); const at = [];
  const w = watchOn(c, () => at.push(c.now()));
  for (const k of ['org:a', 'org:b', 'u:me']) w.status(k, 'SUBSCRIBED');
  for (const k of ['org:a', 'org:b', 'u:me']) w.status(k, 'CHANNEL_ERROR');
  w.status('org:a', 'SUBSCRIBED'); c.advance(150); w.status('u:me', 'SUBSCRIBED'); // org:b는 거절돼 안 붙는다(나간 조직)
  c.advance(150); w.only(['org:a', 'u:me']); // 조직 목록이 바뀌어 구독 효과가 다시 돈다
  c.advance(20_000);
  assert.deepEqual(at, [300 + 800]);
});
