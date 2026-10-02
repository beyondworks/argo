// 폰 셸 v2(유건 확정 2026-10-01: 친구 / 채팅 / 채널 / 에이전트 / 기억) — 탭 뱃지 합계·탭별 공간·채팅 칩 분류·줄 정보 계산의 행동 고정.
// 화면 배선은 App.jsx, 판단은 src/phone-shell.mjs 한 곳에서만 한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PHONE_TABS, isPhoneRoot, spaceForTab, pickChannelOrg, startTab, tabBadges, badgeText,
  roomTraits, chatVisible, chatUnreadTotal, roomRow, sortRooms, tabSearch,
  orgMenuItems, savedOrgAfter, withoutHidden, hiddenGroups, settingsOrgRows, orgScreen,
} from '../src/phone-shell.mjs';

const P = '__personal__';

test('아래 탭은 친구·채팅·채널·에이전트·기억 다섯 개이고 알림함은 없다', () => {
  assert.deepEqual(PHONE_TABS, ['friends', 'chats', 'channels', 'agents', 'memory']);
  assert.equal(isPhoneRoot('inbox'), false);
  assert.equal(isPhoneRoot('home'), false);
  assert.equal(isPhoneRoot('chat'), false, '대화방은 탭 위에 여는 화면');
  for (const t of PHONE_TABS) assert.equal(isPhoneRoot(t), true);
});

test('탭별 공간 — 채팅은 개인 공간, 채널·기억은 고른 조직, 친구·에이전트는 지금 공간 그대로', () => {
  assert.equal(spaceForTab('chats', { personal: P, chOrg: 'o1' }), P);
  assert.equal(spaceForTab('channels', { personal: P, chOrg: 'o1' }), 'o1');
  assert.equal(spaceForTab('memory', { personal: P, chOrg: 'o1' }), 'o1');
  assert.equal(spaceForTab('channels', { personal: P, chOrg: null }), null, '조직이 없으면 공간을 바꾸지 않는다(빈 안내)');
  assert.equal(spaceForTab('friends', { personal: P, chOrg: 'o1' }), null);
  assert.equal(spaceForTab('agents', { personal: P, chOrg: 'o1' }), null);
});

test('채널 탭 조직 — 고른 적 있는 조직이 아직 있으면 그것, 없으면 마지막 조직, 없으면 첫 조직', () => {
  assert.equal(pickChannelOrg({ saved: 'o2', last: 'o1', orgIds: ['o1', 'o2'] }), 'o2');
  assert.equal(pickChannelOrg({ saved: 'gone', last: 'o1', orgIds: ['o1', 'o2'] }), 'o1');
  assert.equal(pickChannelOrg({ saved: null, last: P, orgIds: ['o3', 'o2'] }), 'o3', '마지막 공간이 개인이면 첫 조직');
  assert.equal(pickChannelOrg({ saved: 'o1', last: 'o1', orgIds: [] }), null);
});

test('처음 여는 탭 — 마지막 공간이 조직이면 채널, 개인이거나 처음이면 채팅', () => {
  assert.equal(startTab({ last: 'o1', personal: P, orgIds: ['o1'] }), 'channels');
  assert.equal(startTab({ last: P, personal: P, orgIds: ['o1'] }), 'chats');
  assert.equal(startTab({ last: null, personal: P, orgIds: [] }), 'chats');
  assert.equal(startTab({ last: 'o-gone', personal: P, orgIds: ['o1'] }), 'chats', '없어진 조직이면 채팅');
});

