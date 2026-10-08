// 에이전트 '한 사람'(유건 결정 2026-10-08 ①·③)의 순수 규칙 — 방 판정(ownerSoloRoom), 턴 판정(ownerSoloTurn), 기록 범위(inContextScope), 세션이 본 1:1 줄(soloKey·soloSeenFor·soloMsgIds),
// 회수 때 범위 없는 요약 거두기(applyDeparted·summaryRecalled·unscopedSummaryGone·foldedSolo),
// 호칭 규칙 판정(hasAddressRule·userSetAddress). 행동 전체는 test/agent-one-person.test.mjs(실제 chat()·게이트웨이 처리기)가 잠근다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ownerSoloRoom, audienceOf } from '../src/gateway/office-audience.mjs';
import { ownerSoloTurn } from '../src/gateway/msgr-handoff.mjs';
import { inContextScope, isOwnerSoloScope, soloKey, soloSeenFor, soloMsgIds } from '../src/thread.mjs';
import { applyDeparted, forgetChannels, foldedSolo, summaryRecalled, unscopedSummaryGone } from '../src/departed.mjs';
import { hasAddressRule, userSetAddress, userAddressNote, ADDRESS_RULE_SKILL } from '../src/user-name.mjs';
import { RULES_SKILL } from '../src/corrections.mjs';
import { USER_ADDRESS_NOTE } from '../src/legacy-terms.mjs';
import { hasAddressRule3394 } from './helpers/address-rule-3394.mjs';

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

test('회수 — 회수된 주인 혼자 1:1 줄을 접은 범위 없는 요약(summary.solo)도 거둔다, 1:1 줄을 접지 않은 요약·채널 요약 규칙은 그대로', () => {
  const CH = 'dddddddd-0000-4000-8000-000000000002';
  const lines = () => [
    { who: 'user', text: 'desk', ts: 1 },
    { who: 'user', text: 'solo', ts: 2, contextScope: { kind: 'msgr-dm', channelId: CH, ownerSolo: true } },
    { who: 'crew', text: 'r', ts: 2, contextScope: { kind: 'msgr-dm', channelId: CH, ownerSolo: true } },
    { who: 'user', text: 'desk2', ts: 3 },
  ];
  assert.deepEqual(foldedSolo(lines(), 3), { [CH]: 2 }, '요약이 접은 1:1 방과 그 방 가장 이른 줄 ts');
  const covered = { messages: lines(), summary: { text: 'S', upto: 3, solo: foldedSolo(lines(), 3) } };
  assert.equal(forgetChannels(covered, [CH]).removed, 2);
  assert.equal(covered.summary, undefined, '요약이 지운 1:1 줄(ts 2)을 접었다 — 거둔다');
  assert.deepEqual(covered.messages.map((m) => m.text), ['desk', 'desk2'], '데스크톱 줄은 남는다');
  assert.deepEqual(covered.departed[CH], { ts: 2, sids: [] }, '각인 모양은 종전 그대로({ts, sids}) — 옛 버전이 그대로 읽고 보존한다');
  const before = { messages: lines(), summary: { text: 'S', upto: 1, withSolo: true, solo: foldedSolo(lines(), 1) } }; // 이 버전 요약(thread.mjs setThreadSummary — withSolo)
  forgetChannels(before, [CH]);
  assert.deepEqual(before.summary, { text: 'S', upto: 1, withSolo: true, solo: {} }, '1:1 줄보다 앞까지만 접은 요약은 그대로');
  const plainLines = [{ who: 'user', text: 'x', ts: 2, contextScope: { kind: 'msgr-dm', channelId: CH } }, { who: 'user', text: 'd', ts: 3 }];
  const plainDm = { messages: plainLines, summary: { text: 'S', upto: 3, withSolo: true, solo: foldedSolo(plainLines, 3) } };
  forgetChannels(plainDm, [CH]);
  assert.equal(plainDm.summary?.text, 'S', '표지 없는 DM 줄은 범위 없는 요약에 없다 — 요약을 거두지 않는다');
  // 다른 기기의 옛 사본이 병합으로 되살린 줄을 거르는 자리(읽기·병합에서 다시 적용)도 같다
  const revived = { messages: lines(), summary: { text: 'S', upto: 3, solo: { [CH]: 2 } }, departed: { [CH]: { ts: 2, sids: [] } } };
  applyDeparted(revived);
  assert.equal(revived.summary, undefined);
});

