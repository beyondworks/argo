// 메신저 "업무 > 자동화" 1단계 — Argo 루틴 ↔ msgr_crew_routines 양방향 미러.
// PC → 서버: 크루별 루틴 스냅샷을 올린다(내용이 바뀐 크루만 RPC를 부른다 — 유휴 폴은 호출 0).
// 서버 → PC: 메신저에서 건 대기 편집을 가져와 로컬 루틴에 적용한다. "나중 수정이 이긴다" — 로컬 editedAt이
// 편집 시점(created_at)보다 나중이면 그 편집은 버리고(superseded) 로컬 상태를 그대로 유지한다.
// editedAt은 사람이 실제로 루틴 내용을 고친 시각만이다(routines.mjs addRoutine·updateRoutine·resumeLoop) —
// runRoutine의 실행 기록(lastRun 등)은 안 찍는다(분리 검수 H1: 실행만 해도 대기 편집이 오판되던 결함).
import { loadRoutines, updateRoutine, removeRoutine } from '../routines.mjs';

// M1: 메신저 편집이 건드릴 수 있는 필드는 이 넷뿐 — agentSlug·notifications·loop·verify는 서버 RPC도 거절하지만
// PC 쪽에서도 한 번 더 좁힌다(서버가 뚫려도 로컬 반영은 안전).
const EDITABLE_FIELDS = ['title', 'prompt', 'schedule', 'enabled'];
const pickEditable = (patch = {}) => Object.fromEntries(EDITABLE_FIELDS.filter((k) => k in patch).map((k) => [k, patch[k]]));

// 옛 서버(이 RPC들이 없음)는 조용히 물러난다 — src/gateway/msgr.mjs의 crewMemory와 같은 신호.
const isMissingSchema = (e) => ['PGRST202', '42883', 'PGRST205'].includes(e?.code);
// 재검수(2차) N1: 같은 입력을 다시 보내도 똑같이 막히는 실패만 "영구"다 — RLS 거절(42501)·무결성/제약 위반(23xxx)·
// 입력 형식 오류(22xxx)·우리 RPC가 던진 msgr_routine_* 예외. 그 외(네트워크 끊김, 타임아웃 등)는 일시 오류로 본다.
const isPermanentRoutineError = (e) => e?.code === '42501' || /^23/.test(String(e?.code ?? '')) || /^22/.test(String(e?.code ?? '')) || /msgr_routine_/.test(String(e?.message ?? ''));

/** 이 크루(agentSlug)의 로컬 루틴만 골라 서버 미러 행 모양으로 변환(순수 — 단위 테스트용). */
export function buildRoutineRows(routines, crewSlug) {
  return routines.filter((r) => r.agentSlug === crewSlug).map((r) => ({
    ext_id: r.id,
    title: r.title,
    prompt: r.prompt,
    schedule: r.schedule,
    enabled: !!r.enabled,
    channel_id: r.notifications?.msgr?.channelId ?? r.msgr?.channelId ?? null,
    updated_at: r.editedAt ?? null,
  }));
}

// 재검수(3차) N5: 캐시를 wsId별로 나눈다. 크루 id 자체는 전역 uuid라 겹치지 않지만, forgetMissingCrews가
// "이번 호출의 크루 목록에 없으면 지운다"를 하나의 공유 맵에 걸면 회사(wsId) A를 처리할 때 그 목록에 없는
// 회사 B의 크루 캐시까지 지워버린다 — 한 프로세스가 회사 여러 개를 번갈아 돌리는 drain 루프에서 두 회사가
// 서로의 캐시를 계속 비워 유휴 상태에서도 매 틱 전부 재동기화됐다.
const pushedByWs = new Map();     // wsId → Map(crewId → 마지막으로 올린 rows의 JSON)
const failedHashByWs = new Map(); // wsId → Map(crewId → 영구 오류로 실패한 rows의 JSON)
const backoffUntilByWs = new Map();   // wsId → Map(crewId → 다음 재시도 가능 시각)
const backoffAttemptsByWs = new Map(); // wsId → Map(crewId → 연속 일시 오류 횟수)
const BACKOFF_BASE_MS = 15_000, BACKOFF_CAP_MS = 300_000; // 15초 → 최대 5분
let unsupportedUntil = 0; // N2-b: 옛 서버(RPC 없음) 판정은 wsId 무관 — 같은 세션이 붙는 같은 서버라 프로세스 단위로 기억한다.
const UNSUPPORTED_RECHECK_MS = 10 * 60_000;
const forWs = (byWs, wsId) => { if (!byWs.has(wsId)) byWs.set(wsId, new Map()); return byWs.get(wsId); };

export const _resetRoutineMirrorForTest = () => { pushedByWs.clear(); failedHashByWs.clear(); backoffUntilByWs.clear(); backoffAttemptsByWs.clear(); unsupportedUntil = 0; };