test('탭 뱃지 — 채팅 = 개인 공간, 채널 = 모든 조직 합, 에이전트 = 결재 대기, 친구 = 받은 요청', () => {
  const totals = { personal: { n: 3, mention: 0 }, o1: { n: 5, mention: 1 }, o2: { n: 7, mention: 0 }, oX: { n: 99, mention: 0 } };
  // 보고 있는 공간(o1)은 채널별 최신 셈(here)을 쓴다 — 서버 합계보다 최신
  const b = tabBadges({ hereKey: 'o1', here: { n: 2, mention: 0 }, hereReady: true, totals, orgIds: ['o1', 'o2'], approvals: 4, friendRequests: 1 });
  assert.deepEqual(b, { friends: 1, chats: 3, channels: 9, agents: 4, memory: 0 }, '목록에 없는 조직(oX)은 더하지 않는다');
  // 보고 있는 공간이 개인이면 채팅 뱃지가 here
  assert.equal(tabBadges({ hereKey: 'personal', here: { n: 6 }, hereReady: true, totals, orgIds: ['o1'] }).chats, 6);
  // 공간을 막 바꿔 채널별 셈이 아직 없으면(hereReady false) 서버 합계로 — 숫자가 0으로 깜빡이지 않게
  assert.equal(tabBadges({ hereKey: 'personal', here: { n: 0 }, hereReady: false, totals, orgIds: ['o1'] }).chats, 3);
  assert.deepEqual(tabBadges({}), { friends: 0, chats: 0, channels: 0, agents: 0, memory: 0 });
});

test('뱃지 글자 — 0이면 그리지 않고 100부터 99+', () => {
  assert.equal(badgeText(0), '');
  assert.equal(badgeText(-1), '');
  assert.equal(badgeText(1), '1');
  assert.equal(badgeText(99), '99');
  assert.equal(badgeText(100), '99+');
});

test('방 성격 — 그룹·에이전트 방 판정(남의 에이전트 1:1은 주인이 함께 있어도 그룹이 아니다)', () => {
  const me = 'u-me';
  const m = (kind, id) => ({ member_kind: kind, member_id: id });
  assert.deepEqual(roomTraits({ c: {}, members: [m('user', me), m('user', 'a')], uid: me }), { group: false, agent: false, size: 2 });
  assert.deepEqual(roomTraits({ c: {}, members: [m('user', me), m('user', 'a'), m('user', 'b')], uid: me }), { group: true, agent: false, size: 3 });
  assert.deepEqual(roomTraits({ c: {}, members: [m('user', me), m('crew', 'k')], uid: me }), { group: false, agent: true, size: 2 });
  assert.deepEqual(roomTraits({ c: {}, members: [m('user', me), m('user', 'a'), m('crew', 'k')], uid: me, ownerOf: (id) => (id === 'k' ? 'a' : null) }), { group: false, agent: true, size: 3 }, '남의 에이전트 1:1(주인 동반)');
  assert.deepEqual(roomTraits({ c: {}, members: [m('user', me), m('user', 'a'), m('crew', 'k')], uid: me, ownerOf: () => me }), { group: true, agent: true, size: 3 });
  assert.equal(roomTraits({ c: { _personal_group: true }, members: [m('user', me), m('user', 'a')], uid: me }).group, true, '개인 그룹방은 한 명만 남아도 그룹');
  assert.equal(roomTraits({ c: { _personal_crew: 'k' }, members: [m('user', me)], uid: me }).agent, true, '개인 에이전트 1:1');
});

test('채팅 칩 — 전체 / 안읽음(알림 끈 방 제외) / 에이전트 / 그룹', () => {
  const r = (o) => ({ unreadN: 0, muted: false, group: false, agent: false, ...o });
  assert.equal(chatVisible('all', r({})), true);
  assert.equal(chatVisible('unread', r({ unreadN: 2 })), true);
  assert.equal(chatVisible('unread', r({ unreadN: 2, muted: true })), false);
  assert.equal(chatVisible('unread', r({})), false);
  assert.equal(chatVisible('agent', r({ agent: true })), true);
  assert.equal(chatVisible('agent', r({})), false);
  assert.equal(chatVisible('group', r({ group: true })), true);
  assert.equal(chatVisible('nope', r({})), true, '모르는 칩은 전체');
  assert.equal(chatUnreadTotal([{ id: 'a' }, { id: 'b' }, { id: 'c' }], { a: { n: 2 }, b: { n: 5 }, z: { n: 9 } }, new Set(['b'])), 2, '안읽음 칩 숫자 = 목록에 있는 방의 안 읽은 글 수(알림 끈 방 제외)');
});