test('summary.solo — 회수 각인 ts 이하 1:1 줄을 접은 요약은 줄이 없어도(옛 버전 사본) 거르고, 다시 들어온 뒤 줄만 접은 요약·1:1을 안 접은 요약은 남긴다', () => {
  const CH = 'dddddddd-0000-4000-8000-000000000002', CH2 = 'dddddddd-0000-4000-8000-000000000003';
  const d = { [CH]: { ts: 2, sids: [] } };
  assert.equal(summaryRecalled(d, { text: 'S', upto: 3, solo: { [CH]: 2 } }), true, '지운 줄 가운데 가장 늦은 줄까지 접었다');
  assert.equal(summaryRecalled(d, { text: 'S', upto: 9, solo: { [CH]: 1 } }), true, '지운 줄 하나라도 접었으면(뒤에 다시 들어온 줄을 함께 접었어도)');
  assert.equal(summaryRecalled(d, { text: 'S', upto: 3, solo: { [CH.toUpperCase()]: 2 } }), true, '방 id 대소문자 무관');
  assert.equal(summaryRecalled(d, { text: 'N', upto: 9, solo: { [CH]: 5 } }), false, '다시 들어온 뒤 줄만 접은 요약');
  assert.equal(summaryRecalled(d, { text: 'N', upto: 9 }), false, '1:1 줄을 접지 않은 요약(옛 버전 요약 포함)');
  assert.equal(summaryRecalled(d, { text: 'N', upto: 9, solo: { [CH2]: 1 } }), false, '다른 방');
  assert.equal(summaryRecalled(null, { text: 'S', upto: 3, solo: { [CH]: 1 } }), false);
  assert.equal(summaryRecalled(d, null), false);
  const t = { messages: [{ who: 'user', text: 'd', ts: 9 }], summary: { text: 'S', upto: 3, solo: { [CH]: 2 } }, departed: d };
  applyDeparted(t);
  assert.equal(t.summary, undefined, '읽기·병합 자리(applyDeparted)에서 줄 없이 요약 자신의 표지로 거른다');
  // 이어 접은 앞 요약의 solo는 방마다 작은 값으로 합친다 — 기준점 뒤·표지 없는·방 id가 아닌 줄은 넣지 않는다
  const msgs = [
    { who: 'user', ts: 4, contextScope: { kind: 'msgr-dm', channelId: CH, ownerSolo: true } },
    { who: 'user', ts: 6, contextScope: { kind: 'msgr-dm', channelId: CH2, ownerSolo: true } },
    { who: 'user', ts: 5, contextScope: { kind: 'msgr-dm', channelId: CH2 } },
    { who: 'user', ts: 3, contextScope: { kind: 'msgr-dm', channelId: 'crew:x', ownerSolo: true } },
  ];
  assert.deepEqual(foldedSolo(msgs, 5, { [CH]: 7, [CH2.toUpperCase()]: 1, nope: 1, [CH + 'x']: 1 }), { [CH]: 4, [CH2]: 1 });
  assert.deepEqual(foldedSolo(msgs, 6), { [CH]: 4, [CH2]: 6 });
});

test('옛 버전 요약(withSolo 없음) — 회수 각인이 있는 스레드에서는 쓰지 않는다(옛 버전이 다시 요약하며 solo 표지를 잃는다, 재검수 3차 MEDIUM). 이 버전 요약·각인 없는 스레드·채널 요약은 그대로', () => {
  const CH = 'dddddddd-0000-4000-8000-000000000002', GCH = 'dddddddd-0000-4000-8000-000000000003';
  const d = { [GCH]: { ts: 2, sids: [] } }; // 어느 방이든(채널 회수 #816 포함) — 각인만 보고는 그 방이 1:1이었는지 알 수 없다
  assert.equal(unscopedSummaryGone(d, { text: 'OLD', upto: 9, at: 1 }), true, '옛 버전 모양 {text, upto, at}');
  assert.equal(unscopedSummaryGone(d, { text: 'NEW', upto: 9, withSolo: true }), false, '이 버전 요약(1:1을 안 접었다)');
  assert.equal(unscopedSummaryGone({ [CH]: { ts: 2, sids: [] } }, { text: 'NEW', upto: 9, withSolo: true, solo: { [CH]: 2 } }), true, 'summaryRecalled 경로는 그대로');
  assert.equal(unscopedSummaryGone(null, { text: 'OLD', upto: 9 }), false, '각인 없는 스레드의 옛 요약은 그대로 쓴다(지금과 같음)');
  assert.equal(unscopedSummaryGone({}, { text: 'OLD', upto: 9 }), false);
  assert.equal(unscopedSummaryGone({ nope: { ts: 1 } }, { text: 'OLD', upto: 9 }), false, '방 id가 아닌 키는 각인이 아니다');
  assert.equal(unscopedSummaryGone(d, null), false);
  const t = { messages: [{ who: 'user', text: 'd', ts: 9 }], summary: { text: 'OLD', upto: 9, at: 1 }, scopedSummaries: { [GCH]: { text: 'CH', upto: 30, at: 1 } }, departed: d };
  applyDeparted(t);
  assert.equal(t.summary, undefined, '읽기·병합 자리(applyDeparted)에서 거른다');
  assert.equal(t.scopedSummaries[GCH]?.text, 'CH', '채널 요약은 종전 규칙(upto ≤ 각인 ts)만 — 다시 들어온 뒤 요약은 옛 모양이어도 거두지 않는다');
});

