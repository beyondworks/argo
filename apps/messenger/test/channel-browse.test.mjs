// 점검 A·B #2 — 폰에서 참여한 채널이 없는 멤버가 공개 채널을 찾을 길이 없던 결함.
//  - 조직 1:1(kind dm)을 채널로 세어 "둘러보기" 안내가 숨던 것 → 채널(kind≠dm)만 센다
//  - 검색이 참여 전 공개 채널(previewChannels)을 빼던 것 → 포함한다
import test from 'node:test';
import assert from 'node:assert/strict';
import { hasChannelRows, browseHintVisible, searchChannelsByName, channelSearchPool } from '../src/channel-browse.mjs';

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
