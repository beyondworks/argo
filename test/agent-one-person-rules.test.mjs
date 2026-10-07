// 에이전트 '한 사람'(유건 결정 2026-10-08 ①·③)의 순수 규칙 — 방 판정(ownerSoloRoom), 턴 판정(ownerSoloTurn), 기록 범위(inContextScope·soloAfterSession),
// 호칭 규칙 판정(hasAddressRule·userSetAddress). 행동 전체는 test/agent-one-person.test.mjs(실제 chat()·게이트웨이 처리기)가 잠근다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ownerSoloRoom, audienceOf } from '../src/gateway/office-audience.mjs';
import { ownerSoloTurn } from '../src/gateway/msgr-handoff.mjs';
import { inContextScope, isOwnerSoloScope, soloAfterSession } from '../src/thread.mjs';
import { hasAddressRule, userSetAddress, userAddressNote, ADDRESS_RULE_SKILL } from '../src/user-name.mjs';
import { RULES_SKILL } from '../src/corrections.mjs';

const OWNER = 'u-owner', GUEST = 'u-guest', CREW = 'c-me', OTHER = 'c-other';
const clientOf = (rows, { error = null, throws = false } = {}) => ({ reads: 0, from() {
  const self = this; const q = { select() { return q; }, eq() { return q; }, in() { return q; },
    then(res, rej) { self.reads += 1; if (throws) return Promise.reject(new Error('net')).then(res, rej); return Promise.resolve({ data: rows, error }).then(res, rej); } };
  return q;
} });
const m = (kind, id) => ({ member_kind: kind, member_id: id });
const dm = { channelKind: 'dm', channelId: 'ch-1' };

test('ownerSoloRoom — 주인 하나 + 이 에이전트 하나인 1:1만 참', async () => {
  assert.equal(await ownerSoloRoom(clientOf([m('user', OWNER), m('crew', CREW)]), dm, OWNER, CREW), true);
  for (const [why, rows] of [
    ['손님이 낀 방', [m('user', OWNER), m('user', GUEST), m('crew', CREW)]],
    ['다른 에이전트가 낀 방', [m('user', OWNER), m('crew', CREW), m('crew', OTHER)]],
    ['이 에이전트가 없는 방', [m('user', OWNER), m('crew', OTHER)]],
    ['주인이 없는 방', [m('user', GUEST), m('crew', CREW)]],
    ['알 수 없는 구성원 종류', [m('user', OWNER), m('crew', CREW), m('bot', 'b')]],
    ['빈 결과', []],
  ]) assert.equal(await ownerSoloRoom(clientOf(rows), dm, OWNER, CREW), false, why);
  assert.equal(await ownerSoloRoom(clientOf([m('user', OWNER), m('crew', CREW)]), { channelKind: 'private', channelId: 'ch-1' }, OWNER, CREW), false, 'dm이 아니면 조회도 없이 거짓');
  assert.equal(await ownerSoloRoom(clientOf(null, { error: { message: 'rls' } }), dm, OWNER, CREW), false, '조회 오류 → 좁게');
  assert.equal(await ownerSoloRoom(clientOf(null, { throws: true }), dm, OWNER, CREW), false, '네트워크 예외 → 좁게');
  assert.equal(await ownerSoloRoom(undefined, dm, OWNER, CREW), false, '클라이언트 없음 → 좁게');
});

test('ownerSoloRoom의 사람 규칙은 오피스 도구의 owner 판정(audienceOf)과 같다', async () => {
  for (const rows of [[m('user', OWNER), m('crew', CREW)], [m('user', OWNER), m('user', GUEST), m('crew', CREW)], [m('user', GUEST), m('crew', CREW)]]) {
    const usersOnly = rows.filter((r) => r.member_kind === 'user').map((r) => ({ member_id: r.member_id }));
    const owner = (await audienceOf(clientOf(usersOnly), { ...dm, orgId: null }, OWNER)) === 'owner';
    assert.equal(await ownerSoloRoom(clientOf(rows), dm, OWNER, CREW), owner);
  }
});

test('ownerSoloTurn — 게이트웨이 표지가 있어도 주인 직접 턴이 아니면 거짓(fail-closed)', () => {
  const base = { kind: 'msgr', channelKind: 'dm', ownerSolo: true, uid: OWNER, origin: OWNER };
  assert.equal(ownerSoloTurn(base), true);
  for (const [why, ctx, opts] of [
    ['표지 없음', { ...base, ownerSolo: undefined }],
    ['채널', { ...base, channelKind: 'public' }],
    ['손님(시킨 사람이 주인 아님)', { ...base, origin: GUEST }],
    ['손님 사슬', { ...base, guest: true }],
    ['뿌리가 다른 사람', { ...base, rootAuthor: GUEST }],
    ['오피스에서 맡긴 글', { ...base, office: true }],
    ['에이전트가 넘긴 턴', { ...base, handoffFrom: OTHER }],
    ['넘김 단계(ctx)', { ...base, hop: 1 }],
    ['넘김 단계(인자)', base, { hop: 1 }],
    ['위임받은 동료 턴', base, { from: 'mina' }],
    ['크루가 건 후속', base, { notOwnerDirect: 'mina' }],
    ['메신저 위임 맥락', { ...base, kind: 'msgr-rules' }],
    ['맥락 없음', null],
  ]) assert.equal(ownerSoloTurn(ctx, opts), false, why);
});

