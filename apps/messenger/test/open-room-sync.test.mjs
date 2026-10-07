// 열린 방 따라잡기(2026-10-07 운영 데스크톱 0.1.51 실측) — 목록에는 답이 왔다는 안 읽음 배지(1)가 떴는데 열린 대화방은 '전달됨 · 준비 중'이 27초 넘게 남았다.
// 조직 비공개 방(에이전트 1:1·DM·비공개 채널)의 글 방송은 u:<나>로만 오는데(서버 msgr_room_send), u:가 다시 붙을 때는 목록만 다시 읽고 열린 방은 따라잡지 않았다.
// 고친 길 두 가지: (1) u:가 다시 붙을 때(끊김 뒤·다시 건 구독) 열린 조직 비공개 방 따라잡기, (2) 안 읽음 재집계가 열린 방에 모르는 글이 있다고 할 때 따라잡기.
// (재연결 한 번에 목록 다시 읽기 한 번은 realtime-link.test.mjs, u: 다시 붙음 신호 배선은 realtime-wiring.test.mjs)
// App.jsx의 실제 효과 본문·JSX 식을 꺼내 가짜 DB로 돌린다(realtime-wiring.test.mjs와 같은 방식) — 배선을 지우거나 조건을 되돌리면 결과가 달라진다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import { openRoomBehind } from '../src/read-sync.mjs';
import { readMissed, refreshMessageWindow, mergeRefreshedMessages, createCatchUp } from '../src/refresh-messages.mjs';
import { awaitingReplies } from '../src/await-reply.mjs';

const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8').replaceAll('import.meta.env.DEV', 'false');
const between = (from, to) => { const s = app.indexOf(from); assert.ok(s >= 0, `찾지 못함: ${from}`); const e = app.indexOf(to, s); assert.ok(e > s, `끝을 찾지 못함: ${to}`); return app.slice(s, e); };
const build = (src, scope) => new Function(...Object.keys(scope), `return (${src});`)(...Object.values(scope));
const tick = () => new Promise((r) => setTimeout(r, 0));

// ── 열린 방이 서버보다 뒤처졌나(read-sync.mjs openRoomBehind)

const mine = (id) => ({ id, author_kind: 'user', author_user_id: 'me', crew_id: null, kind: 'text', body: '', mentions: [], reply_to: null, created_at: new Date(1_000_000 + id).toISOString(), deleted_at: null });
const crew = (id, crewId = 'c1') => ({ id, author_kind: 'crew', author_user_id: null, crew_id: crewId, kind: 'text', body: '', mentions: [], reply_to: null, created_at: new Date(1_000_000 + id).toISOString(), deleted_at: null });

test('openRoomBehind — 서버 안 읽음이 이 화면이 가진 "읽은 위치 뒤 남의 글"보다 많을 때만', () => {
  assert.equal(openRoomBehind({ n: 1, msgs: [mine(1)], uid: 'me', readUpTo: 1 }), true, '놓친 답 하나');
  assert.equal(openRoomBehind({ n: 1, msgs: [mine(1), crew(2)], uid: 'me', readUpTo: 1 }), false, '방송으로 이미 받은 답(초점 없어 읽음 전)');
  assert.equal(openRoomBehind({ n: 0, msgs: [mine(1)], uid: 'me', readUpTo: 1 }), false, '안 읽음 없음');
  assert.equal(openRoomBehind({ n: 3, msgs: null, uid: 'me' }), false, '첫 목록을 읽는 중 — 그 조회가 다 가져온다');
  assert.equal(openRoomBehind({ n: 3, msgs: [crew(1), crew(2), crew(3)], uid: 'me', readUpTo: 0 }), false, '연 뒤 읽지 않은 남의 글 셋 = 서버 셋');
});

test('openRoomBehind — 연 뒤 읽음으로 올린 위치를 기준으로 센다(연 때 커서만 쓰면 읽은 글이 놓친 글을 가린다)', () => {
  const msgs = [crew(1), crew(2), crew(3), mine(4)]; // 연 때 커서 0, 이 화면이 4까지 읽음으로 올렸다, 답 5는 방송을 놓쳤다 → 서버 n=1
  assert.equal(openRoomBehind({ n: 1, msgs, uid: 'me', readUpTo: 4 }), true);
  assert.equal(openRoomBehind({ n: 1, msgs, uid: 'me', readUpTo: 0 }), false, '대조: 연 때 커서(0)만 쓰면 찾지 못한다');
});

