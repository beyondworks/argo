// 메신저 v2 U6c-2b — 기존 셸의 옛 RPC·쓰기가 U6d 서버 RPC(20261018040000_msgr2_rooms.sql)로 바뀌어 나가고 결과가 옛 모양으로 돌아오는지,
// 읽음은 msgr2_mark_read로만 쓰는지, 끼워 읽기(방)·초대·공간 만들기·방 멤버·안 읽음·찾기·오류 문구·방 사건.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createV2Client, splitCols } from '../src/v2/source.mjs';
import { legacyInvite, legacyPreview, inviteArgs } from '../src/v2/legacy-rpc.mjs';
import { v2ErrorKey, V2_ERROR_KEYS } from '../src/v2/errors.mjs';
import { roomEventPlan } from '../src/v2/room-events.mjs';
import { v2SearchFound } from '../src/v2/search.mjs';
import { friendlyErr } from '../src/error-toast.mjs';
import { DICT } from '../src/i18n.js';

const ME = 'u0000000-0000-4000-8000-000000000001', MATE = 'u0000000-0000-4000-8000-000000000002';
const P = 'p0000000-0000-4000-8000-000000000001', T = 't0000000-0000-4000-8000-000000000001';
const R1 = 'r0000000-0000-4000-8000-000000000001', R2 = 'r0000000-0000-4000-8000-000000000002', RX = 'r0000000-0000-4000-8000-0000000000ff';
const AG = 'a0000000-0000-4000-8000-000000000001';

/** 호출 기록 가짜. rpcs[이름] = 값 또는 (인자) => 값(던지면 오류), tables[표] = 행. */
function fakeRaw({ rpcs = {}, tables = {} } = {}) {
  const log = [];
  const chain = (entry) => {
    const b = {};
    for (const op of ['select', 'insert', 'upsert', 'update', 'delete', 'eq', 'neq', 'in', 'is', 'order', 'limit', 'maybeSingle', 'single', 'or', 'not', 'ilike']) b[op] = (...a) => { entry.ops.push([op, ...a]); return b; };
    b.then = (res, rej) => { const rows = tables[entry.table] ?? []; const one = entry.ops.some(([op]) => op === 'maybeSingle' || op === 'single'); return Promise.resolve({ data: one ? rows[0] ?? null : rows, error: null, status: 200 }).then(res, rej); };
    return b;
  };
  return {
    log,
    auth: { getSession: async () => ({ data: { session: { user: { id: ME } } } }) },
    from(table) { const e = { kind: 'from', table, ops: [] }; log.push(e); return chain(e); },
    rpc(name, args) {
      log.push({ kind: 'rpc', name, args });
      const v = rpcs[name];
      try { return Promise.resolve({ data: typeof v === 'function' ? v(args) : v ?? null, error: null, status: 200 }); } catch (e) { return Promise.resolve({ data: null, error: { message: e.message }, status: 400 }); }
    },
  };
}
const client = (raw) => createV2Client(raw, { personalSpace: async () => P, roomsOf: async (sp) => (sp === T ? [R1] : sp === P ? [R2] : []) });
const rpcLog = (raw) => raw.log.filter((e) => e.kind === 'rpc').map((e) => [e.name, e.args]);

