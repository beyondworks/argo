// 18차 2번 — 왼쪽 메뉴 '할 일' 배지와 홈 '챙길 것'의 할 일 수(core/task-model.js dueCounts).
// 이 파일은 브라우저 시간대가 한국이 아닌 경우를 같이 본다 — 마감 날짜는 한국 자정 기준이라 시간대에 흔들리면 안 된다.
process.env.TZ = 'America/Los_Angeles';
import test from 'node:test';
import assert from 'node:assert/strict';
import { dueCounts } from '../src/core/task-model.js';

const ME = 'me-1';
const row = (over) => ({ id: Math.random().toString(36).slice(2), assignee: ME, created_by: ME, due_on: null, done_at: null, cancelled_at: null, ...over });
const at = (iso) => Date.parse(iso);

// 이유: 오늘·지난 마감의 경계는 한국 자정이다(서버 기한 준수율·홈 현황 카드와 같은 날짜) — 23:59:59까지는 '오늘', 00:00부터는 '지남'
test('날짜 경계: 한국 자정에서 오늘 → 지남으로 바뀐다', () => {
  const rows = [row({ due_on: '2026-10-04' })];
  assert.deepEqual(dueCounts(rows, at('2026-10-04T14:59:59Z'), ME), { overdue: 0, today: 1 }, '한국 10/4 23:59:59');
  assert.deepEqual(dueCounts(rows, at('2026-10-04T15:00:00Z'), ME), { overdue: 1, today: 0 }, '한국 10/5 00:00');
  assert.deepEqual(dueCounts(rows, at('2026-10-03T15:00:00Z'), ME), { overdue: 0, today: 1 }, '한국 10/4 00:00 — 전날 밤(미국 시간으로는 10/3)');
  assert.deepEqual(dueCounts(rows, at('2026-10-03T14:59:59Z'), ME), { overdue: 0, today: 0 }, '한국 10/3 — 아직 내일 마감');
});

// 이유: 시간대를 바꿔도 같은 수 — 배지가 사람마다(해외 출장 등) 달라지면 안 된다
test('시간대: 브라우저 시간대가 달라도 같은 수', () => {
  const rows = [row({ due_on: '2026-10-04' }), row({ due_on: '2026-10-03' }), row({ due_on: '2026-10-05' })];
  const now = at('2026-10-04T20:00:00Z'); // 한국 10/5 05:00
  const out = [];
  for (const tz of ['America/Los_Angeles', 'Asia/Seoul', 'UTC', 'Pacific/Kiritimati']) { process.env.TZ = tz; out.push(JSON.stringify(dueCounts(rows, now, ME))); }
  process.env.TZ = 'America/Los_Angeles';
  assert.equal(new Set(out).size, 1, out.join(' / '));
  assert.deepEqual(JSON.parse(out[0]), { overdue: 2, today: 1 });
});

// 이유: 끝낸 일·취소한 일은 챙길 것이 아니다. 남이 맡은 일(관리자에게 보이는 다른 사람 일·내가 남에게 맡긴 일)과 기한 없는 일도 세지 않는다 — 홈 현황 카드 '기한 지남·오늘까지'와 같은 수
test('세는 일: 내가 맡은 안 끝낸·안 취소한 일만', () => {
  const now = at('2026-10-04T03:00:00Z'); // 한국 10/4 12:00
  const rows = [
    row({ due_on: '2026-10-01' }),                                        // 지남
    row({ due_on: '2026-10-04' }),                                        // 오늘
    row({ due_on: '2026-10-01', done_at: '2026-10-02T00:00:00Z' }),       // 끝냄
    row({ due_on: '2026-10-04', cancelled_at: '2026-10-03T00:00:00Z' }),  // 취소(서버는 빼고 주지만 예시 데이터에는 있을 수 있다)
    row({ due_on: '2026-10-01', assignee: 'other' }),                     // 남이 맡은 일
    row({ due_on: '2026-10-04', assignee: 'other', created_by: ME }),     // 내가 남에게 맡긴 일
    row({ due_on: null }),                                                // 기한 없음
    row({ due_on: '2026-10-05' }),                                        // 내일
  ];
  assert.deepEqual(dueCounts(rows, now, ME), { overdue: 1, today: 1 });
});

// 이유: 아직 할 일을 읽지 않았으면 배지를 숨긴다 — 0으로 보이면 "할 일이 없다"로 읽힌다. 읽었는데 없으면 0(배지는 0이면 안 보인다)
test('안 읽음: null, 읽었는데 없음: 0', () => {
  assert.equal(dueCounts(undefined, Date.now(), ME), null);
  assert.equal(dueCounts(null, Date.now(), ME), null);
  assert.deepEqual(dueCounts([], Date.now(), ME), { overdue: 0, today: 0 });
});

// 이유(유건 10/9 "할 일 목록 6개인데 뱃지 5" → 권장안): 보류한 일은 지금 할 일이 아니다 — 기한이 지났어도 배지·챙길 것 수에서 뺀다(할 일 화면 목록에는 그대로).
test('보류한 일은 배지에서 뺀다', () => {
  const rows = [
    { id: 'a', assignee: ME, due_on: '2026-08-21', status: 'hold' },
    { id: 'b', assignee: ME, due_on: '2026-10-02', status: 'doing' },
    { id: 'c', assignee: ME, due_on: '2026-10-09', status: 'hold' },
    { id: 'd', assignee: ME, due_on: '2026-10-09' },
  ];
  assert.deepEqual(dueCounts(rows, '2026-10-09', ME), { overdue: 1, today: 1 });
});