test('openRoomBehind — 서버 셈(msgr_unread)과 같은 규칙: 내 글·지운 글은 빼고 99에서 멈춘다', () => {
  assert.equal(openRoomBehind({ n: 1, msgs: [mine(1), { ...crew(2), deleted_at: '2026-10-07T00:00:00Z' }], uid: 'me', readUpTo: 1 }), true, '지운 글은 안 읽음이 아니다');
  assert.equal(openRoomBehind({ n: 1, msgs: [mine(1), mine(2)], uid: 'me', readUpTo: 0 }), true, '다른 기기에서 쓴 내 글은 셈에 없다');
  const many = Array.from({ length: 150 }, (_, i) => crew(i + 1));
  assert.equal(openRoomBehind({ n: 99, msgs: many, uid: 'me', readUpTo: 0 }), false, '서버는 99에서 멈춘다');
});

// 검수 반영(2026-10-08): 서버 셈은 차단한 사람의 글과 숨긴(차단한) 크루의 글을 뺀다(20260927120000 msgr_unread의 msgr_user_blocks 두 조건). 화면이 그 글을 세면
// "서버 1 = 화면 1"로 보여 놓친 답을 찾지 못했다.
const person = (id, who) => ({ ...mine(id), author_user_id: who });
test('openRoomBehind — 차단한 사람·숨긴 크루의 글은 서버처럼 빼고 센다(같이 세면 놓친 답을 못 찾는다)', () => {
  const msgs = [mine(1), person(2, 'blocked-u'), crew(3, 'muted-c')]; // 둘 다 서버 셈에는 없다. 놓친 크루 답 4 → 서버 n=1
  const opts = { n: 1, msgs, uid: 'me', readUpTo: 1 };
  assert.equal(openRoomBehind({ ...opts, blocked: new Set(['blocked-u']), mutedCrews: new Set(['muted-c']) }), true);
  assert.equal(openRoomBehind({ ...opts, blocked: new Set(['blocked-u']) }), false, '대조: 숨긴 크루 글을 세면 2 ≥ 1');
  assert.equal(openRoomBehind({ ...opts, n: 2, blocked: new Set(['other']), mutedCrews: new Set(['other-c']) }), false, '차단 목록에 없는 사람·크루 글은 센다');
  assert.equal(openRoomBehind({ n: 1, msgs: [mine(1), { ...crew(2), author_user_id: 'blocked-u' }], uid: 'me', readUpTo: 1, blocked: new Set(['blocked-u']) }), false, '크루 글은 사람 차단으로 빼지 않는다(서버: author_kind별 조건)');
});

// ── 대화 화면 배선 — App.jsx Channel의 실제 load·catchUp 본문 + 새 효과 본문, 가짜 DB

const loadSrc = between('const load = useCallback(async (afterId = 0, preserve = false) => {', ', [chId, hydrate]);').slice('const load = useCallback('.length);
const catchUpSrc = between('const catchUp = useMemo(() => ', ', [load]);').slice('const catchUp = useMemo(() => '.length);
function channelShell({ server, have }) {
  const live = { current: { msgs: have } }; const asked = [];
  const from = (table) => { const st = { table, f: [], order: 'asc', limit: null }; const b = { st, select: () => b, eq: () => b, gt: (k, v) => { st.f.push(['gt', v]); return b; }, lte: (k, v) => { st.f.push(['lte', v]); return b; }, order: (k, o) => { st.order = o.ascending ? 'asc' : 'desc'; return b; }, limit: (n) => { st.limit = n; return b; }, maybeSingle: () => b }; return b; };
  const q = async (b) => {
    const { st } = b; asked.push(st.table); if (st.table === 'msgr_reads') return { last_read_id: 0 };
    let r = server.filter((m) => st.f.every(([op, v]) => (op === 'gt' ? m.id > Number(v) : m.id <= Number(v))));
    r = st.order === 'desc' ? [...r].reverse() : r;
    return st.limit ? r.slice(0, st.limit) : r;
  };
  const scope = { supabase: { from }, q, chId: 'ch', PAGE: 100, CATCHUP_PAGES: 5, readMissed, uid: 'me', setDivider: () => {}, setHasMore: () => {}, setPending: () => {}, reconcilePending: (c) => c,
    stick: { current: false }, noteRef: { current: () => {} }, hydrate: async () => {}, live, refreshMessageWindow, failedCrewsInFetch: () => [], failRef: { current: null }, mergeRefreshedMessages,
    setMsgs: (f) => { live.current = { msgs: typeof f === 'function' ? f(live.current.msgs) : f }; } };
  const load = build(loadSrc, scope);
  const catchUp = build(catchUpSrc, { createCatchUp, load, live });
  return { live, asked, catchUp, ids: () => live.current.msgs.map((m) => m.id) };
}
// 보낸 뒤 대기 표시 — 열린 1:1 방(에이전트 c1)의 '준비 중'이 남아 있나(await-reply.mjs, 화면이 쓰는 판정 그대로)
const waiting = (msgs) => awaitingReplies({ msgs, uid: 'me', isDm: true, roomCrewIds: ['c1'], now: 1_000_000 + 2000 }).map((x) => x.phase);

