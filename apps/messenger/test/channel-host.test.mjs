import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from '@babel/parser';
import { channelManage, hostChannelIds, memoryToggle } from '../src/channel-host.mjs';

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

// ── 폰 설정 > 에이전트 기억 카드의 한 줄 ──────────────────────────────────────────────────────────────
// 미참여라서 막힌 줄은 채널 시트와 같게 '참여하면 바꿀 수 있음'(검수 #898 L1) — '채널 관리자만'이라고 하면 만든 사람은 왜 막혔는지 알 수 없다.
test('memoryToggle — 참여 중인 생성자·채널 관리자(hostIds)와 조직 관리자는 켜고 끌 수 있다', () => {
  const ch = pub({ id: 'mine', created_by: ME });
  assert.deepEqual(memoryToggle({ channel: ch, uid: ME, isAdmin: false, hostIds: new Set(['mine']) }), { can: true, hintKey: null });
  assert.deepEqual(memoryToggle({ channel: pub({ id: 'x' }), uid: ME, isAdmin: true, hostIds: new Set() }), { can: true, hintKey: null });
});

test('memoryToggle — 만들었거나 관리자인데 참여하지 않은 채널은 막고, 이유는 참여(needJoin)', () => {
  for (const ch of [pub({ id: 'legacy-mine', created_by: ME }), pub({ id: 'legacy-admin', admin_user_ids: [ME] })]) {
    assert.deepEqual(memoryToggle({ channel: ch, uid: ME, isAdmin: false, hostIds: new Set() }), { can: false, hintKey: 'phone.set.chMemory.needJoin' });
  }
});

test('memoryToggle — 생성자도 관리자도 아니면 hostOnly, 조직 정책으로 고정이면 누구든 lockedShort(참여 안내보다 먼저)', () => {
  assert.deepEqual(memoryToggle({ channel: pub({ id: 'plain' }), uid: ME, isAdmin: false, hostIds: new Set() }), { can: false, hintKey: 'phone.set.chMemory.hostOnly' });
  assert.deepEqual(memoryToggle({ channel: pub({ id: 'plain' }), uid: ME, isAdmin: false, hostIds: undefined }), { can: false, hintKey: 'phone.set.chMemory.hostOnly' }, 'hostIds가 없어도 던지지 않는다');
  const locked = { locked: true, hostIds: new Set(['mine']) };
  assert.deepEqual(memoryToggle({ channel: pub({ id: 'mine', created_by: ME }), uid: ME, isAdmin: false, ...locked }), { can: false, hintKey: 'phone.set.chMemory.lockedShort' });
  assert.deepEqual(memoryToggle({ channel: pub({ id: 'legacy-mine', created_by: ME }), uid: ME, isAdmin: true, ...locked }), { can: false, hintKey: 'phone.set.chMemory.lockedShort' });
});

// ── App이 자식에게 실제로 넘기는 값 ─────────────────────────────────────────────────────────────────────
// 판정은 위 순수 함수 한 곳에서 한다. 문제는 App(Shell)이 그 함수에 무엇을 먹이고 자식에게 무엇을 넘기느냐다 — 단언 문자열은 그대로 두고 뒤에서
// joined를 덮어쓰는 변이는 소스 문자열 단언이 못 잡는다(검수 #898 L2). Shell은 effect가 돌아야 자라서 노드에서 그릴 수 없으므로,
// App.jsx를 파싱해 **자식에게 넘기는 prop의 식과 그 식이 기대는 선언을 소스 그대로 꺼내 실제 입력으로 실행**해 값을 본다.
//   - prop이 둘이거나(뒤의 것이 이긴다) 전개(...)가 섞이면 그 자체로 실패 — 값을 한 곳에서만 정한다.
//   - 식이 기대는 이름이 입력에 없으면 ReferenceError로 시끄럽게 실패한다(고친 사람이 이 시험을 같이 고치게).
// 화면까지 닿는지는 test/channel-host.fixture.html(미참여 공개 채널 미리보기)이 맡는다.
const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const ast = parse(app, { sourceType: 'module', plugins: ['jsx'] });
const nodes = [];
(function walk(n) { if (!n || typeof n !== 'object') return; if (Array.isArray(n)) return n.forEach(walk); if (typeof n.type === 'string') nodes.push(n); for (const k of Object.keys(n)) if (k !== 'loc') walk(n[k]); })(ast.program);
const code = (n) => app.slice(n.start, n.end);
const elements = (name) => nodes.filter((n) => n.type === 'JSXOpeningElement' && n.name.type === 'JSXIdentifier' && n.name.name === name);
const declared = (name) => { const d = nodes.filter((n) => n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && n.id.name === name); assert.equal(d.length, 1, `${name} 선언이 정확히 하나`); return code(d[0].init); };
const propExpr = (el, name) => {
  assert.equal(el.attributes.filter((a) => a.type === 'JSXSpreadAttribute').length, 0, `<${el.name.name}>에 전개 prop이 섞이면 ${name}을 덮어쓸 수 있다`);
  const hit = el.attributes.filter((a) => a.name?.name === name);
  assert.equal(hit.length, 1, `<${el.name.name} ${name}>은 정확히 하나`);
  return code(hit[0].value.expression);
};
const observe = (decls, expr, scope) => new Function(...Object.keys(scope), `${decls.map((d) => `const ${d} = ${declared(d)};`).join('\n')}\nreturn (${expr});`)(...Object.values(scope));
const sheetJoined = (scope) => observe(['joinedChannel', 'previewing'], propExpr(elements('ChannelSheet')[0], 'joined'), { orgId: 'o1', loadedOrg: { current: 'o1' }, chId: null, isPersonal: false, previewChannels: [], ...scope });
const passedHosts = (el, prop, scope) => observe(['inviteChannels', 'hostChannels'], propExpr(el, prop), { useMemo: (f) => f(), hostChannelIds, uid: ME, ...scope });

