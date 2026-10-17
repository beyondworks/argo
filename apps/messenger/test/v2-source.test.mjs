// 메신저 v2 어댑터(src/v2/source.mjs) — 옛 표 조회가 v2 표 조회로 바뀌어 나가고, 받은 행이 옛 모양으로 돌아오는지, 대응 표가 없는 조회는 요청 0인지.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createV2Client, toLegacyRow, toV2Row, v2Route, V2_UNSUPPORTED } from '../src/v2/source.mjs';

const SPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';
const AG = '33333333-3333-4333-8333-333333333333';

/** 호출을 기록하는 가짜 클라이언트. data[표] = 돌려줄 행. */
function fakeRaw(data = {}) {
  const log = [];
  const chain = (entry) => {
    const b = {};
    for (const op of ['select', 'insert', 'upsert', 'update', 'delete', 'eq', 'neq', 'in', 'is', 'gt', 'gte', 'lt', 'lte', 'contains', 'or', 'order', 'limit', 'range', 'maybeSingle', 'single']) {
      b[op] = (...args) => { entry.ops.push([op, ...args]); return b; };
    }
    b.then = (res, rej) => {
      const rows = data[entry.table] ?? [];
      const one = entry.ops.some(([op]) => op === 'maybeSingle' || op === 'single');
      return Promise.resolve({ data: one ? rows[0] ?? null : rows, error: null, status: 200 }).then(res, rej);
    };
    return b;
  };
  return {
    log,
    auth: { tag: 'auth', getSession: async () => ({ data: { session: { user: { id: 'o' } } } }) }, storage: { tag: 'storage' },
    from(table) { const entry = { kind: 'from', table, ops: [] }; log.push(entry); return chain(entry); },
    rpc(name, args) { log.push({ kind: 'rpc', name, args }); return Promise.resolve({ data: [{ ok: name }], error: null }); },
    channel(name) { return { name }; },
  };
}

test('글: channel_id·crew_id 조건과 열이 room_id·author_agent_id로 나가고, 행은 옛 모양(crew·멘션 객체·없는 열 null)으로 돌아온다', async () => {
  const raw = fakeRaw({ msgr2_messages: [{ id: 5, room_id: ROOM, author_kind: 'agent', author_user_id: null, author_agent_id: AG, kind: 'card', body: '결재', mentions: [AG], meta: {} }] });
  const c = createV2Client(raw);
  const r = await c.from('msgr_messages').select('id, author_kind, author_user_id, crew_id, kind, body, mentions, reply_to, thread_root, meta').eq('channel_id', ROOM).order('id', { ascending: false }).limit(50);
  const call = raw.log[0];
  assert.equal(call.table, 'msgr2_messages');
  assert.deepEqual(call.ops[0], ['select', 'id, author_kind, author_user_id, author_agent_id, kind, body, mentions, reply_to, meta', undefined], 'v2에 없는 thread_root는 묻지 않는다');
  assert.deepEqual(call.ops.slice(1), [['eq', 'room_id', ROOM], ['order', 'id', { ascending: false }], ['limit', 50]]);
  const m = r.data[0];
  assert.equal(m.author_kind, 'crew'); assert.equal(m.crew_id, AG); assert.equal(m.channel_id, ROOM); assert.equal(m.kind, 'approval_card');
  assert.deepEqual(m.mentions, [{ kind: 'crew', id: AG }]); assert.equal(m.thread_root, null); assert.equal(m._v2, true);
});

test('글: 옛 org_id 조건은 그 공간의 방 id 목록으로(방 조회 1회, 공간마다 기억), 방이 없으면 글 조회도 없다', async () => {
  const raw = fakeRaw({ msgr2_rooms: [{ id: ROOM }], msgr2_messages: [] });
  const c = createV2Client(raw);
  await c.from('msgr_messages').select('id').eq('org_id', SPACE).eq('author_user_id', 'u');
  await c.from('msgr_messages').select('id').eq('org_id', SPACE);
  assert.deepEqual(raw.log.map((e) => e.table), ['msgr2_rooms', 'msgr2_messages', 'msgr2_messages']);
  assert.deepEqual(raw.log[1].ops.slice(1), [['in', 'room_id', [ROOM]], ['eq', 'author_user_id', 'u']]);
  const empty = fakeRaw({ msgr2_rooms: [] }); const c2 = createV2Client(empty);
  const r = await c2.from('msgr_messages').select('id').eq('org_id', SPACE);
  assert.deepEqual(r.data, []); assert.deepEqual(empty.log.map((e) => e.table), ['msgr2_rooms']);
});

