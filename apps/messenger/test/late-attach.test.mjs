// 늦은 첨부 되찾기(C-a 인접 경로, 2026-10-08) — 놓친 'attach' 방송을 다시 붙음·끊긴 동안의 보정 조회에서만 되찾는다(새 주기 조회 없음).
// 1차 검수 M: 여러 파일 답은 파일마다 업로드 → 첨부 행을 차례로 등록한다(게이트웨이 deliverReplyFiles, 한 답 최대 10개). 첫 파일 방송으로 [f1]이 보인 뒤
// 끊기면 나머지는 방송을 놓친다 — 그래서 첨부가 '하나도 없는 글'만 고르면 안 되고, 합치기는 줄이지 않는 합집합이어야 한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { lateAttachCandidates, mergeAttachments, lateAttachDue, createLateAttach, LATE_ATTACH_WINDOW_MS, LATE_ATTACH_MAX, LATE_ATTACH_RECHECK_MS } from '../src/late-attach.mjs';

const NOW = Date.parse('2026-10-08T15:10:00Z');
const at = (msAgo) => new Date(NOW - msAgo).toISOString();
const msg = (id, extra = {}) => ({ id, kind: 'text', body: 'x', created_at: at(60_000), deleted_at: null, ...extra });
const f = (mid, n) => ({ id: `a${mid}-${n}`, message_id: mid, name: `f${n}.md` });

test('이미 첨부를 읽은 최근 글은 첨부 수와 관계없이 다시 읽는다 — 아직 못 읽은 글은 빈 묶음 메우기 몫', () => {
  const msgs = [msg(1), msg(2), msg(3)];
  const atts = { 1: [], 2: [f(2, 1)] }; // 3은 못 읽음
  assert.deepEqual(lateAttachCandidates(msgs, atts, { now: NOW }), [1, 2]);
});

test('여러 파일 답 — 첫 파일만 보이는 글도 대상이다(나머지 파일의 attach 방송을 끊긴 사이 놓쳤을 수 있다)', () => {
  const reply = msg(50, { author_kind: 'crew', created_at: at(4 * 60_000) });
  assert.deepEqual(lateAttachCandidates([reply], { 50: [f(50, 1)] }, { now: NOW }), [50]);
  assert.deepEqual(lateAttachCandidates([reply], { 50: [] }, { now: NOW }), [50], '빈 첨부로 읽힌 답도 그대로 대상');
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
  const atts = Object.fromEntries(msgs.map((m) => [m.id, [f(m.id, 1)]]));
  assert.deepEqual(lateAttachCandidates(msgs, atts, { now: NOW }), [6]);
});

