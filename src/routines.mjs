// 자동화 루틴 — 크루에게 반복 지시를 예약(매일/매주)하거나 즉시 실행한다.
// 실행 = 일반 채팅 턴과 동일 경로(chat) → 결과가 vault 기억으로 남고 자동 링크된다.
import { paths } from './workspace.mjs';
import { chat } from './chat.mjs';
import { emitNotify } from './notify.mjs';
import { runOneShot } from './oneshot.mjs'; // 자연어 → 루틴 초안(러너 독립 — 어떤 러너든 연결만 되면 동작)
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

/** schedule: { type: 'daily'|'weekly', time: 'HH:MM', dow?: 0-6, times?: ['HH:MM'...], dows?: [0-6...] }
    복수 필드(times/dows)가 있으면 우선, 없으면 단수 필드 — 기존 루틴·구버전 동기화 하위호환.
    (export: 단위 테스트용 — 순수 함수) */
const TIME_RE = /^\d{2}:\d{2}$/;
export function normalizeSchedule(schedule = {}) {
  const type = schedule.type === 'weekly' ? 'weekly' : 'daily';
  const rawTimes = Array.isArray(schedule.times) && schedule.times.length ? schedule.times : [schedule.time];
  // 잘못된 항목은 통째로 거절 — 일부만 조용히 수용하면 사용자가 지정한 시각이 소리 없이 빠진다
  if (!rawTimes.every((t) => TIME_RE.test(t || ''))) throw new Error('예약 시각은 HH:MM 형식');
  const times = [...new Set(rawTimes)].sort();
  if (times.length > 8) throw new Error('예약 시각은 하루 8개까지');
  const rawDows = Array.isArray(schedule.dows) && schedule.dows.length ? schedule.dows : [schedule.dow ?? 1];
  const dows = [...new Set(rawDows.map(Number))].sort((a, b) => a - b);
  if (type === 'weekly' && !dows.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) throw new Error('요일은 일(0)~토(6) 범위');
  // 단수 필드(time/dow)는 첫 값으로 함께 유지 — 이 파일을 읽는 구버전(다른 기기 동기화)이 깨지지 않는다
  return { type, time: times[0], times, dow: dows[0], ...(type === 'weekly' ? { dows } : {}) };
}

