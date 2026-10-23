// 메신저 v2 어댑터 F7(재공개 전 검수 2026-10-23): 옛 표 고치기 → 서버 함수(20261023180000 F7절). 직접 v2 표 쓰기는 권한이 없어 나가면 안 된다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createV2Client, V2_UNSUPPORTED } from '../src/v2/source.mjs';

const SPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';
const ME = 'o';

/** rpc 결과를 이름별로 정하는 가짜 클라이언트. from()이 불리면 기록(직접 쓰기 = 결함) */
function fakeRaw(results = {}) {
  const log = [];
  return {
    log,
    auth: { getSession: async () => ({ data: { session: { user: { id: ME } } } }) },
    from(table) { log.push({ kind: 'from', table }); const b = new Proxy({}, { get: (_, k) => (k === 'then' ? (res) => res({ data: [], error: null }) : () => b) }); return b; },
    rpc(name, args) { log.push({ kind: 'rpc', name, args }); const r = results[name]; return Promise.resolve(typeof r === 'function' ? r(args) : r ?? { data: { ok: true }, error: null }); },
    channel(name) { return { name }; },
  };
}
const rpcs = (raw) => raw.log.filter((e) => e.kind === 'rpc').map((e) => [e.name, e.args]);
const froms = (raw) => raw.log.filter((e) => e.kind === 'from').map((e) => e.table);

test('방 설정·보관·기억 → msgr2_room_set, 에이전트 정책 → msgr2_set_room_agent_policy, v2에 없는 열만이면 요청 없이 v2_unsupported', async () => {
  const raw = fakeRaw(); const c = createV2Client(raw);
  let r = await c.from('msgr_channels').update({ name: '새 이름', topic: '주제' }).eq('id', ROOM).select('id');
  assert.deepEqual(r.data, [{ id: ROOM }]);
  r = await c.from('msgr_channels').update({ archived_at: '2026-10-23T00:00:00Z' }).eq('id', ROOM).select('id');
  r = await c.from('msgr_channels').update({ crew_memory: false }).eq('id', ROOM).select('id');
  r = await c.from('msgr_channels').update({ personal_crews: 'read_only' }).eq('id', ROOM).select('id');
  assert.deepEqual(rpcs(raw), [
    ['msgr2_room_set', { p_room: ROOM, p_name: '새 이름', p_memory: null, p_archive: null }],
    ['msgr2_room_set', { p_room: ROOM, p_name: null, p_memory: null, p_archive: true }],
    ['msgr2_room_set', { p_room: ROOM, p_name: null, p_memory: false, p_archive: null }],
    ['msgr2_set_room_agent_policy', { p_room: ROOM, p_policy: 'blocked' }],
  ]);
  const n = raw.log.length;
  assert.equal((await c.from('msgr_channels').update({ admin_user_ids: ['x'] }).eq('id', ROOM)).error.code, V2_UNSUPPORTED, '채널 관리자는 v2에 없다');
  assert.equal((await c.from('msgr_channels').update({ archived_at: null }).eq('id', ROOM)).error.code, V2_UNSUPPORTED, '보관 되돌리기는 없다');
  assert.equal((await c.from('msgr_channels').update({ kind: 'private' }).eq('id', ROOM)).error.code, V2_UNSUPPORTED, '모르는 열');
  assert.equal((await c.from('msgr_channels').delete().eq('id', ROOM)).error.code, V2_UNSUPPORTED, '방 삭제는 App이 room-delete.mjs로');
  assert.equal(raw.log.length, n, '거부되는 쓰기는 요청 0');
  assert.deepEqual(froms(raw), [], 'v2 표 직접 쓰기 0');
});

test('서버 거부: forbidden은 0행(화면이 "바꿀 수 없음"), 그 밖의 코드는 오류', async () => {
  const raw = fakeRaw({ msgr2_room_set: ({ p_memory }) => ({ data: p_memory === false ? { ok: false, code: 'forbidden' } : { ok: false, code: 'archived' }, error: null }) });
  const c = createV2Client(raw);
  assert.deepEqual((await c.from('msgr_channels').update({ crew_memory: false }).eq('id', ROOM).select('id')).data, []);
  const e = await c.from('msgr_channels').update({ crew_memory: true }).eq('id', ROOM).select('id');
  assert.equal(e.error.code, 'archived');
});

test('멤버: 내 표시 이름 → msgr2_space_display_name_set(남의 행은 요청 없이 0행), 역할 → msgr2_set_member_role, 내보내기 → msgr2_space_member_remove', async () => {
  const raw = fakeRaw({ msgr2_space_member_remove: { data: false, error: null } }); const c = createV2Client(raw);
  assert.deepEqual((await c.from('msgr_org_members').update({ display_name: '유' }).eq('org_id', SPACE).eq('user_id', ME).select('user_id')).data, [{ user_id: ME }]);
  assert.deepEqual((await c.from('msgr_org_members').update({ display_name: '남' }).eq('org_id', SPACE).eq('user_id', 'x').select('user_id')).data, [], '남의 표시 이름');
  assert.deepEqual((await c.from('msgr_org_members').update({ role: 'admin' }).eq('org_id', SPACE).eq('user_id', 'x').select('user_id')).data, [{ user_id: 'x' }]);
  assert.deepEqual((await c.from('msgr_org_members').update({ removed_at: '2026-10-23T00:00:00Z' }).eq('org_id', SPACE).eq('user_id', 'x').select('user_id')).data, [], '서버가 false(이미 나감)면 0행');
  assert.deepEqual(rpcs(raw), [
    ['msgr2_space_display_name_set', { p_space: SPACE, p_name: '유' }],
    ['msgr2_set_member_role', { p_space: SPACE, p_user: 'x', p_role: 'admin' }],
    ['msgr2_space_member_remove', { p_space: SPACE, p_user: 'x' }],
  ]);
  assert.equal((await c.from('msgr_org_members').update({ role: 'admin', display_name: 'x' }).eq('org_id', SPACE).eq('user_id', 'x')).error.code, V2_UNSUPPORTED, '여러 열 한 번에는 없다');
  assert.deepEqual(froms(raw), []);
});

test('글: 고치기 → msgr2_message_edit, 지우기 → msgr2_message_delete, 다른 열은 v2_unsupported', async () => {
  const raw = fakeRaw(); const c = createV2Client(raw);
  await c.from('msgr_messages').update({ body: '고침', edited_at: '2026-10-23T00:00:00Z' }).eq('id', 7);
  await c.from('msgr_messages').update({ body: '', deleted_at: '2026-10-23T00:00:00Z' }).eq('id', 7);
  assert.deepEqual(rpcs(raw), [['msgr2_message_edit', { p_id: 7, p_body: '고침' }], ['msgr2_message_delete', { p_id: 7 }]]);
  assert.equal((await c.from('msgr_messages').update({ meta: {} }).eq('id', 7)).error.code, V2_UNSUPPORTED);
  assert.deepEqual(froms(raw), []);
});
