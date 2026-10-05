// 유건 제보(2026-09-23): 에이전트 답변 뒤에 '입력 중' 창이 하나 더 떴다가 사라진다 — 앱이 답글 도착 때 표시를 지우지 않고 6~8초 만료만 기다렸다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { acceptTyping, withoutKey, typingKey, SETTLE_IGNORE_MS } from '../src/typing-state.js';

const p = { channel_id: 'ch1', crew_id: 'cr1' };

test('답글 직후 늦게 온 typing·progress 방송은 받아들이지 않고, 시간창이 지나면 다시 받는다', () => {
  const settled = { [typingKey(p)]: 1000 };
  assert.equal(acceptTyping(settled, p, 1000 + SETTLE_IGNORE_MS - 1), false);
  assert.equal(acceptTyping(settled, p, 1000 + SETTLE_IGNORE_MS), true);
  assert.equal(acceptTyping(settled, { channel_id: 'ch1', crew_id: 'other' }, 1001), true, '다른 크루의 표시까지 막았다');
  assert.equal(acceptTyping({}, p, 5), true);
});

test('답글 도착 시 그 크루 키만 표시 목록에서 빠진다', () => {
  const m = { 'ch1:cr1': 1, 'ch1:cr2': 2 };
  assert.deepEqual(withoutKey(m, 'ch1:cr1'), { 'ch1:cr2': 2 });
  assert.equal(withoutKey(m, 'none'), m, '바뀐 게 없으면 원본(불필요한 렌더 없음)');
});

test('App.jsx 배선 — 크루 글 도착이 표시를 지우고, typing·progress 네 처리기(org·dm 토픽)가 모두 같은 거름망을 쓴다', () => {
  const src = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(src, /author_kind === 'crew'[^\n]*settleCrew\(payload\)/, '크루 글 도착 때 표시를 지우는 호출이 없다');
  assert.equal((src.match(/event: 'typing' \}[^\n]*onTypingEvent/g) ?? []).length, 2, 'typing 처리기 중 거름망을 안 쓰는 곳이 있다');
  assert.equal((src.match(/event: 'progress' \}[^\n]*onProgressEvent/g) ?? []).length, 2, 'progress 처리기 중 거름망을 안 쓰는 곳이 있다');
});

// 분리 검수 #send-feedback MEDIUM(2026-10-05): 답이 방송 없이(재연결·복귀·새로고침으로 다시 읽어서) 들어와도 그 크루의 '입력 중'을 내린다.
test('방에 그 크루의 새 글이 생기면(어느 경로든) 그 크루를 내릴 대상으로 낸다 — 처음 읽은 목록은 기록만', async () => {
  const { createCrewPostsMemory } = await import('../src/typing-state.js');
  const m = (id, crew_id) => ({ id, author_kind: 'crew', crew_id });
  const mem = createCrewPostsMemory();
  assert.deepEqual(mem.read('ch', [{ id: 0.5, author_kind: 'user' }, m(1, 'a')]), [], '처음 읽은 목록은 기록만');
  assert.deepEqual(mem.read('ch', [{ id: 0.5, author_kind: 'user' }, m(1, 'a'), m(3, 'a'), m(4, 'b')]).sort(), ['a', 'b'], '두 크루가 함께 답했다 — 서로의 글은 상대를 부르지 않았다');
  assert.deepEqual(mem.read('ch', [m(1, 'a'), m(3, 'a'), m(4, 'b')]), []);
});
test('답 뒤 늦게 온 방송을 무시하는 시간은 서버 4초 주기 + 지연을 덮는 6초', async () => {
  const { acceptTyping, SETTLE_IGNORE_MS } = await import('../src/typing-state.js');
  assert.equal(SETTLE_IGNORE_MS, 6000);
  const settled = { 'ch:c': 1000 };
  assert.equal(acceptTyping(settled, { channel_id: 'ch', crew_id: 'c' }, 1000 + 2200), false, '답 2.2초 뒤 방송은 버린다(검수 재현값)');
  assert.equal(acceptTyping(settled, { channel_id: 'ch', crew_id: 'c' }, 1000 + 6000), true);
});

test('크루 글 비교는 숫자 id 기준 — 9 → 10도 바뀐 것으로 본다', async () => {
  const { createCrewPostsMemory } = await import('../src/typing-state.js');
  const mem = createCrewPostsMemory();
  mem.read('ch', [{ id: 9, author_kind: 'crew', crew_id: 'p' }]);
  assert.deepEqual(mem.read('ch', [{ id: 9, author_kind: 'crew', crew_id: 'p' }, { id: 10, author_kind: 'crew', crew_id: 'p' }]), ['p']);
});

// 통합 재검수 MEDIUM(2026-10-05): 크루별 마지막 글 기록이 방(Channel key={chId}) 안이라 방을 바꾸면 사라졌다. 방 밖에서 답 방송이 유실되면
// 다시 연 방에서 그 답이 목록에 있어도 '입력 중'이 최대 20초 남았다(재검수 캡처 h-ghost-typing.png). 기록은 셸에 방별로 둔다.
test('방을 다시 열면(Channel 재생성) 떠나 있는 동안 온 크루 답으로 입력 중을 내린다 — 답 방송이 유실된 경우', async () => {
  const { createCrewPostsMemory } = await import('../src/typing-state.js');
  const mine = (id) => ({ id, author_kind: 'user', author_user_id: 'u-me', mentions: [] }); const crew = (id, c) => ({ id, author_kind: 'crew', crew_id: c });
  const mem = createCrewPostsMemory();
  const first = [mine(1), crew(2, 'p'), mine(3)];
  assert.deepEqual(mem.read('dm-1', first), [], '처음 열 때는 기록만');
  // 다른 방으로 갔다가(Channel 언마운트) — 그 사이 크루 답(4)의 방송이 유실 — 다시 연다(새 Channel)
  const reopened = [...first, crew(4, 'p')];
  assert.deepEqual(mem.read('dm-1', reopened), ['p']);
  assert.deepEqual(mem.read('dm-1', reopened), [], '같은 목록을 다시 읽으면 바뀐 것이 없다');
});

