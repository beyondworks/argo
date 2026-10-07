// 에이전트 '한 사람'(유건 결정 2026-10-08 ①·③)의 순수 규칙 — 방 판정(ownerSoloRoom), 턴 판정(ownerSoloTurn), 기록 범위(inContextScope), 세션이 본 1:1 줄(soloKey·soloSeenFor·soloMsgIds),
// 회수 때 범위 없는 요약 거두기(applyDeparted),
// 호칭 규칙 판정(hasAddressRule·userSetAddress). 행동 전체는 test/agent-one-person.test.mjs(실제 chat()·게이트웨이 처리기)가 잠근다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ownerSoloRoom, audienceOf } from '../src/gateway/office-audience.mjs';
import { ownerSoloTurn } from '../src/gateway/msgr-handoff.mjs';
import { inContextScope, isOwnerSoloScope, soloKey, soloSeenFor, soloMsgIds } from '../src/thread.mjs';
import { applyDeparted, forgetChannels, mergeDeparted, summaryRecalled } from '../src/departed.mjs';
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

test('세션이 본 1:1 줄 — 키는 시각·화자·방, 기록은 그 세션 것일 때만', () => {
  const solo = { kind: 'msgr-dm', channelId: 'AbC', ownerSolo: true };
  assert.equal(soloKey({ ts: 5, who: 'user', contextScope: solo }), '5|user|abc');
  assert.notEqual(soloKey({ ts: 5, who: 'user', contextScope: solo }), soloKey({ ts: 5, who: 'crew', contextScope: solo }), '같은 턴의 지시·답은 다른 줄');
  const t = { soloSeen: { session: 's1', keys: ['5|user|abc'] } };
  assert.deepEqual([...soloSeenFor(t, 's1')], ['5|user|abc']);
  assert.equal(soloSeenFor(t, 's2').size, 0, '다른 세션의 기록은 이 세션이 본 줄이 아니다');
  assert.equal(soloSeenFor(t, null).size, 0, '세션이 없으면 본 줄도 없다');
  assert.equal(soloSeenFor({}, 's1').size, 0, '기록 없음 = 본 줄 없음(못 본 줄을 건넨다 — 잃지 않는다)');
  assert.equal(soloSeenFor({ soloSeen: { session: 's1', keys: 'x' } }, 's1').size, 0, '깨진 기록은 무시');
});

test('soloMsgIds — 이 기기 스레드에 있는 그 방의 주인 혼자 1:1 턴(원본 메시지 id)만', () => {
  const T = { messages: [
    { who: 'user', contextScope: { kind: 'msgr-dm', channelId: 'A', ownerSolo: true, msgId: 11 } },
    { who: 'crew', contextScope: { kind: 'msgr-dm', channelId: 'A', ownerSolo: true, msgId: 11 } },
    { who: 'user', contextScope: { kind: 'msgr-dm', channelId: 'B', ownerSolo: true, msgId: 12 } },
    { who: 'user', contextScope: { kind: 'msgr-dm', channelId: 'A', msgId: 13 } },
    { who: 'user', contextScope: { kind: 'msgr-dm', channelId: 'A', ownerSolo: true } },
    { who: 'user', text: 'desk' },
  ] };
  assert.deepEqual([...soloMsgIds(T, 'a')], ['11'], '다른 방·표지 없는 줄·id 없는 줄은 빼고, 방 id는 대소문자 무관');
  assert.equal(soloMsgIds(null, 'a').size, 0);
});

test('회수 — 지우는 주인 혼자 1:1 줄을 덮는 범위 없는 요약(t.summary)도 거둔다, 덮지 않는 요약·채널 요약 규칙은 그대로', () => {
  const CH = 'dddddddd-0000-4000-8000-000000000002';
  const lines = () => [
    { who: 'user', text: 'desk', ts: 1 },
    { who: 'user', text: 'solo', ts: 2, contextScope: { kind: 'msgr-dm', channelId: CH, ownerSolo: true } },
    { who: 'crew', text: 'r', ts: 2, contextScope: { kind: 'msgr-dm', channelId: CH, ownerSolo: true } },
    { who: 'user', text: 'desk2', ts: 3 },
  ];
  const covered = { messages: lines(), summary: { text: 'S', upto: 3 } };
  assert.equal(forgetChannels(covered, [CH]).removed, 2);
  assert.equal(covered.summary, undefined, '요약이 지운 1:1 줄(ts 2)을 덮는다(upto 3) — 거둔다');
  assert.deepEqual(covered.messages.map((m) => m.text), ['desk', 'desk2'], '데스크톱 줄은 남는다');
  const before = { messages: lines(), summary: { text: 'S', upto: 1 } };
  forgetChannels(before, [CH]);
  assert.deepEqual(before.summary, { text: 'S', upto: 1 }, '1:1 줄보다 앞까지만 덮는 요약은 그대로');
  const plainDm = { messages: [{ who: 'user', text: 'x', ts: 2, contextScope: { kind: 'msgr-dm', channelId: CH } }, { who: 'user', text: 'd', ts: 3 }], summary: { text: 'S', upto: 3 } };
  forgetChannels(plainDm, [CH]);
  assert.deepEqual(plainDm.summary, { text: 'S', upto: 3 }, '표지 없는 DM 줄은 범위 없는 요약에 없다 — 요약을 거두지 않는다');
  // 다른 기기의 옛 사본이 병합으로 되살린 줄을 거르는 자리(읽기·병합에서 다시 적용)도 같다
  const revived = { messages: lines(), summary: { text: 'S', upto: 3 }, departed: { [CH]: { ts: 2, sids: [] } } };
  applyDeparted(revived);
  assert.equal(revived.summary, undefined);
  assert.deepEqual(revived.departed[CH].sum, { at: 0, upto: 3 }, '줄로 거둘 때도 거둔 요약을 각인에 남긴다(at 없는 옛 요약은 0)');
});

