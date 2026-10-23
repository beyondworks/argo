// 확인 창·완료 안내의 방 제목(src/v2/room-title.mjs) — 목록 제목과 같게(재공개 전 마지막 재검수).
import test from 'node:test';
import assert from 'node:assert/strict';
import { actionRoomName } from '../src/v2/room-title.mjs';

const dmName = () => '민지';
test('v2: 이름 붙은 여러 명 방은 방 이름, 이름 없는 방(1:1)은 상대 이름, 채널은 채널 이름', () => {
  assert.equal(actionRoomName({ kind: 'dm', name: '주말 모임' }, { v2: true, dmName }), '주말 모임');
  assert.equal(actionRoomName({ kind: 'dm', name: '' }, { v2: true, dmName }), '민지');
  assert.equal(actionRoomName({ kind: 'dm', name: null }, { v2: true, dmName }), '민지');
  assert.equal(actionRoomName({ kind: 'dm', name: 'dm:  ' }, { v2: true, dmName }), '민지');
  assert.equal(actionRoomName({ kind: 'private', name: '기획' }, { v2: true, dmName }), '기획');
  assert.equal(actionRoomName({ kind: 'public', name: '일반' }, { v2: false, dmName }), '일반');
});
test('v1은 종전대로 1:1·그룹 모두 dmName(옛 그룹 이름은 dm: 자동 이름)', () => {
  assert.equal(actionRoomName({ kind: 'dm', name: 'dm:abc' }, { v2: false, dmName }), '민지');
  assert.equal(actionRoomName({ kind: 'dm', name: '주말 모임' }, { v2: false, dmName }), '민지');
});
