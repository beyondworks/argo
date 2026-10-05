// 분리 검수(2026-10-05) 테스트 보강: App.jsx의 구독 배선(다시 거는 구독의 expect, 방 토픽의 roomSignal, u:의 onStatus)과 따라잡기의
// '최신으로 옮기기' 분기가 소스 글자 대조뿐이었다. 여기서는 App.jsx의 실제 효과 본문·load 본문을 꺼내 가짜 Supabase로 돌린다
// (send-feedback-wiring.test.mjs와 같은 방식) — 배선을 지우거나 바꾸면 결과가 달라진다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createLinkWatch, roomSignal } from '../src/realtime-link.mjs';
import { joinWithBackoff } from '../src/cross-space.mjs';
import { createRealtimeScope } from '../src/realtime-scope.mjs';
import { readMissed, refreshMessageWindow, mergeRefreshedMessages, createCatchUp } from '../src/refresh-messages.mjs';

const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8').replaceAll('import.meta.env.DEV', 'false');
const between = (from, to) => { const s = app.indexOf(from); assert.ok(s >= 0, `찾지 못함: ${from}`); const e = app.indexOf(to, s); assert.ok(e > s, `끝을 찾지 못함: ${to}`); return app.slice(s, e); };
const tick = () => new Promise((r) => setTimeout(r, 0));
const build = (src, scope) => new Function(...Object.keys(scope), `return (${src});`)(...Object.values(scope));

// 가짜 Realtime — 채널 이름 → 만든 채널들(구독 콜백을 테스트가 부른다)
function fakeSupabase() {
  const made = [];
  const channel = (name) => { const c = { name, state: 'joining', on() { return c; }, subscribe(cb) { c.cb = cb; return c; }, send: async () => 'ok' }; made.push(c); return c; };
  return { made, last: (name) => made.filter((c) => c.name === name).at(-1),
    sb: { realtime: { setAuth: async () => {}, isConnected: () => true }, channel, removeChannel: async (c) => { c.state = 'closed'; return 'ok'; }, removeAllChannels: async () => {}, getChannels: () => made.filter((c) => c.state !== 'closed') } };
}

// ── 조직·u: 구독 효과(useEffect(() => { if (!uid || !hasToken || !orgs) … }, [orgSubKey, hasToken]))
const orgEffectSrc = between('useEffect(() => {\n    if (!uid || !hasToken || !orgs) return undefined;', ', [orgSubKey, hasToken]);').slice('useEffect('.length);
function orgShell({ orgs, active }) {
  const rt = fakeSupabase(); const events = []; let syncs = 0;
  const watch = createLinkWatch({ onSync: () => { syncs++; }, timer: (fn) => setTimeout(fn, 0), clear: clearTimeout });
  const scope = { uid: 'u1', hasToken: true, orgs, linkWatch: () => watch, linkRef: { current: { subUid: null } }, realtimeScope: createRealtimeScope(), supabase: rt.sb,
    activeOrg: { current: active }, PERSONAL: '__personal__', setEvent: (e) => events.push(e.kind), broadcastEvent: (kind, p) => ({ kind, ...p }), subsRef: { current: new Map() }, rt: { current: null },
    setRoomReset: () => {}, handleMessageRef: { current: () => {} }, crossRef: { current: () => {} }, approvalsSoon: { current: () => {} }, notifyApproval: () => {}, inboxSoon: { current: () => {} },
    spaceChanged: { current: () => {} }, activeChannel: { current: null }, bumpMembers: () => {}, onTypingEvent: () => {}, onProgressEvent: () => {}, bumpFriends: () => {}, joinWithBackoff, uRetryRef: { current: null } };
  const effect = build(orgEffectSrc, scope);
  return { rt, events, scope, syncs: () => syncs, run: async () => { const off = effect(); await tick(); return off; } };
}

test('조직이 없는 사용자 — u:가 끊겼다 붙으면 목록을 한 번 다시 읽는다(onStatus 배선), 열린 방 신호(rt_down·rt_up)는 내지 않는다', async () => {
  const s = orgShell({ orgs: [], active: '__personal__' });
  await s.run();
  const u = s.rt.last('u:u1'); assert.ok(u, 'u: 구독');
  u.cb('SUBSCRIBED'); u.cb('CHANNEL_ERROR', new Error('heartbeat timeout')); u.cb('SUBSCRIBED'); await tick();
  assert.equal(s.syncs(), 1, '다시 붙음 → 목록 다시 읽기');
  assert.deepEqual(s.events, [], 'u:는 열린 방 신호를 내지 않는다(announce=false)');
  assert.equal(typeof s.scope.uRetryRef.current, 'function', '토큰 갱신 때 깨울 재시도(검수 M2)');
});

