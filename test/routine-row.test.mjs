// F15(2026-10-05 분리 검증): 루틴 켜기/끄기가 진행 표시 없이 기다리고, 실패해도 아무 말 없이 옛 상태가 다시 그려졌다.
// 화면은 누르는 즉시 바뀐 상태를 그리고(낙관 반영) 실패하면 같은 함수로 되돌린다 — 그 반영 규칙을 잠근다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyRoutineToggle } from '../app/c/[ws]/routines/routine-row.mjs';

test('켜기/끄기 낙관 반영과 실패 되돌리기 — 그 행만 바뀌고 다른 행은 같은 참조', () => {
  const a = { id: 'a', enabled: true, title: 'A' }; const b = { id: 'b', enabled: false, title: 'B' };
  const on = applyRoutineToggle([a, b], 'b', true);
  assert.equal(on[1].enabled, true, '누르는 즉시 켜진 상태로 보인다');
  assert.equal(on[0], a, '다른 행은 다시 그릴 필요가 없다');
  const back = applyRoutineToggle(on, 'b', false);
  assert.deepEqual(back, [a, b], '실패하면 원래 상태로 돌아간다');
  assert.equal(applyRoutineToggle(null, 'a', true), null, '목록을 못 받은 상태는 그대로');
});