test('글: 사람 멘션 조건은 v2에 없어 요청 없이 빈 결과, 에이전트 멘션은 uuid 배열로', async () => {
  const raw = fakeRaw(); const c = createV2Client(raw);
  const r = await c.from('msgr_messages').select('id').contains('mentions', JSON.stringify([{ kind: 'user', id: 'u' }]));
  assert.deepEqual(r.data, []); assert.equal(raw.log.length, 0);
  await c.from('msgr_messages').select('id').contains('mentions', JSON.stringify([{ kind: 'crew', id: AG }]));
  assert.deepEqual(raw.log[0].ops[1], ['contains', 'mentions', [AG]]);
});

test('글: v2에 없는 열의 같음 조건은 맞는 행이 없다(요청 0), or 식의 열 이름도 바꾼다', async () => {
  const raw = fakeRaw(); const c = createV2Client(raw);
  const r = await c.from('msgr_messages').select('id').eq('thread_root', 3);
  assert.deepEqual(r.data, []); assert.equal(raw.log.length, 0);
  await c.from('msgr_messages').select('id').eq('channel_id', ROOM).or('author_user_id.is.null,crew_id.eq.x');
  assert.deepEqual(raw.log[0].ops.at(-1), ['or', 'author_user_id.is.null,author_agent_id.eq.x']);
});

test('방: org_id → space_id, 종류 dm·public ↔ direct·open(조건과 행 모두), 옛 열은 기본값', async () => {
  const raw = fakeRaw({ msgr2_rooms: [{ id: ROOM, space_id: SPACE, kind: 'direct', name: null, memory: true }, { id: 'r2', space_id: SPACE, kind: 'open', name: '일반', memory: false }] });
  const c = createV2Client(raw);
  const r = await c.from('msgr_channels').select('id, kind, name, topic, crew_memory, admin_user_ids, excluded_user_ids').eq('org_id', SPACE).eq('kind', 'dm').is('archived_at', null);
  assert.deepEqual(raw.log[0].ops.slice(1), [['eq', 'space_id', SPACE], ['eq', 'kind', 'direct'], ['is', 'archived_at', null]]);
  assert.deepEqual(r.data.map((x) => x.kind), ['dm', 'public']);
  assert.equal(r.data[0].crew_memory, true); assert.deepEqual(r.data[0].admin_user_ids, []); assert.equal(r.data[0].topic, null);
});

test('방 멤버: 빠진 멤버는 없는 것으로(removed_at is null), crew ↔ agent', async () => {
  const raw = fakeRaw({ msgr2_room_members: [{ room_id: ROOM, member_kind: 'agent', member_id: AG }] });
  const c = createV2Client(raw);
  const r = await c.from('msgr_channel_members').select('channel_id, member_kind, member_id').eq('member_kind', 'crew').in('channel_id', [ROOM]);
  assert.deepEqual(raw.log[0].ops.slice(1), [['is', 'removed_at', null], ['eq', 'member_kind', 'agent'], ['in', 'room_id', [ROOM]]]);
  assert.deepEqual(r.data, [{ channel_id: ROOM, member_kind: 'crew', member_id: AG }]);
});

