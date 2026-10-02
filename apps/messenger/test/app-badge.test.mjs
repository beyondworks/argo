// 폰 앱 아이콘 숫자(유건 제보 2026-10-01: 다 읽어도 아이콘 '1'이 남음). iOS는 앱이 앞에 있을 때 받은 푸시의 배지를 적용하지 않으므로
// (시뮬레이터 실측) 앱이 쓰는 숫자가 곧 아이콘이다 — 그 숫자는 서버 배지(msgr_my_badge)여야 하고, Android는 읽은 채널의 트레이 알림을 지운다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createIconBadge, badgeFromRows, trayTagOf, unreadSignature } from '../src/app-badge.mjs';
import { badgeTotal } from '../src/cross-space.mjs';

const fakeTimers = () => { const q = new Map(); let id = 0; return { setTimeout: (fn) => { q.set(++id, fn); return id; }, clearTimeout: (i) => q.delete(i), flush: () => { const fns = [...q.values()]; q.clear(); fns.forEach((f) => f()); }, size: () => q.size }; };
const tick = () => new Promise((r) => setImmediate(r));

test('제보 재현: 앱 안 합계(공개 채널 잡담 1)와 달리 아이콘은 서버 배지 0 — 다 읽은 뒤 1이 남지 않는다', async () => {
  const icon = [];
  const appCount = badgeTotal({ current: { pub: { n: 1, mention: 0 } }, currentKey: 'org', totals: {} });
  assert.equal(appCount, 1, '예전 아이콘 숫자(모든 채널 합계)는 1이었다');
  const b = createIconBadge({ fetchRows: async () => [], setIcon: (n) => icon.push(n), fallback: () => appCount });
  await b.sync();
  assert.deepEqual(icon, [0], '서버 배지(DM·나를 향한 글)가 0이면 아이콘을 0으로 지운다');
});

test('첫 동기화는 값이 0이어도 반드시 쓴다(실행 전부터 남아 있던 아이콘 숫자를 지운다), 같은 값은 다시 쓰지 않는다', async () => {
  const icon = []; let rows = [];
  const b = createIconBadge({ fetchRows: async () => rows, setIcon: (n) => icon.push(n) });
  await b.sync(); await b.sync();
  assert.deepEqual(icon, [0]);
  rows = [{ channel_id: 'dm1', n: 2 }, { channel_id: 'pub', n: 1 }];
  await b.sync(); await b.sync();
  rows = [{ channel_id: 'pub', n: 1 }];
  await b.sync();
  assert.deepEqual(icon, [0, 3, 1]);
  assert.equal(b.shown, 1);
});

test('동시에 여러 번 불러도 서버 호출은 겹치지 않고, 진행 중에 온 요청은 끝난 뒤 한 번만 더 부른다', async () => {
  let calls = 0; let release; const icon = [];
  const b = createIconBadge({ fetchRows: () => { calls++; return new Promise((r) => { release = () => r([{ channel_id: 'dm', n: calls }]); }); }, setIcon: (n) => icon.push(n) });
  const p = b.sync(); b.sync(); b.sync();
  assert.equal(calls, 1);
  release(); await tick(); await tick();
  assert.equal(calls, 2, '진행 중 요청 여러 개 → 뒤에 한 번');
  release(); await p;
  assert.deepEqual(icon, [1, 2], '두 번째 호출이 그 사이 바뀐 값을 반영한다');
  assert.equal(calls, 2);
});

test('request는 잇따른 변화를 모아 한 번 부른다(디바운스)', async () => {
  let calls = 0; const timers = fakeTimers();
  const b = createIconBadge({ fetchRows: async () => { calls++; return []; }, setIcon: () => {}, timers });
  b.request(); b.request(); b.request(); b.resume();
  assert.equal(timers.size(), 1);
  timers.flush(); await tick();
  assert.equal(calls, 1);
  b.stop(); b.request(); assert.equal(timers.size(), 0, '멈춘 뒤에는 예약하지 않는다');
});

test('서버 함수가 없으면(라이브 적용 전) 예전 숫자로 — 회귀 없음, 그 경우 트레이는 건드리지 않는다', async () => {
  const icon = []; const tray = [];
  const b = createIconBadge({ fetchRows: async () => { throw new Error('PGRST202'); }, setIcon: (n) => icon.push(n), clearTray: (x) => tray.push(x), fallback: () => 4 });
  await b.sync();
  assert.deepEqual(icon, [4]); assert.deepEqual(tray, []);
  const c = createIconBadge({ fetchRows: async () => { throw new Error('offline'); }, setIcon: (n) => icon.push(n) });
  await c.sync();
  assert.deepEqual(icon, [4], '예전 숫자도 없으면 아이콘을 건드리지 않는다');
});

