// 놓친 회차 판정(순수) — catch-up 창(4h)을 넘겨 isDue가 다시는 발화하지 않을 슬롯만 '놓침'이다.
// isDue와 판정이 갈리면 건너뛰지 않은 회차를 "건너뛰었다"고 말하거나(거짓 기록), 건너뛴 회차를 놓친다.
// 그래서 대조군으로 같은 시각에 isDue를 함께 돌려 본다. 활동·대화 문구의 날짜 묶음(formatMissedSlots)도 여기서 잠근다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { missedSlots, formatMissedSlots, CATCHUP_MS, MISSED_LOOKBACK_DAYS } from '../src/routine-time.mjs';
import { isDue } from '../src/routines.mjs';

const kst = (d, hm) => new Date(`${d}T${hm}:00+09:00`);
const base = (schedule, extra = {}) => ({ id: 'r1', enabled: true, schedule: { tz: 'Asia/Seoul', ...schedule },
  created: '2026-09-01T00:00:00.000Z', editedAt: '2026-09-01T00:00:00.000Z', lastRun: kst('2026-10-07', '09:00').toISOString(), ...extra });
const slots = (r, now) => missedSlots(r, now).map((s) => `${s.date} ${s.time}`);

test('daily: 창을 넘긴 슬롯만 놓침 — isDue가 발화하는 동안(창 안)은 놓침이 아니다', () => {
  const r = base({ type: 'daily', times: ['09:00'] });
  assert.deepEqual(slots(r, kst('2026-10-08', '12:59')), [], '3시간 59분 — 아직 catch-up 창 안');
  assert.equal(isDue(r, kst('2026-10-08', '12:59')), true, '대조군: 같은 시각 isDue는 발화한다');
  assert.deepEqual(slots(r, kst('2026-10-08', '13:01')), ['2026-10-08 09:00']);
  assert.equal(isDue(r, kst('2026-10-08', '13:01')), false, '대조군: 창을 넘기면 isDue는 영영 건너뛴다');
  const s = missedSlots(r, kst('2026-10-08', '15:00'))[0];
  assert.equal(s.at, kst('2026-10-08', '09:00').toISOString(), '절대 시각은 루틴 시간대의 09:00');
});

test('여러 회차·여러 날짜 — 오래된 순, 이미 실행된(lastRun 이후가 아닌) 슬롯은 빼고', () => {
  const r = base({ type: 'daily', times: ['09:00', '13:00'] }, { lastRun: kst('2026-10-06', '09:05').toISOString() });
  assert.deepEqual(slots(r, kst('2026-10-08', '18:00')),
    ['2026-10-06 13:00', '2026-10-07 09:00', '2026-10-07 13:00', '2026-10-08 09:00', '2026-10-08 13:00']);
});

test('weekly: 지정 요일만 (2026-10-05=월, 2026-10-08=목)', () => {
  const r = base({ type: 'weekly', times: ['09:00'], dows: [1, 4] }, { lastRun: kst('2026-10-01', '09:00').toISOString() });
  assert.deepEqual(slots(r, kst('2026-10-08', '15:00')), ['2026-10-05 09:00', '2026-10-08 09:00']);
});

test('once: 지정 날짜 한 번 / 실행됐으면 없음', () => {
  const r = base({ type: 'once', date: '2026-10-08', time: '09:00', times: ['09:00'] }, { lastRun: null });
  assert.deepEqual(slots(r, kst('2026-10-08', '15:00')), ['2026-10-08 09:00']);
  assert.deepEqual(slots({ ...r, lastRun: kst('2026-10-08', '09:00').toISOString() }, kst('2026-10-08', '15:00')), []);
});

test('B5: 만든 시각·사람이 고친 시각 이전 슬롯, 꺼진 루틴, interval은 놓침이 아니다', () => {
  const now = kst('2026-10-08', '15:00');
  assert.deepEqual(slots(base({ type: 'daily', times: ['09:00'] }, { lastRun: null, created: kst('2026-10-08', '10:00').toISOString(), editedAt: kst('2026-10-08', '10:00').toISOString() }), now), []);
  assert.deepEqual(slots(base({ type: 'daily', times: ['09:00'] }, { editedAt: kst('2026-10-08', '09:30').toISOString() }), now), [], '그 슬롯 뒤에 다시 켜거나 시각을 바꿨다');
  assert.deepEqual(slots(base({ type: 'daily', times: ['09:00'] }, { enabled: false }), now), []);
  assert.deepEqual(missedSlots({ id: 'i', enabled: true, schedule: { type: 'interval', everyMinutes: 30 }, created: '2026-01-01T00:00:00Z' }, now), [], 'interval은 다음 틱에 자연 캐치업');
});

test('B9: 아주 오래 꺼져 있었으면 최근 7일 슬롯만', () => {
  const r = base({ type: 'daily', times: ['09:00'] }, { lastRun: kst('2026-08-01', '09:00').toISOString() });
  const got = missedSlots(r, kst('2026-10-08', '15:00'));
  assert.equal(MISSED_LOOKBACK_DAYS, 7);
  assert.ok(got.length >= 6 && got.length <= 7, String(got.length));
  assert.ok(got.every((s) => Date.parse(s.at) >= kst('2026-10-08', '15:00').getTime() - 7 * 86_400_000));
  assert.ok(got.every((s) => kst('2026-10-08', '15:00').getTime() - Date.parse(s.at) > CATCHUP_MS));
});

test('B7: 루틴 시간대 기준 — 같은 09:00이라도 뉴욕 루틴의 절대 시각은 다르다', () => {
  const ny = { ...base({ type: 'daily', times: ['09:00'] }), schedule: { type: 'daily', times: ['09:00'], tz: 'America/New_York' }, lastRun: '2026-10-06T13:00:00.000Z' };
  const got = missedSlots(ny, new Date('2026-10-07T20:00:00Z'));
  assert.deepEqual(got.map((s) => [s.date, s.time, s.at]), [['2026-10-07', '09:00', '2026-10-07T13:00:00.000Z']], 'EDT(UTC-4) 09:00 = 13:00Z');
});

test('formatMissedSlots: 같은 날은 한 묶음(·), 날짜는 쉼표, 많으면 "외 N건"', () => {
  const s = (date, time) => ({ date, time });
  assert.equal(formatMissedSlots([s('2026-10-08', '09:00'), s('2026-10-08', '13:00')], 'ko'), '10월 8일 09:00·13:00');
  assert.equal(formatMissedSlots([s('2026-10-07', '09:00'), s('2026-10-08', '09:00')], 'ko'), '10월 7일 09:00, 10월 8일 09:00');
  assert.equal(formatMissedSlots([s('2026-10-08', '09:00'), s('2026-10-08', '13:00')], 'en'), 'Oct 8 09:00 · 13:00');
  const many = ['01', '02', '03', '04', '05'].map((d) => s(`2026-10-${d}`, '09:00'));
  assert.equal(formatMissedSlots(many, 'ko'), '10월 1일 09:00, 10월 2일 09:00, 10월 3일 09:00 외 2건');
  assert.equal(formatMissedSlots(many, 'en'), 'Oct 1 09:00, Oct 2 09:00, Oct 3 09:00 and 2 more');
  assert.equal(formatMissedSlots([], 'ko'), '');
});
