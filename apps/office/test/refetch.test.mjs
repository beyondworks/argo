// 18차 4번 — 다른 기기 변경 반영: 탭 복귀 다시 읽기 간격(core/refetch.js)과 일정 창 한 번에 읽기(calendar/model.js unionWindow·eventsIn)
import test from 'node:test';
import assert from 'node:assert/strict';
import { refetchDue, RETURN_GAP } from '../src/core/refetch.js';
import { unionWindow, eventsIn, kstStart, windowOf } from '../src/calendar/model.js';

// 이유: 같은 화면은 1분에 한 번까지만 다시 읽는다(사람당 분당 최대 할 일 1 + 일정 1), 숨긴 탭에서는 읽지 않는다
test('간격: 1분이 지나야, 탭이 보일 때만', () => {
  const t0 = 1_000_000;
  assert.equal(RETURN_GAP, 60_000);
  assert.equal(refetchDue({ hidden: false, now: t0 + 59_999, last: t0, busy: false }), false, '59.999초');
  assert.equal(refetchDue({ hidden: false, now: t0 + 60_000, last: t0, busy: false }), true, '60초');
  assert.equal(refetchDue({ hidden: true, now: t0 + 600_000, last: t0, busy: false }), false, '숨긴 탭');
  assert.equal(refetchDue({ hidden: false, now: t0, last: undefined, busy: false }), true, '아직 읽은 적 없음');
});

// 이유: 쓰는 사이에 읽으면 막 고친 값이 옛 값으로 덮여 보인다 — 안 저장한 변경이 있으면 건너뛴다(페이지 탭 복귀와 같은 규칙)
test('쓰는 중이면 건너뜀', () => {
  assert.equal(refetchDue({ hidden: false, now: 10 * RETURN_GAP, last: 0, busy: true }), false);
});

// 이유(DB 위생): 탭을 아무리 자주 오가도 읽기는 분당 1회 — 10초마다 돌아오는 사람 5분 = 5회(주기 폴링 없이)
test('부하: 10초마다 탭을 오가도 5분에 5회', () => {
  let last = 0, reads = 0;
  for (let now = 60_000; now < 60_000 + 5 * 60_000; now += 10_000) if (refetchDue({ hidden: false, now, last, busy: false })) { reads++; last = now; }
  assert.equal(reads, 5);
});

// 이유: 화면에 떠 있는 일정 창 여럿(연속 월 보기 2~3개, 홈 캘린더 카드 여러 개)을 한 범위로 한 번에 읽는다 — 서버 한도 400일을 넘으면 창마다
test('일정 창 합치기: 덮는 한 범위, 400일 넘으면 따로', () => {
  const sep = windowOf('month', '2026-09-01'), oct = windowOf('month', '2026-10-01');
  const k = (w) => w.join('|');
  assert.deepEqual(unionWindow([k(oct), k(sep)]), { from: sep[0], to: oct[1] });
  assert.equal(unionWindow([]), null);
  assert.equal(unionWindow(['2026-01-01|2026-02-01', '2026-12-01|2027-02-10']), null, '400일 초과');
  assert.deepEqual(unionWindow(['2026-01-01|2027-02-05']), { from: '2026-01-01', to: '2027-02-05' }, '400일까지는 한 번');
});

// 이유: 한 번에 읽은 일정을 창마다 나눌 때 서버 office_event_list와 같은 조건 — 창 끝 전에 시작하고, 반복 없는 일정은 창 시작 뒤에 끝난다(경계에 딱 붙은 일정은 빠진다)
test('창마다 나누기: 서버와 같은 겹침 조건', () => {
  const lo = kstStart('2026-10-01'), hi = kstStart('2026-11-01');
  const iso = (ms) => new Date(ms).toISOString();
  const evs = [
    { id: 'in', starts_at: iso(lo + 3600e3), ends_at: iso(lo + 7200e3), rrule: null },
    { id: 'endsAtLo', starts_at: iso(lo - 3600e3), ends_at: iso(lo), rrule: null },
    { id: 'startsAtHi', starts_at: iso(hi), ends_at: iso(hi + 3600e3), rrule: null },
    { id: 'spans', starts_at: iso(lo - 86400e3), ends_at: iso(lo + 3600e3), rrule: null },
    { id: 'series', starts_at: iso(lo - 30 * 86400e3), ends_at: iso(lo - 30 * 86400e3 + 3600e3), rrule: 'FREQ=WEEKLY' },
    { id: 'seriesLater', starts_at: iso(hi + 86400e3), ends_at: iso(hi + 90000e3), rrule: 'FREQ=DAILY' },
  ];
  assert.deepEqual(eventsIn(evs, lo, hi).map((e) => e.id), ['in', 'spans', 'series']);
});