// u:가 다시 붙은 회차(uRejoin) — 셸이 u: 구독의 'up'마다 올린다(realtime-wiring.test.mjs). 대화 화면은 글 방송이 u:로만 오는 방에서만 따라잡는다.
const uEffectSrc = between('useEffect(() => { if (uRejoinSeen.current === uRejoin) return;', ', [uRejoin]);').slice('useEffect('.length);
const uShell = ({ kind = 'dm', isPersonal = false } = {}) => {
  const s = channelShell({ server: [mine(1), crew(2)], have: [mine(1)] });
  const seen = { current: 0 }; let approvals = 0;
  const run = (uRejoin) => build(uEffectSrc, { uRejoin, uRejoinSeen: seen, isPersonal, channel: { id: 'ch', kind }, catchUp: s.catchUp, loadApprovals: async () => { approvals++; } })();
  return { ...s, run, approvals: () => approvals };
};
test('경우 1 — 조직 에이전트 1:1(비공개)에서 재연결 중 u: 방송을 놓친 답: u:가 다시 붙으면 한 번 따라잡아 "준비 중"이 사라진다', async () => {
  for (const kind of ['dm', 'private']) {
    const s = uShell({ kind });
    assert.deepEqual(waiting(s.live.current.msgs), ['preparing'], '고치기 전 화면: 배지는 1인데 방은 준비 중');
    s.run(0); await tick();
    assert.deepEqual([s.asked.length, s.approvals()], [0, 0], `${kind}: 방을 연 순간(마운트)은 따라잡지 않는다 — 첫 목록 조회가 한다`);
    s.run(1); await tick(); await tick();
    assert.deepEqual(s.ids(), [1, 2], kind);
    assert.deepEqual(waiting(s.live.current.msgs), [], `${kind}: 답이 보이고 대기 표시가 사라진다`);
    assert.deepEqual([s.asked.length, s.approvals()], [1, 1], `${kind}: 글 조회 1 + 결재 1(결재 방송도 u:로 온다)`);
    s.run(1); await tick();
    assert.deepEqual([s.asked.length, s.approvals()], [1, 1], `${kind}: 같은 회차로는 다시 안 읽는다`);
  }
});

test('경우 17 — 조직 공개 채널·개인 방은 u: 다시 붙음에 따라잡지 않는다(공개는 org:, 개인은 dm:이 다시 붙을 때 rt_up이 이미 한다 — 같은 재연결에 두 번 읽던 것)', async () => {
  for (const o of [{ kind: 'public' }, { kind: 'dm', isPersonal: true }, { kind: 'private', isPersonal: true }]) {
    const s = uShell(o);
    s.run(0); s.run(1); s.run(2); await tick(); await tick();
    assert.deepEqual([s.asked.length, s.approvals()], [0, 0], JSON.stringify(o));
  }
});

const unreadEffectSrc = between('useEffect(() => { if (openRoomBehind(', ', [serverUnread]);').slice('useEffect('.length);
const runUnread = (s, { n, divider = 0, readMark = 0, blocked = new Set(), mutedCrewIds = new Set() }) => build(unreadEffectSrc, { openRoomBehind, serverUnread: n, msgs: s.live.current.msgs, uid: 'me', divider, readMark: { current: readMark }, safety: { blocked, mutedCrewIds }, catchUp: s.catchUp })();
test('경우 2 — 재연결 없이 안 읽음 재집계가 열린 방에 모르는 글이 있다고 하면(서버 1 > 화면 0) 한 번 따라잡는다', async () => {
  const s = channelShell({ server: [mine(1), crew(2)], have: [mine(1)] });
  runUnread(s, { n: 1, readMark: 1 }); await tick(); await tick();
  assert.deepEqual([s.ids(), waiting(s.live.current.msgs)], [[1, 2], []]);
});

test('경우 3 — 방송으로 이미 받은 답(초점 없어 읽음 전): 서버 1 = 화면 1이면 요청 0', async () => {
  const s = channelShell({ server: [mine(1), crew(2)], have: [mine(1), crew(2)] });
  runUnread(s, { n: 1, readMark: 1 }); await tick();
  assert.equal(s.asked.length, 0);
});

