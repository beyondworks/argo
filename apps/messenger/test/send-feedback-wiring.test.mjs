// 통합 재검수 LOW(2026-10-05): 보낸 뒤 대기 표시의 배선 — 대화 화면 요소의 received·onCrewPosted·crewPosts 속성, 처음 본 시각 기록, 동명이인 검사 순서 —
// 를 지워도 실패하는 테스트가 없었다. App.jsx의 실제 코드(요소 속성 식·Channel 계산 줄·Composer send)를 꺼내 가짜 의존성으로 돌린다
// (agent-identity-app.test.mjs와 같은 방식). 속성을 지우면 Channel의 기본값(received = {}, onCrewPosted = () => {}, 화면 자체 기억)이 쓰여 결과가 달라진다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { awaitingReplies } from '../src/await-reply.mjs';
import { createCrewPostsMemory, lastAskedIds, typingKey, withoutKey } from '../src/typing-state.js';

const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const between = (from, to, at = 0) => { const s = app.indexOf(from, at); assert.ok(s >= 0, `찾지 못함: ${from}`); const e = app.indexOf(to, s + from.length); assert.ok(e > s, `끝을 찾지 못함: ${to}`); return app.slice(s, e + to.length); };
// <Channel key={chId} …/> 요소의 속성 식 하나(중괄호 짝 맞춤). 없으면 undefined — Channel 기본값이 쓰인다.
const element = between('<Channel key={chId}', '\n'); // 요소는 한 줄(안에 다른 요소 <LegacyDmBar … />가 있어 ' />'로 자르면 중간에서 끊긴다)
function attr(name) {
  const at = element.indexOf(` ${name}={`); if (at < 0) return undefined;
  let i = at + name.length + 3; let depth = 1; const start = i;
  for (; i < element.length && depth; i++) { if (element[i] === '{') depth++; else if (element[i] === '}') depth--; }
  return element.slice(start, i - 1);
}
const evalIn = (expr, scope) => (expr === undefined ? undefined : new Function(...Object.keys(scope), `return (${expr});`)(...Object.values(scope)));

// 셸 쪽 실제 settleCrew(입력 중·진행·받음 표시를 내린다)
const settleSrc = between('const settleCrew = (payload) => {', '};');
function shell(chId) {
  const st = { typing: {}, progress: {}, received: {}, settled: {} };
  const set = (k) => (f) => { st[k] = typeof f === 'function' ? f(st[k]) : f; };
  const scope = { typingKey, withoutKey, settledRef: { current: st.settled }, setTyping: set('typing'), setProgress: set('progress'), setReceived: set('received'), typingStartRef: { current: {} } };
  const settleCrew = new Function(...Object.keys(scope), `${settleSrc}; return settleCrew;`)(...Object.values(scope));
  const crewPosts = createCrewPostsMemory();
  const props = () => ({
    received: evalIn(attr('received'), { received: st.received }) ?? {},
    onCrewPosted: evalIn(attr('onCrewPosted'), { settleCrew, chId }) ?? (() => {}),
    crewPosts: evalIn(attr('crewPosts'), { crewPosts }) ?? null,
  });
  return { st, props, crewPosts, settleCrew };
}
// Channel의 실제 '크루 글 → 입력 중 내리기' 효과 본문(셸 기억이 없으면 화면 자체 기억)
const postsLine = between('useEffect(() => { if (!msgs) return; for (const c of postsMem.read(', '}, [msgs]);');
function channel({ props, chId, isDm = true, uid = 'u-me' }) {
  const ownPosts = createCrewPostsMemory(); const postsMem = props.crewPosts ?? ownPosts; // Channel: crewPosts ?? ownPosts
  return (msgs) => { const useEffect = (fn) => fn(); new Function('useEffect', 'msgs', 'postsMem', 'chId', 'lastAskedIds', 'uid', 'channel', 'onCrewPosted', postsLine)(useEffect, msgs, postsMem, chId, lastAskedIds, uid, { kind: isDm ? 'dm' : 'public' }, props.onCrewPosted); };
}
const ME = 'u-me', P = 'c-p', CH = 'dm-1';
const mine = (id, created) => ({ id, author_kind: 'user', author_user_id: ME, crew_id: null, kind: 'text', body: 'hi', mentions: [], reply_to: null, created_at: new Date(created).toISOString(), deleted_at: null });
const crew = (id) => ({ id, author_kind: 'crew', crew_id: P, kind: 'text', body: '답', mentions: [] });

test('답이 방송 없이(재연결로 다시 읽어) 들어오면 입력 중을 내린다 — onCrewPosted 속성이 셸의 settleCrew로 이어진다', () => {
  const s = shell(CH); s.st.typing[`${CH}:${P}`] = Date.now();
  const run = channel({ props: s.props(), chId: CH });
  run([mine(10, Date.now())]);
  run([mine(10, Date.now()), crew(11)]); // 재연결 따라잡기로 읽은 답
  assert.equal(s.st.typing[`${CH}:${P}`], undefined, '입력 중이 내려갔다');
});

