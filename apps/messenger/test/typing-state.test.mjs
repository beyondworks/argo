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
