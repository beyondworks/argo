// 루틴 시간대 — 예약 시각은 **만든 사람의 시간대**로 발화해야 한다
// (유건 지시 2026-07-28: "한국 사용자는 한국 시간으로 적용되어야 한다").
//
// 이전 동작: isDue가 Date의 기기 로컬 시각(getHours/getDay)만 봤다. 사용자 맥에서 돌 땐 맞지만,
// 클라우드 워커(UTC)나 다른 시간대 기기가 스케줄러를 돌리면 09:00 브리핑이 18:00에 터진다.
// 무증상이라 더 나쁘다 — 루틴은 "안 왔다"가 아니라 "엉뚱한 때 왔다"로 나타난다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDue, normalizeSchedule, normalizeTz, zonedParts } from '../src/routines.mjs';

const KST = 'Asia/Seoul';
const routine = (schedule, extra = {}) => ({
  id: 'r1', enabled: true, agentSlug: 'a', title: 't', prompt: 'p',
  created: '2026-01-01T00:00:00.000Z', lastRun: null, schedule, ...extra,
});

test('시간대 이름 검증 — IANA만 통과, 쓰레기는 null', () => {
  assert.equal(normalizeTz(KST), KST);
  assert.equal(normalizeTz('UTC'), 'UTC');
  assert.equal(normalizeTz('Not/AZone'), null);
  assert.equal(normalizeTz(''), null);
  assert.equal(normalizeTz(undefined), null);
});

test('zonedParts는 같은 순간을 시간대별로 다르게 읽는다', () => {
  const at = new Date('2026-07-28T00:30:00.000Z'); // UTC 00:30 = KST 09:30 (같은 날)
  assert.deepEqual(
    { h: zonedParts(at, KST).hour, m: zonedParts(at, KST).minute, d: zonedParts(at, KST).day },
    { h: 9, m: 30, d: 28 },
  );
  assert.equal(zonedParts(at, 'UTC').hour, 0);
});

test('KST 09:00 루틴은 UTC 00:00~00:05에 due — 실행 기기가 어디든', () => {
  const r = routine(normalizeSchedule({ type: 'daily', time: '09:00', tz: KST }));
  assert.equal(r.schedule.tz, KST, '스케줄에 시간대가 실려야 다른 기기로 옮겨가도 유지된다');
  assert.equal(isDue(r, new Date('2026-07-28T00:01:00.000Z')), true);  // KST 09:01
  assert.equal(isDue(r, new Date('2026-07-27T23:59:00.000Z')), false); // KST 08:59 — 아직 전
});

test('KST 09:00 루틴은 UTC 09:00(=KST 18:00)에 발화하지 않는다 — 이 버그가 신고 대상', () => {
  const r = routine(normalizeSchedule({ type: 'daily', time: '09:00', tz: KST }));
  // KST 18:00은 예약 시각에서 9시간 지났다 → 캐치업 상한(4h) 밖이라 발화 금지
  assert.equal(isDue(r, new Date('2026-07-28T09:00:00.000Z')), false);
});

test('시간대가 없으면 기기 로컬로 판정 — 기존 루틴 동작 불변', () => {
  const r = routine({ type: 'daily', time: '09:00', times: ['09:00'] }); // tz 없음(구 데이터)
  const local9 = new Date(); local9.setHours(9, 1, 0, 0);
  const local8 = new Date(); local8.setHours(8, 59, 0, 0);
  assert.equal(isDue(r, local9), true);
  assert.equal(isDue(r, local8), false);
});

test('요일 판정도 그 시간대 기준 — 날짜 경계에서 갈린다', () => {
  // UTC 월요일 22:00 = KST 화요일 07:00. 화요일(2) 07:00 KST 루틴은 이때 due여야 한다.
  const r = routine(normalizeSchedule({ type: 'weekly', time: '07:00', dows: [2], tz: KST }));
  const at = new Date('2026-07-27T22:01:00.000Z'); // 월 22:01 UTC = 화 07:01 KST
  assert.equal(zonedParts(at, KST).dow, 2);
  assert.equal(isDue(r, at), true);
  // 같은 순간을 UTC로 보면 월요일이라, 시간대를 안 실은 루틴은 화요일 조건에서 탈락한다
  assert.equal(isDue(routine({ type: 'weekly', time: '07:00', times: ['07:00'], dows: [2], tz: 'UTC' }), at), false);
});

test('1회 예약 날짜도 그 시간대 달력으로 본다', () => {
  const r = routine(normalizeSchedule({ type: 'once', date: '2026-07-28', time: '08:00', tz: KST }));
  // UTC 2026-07-27 23:05 = KST 2026-07-28 08:05 → KST 달력으론 예약 당일
  assert.equal(isDue(r, new Date('2026-07-27T23:05:00.000Z')), true);
});

test('interval(반복 N분)은 시간대와 무관하다 — 벽시계가 아니라 경과 시간', () => {
  const s = normalizeSchedule({ type: 'interval', everyMinutes: 30, tz: KST });
  assert.equal(s.tz, undefined, 'interval에는 시간대를 달지 않는다(의미 없음)');
  const r = routine(s, { lastRun: new Date('2026-07-28T00:00:00.000Z').toISOString() });
  assert.equal(isDue(r, new Date('2026-07-28T00:31:00.000Z')), true);
  assert.equal(isDue(r, new Date('2026-07-28T00:20:00.000Z')), false);
});

test('자정 예약(00:00)이 죽지 않는다 — hourCycle이 24를 주는 구현 방어', () => {
  const r = routine(normalizeSchedule({ type: 'daily', time: '00:00', tz: KST }));
  // UTC 15:05 = KST 다음날 00:05
  assert.equal(zonedParts(new Date('2026-07-28T15:05:00.000Z'), KST).hour, 0);
  assert.equal(isDue(r, new Date('2026-07-28T15:05:00.000Z')), true);
});