test('내 참여 방(방 조건 없는 내 멤버십 조회)에는 읽을 수 있는 open 방을 더한다(v2 open 방은 참여 단계가 없다), 방 조건이 있으면 더하지 않는다', async () => {
  const raw = fakeRaw({ msgr2_room_members: [{ room_id: ROOM, member_kind: 'user', member_id: 'me' }], msgr2_rooms: [{ id: ROOM }, { id: 'open-1' }] });
  const c = createV2Client(raw);
  const r = await c.from('msgr_channel_members').select('channel_id').eq('member_kind', 'user').eq('member_id', 'me');
  assert.deepEqual(r.data.map((x) => x.channel_id), [ROOM, 'open-1']);
  assert.deepEqual(raw.log[1].ops, [['select', 'id'], ['eq', 'kind', 'open'], ['is', 'archived_at', null]]);
  const n = raw.log.length;
  await c.from('msgr_channel_members').select('channel_id, member_kind, member_id').in('channel_id', [ROOM]);
  assert.equal(raw.log.length, n + 1, '방 조건이 있는 조회는 open 방을 묻지 않는다');
});

test('에이전트: 조직 조건 = 그 팀 공간의 자리(allow 붙임), 파견 전(available) = 자리가 없는 내 에이전트, 자리도 파견 전도 안 물으면 에이전트 조회 없음', async () => {
  const raw = fakeRaw({ msgr2_agent_seats: [{ agent_id: AG, allow: 'list', allow_users: ['u1'] }], msgr2_agents: [{ id: AG, owner_user_id: 'o', slug: 'a', display_name: '에이', status: 'active' }] });
  const c = createV2Client(raw);
  const r = await c.from('msgr_crews').select('id, owner_user_id, slug, display_name, allow, allow_users, last_seen_at, folder, bio').eq('org_id', SPACE).in('status', ['active', 'available']);
  assert.deepEqual(raw.log.map((e) => e.table), ['msgr2_agent_seats', 'msgr2_agents', 'msgr2_agents']);
  assert.deepEqual(raw.log[1].ops.slice(1), [['in', 'id', [AG]], ['in', 'status', ['active']]]);
  assert.deepEqual(raw.log[2].ops.slice(1), [['eq', 'owner_user_id', 'o'], ['eq', 'status', 'active']], '파견 전 = 내(세션 사용자) 활성 에이전트');
  assert.equal(r.data.length, 1, '자리 있는 내 에이전트는 파견 전에 다시 넣지 않는다');
  assert.equal(r.data[0].allow, 'list'); assert.deepEqual(r.data[0].allow_users, ['u1']); assert.equal(r.data[0].org_id, SPACE); assert.equal(r.data[0].bio, null); assert.equal(r.data[0].status, 'active');
  // 자리가 없는 공간: 파견 전만(내 에이전트 = status available)
  const fresh = fakeRaw({ msgr2_agent_seats: [], msgr2_agents: [{ id: AG, owner_user_id: 'o', display_name: '에이', status: 'active' }] });
  const r3 = await createV2Client(fresh).from('msgr_crews').select('id, status').eq('org_id', SPACE).in('status', ['active', 'available']);
  assert.deepEqual(r3.data.map((x) => [x.id, x.status]), [[AG, 'available']]);
  const none = fakeRaw({ msgr2_agent_seats: [] }); const r2 = await createV2Client(none).from('msgr_crews').select('id').eq('org_id', SPACE);
  assert.deepEqual(r2.data, []); assert.deepEqual(none.log.map((e) => e.table), ['msgr2_agent_seats']);
  assert.equal((await createV2Client(fakeRaw()).from('msgr_crews').update({ bio: 'x' }).eq('id', AG)).error.code, V2_UNSUPPORTED, '에이전트 고치기는 v2 모드에서 아직 없다');
});