test('Android: 아직 안 읽은 채널의 알림만 남기고 나머지 메시지 알림을 지운다 — 같은 목록이면 다시 부르지 않고, 앞으로 올 때는 다시 훑는다', async () => {
  const tray = []; let rows = [{ channel_id: 'a', n: 1 }, { channel_id: 'b', n: 2 }]; const timers = fakeTimers();
  const b = createIconBadge({ fetchRows: async () => rows, setIcon: () => {}, clearTray: ({ keep }) => tray.push(keep.slice().sort()), timers });
  await b.sync();
  assert.deepEqual(tray, [['ch-a', 'ch-b']]);
  rows = [{ channel_id: 'b', n: 2 }, { channel_id: 'a', n: 1 }];
  await b.sync();
  assert.equal(tray.length, 1, '순서만 바뀐 같은 목록은 다시 부르지 않는다');
  rows = [{ channel_id: 'b', n: 2 }];
  await b.sync();
  assert.deepEqual(tray.at(-1), ['ch-b'], 'a를 읽으면 a 알림을 지운다');
  b.resume(); timers.flush(); await tick();
  assert.equal(tray.length, 3, '앞으로 올 때는 같은 목록이어도 다시(뒤에 있는 동안 쌓인 알림)');
  rows = []; await b.sync();
  assert.deepEqual(tray.at(-1), [], '다 읽으면 메시지 알림 전부');
});

test('badgeFromRows — n이 0 이하·빈 행은 빼고, 태그는 엣지 알림 칸 모양(ch-<채널>)', () => {
  assert.deepEqual(badgeFromRows([{ channel_id: 'x', n: 3 }, { channel_id: 'y', n: 0 }, null, { n: 2 }]), { total: 3, tags: ['ch-x'] });
  assert.deepEqual(badgeFromRows(null), { total: 0, tags: [] });
  assert.equal(trayTagOf('c1'), 'ch-c1');
});

test('unreadSignature — 15초 재조회로 같은 값이 새 객체로 와도 같고, 값·음소거가 바뀌면 달라진다', () => {
  const a = unreadSignature({ unread: { c1: { n: 1, mention: 0 }, c2: { n: 0 } }, totals: { o: { n: 2, mention: 1 } } });
  assert.equal(unreadSignature({ unread: { c2: { n: 0 }, c1: { n: 1, mention: 0 } }, totals: { o: { n: 2, mention: 1 } } }), a);
  assert.notEqual(unreadSignature({ unread: { c1: { n: 0 } }, totals: { o: { n: 2, mention: 1 } } }), a);
  assert.notEqual(unreadSignature({ unread: { c1: { n: 1, mention: 0 } }, totals: { o: { n: 2, mention: 1 } }, muted: new Set(['c1']) }), a);
});

// 분리 검수 MEDIUM(2026-10-02): 트레이에 남길 목록을 배지 셈법(1:1·멘션·답글만)으로 정하면, 멘션 없는 채널 글 알림이 앱을 열기만 해도 지워졌다.
// 트레이 = 안 읽은 글이 있는 모든 채널(unread), 아이콘 숫자만 배지(n). 서버 msgr_my_badge가 두 값을 같이 준다(20261001150000).
test('Android: 멘션 없는 채널 글(배지 0, 안 읽음 있음) 알림은 남기고, 아이콘 숫자에는 넣지 않는다', async () => {
  const icon = []; const tray = [];
  let rows = [{ channel_id: 'dm', n: 1, unread: 1 }, { channel_id: 'pub', n: 0, unread: 3 }];
  const b = createIconBadge({ fetchRows: async () => rows, setIcon: (n) => icon.push(n), clearTray: ({ keep }) => tray.push(keep.slice().sort()) });
  await b.sync();
  assert.deepEqual(icon, [1], '아이콘 = 배지 숫자(채널 잡담 제외)');
  assert.deepEqual(tray, [['ch-dm', 'ch-pub']], '안 읽은 채널 잡담 알림은 남긴다');
  rows = [{ channel_id: 'pub', n: 0, unread: 3 }];
  await b.sync();
  assert.deepEqual(icon, [1, 0]); assert.deepEqual(tray.at(-1), ['ch-pub'], 'DM을 읽으면 DM 알림만 지운다');
  assert.deepEqual(badgeFromRows([{ channel_id: 'x', n: 2 }]), { total: 2, tags: ['ch-x'] }, 'unread가 없는 행은 배지 숫자로 판단(옛 모양)');
});