test('조직 구독 — 보는 공간이 끊기면 rt_down, 다시 붙으면 rt_up + 목록 다시 읽기 / 다시 건 구독(복귀)은 첫 SUBSCRIBED에서 한 번 따라잡는다(expect)', async () => {
  const s = orgShell({ orgs: [{ id: 'o1' }, { id: 'o2' }], active: 'o1' });
  const off = await s.run();
  for (const c of s.rt.made) c.cb('SUBSCRIBED');
  assert.deepEqual(s.events, [], '처음 구독은 신호 없음(화면이 열 때 읽는다)');
  s.rt.last('org:o1').cb('TIMED_OUT'); s.rt.last('org:o2').cb('TIMED_OUT');
  s.rt.last('org:o1').cb('SUBSCRIBED'); s.rt.last('org:o2').cb('SUBSCRIBED'); await tick();
  assert.deepEqual(s.events, ['rt_down', 'rt_up'], '보는 공간(o1)만 화면에 알린다');
  assert.equal(s.syncs(), 1, '두 조직이 함께 다시 붙어도 목록 다시 읽기는 한 번(묶기 창)');
  off(); s.events.length = 0;
  await s.run(); // 복귀(resumeEpoch)로 다시 건다 — linkRef.subUid가 같은 계정
  s.rt.last('org:o1').cb('SUBSCRIBED'); s.rt.last('org:o2').cb('SUBSCRIBED'); s.rt.last('u:u1').cb('SUBSCRIBED');
  assert.deepEqual(s.events, ['rt_up'], '다시 건 보는 공간 구독의 첫 SUBSCRIBED = 거는 사이 놓친 글 따라잡기(MSG-01)');
});

// ── 방 토픽(dm:<방>) 구독 효과
const roomEffectSrc = between('useEffect(() => {\n    let live = true; // 정리가 setAuth보다 먼저 끝나면', ', [roomIdsKey, isPersonal, resumeEpoch, roomReset]);').slice('useEffect('.length);
function roomShell({ open, rooms }) {
  const rt = fakeSupabase(); const events = [];
  const watch = createLinkWatch({ timer: (fn) => setTimeout(fn, 0), clear: clearTimeout });
  const base = { supabase: rt.sb, roomSubs: { current: new Map() }, linkWatch: () => watch, roomEpoch: { current: null }, roomSpaces: { current: new Map() }, activeOrg: { current: '__personal__' },
    loadedOrg: { current: '__personal__' }, roomIdsKey: rooms.join(','), handleMessageRef: { current: () => {} }, crossRef: { current: () => {} }, PERSONAL: '__personal__', onTypingEvent: () => {},
    onProgressEvent: () => {}, setEvent: (e) => events.push(e.kind), broadcastEvent: (kind, p) => ({ kind, ...p }), activeChannel: { current: open }, roomSignal };
  return { rt, events, run: async (resumeEpoch) => { build(roomEffectSrc, { ...base, resumeEpoch })(); await tick(); } };
}

test('개인 공간 방 토픽 — 열린 방만 끊김·다시 붙음을 알리고(roomSignal), 복귀로 다시 건 열린 방은 첫 SUBSCRIBED에서 따라잡는다, 떼어 낸 옛 구독의 CLOSED는 무시', async () => {
  const s = roomShell({ open: 'r1', rooms: ['r1', 'r2'] });
  await s.run(0);
  for (const c of s.rt.made) c.cb('SUBSCRIBED');
  s.rt.last('dm:r2').cb('CHANNEL_ERROR'); s.rt.last('dm:r2').cb('SUBSCRIBED');
  assert.deepEqual(s.events, [], '열려 있지 않은 방은 알리지 않는다');
  s.rt.last('dm:r1').cb('CHANNEL_ERROR'); s.rt.last('dm:r1').cb('SUBSCRIBED');
  assert.deepEqual(s.events, ['rt_down', 'rt_up'], '열린 개인 방의 짝(MSG-03)');
  s.events.length = 0; const oldR1 = s.rt.last('dm:r1');
  await s.run(1); // 폰 복귀
  oldR1.cb('CLOSED');
  assert.deepEqual(s.events, [], '떼어 낸 옛 구독의 늦은 CLOSED는 새 구독과 섞이지 않는다');
  s.rt.last('dm:r1').cb('SUBSCRIBED'); s.rt.last('dm:r2').cb('SUBSCRIBED');
  assert.deepEqual(s.events, ['rt_up'], '다시 건 열린 방의 첫 SUBSCRIBED만(expect)');
});

