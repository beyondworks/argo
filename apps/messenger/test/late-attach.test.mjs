// 늦은 첨부 되찾기(C-a, 2026-10-08) — 놓친 'attach' 방송을 다시 붙음·끊긴 동안의 보정 조회에서만 되찾는다(주기 조회 없음).
import test from 'node:test';
import assert from 'node:assert/strict';
import { lateAttachCandidates, mergeAttachments, LATE_ATTACH_WINDOW_MS, LATE_ATTACH_MAX } from '../src/late-attach.mjs';

const NOW = Date.parse('2026-10-08T15:10:00Z');
const at = (msAgo) => new Date(NOW - msAgo).toISOString();
const msg = (id, extra = {}) => ({ id, kind: 'text', body: 'x', created_at: at(60_000), deleted_at: null, ...extra });

test('빈 첨부로 읽힌 최근 글만 다시 읽는다 — 첨부가 있는 글·아직 못 읽은 글은 대상이 아니다', () => {
  const msgs = [msg(1), msg(2), msg(3)];
  const atts = { 1: [], 2: [{ id: 'a', message_id: 2 }] }; // 3은 못 읽음(빈 묶음 메우기 몫)
  assert.deepEqual(lateAttachCandidates(msgs, atts, { now: NOW }), [1]);
});

test('운영 사례 꼴 — 답(3798)이 빈 첨부로 읽힌 뒤 0.7초 늦게 붙은 파일은 다시 붙을 때 대상이 된다', () => {
  const reply = msg(3798, { body: 'download-test.md', author_kind: 'crew', created_at: at(4 * 60_000) });
  assert.deepEqual(lateAttachCandidates([reply], { 3798: [] }, { now: NOW }), [3798]);
});

test('기한(1시간)을 넘긴 글·지운 글·시스템 글·결재 카드·시각이 없는 글은 다시 읽지 않는다', () => {
  const msgs = [
    msg(1, { created_at: at(LATE_ATTACH_WINDOW_MS + 1) }),
    msg(2, { deleted_at: at(1000) }),
    msg(3, { kind: 'system' }),
    msg(4, { kind: 'approval_card' }),
    msg(5, { created_at: null }),
    msg(6, { created_at: at(LATE_ATTACH_WINDOW_MS - 1000) }),
  ];
  const atts = Object.fromEntries(msgs.map((m) => [m.id, []]));
  assert.deepEqual(lateAttachCandidates(msgs, atts, { now: NOW }), [6]);
});

test('대상이 없으면 빈 목록 — 부르는 쪽은 요청을 내지 않는다(DB 위생: 다시 붙어도 받을 게 없으면 0건)', () => {
  assert.deepEqual(lateAttachCandidates([], {}, { now: NOW }), []);
  assert.deepEqual(lateAttachCandidates(null, null, { now: NOW }), []);
  assert.deepEqual(lateAttachCandidates([msg(1, { created_at: at(2 * LATE_ATTACH_WINDOW_MS) })], { 1: [] }, { now: NOW }), []);
});

test('한 번에 읽는 글 수는 상한 안 — 최신 글부터 남긴다', () => {
  const msgs = Array.from({ length: LATE_ATTACH_MAX + 20 }, (_, i) => msg(i + 1));
  const atts = Object.fromEntries(msgs.map((m) => [m.id, []]));
  const ids = lateAttachCandidates(msgs, atts, { now: NOW });
  assert.equal(ids.length, LATE_ATTACH_MAX);
  assert.equal(ids.at(-1), LATE_ATTACH_MAX + 20);
  assert.equal(ids[0], 21);
});

test('합치기 — 받은 행은 그 글에, 행이 없는 글은 빈 묶음, 묶음 밖 글은 그대로, 원본은 바꾸지 않는다', () => {
  const cur = { 1: [], 2: [], 9: [{ id: 'keep', message_id: 9 }] };
  const next = mergeAttachments(cur, [1, 2], [{ id: 'a1', message_id: 1 }, { id: 'a2', message_id: 1 }]);
  assert.deepEqual(next[1].map((r) => r.id), ['a1', 'a2']);
  assert.deepEqual(next[2], []);
  assert.deepEqual(next[9], [{ id: 'keep', message_id: 9 }]);
  assert.deepEqual(cur[1], []);
});

test('합치기 — 이미 보이는 첨부는 빈 결과로 덮지 않는다(첨부 등록 전에 나간 조회가 늦게 도착하는 경합)', () => {
  const cur = { 5: [{ id: 'late', message_id: 5 }] };
  assert.deepEqual(mergeAttachments(cur, [5], [])[5], [{ id: 'late', message_id: 5 }]);
});