// 분리 검수 M1(2026-10-05, 206f60cd 회귀): 처음 여는 단체 방·그룹 DM에서 '내가 겨냥한 글'만 기준으로 삼아, 다른 사람이 부른 크루의
// 입력 중·실행 카드·받음 표시가 사라지고 6초 동안 방송도 버렸다(재현: 페퍼 옛 답 10, 밥이 20에서 @페퍼, 내가 처음 연다 → ['pepper']).
const ME = 'u-me', BOB = 'u-bob';
const said = (id, who, over = {}) => ({ id, author_kind: 'user', author_user_id: who, mentions: [], ...over });
const crewSaid = (id, c, over = {}) => ({ id, author_kind: 'crew', crew_id: c, mentions: [], ...over });
test('처음 여는 단체 방 — 다른 사람이 부른 크루의 입력 중을 내리지 않는다(검수 M1 재현)', async () => {
  const { createCrewPostsMemory } = await import('../src/typing-state.js');
  const mem = createCrewPostsMemory();
  assert.deepEqual(mem.read('ch-1', [crewSaid(10, 'pepper'), said(20, BOB, { mentions: [{ kind: 'crew', id: 'pepper' }] })]), []);
});
test('다시 연 단체 방 — 떠나 있는 동안 온 답(방송 유실) 뒤에 다른 사람이 그 크루를 다시 불렀으면 내리지 않는다', async () => {
  const { createCrewPostsMemory } = await import('../src/typing-state.js');
  const mem = createCrewPostsMemory();
  mem.read('ch-1', [said(5, ME, { mentions: [{ kind: 'crew', id: 'pepper' }] }), crewSaid(10, 'pepper')]);
  const back = [said(5, ME, { mentions: [{ kind: 'crew', id: 'pepper' }] }), crewSaid(10, 'pepper'), crewSaid(25, 'pepper'), said(30, BOB, { mentions: [{ kind: 'crew', id: 'pepper' }] })];
  assert.deepEqual(mem.read('ch-1', back), [], '밥의 30이 페퍼를 다시 불렀다 — 지금 답하는 중일 수 있다');
});
test('그룹 DM(kind=dm, 사람 셋) — 멘션 없는 다른 사람 글도 방의 크루를 부른 것으로 본다', async () => {
  const { createCrewPostsMemory } = await import('../src/typing-state.js');
  const mem = createCrewPostsMemory();
  mem.read('gdm', [said(1, ME), crewSaid(2, 'pepper')]);
  assert.deepEqual(mem.read('gdm', [said(1, ME), crewSaid(2, 'pepper'), crewSaid(25, 'pepper'), said(30, BOB)]), [], '밥의 멘션 없는 30');
  assert.deepEqual(mem.read('gdm', [said(1, ME), crewSaid(2, 'pepper'), crewSaid(25, 'pepper'), said(30, BOB), crewSaid(31, 'pepper')]), ['pepper'], '그 뒤 답(31)이 오면 내린다');
});
test('다른 크루가 넘긴 일(@넘김·그 크루 글에 단 답) 뒤의 옛 글로는 내리지 않는다 — 넘김을 받지 않은 크루 글은 상관없다', async () => {
  const { createCrewPostsMemory } = await import('../src/typing-state.js');
  const mem = createCrewPostsMemory();
  mem.read('ch', [said(1, ME), crewSaid(2, 'b')]);
  assert.deepEqual(mem.read('ch', [said(1, ME), crewSaid(2, 'b'), crewSaid(5, 'b'), crewSaid(6, 'a', { mentions: [{ kind: 'crew', id: 'b' }] })]), ['a'], 'a가 b를 불렀다 — a 자신의 새 글은 내린다');
  mem.read('ch2', [said(1, ME), crewSaid(2, 'b')]);
  assert.deepEqual(mem.read('ch2', [said(1, ME), crewSaid(2, 'b'), crewSaid(5, 'b'), crewSaid(6, 'a', { reply_to: 5 })]), ['a'], 'a가 b의 글에 답했다');
  mem.read('ch3', [said(1, ME), crewSaid(2, 'b')]);
  assert.deepEqual(mem.read('ch3', [said(1, ME), crewSaid(2, 'b'), crewSaid(5, 'b'), crewSaid(6, 'a')]).sort(), ['a', 'b'], 'a의 글은 b를 부르지 않았다');
});

test('방 밖에서 받은 크루 글 방송(heard)은 다시 연 방의 비교 기준에 들어간다 — 같은 답으로 두 번 내리지 않는다', async () => {
  const { createCrewPostsMemory } = await import('../src/typing-state.js');
  const mine = (id) => ({ id, author_kind: 'user', author_user_id: 'u-me', mentions: [] }); const crew = (id, c) => ({ id, author_kind: 'crew', crew_id: c });
  const mem = createCrewPostsMemory();
  mem.read('dm-1', [mine(1)]);
  mem.heard('dm-1', 'p', 2); // 다른 방에 있는 동안 답 방송을 받았다(셸이 이미 내렸다)
  assert.deepEqual(mem.read('dm-1', [mine(1), crew(2, 'p')]), []);
});
