// 목록의 '답변 중' 표시(유건 2026-09-23 "다른 페이지에 있어도 구분") — 비공개 방 typing은 dm:<방> 토픽으로만 오므로 열린 방만이 아니라 방 전체를 구독한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { roomTopicIds, typingIn } from '../src/typing-state.js';

const ch = (id, kind) => ({ id, kind });
test('조직: 비공개 방만, 공개 채널은 org: 토픽이라 뺀다 · 개인 공간: 전부', () => {
  const list = [ch('p1', 'public'), ch('d1', 'dm'), ch('x1', 'private')];
  assert.deepEqual(roomTopicIds(list, 'p1', false), ['d1', 'x1']);
  assert.deepEqual(roomTopicIds(list, null, true), ['d1', 'p1', 'x1']);
});
test('상한을 넘으면 최근 대화·최근 방 우선(옛 방부터 채우지 않는다 — 검수 #690 M1)', () => {
  const list = Array.from({ length: 60 }, (_, i) => ch(`d${String(i).padStart(2, '0')}`, 'dm'));
  const ids = roomTopicIds(list, null, false, 50, { d00: 999 });
  assert.ok(ids.includes('d00'), '가장 옛 방이라도 최근 대화면 포함');
  assert.ok(ids.includes('d59') && !ids.includes('d01'), '그다음은 최근에 만든 방');
});
test('상한을 넘어도 열린 방은 남는다', () => {
  const list = Array.from({ length: 60 }, (_, i) => ch(`d${String(i).padStart(2, '0')}`, 'dm'));
  const ids = roomTopicIds(list, 'd59', false);
  assert.equal(ids.length, 50); assert.ok(ids.includes('d59'));
});
test('typing 6초 창 — 그 방 크루만, 지나면 꺼진다', () => {
  const now = 10_000;
  assert.equal(typingIn({ 'd1:c1': now - 5999 }, 'd1', now), true);
  assert.equal(typingIn({ 'd1:c1': now - 6000 }, 'd1', now), false);
  assert.equal(typingIn({ 'd10:c1': now }, 'd1', now), false, '접두 겹치는 다른 방');
});
