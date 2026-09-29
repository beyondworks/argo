// 연속 메시지 묶음 — 유건 2026-09-29: 메시지마다 이름·역할·아바타·시간이 반복돼 상용 메신저와 이질감이 컸다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sameGroup, groupFlags } from '../src/msg-group.mjs';

const at = (min) => new Date(Date.UTC(2026, 8, 28, 3, 0) + min * 60000).toISOString();
const crew = (id, min, extra = {}) => ({ author_kind: 'crew', crew_id: id, author_user_id: null, kind: 'text', created_at: at(min), ...extra });
const user = (id, min, extra = {}) => ({ author_kind: 'user', author_user_id: id, crew_id: null, kind: 'text', created_at: at(min), ...extra });

test('같은 보낸이·5분 안이면 묶고, 5분을 넘거나 보낸이가 바뀌면 끊는다', () => {
  assert.equal(sameGroup(crew('a', 0), crew('a', 5)), true, '정확히 5분은 묶음');
  assert.equal(sameGroup(crew('a', 0), crew('a', 5.02)), false, '5분 1초는 새 묶음');
  assert.equal(sameGroup(crew('a', 0), crew('b', 1)), false, '다른 크루');
  assert.equal(sameGroup(user('u', 0), crew('u', 1)), false, '같은 id라도 사람과 크루는 다른 보낸이');
});

test('시스템·결재 카드·지운 글은 묶지 않는다', () => {
  assert.equal(sameGroup(crew('a', 0), crew('a', 1, { kind: 'approval_card' })), false);
  assert.equal(sameGroup(crew('a', 0, { kind: 'system' }), crew('a', 1)), false);
  assert.equal(sameGroup(crew('a', 0), crew('a', 1, { deleted_at: at(2) })), false);
});

test('날짜가 바뀌면 5분 안이어도 끊는다', () => {
  const a = { ...crew('a', 0), created_at: new Date(2026, 8, 28, 23, 58).toISOString() };
  const b = { ...crew('a', 0), created_at: new Date(2026, 8, 29, 0, 1).toISOString() };
  assert.equal(sameGroup(a, b), false);
});

test('groupFlags — 첫 글만 머리, 마지막 글만 꼬리, 끊는 자리(새 메시지 줄)에서 새 묶음', () => {
  const list = [crew('a', 0), crew('a', 1), crew('a', 2), user('u', 3), user('u', 4), crew('a', 5)];
  assert.deepEqual(groupFlags(list).map((f) => [f.cont, f.tail]), [[false, false], [true, false], [true, true], [false, false], [true, true], [false, true]]);
  const cut = groupFlags(list, (i) => i === 2); // 셋째 글 앞에 "새 메시지" 줄
  assert.deepEqual(cut.map((f) => [f.cont, f.tail]).slice(0, 3), [[false, false], [true, true], [false, true]]);
});

// 검수 MEDIUM-3: 묶인 글은 머리(.who)·꼬리(.meta)를 숨겨 '편집됨' 표시까지 사라졌다 — 편집된 글은 앞뒤로 끊어 표시가 남게 한다.
test('편집된 글은 묶지 않는다(앞 글과도, 뒤 글과도)', () => {
  assert.equal(sameGroup(crew('a', 0), crew('a', 1, { edited_at: at(2) })), false);
  assert.equal(sameGroup(crew('a', 0, { edited_at: at(2) }), crew('a', 1)), false);
});