/** 이번 틱의 크루 집합에서 빠진 크루의 캐시를 지운다(N2) — 이 wsId 몫의 맵만 건드린다(N5: 다른 회사 캐시는 안 건드림).
    회수(active→available)·오프보딩으로 서버 트리거가 미러 행을 지운 뒤 재파견(다시 active)되면, 크루 id는 같아도
    서버 상태가 리셋된 것이므로 다시 올려야 한다. myCrews()가 status='active'만 돌려주므로 "이번 틱에 없다"는
    곧 "active를 벗어났다"는 신호다. */
function forgetMissingCrews(wsId, currentIds) {
  for (const byWs of [pushedByWs, failedHashByWs, backoffUntilByWs, backoffAttemptsByWs]) {
    const map = byWs.get(wsId);
    if (!map) continue;
    for (const id of [...map.keys()]) if (!currentIds.has(id)) map.delete(id);
  }
}

/** 크루마다 로컬 루틴 스냅샷을 서버에 미러 — 바뀐 크루에만 syncCrewRoutines를 부른다.
    M2: 한 크루의 실패가 나머지 크루의 미러를 막지 않는다(크루별 try/catch).
    N1: 영구 오류만 "같은 내용이면 재시도 안 함"에 걸리고, 일시 오류는 지수 백오프로 다음 틱들에 다시 시도한다.
    N2-b: 옛 서버 판정은 프로세스 단위로 10분 캐시 — 매 틱 크루 수만큼 RPC를 부르지 않는다.
    N5: 캐시는 wsId별로 격리 — 회사(워크스페이스) 여러 개를 번갈아 돌려도 서로의 캐시를 안 지운다. */
export async function mirrorRoutines(wsId, { db, crews, load = loadRoutines, log = console.error, now = Date.now } = {}) {
  const pushed = forWs(pushedByWs, wsId), failedHash = forWs(failedHashByWs, wsId);
  const backoffUntil = forWs(backoffUntilByWs, wsId), backoffAttempts = forWs(backoffAttemptsByWs, wsId);
  // crews는 매 호출 db.myCrews()의 실제 스냅샷(빈 배열도 "지금 active 크루가 없다"는 진짜 신호 — 조회 실패는
  // 호출부가 던진다) — 그래서 비어 있어도 먼저 캐시를 정리한다. 안 그러면 크루 전체가 회수된 뒤 재파견돼도
  // 캐시가 안 지워진 채 남아 "다음 sync가 다시 채운다"(마이그레이션 주석)가 거짓이 된다(N2).
  forgetMissingCrews(wsId, new Set((crews ?? []).map((c) => c.id)));
  if (!crews?.length) return { synced: 0, failed: 0, unsupported: false };
  if (now() < unsupportedUntil) return { synced: 0, failed: 0, unsupported: true };
  const routines = await load(wsId);
  let synced = 0, failed = 0, unsupported = false;
  for (const crew of crews) {
    const rows = buildRoutineRows(routines, crew.slug);
    const json = JSON.stringify(rows);
    if (pushed.get(crew.id) === json) continue;
    if (failedHash.get(crew.id) === json) continue; // 직전에 이 내용으로 "영구" 실패했다 — 내용이 안 바뀌었으면 다시 두드리지 않는다
    if (now() < (backoffUntil.get(crew.id) ?? 0)) continue; // 일시 오류 백오프 중
    try {
      const result = await db.syncCrewRoutines(crew.org_id, crew.id, rows);
      if (result === undefined) { unsupported = true; unsupportedUntil = now() + UNSUPPORTED_RECHECK_MS; break; } // 옛 서버(M4) — 다음 크루도 같은 서버라 더 두드리지 않는다
      // L-b(부분): 서버가 반영(kept)하거나 스스로 건너뛴(skipped) 행이 보낸 행 수와 맞지 않으면 서버 상태가 예상과 어긋난 것 —
      // 다음 틱에 다시 확인하도록 캐시를 남기지 않는다. 판정은 서버 응답만으로(클라이언트가 유효 행을 따로 세면 공백 제목 같은
      // 서버·클라이언트 기준 차이로 영영 안 맞아 유휴 폴링이 매 틱 RPC가 된다 — 4차 검수 L-d).
      // ponytail: 한 틱 안의 회수·재파견(캐시 내용이 같아 RPC를 안 부름)은 못 잡는다. 크루 status 전이 시각을 캐시 키에 넣으면 닫힌다.
      if (typeof result?.kept === 'number' && result.kept + (result.skipped ?? 0) !== rows.length) {
        pushed.delete(crew.id);
      } else {
        pushed.set(crew.id, json);
      }
      failedHash.delete(crew.id);
      backoffUntil.delete(crew.id);
      backoffAttempts.delete(crew.id);
      synced++;
    } catch (e) {
      failed++;
      if (isPermanentRoutineError(e)) {
        failedHash.set(crew.id, json);
        backoffUntil.delete(crew.id); backoffAttempts.delete(crew.id); // 영구 오류는 해시로만 막는다 — 시간 백오프까지 겹치면 내용을 고쳐도 더 오래 막힌다
      } else {
        const attempts = (backoffAttempts.get(crew.id) ?? 0) + 1;
        backoffAttempts.set(crew.id, attempts);
        backoffUntil.set(crew.id, now() + Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (attempts - 1)));
      }
      log('[argo] msgr 루틴 미러 실패(crew=' + crew.slug + '):', e.message);
    }
  }
  return { synced, failed, unsupported };
}

