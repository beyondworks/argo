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