// 호칭 규칙 판정 표(8차 2026-10-08 — 정밀도 우선). 잘못 잡으면 확정 규칙 한 줄 때문에 그 회사 모든 에이전트의 이름 줄이 빠지고,
// 놓치면 이름 줄이 남지만 그 끝의 우선 문구("단, 사용자가 카드의 '일하는 방식'이나 회사 규칙(사용자 지침)에서 호칭을 따로 정했으면 그 규칙을 따른다")가 덮는다.
//   CAUGHT   — 사용자 호칭 규칙이고 판정이 잡는 줄
//   MISSED   — 사용자 호칭 규칙이지만 판정이 일부러 잡지 않는 줄('놓침(문구로 덮음)'). 5~7차에 이 모양을 잡으려 넓힐 때마다 다른 줄을 잘못 잡았다.
//              여기서 CAUGHT로 옮기려면 NOT_RULE 표 전체가 그대로 거짓인지 먼저 본다.
//   NOT_RULE — 사용자 호칭 규칙이 아닌 줄(1~7차 검수 탐침의 오탐 후보 전부). 하나라도 참이면 실패.
// 줄은 각 차수 탐침(scratchpad one-person-addr3/all-lines.mjs가 모은 것)에서 출처별로 그대로 가져왔다.
const CAUGHT = [
    // 7차 표 (42)
    '- 나를 "대표님"이라고 불러라', '- 사용자를 형이라고 부른다', '- 저를 유건님으로 불러 주세요', '- 호칭은 대표님', '- Call me "Chief".',
    '- Address the user as Dr. Kim', '- refer to me as boss', '- 나를 대표님이라 불러', '- 대표님이라고 해줘', '- 나는 형이라 부르면 돼',
    '- 나를 부를 때는 대표님', '- 사용자 호칭은 대표님', '- 내 이름을 부르지 마', '- 제 이름은 부르지 말고 대표님이라고 해 주세요', '- 말할 때는 대표님이라고 불러줘',
    '- 앞으로 "대표님"이라고 불러줘', '- 대표님으로 불러', '- 이름은 유건님으로 불러줘', '- 제 직함은 빼고 이름으로 불러 주세요', '- 직함은 빼고 유건님이라고 불러줘',
    '- 앞으로는 성은 빼고 유건님이라고 불러', '- 앞으로 이름은 유건님으로 불러줘', '- 보고는 결론부터, 그리고 대표님이라 부르지 말고 유건님이라 불러', '- 반말은 쓰지 말고 유건님이라고 불러', '- 존댓말을 쓰고 유건님이라고 불러줘',
    '- 대표님 말고 유건님이라고 불러줘', '- 보고할 때는 유건님이라고 부른다', '- 말투는 친근하게 하고 형이라고 불러', '- 보고는 결론부터. 유건님이라고 불러', '- 대화에서 호칭은 유건님',
    '- 메일은 짧게 쓰고 나를 팀장님이라고 불러', '- 대표님은 말고 유건님이라고 불러', '- 주인을 형이라고 불러', '- 저는 유건님이라고 불러 주세요', '- 사용자에게 대표님이라고 부르지 않는다',
    '- 유저 호칭은 대표님', '- Call the user "boss"', '- Address the owner by first name', '- Address the user.', '- 저를 부르실 때는 유건님이라고 해 주세요',
    '- Call me "boss" in every reply', '- Please call me by my first name',
    // 6차 검수 탐침 (24)
    '- 사용자(유건)는 유건님이라고 부른다', '- 사용자 이름: 유건, 유건님이라고 불러', '- 사용자를 부르는 호칭은 유건님', '- 사용자를 부를 때 유건님', '- 사용자를 "대표님"으로 부르지 말 것',
    '- 사용자는 대표님이라고 부른다', '- 사용자도 유건님이라고 부른다', '- 주인님이라고 불러줘', '- 유저를 대표님으로 불러', '- 저를 유건님이라고 불러 주세요',
    '- 저는 유건님으로 불러 주세요', '- 저, 유건님이라고 불러주세요', '- 나를 유건님이라고 불러', '- 날 형이라고 불러', '- 나는 대표님이라고 불러줘',
    '- 호칭: 유건님', '- 호칭은 유건님', '- 앞으로 호칭은 대표님', '- Address the user as Yugeon', '- Address the user by first name',
    '- Refer to the user as Yugeon', '- Address the owner as Mr. Kim', '- Address me as boss', '- Refer to me by first name',
    // 7차 반례 (4)
    '- 유저 이름: 유건, 유건님으로 불러', '- Call me "Chief"', '- Call the user by first name', '- Refer to the owner as Mr. Kim',
    // 7차 확인 검수 (13)
    '- 앞으로 사용자를 대표님이라고 부르지 않는다', '- 앞으로 사용자를 부를 때는 유건님이라고 한다', '- 앞으로 나를 형이라고 부른다', '- 저를 부르는 호칭은 유건님', '- 사용자한테도 유건님이라고 불러',
    '- 사용자 호칭은 유건님으로', '- Never call me "CEO"', '- Always address me as Yugeon', '- Please address the owner by first name', '- Call the user by their first name',
    '- Refer to the user as Yugeon in reports', '- Don\'t refer to me as the CEO', '- Address the user by name.',
    // 3차 (3)
    '- 존댓말을 쓰고 유건님이라고 불러', '- 항상 "유건님"으로 불러', '- 나는 그냥 유건이라고 불러',
    // 3차 수정 (4)
    '- 보고는 짧게 그리고 유건님이라고 불러', '- 반말 말고 존댓말로, 대표님이라고 불러', '- 존댓말을 쓰고, 유건님이라고 불러', '- 제 호칭은 대표님으로',
    // 4차 검수 (3)
    '- 사용자를 "대표님"이라고 부르지 않는다', '- 유건님이라고 불러줘', '- 사장님 대신 유건님이라고 부른다',
    // #858 첫 검수 (2)
    '- 나를 부를 때는 유건님', '- 대표님 말고 유건님으로 불러줘',
    // 8차 반례 (5)
    '- 사용자는 대표님 말고 유건님이라고 부른다', '- 나를 "유건님"이라고 불러', '- Call me "Yugeon", not CEO', '- Call the user "유건님"', '- Address me as "boss"',
];
const MISSED = [
    // 7차 표 (26)
    '- Call me Yugeon', '- 사용자 호칭: 유건님', '- 사용자 호칭 : 대표님', '- 사용자 호칭 = 유건님', '- 사용자 호칭 - 유건님',
    '- 사용자 호칭 유건님', '- 사용자 호칭 "대표님"', '- 주인 호칭: 형', '- 유저 호칭: 대표님', '- 사용자의 호칭은 유건님',
    '- 사용자의 호칭은 "대표님"으로 통일', '- 사용자의 이름은 유건님으로 불러', '- 사용자의 이름을 부를 때는 유건님', '- 주인의 호칭은 형', '- 유저의 호칭은 대표님',
    '- 사용자에게는 유건님이라고 부른다', '- 사용자한테는 대표님이라 부르지 마', '- 저한테는 유건님이라고 해 주세요', '- 사용자님을 유건님이라고 불러', '- 주인님을 형이라고 불러',
    '- Address the user formally', '- Address the user politely, as Yugeon', '- Address the user casually', '- Always call the user Yugeon', '- Call the user Yugeon',
    '- Call me 유건님',
    // 6차 검수 탐침 (3)
    '- Call me Yugeon, not CEO', '- Refer to the user in the third person', '- address me formally',
    // 7차 반례 (5)
    '- 사용자 호칭 = "유건님"', '- 나한테는 형이라고 해', '- 사용자 호칭 – 유건님', '- call me Yugeon', '- Address me respectfully',
    // 7차 확인 검수 (18)
    '- 사용자님은 유건님이라고 부른다', '- 사용자의 호칭: 유건님', '- 사용자 호칭 = 대표님', '- 사용자 호칭 — 유건님', '- 사용자의 성함은 김유건, 유건님으로 불러',
    '- 앞으로 사용자에게는 유건님이라고 부른다', '- 앞으로 나한테는 대표님이라고 해', '- 앞으로 사용자의 호칭은 "유건님"으로 통일한다', '- 나를 부르는 이름은 형', '- 날 부를 땐 형이라고',
    '- Don\'t call me sir', '- Call me boss, not CEO', '- call me yugeon', '- When you call me, use my first name', '- Address me formally',
    '- Call me Mr. Kim', '- Call the user 유건님', '- From now on, call me Yugeon',
    // 7차 확인 검수(교정 채택 문장 모양) (2)
    '사용자에게는 "유건님"이라고 부른다.', '앞으로 사용자에게는 대표님이라고 하지 말고 유건님이라고 부른다.',
    // 4차 검수 (1)
    '- 답변을 시작할 때 유건님이라고 부른다',
    // #858 첫 검수 (1)
    '- 메일 서명은 "유건 드림"으로, 호칭은 "유건님"으로',
    // 9차 확인 검수 (6) — 맨 앞 둘은 이 맥 ~/.argo 실제 카드 24개 '## 일하는 방식'에 있는 사용자의 실제 호칭 규칙(네 판 모두 놓침)
    '- 사장을 부를 때 "사장님"이 아니라 "유건님"으로 호칭한다 — 대화·보고·문서·메일 초안 등 모든 산출물에 예외 없이 적용한다.', '- 사장을 부를 때 "사장님"이 아니라 "유건님"으로 호칭한다',
    '- 앞으로는 유건님이라고 불러줘', '- 이제는 형이라고 불러', '- 앞으로는 "대표님"이라고 부르지 마', '- 날 부를 땐 형',
];
const NOT_RULE = [
    // 10차 검수(영어 「」 — 3394에서 거짓): 「」를 받으면 확정 규칙 한 줄로 회사 전체 이름 줄이 빠진다
    '- Address the owner 「승인 대기」 items first.', '- Address the user 「Ticket #12」 before others.', '- Call the owner 「urgent」 when the server is down.',
    // 7차 표 (88)
    '- 결론부터 말한다', '- 함수 하나를 부를 때 인자를 확인한다', '- 도구를 부를 때 결재를 먼저', '- Always address the user\'s question first', '- call them back when a customer emails',
    '- 결재를 부르기 전에', '', '- 고객은 고객님이라고 부른다', '- 메일에서 상대를 이름으로 부르지 마라', '- 상대방 호칭은 OO님으로 통일',
    '- 너를 서윤이라고 부를게', '- 출처가 없으면 "출처 없음"이라고 해', '- 모르면 모른다고 해', '- 결론부터 말하는 걸로 해', '- 파일은 Read로 불러온다',
    '- 템플릿으로 불러와 채운다', '- 너무 길게 쓰지 마', '- 저장 전에 확인', '- 보고서 제목은 "주간 보고"라고 부른다', '- 이 프로젝트를 앞으로 "아르고"라 부른다',
    '- 회의는 스탠드업이라고 부른다', '- API를 호출할 때는 재시도로 부른다', '- 함수는 helper로 불러 쓴다', '- 필요하면 도구로 불러서 처리한다', '- 프로젝트 이름은 Argo라고 부른다',
    '- 회사 이름은 린이라고 부른다', '- 회의 이름은 스탠드업이라고 부른다', '- 고객 호칭은 고객님으로', '- 회의록은 정리하고 "스탠드업"이라고 부른다', '- 매주 월요일 회의는 짧게 하고 스탠드업이라고 부른다',
    '- 이 저장소는 비공개로 두고 Argo라고 부른다', '- 주간 보고서를 만들면 "주간 보고"라고 부른다', '- 문서 호칭은 정식 명칭으로', '- 결제 모듈은 따로 빼고, 이름은 pay라고 부른다', '- 프로젝트 이름은, 앞으로 Argo라고 부른다',
    '- 새 버전은 v2.0이라고 부른다', '- 회의록은 짧게, 스탠드업이라고 부른다', '- 문서호칭은 정식 명칭으로', '- 사용자 매뉴얼은 "가이드"라고 부른다', '- 사용자 화면은 "홈"이라고 부른다',
    '- 고객 화면은 "사용자 화면"이라고 부른다', '- 유저 스토리는 US라고 부른다', '- 유저 플로우 문서는 "흐름도"라고 부른다', '- 주인공은 루나라고 부른다', '- 사용자 테스트는 UT라고 부른다',
    '- 사용자 인터뷰 기록은 "인터뷰 노트"로 부른다', '- \'유저\'라는 말 대신 \'사용자\'라고 부른다', '- 고객은 "사용자"라고 부른다', '- 주인 없는 업무는 "공용 업무"라고 부른다', '- 저 장표는 "요약"이라고 부른다',
    '- 사용자의 고객은 "회원님"이라고 부른다', '- 사용자의 회사는 "린"이라고 부른다', '- 회의 때는 서로 이름으로 부른다', '- 에이전트끼리는 서로 이름으로 부른다', '- Refer to the user manual before answering setup questions',
    '- Address the user stories in priority order', '- Call me only when you are blocked', '- Call me back after the deploy finishes', '- Refer to the owner dashboard for revenue numbers', '- 막히면 나를 불러',
    '- 결재가 필요하면 사용자를 부른다', '- 급한 일이면 저를 불러 주세요', '- 판단이 어려우면 주인을 부른다', '- 사용자를 부르기 전에 결재 카드를 만든다', '- 저를 불러서 확인받으세요',
    '- Call me during an incident', '- Call me in an emergency', '- Call me immediately if the deploy fails', '- Call me ASAP when the build breaks', '- Call me by 5pm with the numbers',
    '- Call me by phone if it breaks', '- Call me Monday about the deploy', '- If unsure, refer to the user.', '- Escalate billing questions; refer to the owner.', '- If blocked, call the user.',
    '- Call the owner, then wait', '- Refer to me if you are unsure', '- Address the user feedback in the next release', '- 사용자 호칭 정리는 나중에 한다', '- 사용자 이름 "닉네임" 필드는 "별명"이라고 부른다',
    '- 사용자의 이름 필드는 "닉네임"이라고 부른다', '- 사용자 이름 목록은 "명단"이라고 부른다', '- 사용자 호칭 관련 문서는 "호칭표"라고 부른다', '- 사용자들에게는 "회원"이라고 부른다', '- 주인의 고객은 "손님"이라고 부른다',
    '- 사용자의 화면 이름은 "홈"이라고 부른다', '- 사용자들은 "멤버"라고 부른다', '- 주인공을 루나라고 부른다',
    // 6차 검수 탐침 (5)
    '- 유저들은 "회원"이라고 부른다', '- Refer to the user guide', '- Address the user\'s concerns first', '- 사용자 화면 이름은 "홈"이라고 부른다', '- 사용자 이름은 "닉네임"이라고 부른다',
    // 7차 반례 (7)
    '- 막히면 사용자님을 불러', '- 승인이 필요하면 나를 불러 줘', '- Call me when the release is out', '- Call the user if payment fails', '- Refer to the owner for pricing questions',
    '- Call me ASAP', '- Address the owner\'s questions first',
    // 7차 확인 검수 (53)
    '- 사용자에게는 결론만 보고하고, 회의록은 "스탠드업 노트"라고 부른다', '- 사용자에게는 존댓말을 쓰고, 이 문서는 "주간 보고"라고 부른다', '- 사용자에게도 같은 요약을 보내고, 그 요약은 "데일리"라고 부른다', '- 사용자한테는 숫자만 보여 주고, 내부 지표는 "북극성"이라고 부른다', '- 주인에게는 매주 금요일에 보고하고, 이 보고는 "주간 결산"이라고 부른다',
    '- 앞으로 사용자에게는 결론부터 말하고, 이 보고서는 "주간 요약"이라고 부른다', '- 앞으로 사용자한테는 표로 보여 주고, 표는 "현황판"이라고 부른다', '- 나한테는 요약만 보내고, 긴 문서는 "부록"이라고 부른다', '- 나에게는 링크만 주고, 저장 폴더는 "보관함"이라고 부른다', '- 저한테는 결과만 알려 주시고, 이번 작업은 "알파 프로젝트"라고 부릅니다',
    '- 저에게는 메일로 보내 주시고, 첨부 파일은 "증빙"이라고 부릅니다', '- 사용자에게는 묻지 말고 helper로 불러 쓴다', '- 유저에게는 보이지 않게, 내부 플래그는 "섀도"라고 부른다', '- 사용자의 이름은 프로필에서 가져오고, 화면에서는 "멤버"라고 부른다', '- 사용자의 이름은 마스킹하고, 보고서에서는 "고객 A"라고 부른다',
    '- 사용자의 이름을 로그에 남기지 않고, 대신 "user-1"처럼 번호로 부른다', '- 사용자의 성함은 계약서에서 확인하고, 계약서는 "원본"이라고 부른다', '- 앞으로 사용자의 이름은 DB에서 읽고, 그 테이블은 "프로필 표"라고 부른다', '- 사용자 이름: 로그인 ID를 말한다. 팀에서는 "계정명"이라고 부른다', '- 사용자 이름 = username 칼럼, 화면에서는 "아이디"라고 부른다',
    '- 사용자 이름 - 로그인할 때 쓰는 값, "아이디"라고 부른다', '- 사용자 이름: username (화면에서는 "닉네임"이라 부름)', '- 유저 이름: 표시용 문자열. 내부에서는 handle로 부른다', '- 사용자 이름：이메일 앞부분, "아이디"라고 부른다', '- 사용자 이름 뒤에 "님"을 붙이는 기능은 "존칭 붙이기"라고 부른다',
    '- 사용자 호칭 관리님 메뉴는 "설정"이라고 부른다', '- 사용자 이름 고객님으로 표시되는 오류는 "이름 누락"이라고 부른다', '- 사용자님들은 "멤버"라고 부른다', '- 사용자를 부를 때는 결재 카드를 만든다', '- 사용자님을 부를 때는 결재 카드로 알린다',
    '- 주인을 부르실 때는 알림을 먼저 보낸다', '- 막혀서 나를 부를 때는 로그를 첨부해', '- 저를 부르는 때는 급한 일일 때만', '- Call me by Friday if it is not done', '- Call me by EOD with the numbers',
    '- Call me by Slack if blocked', '- Call me Next week to review', '- Call the user Service to fetch profiles', '- Call the user API before rendering', '- Address the user kindly when they are upset',
    '- Address the user warmly in greetings', '- Address the user stories first', '- Refer to the user by email in the ticket', '- Refer to the owner by Slack for approvals', '- Call me 바로 if blocked',
    '- 급하면 call me 해줘', '- Call me Asap if prod is down', '- Call me On weekends only for outages', '- Call me If anything breaks', '- Address me with questions anytime',
    '- Address the user’s feedback first', '- If blocked, call the user "now" via the alert channel', '- Call me \'only\' in emergencies',
    // 7차 확인 검수(교정 채택 문장 모양) (11)
    '- 저한테는 결과만 알려 주시고, 이번 작업은 "알파 프로젝트"라고 부른다', '- 저에게는 메일로 보내 주시고, 첨부 파일은 "증빙"이라고 부른다', '사용자에게는 결론부터 보고하고, 보고서는 "주간 요약"이라고 부른다.', '사용자에게는 확인을 받지 말고, 배포 스크립트는 deploy.sh로 부른다.', '사용자의 이름은 외부 메일에 쓰지 않고, 고객사는 "A사"라고 부른다.',
    '앞으로 사용자에게는 표 대신 목록으로 보여 주고, 이 목록은 "할 일 목록"이라고 부른다.', 'Report to the user formally, and call the sprint "Phase 2".', '- 사용자의 이름 칸은 "닉네임"이라고 부른다', '- 사용자 이름 필드는 "닉네임"이라고 부른다', '- 사용자의 이름 목록은 "명단"이라고 부른다',
    '- 사용자 호칭 설정 메뉴는 "호칭 관리"라고 부른다',
    // 3차 (3)
    '- 새 기능은 v2라고 부르고, 옛 기능은 v1이라고 부른다', '- 거래처 담당자는 과장님이라고 부른다', '- 고객 문의는 티켓이라고 부르고 우선순위를 붙인다',
    // 3차 수정 (1)
    '- 이 문서는 정리하면 보고서라고 부른다',
    // 4차 검수 (7)
    '- 결재 카드는 "승인 요청"이라고 부른다', '- 크루는 "에이전트"라고 부른다', '- 자동화는 루틴이라고 부르지 않는다', '- 회사 이름은 "린"으로 부른다', '- 팀 이름을 "Argo팀"이라고 부른다',
    '- 필요하면 도구를 불러 처리한다', '- 상대방 호칭은 직함으로',
    // #858 첫 검수 (1)
    '- 결과는 표로 정리하고 회의는 스탠드업이라고 부른다',
    // 8차 반례 (12)
    '- Call me as soon as the build breaks', '- Call me as needed', '- Call me as a last resort', '- Refer to the owner as an escalation path', '- Call me by Mon if blocked',
    '- Call the user by phone', '- Address the user by Slack', '- 사용자는 결론만 보고받고, 회의록은 "스탠드업"이라고 부른다', '- 나는 요약만 받고, 긴 문서는 "부록"이라고 부른다', '- 사용자 직함은 "PM"이라고 부른다',
    '- 사용자 성함은 계약서에서 확인하고, 계약서는 "원본"이라고 부른다', '- 사용자를 위해 만든 화면은 "홈"이라고 부른다',
    // 9차 확인 검수 (20) — 9878a4c0에서 참이고 3394에서 거짓이던 줄(12), 부르는 말 뒤에 사용자 낱말이 오는 순서(5), 3394 오탐이던 집주인 줄(3)
    '- 흔히 부르는 대로 "스탠드업"이라고 부른다', '- 팀에서 부르는 대로 "린"이라고 부른다', '- 다들 부르는 이름 그대로 "알파"라고 부른다', '- 평소 부르는 말로 "데일리"라고 부른다', '- 공통 함수는 utils로 불러 쓴다. 줄여서 "유틸"이라고 부른다.',
    '- 설정값은 config로 불러 써. 짧게 cfg라고 부르기도 해.', '헬퍼는 lib로 불러 쓴다. 보통 "헬퍼"라고 부른다. (2026-10-08 채택)', '- 날짜 함수는 dayjs로 불러 쓴다; 줄여서 "데이"라고 부른다', '- 공통 함수는 utils로 불러 쓴다 그리고 줄여서 "유틸"이라고 부른다', '공통 함수는 utils로 불러 쓴다. 줄여서 "유틸"이라고 부른다. (2026-10-08 채택)',
    '- 공통 함수는 utils로 불러 쓴다; 짧게 "유틸"이라 부른다', '- 건물은 집주인을 부른다. 짧게 "관리인"이라고 부른다', '- 회의록은 "스탠드업"이라고 부르고, 사용자에게 결론만 보고한다', '- 이번 작업은 "알파"라고 부르고, 결과는 나한테 보내 줘', '- 주간 보고서는 "주간 요약"이라고 부르고 사용자에게 금요일마다 보낸다',
    '- 첨부 파일은 "증빙"이라고 부르고 저한테 메일로 보내 주세요', '- Call the sprint "Phase 2" and report to me formally', '- 고장 나면 집주인을 부른다. 수리 기록은 "AS 일지"라고 부른다', '- 수리는 집주인을 불러 처리한다. 수리 기록은 "AS 일지"라고 부른다', '- 회의는 흔히 부르는 대로 "스탠드업"이라고 부른다',
];

