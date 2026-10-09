import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { channelManage, hostChannelIds } from '../src/channel-host.mjs';

// 채널을 관리할 수 있는가 — 서버 msgr_can_manage_channel·msgr_is_channel_host(20261006160000_msgr_security_fixes.sql 2절)와 같은 규칙:
//   조직 관리자 || ((채널 생성자 || 채널 관리자) && 지금 그 채널에 참여 중).
// 9/16 전에 만든 공개 채널의 생성자는 한 번도 참여하지 않았을 수 있다 — 미리보기로 열면 설정 단추가 보이지만 저장은 서버가 거절했다(점검 H44).
const ME = 'user-me';
const OTHER = 'user-other';
const pub = (extra = {}) => ({ id: 'ch', kind: 'public', created_by: OTHER, admin_user_ids: [], ...extra });

test('미리보기(미참여) 공개 채널의 생성자는 설정을 바꿀 수 없다', () => {
  const m = channelManage({ channel: pub({ created_by: ME }), uid: ME, isAdmin: false, joined: false });
  assert.equal(m.canEdit, false);
  assert.equal(m.canAssignAdmins, false);
});

test('참여 중인 생성자는 설정을 바꾸고 채널 관리자를 지정할 수 있다', () => {
  const m = channelManage({ channel: pub({ created_by: ME }), uid: ME, isAdmin: false, joined: true });
  assert.equal(m.canEdit, true);
  assert.equal(m.canAssignAdmins, true);
});

test('조직 관리자는 참여하지 않아도 설정을 바꾸고 채널 관리자를 지정할 수 있다', () => {
  const m = channelManage({ channel: pub(), uid: ME, isAdmin: true, joined: false });
  assert.equal(m.canEdit, true);
  assert.equal(m.canAssignAdmins, true);
});

test('채널 관리자는 참여 중일 때만 설정을 바꾼다 — 관리자 지정은 어느 쪽이든 못 한다(자기 증식 방지)', () => {
  const ch = pub({ admin_user_ids: [ME] });
  assert.equal(channelManage({ channel: ch, uid: ME, isAdmin: false, joined: false }).canEdit, false);
  const joined = channelManage({ channel: ch, uid: ME, isAdmin: false, joined: true });
  assert.equal(joined.canEdit, true);
  assert.equal(joined.canAssignAdmins, false);
});

test('게스트(조직 관리자도 생성자도 채널 관리자도 아닌 사람)는 참여 중이어도 설정을 바꿀 수 없다', () => {
  const priv = { id: 'p', kind: 'private', created_by: OTHER, admin_user_ids: [OTHER] };
  for (const joined of [true, false]) {
    const m = channelManage({ channel: priv, uid: ME, isAdmin: false, joined });
    assert.equal(m.canEdit, false);
    assert.equal(m.canAssignAdmins, false);
  }
});

test('uid가 아직 없을 때 created_by 없는 채널이 서로 같다고 보지 않는다', () => {
  for (const uid of [null, undefined, '']) {
    const m = channelManage({ channel: pub({ created_by: uid ?? null, admin_user_ids: [] }), uid, isAdmin: false, joined: true });
    assert.equal(m.canEdit, false);
  }
});

test('1:1(dm)에서는 조직 관리자라도 관리자 지정이 없다', () => {
  const dm = { id: 'd', kind: 'dm', created_by: ME, admin_user_ids: [] };
  assert.equal(channelManage({ channel: dm, uid: ME, isAdmin: true, joined: true }).canAssignAdmins, false);
});

test('참여하면 풀리는 경우만 needsJoin — 안내 문구를 가른다', () => {
  const mine = pub({ created_by: ME });
  assert.equal(channelManage({ channel: mine, uid: ME, isAdmin: false, joined: false }).needsJoin, true);
  assert.equal(channelManage({ channel: mine, uid: ME, isAdmin: false, joined: true }).needsJoin, false);
  assert.equal(channelManage({ channel: pub(), uid: ME, isAdmin: false, joined: false }).needsJoin, false, '생성자도 관리자도 아니면 참여해도 풀리지 않는다');
  assert.equal(channelManage({ channel: mine, uid: ME, isAdmin: true, joined: false }).needsJoin, false, '조직 관리자는 이미 편집할 수 있다');
});

test('hostChannelIds — 참여 중인 채널 목록에서 내가 만들었거나 관리자인 채널만, 1:1은 뺀다', () => {
  const channels = [
    { id: 'made', kind: 'public', created_by: ME, admin_user_ids: [] },
    { id: 'admin', kind: 'private', created_by: OTHER, admin_user_ids: [ME] },
    { id: 'plain', kind: 'public', created_by: OTHER, admin_user_ids: [] },
    { id: 'dm', kind: 'dm', created_by: ME, admin_user_ids: [] },
  ];
  assert.deepEqual([...hostChannelIds({ channels, uid: ME })].sort(), ['admin', 'made']);
  assert.equal(hostChannelIds({ channels, uid: null }).size, 0);
  assert.equal(hostChannelIds({ channels: undefined, uid: ME }).size, 0);
});

// 화면 연결 — 판정은 위 순수 함수 한 곳에서만 한다. 같은 식을 App.jsx에 다시 쓰면(복사본이 서버와 어긋나는 것이 H44의 원인) 여기서 걸린다.
// 소스 문자열 단언이라 동작 게이트는 아니다 — 동작은 위 함수 시험과 test/channel-host.fixture.html 화면 확인(미참여 생성자 미리보기)이 맡는다.
const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');

test('App.jsx — 생성자·채널 관리자 판정 식이 따로 남아 있지 않다', () => {
  assert.doesNotMatch(app, /created_by === uid \|\| \(c\.admin_user_ids \?\? \[\]\)\.includes\(uid\)/, '채널 줄 메뉴·기억 카드·초대 창 판정은 hostChannels(hostChannelIds) 하나로');
  assert.doesNotMatch(app, /channel\.created_by === uid \|\| chAdmins\.includes\(uid\)/, '채널 시트 판정은 channelManage 하나로');
});

test('App.jsx — hostChannels는 참여 중인 채널(channels)에서만 센다, 미리보기(previewChannels)는 넣지 않는다', () => {
  assert.match(app, /const hostChannels = useMemo\(\(\) => hostChannelIds\(\{ channels, uid \}\), \[channels, uid\]\)/);
});

test('App.jsx — 채널 시트는 미리보기 채널일 때 joined=false로 연다', () => {
  assert.match(app, /<ChannelSheet joined=\{!previewing\} /);
  assert.match(app, /channelManage\(\{ channel, uid, isAdmin, joined \}\)/);
});

test('App.jsx — 기억 카드·채널 줄 메뉴도 같은 집합(hostChannels)을 쓴다', () => {
  assert.match(app, /const canManage = !!isAdmin \|\| hostChannels\.has\(c\.id\)/);
  assert.match(app, /hostIds=\{hostChannels\} onToggleMemory=\{toggleMemory\}/);
  assert.match(app, /const can = !locked && \(isAdmin \|\| hostIds\.has\(c\.id\)\)/);
});