test('경우 4·6 — 읽음 저장 뒤(서버 0)는 요청 0, 연 뒤 읽은 글이 있어도 놓친 답은 찾는다(divider만 쓰지 않는다)', async () => {
  const s0 = channelShell({ server: [mine(1), crew(2)], have: [mine(1), crew(2)] });
  runUnread(s0, { n: 0, readMark: 2 }); await tick();
  assert.equal(s0.asked.length, 0);
  const s = channelShell({ server: [crew(1), crew(2), crew(3), mine(4), crew(5)], have: [crew(1), crew(2), crew(3), mine(4)] });
  runUnread(s, { n: 1, divider: 0, readMark: 4 }); await tick(); await tick();
  assert.deepEqual(s.ids(), [1, 2, 3, 4, 5]);
});

// 읽은 위치 기록 — 화면이 읽음으로 올릴 때(onRead) 그 위치를 기억해야 연 뒤 읽은 글이 놓친 글을 가리지 않는다(경우 6). 셸로 넘기는 것은 그대로.
test('onRead 배선 — 읽음으로 올린 위치를 readMark에 남기고 셸(markRead)에는 그대로 넘긴다, 뒤로 가지 않는다', () => {
  const m = app.match(/const onRead = (\(ch, id\) => \{.*?\});/);
  assert.ok(m, 'onRead를 찾지 못함');
  const readMark = { current: 0 }; const out = [];
  const onRead = build(m[1], { readMark, onReadOut: (ch, id) => out.push([ch, id]) });
  onRead('ch', 4); onRead('ch', 2);
  assert.deepEqual([readMark.current, out], [4, [['ch', 4], ['ch', 2]]]);
});

test('경우 7 — 대화 화면이 차단 목록(SafetyCtx)을 넘긴다: 차단한 사람의 안 읽은 글이 있어도 놓친 답을 따라잡는다', async () => {
  const s = channelShell({ server: [mine(1), person(2, 'blocked-u'), crew(3)], have: [mine(1), person(2, 'blocked-u')] });
  runUnread(s, { n: 1, readMark: 1, blocked: new Set(['blocked-u']) }); await tick(); await tick();
  assert.deepEqual(s.ids(), [1, 2, 3]);
});

// 검수 반영(2026-10-08): 셸 → 대화 화면 JSX 배선(u: 회차·열린 방 안 읽음)을 끊어도 모든 테스트가 통과했다. 실제 <Channel …/> 식을 esbuild로 컴파일해
// 셸 상태를 넣고 돌린다 — 대화 화면이 받는 값이 셸의 값과 같아야 한다(열린 방 = chId의 안 읽음만).
const channelLine = app.split('\n').map((l) => l.trim()).find((l) => l.startsWith('<Channel key={chId}'));
test('경우 16 — 셸 → 대화 화면 배선: u: 회차와 열린 방(chId)의 서버 안 읽음을 그대로 넘긴다, 다른 방의 배지는 넘기지 않는다', () => {
  assert.ok(channelLine?.endsWith('/>'), '<Channel key={chId} … /> 한 줄을 찾지 못함');
  const code = transformSync(`(${channelLine})`, { loader: 'jsx', jsxFactory: '__h', jsxFragment: '__F' }).code.trim().replace(/;$/, '');
  const run = new Function('__s', `with (__s) { return ${code}; }`);
  const globals = new Set(['undefined', 'Math', 'JSON', 'Date', 'Object', 'Array', 'Number', 'String', 'Boolean', 'Set', 'Map', 'Promise']);
  const shell = (vals) => run(new Proxy({}, { has: (_, k) => typeof k === 'string' && !globals.has(k), get: (_, k) => (k === Symbol.unscopables ? undefined : k in vals ? vals[k] : () => undefined) }));
  const Channel = () => null;
  const base = { __h: (type, props) => ({ type, props }), Channel, chId: 'ch-1', channel: { id: 'ch-1', kind: 'dm' }, isPersonal: false, muted: new Set() };
  const el = shell({ ...base, uRejoin: 7, unread: { 'ch-1': { n: 3, mention: 0 }, 'ch-2': { n: 5, mention: 0 } } });
  assert.equal(el.type, Channel);
  assert.deepEqual([el.props.uRejoin, el.props.serverUnread], [7, 3]);
  assert.equal(shell({ ...base, uRejoin: 0, unread: { 'ch-2': { n: 5, mention: 0 } } }).props.serverUnread, 0, '열린 방이 아닌 방의 배지');
});
