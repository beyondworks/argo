// 보낸 뒤 반응 없음(2026-10-05 운영 실측: 턴은 2초 뒤 시작했는데 사용자는 "1분 반응 없음 → 답변 중 → 사라지고 30초 뒤 답"을 겪었다).
// 크루를 겨냥한 내 글이 저장되면 그 즉시 "전달됨 · 준비 중"이 뜨고, 그 크루가 내 글 뒤에 글을 올릴 때까지(상한 5분) 남는다.
// 방송이 오면 '답변 중', 끊겨도 사라지지 않고, 30초 동안 신호가 없으면 '조금 오래', 기기가 꺼져 있으면 '꺼져 있어 기다리는 중'.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { awaitingReplies, awaitTargets, AWAIT_MAX_MS, AWAIT_SLOW_MS } from '../src/await-reply.mjs';

const ME = 'u-me', OTHER = 'u-other', PEPPER = 'c-pepper', EDNA = 'c-edna';
const T0 = Date.parse('2026-10-05T02:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const mine = (id, over = {}) => ({ id, author_kind: 'user', author_user_id: ME, crew_id: null, kind: 'text', body: 'hi', mentions: [], reply_to: null, created_at: iso(T0), deleted_at: null, ...over });
const crewMsg = (id, crew, over = {}) => ({ id, author_kind: 'crew', author_user_id: null, crew_id: crew, kind: 'text', body: '답', mentions: [], reply_to: null, created_at: iso(T0 + 5000), deleted_at: null, ...over });
const none = () => ({});
const run = ({ msgs, isDm = true, roomCrewIds = [PEPPER], signals = none, away = () => false, now = T0 + 1000 }) =>
  awaitingReplies({ msgs, uid: ME, isDm, roomCrewIds, signals, away, now });

test('크루 1:1 방: 내 글이 저장되면 그 즉시 준비 중, 그 크루가 뒤에 글을 올리면 사라진다', () => {
  assert.deepEqual(run({ msgs: [mine(10)] }), [{ crewId: PEPPER, msgId: 10, phase: 'preparing' }]);
  assert.deepEqual(run({ msgs: [mine(10), crewMsg(11, PEPPER)] }), []);
  assert.deepEqual(run({ msgs: [mine(10), crewMsg(11, PEPPER, { kind: 'system', body: '실패 안내' })] }), [], '실패·거절 안내(시스템 글)도 답으로 친다');
  assert.deepEqual(run({ msgs: [crewMsg(9, PEPPER), mine(10)] }), [{ crewId: PEPPER, msgId: 10, phase: 'preparing' }], '내 글 앞의 크루 글은 답이 아니다');
});

test('입력 중·진행 방송이 오면 답변 중, 방송이 끊겨도 30초까지는 답변 중으로 남는다', () => {
  const at = (typingAt) => () => ({ typingAt });
  assert.equal(run({ msgs: [mine(10)], signals: at(T0 + 2000), now: T0 + 3000 })[0].phase, 'answering');
  assert.equal(run({ msgs: [mine(10)], signals: () => ({ progressAt: T0 + 2000 }), now: T0 + 3000 })[0].phase, 'answering');
  assert.equal(run({ msgs: [mine(10)], signals: at(T0 + 2000), now: T0 + 2000 + 25_000 })[0].phase, 'answering', '방송이 25초 끊겨도 표시는 남는다');
  assert.equal(run({ msgs: [mine(10)], signals: at(T0 + 2000), now: T0 + 2000 + AWAIT_SLOW_MS + 1 })[0].phase, 'slow', '30초 무신호 = 조금 오래');
});

test('켜져 있는데 30초 동안 아무 신호가 없으면 조금 오래 — 표시는 계속', () => {
  assert.equal(run({ msgs: [mine(10)], now: T0 + 29_000 })[0].phase, 'preparing');
  assert.equal(run({ msgs: [mine(10)], now: T0 + 31_000 })[0].phase, 'slow');
  assert.equal(run({ msgs: [mine(10)], signals: () => ({ receivedAt: T0 + 20_000 }), now: T0 + 40_000 })[0].phase, 'preparing', '받음 신호도 30초 시계를 다시 잰다(아직 답변 중은 아님)');
});

test('기기가 꺼져 있으면(접속 90초 넘음) 바로 꺼짐 안내, 신호가 오면 꺼짐이 아니다', () => {
  const off = () => true;
  assert.equal(run({ msgs: [mine(10)], away: off })[0].phase, 'offline');
  assert.equal(run({ msgs: [mine(10)], away: off, now: T0 + 60_000 })[0].phase, 'offline');
  assert.equal(run({ msgs: [mine(10)], away: off, signals: () => ({ typingAt: T0 + 500 }) })[0].phase, 'answering');
  assert.equal(run({ msgs: [mine(10)], away: off, signals: () => ({ receivedAt: T0 + 500 }) })[0].phase, 'preparing');
});

test('상한 5분 — 넘으면 표시를 내린다', () => {
  assert.equal(run({ msgs: [mine(10)], now: T0 + AWAIT_MAX_MS - 1 }).length, 1);
  assert.deepEqual(run({ msgs: [mine(10)], now: T0 + AWAIT_MAX_MS + 1 }), []);
});

test('내 글보다 앞선 옛 방송(지난 턴 잔여)은 신호로 치지 않는다', () => {
  assert.equal(run({ msgs: [mine(10)], signals: () => ({ typingAt: T0 - 60_000 }), now: T0 + 1000 })[0].phase, 'preparing');
});

test('대상 — 서버 targetsCrew와 같은 규칙: 멘션(to)·1:1 방·크루 글에 단 답글. 참조(cc)·사람 멘션·남의 글·보내는 중인 글은 아니다', () => {
  const room = [PEPPER, EDNA];
  assert.deepEqual(awaitTargets(mine(1, { mentions: [{ kind: 'crew', id: EDNA }] }), { uid: ME, isDm: false, roomCrewIds: room }), [EDNA]);
  assert.deepEqual(awaitTargets(mine(1), { uid: ME, isDm: false, roomCrewIds: room }), [], '채널에서 멘션 없는 글은 아무도 겨냥하지 않는다');
  assert.deepEqual(awaitTargets(mine(1, { mentions: [{ kind: 'crew', id: EDNA, role: 'cc' }] }), { uid: ME, isDm: true, roomCrewIds: [PEPPER] }), [PEPPER], '1:1에서 참조만 있으면 상대 크루가 답한다');
  assert.deepEqual(awaitTargets(mine(1, { mentions: [{ kind: 'crew', id: EDNA, role: 'cc' }] }), { uid: ME, isDm: false, roomCrewIds: room }), []);
  assert.deepEqual(awaitTargets(mine(1, { mentions: [{ kind: 'crew', id: EDNA, role: 'to' }] }), { uid: ME, isDm: true, roomCrewIds: room }), [EDNA], '1:1에서 받는이를 정하면 그 크루만');
  assert.deepEqual(awaitTargets(mine(1, { mentions: [{ kind: 'user', id: OTHER }] }), { uid: ME, isDm: false, roomCrewIds: room }), []);
  assert.deepEqual(awaitTargets(mine(1, { author_user_id: OTHER }), { uid: ME, isDm: true, roomCrewIds: room }), [], '남의 글');
  assert.deepEqual(awaitTargets(mine(1, { pending: true }), { uid: ME, isDm: true, roomCrewIds: room }), [], '저장 전');
  assert.deepEqual(awaitTargets(mine(1, { kind: 'system' }), { uid: ME, isDm: true, roomCrewIds: room }), []);
  assert.deepEqual(awaitTargets(mine(1, { deleted_at: iso(T0) }), { uid: ME, isDm: true, roomCrewIds: room }), []);
  assert.deepEqual(awaitTargets(mine(1, { mentions: [{ kind: 'crew', id: 'c-outside' }] }), { uid: ME, isDm: false, roomCrewIds: room }), [], '방 밖 크루는 답하지 않는다');
  const parent = crewMsg(5, EDNA);
  assert.deepEqual(awaitTargets(mine(6, { reply_to: 5 }), { uid: ME, isDm: false, roomCrewIds: room, parentOf: (id) => (id === 5 ? parent : null) }), [EDNA], '크루 글에 단 답글');
});

test('같은 크루에 여러 번 보내면 마지막 글 하나만, 여러 크루 멘션이면 크루마다 하나', () => {
  const msgs = [mine(10), mine(12, { mentions: [{ kind: 'crew', id: PEPPER }, { kind: 'crew', id: EDNA }] })];
  const r = run({ msgs, isDm: false, roomCrewIds: [PEPPER, EDNA] });
  assert.deepEqual(r.map((x) => [x.crewId, x.msgId]), [[PEPPER, 12], [EDNA, 12]]);
  const after = run({ msgs: [...msgs, crewMsg(13, EDNA)], isDm: false, roomCrewIds: [PEPPER, EDNA] });
  assert.deepEqual(after.map((x) => x.crewId), [PEPPER], '답한 크루만 내린다');
});
