// 자동화 루틴 — 크루에게 반복 지시를 예약(매일/매주)하거나 즉시 실행한다.
// 실행 = 일반 채팅 턴과 동일 경로(chat) → 결과가 vault 기억으로 남고 자동 링크된다.
import { readFile, writeFile } from 'node:fs/promises';
import { paths } from './workspace.mjs';
import { chat } from './chat.mjs';
import { emitNotify } from './notify.mjs';

export async function loadRoutines(wsId) {
  try { return JSON.parse(await readFile(paths(wsId).routines, 'utf8')); } catch { return []; }
}

async function saveRoutines(wsId, routines) {
  await writeFile(paths(wsId).routines, JSON.stringify(routines, null, 2));
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
  routines.push(routine);
  await saveRoutines(wsId, routines);
  return routine;
}

export async function updateRoutine(wsId, id, patch) {
  const routines = await loadRoutines(wsId);
  const r = routines.find((x) => x.id === id);
  if (!r) throw new Error('루틴을 찾을 수 없습니다');
  Object.assign(r, patch, { id: r.id });
  await saveRoutines(wsId, routines);
  return r;
}

export async function removeRoutine(wsId, id) {
  const routines = await loadRoutines(wsId);
  await saveRoutines(wsId, routines.filter((x) => x.id !== id));
}

/** 루틴 실행 — 새 세션 1턴. 결과 요약을 루틴에 기록(전체는 vault 핸드오버에). */
export async function runRoutine(wsId, id) {
  const routines = await loadRoutines(wsId);
  const r = routines.find((x) => x.id === id);
  if (!r) throw new Error('루틴을 찾을 수 없습니다');
  r.lastRun = new Date().toISOString();
  try {
    const t = await chat(wsId, r.agentSlug, `[루틴: ${r.title}] ${r.prompt}`, null);
    r.lastOk = true;
    r.lastResult = t.reply.replace(/\s+/g, ' ').slice(0, 160);
    await saveRoutines(wsId, routines);
    emitNotify({ type: 'routine', wsId, routine: r, ok: true, reply: t.reply }); // 메신저 브리핑 푸시
    return { ok: true, reply: t.reply, handover: t.handover };
  } catch (e) {
    r.lastOk = false;
    r.lastResult = String(e.message || e).slice(0, 160);
    await saveRoutines(wsId, routines);
    emitNotify({ type: 'routine', wsId, routine: r, ok: false, reply: r.lastResult });
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
