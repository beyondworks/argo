// 점검 A·B #2 — 폰에서 참여한 채널이 없는 멤버가 공개 채널을 찾을 길이 없던 결함.
//  - 조직 1:1(kind dm)을 채널로 세어 "둘러보기" 안내가 숨던 것 → 채널(kind≠dm)만 센다
//  - 검색이 참여 전 공개 채널(previewChannels)을 빼던 것 → 포함한다
import test from 'node:test';
import assert from 'node:assert/strict';
import { hasChannelRows, browseHintVisible, searchChannelsByName, channelSearchPool, addableToChannel } from '../src/channel-browse.mjs';

const dm = { id: 'd1', kind: 'dm', name: 'dm:x' };
const pub = { id: 'p1', kind: 'public', name: 'general' };
const priv = { id: 'p2', kind: 'private', name: 'secret' };

test('1:1만 있으면 채널은 0개 — 조직 1:1이 둘러보기 안내를 숨기지 않는다', () => {
  assert.equal(hasChannelRows([dm]), false);
  assert.equal(hasChannelRows([]), false);
  assert.equal(hasChannelRows([dm, pub]), true);
  assert.equal(hasChannelRows([priv]), true);
});

test('둘러보기 안내: 조직이 있고 참여한 채널이 없고 참여할 수 있는 공개 채널이 있을 때', () => {
  assert.equal(browseHintVisible({ org: { id: 'o' }, channels: [dm], previewChannels: [pub] }), true);
  assert.equal(browseHintVisible({ org: { id: 'o' }, channels: [pub], previewChannels: [pub] }), false, '이미 채널이 있다');
  assert.equal(browseHintVisible({ org: { id: 'o' }, channels: [dm], previewChannels: [] }), false, '들어갈 곳이 없다');
  assert.equal(browseHintVisible({ org: null, channels: [], previewChannels: [pub] }), false, '조직 없음');
});

test('검색 대상 = 참여한 채널 + 참여 전 공개 채널, 1:1은 제외', () => {
  const pool = channelSearchPool([dm, priv], [pub]);
  assert.deepEqual(pool.map((c) => c.id), ['p2', 'p1']);
});

test('채널 이름 검색은 참여 전 공개 채널도 찾는다 — 대소문자 무시', () => {
  assert.deepEqual(searchChannelsByName([dm], [pub], 'GENERAL').map((c) => c.id), ['p1']);
  assert.deepEqual(searchChannelsByName([priv], [pub], 'e').map((c) => c.id).sort(), ['p1', 'p2']);
  assert.deepEqual(searchChannelsByName([dm], [pub], 'x'), []);
});

test('사람 추가 후보 — 공개 채널은 게스트·내보낸 사람을 빼고, 비공개·개인 방은 그대로(서버 20261006160000과 같은 역할 목록)', () => {
  const guest = { user_id: 'g', role: 'guest' }, member = { user_id: 'm', role: 'member' }, admin = { user_id: 'a', role: 'admin' }, owner = { user_id: 'o', role: 'owner' };
  for (const m of [member, admin, owner]) assert.equal(addableToChannel(pub, m), true, `공개 채널 ${m.role}`);
  assert.equal(addableToChannel(pub, guest), false, '공개 채널 게스트는 후보가 아니다');
  assert.equal(addableToChannel(pub, member, ['m']), false, '공개 채널에서 내보낸 사람');
  assert.equal(addableToChannel(priv, guest), true, '비공개 채널은 게스트를 초대할 수 있다');
  assert.equal(addableToChannel(priv, member, ['m']), true, '비공개 채널은 제외 목록을 보지 않는다(종전과 같다)');
  assert.equal(addableToChannel(dm, { user_id: 'f' }), true, '개인 방 친구(역할 없음)');
});