/** 대기 편집 판정(순수 — 단위 테스트용): 로컬 루틴이 편집보다 나중에 바뀌었으면 'superseded', 로컬 루틴이
    이미 없으면(먼저 지워졌거나 이 ws 소관이 아님) 'notfound', 아니면 'apply'. */
export function decideRoutineEdit(localRoutine, edit) {
  if (!localRoutine) return 'notfound';
  const localAt = localRoutine.editedAt ? Date.parse(localRoutine.editedAt) : NaN;
  const editAt = Date.parse(edit.created_at);
  if (Number.isFinite(localAt) && Number.isFinite(editAt) && localAt > editAt) return 'superseded';
  return 'apply';
}

/** 이 회사(ws)의 내 크루가 속한 조직마다 대기 편집을 가져와 로컬 루틴에 적용 — PC가 켜지면 즉시 반영.
    H2: 조직별로 "내 크루 id 목록"까지 서버에 넘겨 다른 워크스페이스의 크루가 낀 편집을 아예 끌어오지 않는다.
    H4: 한 크루가 여러 조직에 파견돼 같은 루틴(ext_id)에 중복 편집이 생기면, 전체를 시각순으로 합쳐 가장 나중
    편집만 적용하고 나머지는 superseded로 닫는다(오래된 편집이 나중에 처리돼 새 편집을 덮어쓰는 사고 방지).
    N2-b: 옛 서버 판정은 mirrorRoutines와 같은 프로세스 단위 10분 캐시를 공유한다. */
export async function applyRoutineEdits(wsId, { db, crews, load = loadRoutines, update = updateRoutine, remove = removeRoutine, log = console.error, now = Date.now } = {}) {
  if (!crews?.length) return { applied: 0, superseded: 0, failed: 0, unsupported: false };
  if (now() < unsupportedUntil) return { applied: 0, superseded: 0, failed: 0, unsupported: true };
  const crewIdsByOrg = new Map();
  for (const c of crews) { if (!crewIdsByOrg.has(c.org_id)) crewIdsByOrg.set(c.org_id, []); crewIdsByOrg.get(c.org_id).push(c.id); }
  let unsupported = false;
  const fetched = await Promise.all([...crewIdsByOrg.entries()].map(async ([orgId, crewIds]) => {
    try {
      const rows = await db.pendingRoutineEdits(orgId, crewIds);
      if (rows === undefined) { unsupported = true; unsupportedUntil = now() + UNSUPPORTED_RECHECK_MS; return []; }
      return rows;
    } catch (e) {
      if (isMissingSchema(e)) { unsupported = true; unsupportedUntil = now() + UNSUPPORTED_RECHECK_MS; return []; }
      log('[argo] msgr 루틴 편집 조회 실패:', e.message);
      return [];
    }
  }));
  const edits = fetched.flat().sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  if (!edits.length) return { applied: 0, superseded: 0, failed: 0, unsupported };
  // H4: 같은 ext_id는 시각순으로 정렬된 배열의 마지막 것만 최신이다.
  const latestByExt = new Map();
  for (const e of edits) latestByExt.set(e.ext_id, e);
  const out = { applied: 0, superseded: 0, failed: 0, unsupported };
  const finish = async (editId, status, error) => { try { await db.routineEditDone(editId, status, error); } catch (e) { if (!isMissingSchema(e)) log('[argo] msgr 루틴 편집 상태 기록 실패:', e.message); } };
  for (const edit of edits) {
    if (latestByExt.get(edit.ext_id) !== edit) { await finish(edit.edit_id, 'superseded', 'newer edit applied for the same routine elsewhere'); out.superseded++; continue; }
    const routines = await load(wsId); // 편집마다 다시 읽는다 — 앞선 편집 적용이 같은 루틴을 또 바꿨을 수 있다
    const local = routines.find((r) => r.id === edit.ext_id);
    const decision = decideRoutineEdit(local, edit);
    try {
      if (decision === 'superseded') { await finish(edit.edit_id, 'superseded'); out.superseded++; continue; }
      if (decision === 'notfound') { await finish(edit.edit_id, 'failed', 'routine_not_found'); out.failed++; continue; } // M3/H2: noop을 조용히 applied로 덮지 않는다
      if (edit.op === 'delete') await remove(wsId, edit.ext_id);
      else await update(wsId, edit.ext_id, pickEditable(edit.patch)); // M1: 화이트리스트 밖 필드는 로컬에도 안 넣는다
      await finish(edit.edit_id, 'applied');
      out.applied++;
    } catch (e) {
      await finish(edit.edit_id, 'failed', String(e.message ?? e));
      out.failed++;
    }
  }
  return out;
}