const legacyMine = pub({ id: 'legacy-mine', created_by: ME });
const legacyAdmin = pub({ id: 'legacy-admin', admin_user_ids: [ME] });
const general = pub({ id: 'general', created_by: ME });
const adminJoined = { id: 'admin-joined', kind: 'private', created_by: OTHER, admin_user_ids: [ME] };
const plain = pub({ id: 'plain' });

test('ChannelSheet이 실제로 받는 joined — 미리보기(미참여) 채널은 false, 그 값으로 생성자의 canEdit도 false', () => {
  assert.equal(elements('ChannelSheet').length, 1, 'ChannelSheet 사용처가 하나');
  const joined = sheetJoined({ channels: [], previewChannels: [legacyMine], chId: legacyMine.id });
  assert.equal(joined, false);
  assert.equal(channelManage({ channel: legacyMine, uid: ME, isAdmin: false, joined }).canEdit, false);
});

test('ChannelSheet이 실제로 받는 joined — 참여 중인 채널·개인 공간 채널은 true라 생성자의 canEdit이 그대로다', () => {
  const joined = sheetJoined({ channels: [general], chId: general.id });
  assert.equal(joined, true);
  assert.equal(channelManage({ channel: general, uid: ME, isAdmin: false, joined }).canEdit, true);
  const personal = { id: 'pg', kind: 'dm', created_by: ME, admin_user_ids: [] };
  assert.equal(sheetJoined({ channels: [personal], chId: personal.id, isPersonal: true }), true, '개인 공간은 미리보기가 없다');
});

test('ChannelSheet — joined 기본값은 false(안 넘기면 막는 쪽)이고 판정은 channelManage 한 곳', () => {
  assert.match(app, /function ChannelSheet\(\{ channel, joined = false, /);
  assert.match(app, /const \{ canEdit, canAssignAdmins, needsJoin \} = channelManage\(\{ channel, uid, isAdmin, joined \}\)/);
});

test('Settings(기억 카드)·InviteDialog(hostOf)가 실제로 받는 집합 — 미리보기 채널의 생성자·채널 관리자는 없다', () => {
  const scope = { channels: [general, adminJoined, plain], previewChannels: [legacyMine, legacyAdmin] };
  for (const [name, prop] of [['Settings', 'hostIds'], ['InviteDialog', 'hostOf']]) {
    assert.equal(elements(name).length, 1, `${name} 사용처가 하나`);
    assert.deepEqual([...passedHosts(elements(name)[0], prop, scope)].sort(), ['admin-joined', 'general'], `${name} ${prop}`);
  }
});

test('기억 카드 — 받은 hostIds·uid를 그대로 판정에 쓰므로, 미참여 생성자 줄은 막히고 이유가 참여다', () => {
  const [card] = elements('MemoryChannelsCard');
  assert.equal(propExpr(card, 'hostIds'), 'hostIds');
  assert.equal(propExpr(card, 'uid'), 'uid');
  assert.match(app, /memoryToggle\(\{ channel: c, uid, isAdmin, hostIds, locked \}\)/);
  const hostIds = passedHosts(elements('Settings')[0], 'hostIds', { channels: [general], previewChannels: [legacyMine] });
  assert.deepEqual(memoryToggle({ channel: legacyMine, uid: ME, isAdmin: false, hostIds }), { can: false, hintKey: 'phone.set.chMemory.needJoin' });
  assert.deepEqual(memoryToggle({ channel: general, uid: ME, isAdmin: false, hostIds }), { can: true, hintKey: null });
});

test('App.jsx — 생성자·채널 관리자 판정 식이 따로 남아 있지 않다(복사본이 서버와 어긋난 것이 H44의 원인)', () => {
  assert.doesNotMatch(app, /created_by === uid \|\| \(c\.admin_user_ids \?\? \[\]\)\.includes\(uid\)/);
  assert.doesNotMatch(app, /channel\.created_by === uid \|\| chAdmins\.includes\(uid\)/);
});