export async function addRoutine(wsId, { agentSlug, title, prompt, schedule, enabled = true }) {
  if (!agentSlug || !title?.trim() || !prompt?.trim()) throw new Error('크루·제목·지시가 필요합니다');
  const routine = {
    id: `r${Date.now().toString(36)}`,
    agentSlug, title: title.trim(), prompt: prompt.trim(),
    schedule: normalizeSchedule(schedule),
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

/** API 경유 수정 패치 정제 — 편집 가능 필드만 통과(화이트리스트), 각 필드는 addRoutine과 같은 규칙으로 검증.
    실행 기록(lastRun/lastOk/lastResult/created/id)은 API로 덮어쓸 수 없다 — 그건 runRoutine 내부(patchRoutine) 전용.
    (export: 단위 테스트용 — 순수 함수) */
export function sanitizeRoutinePatch(patch = {}) {
  const out = {};
  if ('title' in patch) {
    if (!patch.title?.trim()) throw new Error('제목이 필요합니다');
    out.title = patch.title.trim();
  }
  if ('prompt' in patch) {
    if (!patch.prompt?.trim()) throw new Error('지시가 필요합니다');
    out.prompt = patch.prompt.trim();
  }
  if ('agentSlug' in patch) {
    if (!patch.agentSlug) throw new Error('크루가 필요합니다');
    out.agentSlug = patch.agentSlug;
  }
  if ('schedule' in patch) out.schedule = normalizeSchedule(patch.schedule);
  if ('enabled' in patch) out.enabled = !!patch.enabled;
  return out;
}

export async function updateRoutine(wsId, id, patch) {
  const r = await patchRoutine(wsId, id, sanitizeRoutinePatch(patch));
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
// 예약 시각을 놓쳐도(슬립·재시작으로 폴러가 그 분을 건너뜀) 당일 안에서 1회 catch-up 한다.
// 예전엔 정확히 그 분에만 due라, 그 분을 놓치면 그날은 조용히 스킵돼(아침 브리핑 유실) 스케줄러
// 신뢰가 무너졌다. 지연 상한(4h)으로 23:59에 09:00을 늦게 쏘는 것은 막는다.
const CATCHUP_MS = 4 * 60 * 60 * 1000;
export function isDue(routine, now = new Date()) {
  if (!routine.enabled) return false;
  const s = routine.schedule ?? {};
  const times = Array.isArray(s.times) && s.times.length ? s.times : [s.time];
  const dows = Array.isArray(s.dows) && s.dows.length ? s.dows : [s.dow ?? 1];
  if (s.type === 'weekly' && !dows.includes(now.getDay())) return false;
  // 슬롯별 판정 — 각 시각이 독립 슬롯. 앞 슬롯 실행(lastRun 갱신)이 뒤 슬롯을 막지 않는다
  // (lastRun < 뒤 슬롯 sched이므로). 스케줄러의 선점 마킹(lastRun=now)과도 그대로 호환된다.
  for (const tm of times) {
    const [h, m] = String(tm ?? '').split(':').map(Number);
    if (!Number.isInteger(h) || !Number.isInteger(m)) continue;
    const sched = new Date(now); sched.setHours(h, m, 0, 0); // 오늘의 예약 시각(로컬)
    if (now < sched) continue;              // 아직 예약 시각 전
    if (now - sched > CATCHUP_MS) continue;  // 지연 상한 초과 — 낡은 실행 억제
    if (routine.lastRun) {
      if (new Date(routine.lastRun) >= sched) continue; // 이 슬롯 예약분 이미 실행됨
    } else if (routine.created && sched < new Date(routine.created)) {
      // 신규 루틴 — 생성 이전 시각은 '놓친 실행'이 아니다. 예약 시각이 지난 뒤 만든 루틴이
      // catch-up으로 즉시 발화하던 것을 막는다(예: 11시에 만든 09:00 루틴은 내일부터).
      continue;
    }
    return true;
  }
  return false;
}

/* ─── 자연어 → 루틴 초안 (러너 독립) ─────────────────────────────────────── */

/** 모델 출력에서 JSON 오브젝트 추출 — ```json 펜스 또는 첫 { ~ 마지막 }. 실패 시 throw. */
function extractJson(text) {
  const fenced = String(text ?? '').match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : String(text ?? '');
  const a = raw.indexOf('{'); const b = raw.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('해석 결과가 JSON이 아닙니다');
  return JSON.parse(raw.slice(a, b + 1));
}

/** 초안 검증 — 모델 출력은 신뢰하지 않는다: 스케줄은 normalizeSchedule 재검증, 크루는 명단 대조.
    트리거형(unsupported)은 그대로 통과시켜 UI가 정직하게 안내한다. (export: 단위 테스트용 — 순수 함수) */
export function validateRoutineDraft(parsed, { agents = [] } = {}) {
  if (parsed?.unsupported) {
    return { unsupported: String(parsed.unsupported), reason: String(parsed.reason ?? '').slice(0, 200) };
  }
  const title = String(parsed?.title ?? '').trim().slice(0, 80);
  const prompt = String(parsed?.prompt ?? '').trim().slice(0, 2000);
  if (!title || !prompt) throw new Error('해석 결과에 제목/지시가 없습니다');
  const schedule = normalizeSchedule(parsed?.schedule ?? {});
  // 명단에 없는 크루는 null — UI가 현재 선택을 유지한다(모델이 지어낸 slug 채택 금지)
  const agentSlug = agents.some((a) => a.slug === parsed?.agentSlug) ? parsed.agentSlug : null;
  return { draft: { title, prompt, schedule, agentSlug } };
}

const DRAFT_PROMPT = (text, roster) => `너는 루틴(반복 업무) 설정 도우미다. 사용자의 요청을 아래 JSON으로만 변환해 출력하라. JSON 외 텍스트·설명 금지.
스키마: {"title": "짧은 제목", "prompt": "크루에게 줄 반복 지시문(요청의 목적을 보존)", "schedule": {"type": "daily"|"weekly", "times": ["HH:MM", ...], "dows": [0-6 정수 배열 — weekly일 때만, 0=일요일]}, "agentSlug": "아래 크루 목록의 slug — 사용자가 특정 크루를 지목했을 때만, 아니면 null"}
크루 목록:
${roster || '(없음)'}
규칙:
- 요일 언급이 있으면 weekly + dows. "평일"=[1,2,3,4,5], "주말"=[0,6]. 요일 언급이 없으면 daily.
- 시각은 24시간 HH:MM. 복수 언급이면 전부 넣는다. 시각 언급이 없으면 ["09:00"].
- 시각·주기와 무관한 내용은 전부 prompt에 담는다. 사용자의 언어를 유지한다.
- 이벤트 트리거 요청(예: "메일이 오면", "댓글 달리면", "~할 때마다")은 아직 미지원 — 그때만 {"unsupported": "trigger", "reason": "무엇이 트리거인지 한 줄"}을 출력한다.
사용자 요청: <<<${text}>>>`;

/** 자연어 한 줄 → 루틴 초안. 반환 { draft } 또는 { unsupported, reason }. 러너 미연결 등은 throw(원문 안내). */
export async function draftRoutineFromText(wsId, text, { agents = [], lang = 'ko' } = {}) {
  if (!String(text ?? '').trim()) throw new Error(lang === 'en' ? 'Describe the routine first' : '루틴 내용을 먼저 적어주세요');
  const roster = agents.map((a) => `- ${a.slug}: ${a.name} (${a.role ?? ''})`).join('\n');
  const { text: out } = await runOneShot(wsId, DRAFT_PROMPT(String(text).slice(0, 1000), roster), { lang, timeoutMs: 90_000 });
  let parsed;
  try {
    parsed = extractJson(out);
  } catch {
    throw new Error(lang === 'en' ? 'Could not parse the request — try rephrasing it' : '요청을 해석하지 못했습니다 — 표현을 바꿔 다시 시도해 주세요');
  }
  return validateRoutineDraft(parsed, { agents });
}
