// 읽음 커서·안 읽음 숫자(MSG-05·MSG-08, 2026-10-05 분리 검증).
//  MSG-05 읽음 커서 저장이 한 번 실패하면 같은 위치를 다시 저장하지 않아, 읽은 방이 서버·다른 기기·폰 아이콘에서 계속 안 읽음으로 남았다.
//  MSG-08 보는 공간에 글 방송이 올 때마다 msgr_unread를 묶지 않고 매번 불렀다(참여하지 않은 공개 채널 글·내 글 포함).
//  + 열린 방 배지 경합 — 저장 전 시점에 센 서버 숫자(n=1)가 늦게 도착해, 이미 읽은 열린 방에 배지를 다시 덮었다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReadCursor, unreadWorthy, createCoalescer } from '../src/read-sync.mjs';

test('MSG-05 저장이 실패하면 같은 위치를 다음 기회(초점·가시성·새 글)에 다시 저장한다', () => {
  const c = createReadCursor();
  const w = c.begin('ch', 5); assert.ok(w, '처음엔 쓴다');
  assert.equal(c.begin('ch', 5), null, '저장 중엔 같은 위치를 또 쓰지 않는다(초점·가시성 연타)');
  w.fail();
  assert.ok(c.begin('ch', 5), '실패한 위치는 다시 쓴다');
});

test('MSG-05 저장이 끝난 위치 이하는 다시 쓰지 않는다 — 초점이 바뀔 때마다 upsert하던 것(D2)은 그대로 막는다', () => {
  const c = createReadCursor();
  c.begin('ch', 5).ok();
  assert.equal(c.begin('ch', 5), null); assert.equal(c.begin('ch', 4), null);
  assert.ok(c.begin('ch', 6));
});

test('MSG-05 앞선 위치가 실패하고 뒤 위치가 저장 중이면 뒤 위치가 덮는다 — 둘 다 실패하면 다시 쓴다', () => {
  const c = createReadCursor();
  const a = c.begin('ch', 5); const b = c.begin('ch', 7);
  a.fail(); assert.equal(c.begin('ch', 6), null, '7이 저장 중이라 6은 쓰지 않는다');
  b.fail(); assert.ok(c.begin('ch', 7), '둘 다 실패 — 다시 쓴다');
});

test('열린 방 배지 경합 — 서버 숫자를 물은 뒤(또는 묻는 동안) 이 기기가 읽음으로 저장한 방은 0으로 둔다', () => {
  let t = 1000; const c = createReadCursor({ now: () => t });
  const rows = [{ channel_id: 'open', n: 1, mention: 0 }, { channel_id: 'other', n: 3, mention: 1 }];
  const since = 1000; // 숫자를 묻기 시작한 때
  t = 1100; const w = c.begin('open', 9); // 묻는 동안 열린 방을 읽음 처리 — 저장 중
  assert.deepEqual(c.unreadFrom(rows, since, 'open'), { open: { n: 0, mention: 0 }, other: { n: 3, mention: 1 } }, '저장 중인 방');
  t = 1200; w.ok();
  assert.deepEqual(c.unreadFrom(rows, since, 'open').open, { n: 0, mention: 0 }, '물은 뒤 저장이 끝난 방');
  assert.deepEqual(c.unreadFrom(rows, 1300, 'open').open, { n: 1, mention: 0 }, '저장 뒤에 물은 숫자는 그대로 쓴다(그 뒤 새 글)');
  const f = c.begin('x', 3); t = 1400; f.fail();
  assert.deepEqual(c.unreadFrom([{ channel_id: 'x', n: 2, mention: 0 }], 1000, 'x').x, { n: 2, mention: 0 }, '저장에 실패한 방은 서버 숫자를 그대로 — 실패를 감추지 않는다');
});

test('MSG-08 다시 셀 글만 고른다 — 내 글·참여하지 않은 공개 채널(미리보기·이미 물어본 방)은 건너뛴다', () => {
  const ctx = { uid: 'me', listIds: new Set(['a']), previewIds: new Set(['pub']), asked: new Set(['pub2']), openId: 'a' };
  assert.equal(unreadWorthy({ id: 1, channel_id: 'a', author_user_id: 'other' }, ctx), true, '목록에 있는 방');
  assert.equal(unreadWorthy({ id: 2, channel_id: 'a', author_user_id: 'me' }, ctx), false, '이 기기에서 보낸 내 글(열린 방)은 안 읽음이 아니다');
  assert.equal(unreadWorthy({ id: 3, channel_id: 'pub', author_user_id: 'other' }, ctx), false, '참여 전 미리보기 채널');
  assert.equal(unreadWorthy({ id: 4, channel_id: 'pub2', author_user_id: 'other' }, ctx), false, '이미 물어 내 방이 아닌 것으로 확인한 방(공개·보관)');
  assert.equal(unreadWorthy({ id: 5, channel_id: 'new', author_user_id: 'other' }, ctx), true, '처음 보는 방의 첫 글 — 새 1:1·비공개 방일 수 있다');
  assert.equal(unreadWorthy({ id: 6, channel_id: 'a', author_kind: 'crew', crew_id: 'c', author_user_id: null }, ctx), true, '크루 글');
  assert.equal(unreadWorthy(null, ctx), false);
});

