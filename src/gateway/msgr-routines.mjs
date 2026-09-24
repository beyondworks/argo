// 메신저 "업무 > 자동화" 1단계 — Argo 루틴 ↔ msgr_crew_routines 양방향 미러.
// PC → 서버: 크루별 루틴 스냅샷을 올린다(내용이 바뀐 크루만 RPC를 부른다 — 유휴 폴은 호출 0).
// 서버 → PC: 메신저에서 건 대기 편집을 가져와 로컬 루틴에 적용한다. "나중 수정이 이긴다" — 로컬 updatedAt이
// 편집 시점(created_at)보다 나중이면 그 편집은 버리고(superseded) 로컬 상태를 그대로 유지한다.
import { loadRoutines, updateRoutine, removeRoutine } from '../routines.mjs';

/** 이 크루(agentSlug)의 로컬 루틴만 골라 서버 미러 행 모양으로 변환(순수 — 단위 테스트용). */
export function buildRoutineRows(routines, crewSlug) {
  return routines.filter((r) => r.agentSlug === crewSlug).map((r) => ({
    ext_id: r.id,
    title: r.title,
    prompt: r.prompt,
    schedule: r.schedule,
    enabled: !!r.enabled,
    channel_id: r.notifications?.msgr?.channelId ?? r.msgr?.channelId ?? null,
    updated_at: r.updatedAt ?? null,
  }));
}

const pushed = new Map(); // crewId → 마지막으로 올린 rows의 JSON. 같은 내용이면 폴마다 RPC를 부르지 않는다.
export const _resetRoutineMirrorForTest = () => pushed.clear();

/** 크루마다 로컬 루틴 스냅샷을 서버에 미러 — 바뀐 크루에만 syncCrewRoutines를 부른다. */
export async function mirrorRoutines(wsId, { db, crews, load = loadRoutines } = {}) {
  if (!crews?.length) return { synced: 0 };
  const routines = await load(wsId);
  let synced = 0;
  for (const crew of crews) {
    const rows = buildRoutineRows(routines, crew.slug);
    const json = JSON.stringify(rows);
    if (pushed.get(crew.id) === json) continue;
    await db.syncCrewRoutines(crew.org_id, crew.id, rows);
    pushed.set(crew.id, json);
    synced++;
  }
  return { synced };
}

/** 대기 편집 판정(순수 — 단위 테스트용): 로컬 루틴이 편집보다 나중에 바뀌었으면 'superseded', 로컬 루틴이
    이미 없으면(먼저 지워짐) 'noop', 아니면 'apply'. */
export function decideRoutineEdit(localRoutine, edit) {
  if (!localRoutine) return 'noop';
  const localAt = localRoutine.updatedAt ? Date.parse(localRoutine.updatedAt) : NaN;
  const editAt = Date.parse(edit.created_at);
  if (Number.isFinite(localAt) && Number.isFinite(editAt) && localAt > editAt) return 'superseded';
  return 'apply';
}

/** 이 회사(ws)의 내 크루가 속한 조직마다 대기 편집을 가져와 로컬 루틴에 적용 — PC가 켜지면 즉시 반영. */
export async function applyRoutineEdits(wsId, { db, crews, load = loadRoutines, update = updateRoutine, remove = removeRoutine, log = console.error } = {}) {
  if (!crews?.length) return { applied: 0, superseded: 0, failed: 0 };
  const orgIds = [...new Set(crews.map((c) => c.org_id))];
  const edits = (await Promise.all(orgIds.map((orgId) => db.pendingRoutineEdits(orgId).catch((e) => { log('[argo] msgr 루틴 편집 조회 실패:', e.message); return []; })))).flat();
  if (!edits.length) return { applied: 0, superseded: 0, failed: 0 };
  const out = { applied: 0, superseded: 0, failed: 0 };
  for (const edit of edits) {
    const routines = await load(wsId); // 편집마다 다시 읽는다 — 앞선 편집 적용이 같은 루틴을 또 바꿨을 수 있다
    const local = routines.find((r) => r.id === edit.ext_id);
    const decision = decideRoutineEdit(local, edit);
    try {
      if (decision === 'superseded') { await db.routineEditDone(edit.edit_id, 'superseded'); out.superseded++; continue; }
      if (decision === 'noop') { await db.routineEditDone(edit.edit_id, 'applied'); out.applied++; continue; }
      if (edit.op === 'delete') await remove(wsId, edit.ext_id);
      else await update(wsId, edit.ext_id, edit.patch ?? {});
      await db.routineEditDone(edit.edit_id, 'applied');
      out.applied++;
    } catch (e) {
      await db.routineEditDone(edit.edit_id, 'failed', String(e.message ?? e)).catch((e2) => log('[argo] msgr 루틴 편집 상태 기록 실패:', e2.message));
      out.failed++;
    }
  }
  return out;
}