test('호칭 규칙 판정 — 사용자를 부르는 방법을 정한 줄만, 애매하면 잡지 않는다', () => {
  for (const s of CAUGHT) assert.equal(hasAddressRule(s), true, s);
  for (const s of NOT_RULE) assert.equal(hasAddressRule(s), false, s);
});

test('호칭 규칙 판정 — 놓치는 모양(문구로 덮음)은 잡지 않고, 그때 이름 줄 끝에 우선 문구가 붙는다', () => {
  for (const s of MISSED) {
    assert.equal(hasAddressRule(s), false, s);
    const ruled = userSetAddress('', `\n### 스킬: ${ADDRESS_RULE_SKILL.replace(/\.md$/, '')}\n${s}\n`);
    assert.equal(ruled, false, s);
    for (const lang of ['ko', 'en']) {
      const note = userAddressNote('유건', lang, { ruled });
      assert.ok(note.endsWith(USER_ADDRESS_NOTE.deferToRule[lang]), `${lang} ${s}`);
      assert.match(note, /"유건"/, `${lang} 이름 줄은 그대로`);
    }
  }
});

// 지금 판정은 3394f000 판정의 부분집합이다(9차 2026-10-08 — 판정을 넓혀 정탐을 되찾으려 할 때마다 새 오탐이 생겼다). 표 전체와 조합으로 만든 줄에서
// "지금 판정이 참이면 3394도 참"을 본다. 기준판은 test/helpers/address-rule-3394.mjs(글자 그대로 옮긴 고정 사본).
const KO_PRE = ['- ', '', '- 앞으로 ', '- 앞으로는 ', '- 흔히 부르는 대로 ', '- 공통 함수는 utils로 불러 쓴다. ', '- 설정값은 config로 불러 써; ', '- 건물은 집주인을 부른다. ', '- 사용자에게 결론만 보고한다. ', '- 반말은 쓰지 말고 ', '- 보고는 결론부터, 그리고 ', '- 회의록은 정리하고 ', '- 막히면 나를 불러. '];
const KO_SUBJ = ['', '나를 ', '날 ', '저를 ', '저는 ', '사용자를 ', '사용자는 ', '사용자에게는 ', '나한테는 ', '주인을 ', '회의록은 ', '고객은 ', '저를 부르는 호칭은 ', '사용자 호칭은 ', '사용자의 호칭은 ', '호칭은 ', '이름은 ', '사용자 이름은 ', '보고서에서 ', '사장을 부를 때 ', '나를 부를 때는 ', '팀에서 부르는 대로 '];
const KO_NAME = ['"대표님"', '유건님', '형', '"스탠드업"', 'helper', '"긴급"'];
const KO_VERB = ['이라고 불러', '이라고 부른다', '라 부른다', '으로 불러', '로 불러 쓴다', '이라고 해줘', '님이라고 해', '으로 호칭한다', '', '이라고 부르지 마', '을 부른다'];
const KO_SUF = ['', '.', ', 사용자에게 결론만 보고한다', ' (2026-10-08 채택)', '. 줄여서 "유틸"이라고 부른다', ' 태그를 붙여'];
const EN = ['Call', 'Address', 'Refer to', 'Never call', 'Please address'].flatMap((v) => ['me', 'the user', 'the owner', 'the sprint'].flatMap((o) =>
  ['', ' as', ' by', ' as soon as', ' by phone', ' by the end of', ' only when', ','].flatMap((m) => [' Yugeon', ' "boss"', ' 「boss」', ' 「승인 대기」', ' first name', ' the approver', ''].flatMap((n) => ['', '.', ' if blocked'].map((e) => `- ${v} ${o}${m}${n}${e}`)))));