test('MSG-08 연달아 온 방송은 창(1.5초) 안에서 한 번 — 계속 와도 첫 요청 뒤 1.5초에는 반드시 한 번 센다', () => {
  const q = []; let calls = 0;
  const co = createCoalescer(() => { calls++; }, { delayMs: 1500, timer: (fn, ms) => { q.push({ fn, ms }); return q.length; }, clear: () => {} });
  for (let i = 0; i < 10; i++) co.request();
  assert.equal(q.length, 1, '예약은 하나'); assert.equal(q[0].ms, 1500); assert.equal(calls, 0);
  q.shift().fn(); assert.equal(calls, 1);
  co.request(); assert.equal(q.length, 1, '창이 끝난 뒤 새 요청은 새 예약');
});

// 분리 검수 L1(2026-10-05): 내 글 방송을 아예 안 세자, 폰에서 답한 방의 배지가 데스크톱에 남았다 — msgr_reads에는 방송이 없어
// 내 글 방송 재집계가 다른 기기의 읽음을 아는 유일한 길이다. 이 기기에서 열어 둔 방이 아닌 곳의 내 글 = 다른 기기에서 쓴 글 → 센다.
test('L1 다른 기기에서 쓴 내 글(이 기기에서 열어 둔 방이 아닌 곳)은 다시 센다 — 열어 둔 방의 내 글은 세지 않는다', () => {
  const ctx = { uid: 'me', listIds: new Set(['a', 'b']), openId: 'a' };
  assert.equal(unreadWorthy({ id: 1, channel_id: 'a', author_user_id: 'me' }, ctx), false, '이 기기에서 보낸 글(열린 방)');
  assert.equal(unreadWorthy({ id: 2, channel_id: 'b', author_user_id: 'me' }, ctx), true, '폰에서 답한 방 — 폰이 읽음을 올렸다');
  assert.equal(unreadWorthy({ id: 3, channel_id: 'pub', author_user_id: 'me' }, { ...ctx, previewIds: new Set(['pub']) }), false, '참여 전 미리보기 채널은 여전히 아니다');
});

// 분리 검수 L2(2026-10-05): 저장 중·저장 확인된 방을 위치와 상관없이 0으로 두어, 열지 않은 방(목록에서 '모두 읽음' 등으로 저장 중)의
// 그 뒤 새 글까지 감췄다. 0으로 두는 것은 지금 열린 방(물은 뒤 새 글도 바로 읽음 처리되는 방)뿐이다.
test('L2 물은 뒤 저장한 방을 0으로 두는 것은 지금 열린 방만 — 다른 방은 서버 숫자를 그대로 쓴다', () => {
  let t = 1000; const c = createReadCursor({ now: () => t });
  const rows = [{ channel_id: 'open', n: 1, mention: 0 }, { channel_id: 'side', n: 4, mention: 1 }];
  t = 1100; c.begin('open', 9); c.begin('side', 5);
  assert.deepEqual(c.unreadFrom(rows, 1000, 'open'), { open: { n: 0, mention: 0 }, side: { n: 4, mention: 1 } });
});

// 분리 검수 L7(2026-10-05): 모르는 방의 첫 글(addRoom)이 조회 전에 '물어봤음'을 적어, 조회가 실패한 새 방의 다음 글이 안 읽음 재집계에서 빠졌다.
// App.jsx의 실제 addRoom 본문을 가짜 조회로 돌린다.
test('L7 방 조회가 실패하면 물어봤음으로 적지 않는다 — 다음 글이 다시 묻고 안 읽음도 센다', async () => {
  const { readFileSync } = await import('node:fs');
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const s = app.indexOf('  addRoom.current = async (cid) => {'); const e = app.indexOf('\n  };', s);
  assert.ok(s > 0 && e > s, 'addRoom 본문을 찾지 못함');
  const body = app.slice(s, e + 5).replace('addRoom.current =', 'return');
  let fail = true; const fetched = []; const channels = [];
  const chain = new Proxy({}, { get: (_, k) => (k === 'then' ? undefined : () => chain) });
  const scope = { roomAsked: { current: new Set() }, roomAsking: { current: new Set() }, activeOrg: { current: 'org-1' }, PERSONAL: '__personal__', loadPersonal: async () => {},
    supabase: { from: () => chain }, q: async () => { fetched.push(1); if (fail) throw new Error('Failed to fetch'); return { id: 'room-9', kind: 'dm', org_id: 'org-1', archived_at: null }; },
    setChannels: (f) => { channels.splice(0, channels.length, ...f(channels)); }, setDmMembers: () => {} };
  const addRoom = new Function(...Object.keys(scope), body)(...Object.values(scope));
  await addRoom('room-9');
  const payload = { id: 2, channel_id: 'room-9', author_user_id: 'other' };
  assert.equal(unreadWorthy(payload, { uid: 'me', asked: scope.roomAsked.current }), true, '조회 실패 — 다음 글도 센다');
  fail = false; await addRoom('room-9');
  assert.equal(fetched.length >= 2, true, '다음 글이 다시 묻는다');
  assert.deepEqual(channels.map((c) => c.id), ['room-9'], '두 번째에 목록에 들어온다');
});
