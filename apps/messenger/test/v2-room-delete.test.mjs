// 메신저 v2 대화(방) 삭제 호출 순서·거부 처리(src/v2/room-delete.mjs, 재공개 전 검수 b).
import test from 'node:test';
import assert from 'node:assert/strict';
import { deleteRoomV2, roomDeleteErrKey } from '../src/v2/room-delete.mjs';

const fake = ({ files = { ok: true, paths: [] }, del = { ok: true, messages: 1 }, remove } = {}) => {
  const calls = [];
  const rpc = async (name, args) => { calls.push([name, args]); return { data: name === 'msgr2_room_delete_files' ? files : del, error: null }; };
  const bucket = { remove: async (p) => { calls.push(['remove', p]); return remove ? remove(p) : { data: p.map((name) => ({ name })), error: null }; } };
  return { rpc, bucket, calls };
};

test('파일 목록 → Storage remove → 방 삭제 순서로 부른다(방 행이 남아 있을 때 파일을 지운다)', async () => {
  const f = fake({ files: { ok: true, paths: ['s/r/1/0-a.txt', 's/r/w/out.txt'] } });
  assert.deepEqual(await deleteRoomV2(f.rpc, f.bucket, 'r'), { ok: true, filesLeft: 0 });
  assert.deepEqual(f.calls.map((c) => c[0]), ['msgr2_room_delete_files', 'remove', 'msgr2_room_delete']);
  assert.deepEqual(f.calls[0][1], { p_room: 'r' });
  assert.deepEqual(f.calls[1][1], ['s/r/1/0-a.txt', 's/r/w/out.txt']);
});

test('지울 수 없으면(서버 거부) 파일도 방도 건드리지 않는다', async () => {
  for (const code of ['forbidden', 'work_active', 'migration']) {
    const f = fake({ files: { ok: false, code } });
    assert.deepEqual(await deleteRoomV2(f.rpc, f.bucket, 'r'), { code });
    assert.deepEqual(f.calls.map((c) => c[0]), ['msgr2_room_delete_files'], code);
  }
});

test('파일 지우기가 실패하거나 일부만 지워져도 방 삭제는 진행하고 남은 수를 돌려준다', async () => {
  const paths = Array.from({ length: 150 }, (_, i) => `s/r/${i}/0-a`);
  const f = fake({ files: { ok: true, paths }, remove: (p) => (p.length === 100 ? { data: p.slice(0, 90), error: null } : { data: null, error: { message: 'x' } }) });
  assert.deepEqual(await deleteRoomV2(f.rpc, f.bucket, 'r'), { ok: true, filesLeft: 60 });
  assert.deepEqual(f.calls.filter((c) => c[0] === 'remove').map((c) => c[1].length), [100, 50], '100개씩 나눠 보낸다');
  const g = fake({ files: { ok: true, paths: ['a'] }, remove: () => { throw new Error('net'); } });
  assert.deepEqual(await deleteRoomV2(g.rpc, g.bucket, 'r'), { ok: true, filesLeft: 1 });
});

test('방 삭제가 마지막에 거부되면(그 사이 일이 시작됨 등) 코드를 돌려준다, 호출 오류는 error로', async () => {
  const f = fake({ del: { ok: false, code: 'work_active' } });
  assert.deepEqual(await deleteRoomV2(f.rpc, f.bucket, 'r'), { code: 'work_active' });
  const e = { message: 'boom' };
  const g = { rpc: async () => ({ data: null, error: e }), bucket: { remove: async () => ({}) } };
  assert.deepEqual(await deleteRoomV2(g.rpc, g.bucket, 'r'), { error: e });
});

test('거부 코드 → 문구 키', () => {
  assert.equal(roomDeleteErrKey('forbidden'), 'ch.noEdit');
  assert.equal(roomDeleteErrKey('work_active'), 'room.delete.workActive');
  assert.equal(roomDeleteErrKey('migration'), 'room.delete.migration');
  assert.equal(roomDeleteErrKey('zzz'), 'err.generic');
});
