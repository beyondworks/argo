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

// UM2(2026-10-05 분리 검수): 크루 없는 켜진 루틴(이 수정 전에 해고한 크루의 루틴, 동기화로 루틴이 카드보다 먼저 온 경우)이 화면에 '가동'으로 표시·집계되는데
// 칩 툴팁은 "해고되어 꺼 두었습니다"라고 했다. 스케줄러는 그 루틴을 실행하지 않고 건너뛴다(끄지는 않는다) — 화면은 실제 상태를 말한다.
import { routineStateKind, activeRoutineCount, routineCrewMissing } from '../app/c/[ws]/routines/routine-row.mjs';

test('상태 칸 — 켜져 있어도 크루가 없으면 "크루 없음으로 멈춤"이지 "가동"이 아니다', () => {
  const on = { id: 'a', enabled: true }; const off = { id: 'b', enabled: false };
  assert.equal(routineStateKind(on, { crewGone: false, expired: false }), 'on');
  assert.equal(routineStateKind(on, { crewGone: true, expired: false }), 'crewMissing', '켜져 있지만 돌지 않는다');
  assert.equal(routineStateKind(on, { crewGone: true, expired: true }), 'crewMissing', '크루가 없는 것이 더 근본이다');
  assert.equal(routineStateKind(on, { crewGone: false, expired: true }), 'expired');
  assert.equal(routineStateKind(off, { crewGone: true, expired: false }), 'off', '꺼진 루틴은 꺼짐 — 크루 없음은 크루 칸의 칩이 말한다');
});

test('가동 수 — 켜져 있고, 만료 아니고, 크루가 있는 루틴만 센다. 크루 목록을 못 받았으면 단정하지 않는다', () => {
  const agents = [{ slug: 'a' }];
  const routines = [{ id: '1', enabled: true, agentSlug: 'a' }, { id: '2', enabled: true, agentSlug: 'gone' }, { id: '3', enabled: true, agentSlug: 'a', expiredFlag: true }, { id: '4', enabled: false, agentSlug: 'a' }];
  const expired = (r) => r.expiredFlag === true;
  assert.equal(activeRoutineCount(routines, agents, expired), 1);
  assert.equal(activeRoutineCount(routines, null, expired), 2, '크루 목록을 아직/못 받았으면 크루 없음으로 세지 않는다(F4 원칙)');
  assert.equal(activeRoutineCount(null, agents, expired), 0);
  assert.equal(routineCrewMissing(routines[1], agents), true);
});

// UL4(2026-10-05): 켜기·삭제가 실패하면 404(이미 지워진 루틴 — 다른 기기·메신저에서 지움)도 "잠시 뒤 다시 시도해 주세요"라고만 했다.
// 다시 시도해도 같은 404라 소용없다 — 목록을 다시 읽고 "이미 지워진 루틴"이라고 말해야 한다.
import { routineFailKind } from '../app/c/[ws]/routines/routine-row.mjs';

test('실패 분류 — routine_not_found(404)만 "이미 지워짐", 코드 없는 404·그 밖의 실패는 다시 시도 안내', () => {
  assert.equal(routineFailKind({ status: 404, errorCode: 'routine_not_found' }), 'gone');
  assert.equal(routineFailKind({ errorCode: 'routine_not_found' }), 'gone');
  assert.equal(routineFailKind({ status: 404 }), 'failed', '코드 없는 404(프록시 등)는 지워졌다고 단정하지 않는다');
  assert.equal(routineFailKind({ status: 404, errorCode: 'company_not_found' }), 'failed', '회사가 없는 404는 루틴이 지워진 것이 아니다');
  assert.equal(routineFailKind({ status: 500 }), 'failed');
  assert.equal(routineFailKind(new TypeError('fetch failed')), 'failed');
  assert.equal(routineFailKind(null), 'failed');
});
