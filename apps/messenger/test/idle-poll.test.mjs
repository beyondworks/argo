// 끊긴 동안의 보정 조회 박자(src/idle-poll.mjs, 2026-10-25 유휴 읽기 줄이기) — 숨긴 창 0, 변화 없으면 10초 → 5분, 멈추면 타이머 0.
// + 열린 채널 화면 하나가 실시간이 끊긴 채(rt_down) 60분 — 종전 10초 고정 대비 요청 수(가짜 서버: 보정 1회 = 글 따라잡기 1 + 결재 1).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startIdlePoll, IDLE_POLL_DELAYS } from '../src/idle-poll.mjs';

function clock() {
  let now = 0; let id = 0; const timers = new Map();
  const setTimer = (fn, ms) => { id += 1; timers.set(id, { fn, at: now + ms }); return id; };
  const clearTimer = (i) => { timers.delete(i); };
  const advance = (ms) => { const end = now + ms; for (;;) { const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]; if (!due) break; timers.delete(due[0]); now = due[1].at; due[1].fn(); } now = end; };
  return { setTimer, clearTimer, advance, now: () => now, live: () => timers.size };
}

test('박자: 10 → 20 → 40 → 80 → 160 → 300초, 상한 300초에서 머문다', () => {
  assert.deepEqual(IDLE_POLL_DELAYS, [10_000, 20_000, 40_000, 80_000, 160_000, 300_000]);
  const c = clock(); const at = [];
  startIdlePoll(() => at.push(c.now()), { setTimer: c.setTimer, clearTimer: c.clearTimer, hidden: () => false });
  c.advance(1_210_000);
  assert.deepEqual(at, [10_000, 30_000, 70_000, 150_000, 310_000, 610_000, 910_000, 1_210_000]);
});

test('숨긴 창: 그 칸은 요청 0(같은 간격으로 다시 잼), 다시 보이면 이어서', () => {
  const c = clock(); let hidden = true; let n = 0;
  startIdlePoll(() => { n += 1; }, { setTimer: c.setTimer, clearTimer: c.clearTimer, hidden: () => hidden });
  c.advance(3_600_000);
  assert.equal(n, 0, '숨긴 채 60분 — 0회(돌아오는 순간은 onForeground가 한 번 따라잡는다)');
  hidden = false; c.advance(10_000);
  assert.equal(n, 1, '보이면 다음 칸에 한 번');
});

test('멈추기: 남은 타이머 0, 그 뒤 요청 0(새 글로 효과가 다시 돌 때·rt_up·화면 닫힘)', () => {
  const c = clock(); let n = 0;
  const stop = startIdlePoll(() => { n += 1; }, { setTimer: c.setTimer, clearTimer: c.clearTimer, hidden: () => false });
  c.advance(30_000); assert.equal(n, 2);
  stop(); assert.equal(c.live(), 0); c.advance(3_600_000); assert.equal(n, 2);
  // 다시 시작하면(새 글 → lastId가 바뀌어 효과가 다시 돈다) 10초부터
  const at = []; startIdlePoll(() => at.push(c.now()), { setTimer: c.setTimer, clearTimer: c.clearTimer, hidden: () => false });
  const t0 = c.now(); c.advance(10_000); assert.deepEqual(at, [t0 + 10_000]);
});

test('배선: 채널 화면의 보정 조회는 setInterval 10초가 아니라 startIdlePoll — 효과 의존값에 lastId(새 글이면 10초부터)', () => {
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /import \{ startIdlePoll \} from '\.\/idle-poll\.mjs';/);
  assert.match(app, /if \(!onScreen \|\| !rtDown\) return undefined; return startIdlePoll\(\(\) => \{ recover\(\); loadApprovals\(\)\.catch\(\(\) => \{\}\); \}\); \}, \[onScreen, rtDown, recover, lastId\]\);/);
  assert.doesNotMatch(app, /if \(!onScreen \|\| !rtDown\) return undefined; const iv = setInterval/, '옛 10초 고정 루프');
  assert.match(app, /useEffect\(\(\) => onForeground\(\(\) => \{ catchUp\(\)\.catch\(\(\) => \{\}\); loadApprovals\(\)\.catch\(\(\) => \{\}\); \}\), \[catchUp\]\);/, '돌아오는 순간 한 번 따라잡기는 그대로');
});

test('측정: 끊긴 채 열린 채널 화면 1개 60분 — 종전 10초 고정 720회 → 보이는 창 30회(1/24), 숨긴 창 0회', () => {
  const REQ = 2; // 보정 1회 = 글 따라잡기(msgr_messages / v2 msgr2_messages) 1 + 결재(msgr_crew_approvals, v2는 요청 없음) 1
  const before = Math.floor(3_600_000 / 10_000) * REQ;
  const run = (hidden) => { const c = clock(); let n = 0; startIdlePoll(() => { n += REQ; }, { setTimer: c.setTimer, clearTimer: c.clearTimer, hidden: () => hidden }); c.advance(3_600_000); return n; };
  const visible = run(false); const hidden = run(true);
  assert.equal(before, 720);
  assert.equal(visible, 30);
  assert.equal(hidden, 0);
  assert.ok(visible / before <= 0.2, '목표 1/5 이하');
});
