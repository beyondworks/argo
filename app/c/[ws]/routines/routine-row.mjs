// 루틴 행 표시·조작 규칙 — JSX 없는 순수 함수(node --test가 직접 import해 검증한다. app/lib/approval-display.mjs와 같은 이유).

/** 이 루틴의 크루가 없는가(해고·이름 변경). agents가 null이면(목록을 아직/못 받았으면) 단정하지 않는다 — 조회 실패를
    "전부 크루 없음"으로 보이게 하지 않는다(F4, 2026-10-05). */
export function routineCrewMissing(routine, agents) {
  if (!Array.isArray(agents)) return false;
  return !agents.some((a) => a.slug === routine?.agentSlug);
}

/** 켜기/끄기 낙관 반영 — 누르는 즉시 화면이 바뀌고, 실패하면 revert로 되돌린다(F15). 다른 행은 같은 참조 그대로. */
export function applyRoutineToggle(routines, id, enabled) {
  if (!Array.isArray(routines)) return routines;
  return routines.map((r) => (r.id === id ? { ...r, enabled } : r));
}

/** 상태 칸 종류 — 'off'(꺼짐) · 'crewMissing'(켜져 있지만 크루가 없어 스케줄러가 건너뜀) · 'expired'(한 번만 실행이 지남) · 'on'(가동).
    크루 없음이 만료보다 우선한다(고쳐야 할 쪽이 더 근본이다). UM2: 크루 없는 켜진 루틴이 '가동'으로 보이고 집계되던 것. */
export function routineStateKind(routine, { crewGone, expired }) {
  if (!routine?.enabled) return 'off';
  if (crewGone) return 'crewMissing';
  return expired ? 'expired' : 'on';
}

/** 가동 수 — 켜져 있고 만료가 아니며 크루가 있는 루틴만(영영 안 도는 루틴을 세면 집계도 같은 거짓말을 한다). agents가 null이면 크루 없음으로 단정하지 않는다. */
export function activeRoutineCount(routines, agents, isExpired) {
  if (!Array.isArray(routines)) return 0;
  return routines.filter((r) => routineStateKind(r, { crewGone: routineCrewMissing(r, agents), expired: isExpired(r) }) === 'on').length;
}

/** 켜기·삭제 실패 분류(UL4) — 'gone' = 서버가 "루틴 없음"(routine_not_found)이라 했다: 이미 지워진 루틴이라 다시 시도해도 같은 결과이니 목록을 다시 읽고 그렇게 알린다.
    그 밖(순단·500·코드 없는 404·회사 없음)은 'failed' = 잠시 뒤 다시 시도 안내. err = fetch 실패 예외 또는 { status, errorCode }. */
export function routineFailKind(err) {
  return err?.errorCode === 'routine_not_found' ? 'gone' : 'failed';
}
