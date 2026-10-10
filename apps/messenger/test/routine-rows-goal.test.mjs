// 업무 > 자동화 — 목표 하트비트(schedule.type 'goal')는 자동화 행으로 보이지 않는다. 새 본체는 올리지 않지만 옛 본체(0.1.100 이하)가 올린 행을 숨긴다(#926 재검수 LOW-7).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { visibleRoutineRows } from '../src/routine-rows.mjs';

test('목표 하트비트 행은 숨기고 루틴 행은 그대로', () => {
  const rows = [{ id: 1, schedule: { type: 'daily', time: '09:00' } }, { id: 2, schedule: { type: 'goal', everyMinutes: 60 } }, { id: 3, schedule: { type: 'interval', everyMinutes: 30 } }, { id: 4, schedule: null }];
  assert.deepEqual(visibleRoutineRows(rows).map((r) => r.id), [1, 3, 4]);
  assert.deepEqual(visibleRoutineRows(null), []);
});

test('자동화 목록 조회가 이 거름을 거친다(편집 이력 조회도 걸러진 행 id로)', () => {
  const src = readFileSync(new URL('../src/work-panel.jsx', import.meta.url), 'utf8');
  assert.match(src, /const rows = visibleRoutineRows\(await checked\(query\)\);\n\s*const ids = \(rows \?\? \[\]\)\.map/);
});
