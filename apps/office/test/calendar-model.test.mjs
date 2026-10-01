// 이 파일은 브라우저 시간대가 한국이 아닌 경우를 같이 본다 — 종일·반복 규칙은 한국 날짜라 브라우저 시간대에 흔들리면 안 된다.
process.env.TZ = 'America/New_York';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays, weekday, mondayOf, monthGrid, weekDays, kstDay, allDayRange, parseRule, ruleString, seriesDays, expand,
  layoutDay, packLanes, holidaysOn, spanOf, windowOf, shift, colorKey, localDay,
} from '../src/calendar/model.js';

const ev = (over) => ({ id: 'e1', title: '회의', all_day: false, exdates: [], rrule: null, parent_id: null, recur_on: null, ...over });
const kst = (s) => Date.parse(`${s}+09:00`);
const days = (list) => list.map((o) => o.occ ?? kstDay(o.start));

// 이유: 한 주의 시작은 월요일(유건 규칙 7) — 월 격자가 월 경계에서 앞달 월요일부터 시작해야 한다.
test('월 격자는 1일이 든 주의 월요일부터 42일, 주 보기는 월~일', () => {
  const g = monthGrid('2026-10-15'); // 2026-10-01은 목요일
  assert.equal(g.length, 42);
  assert.equal(g[0], '2026-09-28');
  assert.equal(weekday(g[0]), 0);
  assert.equal(g[41], '2026-11-08');
  assert.deepEqual(weekDays('2026-10-04'), ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04']); // 일요일은 그 주의 끝
  assert.equal(mondayOf('2026-06-01'), '2026-06-01'); // 1일이 월요일이면 그날부터
  assert.equal(monthGrid('2026-06-20')[0], '2026-06-01');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
});

// 이유: 종일 일정은 한국 자정 기준으로 저장하고, 자정 직전·직후 한 순간이 다른 날로 갈라져야 한다(브라우저가 뉴욕이어도).
test('종일 KST 날짜 변환 — 자정 직전은 전날, 자정은 다음 날', () => {
  assert.deepEqual(allDayRange('2026-10-01', '2026-10-02'), { starts_at: '2026-09-30T15:00:00.000Z', ends_at: '2026-10-02T15:00:00.000Z' });
  assert.equal(kstDay(Date.parse('2026-09-30T14:59:59.999Z')), '2026-09-30');
  assert.equal(kstDay(Date.parse('2026-09-30T15:00:00.000Z')), '2026-10-01');
  const [o] = expand([ev({ all_day: true, ...allDayRange('2026-10-01', '2026-10-02') })], kst('2026-09-01T00:00:00'), kst('2026-11-01T00:00:00'));
  assert.deepEqual(spanOf(o), ['2026-10-01', '2026-10-02']); // 끝은 포함 날짜(다음 날 자정 − 1ms)
});

test('반복 규칙 문자열 왕복 — 간격 1은 생략, UNTIL은 한국 날짜', () => {
  assert.equal(ruleString({ freq: 'WEEKLY', interval: 1 }), 'FREQ=WEEKLY');
  assert.equal(ruleString({ freq: 'MONTHLY', interval: 2, until: '2026-12-31' }), 'FREQ=MONTHLY;INTERVAL=2;UNTIL=20261231');
  assert.deepEqual(parseRule('FREQ=DAILY;INTERVAL=3;UNTIL=20261010'), { freq: 'DAILY', interval: 3, until: '2026-10-10' });
  assert.equal(parseRule('FREQ=YEARLY'), null); // 서버 check와 같은 모양만 받는다
  assert.equal(ruleString({ freq: '' }), null);
});

// 이유: 매주 반복은 시작일 요일에만, 간격 2면 격주 — 회차 시각은 첫 회차와 같은 한국 시각.
test('매주 반복 — 시작일 요일·간격·UNTIL 포함', () => {
  const row = ev({ starts_at: '2026-09-07T10:00:00+09:00', ends_at: '2026-09-07T11:00:00+09:00', rrule: 'FREQ=WEEKLY;INTERVAL=2;UNTIL=20261019' });
  const list = expand([row], kst('2026-09-01T00:00:00'), kst('2026-12-01T00:00:00'));
  assert.deepEqual(days(list), ['2026-09-07', '2026-09-21', '2026-10-05', '2026-10-19']); // UNTIL 당일(10/19) 포함
  assert.ok(list.every((o) => weekday(o.occ) === 0));
  assert.ok(list.every((o) => new Date(o.start).toISOString().endsWith('01:00:00.000Z'))); // 한국 10:00 = UTC 01:00
  assert.equal(list[1].key, 'e1|2026-09-21');
  assert.equal(list[1].series, row);
});

// 이유: 매월 31일 반복은 31일이 없는 달(9·11월)을 건너뛴다 — 말일로 당기지 않는다(명세).
test('매월 31일 — 없는 달은 건너뛴다', () => {
  assert.deepEqual(seriesDays('2026-08-31', { freq: 'MONTHLY', interval: 1, until: null }, '2026-08-01', '2027-01-31'), ['2026-08-31', '2026-10-31', '2026-12-31', '2027-01-31']);
  assert.deepEqual(seriesDays('2026-01-31', { freq: 'MONTHLY', interval: 2, until: '2026-07-31' }, '2026-01-01', '2026-12-31'), ['2026-01-31', '2026-03-31', '2026-05-31', '2026-07-31']);
  assert.deepEqual(seriesDays('2026-01-15', { freq: 'MONTHLY', interval: 1, until: null }, '2026-10-01', '2026-10-31'), ['2026-10-15']); // 먼 과거 시작도 창 안 회차만
});

test('매일 반복 — 간격과 창 밖 회차', () => {
  assert.deepEqual(seriesDays('2026-01-01', { freq: 'DAILY', interval: 3, until: null }, '2026-01-05', '2026-01-12'), ['2026-01-07', '2026-01-10']);
  assert.deepEqual(seriesDays('2026-05-01', { freq: 'DAILY', interval: 1, until: null }, '2026-04-01', '2026-04-30'), []); // 시작 전
});

// 이유: '이번 한 번만 지우기'(exdates)와 '이번만 수정'(parent_id+recur_on 행)은 원본 전개에서 그 날짜를 빼고, 수정한 행은 따로 한 건.
test('exdates·회차 수정 행이 원본 회차를 대신한다', () => {
  const parent = ev({ starts_at: '2026-09-07T10:00:00+09:00', ends_at: '2026-09-07T11:00:00+09:00', rrule: 'FREQ=WEEKLY', exdates: ['2026-09-14'] });
  const moved = ev({ id: 'e2', title: '회의(옮김)', starts_at: '2026-09-22T15:00:00+09:00', ends_at: '2026-09-22T16:00:00+09:00', parent_id: 'e1', recur_on: '2026-09-21' });
  const list = expand([parent, moved], kst('2026-09-01T00:00:00'), kst('2026-09-29T00:00:00'));
  assert.deepEqual(list.map((o) => o.key), ['e1|2026-09-07', 'e2', 'e1|2026-09-28']);
  assert.equal(list[1].occ, null); // 수정한 회차는 반복이 아닌 한 건
});

test('창 앞에서 시작해 창 안으로 이어지는 회차도 나온다', () => {
  const row = ev({ all_day: true, ...allDayRange('2026-09-29', '2026-10-02'), rrule: 'FREQ=MONTHLY' });
  const list = expand([row], kst('2026-10-01T00:00:00'), kst('2026-10-05T00:00:00'));
  assert.deepEqual(days(list), ['2026-09-29']);
});

// 이유: 주·일 보기에서 겹치는 일정은 나란히 — 겹침이 이어진 무리마다 열 수가 따로 정해진다.
test('겹침 배치 — 무리별 열 수, 빈 열 재사용', () => {
  const m = layoutDay([
    { key: 'a', start: 540, end: 600 }, { key: 'b', start: 570, end: 630 }, { key: 'c', start: 600, end: 660 }, // a·b 겹침, c는 a 자리 재사용
    { key: 'd', start: 720, end: 780 }, // 따로 한 칸
  ]);
  assert.deepEqual(m.get('a'), { col: 0, cols: 2 });
  assert.deepEqual(m.get('b'), { col: 1, cols: 2 });
  assert.deepEqual(m.get('c'), { col: 0, cols: 2 });
  assert.deepEqual(m.get('d'), { col: 0, cols: 1 });
  assert.deepEqual(layoutDay([{ key: 'x', start: 600, end: 600 }, { key: 'y', start: 610, end: 640 }]).get('y'), { col: 1, cols: 2 }); // 0분 일정도 최소 20분으로 겹침 판단
});

test('주 칸 줄 배치 — 긴 막대 먼저, 안 겹치면 같은 줄', () => {
  const m = packLanes([{ key: 's', a: 2, b: 2 }, { key: 'l', a: 0, b: 3 }, { key: 'r', a: 4, b: 6 }, { key: 't', a: 2, b: 2 }]);
  assert.equal(m.get('l'), 0);
  assert.equal(m.get('s'), 1);
  assert.equal(m.get('t'), 2);
  assert.equal(m.get('r'), 0);
});

// 이유: 공휴일(1)은 빨간 날짜, 기념일(0)은 회색 — 같은 날 두 개(어린이날·부처님오신날)도 다 나온다.
test('공휴일 조회', () => {
  assert.deepEqual(holidaysOn('2025-05-05').map((h) => h.name).sort(), ['부처님오신날', '어린이날']);
  assert.equal(holidaysOn('2025-05-05')[0].off, true);
  assert.deepEqual(holidaysOn('2025-05-08'), [{ name: '어버이날', off: false }]);
  assert.deepEqual(holidaysOn('2025-05-07'), []);
});

test('보기별 읽기 창·이동·색 기준', () => {
  const [from, to] = windowOf('week', '2026-10-15');
  assert.ok(from <= '2026-09-28' && to >= '2026-11-09'); // 주 보기도 그달 격자 전체를 읽는다
  assert.equal(shift('month', '2026-01-31', 1), '2026-02-01');
  assert.equal(shift('week', '2026-10-15', -1), '2026-10-08');
  assert.deepEqual(colorKey({ crew: null, owner: 'u1', category: '' }, 'agent'), null); // 사람이 만든 일정은 중립
  assert.deepEqual(colorKey({ crew: 'crew-luna' }, 'agent'), { agent: 'crew-luna' });
  assert.equal(colorKey({ category: '' }, 'category'), null);
  assert.equal(localDay(new Date(2026, 9, 1, 23, 30).getTime()), '2026-10-01'); // 브라우저 날짜(뉴욕)
});

// 이유: 공휴일 표는 한국어 원본 — 영어 화면에서는 사전으로 옮기고, '쉬는 날 ○○'(대체공휴일)은 틀에 끼워 넣는다. 사전에 없는 새 이름은 원본 그대로.
test('공휴일 이름 번역', async () => {
  const { CAL_DICT, holidayName } = await import('../src/calendar/calendar-i18n.js');
  const en = (k, vars) => { let s = CAL_DICT[k]?.[1] ?? k; for (const [a, b] of Object.entries(vars ?? {})) s = s.replaceAll(`{${a}}`, b); return s; };
  assert.equal(holidayName('한글날', en), 'Hangul Day');
  assert.equal(holidayName('쉬는 날 개천절', en), 'Substitute holiday: National Foundation Day');
  assert.equal(holidayName('임시공휴일', en), '임시공휴일');
  const { KR_HOLIDAYS } = await import('../src/calendar/holidays-kr.js');
  for (const [, name] of KR_HOLIDAYS) assert.doesNotMatch(holidayName(name, en), /[가-힣]/, name); // 지금 표의 이름은 전부 영어가 있다
});

// 연속 월 보기 — 주 높이·제목 달·읽기 창이 틀리면 스크롤 중 제목이 엉뚱하거나 일정 칩이 빠진다
import { weekFit, dominantMonth, weekWindows } from '../src/calendar/model.js';
test('weekFit: 홀수 주 수로 보이는 높이를 채운다', () => {
  assert.deepEqual(weekFit(770, 118), { n: 5, h: 154 });
  assert.deepEqual(weekFit(600, 58), { n: 9, h: 66 });
  assert.equal(weekFit(100, 118).n, 1);
  assert.ok(weekFit(0, 118).h >= 24);
});
test('dominantMonth: 보이는 날짜가 가장 많은 달, 동점이면 앞 달', () => {
  // 9/14 주부터 5주: 9월 17일, 10월 18일
  assert.equal(dominantMonth('2026-09-14', 0, 100, 500), '2026-10');
  // 9/14 주부터 3주(9/14~10/4): 9월 17일, 10월 4일
  assert.equal(dominantMonth('2026-09-14', 0, 100, 300), '2026-09');
  // 반 주씩 걸친 위치도 센다
  assert.equal(dominantMonth('2026-08-31', 50, 100, 500), '2026-09');
  // 2026-06-29 주: 6월 2일·7월 5일 — 한 주만 보이면 7월
  assert.equal(dominantMonth('2026-06-29', 0, 100, 100), '2026-07');
});
test('weekWindows: 각 주의 월~일이 적어도 한 창 안에 든다', () => {
  const base = '2025-12-29';
  const wins = weekWindows(base, 0, 60);
  for (let i = 0; i <= 60; i++) {
    const mon = addDays(base, i * 7), sun = addDays(mon, 6);
    assert.ok(wins.some(([f, t]) => f <= mon && sun < t), mon);
  }
  // 같은 달은 한 창만(같은 기간을 두 번 읽지 않는다)
  assert.equal(new Set(wins.map((w) => w.join())).size, wins.length);
  assert.deepEqual(weekWindows(base, 0, 0), [windowOf('month', '2025-12-01')]);
});