test('쓰기: 반응은 v2 표로(없는 열은 버림), 방 설정·방 멤버는 U6d RPC로(U6c-2b), 대응 표가 없으면 요청 없이 v2_unsupported', async () => {
  const raw = fakeRaw(); const c = createV2Client(raw);
  await c.from('msgr_reactions').insert({ message_id: 5, user_id: 'u', emoji: '👍' });
  assert.deepEqual(raw.log[0], { kind: 'from', table: 'msgr2_reactions', ops: [['insert', { message_id: 5, user_id: 'u', emoji: '👍' }, undefined]] });
  await c.from('msgr_channel_prefs').upsert([{ channel_id: ROOM, user_id: 'u', muted: true, pin_pos: 3, sort_pos: 1 }, { channel_id: 'r2', user_id: 'u', sort_pos: 4 }]);
  assert.deepEqual(raw.log.slice(1).map((e) => [e.name, e.args]), [['msgr2_room_pref_set', { p_room: ROOM, p_muted: true, p_pinned: null }]], '순서 열만 있는 행은 요청 없이 버린다');
  await c.from('msgr_channel_members').upsert([{ channel_id: ROOM, member_kind: 'crew', member_id: AG }, { channel_id: ROOM, member_kind: 'user', member_id: 'x' }], { onConflict: 'channel_id,member_kind,member_id' });
  assert.deepEqual([raw.log.at(-1).name, raw.log.at(-1).args], ['msgr2_room_members_add', { p_room: ROOM, p_users: ['x'], p_agents: [AG] }]);
  const n = raw.log.length;
  assert.equal((await c.from('msgr_channel_groups').insert({ name: 'x' })).error.code, V2_UNSUPPORTED);
  assert.deepEqual((await c.from('msgr_bots').select('crew_id').eq('org_id', SPACE)).data, []);
  assert.equal((await c.from('msgr_crew_approvals').select('id').eq('channel_id', ROOM).maybeSingle()).data, null);
  assert.equal(raw.log.length, n, '대응 표가 없는 조회·쓰기는 요청 0');
});

test('그대로 쓰는 표(설계 1-2절)는 원래 클라이언트로, auth·storage도 원래 것', async () => {
  const raw = fakeRaw(); const c = createV2Client(raw);
  for (const t of ['msgr_profiles', 'msgr_friends', 'msgr_friend_links', 'msgr_user_blocks', 'msgr_user_hides', 'msgr_reports', 'msgr_org_docs', 'msgr_journal_entries', 'msgr_org_entitlements']) {
    await c.from(t).select('*'); assert.equal(raw.log.at(-1).table, t);
  }
  assert.equal(c.auth.tag, 'auth'); assert.equal(c.storage.tag, 'storage');
});

test('RPC: 그대로 쓰는 것·msgr2_*·친구 요청은 원래대로, 바꾸지 않은 옛 쓰기는 요청 없이 v2_unsupported, 그 밖의 옛 읽기는 요청 없이 빈 값', async () => {
  const raw = fakeRaw(); const c = createV2Client(raw);
  await c.rpc('msgr_my_friends'); await c.rpc('msgr2_catch_up', { p_since_id: 0 }); await c.rpc('msgr_avatars', { ids: [] }); await c.rpc('msgr_friend_request', { target: 'x' }); await c.rpc('msgr_friend_link_accept', { code: 'c' });
  assert.deepEqual(raw.log.map((e) => e.name), ['msgr_my_friends', 'msgr2_catch_up', 'msgr_avatars', 'msgr_friend_request', 'msgr_friend_link_accept'], '친구 쓰기는 옛 RPC 그대로(옛 중단 장치가 v2 앱 기기만 통과 — U6d)');
  for (const w of ['msgr_crew_join_decide', 'msgr_work_create', 'msgr_mute_crew']) assert.equal((await c.rpc(w, {})).error.code, V2_UNSUPPORTED, w);
  assert.deepEqual((await c.rpc('msgr_dm_personal_list', {})).data, []);
  assert.equal((await c.rpc('msgr_my_badge')).data, 0);
  assert.equal(raw.log.length, 5, '바꾸지 않은 옛 RPC는 요청 0');
  assert.equal(v2Route('rpc', 'msgr_unread'), 'map'); assert.equal(v2Route('rpc', 'msgr_mute_crew'), 'unsupported'); assert.equal(v2Route('table', 'msgr_channels'), 'map'); assert.equal(v2Route('table', 'msgr_profiles'), 'keep'); assert.equal(v2Route('table', 'msgr_bots'), 'none');
});