test('줄 정보 — 마지막 글·시각·안 읽음·@·고정·알림 끔, 개인 방은 목록 조회 값으로 시작', () => {
  const c = { id: 'c1', _personal_last_at: '2026-10-01T03:00:00Z', _personal_last_body: '**안녕** 하세요\n\n두 번째 줄' };
  const a = roomRow({ c, unread: { n: 3, mention: 1 }, muted: false, pinned: true });
  assert.equal(a.at, Date.parse('2026-10-01T03:00:00Z'));
  assert.equal(a.preview, '안녕 하세요 두 번째 줄', '마크다운을 벗기고 한 줄로(두 줄은 CSS가 자른다)');
  assert.deepEqual([a.unreadN, a.mention, a.pinned, a.muted], [3, true, true, false]);
  // 실시간으로 받은 마지막 글이 더 새것이면 그것
  const b = roomRow({ c, lastMsg: { body: '새 글', at: Date.parse('2026-10-01T04:00:00Z'), mine: true }, unread: {} });
  assert.equal(b.preview, '새 글'); assert.equal(b.mine, true); assert.equal(b.at, Date.parse('2026-10-01T04:00:00Z'));
  // 실시간 글이 더 오래됐으면(늦게 온 응답) 목록 조회 값
  const d = roomRow({ c, lastMsg: { body: '옛 글', at: Date.parse('2026-09-30T00:00:00Z') } });
  assert.equal(d.preview, '안녕 하세요 두 번째 줄');
  // 아무것도 없으면 빈 미리보기, 시각 0
  assert.deepEqual([roomRow({ c: { id: 'x' } }).preview, roomRow({ c: { id: 'x' } }).at], ['', 0]);
  assert.equal(roomRow({ c: { id: 'x' }, lastAt: 5 }).at, 5, '방송으로 받은 시각만 있어도 정렬에 쓴다');
});

test('채팅 정렬 — 고정한 방이 위(고정 순서), 나머지는 최근 글 순', () => {
  const list = [{ id: 'a', name: 'a' }, { id: 'b', name: 'b' }, { id: 'c', name: 'c' }, { id: 'd', name: 'd' }];
  const at = { a: 10, b: 40, c: 30, d: 20 };
  const out = sortRooms(list, { atOf: (c) => at[c.id], pinned: new Set(['d', 'a']), pinPos: new Map([['d', 0], ['a', 1]]), nameOf: (c) => c.name });
  assert.deepEqual(out.map((c) => c.id), ['d', 'a', 'b', 'c']);
  const unreadFirst = sortRooms(list, { sort: 'unread', atOf: (c) => at[c.id], unread: { c: { n: 1 } }, nameOf: (c) => c.name });
  assert.deepEqual(unreadFirst.map((c) => c.id), ['c', 'b', 'd', 'a']);
});

test('탭 안 검색 — 이름·본문에서 대소문자 없이 찾는다, 빈 검색어는 전부', () => {
  const items = [{ id: 1, name: 'Marketing', text: '캠페인 일정' }, { id: 2, name: '서윤', text: '' }, { id: 3, name: 'general', text: 'Launch plan' }];
  const fields = (x) => [x.name, x.text];
  assert.deepEqual(tabSearch(items, '', fields).map((x) => x.id), [1, 2, 3]);
  assert.deepEqual(tabSearch(items, 'market', fields).map((x) => x.id), [1]);
  assert.deepEqual(tabSearch(items, '  LAUNCH ', fields).map((x) => x.id), [3]);
  assert.deepEqual(tabSearch(items, '일정', fields).map((x) => x.id), [1]);
  assert.deepEqual(tabSearch(items, '없음', fields), []);
});

