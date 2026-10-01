// 홈 '캘린더' 위젯 순수 계산(유건 10/1 4차 명세 B절) — 위젯마다 따로 정하는 값, 보기별 읽기 창, 다음 일정·남은 시간, 진행 막대.
// 브라우저 시간대가 한국이 아닌 경우도 본다 — 시간 일정은 브라우저 날짜, 종일은 한국 날짜.
process.env.TZ = 'America/New_York';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as W from '../src/calendar/widget-model.js';
import { windowOf, addDays } from '../src/calendar/model.js';

const ME = 'u-me';
const at = (day, time) => new Date(`${day}T${time}:00`).getTime(); // 브라우저(뉴욕) 시각
const ev = (over) => ({ key: over.id ?? 'e', id: 'e', title: '회의', all_day: false, org_id: null, owner: ME, attendees: [], ...over });

// 이유(B-5): 위젯마다 따로 정하되 기본값은 캘린더 페이지 설정과 같게 — 고르지 않은 칸은 저장하지 않고 페이지를 계속 따른다.
test('위젯 설정: 모르는 값은 버리고, 고르지 않은 칸은 페이지 설정을 따른다', () => {
  assert.deepEqual(W.normalizeWidget({ design: 'neon', color: 'agent', show: { org: false, me: 'yes', extra: true } }), { color: 'agent', show: { org: false } });
  assert.deepEqual(W.normalizeWidget(null), {});
  const page = W.pageDefaults({ color: 'person', off: ['tasks', 'o2'], space: 'me', orgIds: ['o1', 'o2'] });
  assert.deepEqual(page, { color: 'person', show: { me: true, org: true, tasks: false, holidays: true } });
  const w = W.resolveWidget({ show: { holidays: false } }, page);
  assert.equal(w.design, 'minimal', '기본 디자인은 미니멀');
  assert.equal(w.color, 'person');
  assert.deepEqual(w.show, { me: true, org: true, tasks: false, holidays: false });
  assert.deepEqual(w.own, { holidays: false });
  // 모든 조직 캘린더를 끄면 '조직 일정'도 꺼진 것으로 보인다. 조직 공간은 '내 일정' = 주인·참석(mine)
  assert.equal(W.pageDefaults({ off: ['o1'], space: 'me', orgIds: ['o1'] }).show.org, false);
  assert.deepEqual(W.pageDefaults({ off: ['mine'], space: 'o1' }).show, { me: false, org: true, tasks: true, holidays: true });
});

test('설정 창 저장: 페이지와 같은 값은 적지 않고 디자인은 그대로', () => {
  const page = { color: 'category', show: { me: true, org: true, tasks: true, holidays: true } };
  assert.deepEqual(W.widgetPatch({ design: 'accent', color: 'agent' }, { color: 'category', show: { me: true, org: false, tasks: true, holidays: true } }, page), { design: 'accent', show: { org: false } });
  assert.deepEqual(W.widgetPatch({}, { color: 'person', show: page.show }, page), { color: 'person' });
});

// 이유(B-5 보여 줄 것): 위젯이 정한 값이 있으면 그것, 없으면 페이지에서 끈 캘린더를 캘린더 단위로 따른다(조직이 여럿이면 조직마다).
test('일정 거르기: 내 일정·조직 일정', () => {
  const mine = ev({ org_id: null }), team = ev({ org_id: 'o1' });
  assert.equal(W.sourceOf(mine, 'me', ME), 'me');
  assert.equal(W.sourceOf(team, 'me', ME), 'org');
  assert.equal(W.sourceOf(ev({ org_id: 'o1', owner: 'u-x', attendees: [ME] }), 'o1', ME), 'me');
  assert.equal(W.sourceOf(ev({ org_id: 'o1', owner: 'u-x' }), 'o1', ME), 'org');
  assert.equal(W.keepEvent(team, { space: 'me', me: ME, own: {}, off: ['o1'], calKey: 'o1' }), false, '페이지에서 끈 조직');
  assert.equal(W.keepEvent(team, { space: 'me', me: ME, own: { org: true }, off: ['o1'], calKey: 'o1' }), true, '위젯이 켠 것이 이긴다');
  assert.equal(W.keepEvent(mine, { space: 'me', me: ME, own: { me: false }, off: [], calKey: 'me' }), false);
});

