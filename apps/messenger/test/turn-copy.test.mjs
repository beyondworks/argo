// 턴 전체 복사(유건 2026-10-02 "한 덩어리를 한 턴으로 치고 그 아래에만 복사 표시") — 무엇이 복사되는지 행동으로 잠근다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { turnCopyText, tailTurns } from '../src/turn-copy.mjs';
import { groupFlags } from '../src/msg-group.mjs';

const at = (s) => `2026-10-02T10:00:${String(s).padStart(2, '0')}Z`;
const msg = (id, body, extra = {}) => ({ id, author_kind: 'user', author_user_id: 'u1', kind: 'text', body, created_at: at(id), edited_at: null, deleted_at: null, ...extra });

test('글 3개 턴 — 순서대로, 글 사이는 빈 줄 하나', () => {
  assert.equal(turnCopyText([msg(1, '첫째'), msg(2, '둘째'), msg(3, '셋째')]), '첫째\n\n둘째\n\n셋째');
});

test('지운 글·시스템 글·결재 카드·첨부만 있는 글은 빠진다', () => {
  const list = [msg(1, '첫째'), msg(2, '', { deleted_at: at(9) }), msg(3, ''), msg(4, '   '), msg(5, '알림', { kind: 'system' }), msg(6, '결재 본문', { kind: 'approval_card' }), msg(7, '마지막\n두 줄')];
  assert.equal(turnCopyText(list), '첫째\n\n마지막\n두 줄');
});

test('본문이 하나도 없으면 빈 문자열(버튼을 그리지 않는다)', () => {
  assert.equal(turnCopyText([msg(1, ''), msg(2, 'x', { deleted_at: at(9) })]), '');
});

test('턴은 지금의 묶음(groupFlags) 그대로 — 마지막 글만 턴 전체를 받는다', () => {
  const list = [msg(1, 'a'), msg(2, 'b'), msg(3, ''), msg(4, 'c', { author_user_id: 'u2' }), msg(5, 'd', { author_user_id: 'u2' })];
  const turns = tailTurns(list, groupFlags(list));
  assert.deepEqual(turns.map((t) => t && t.map((m) => m.id)), [null, null, [1, 2, 3], null, [4, 5]]);
  assert.equal(turnCopyText(turns[2]), 'a\n\nb');
  assert.equal(turnCopyText(turns[4]), 'c\n\nd');
});

test("'새 메시지' 줄에서 끊긴 묶음은 따로 복사된다", () => {
  const list = [msg(1, 'a'), msg(2, 'b'), msg(3, 'c')];
  const turns = tailTurns(list, groupFlags(list, (i) => i === 2));
  assert.deepEqual(turns.map((t) => t && t.map((m) => m.id)), [null, [1, 2], [3]]);
});