import { memoryGroups, memSnippet } from '../src/phone-shell.mjs';
test('기억 폴더 — 조직 전체(규칙·용어·프로젝트) / 채널별(문서 먼저, 일지는 최신이 위), 기본 최근순', () => {
  const d = (id, path, ch = null, at = '2026-10-01T00:00:00Z', title = path, body = '') => ({ id, path, channel_id: ch, updated_at: at, title, body });
  const docs = [d(1, 'rules/b.md', null, '2026-09-01', '보안 규칙'), d(2, 'rules/a.md', null, '2026-09-02', '가입 규칙'), d(3, 'glossary/x.md'), d(4, 'journal/2026-09-30.md', 'c1', '2026-09-30'), d(5, 'journal/2026-10-01.md', 'c1', '2026-10-01'), d(6, 'projects/p.md', 'c1', '2026-08-01', '캠페인'), d(7, 'journal/2026-09-29.md', 'c2', '2026-10-02')];
  const g = memoryGroups(docs, { channelLabel: (id) => `#${id}` }); // 기본 = 최근순
  assert.deepEqual(g.org.map((x) => [x.key, x.docs.map((y) => y.id)]), [['rules', [2, 1]], ['glossary', [3]]], '폴더 순서 고정, 안에서는 제목순, 빈 폴더(projects)는 없다');
  assert.deepEqual(g.channels.map((x) => [x.key, x.label, x.docs.map((y) => y.id)]), [['c2', '#c2', [7]], ['c1', '#c1', [6, 5, 4]]]);
  assert.equal(g.total, 7);
});
test('기억 검색 — 제목·본문에서 찾고, 발췌는 찾은 자리 앞뒤', () => {
  const docs = [{ id: 1, path: 'rules/a.md', channel_id: null, title: '휴가 규칙', body: '연차는 미리 알린다', updated_at: '' }, { id: 2, path: 'journal/2026-10-01.md', channel_id: 'c', title: '2026-10-01', body: '- 10:00 · **서윤** → 뉴스레터 초안을 보냈습니다', updated_at: '' }];
  assert.deepEqual(memoryGroups(docs, { query: '뉴스레터' }).channels.map((x) => x.docs.map((y) => y.id)), [[2]]);
  assert.equal(memoryGroups(docs, { query: '휴가' }).org[0].docs[0].id, 1);
  assert.equal(memoryGroups(docs, { query: '없는말' }).total, 0);
  assert.equal(memSnippet('- 10:00 · **서윤** → 뉴스레터 초안을 보냈습니다', '뉴스레터'), '10:00 · 서윤 → 뉴스레터 초안을 보냈습니다');
  const long = `${'가'.repeat(200)}목표${'나'.repeat(200)}`;
  const s = memSnippet(long, '목표', 40); assert.ok(s.includes('목표') && s.startsWith('…') && s.endsWith('…'), s);
  assert.equal(memSnippet('', 'x'), '');
});
test('기억 폴더 정렬 — 이름순(문서 제목·채널 이름) / 최근순(문서·채널 모두 최근에 바뀐 것이 위)', () => {
  const d = (id, path, ch, at, title) => ({ id, path, channel_id: ch, updated_at: at, title, body: '' });
  const docs = [d(1, 'rules/a.md', null, '2026-09-01', '가'), d(2, 'rules/b.md', null, '2026-09-05', '나'), d(3, 'projects/x.md', 'c-b', '2026-09-02', '나 문서'), d(4, 'projects/y.md', 'c-a', '2026-09-03', '가 문서'), d(5, 'projects/z.md', 'c-b', '2026-09-09', '다 문서')];
  const label = (id) => ({ 'c-a': '#가람', 'c-b': '#나래' })[id];
  const byName = memoryGroups(docs, { channelLabel: label, sort: 'name' });
  assert.deepEqual(byName.org[0].docs.map((x) => x.id), [1, 2]);
  assert.deepEqual(byName.channels.map((x) => x.key), ['c-a', 'c-b'], '채널 이름순');
  assert.deepEqual(byName.channels[1].docs.map((x) => x.id), [3, 5], '문서 제목순');
  const recent = memoryGroups(docs, { channelLabel: label, sort: 'recent' });
  assert.deepEqual(recent.org[0].docs.map((x) => x.id), [2, 1]);
  assert.deepEqual(recent.channels.map((x) => x.key), ['c-b', 'c-a'], '최근에 바뀐 채널이 위');
  assert.deepEqual(recent.channels[0].docs.map((x) => x.id), [5, 3]);
});