// 이유(B-4): 미니멀·강조는 주·월·미니에서만 제목 줄을 숨긴다 — 목록 계열은 기존 모양, 기본 디자인은 제목 줄 유지.
test('제목 줄 숨김은 디자인이 적용되는 보기에서만', () => {
  for (const v of ['week', 'month', 'mini']) { assert.ok(W.isBare(v, 'minimal')); assert.ok(W.isBare(v, 'accent')); assert.ok(!W.isBare(v, 'basic')); }
  for (const v of ['list', 'card', 'kanban', 'table', 'day', 'next']) assert.ok(!W.isBare(v, 'minimal'), v);
});

// 이유(B-3): 데이터 읽기 기간은 보이는 범위를 덮어야 한다 — ‹ ›로 옮긴 주·달도. 주가 두 달에 걸쳐도 그달 격자 창 안에 든다.
test('보기별 읽기 창은 보이는 범위를 덮는다', () => {
  const today = '2026-10-01';
  assert.deepEqual(W.readWindow('list', '2026-12-01', today), [today, '2026-10-09'], '목록 계열은 오늘부터 7일(옮기지 않는다)');
  assert.deepEqual(W.readWindow('day', '2026-12-01', today), windowOf('month', today));
  for (const anchor of ['2026-09-28', '2026-10-31', '2027-02-01', '2026-11-30']) {
    const [from, to] = W.readWindow('week', anchor, today);
    const monday = addDays(anchor, -((new Date(`${anchor}T00:00:00Z`).getUTCDay() + 6) % 7));
    assert.ok(from <= monday && addDays(monday, 6) < to, `주 ${anchor}`);
    const weeks = W.monthWeeks(anchor), [mf, mt] = W.readWindow('month', anchor, today);
    assert.ok(mf <= weeks[0][0] && weeks.at(-1)[6] < mt, `월 ${anchor}`);
  }
  const [nf, nt] = W.readWindow('next', today, today);
  assert.ok(nf <= today && nt >= '2026-10-31', '다음 일정은 한 달 앞까지');
});

test('‹ › 이동: 주는 7일, 월·미니는 한 달', () => {
  assert.equal(W.navShift('week', '2026-10-01', 1), '2026-10-08');
  assert.equal(W.navShift('week', '2026-10-01', -1), '2026-09-24');
  assert.equal(W.navShift('month', '2026-10-31', 1), '2026-11-01');
  assert.equal(W.navShift('mini', '2026-01-15', -1), '2025-12-01');
});

// 이유(B-4 강조): 진행 막대는 주 단위 칸, 지난 주는 채움 — 그달 날짜가 있는 주만 센다(빈 6번째 주 없음).
test('그달의 주·진행 막대', () => {
  const weeks = W.monthWeeks('2026-10-15');
  assert.equal(weeks.length, 5);
  assert.equal(weeks[0][0], '2026-09-28');
  assert.equal(weeks.at(-1)[6], '2026-11-01');
  assert.equal(W.monthWeeks('2027-02-10').length, 4, '2027년 2월은 월요일에 시작해 4주');
  assert.deepEqual(W.monthProgress('2026-10-14'), [1, 1, 3 / 7, 0, 0]);
});

