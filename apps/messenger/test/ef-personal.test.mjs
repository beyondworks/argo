// UI 점검 F(2026-10-01) — 개인 공간·에이전트 방: 내 이름, 에이전트 행 메뉴, 꺼진 에이전트 안내, 넣기 요청 대기 표시.
import test from 'node:test';
import assert from 'node:assert/strict';
import { selfMember, personalSelfName } from '../src/self-member.mjs';
import { crewRowMenuKeys } from '../src/crew-row-menu.mjs';
import { crewAwayNotice } from '../src/crew-dm-notice.mjs';
import { crewListEmptyKey } from '../src/crews-empty.mjs';
import { shortcutLabel } from '../src/shortcut.mjs';

test('selfMember: 조직에서는 구성원 목록의 내 행, 개인 공간에서는 목록에 없어도 내 프로필 이름으로 만든다', () => {
  const members = [{ user_id: 'u1', display_name: '하나', role: 'friend' }];
  assert.equal(selfMember({ members, uid: 'u1', isPersonal: false }).display_name, '하나');
  assert.equal(selfMember({ members, uid: 'me', isPersonal: false }), undefined, '조직에서 구성원 행이 없으면 만들어 내지 않는다');
  assert.deepEqual(selfMember({ members, uid: 'me', isPersonal: true, personalName: '유건', email: 'owner.qa@example.test' }), { user_id: 'me', role: null, display_name: '유건' });
  assert.equal(selfMember({ members: [], uid: 'me', isPersonal: true, personalName: '', email: 'owner.qa@example.test' }).display_name, 'owner.qa', '이름이 없으면 이메일 앞부분(서버 이름 규칙의 마지막 단계)');
  assert.equal(selfMember({ members: [], uid: 'me', isPersonal: true, personalName: ' ', email: '' }).display_name, '');
});

test('personalSelfName: 개인 방 목록이 준 이름 표에서 내 이름을 고른다(공백·없음은 빈 문자열)', () => {
  assert.equal(personalSelfName({ me: '유건' }, 'me'), '유건');
  assert.equal(personalSelfName({ me: '  ' }, 'me'), '');
  assert.equal(personalSelfName({}, 'me'), '');
});

test('crewRowMenuKeys: 개인 공간에는 에이전트 관리(시트) 항목이 없다 — 시트를 그리지 않는 화면에서 눌러도 안 열리던 메뉴', () => {
  assert.deepEqual(crewRowMenuKeys({ isPersonal: false, isDm: false, canKickCrew: true, ownedByMe: true }), ['manage', 'call', 'remove']);
  assert.deepEqual(crewRowMenuKeys({ isPersonal: true, isDm: true, canKickCrew: true, ownedByMe: true }), ['leave'], '개인 방의 내 에이전트는 주인 전용 빼기 함수로(행 삭제는 친구가 만든 방에서 거절됐다)');
  assert.deepEqual(crewRowMenuKeys({ isPersonal: true, isDm: true, canKickCrew: true, ownedByMe: false }), ['remove'], '남의 에이전트는 방에서 권한이 있을 때만');
  assert.deepEqual(crewRowMenuKeys({ isPersonal: true, isDm: false, canKickCrew: false, ownedByMe: true }), ['call', 'leave']);
  assert.deepEqual(crewRowMenuKeys({ isPersonal: false, isDm: true, canKickCrew: false, ownedByMe: false }), ['manage']);
});

test('crewAwayNotice: 에이전트와의 1:1에서 에이전트가 꺼져 있을 때만 안내한다', () => {
  const now = Date.parse('2026-10-01T12:00:00Z'); const awayMs = 90_000;
  const dm = { kind: 'dm' }; const me = 'me';
  const crew = (seen, owner = 'me') => ({ id: 'c1', display_name: '페퍼', owner_user_id: owner, last_seen_at: seen });
  const run = (o) => crewAwayNotice({ channel: dm, people: [{ user_id: me }], uid: me, now, awayMs, ...o });
  assert.deepEqual(run({ chCrews: [crew(null)] }), { name: '페퍼', mine: true });
  assert.deepEqual(run({ chCrews: [crew('2026-10-01T11:50:00Z', 'friend')] }), { name: '페퍼', mine: false });
  assert.equal(run({ chCrews: [crew('2026-10-01T11:59:30Z')] }), null, '90초 안에 신호가 있으면 켜져 있다');
  assert.equal(run({ chCrews: [crew(null), crew(null)] }), null, '에이전트 둘이면 에이전트 1:1이 아니다');
  assert.equal(run({ chCrews: [crew(null)], people: [{ user_id: me }, { user_id: 'f' }] }), null, '사람이 더 있으면 에이전트 1:1이 아니다');
  assert.equal(run({ chCrews: [crew(null)], channel: { kind: 'public' } }), null);
});

test('crewListEmptyKey: 넣기 요청이 대기 중이면 "넣을 에이전트가 없다"고 말하지 않는다', () => {
  const base = { crewCount: 0, pendingCount: 0, isPersonal: true, canAddCrew: false, scoped: true };
  assert.equal(crewListEmptyKey(base), 'ch.crews.none.personal');
  assert.equal(crewListEmptyKey({ ...base, pendingCount: 1 }), null, '대기 요청 행이 이미 보인다');
  assert.equal(crewListEmptyKey({ ...base, crewCount: 1 }), null);
  assert.equal(crewListEmptyKey({ ...base, isPersonal: false }), 'ch.crews.none.scoped');
  assert.equal(crewListEmptyKey({ ...base, isPersonal: false, scoped: false }), 'ch.crews.none');
  assert.equal(crewListEmptyKey({ ...base, canAddCrew: true }), 'ch.crews.none.scoped', '개인 공간이어도 넣을 수 있으면 아래 추가로 안내');
});

