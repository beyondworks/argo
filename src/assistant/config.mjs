// 능동 비서 설정 — <회사>/assistant.json 정규화·읽기.
// 이 단계(1단계: 일정 감시 엔진)는 읽기만 한다. 쓰는 곳은 설정 API(2단계)와 사람뿐이다 — 에이전트 파일 쓰기는 permission-gate WS_CONTROL_FILES가 막고,
// 동기화는 같은 프로세스 간 잠금(sync.mjs isFileLockedRel)으로 이 파일을 쓴다. 파일이 없거나 꺼져 있으면 비서는 네트워크 호출·쓰기 0이다.
import { stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { paths } from '../workspace.mjs';
import { normalizeTz } from '../routine-time.mjs';

export const ASSISTANT_FILE = 'assistant.json';
export const LEAD_CHOICES = Object.freeze([10, 15, 30, 60]);
export const DAILY_CAP_RANGE = Object.freeze([1, 30]);
export const DEFAULTS = Object.freeze({
  leadMinutes: 30,
  morningAt: '08:00',
  eveningAt: '21:00',
  quiet: Object.freeze({ from: '23:00', to: '08:00', calendarAlerts: false }),
  dailyCap: 10,
});

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const hhmm = (v, d) => (HHMM_RE.test(String(v ?? '')) ? String(v) : d);
/** 에이전트 slug — 카드 파일 이름이 되는 값. 경로 구분자·널 문자만 거른다(작명 규칙은 영입 문의 몫 — persona.mjs cardPath와 같은 기준). */
const agentOk = (v) => typeof v === 'string' && v.length > 0 && v.length <= 100 && !/[\\/\0]/.test(v) && v !== '.' && v !== '..';
const msOf = (v) => { const t = Date.parse(String(v ?? '')); return Number.isFinite(t) ? t : null; };

/** 저장값 → 엔진이 쓰는 모양(순수). 모르는 값은 기본값으로, 켜짐은 true일 때만. 아침 시각이 저녁 시각보다 늦으면 둘 다 기본값으로 되돌린다. */
export function normalizeAssistantConfig(raw) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const w = r.watch && typeof r.watch === 'object' ? r.watch : {};
  const q = r.quiet && typeof r.quiet === 'object' ? r.quiet : {};
  let morningAt = hhmm(r.morningAt, DEFAULTS.morningAt);
  let eveningAt = hhmm(r.eveningAt, DEFAULTS.eveningAt);
  if (morningAt >= eveningAt) { morningAt = DEFAULTS.morningAt; eveningAt = DEFAULTS.eveningAt; }
  const cap = Number(r.dailyCap);
  return {
    enabled: r.enabled === true,
    agent: agentOk(r.agent) ? r.agent : null,
    enabledAt: msOf(r.enabledAt), // 켠 시각 — 같은 사용자의 다른 회사와 겹치면 나중에 켠 쪽이 맡는다(C14), 다시 켰을 때 그 전 일은 지난 일로 알리지 않는다
    // 볼 것 — 이 단계는 일정만 실제로 본다(메일 4단계, 할 일·거래 5단계). 기본은 전부 켬.
    watch: { calendar: w.calendar !== false, mail: w.mail !== false, tasks: w.tasks !== false, deals: w.deals !== false },
    leadMinutes: LEAD_CHOICES.includes(Number(r.leadMinutes)) ? Number(r.leadMinutes) : DEFAULTS.leadMinutes,
    morningAt,
    eveningAt,
    quiet: { from: hhmm(q.from, DEFAULTS.quiet.from), to: hhmm(q.to, DEFAULTS.quiet.to), calendarAlerts: q.calendarAlerts === true },
    dailyCap: Number.isInteger(cap) && cap >= DAILY_CAP_RANGE[0] && cap <= DAILY_CAP_RANGE[1] ? cap : DEFAULTS.dailyCap,
    tz: normalizeTz(r.tz), // null = 기기 로컬(루틴과 같은 폴백)
  };
}

/** 이 단계에서 감시기가 할 일이 있는가 — 켜짐 + 비서 에이전트 지정 + 일정 보기. */
export const calendarActive = (cfg) => !!(cfg?.enabled && cfg.agent && cfg.watch.calendar);

const cache = new Map(); // wsId → { sig, cfg } — 파일 수정 시각·크기가 같으면 메모리 값을 다시 쓴다(사이 틱에 파일을 다시 파싱하지 않는다)
const warned = new Set();

/** 회사 비서 설정 읽기 — 없으면 null(꺼짐). 손상(JSON 아님)도 null로 보고 프로세스당 한 번 알린다(설정 파일이 깨졌다고 알림을 켜지 않는다 — 돈·메일 읽기를 쓰지 않는 쪽). */
export async function loadAssistantConfig(wsId) {
  const file = join(paths(wsId).root, ASSISTANT_FILE);
  let st;
  try { st = await stat(file); } catch { cache.delete(wsId); return null; }
  const sig = `${st.mtimeMs}:${st.size}`;
  const hit = cache.get(wsId);
  if (hit?.sig === sig) return hit.cfg;
  let cfg = null;
  try { cfg = normalizeAssistantConfig(JSON.parse(await readFile(file, 'utf8'))); warned.delete(wsId); }
  catch (e) {
    if (!warned.has(wsId)) { warned.add(wsId); console.error(`[argo] 비서 설정을 읽지 못해 꺼진 것으로 봅니다(${wsId}): ${String(e?.message ?? e).slice(0, 120)}`); }
  }
  cache.set(wsId, { sig, cfg });
  return cfg;
}
export const _resetAssistantConfigCacheForTest = () => { cache.clear(); warned.clear(); };