// 이유(B-3 주 보기): 노션식 한 주 카드 — 칸마다 그날 항목, 종일·할 일 먼저, 그다음 시각순. 여러 날 걸친 일정은 걸친 날마다.
test('날짜별 항목', () => {
  const days = ['2026-10-05', '2026-10-06', '2026-10-07'];
  const a = ev({ key: 'a', title: 'B 회의', start: at('2026-10-05', '14:00'), end: at('2026-10-05', '15:00') });
  const b = ev({ key: 'b', title: 'A 아침', start: at('2026-10-05', '09:00'), end: at('2026-10-05', '09:30') });
  const c = { key: 't', kind: 'task', title: '보고서', all_day: true, start: Date.parse('2026-10-04T15:00:00Z'), end: Date.parse('2026-10-05T15:00:00Z') }; // 한국 10-05 종일
  const d = ev({ key: 'd', title: '출장', all_day: true, start: Date.parse('2026-10-05T15:00:00Z'), end: Date.parse('2026-10-07T15:00:00Z') }); // 한국 10-06~07
  const m = W.dayBuckets(days, [a, b, c, d]);
  assert.deepEqual(m.get('2026-10-05').map((o) => o.key), ['t', 'b', 'a']);
  assert.deepEqual(m.get('2026-10-06').map((o) => o.key), ['d']);
  assert.deepEqual(m.get('2026-10-07').map((o) => o.key), ['d']);
});

// 이유(B-3 다음 일정): 진행 중이면 그것("진행 중 · 30분 남음"), 아니면 가장 먼저 시작할 것. 이미 시작한 종일 일정·할 일은 '다음'이 아니다.
test('다음 일정 하나와 그다음', () => {
  const now = at('2026-10-01', '13:30');
  const allDay = ev({ key: 'ad', all_day: true, start: at('2026-10-01', '00:00'), end: at('2026-10-02', '00:00') });
  const live = ev({ key: 'live', start: at('2026-10-01', '13:00'), end: at('2026-10-01', '14:00') });
  const next = ev({ key: 'n1', start: at('2026-10-01', '15:00'), end: at('2026-10-01', '16:00') });
  const later = ev({ key: 'n2', start: at('2026-10-02', '09:00'), end: at('2026-10-02', '10:00') });
  const done = ev({ key: 'old', start: at('2026-10-01', '09:00'), end: at('2026-10-01', '10:00') });
  const task = { key: 't', kind: 'task', title: 'x', all_day: true, start: at('2026-10-01', '15:00'), end: at('2026-10-02', '00:00') };
  let r = W.nextUp([later, next, live, allDay, done, task], now);
  assert.equal(r.main.key, 'live'); assert.equal(r.live, true);
  assert.deepEqual(r.rest.map((o) => o.key), ['n1', 'n2']);
  r = W.nextUp([later, next, allDay, done, task], now);
  assert.equal(r.main.key, 'n1'); assert.equal(r.live, false);
  assert.deepEqual(r.rest.map((o) => o.key), ['n2']);
  assert.deepEqual(W.nextUp([allDay, done, task], now), { main: null, live: false, rest: [] }, '다가오는 일정이 없습니다');
  const many = Array.from({ length: 6 }, (_, i) => ev({ key: `m${i}`, start: at('2026-10-03', `1${i}:00`), end: at('2026-10-03', `1${i}:30`) }));
  assert.equal(W.nextUp(many, now).rest.length, 3, '그다음은 3개까지');
});

test('남은 시간 글자 재료', () => {
  const now = at('2026-10-01', '12:00');
  assert.deepEqual(W.untilParts(now, at('2026-10-01', '12:20')), { unit: 'min', n: 20 });
  assert.deepEqual(W.untilParts(now, at('2026-10-01', '14:00')), { unit: 'hour', n: 2 });
  assert.deepEqual(W.untilParts(now, at('2026-10-01', '14:40')), { unit: 'hour', n: 3 });
  assert.deepEqual(W.untilParts(now, at('2026-10-02', '09:00')), { unit: 'tomorrow', n: 1 });
  assert.deepEqual(W.untilParts(now, at('2026-10-05', '09:00')), { unit: 'day', n: 4 });
  assert.deepEqual(W.leftParts(now, at('2026-10-01', '12:30')), { unit: 'min', n: 30 });
  assert.deepEqual(W.leftParts(now, at('2026-10-01', '14:10')), { unit: 'hour', n: 2 });
});
