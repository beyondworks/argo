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
test('방에 그 크루의 새 글이 생기면(어느 경로든) 그 크루를 내릴 대상으로 낸다 — 처음 읽을 때는 기록만', async () => {
  const { crewPostsChanged } = await import('../src/typing-state.js');
  const m = (id, crew_id) => ({ id, author_kind: 'crew', crew_id });
  const first = crewPostsChanged(null, [m(1, 'a'), { id: 2, author_kind: 'user' }]);
  assert.deepEqual(first.changed, [], '처음 읽은 목록은 비교 대상이 없다');
  const second = crewPostsChanged(first.next, [m(1, 'a'), m(3, 'a'), m(4, 'b')]);
  assert.deepEqual(second.changed.sort(), ['a', 'b']);
  const same = crewPostsChanged(second.next, [m(1, 'a'), m(3, 'a'), m(4, 'b')]);
  assert.deepEqual(same.changed, []);
});

test('답 뒤 늦게 온 방송을 무시하는 시간은 서버 4초 주기 + 지연을 덮는 6초', async () => {
  const { acceptTyping, SETTLE_IGNORE_MS } = await import('../src/typing-state.js');
  assert.equal(SETTLE_IGNORE_MS, 6000);
  const settled = { 'ch:c': 1000 };
  assert.equal(acceptTyping(settled, { channel_id: 'ch', crew_id: 'c' }, 1000 + 2200), false, '답 2.2초 뒤 방송은 버린다(검수 재현값)');
  assert.equal(acceptTyping(settled, { channel_id: 'ch', crew_id: 'c' }, 1000 + 6000), true);
});

test('크루 글 비교는 목록 순서 기준 — 숫자 id 9 → 10도 바뀐 것으로 본다', async () => {
  const { crewPostsChanged } = await import('../src/typing-state.js');
  const a = crewPostsChanged(null, [{ id: 9, author_kind: 'crew', crew_id: 'p' }]);
  assert.deepEqual(crewPostsChanged(a.next, [{ id: 9, author_kind: 'crew', crew_id: 'p' }, { id: 10, author_kind: 'crew', crew_id: 'p' }]).changed, ['p']);
});
