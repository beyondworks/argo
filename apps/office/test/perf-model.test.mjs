import test from 'node:test';
import assert from 'node:assert/strict';
import { periodRange, shiftAnchor, groupByDay, rate, canShare } from '../src/core/perf-model.js';

// 일간 기록이 주(월~일)·월(1일~말일)·연으로 모인다(유건 9/29: 달력 월 기준)
test('periodRange: 일·주(월요일 시작)·월·연', () => {
  assert.deepEqual(periodRange('day', '2026-09-29'), { unit: 'day', from: '2026-09-29', to: '2026-09-29', key: null });
  assert.deepEqual(periodRange('week', '2026-09-29'), { unit: 'week', from: '2026-09-28', to: '2026-10-04', key: null }); // 화요일 → 월~일
  assert.deepEqual(periodRange('week', '2026-10-04'), { unit: 'week', from: '2026-09-28', to: '2026-10-04', key: null }); // 일요일은 그 주 끝
  assert.deepEqual(periodRange('month', '2026-02-10'), { unit: 'month', from: '2026-02-01', to: '2026-02-28', key: '2026-02' });
  assert.deepEqual(periodRange('year', '2026-09-29'), { unit: 'year', from: '2026-01-01', to: '2026-12-31', key: '2026' });
});

test('shiftAnchor: 앞뒤로 한 칸 — 월 이동은 말일을 넘지 않는다', () => {
  assert.equal(shiftAnchor('day', '2026-03-01', -1), '2026-02-28');
  assert.equal(shiftAnchor('week', '2026-09-29', 1), '2026-10-06');
  assert.equal(shiftAnchor('month', '2026-01-31', 1), '2026-02-01');
  assert.equal(shiftAnchor('year', '2026-09-29', -1), '2025-09-29');
});

test('canShare: 월은 그달이 끝난 뒤, 연은 12월부터', () => {
  assert.equal(canShare('2026-09', '2026-09-30'), false);
  assert.equal(canShare('2026-09', '2026-10-01'), true);
  assert.equal(canShare('2026', '2026-11-30'), false);
  assert.equal(canShare('2026', '2026-12-01'), true);
});

test('rate: 분모가 0이면 null(0%가 아니다)', () => {
  assert.equal(rate(2, 4), 50); assert.equal(rate(0, 0), null); assert.equal(rate(1, 3), 33);
});

test('groupByDay: 날짜별로 모으고 최근 날이 먼저 — 끝낸 할 일만 그날 기록', () => {
  const days = groupByDay({
    deals: [{ day: '2026-09-10', kind: 'contract', amount: 1 }],
    tasks: [{ id: 'a', day: '2026-09-10', done: true }, { id: 'b', day: null, done: false, due_on: '2026-09-12' }],
    approvals: [{ day: '2026-09-11', n: 2 }], pages: [{ day: '2026-09-11', page_id: 'p', title: 'x' }], crew: [], notes: [{ id: 'n', day: '2026-09-11', body: 'y' }],
    mail: [{ thread_id: 't', day: '2026-09-12', grade: 'good' }], asks: [{ id: 1, day: '2026-09-12', minutes: 30 }, { id: 2, day: '2026-09-12', minutes: null, unanswered: true }],
  });
  assert.deepEqual(days.map((d) => d.day), ['2026-09-12', '2026-09-11', '2026-09-10']);
  assert.equal(days[0].mail.length, 1); assert.equal(days[0].asks.length, 2); // 3단계: 거래처 메일·메신저 요청도 그날 기록
  assert.equal(days[1].approvals, 2); assert.equal(days[1].notes.length, 1);
  assert.deepEqual(days[2].tasks.map((t) => t.id), ['a']);
});
