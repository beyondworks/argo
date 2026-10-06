// 10/5 작은 결함(OFC-14·16) — 실패가 성공 알림으로 덮이지 않게, 날짜 기본값은 한국 날짜.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../src/core/people-model.js';
import * as V from '../src/views/model.js';

// 이유(OFC-14): 여러 명 지우기가 중간에 실패해도 'N명 지웠습니다'가 오류 알림을 덮었다 — 지운 수와 오류를 나눠 돌려준다
test('OFC-14: 여러 명 지우기 — 실패하면 거기서 멈추고 지운 수와 오류를 돌려준다', async () => {
  assert.ok(P.removeEach, 'removeEach가 있어야 한다');
  const gone = [];
  const r = await P.removeEach(['a', 'b', 'c'], async (id) => { if (id === 'b') throw new Error('people.error.permission'); gone.push(id); });
  assert.deepEqual([r.done, r.error?.message, gone], [1, 'people.error.permission', ['a']]);
  assert.deepEqual(await P.removeEach(['a'], async () => {}), { done: 1, error: null });
});

// 이유(OFC-16): '날짜 바꾸기' 창의 처음 날짜가 UTC라 한국 오전 9시 전에는 어제가 들어가 바로 '기한 지남'이 됐다
test('OFC-16: 날짜 바꾸기 처음 날짜 — 항목 날짜, 없으면 한국 오늘', () => {
  assert.ok(V.askDay, 'askDay가 있어야 한다');
  const kst0830 = Date.parse('2026-10-05T23:30:00Z'); // 한국 10/6 08:30 — UTC로는 아직 10/5
  assert.equal(V.askDay([{ day: null }], kst0830), '2026-10-06');
  assert.equal(V.askDay([{ day: '2026-10-09' }], kst0830), '2026-10-09');
  assert.equal(V.askDay([], kst0830), '2026-10-06');
});