test('행 바꾸기 왕복: 옛 → v2 → 옛이 같은 값(정해진 열)', () => {
  const v2 = toV2Row('msgr_messages', { channel_id: ROOM, author_kind: 'crew', crew_id: AG, body: 'x', mentions: [{ kind: 'crew', id: AG }, { kind: 'user', id: 'u' }, { kind: 'crew', id: AG }], thread_root: 9 });
  assert.deepEqual(v2, { room_id: ROOM, author_kind: 'agent', author_agent_id: AG, body: 'x', mentions: [AG] });
  const back = toLegacyRow('msgr_messages', v2, ['channel_id', 'author_kind', 'crew_id', 'body', 'mentions', 'thread_root']);
  assert.deepEqual({ ...back, _v2: undefined }, { channel_id: ROOM, author_kind: 'crew', crew_id: AG, body: 'x', mentions: [{ kind: 'crew', id: AG }], thread_root: null, _v2: undefined });
});

test('첨부 경로(#1085 검수): v2 storage_path(버킷/객체)는 옛 모양에서 버킷 안 객체 이름으로, 조건·쓰기는 다시 버킷을 붙인다, 다른 버킷은 그대로', async () => {
  const obj = `${SPACE}/${ROOM}/103/0-a.csv`;
  const raw = fakeRaw({ msgr2_attachments: [{ id: 1, message_id: 103, storage_path: `msgr/${obj}`, name: 'a.csv' }, { id: 2, message_id: 104, storage_path: `other/${obj}`, name: 'b' }] });
  const c = createV2Client(raw);
  const r = await c.from('msgr_attachments').select('id, message_id, storage_path, name, mime, bytes').in('message_id', [103, 104]);
  assert.equal(r.data[0].storage_path, obj, "media-io가 storage.from('msgr')로 서명하는 이름");
  assert.equal(r.data[1].storage_path, `other/${obj}`, '다른 버킷은 그대로(옛 화면이 열지 않게)');
  await c.from('msgr_attachments').select('id').eq('storage_path', obj);
  assert.deepEqual(raw.log.at(-1).ops.at(-1), ['eq', 'storage_path', `msgr/${obj}`]);
  await c.from('msgr_attachments').select('id').in('storage_path', [obj, `msgr/${obj}`]);
  assert.deepEqual(raw.log.at(-1).ops.at(-1), ['in', 'storage_path', [`msgr/${obj}`, `msgr/${obj}`]]);
  assert.deepEqual(toV2Row('msgr_attachments', { storage_path: obj, name: 'a' }), { storage_path: `msgr/${obj}`, name: 'a' });
});

test('등록 전 읽기(#1085 검수 2): 바꾼 조회·에이전트 조회·msgr2_* RPC는 기기 등록이 끝난 뒤에 나간다, 그대로 쓰는 표·RPC는 기다리지 않는다', async () => {
  const raw = fakeRaw({ msgr2_room_members: [], msgr2_agent_seats: [] });
  let open; const gate = new Promise((r) => { open = r; });
  const c = createV2Client(raw, { ready: () => gate });
  const a = c.from('msgr_channel_members').select('channel_id').eq('member_kind', 'user').eq('member_id', 'me');
  const b = c.from('msgr_crews').select('id').eq('org_id', SPACE);
  const r = c.rpc('msgr2_unread', {});
  c.from('msgr_profiles').select('*'); await c.rpc('msgr_my_friends');
  const p1 = a.then((x) => x); const p2 = b.then((x) => x);
  await new Promise((res) => setTimeout(res, 5));
  assert.deepEqual(raw.log.map((e) => e.table ?? e.name), ['msgr_profiles', 'msgr_my_friends'], '등록 전에는 그대로 쓰는 것만');
  open(); await Promise.all([p1, p2, r]);
  assert.ok(raw.log.some((e) => e.table === 'msgr2_room_members') && raw.log.some((e) => e.table === 'msgr2_agent_seats') && raw.log.some((e) => e.name === 'msgr2_unread'), '등록 뒤에 나간다');
});