test('대상이 없으면 빈 목록 — 부르는 쪽은 요청을 내지 않는다', () => {
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

test('합치기 — 받은 행은 그 글에, 행이 없는 처음 읽은 글은 빈 묶음, 묶음 밖 글은 그대로, 원본은 바꾸지 않는다', () => {
  const cur = { 1: [], 9: [f(9, 1)] };
  const next = mergeAttachments(cur, [1, 2], [f(1, 1), f(1, 2)]);
  assert.deepEqual(next[1].map((r) => r.id), ['a1-1', 'a1-2']);
  assert.deepEqual(next[2], []);
  assert.equal(next[9], cur[9]);
  assert.deepEqual(cur[1], []);
});

test('합치기 — 첫 파일만 보이던 글에 나머지가 붙는다(보이던 순서 유지, 새 것은 뒤에)', () => {
  const cur = { 50: [f(50, 1)] };
  const next = mergeAttachments(cur, [50], [f(50, 3), f(50, 1), f(50, 2)]);
  assert.deepEqual(next[50].map((r) => r.id), ['a50-1', 'a50-3', 'a50-2']);
});

test('합치기 — 늦게 도착한 부분 결과·빈 결과는 보이는 첨부를 줄이지 않는다(먼저 나간 조회가 더 완전한 다시 읽기보다 늦게 오는 경합)', () => {
  const cur = { 50: [f(50, 1), f(50, 2), f(50, 3)] };
  assert.equal(mergeAttachments(cur, [50], [f(50, 1)]), cur, '부분 결과 — 바뀐 것이 없으면 같은 상태(다시 그리지 않는다)');
  assert.equal(mergeAttachments(cur, [50], []), cur, '빈 결과');
});

test('다시 읽을지 — 다시 붙음은 늘 읽고, 보정 조회는 처음·새 대상이 생겼을 때·지난 읽기에서 1분이 지났을 때만', () => {
  assert.equal(lateAttachDue(null, [], { now: NOW, rejoined: true }), false, '대상이 없으면 다시 붙어도 0건');
  assert.equal(lateAttachDue({ ids: new Set([1, 2]), at: NOW }, [1, 2], { now: NOW, rejoined: true }), true, '다시 붙음 — 그 사이 방송을 놓쳤을 수 있다');
  assert.equal(lateAttachDue(null, [1], { now: NOW }), true, '보정 조회 첫 회');
  const last = { ids: new Set([1, 2]), at: NOW };
  assert.equal(lateAttachDue(last, [1, 2], { now: NOW + 10_000 }), false, '같은 대상 10초 뒤 — 같은 데이터를 다시 받지 않는다');
  assert.equal(lateAttachDue(last, [2], { now: NOW + 10_000 }), false, '대상이 줄기만 함(1시간 지남) — 다시 읽을 이유 없음');
  assert.equal(lateAttachDue(last, [1, 2, 3], { now: NOW + 10_000 }), true, '새 글이 대상에 들어옴');
  assert.equal(lateAttachDue(last, [1, 2], { now: NOW + LATE_ATTACH_RECHECK_MS }), true, '1분이 지남 — 업로드가 오래 걸린 파일');
});

/** createLateAttach 실행판 — 시각·화면 상태·서버 첨부를 손으로 움직인다. */
function harness({ msgs, atts, server = [] }) {
  const s = { clock: NOW, live: { msgs, atts }, server, reads: [], fail: 0 };
  const run = createLateAttach({
    snapshot: () => s.live,
    read: async (ids) => { s.reads.push(ids); if (s.fail > 0) { s.fail--; throw new Error('net'); } return s.server.filter((r) => ids.includes(r.message_id)); },
    apply: (ids, rows) => { s.live = { ...s.live, atts: mergeAttachments(s.live.atts, ids, rows) }; },
    now: () => s.clock,
  });
  return { s, run };
}

test('되찾기 — 다시 붙으면 첫 파일만 보이던 답에 나머지 파일이 붙는다(조회 1건)', async () => {
  const { s, run } = harness({ msgs: [msg(50)], atts: { 50: [f(50, 1)] }, server: [f(50, 1), f(50, 2), f(50, 3)] });
  await run({ rejoined: true });
  assert.deepEqual(s.live.atts[50].map((r) => r.id), ['a50-1', 'a50-2', 'a50-3']);
  assert.deepEqual(s.reads, [[50]]);
});

test('되찾기 — 끊긴 동안 보정 조회는 같은 대상을 10초마다 다시 받지 않는다(첫 회·새 글·1분 경과 때만)', async () => {
  const { s, run } = harness({ msgs: [msg(50)], atts: { 50: [f(50, 1)] }, server: [f(50, 1)] });
  await run(); assert.equal(s.reads.length, 1, '첫 회');
  s.clock += 10_000; await run(); assert.equal(s.reads.length, 1, '10초 뒤 같은 대상 — 0건');
  s.live = { msgs: [msg(50), msg(51)], atts: { ...s.live.atts, 51: [] } }; // 보정 조회의 새 글 따라잡기가 업로드 도중의 답을 읽음
  s.server.push(f(51, 1), f(51, 2));
  s.clock += 10_000; await run(); assert.deepEqual(s.reads.at(-1), [50, 51], '새 글이 대상에 들어오면 다음 회에 읽는다');
  assert.equal(s.live.atts[51].length, 2);
  s.server.push(f(51, 3)); // 오래 걸린 세 번째 파일
  s.clock += 10_000; await run(); assert.equal(s.reads.length, 2);
  s.clock += LATE_ATTACH_RECHECK_MS; await run(); assert.equal(s.reads.length, 3, '1분이 지나면 다시 읽는다');
  assert.equal(s.live.atts[51].length, 3);
  await run({ rejoined: true }); assert.equal(s.reads.length, 4, '다시 붙음은 시각과 관계없이 읽는다');
});

test('되찾기 — 대상이 없으면 다시 붙어도 0건, 읽기 실패는 다시 붙음 요청을 잃지 않는다', async () => {
  const empty = harness({ msgs: [msg(1, { kind: 'system' })], atts: { 1: [] } });
  await empty.run({ rejoined: true }); assert.equal(empty.s.reads.length, 0);
  const { s, run } = harness({ msgs: [msg(50)], atts: { 50: [] }, server: [f(50, 1)] });
  await run(); assert.equal(s.reads.length, 1);
  s.fail = 1; await assert.rejects(run({ rejoined: true })); assert.equal(s.reads.length, 2);
  s.clock += 10_000; await run(); assert.equal(s.reads.length, 3, '실패한 다시 붙음 몫은 다음 회에 읽는다(같은 대상·1분 안이어도)');
  assert.equal(s.live.atts[50].length, 1);
});