test('기록 범위 — 범위 없는 턴은 범위 없는 기록 + 주인 혼자 1:1 기록만, 범위 턴은 종전대로', () => {
  const solo = { kind: 'msgr-dm', channelId: 'a', threadRoot: 1, ownerSolo: true };
  const plain = { kind: 'msgr-dm', channelId: 'a', threadRoot: 1 };
  const chan = { kind: 'msgr', channelId: 'g' };
  assert.equal(isOwnerSoloScope(solo), true);
  assert.equal(isOwnerSoloScope(plain), false);
  assert.equal(isOwnerSoloScope({ ...chan, ownerSolo: true }), false, '채널 범위에 표지가 붙어도 1:1이 아니다');
  assert.equal(inContextScope({}, null), true);
  assert.equal(inContextScope({ contextScope: solo }, null), true);
  assert.equal(inContextScope({ contextScope: plain }, null), false, '표지 없는 DM(옛 버전·남 낀 방)은 데스크톱 맥락에서 뺀다');
  assert.equal(inContextScope({ contextScope: chan }, null), false);
  assert.equal(inContextScope({ contextScope: solo }, chan), false, '채널 턴은 그 채널 기록만');
  assert.equal(inContextScope({}, chan), false, '채널 턴에 데스크톱 기록 없음');
  assert.equal(inContextScope({ contextScope: solo }, plain), false, '남 낀 DM 턴(범위 키 없음)에는 아무 기록도 없음');
});

test('soloAfterSession — 마지막 범위 없는 답 뒤의 1:1 기록만 "세션이 못 본 것"', () => {
  const solo = { kind: 'msgr-dm', channelId: 'a', ownerSolo: true };
  const T = (messages) => ({ messages });
  assert.equal(soloAfterSession(T([])), false);
  assert.equal(soloAfterSession(T([{ who: 'user', text: 'd' }, { who: 'crew', text: 'r' }])), false);
  assert.equal(soloAfterSession(T([{ who: 'crew', text: 'r' }, { who: 'user', contextScope: solo }, { who: 'crew', contextScope: solo }])), true);
  assert.equal(soloAfterSession(T([{ who: 'user', contextScope: solo }, { who: 'crew', contextScope: solo }, { who: 'user', text: 'd' }, { who: 'crew', text: 'r' }])), false, '그 뒤 데스크톱 답이 있으면 세션이 이미 받았다');
  assert.equal(soloAfterSession(T([{ who: 'crew', text: 'r' }, { who: 'user', contextScope: { kind: 'msgr-dm', channelId: 'a' } }])), false, '표지 없는 DM은 세지 않는다');
  assert.equal(soloAfterSession(T([{ who: 'crew', text: 'r' }, { who: 'user', contextScope: solo, failed: 'x' }])), false, '실패 줄은 세지 않는다');
  assert.equal(soloAfterSession(T([{ who: 'user', contextScope: solo }, { who: 'user', text: 'now', awaiting: true }])), true, '지금 보내는 데스크톱 글(대기 줄) 앞의 1:1');
});

test('호칭 규칙 판정 — 사용자를 부르는 방법을 정한 줄만', () => {
  for (const s of ['- 나를 "대표님"이라고 불러라', '- 사용자를 형이라고 부른다', '- 저를 유건님으로 불러 주세요', '- 호칭은 대표님', '- Call me "Chief".', '- Address the user as Dr. Kim', '- refer to me as boss'])
    assert.equal(hasAddressRule(s), true, s);
  for (const s of ['- 결론부터 말한다', '- 함수 하나를 부를 때 인자를 확인한다', '- 도구를 부를 때 결재를 먼저', "- Always address the user's question first", '- call them back when a customer emails', '- 결재를 부르기 전에', ''])
    assert.equal(hasAddressRule(s), false, s);
});

test('호칭 규칙 위치 — 카드는 "## 일하는 방식" 절만, 확정 규칙은 주입된 captain-rules 절만', () => {
  const card = (rules, other = '') => `---\nname: a\n---\n# a\n\n## 전문성\n${other}\n\n## 일하는 방식\n${rules}\n\n## 톤\n- 담백\n`;
  assert.equal(userSetAddress(card('- 나를 형이라고 불러'), ''), true);
  assert.equal(userSetAddress(card('- 결론부터', '- 나를 형이라고 불러'), ''), false, '다른 절의 줄은 보지 않는다(결정 문구: 일하는 방식)');
  assert.equal(userSetAddress('', '\n### 스킬: captain-rules\n# r\n- 사용자를 형이라고 부른다\n\n### 스킬: other\n- x'), true);
  assert.equal(userSetAddress('', '\n### Skill: other\n- call me boss\n### Skill: captain-rules\n- be brief\n'), false, '다른 스킬의 줄은 보지 않는다');
  assert.equal(userSetAddress('', '\n### Skill: captain-rules\n(Body omitted — injection budget exceeded.)\n'), false, '본문이 빠진 확정 규칙은 모델도 못 본다');
  assert.equal(ADDRESS_RULE_SKILL, RULES_SKILL, '확정 규칙 파일 이름이 교정 채택(corrections.mjs)과 같아야 한다');
});

test('호칭 지시문 — 규칙이 있으면 이름 대신 "정한 규칙대로"(ko·en), 없으면 종전 그대로', () => {
  assert.match(userAddressNote('유건', 'ko'), /이름은 "유건"/);
  assert.doesNotMatch(userAddressNote('유건', 'ko', { ruled: true }), /유건/);
  assert.match(userAddressNote('유건', 'ko', { ruled: true }), /직접 정한 규칙/);
  assert.match(userAddressNote('Yugeon', 'en', { ruled: true }), /rule they set/);
  assert.doesNotMatch(userAddressNote('Yugeon', 'en', { ruled: true }), /Yugeon/);
  assert.match(userAddressNote(null, 'ko'), /바로 말한다/);
});