test('신고·방 만들기·참여·둘러보기·나가기: 옛 RPC → U6d RPC(인자), 결과는 옛 모양', async () => {
  const raw = fakeRaw({ rpcs: { msgr2_report_message: 'rep1', msgr2_room_create: R1, msgr2_dm_open: { room_id: R2, space_id: T, existing: false }, msgr2_room_join: true,
    msgr2_rooms_browse: [{ id: R1, name: '일반', members: 3, created_at: 'x', joined: false }], msgr2_room_leave: true } });
  const c = client(raw);
  assert.equal((await c.rpc('msgr_report_message', { msg: 7, reason: '스팸' })).data, 'rep1');
  assert.equal((await c.rpc('msgr_create_channel', { org: T, kind: 'public', name: '일반' })).data, R1);
  assert.equal((await c.rpc('msgr_create_channel', { org: T, kind: 'private', name: '기획' })).data, R1);
  assert.equal((await c.rpc('msgr_create_channel', { org: T, kind: 'dm', name: 'dm:민지', others: [{ kind: 'user', id: MATE }] })).data, R2, '팀 1:1은 짝당 하나(dm_open)');
  assert.equal((await c.rpc('msgr_create_channel', { org: T, kind: 'dm', name: 'dm:민지, 지수', others: [{ kind: 'user', id: MATE }, { kind: 'user', id: 'x' }] })).data, R1, '여럿이면 비공개 방');
  assert.equal((await c.rpc('msgr_join_channel', { ch: R1 })).data, 'joined');
  assert.deepEqual((await c.rpc('msgr_browse_channels', { org: T })).data, [{ id: R1, name: '일반', members: 3, created_at: 'x', joined: false, kind: 'public', topic: null }]);
  assert.equal((await c.rpc('msgr_leave_dm', { ch: R2 })).data, true);
  assert.deepEqual(rpcLog(raw), [
    ['msgr2_report_message', { p_message: 7, p_reason: '스팸' }],
    ['msgr2_room_create', { p_space: T, p_kind: 'open', p_name: '일반', p_users: [], p_agents: [] }],
    ['msgr2_room_create', { p_space: T, p_kind: 'private', p_name: '기획', p_users: [], p_agents: [] }],
    ['msgr2_dm_open', { p_user: MATE, p_space: T }],
    ['msgr2_room_create', { p_space: T, p_kind: 'private', p_name: '민지, 지수', p_users: [MATE, 'x'], p_agents: [] }],
    ['msgr2_room_join', { p_room: R1 }],
    ['msgr2_rooms_browse', { p_space: T, p_include_joined: false }],
    ['msgr2_room_leave', { p_room: R2 }],
  ]);
});

test('개인 1:1·에이전트 1:1·여러 사람 방·에이전트 넣기/빼기: 옛 반환값(방 id·joined/already·left)', async () => {
  const raw = fakeRaw({ rpcs: { msgr2_dm_open: { room_id: R2, space_id: P }, msgr2_agent_dm_open: { room_id: RX, space_id: P }, msgr2_room_create: R1, msgr2_room_members_add: (a) => (a.p_room === R1 ? 1 : 0), msgr2_room_member_remove: true } });
  const c = client(raw);
  assert.equal((await c.rpc('msgr_dm_personal', { target: MATE })).data, R2);
  assert.equal((await c.rpc('msgr_dm_personal_crew', { crew: AG })).data, RX);
  assert.equal((await c.rpc('msgr_dm_personal_group', { targets: [MATE, 'x'], title: '민지, 지수' })).data, R1);
  assert.equal((await c.rpc('msgr_crew_join', { ch: R1, crew: AG })).data, 'joined');
  assert.equal((await c.rpc('msgr_crew_join', { ch: R2, crew: AG })).data, 'already');
  assert.equal((await c.rpc('msgr_crew_leave_channel', { ch: R1, crew: AG })).data, 'left');
  assert.deepEqual(rpcLog(raw).map(([n, a]) => [n, a]), [
    ['msgr2_dm_open', { p_user: MATE }], ['msgr2_agent_dm_open', { p_agent: AG }],
    ['msgr2_room_create', { p_space: null, p_kind: 'private', p_name: '민지, 지수', p_users: [MATE, 'x'] }],
    ['msgr2_room_members_add', { p_room: R1, p_users: [], p_agents: [AG] }], ['msgr2_room_members_add', { p_room: R2, p_users: [], p_agents: [AG] }],
    ['msgr2_room_member_remove', { p_room: R1, p_kind: 'agent', p_member: AG }],
  ]);
});