test('방을 다시 열어도 셸 기억(crewPosts 속성)을 써서, 떠나 있는 동안 방송으로 받아 이미 내린 답으로 새 턴의 입력 중을 또 내리지 않는다', () => {
  const s = shell(CH);
  channel({ props: s.props(), chId: CH })([mine(10, Date.now())]); // 처음 열기
  // 다른 방에 있는 동안 답 방송을 받았다 — 셸 handleMessage의 실제 크루 글 처리 줄(입력 중을 내리고 방 기억의 기준을 올린다)
  const crewLine = between("    if (payload?.author_kind === 'crew' && payload.crew_id) { crewActive(payload.crew_id);", '\n');
  new Function('payload', 'crewActive', 'settleCrew', 'crewPosts', 'setDoneAt', crewLine)({ id: 11, channel_id: CH, author_kind: 'crew', crew_id: P }, () => {}, s.settleCrew, s.crewPosts, () => {});
  s.st.typing[`${CH}:${P}`] = Date.now(); // 그 크루가 곧바로 다음 일을 시작했다
  channel({ props: s.props(), chId: CH })([mine(10, Date.now()), crew(11)]); // 다시 연다(Channel 재생성)
  assert.ok(s.st.typing[`${CH}:${P}`], '새 턴의 입력 중은 남는다');
});

// Channel의 실제 처음 본 시각 기록 + 대기 표시 계산 두 줄
const awaitSrc = between('  for (const m of msgs ?? []) if (m.author_user_id === uid && Number.isFinite(m.id) && !seenAtRef.current.has(m.id))', '.filter((a) => a.crew);');
function awaitingIn({ props, msgs, typing = {}, away = false, now }) {
  const realNow = Date.now; Date.now = () => now;
  try {
    const scope = { msgs, uid: ME, channel: { kind: 'dm' }, chCrews: [{ id: P }], chId: CH, typing, progress: {}, received: props.received, crewAway: () => away, crewOf: (id) => ({ id }), seenAtRef: props.seenAtRef, awaitingReplies };
    return new Function(...Object.keys(scope), `${awaitSrc}; return awaiting;`)(...Object.values(scope));
  } finally { Date.now = realNow; }
}

test('received 속성 — 게이트웨이가 받았다는 신호가 대화 화면에 닿아, 꺼짐 안내 대신 준비 중으로 보인다', () => {
  const s = shell(CH); const T = Date.parse('2026-10-05T03:00:00Z');
  s.st.received[`${CH}:${P}`] = T + 800;
  const a = awaitingIn({ props: { ...s.props(), seenAtRef: { current: new Map() } }, msgs: [mine(10, T)], away: true, now: T + 1000 });
  assert.equal(a[0].phase, 'preparing');
});

test('처음 본 시각 기록 — 기기 시계가 서버보다 10초 늦어도, 글을 본 뒤 온 입력 중 방송은 답변 중으로 친다', () => {
  const s = shell(CH); const serverT = Date.parse('2026-10-05T03:00:00Z'); const deviceT = serverT - 10_000; const seenAtRef = { current: new Map() };
  awaitingIn({ props: { ...s.props(), seenAtRef }, msgs: [mine(10, serverT)], now: deviceT }); // 이 기기가 글을 처음 본 렌더
  const a = awaitingIn({ props: { ...s.props(), seenAtRef }, msgs: [mine(10, serverT)], typing: { [`${CH}:${P}`]: deviceT + 2000 }, now: deviceT + 3000 });
  assert.equal(a[0].phase, 'answering');
});

// Composer의 실제 send — 실패한 글이 있으면 그 글부터 다시 보내고, 그 뒤 새 글의 동명이인을 검사한다
const sendSrc = between('  const send = async () => {', '\n  };');
test('실패한 글이 있고 새 글에 같은 이름이 둘이면 — 재전송은 나가고 새 글은 멈춘다(동명이인 안내)', async () => {
  const seen = [];
  const delivery = { retry: async () => { seen.push('retry'); return true; }, snapshot: () => ({ lastDeliveredId: 77, job: null }), send: () => { seen.push('send'); return Promise.resolve(true); } };
  const scope = { locked: false, busy: false, deliveryBlocked: false, rolePick: null, job: { clientId: 'old', messageId: null, files: [] }, retryBlocked: false, delivery,
    onSent: (id) => seen.push(`sent:${id}`), text: '@Kim 확인해 주세요', files: [], uid: ME, mentions: [], byName: [{ kind: 'crew', id: 'a', name: 'Kim' }, { kind: 'crew', id: 'b', name: 'kim' }],
    ambiguousMentions: (text, list) => (list.filter((x) => text.toLowerCase().includes(`@${x.name.toLowerCase()}`)).length > 1 ? ['Kim'] : []),
    setAmbiguous: (v) => seen.push(`ambiguous:${v}`), haptic: () => {}, mentionsFromBody: () => [], allByName: [], crews: [], crewAway: () => false, outsideCrewMentions: () => [],
    dmDeliveryMentions: (x) => x, recipients: [], onPending: () => seen.push('pending'), setPop: () => {}, ta: { current: null }, onPendingSettled: () => {}, setAwayNote: () => {}, setOutside: () => {} };
  const send = new Function(...Object.keys(scope), `${sendSrc}; return send;`)(...Object.values(scope));
  await send();
  assert.deepEqual(seen, ['retry', 'sent:77', 'ambiguous:Kim'], '재전송 → 보냄 알림 → 동명이인 안내, 새 글은 보내지 않는다');
});