import { agentCardAction, orgCardStep, personalCardLocks } from '../src/phone-shell.mjs';
test('설정 > 내 에이전트 — 어떤 에이전트를 눌러도 카드가 열리거나 이유가 뜬다(아무 일도 없는 줄 0)', () => {
  const shapes = [
    { id: 'a', org_id: 'o1', hosting: 'local', status: 'active' },      // 조직 크루
    { id: 'b', org_id: 'o1', hosting: 'bot', status: 'active' },        // 조직 외부 에이전트
    { id: 'c', org_id: 'o1', hosting: 'local', status: 'available' },   // 꺼 둔 조직 크루
    { id: 'd', org_id: null, hosting: 'local', status: 'active' },      // 개인 크루
    { id: 'e', org_id: null, hosting: 'bot', status: 'active', paused: 'relink', ready: false }, // 개인 쪽 외부 에이전트(쌍둥이)
  ];
  for (const c of shapes) { const a = agentCardAction(c); assert.ok(['org-card', 'personal-card'].includes(a.do), `${c.id}: ${a.do}`); }
  assert.deepEqual(agentCardAction(shapes[0]), { do: 'org-card', space: 'o1' });
  assert.deepEqual(agentCardAction(shapes[3]), { do: 'personal-card' }, '개인 크루는 대화로 넘기지 않고 카드');
  assert.deepEqual(agentCardAction(null), { do: 'note', why: 'missing' });
  // 조직 카드: 공간을 바꾼 뒤 — 열 수 없으면 이유를 알린다(조용히 끝나지 않는다)
  assert.deepEqual(orgCardStep({ found: true, blocked: false }), { do: 'open' });
  assert.deepEqual(orgCardStep({ found: true, blocked: true }), { do: 'note', why: 'blocked' });
  assert.deepEqual(orgCardStep({ found: false, blocked: false }), { do: 'note', why: 'missing' });
  assert.deepEqual(orgCardStep({ timedOut: true }), { do: 'note', why: 'slow' });
});
test('개인 에이전트 카드 잠금 — 서버가 허용하는 것만 바꾼다(이름은 Argo 앱, 쌍둥이는 이름·직무·지시 범위가 조직을 따른다)', () => {
  assert.deepEqual(personalCardLocks({ hosting: 'local' }), { name: 'argo', role: null, allow: null, face: null, bio: null });
  assert.deepEqual(personalCardLocks({ hosting: 'bot' }), { name: 'twin', role: 'twin', allow: 'twin', face: null, bio: null });
});

// 3차 피드백(유건 2026-10-02): 기억 탭 조직 메뉴는 목적이 달라 채널 탭 메뉴와 나눈다 — 조직 고르기 + 기억 설정만.
test('조직 메뉴 항목 — 채널 탭은 그대로(참여·만들기·초대·조직 설정), 기억 탭은 내 조직 목록과 기억 설정뿐', () => {
  assert.deepEqual(orgMenuItems('channels', { admin: true }), ['orgs', 'joinable', 'deleted', 'join', 'invite', 'org-settings']);
  assert.deepEqual(orgMenuItems('channels', { admin: false }), ['orgs', 'joinable', 'deleted', 'join']);
  assert.deepEqual(orgMenuItems('memory', { admin: true }), ['orgs', 'memory-settings']);
  assert.deepEqual(orgMenuItems('memory', { admin: false }), ['orgs', 'memory-settings']);
});

test('고른 조직은 채널·기억 탭이 같이 쓴다 — 기억 탭에서 조직 B로 바꾸면 채널 탭도 B', () => {
  const ids = ['A', 'B'];
  let saved = 'A';
  saved = savedOrgAfter(saved, 'B', P); // 기억 탭 메뉴에서 B를 고름 → 공간이 B로 바뀜
  const chOrg = pickChannelOrg({ saved, last: 'A', orgIds: ids });
  assert.equal(spaceForTab('memory', { personal: P, chOrg }), 'B');
  assert.equal(spaceForTab('channels', { personal: P, chOrg }), 'B');
  assert.equal(savedOrgAfter('B', P, P), 'B'); // 채팅 탭(개인 공간)에 가도 고른 조직은 그대로
  assert.equal(savedOrgAfter('B', null, P), 'B');
});