// ── 대화 화면의 따라잡기(load 본문 + catchUp)
const loadSrc = between('const load = useCallback(async (afterId = 0, preserve = false) => {', ', [chId, hydrate]);').slice('const load = useCallback('.length);
const catchUpSrc = between('const catchUp = useMemo(() => ', ', [load]);').slice('const catchUp = useMemo(() => '.length);
function fakeDb(server) {
  const from = (table) => { const st = { table, f: [], order: 'asc', limit: null }; const b = { st, select: () => b, eq: () => b, gt: (k, v) => { st.f.push(['gt', v]); return b; }, lte: (k, v) => { st.f.push(['lte', v]); return b; }, order: (k, o) => { st.order = o.ascending ? 'asc' : 'desc'; return b; }, limit: (n) => { st.limit = n; return b; }, maybeSingle: () => b }; return b; };
  const q = async (b) => {
    const { st } = b; if (st.table === 'msgr_reads') return { last_read_id: 0 };
    let r = server.filter((m) => st.f.every(([op, v]) => (op === 'gt' ? m.id > Number(v) : m.id <= Number(v))));
    r = st.order === 'desc' ? [...r].reverse() : r;
    return st.limit ? r.slice(0, st.limit) : r;
  };
  return { supabase: { from }, q };
}
function channelShell({ server, have }) {
  const notes = []; const live = { current: { msgs: have } }; let hasMore = null;
  const { supabase, q } = fakeDb(server);
  const scope = { supabase, q, chId: 'ch', PAGE: 100, CATCHUP_PAGES: 5, readMissed, uid: 'me', setDivider: () => {}, setHasMore: (v) => { hasMore = v; }, setPending: () => {}, reconcilePending: (c) => c,
    stick: { current: false }, noteRef: { current: (k) => notes.push(k) }, hydrate: async () => {}, live, refreshMessageWindow, failedCrewsInFetch: () => [], failRef: { current: null }, mergeRefreshedMessages,
    setMsgs: (f) => { live.current = { msgs: typeof f === 'function' ? f(live.current.msgs) : f }; } };
  const load = build(loadSrc, scope);
  const catchUp = build(catchUpSrc, { createCatchUp, load, live });
  return { notes, live, hasMore: () => hasMore, catchUp };
}
const msgsTo = (n, from = 1) => Array.from({ length: n - from + 1 }, (_, i) => ({ id: from + i, author_kind: 'user', body: '' }));

test('따라잡기 — 상한(500개)을 넘게 밀렸으면 최신 100개로 옮기고 안내는 한 번, 방송이 겹쳐 와도 한 번(검수 L3)', async () => {
  const s = channelShell({ server: msgsTo(800), have: msgsTo(100) });
  await Promise.all([s.catchUp(), s.catchUp(), s.catchUp()]); // 글 방송 세 건이 겹쳐 왔다
  const ids = s.live.current.msgs.map((m) => m.id);
  assert.deepEqual([ids[0], ids.at(-1), ids.length, s.hasMore()], [701, 800, 100, true], '최신 쪽 + 이전 기록 불러오기 켜짐');
  assert.deepEqual(s.notes, ['thread.jumped'], '안내는 한 번');
});

test('따라잡기 — 정확히 500개 밀렸으면 다 붙이고 옮기지 않는다(검수 L3), 덜 밀렸으면 이어 붙인다', async () => {
  const s = channelShell({ server: msgsTo(600), have: msgsTo(100) });
  await s.catchUp();
  assert.deepEqual([s.live.current.msgs.length, s.live.current.msgs.at(-1).id, s.notes.length], [600, 600, 0]);
});

// 분리 검수 M2(2026-10-05): 토큰이 갱신되면(TOKEN_REFRESHED → session.access_token) 거절 대기 중인 u:를 바로 다시 붙인다.
test('토큰 갱신 효과 — session.access_token이 바뀌면 u: 재시도를 부른다', async () => {
  const m = app.match(/useEffect\(\(\) => \{ uRetryRef\.current\?\.\(\); \}, \[([^\]]*)\]\);/);
  assert.ok(m, 'u: 재시도 효과가 없다');
  assert.deepEqual(m[1].split(',').map((x) => x.trim()), ['session.access_token'], '토큰이 바뀔 때만');
  // 조직 효과가 넘긴 재시도가 거절 대기 중인 u:를 깨운다 — 실제 효과 본문 + 실제 joinWithBackoff
  const s = orgShell({ orgs: [], active: '__personal__' });
  await s.run();
  const before = s.rt.made.length;
  s.rt.last('u:u1').cb('CHANNEL_ERROR', new Error('expired', { cause: { reason: 'InvalidJWTToken: Token has expired' } }));
  s.scope.uRetryRef.current();
  assert.equal(s.rt.made.length, before + 1, '바로 다시 붙는다(60초를 기다리지 않는다)');
});
