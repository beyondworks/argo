// 자동화 루틴 — 크루에게 반복 지시를 예약(매일/매주)하거나 즉시 실행한다.
// 실행 = 일반 채팅 턴과 동일 경로(chat) → 결과가 vault 기억으로 남고 자동 링크된다.
import { paths } from './workspace.mjs';
import { chat } from './chat.mjs';
import { emitNotify } from './notify.mjs';
import { writeJsonAtomic, readJson } from './jsonstore.mjs';
import { withLock } from './mutex.mjs';

const lockKey = (wsId) => `routines:${wsId}`;

/** 락 안에서 목록 재로드 → 해당 id만 patch → 저장. 실행 중 삭제/비활성이 되돌려지는 것을 막는다. */
async function patchRoutine(wsId, id, patch) {
  return withLock(lockKey(wsId), async () => {
    const routines = await loadRoutines(wsId);
    const r = routines.find((x) => x.id === id);
    if (!r) return null; // 실행 중 삭제됐으면 조용히 포기(부활 금지)
    Object.assign(r, patch, { id: r.id });
    await saveRoutines(wsId, routines);
    return { ...r };
  });
}

export async function loadRoutines(wsId) {
  // 예약 지시는 유실 시 재생성 불가 — 손상을 조용히 빈 목록으로 리셋하지 않고 throw로 드러낸다.
  return readJson(paths(wsId).routines, []);
}

async function saveRoutines(wsId, routines) {
  await writeJsonAtomic(paths(wsId).routines, routines);
}

/** schedule: { type: 'daily'|'weekly', time: 'HH:MM', dow?: 0-6 } */
export async function addRoutine(wsId, { agentSlug, title, prompt, schedule, enabled = true }) {
  if (!agentSlug || !title?.trim() || !prompt?.trim()) throw new Error('크루·제목·지시가 필요합니다');
  if (!/^\d{2}:\d{2}$/.test(schedule?.time || '')) throw new Error('예약 시각은 HH:MM 형식');
  const routines = await loadRoutines(wsId);
  const routine = {
    id: `r${Date.now().toString(36)}`,
    agentSlug, title: title.trim(), prompt: prompt.trim(),
    schedule: { type: schedule.type === 'weekly' ? 'weekly' : 'daily', time: schedule.time, dow: schedule.dow ?? 1 },
    enabled,
    created: new Date().toISOString(),
    lastRun: null, lastOk: null, lastResult: '',
  };
  return withLock(lockKey(wsId), async () => {
    const routines = await loadRoutines(wsId);
    routines.push(routine);
    await saveRoutines(wsId, routines);
    return routine;
  });
}

export async function updateRoutine(wsId, id, patch) {
  const r = await patchRoutine(wsId, id, patch);
  if (!r) throw new Error('루틴을 찾을 수 없습니다');
  return r;
}

export async function removeRoutine(wsId, id) {
  return withLock(lockKey(wsId), async () => {
    const routines = await loadRoutines(wsId);
    await saveRoutines(wsId, routines.filter((x) => x.id !== id));
  });
}

/** 루틴 실행 — 새 세션 1턴. 결과 요약을 루틴에 기록(전체는 vault 핸드오버에).
    chat()은 수 분 걸리므로 락 밖에서 돌리고, 결과 기록만 락 안에서 해당 루틴 필드에 반영한다
    — 실행 도중 사용자가 다른 루틴을 지우거나 이 루틴을 꺼도 낡은 전체 스냅샷으로 되돌리지 않는다. */
export async function runRoutine(wsId, id) {
  const r0 = await patchRoutine(wsId, id, { lastRun: new Date().toISOString() });
  if (!r0) throw new Error('루틴을 찾을 수 없습니다');
  try {
    const t = await chat(wsId, r0.agentSlug, `[루틴: ${r0.title}] ${r0.prompt}`, null, { source: 'routine' });
    const summary = t.reply.replace(/\s+/g, ' ').slice(0, 160);
    const r = await patchRoutine(wsId, id, { lastOk: true, lastResult: summary });
    emitNotify({ type: 'routine', wsId, routine: r ?? r0, ok: true, reply: t.reply }); // 메신저 브리핑 푸시
    return { ok: true, reply: t.reply, handover: t.handover };
  } catch (e) {
    const msg = String(e.message || e).slice(0, 160);
    const r = await patchRoutine(wsId, id, { lastOk: false, lastResult: msg });
    emitNotify({ type: 'routine', wsId, routine: r ?? r0, ok: false, reply: msg });
    throw e;
  }
}

/** 스케줄러용 — 이 분(minute)에 실행해야 하나. */
export function isDue(routine, now = new Date()) {
  if (!routine.enabled) return false;
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  if (routine.schedule.time !== hhmm) return false;
  if (routine.schedule.type === 'weekly' && now.getDay() !== routine.schedule.dow) return false;
  // 같은 분에 중복 실행 방지
  if (routine.lastRun && new Date(routine.lastRun).toISOString().slice(0, 16) === now.toISOString().slice(0, 16)) return false;
  return true;
}