// 4차 피드백(유건 2026-10-02) — 숨김 = 내 목록에서만 뺀다(친구 관계·대화·알림은 그대로). 차단은 따로.
test('숨김 판정 — 숨긴 친구는 친구 목록·새 채팅·초대 후보에서 빠지고, 다시 보이기 하면 돌아온다', () => {
  const friends = [{ user_id: 'u1', status: 'accepted' }, { user_id: 'u2', status: 'accepted' }, { user_id: 'u3', status: 'pending' }];
  assert.deepEqual(withoutHidden(friends, new Set(['u2'])).map((f) => f.user_id), ['u1', 'u3']);
  assert.deepEqual(withoutHidden(friends, new Set()).map((f) => f.user_id), ['u1', 'u2', 'u3']);
  assert.deepEqual(withoutHidden(friends, null).map((f) => f.user_id), ['u1', 'u2', 'u3'], '숨김을 아직 못 불러왔으면 그대로');
  const crews = [{ id: 'c1' }, { id: 'c2' }];
  assert.deepEqual(withoutHidden(crews, new Set(['c1']), (c) => c.id).map((c) => c.id), ['c2']);
});

test('숨김 탭 — 숨긴 친구(친구 행 이름 그대로)와 숨긴 에이전트를 한 목록에, 친구가 아닌 숨김 행은 보이지 않는다', () => {
  const friends = [{ user_id: 'u1', display_name: '민지', status: 'accepted' }, { user_id: 'u2', display_name: '도윤', status: 'accepted' }];
  const g = hiddenGroups({ friends, hiddenUserIds: new Set(['u2', 'gone']), mutedCrews: [{ crew_id: 'c1', display_name: '봇' }] });
  assert.deepEqual(g.friends.map((f) => f.display_name), ['도윤']);
  assert.deepEqual(g.agents.map((c) => c.crew_id), ['c1']);
  assert.deepEqual(hiddenGroups({ friends, hiddenUserIds: new Set(), mutedCrews: [] }), { friends: [], agents: [] });
});

test('설정 조직 줄 — 조직이 몇 개든 네 가지는 각각 한 줄(관리자 조직이 있어야 에이전트 연결·서버 연결)', () => {
  const two = [{ id: 'o1', role: 'owner' }, { id: 'o2', role: 'member' }];
  assert.deepEqual(settingsOrgRows(two), { org: true, ext: true, server: true, memory: true });
  assert.deepEqual(settingsOrgRows([{ id: 'o2', role: 'member' }]), { org: true, ext: false, server: false, memory: true });
  assert.deepEqual(settingsOrgRows([]), { org: false, ext: false, server: false, memory: false });
});

test('설정 조직 화면 — 처음엔 고른 조직, 하나뿐이면 고르기 없음, 관리자 화면에서 관리자 아닌 조직은 잠금', () => {
  const orgs = [{ id: 'o1', name: '린', role: 'owner' }, { id: 'o2', name: '디자인', role: 'member' }];
  assert.deepEqual(orgScreen('server', { orgs, orgId: 'o1' }), { org: orgs[0], multi: true, locked: false });
  assert.deepEqual(orgScreen('server', { orgs, orgId: 'o2' }), { org: orgs[1], multi: true, locked: true });
  assert.deepEqual(orgScreen('ext', { orgs, orgId: 'o2' }), { org: orgs[1], multi: true, locked: true });
  assert.deepEqual(orgScreen('memory', { orgs, orgId: 'o2' }), { org: orgs[1], multi: true, locked: false }, '기억은 멤버도 본다(바꾸기는 정책이 정한다)');
  assert.deepEqual(orgScreen('org', { orgs: [orgs[1]], orgId: 'o2' }), { org: orgs[1], multi: false, locked: false });
  assert.deepEqual(orgScreen('org', { orgs, orgId: 'gone' }), { org: null, multi: true, locked: false });
});

// 기능 점검 D6(2026-10-02) — 결재 카드에서 어떤 에이전트를 어느 방에 넣어 달라는지 구분되지 않던 것. 이름을 모르면 종전 문구로.
test('넣기 요청 카드 문구 — 에이전트·방 이름이 있으면 둘 다, 에이전트만 있으면 에이전트만, 없으면 종전 문구', async () => {
  const { joinReqKey } = await import('../src/phone-shell.mjs');
  assert.deepEqual(joinReqKey({ crew: '효일', room: '유건, 하나' }), ['phone.agents.joinReq.named', { crew: '효일', room: '유건, 하나' }]);
  assert.deepEqual(joinReqKey({ crew: '효일', room: null }), ['phone.agents.joinReq.crew', { crew: '효일' }]);
  assert.deepEqual(joinReqKey({ crew: null, room: '유건, 하나' }), ['phone.agents.joinReq', {}]);
});