test('shortcutLabel: 맥은 ⌘, 그 밖의 OS는 Ctrl', () => {
  assert.equal(shortcutLabel('K', { platform: 'MacIntel' }), '⌘K');
  assert.equal(shortcutLabel('/', { platform: 'MacIntel' }), '⌘/');
  assert.equal(shortcutLabel('K', { platform: 'Win32' }), 'Ctrl+K');
  assert.equal(shortcutLabel('K', { userAgentData: { platform: 'Windows' }, platform: '' }), 'Ctrl+K');
  assert.equal(shortcutLabel('K', { userAgentData: { platform: 'macOS' }, platform: '' }), '⌘K');
  assert.equal(shortcutLabel('K', {}), 'Ctrl+K', '알 수 없으면 Ctrl');
});

import { graphLabelVisible, SMALL_GRAPH } from '../src/graph-labels.mjs';
import { t } from '../src/i18n.js';
test('graphLabelVisible: 점이 적으면 처음부터 전부 이름을 그리고, 많으면 허브·호버·이웃만(종전)', () => {
  const base = { hover: -1, focus: -1, hoverNeighbor: false, near: null };
  assert.equal(graphLabelVisible({ ...base, i: 3, deg: 1, n: 11 }), true, '작은 그래프의 말단 점도 이름');
  assert.equal(graphLabelVisible({ ...base, i: 3, deg: 1, n: SMALL_GRAPH + 1 }), false, '큰 그래프의 말단 점은 이름 없음');
  assert.equal(graphLabelVisible({ ...base, i: 3, deg: 3, n: 500 }), true, '허브는 늘 이름');
  assert.equal(graphLabelVisible({ ...base, i: 3, deg: 1, n: 500, hover: 3 }), true);
  assert.equal(graphLabelVisible({ ...base, i: 4, deg: 1, n: 11, hover: 3, hoverNeighbor: false }), false, '호버 중에는 이웃만');
  assert.equal(graphLabelVisible({ ...base, i: 4, deg: 1, n: 11, hover: 3, hoverNeighbor: true }), true);
  assert.equal(graphLabelVisible({ ...base, i: 4, deg: 1, n: 11, near: new Set([1]) }), false, '집중 중에는 가까운 점만');
});

test('영어 모드: 에이전트 한 명을 가리키는 표식은 단수(Agent)다', () => {
  assert.equal(t('org.crew', 'en'), 'Agent');
  assert.equal(t('org.crew', 'ko'), '에이전트');
});

test('기억 트리 숫자: 행마다 뜻을 밝힌다 — 활동 수 / 항목 수 (영어 단수·복수 포함)', () => {
  assert.equal(t('act.tree.n.act', 'ko', { n: 28 }), '활동 28');
  assert.equal(t('act.tree.n.items', 'ko', { n: 3 }), '3개');
  assert.equal(t('act.tree.n.act', 'en', { n: 1 }), '1 event');
  assert.equal(t('act.tree.n.items', 'en', { n: 3 }), '3 items');
});

test('이름 용어: 만든 사람 표식은 앱 전체가 쓰는 "방장"으로 통일', () => {
  assert.equal(t('ch.admin.creator', 'ko'), '방장');
  assert.doesNotMatch(t('dm.crew.join.note.opener', 'ko', { name: '하나' }), /대화를 연/);
  assert.match(t('dm.crew.join.note.opener', 'ko', { name: '하나' }), /방장 하나님/);
  assert.equal(t('ch.open.crew', 'ko'), '에이전트 관리');
  assert.equal(t('dm.remove.crew', 'ko'), '방에서 빼기');
});

import { koJosa } from '../src/ko-josa.mjs';
test('koJosa: 앞말 받침에 맞춰 조사를 고른다 — 에이전트 꺼짐 안내 문구', () => {
  assert.equal(koJosa('페퍼이(가) 꺼져 있어'), '페퍼가 꺼져 있어');
  assert.equal(koJosa('서윤이(가) 꺼져 있어'), '서윤이 꺼져 있어');
  assert.equal(koJosa('Argo이(가)'), 'Argo가');
  assert.equal(koJosa('서울(으)로'), '서울로'); assert.equal(koJosa('집(으)로'), '집으로');
  assert.equal(koJosa(t('crew.dm.away', 'ko', { name: '페퍼' })), '페퍼가 꺼져 있어 답하지 않습니다. 켜지면 보낸 글에 답합니다.');
});

test('허락 막대 문구: 어떤 에이전트인지와 대화를 읽게 된다는 것을 밝힌다(이름을 알 때·모를 때)', () => {
  const named = koJosa(t('personal.crewReq.named', 'ko', { name: '유건', crew: '페퍼' }));
  assert.equal(named, '유건님이 자기 에이전트 페퍼를 이 방에 넣으려고 합니다. 허락하면 페퍼가 이 방의 대화를 읽고 답할 수 있습니다.');
  assert.match(t('personal.crewReq', 'ko', { name: '유건' }), /읽고 답할 수 있습니다/);
  assert.match(t('personal.crewReq.named', 'en', { name: 'A', crew: 'Pepper' }), /Pepper can read and answer/);
});