test('호칭 규칙 판정 — 지금 판정이 참이면 3394f000 판정도 참(새 오탐 0을 구조로)', () => {
  let n = 0;
  const check = (s) => { n += 1; if (hasAddressRule(s)) assert.equal(hasAddressRule3394(s), true, `3394에서 거짓인데 지금 참: ${s}`); };
  for (const s of [...CAUGHT, ...MISSED, ...NOT_RULE]) check(s);
  for (const p of KO_PRE) for (const j of KO_SUBJ) for (const nm of KO_NAME) for (const v of KO_VERB) for (const x of KO_SUF) check(`${p}${j}${nm}${v}${x}`);
  for (const s of EN) check(s);
  assert.ok(n > 50000, `조합 줄 수 ${n}`);
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

test('호칭 지시문 — 규칙이 있으면 이름 대신 "정한 규칙대로"(ko·en), 없으면 이름 줄·호칭 없음 줄 끝에 우선 문구', () => {
  assert.match(userAddressNote('유건', 'ko'), /이름은 "유건"/);
  for (const lang of ['ko', 'en']) {
    for (const name of ['유건', 'Yugeon', null, '']) {
      const note = userAddressNote(name, lang);
      assert.ok(note.endsWith(` ${USER_ADDRESS_NOTE.deferToRule[lang]}`), `${lang} ${name}: 끝에 우선 문구`);
      assert.equal(note.split(USER_ADDRESS_NOTE.deferToRule[lang]).length, 2, `${lang} ${name}: 한 번만`);
    }
    assert.ok(!userAddressNote('유건', lang, { ruled: true }).includes(USER_ADDRESS_NOTE.deferToRule[lang]), `${lang}: 규칙을 찾았으면 그 규칙을 따르라는 줄만`);
  }
  assert.equal(USER_ADDRESS_NOTE.deferToRule.ko, "단, 사용자가 카드의 '일하는 방식'이나 회사 규칙(사용자 지침)에서 호칭을 따로 정했으면 그 규칙을 따른다.");
  assert.doesNotMatch(userAddressNote('유건', 'ko', { ruled: true }), /유건/);
  assert.match(userAddressNote('유건', 'ko', { ruled: true }), /직접 정한 규칙/);
  assert.match(userAddressNote('Yugeon', 'en', { ruled: true }), /rule they set/);
  assert.doesNotMatch(userAddressNote('Yugeon', 'en', { ruled: true }), /Yugeon/);
  assert.match(userAddressNote(null, 'ko'), /바로 말한다/);
});