test('회수가 거둔 요약 표지(sum) — 옛 버전이 줄 없이 되돌린 요약·그보다 앞 요약은 거르고, 회수 뒤 새 요약은 남긴다. 병합은 큰 값으로 보존', () => {
  const CH = 'dddddddd-0000-4000-8000-000000000002', CH2 = 'dddddddd-0000-4000-8000-000000000003';
  const d = { [CH]: { ts: 2, sids: [], sum: { at: 500, upto: 3 } } };
  assert.equal(summaryRecalled(d, { text: 'S', upto: 3, at: 500 }), true, '거둔 그 요약');
  assert.equal(summaryRecalled(d, { text: 'S0', upto: 2, at: 400 }), true, '그 앞 요약(같은 1:1 줄을 접었을 수 있다)');
  assert.equal(summaryRecalled(d, { text: 'S0', upto: 2 }), true, 'at 없는 옛 요약');
  assert.equal(summaryRecalled(d, { text: 'N', upto: 3, at: 501 }), false, '회수 뒤 만든 요약(기준점이 같아도)');
  assert.equal(summaryRecalled(d, { text: 'N', upto: 4, at: 400 }), false, '기준점이 더 뒤인 요약(시계가 늦은 기기가 만든 새 요약)');
  assert.equal(summaryRecalled({ [CH]: { ts: 2, sids: [] } }, { text: 'S', upto: 3, at: 1 }), false, '표지 없는 각인(옛 버전·요약을 거두지 않은 회수)');
  assert.equal(summaryRecalled(null, { text: 'S', upto: 3, at: 1 }), false);
  const t = { messages: [{ who: 'user', text: 'd', ts: 9 }], summary: { text: 'S', upto: 3, at: 500 }, departed: d };
  applyDeparted(t);
  assert.equal(t.summary, undefined, '읽기·병합 자리(applyDeparted)에서 줄 없이도 거른다');
  const m = mergeDeparted({ [CH]: { ts: 2, sids: ['a'], sum: { at: 500, upto: 3 } } }, { [CH]: { ts: 5, sids: ['b'] }, [CH2]: { ts: 1, sids: [], sum: { at: 7, upto: 9 } } });
  assert.deepEqual(m, { [CH]: { ts: 5, sids: ['a', 'b'], sum: { at: 500, upto: 3 } }, [CH2]: { ts: 1, sids: [], sum: { at: 7, upto: 9 } } }, '옛 버전 쪽(sum 없음)과 합쳐도 sum이 남는다');
  assert.deepEqual(mergeDeparted({ [CH]: { ts: 1, sids: [], sum: { at: 5, upto: 1 } } }, { [CH]: { ts: 1, sids: [], sum: { at: 3, upto: 4 } } })[CH].sum, { at: 5, upto: 4 }, '큰 값으로');
  assert.deepEqual(mergeDeparted({ [CH]: { ts: 1, sids: [], sum: { at: 'x', upto: 1 } } }, null)[CH], { ts: 1, sids: [] }, '깨진 sum은 버린다');
});

test('호칭 규칙 판정 — 사용자를 부르는 방법을 정한 줄만', () => {
  for (const s of ['- 나를 "대표님"이라고 불러라', '- 사용자를 형이라고 부른다', '- 저를 유건님으로 불러 주세요', '- 호칭은 대표님', '- Call me "Chief".', '- Address the user as Dr. Kim', '- refer to me as boss',
    '- 나를 대표님이라 불러', '- 대표님이라고 해줘', '- 나는 형이라 부르면 돼', '- 나를 부를 때는 대표님', '- 사용자 호칭은 대표님', // 검수 LOW: 앞의 셋을 놓쳤다
    '- 내 이름을 부르지 마', '- 제 이름은 부르지 말고 대표님이라고 해 주세요', '- 말할 때는 대표님이라고 불러줘', '- 앞으로 "대표님"이라고 불러줘', '- 대표님으로 불러']) // 재검수 LOW: '내 이름을 부르지 마'를 놓쳤다
    assert.equal(hasAddressRule(s), true, s);
  for (const s of ['- 결론부터 말한다', '- 함수 하나를 부를 때 인자를 확인한다', '- 도구를 부를 때 결재를 먼저', "- Always address the user's question first", '- call them back when a customer emails', '- 결재를 부르기 전에', '',
    '- 고객은 고객님이라고 부른다', '- 메일에서 상대를 이름으로 부르지 마라', '- 상대방 호칭은 OO님으로 통일', '- 너를 서윤이라고 부를게', // 검수 LOW: 사용자가 아닌 대상을 잡았다
    '- 출처가 없으면 "출처 없음"이라고 해', '- 모르면 모른다고 해', '- 결론부터 말하는 걸로 해', '- 파일은 Read로 불러온다', '- 템플릿으로 불러와 채운다', '- 너무 길게 쓰지 마', '- 저장 전에 확인',
    '- 보고서 제목은 "주간 보고"라고 부른다', '- 이 프로젝트를 앞으로 "아르고"라 부른다', '- 회의는 스탠드업이라고 부른다', '- API를 호출할 때는 재시도로 부른다', '- 함수는 helper로 불러 쓴다']) // 재검수 LOW: 사람이 아닌 대상의 이름을 정한 줄을 잡았다
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