test('안 읽음: 옛 org null = 개인 공간 id로 묻는다, 합계는 공간별(음소거 제외, 개인 = org_id null), 사람 멘션 0', async () => {
  const rows = [{ room_id: R1, space_id: T, n: 3, muted: false }, { room_id: RX, space_id: T, n: 9, muted: true }, { room_id: R2, space_id: P, n: 2, muted: false }];
  const raw = fakeRaw({ rpcs: { msgr2_unread: (a) => rows.filter((x) => !a.p_space || x.space_id === a.p_space) } });
  const c = client(raw);
  assert.deepEqual((await c.rpc('msgr_unread', { org: null })).data, [{ channel_id: R2, n: 2, mention: 0, muted: false }]);
  assert.deepEqual((await c.rpc('msgr_unread', { org: T })).data.map((x) => [x.channel_id, x.n]), [[R1, 3], [RX, 9]]);
  assert.deepEqual((await c.rpc('msgr_unread_totals')).data, [{ org_id: T, n: 3, mention: 0 }, { org_id: null, n: 2, mention: 0 }]);
  assert.deepEqual(rpcLog(raw), [['msgr2_unread', { p_space: P }], ['msgr2_unread', { p_space: T }], ['msgr2_unread', {}]]);
});

test('찾기: 탭 본문 찾기·⌘K 글 찾기는 msgr2_search 한 번, 지금 공간의 방만, 옛 행 모양', async () => {
  const res = { rooms: [{ id: R1, name: '일반' }], messages: [{ id: 5, room_id: R1, author_kind: 'agent', author_agent_id: AG, created_at: 'c', snippet: '가격표' }, { id: 6, room_id: R2, author_kind: 'user', author_user_id: MATE, created_at: 'd', snippet: '다른 공간' }], people: [], agents: [] };
  const raw = fakeRaw({ rpcs: { msgr2_search: res } });
  const c = client(raw);
  assert.deepEqual((await c.rpc('msgr_tab_search', { org: T, q: '가격' })).data, [{ channel_id: R1 }]);
  assert.deepEqual((await c.rpc('msgr_tab_search', { org: null, q: '공간' })).data, [{ channel_id: R2 }], '개인 공간은 개인 공간 방');
  const found = await v2SearchFound(c, '가격', new Set([R1]));
  assert.deepEqual(found, [{ id: 5, channel_id: R1, author_kind: 'crew', author_user_id: null, crew_id: AG, body: '가격표', created_at: 'c', _v2: true }]);
  assert.deepEqual(rpcLog(raw).map(([n, a]) => [n, a.p_limit]), [['msgr2_search', 50], ['msgr2_search', 50], ['msgr2_search', 50]]);
  await assert.rejects(v2SearchFound(createV2Client(fakeRaw({ rpcs: { msgr2_search: () => { throw new Error('boom'); } } })), 'x', new Set()), /boom/, '실패는 던진다(셸이 failed로)');
  const src = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(src, /await fetchSearchRows\(\(\) => V2 \? v2SearchFound\(supabase, qs,/, '⌘K는 v2에서 msgr2_search로');
});

test('읽음은 msgr2_mark_read로만(직접 쓰기 없음), 방 설정은 msgr2_room_pref_set(음소거·고정만), 읽기는 그대로 표', async () => {
  const raw = fakeRaw({ rpcs: { msgr2_mark_read: 9 } });
  const c = client(raw);
  const r = await c.from('msgr_reads').upsert({ channel_id: R1, user_id: ME, last_read_id: 9, updated_at: 'now' });
  assert.equal(r.error, null);
  await c.from('msgr_reads').select('channel_id, last_read_id').eq('user_id', ME).in('channel_id', [R1]);
  assert.deepEqual(raw.log.map((e) => (e.kind === 'rpc' ? e.name : `${e.table}:${e.ops[0][0]}`)), ['msgr2_mark_read', 'msgr2_reads:select'], 'msgr2_reads에 직접 쓰지 않는다');
  assert.deepEqual(raw.log[0].args, { p_room: R1, p_last_id: 9 });
  await c.from('msgr_channel_prefs').upsert([{ channel_id: R1, muted: false }, { channel_id: R2, pinned: true, pin_pos: 2 }]);
  assert.deepEqual(rpcLog(raw).slice(1), [['msgr2_room_pref_set', { p_room: R1, p_muted: false, p_pinned: null }], ['msgr2_room_pref_set', { p_room: R2, p_muted: null, p_pinned: true }]]);
  assert.ok(!raw.log.some((e) => e.kind === 'from' && ['msgr2_reads', 'msgr2_prefs'].includes(e.table) && e.ops.some(([op]) => ['insert', 'upsert', 'update'].includes(op))));
});

test('방 멤버 쓰기: 넣기 → msgr2_room_members_add, 나 빼기 → msgr2_room_leave, 남·에이전트 빼기 → msgr2_room_member_remove, 결과 행', async () => {
  const raw = fakeRaw({ rpcs: { msgr2_room_members_add: 1, msgr2_room_leave: true, msgr2_room_member_remove: (a) => a.p_member === MATE } });
  const c = client(raw);
  assert.equal((await c.from('msgr_channel_members').upsert([{ channel_id: R1, member_kind: 'user', member_id: MATE, added_by: ME }], { onConflict: 'channel_id,member_kind,member_id' })).error, null);
  assert.deepEqual((await c.from('msgr_channel_members').delete().eq('channel_id', R1).eq('member_kind', 'user').eq('member_id', ME).select('member_id')).data, [{ member_id: ME }]);
  assert.deepEqual((await c.from('msgr_channel_members').delete().eq('channel_id', R1).eq('member_kind', 'user').eq('member_id', MATE).select('member_id')).data, [{ member_id: MATE }]);
  assert.deepEqual((await c.from('msgr_channel_members').delete().eq('channel_id', R1).eq('member_kind', 'crew').eq('member_id', AG).select('member_id')).data, [], '없던 행이면 빈 결과(옛 앱이 권한 없음으로 안내)');
  assert.deepEqual(rpcLog(raw), [
    ['msgr2_room_members_add', { p_room: R1, p_users: [MATE], p_agents: [] }], ['msgr2_room_leave', { p_room: R1 }],
    ['msgr2_room_member_remove', { p_room: R1, p_kind: 'user', p_member: MATE }], ['msgr2_room_member_remove', { p_room: R1, p_kind: 'agent', p_member: AG }],
  ]);
  assert.equal((await c.from('msgr_channel_members').delete().eq('channel_id', R1)).error.code, 'v2_unsupported', '여러 행 지우기는 v2에 없다');
});

test('공간 만들기: 옛 msgr_orgs 넣기 → msgr2_space_create(규칙에 맞는 주소만), 결과 { id }', async () => {
  const raw = fakeRaw({ rpcs: { msgr2_space_create: T } });
  const c = client(raw);
  assert.deepEqual((await c.from('msgr_orgs').insert({ name: 'Beyond', slug: 'beyond-1a2b', owner_user_id: ME }).select('id').single()).data, { id: T });
  await c.from('msgr_orgs').insert({ name: '팀', slug: '-bad!' }).select('id').single();
  assert.deepEqual(rpcLog(raw), [['msgr2_space_create', { p_name: 'Beyond', p_slug: 'beyond-1a2b' }], ['msgr2_space_create', { p_name: '팀', p_slug: null }]]);
  assert.deepEqual((await c.from('msgr_orgs').select('id')).data, [], '조직 표 읽기는 v2에 없다(요청 0)');
  assert.equal(raw.log.length, 2);
});

test('초대: 만들기 → msgr2_invite_create(만료 초·횟수·게스트), 목록 → msgr2_invites_list(옛 행 모양, 거른 뒤), 지우기·취소 → msgr2_invite_revoke, 새 링크로 바꾸기', async () => {
  const now = Date.parse('2026-10-18T00:00:00Z');
  assert.deepEqual(inviteArgs({ org_id: T, role: 'member', channel_ids: [R1], max_uses: null, expires_at: new Date(now + 7 * 864e5).toISOString() }, now),
    { p_space: T, p_role: 'member', p_user: null, p_rooms: [R1], p_max_uses: null, p_expires_in_s: 604800, p_guest_days: null });
  assert.deepEqual(inviteArgs({ org_id: T, role: 'member' }, now), { p_space: T, p_role: 'member', p_user: null, p_rooms: [], p_max_uses: 1, p_expires_in_s: 604800, p_guest_days: null }, '옛 OrgCard 넣기(만료·횟수 없음) = 7일·1회');
  assert.equal(inviteArgs({ org_id: T, role: 'guest', channel_ids: [R1], expires_at: null, guest_days: 30, max_uses: 1 }, now).p_expires_in_s, null);
  assert.equal(inviteArgs({ org_id: T, role: 'guest', channel_ids: [R1], guest_days: 7 }, now).p_guest_days, 7);
  const list = [
    { id: 'i1', code: 'c1', role: 'member', room_ids: [R1], expires_at: null, max_uses: null, use_count: 0, created_at: '2026-10-17', state: 'valid', target_user_id: null },
    { id: 'i2', code: 'c2', role: 'member', room_ids: [], expires_at: null, max_uses: 1, use_count: 0, created_at: '2026-10-18', state: 'valid', target_user_id: null },
    { id: 'i3', code: 'c3', role: 'member', room_ids: [], created_at: '2026-10-16', state: 'declined' },
  ];
  const raw = fakeRaw({ rpcs: { msgr2_invite_create: { invite_id: 'i2', code: 'c2', expires_at: null, existing: false }, msgr2_invites_list: list, msgr2_invite_revoke: true } });
  const c = client(raw);
  assert.deepEqual((await c.from('msgr_invites').insert({ org_id: T, role: 'member', created_by: ME, channel_ids: [], max_uses: 1, expires_at: null }).select('id, code').single()).data, { id: 'i2', code: 'c2', expires_at: null });
  const sel = await c.from('msgr_invites').select('id, code, role').eq('org_id', T).eq('role', 'member').is('revoked_at', null).order('created_at', { ascending: false }).limit(20);
  assert.deepEqual(sel.data.map((x) => x.id), ['i2', 'i1'], '거절된 초대는 취소된 것으로 걸러진다, 최신순');
  assert.deepEqual(sel.data[1].channel_ids, [R1]);
  assert.equal((await c.from('msgr_invites').select('id, use_count').eq('id', 'i1').maybeSingle()).data.id, 'i1', 'id만으로 읽기 — 기억한 공간으로');
  assert.deepEqual((await c.from('msgr_invites').delete().eq('id', 'i1').eq('use_count', 0).select('id')).data, [{ id: 'i1' }]);
  assert.equal((await c.rpc('msgr_invite_replace', { keep: 'i2' })).data, true);
  assert.equal((await c.rpc('msgr_invite_revoke', { invite: 'i1' })).data, true);
  const names = rpcLog(raw).map(([n, a]) => `${n}:${a.p_invite ?? a.p_space ?? ''}`);
  assert.deepEqual(names, [`msgr2_invite_create:${T}`, `msgr2_invites_list:${T}`, `msgr2_invites_list:${T}`, 'msgr2_invite_revoke:i1', `msgr2_invites_list:${T}`, 'msgr2_invite_revoke:i1', 'msgr2_invite_revoke:i1'], '바꾸기는 같은 역할의 다른 링크(i1)만 취소');
  assert.equal((await c.from('msgr_invites').insert({ org_id: T, role: 'member', for_node: true }).select('code').single()).error.code, 'v2_unsupported', '노드 코드는 v2에 없다');
  const unknown = await client(fakeRaw()).from('msgr_invites').select('id').eq('id', 'zz').maybeSingle();
  assert.equal(unknown.data, null);
});

test('초대 미리보기·받기: 옛 모양(org_name·channels·already_member), 받기 → 공간·첫 방', async () => {
  assert.deepEqual(legacyPreview({ state: 'valid', space_id: T, space_name: 'Beyond', role: 'member', inviter_name: '민지', expires_at: null, already_member: true, rooms: [{ id: R1, name: '일반' }] }),
    { state: 'already_member', org_id: T, org_name: 'Beyond', role: 'member', inviter_name: '민지', expires_at: null, channels: [{ id: R1, name: '일반', kind: 'public' }], _v2: true });
  assert.equal(legacyPreview({ state: 'expired', space_name: 'Beyond' }).state, 'expired');
  const raw = fakeRaw({ rpcs: { msgr2_invite_preview: { state: 'valid', space_id: T, space_name: 'B', rooms: [] }, msgr2_invite_accept: { space_id: T, role: 'member', rooms: [R1], already_member: false } } });
  const c = client(raw);
  assert.equal((await c.rpc('msgr_invite_preview', { code: 'c' })).data.org_name, 'B');
  assert.deepEqual((await c.rpc('msgr_accept_invite_v2', { code: 'c' })).data, { org_id: T, channel_id: R1, joined_channel_ids: [R1], skipped_channel_ids: [] });
  assert.deepEqual(rpcLog(raw), [['msgr2_invite_preview', { p_code: 'c' }], ['msgr2_invite_accept', { p_code: 'c' }]]);
  assert.equal(legacyInvite({ id: 'x', state: 'revoked', created_at: 'c' }).revoked_at, 'c');
});

test('끼워 읽기: msgr_channels(...)·!inner는 msgr2_rooms 별칭으로 한 요청, 방은 옛 모양(org_id·dm), 그 밖의 끼워 읽기는 던진다', async () => {
  const raw = fakeRaw({ tables: {
    msgr2_messages: [{ id: 5, body: 'b', room_id: R1, msgr_channels: { name: '일반', kind: 'open' } }],
    msgr2_room_members: [{ room_id: R2, msgr_channels: { id: R2, kind: 'direct', space_id: T, archived_at: null } }],
  } });
  const c = client(raw);
  const m = await c.from('msgr_messages').select('id, body, channel_id, msgr_channels(name, kind)').eq('id', 5).is('deleted_at', null).maybeSingle();
  assert.equal(raw.log[0].ops[0][1], 'id, body, room_id, msgr_channels:msgr2_rooms(name, kind)');
  assert.deepEqual(m.data.msgr_channels, { name: '일반', kind: 'public' });
  const mine = await c.from('msgr_channel_members').select('channel_id, msgr_channels!inner(id, kind, org_id, archived_at)').eq('member_kind', 'user').eq('member_id', ME);
  assert.equal(raw.log[1].ops[0][1], 'room_id, msgr_channels:msgr2_rooms!inner(id, kind, space_id, archived_at)');
  assert.deepEqual(mine.data[0].msgr_channels, { id: R2, kind: 'dm', org_id: T, archived_at: null });
  assert.throws(() => splitCols('id, msgr_channel_members(member_kind)'), /embedded select is not mapped/);
  assert.deepEqual(splitCols('id, msgr_channels(name, kind), body'), ['id', 'body']);
});

test('오류 코드 → 사전 문구(ko·en): U6d 코드는 모두 사전 키가 있고, friendlyErr가 먼저 바꾼다', () => {
  for (const k of new Set(V2_ERROR_KEYS)) { assert.ok(DICT[k]?.[0] && DICT[k]?.[1], k); assert.doesNotMatch(DICT[k][1], /[가-힣]/, k); }
  const codes = ['msgr2_app_device_required', 'msgr2_device_invalid', 'service_paused', 'msgr2_forbidden', 'msgr2_not_space_member', 'msgr2_not_friend', 'msgr2_group_blocked_pair',
    'msgr2_invite_rejoin_direct_only', 'msgr2_dm_unavailable', 'msgr2_invite_unavailable', 'msgr2_agent_not_allowed', 'msgr2_room_not_found', 'msgr2_direct_fixed', 'msgr2_invite_not_found',
    'msgr2_invite_expired', 'msgr2_invite_exhausted', 'msgr2_invite_revoked', 'msgr2_invite_declined', 'msgr2_bad_name', 'msgr2_bad_kind', 'msgr2_bad_invite', 'msgr2_limit', 'msgr2_slug_taken',
    'msgr_owner_transfer_required', 'msgr2_report_own', 'msgr2_report_no_message', 'msgr2_space_not_found', 'msgr2_invite_room_forbidden'];
  for (const code of codes) assert.ok(v2ErrorKey(code), code);
  assert.equal(v2ErrorKey('msgr2_dm_unavailable (42501)'), 'v2.err.dmUnavailable');
  assert.equal(v2ErrorKey('msgr_crew_not_visible'), null, '옛 코드는 기존 판정으로');
  const t = (k) => DICT[k]?.[0] ?? k; const en = (k) => DICT[k]?.[1] ?? k;
  assert.equal(friendlyErr('msgr2_not_friend', t), DICT['v2.err.notFriend'][0]);
  assert.equal(friendlyErr('msgr2_invite_expired', en), DICT['inv.err.expired'][1]);
  assert.equal(friendlyErr('msgr2_forbidden', t), DICT['err.denied'][0]);
});

test('방 사건(v2:u: spaces·rooms): 공간 목록·보는 공간의 방 목록을 한 번 다시 읽고, 보던 방에서 빠졌으면 닫는다, 다른 공간·초대는 읽지 않는다', () => {
  const at = { orgId: T, personal: '__personal__', personalId: P, chId: R1 };
  assert.deepEqual(roomEventPlan({ event: 'spaces', payload: { space_id: T } }, at), { orgs: true, reload: false, forget: T, close: false });
  assert.deepEqual(roomEventPlan({ event: 'rooms', payload: { space_id: T, room_id: R2 } }, at), { orgs: false, reload: true, forget: T, close: false });
  assert.deepEqual(roomEventPlan({ event: 'rooms', payload: { space_id: T, room_id: R1, removed: true } }, at), { orgs: false, reload: true, forget: T, close: true });
  assert.equal(roomEventPlan({ event: 'rooms', payload: { space_id: 'other', room_id: RX } }, at).reload, false, '다른 공간은 읽지 않는다');
  assert.equal(roomEventPlan({ event: 'rooms', payload: { space_id: P, room_id: R2 } }, { ...at, orgId: '__personal__' }).reload, true, '개인 공간 자리 = 진짜 개인 공간 id');
  assert.equal(roomEventPlan({ event: 'rooms', payload: { room_id: R1, removed: true } }, at).close, true, '나가기 방송에는 공간이 없다');
  assert.deepEqual(roomEventPlan({ event: 'invite', payload: {} }, at), { orgs: false, reload: false, forget: null, close: false });
  assert.deepEqual(roomEventPlan({ event: 'device_revoked', payload: {} }, at), { orgs: false, reload: false, forget: null, close: false });
  const src = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(src, /m\.on\('event', \(ev\) => v2RoomEventRef\.current\?\.\(ev\)\)/, '셸이 기계의 사건을 받는다');
});

test('셸: #1085에서 숨긴 단추를 켰다(신고·친구 요청·새 채널·둘러보기·새 대화·초대·조직 참여·만들기), 범위 밖(그룹·노드·업무 패널·에이전트 숨김)은 그대로 숨김', () => {
  const src = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(src, /const orgJoinForms = \(phone = false\) => \(<>/);
  assert.match(src, /\{items\.includes\('invite'\) && <button/);
  assert.match(src, /\{relation === 'none' && <button type="button" className="btn btn-primary sm"/);
  assert.doesNotMatch(src, /\.\.\.\(V2 \? \[\] : \[\{ key: 'new'/);
  assert.doesNotMatch(src, /!V2 && <button type="button" className="btn msgr-chbrowse"/);
  assert.doesNotMatch(src, /onOrgTab && !orgBlocked && !V2 &&/);
  for (const keep of [/isPhone && !isPersonal && !V2 && \{ icon: 'folder'/, /isAdmin && !V2 && <OrgCard part="node"/, /\{!V2 && <>\{!isPersonal && !archived && <button type="button" className="btn sm msgr-work-button"/, /const canMuteCrew = !V2 &&/]) assert.match(src, keep);
});
