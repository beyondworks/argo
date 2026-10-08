// 능동 비서 설정 — <회사>/assistant.json 정규화·읽기.
// 엔진은 읽기만 한다. 쓰는 곳은 설정 API(settings.mjs)뿐이다 — 에이전트 파일 쓰기는 permission-gate WS_CONTROL_FILES가 막고,
// 동기화는 같은 프로세스 간 잠금(sync.mjs isFileLockedRel)으로 이 파일을 쓴다. 파일이 없거나 꺼져 있으면 비서는 네트워크 호출·쓰기 0이다.
//
// 봉인(2단계, #863 2차 검수 LOW): assistant.json은 동기화 대상인데, 이 칸이 없는 옛 버전 본체의 권한 게이트는 assistant.json 쓰기를 막지 않는다.
// 그 기기의 에이전트가 파일 쓰기 한 번으로 비서를 켜면(일정 읽기·알림 시작) 동기화로 새 기기에 퍼진다. 그래서 설정 API가 파일을 쓸 때마다
// 그 바이트의 sha256을 company.json `assistantSeal`에 같이 적고, 엔진은 둘이 맞을 때만 켜진 것으로 본다(loadEffectiveAssistantConfig).
// company.json은 #141(2026-07-28, 첫 발행본 v0.1.33)부터 권한 게이트가 에이전트의 파일 도구(Write·Edit) 쓰기와 이름이 그대로 적힌 셸 명령을 막고,
// 회사 설정 API는 정해진 칸만 받아 이 칸을 고칠 수 없다(test/assistant-settings-adjacent.test.mjs). 막지 못하는 경우: v0.1.32 이하 기기의 에이전트,
// 셸 능력을 켠 에이전트가 이름을 조합해 쓰는 명령('comp'+'any.json') — capabilities.json·fullAuto 같은 다른 제어 파일과 같은 게이트 한계다.
// 바이트 해시라 버전마다 정규화 결과가 달라도 같은 값이고, 손으로 고친 파일·동기화 충돌로 둘이
// 어긋나면 꺼진 쪽으로 간다(설정 화면이 "설정 화면 밖에서 바뀜"을 보여 주고, 다시 켜면 새로 봉인한다).
// 6단계("이런 건 알리지 마")처럼 이 파일을 쓰는 새 경로는 settings.mjs writeSealed로 써야 한다 — 봉인 없이 쓰면 비서가 꺼진다.
import { createHash } from 'node:crypto';
import { stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { paths } from '../workspace.mjs';
import { normalizeTz } from '../routine-time.mjs';

export const ASSISTANT_FILE = 'assistant.json';
export const SEAL_FIELD = 'assistantSeal'; // company.json 칸 이름
/** 봉인 값 — assistant.json 파일 내용(문자열 그대로)의 sha256 hex. */
export const sealOf = (text) => createHash('sha256').update(String(text), 'utf8').digest('hex');
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
  const sig = `${st.mtimeMs}:${st.size}:${st.ino}`; // ino — 원자적 쓰기(rename)는 매번 새 파일이라 같은 시각·같은 크기 덮어쓰기도 가른다
  const hit = cache.get(wsId);
  if (hit?.sig === sig) return hit.cfg;
  let cfg = null;
  try { const text = await readFile(file, 'utf8'); cfg = { ...normalizeAssistantConfig(JSON.parse(text)), seal: sealOf(text) }; warned.delete(wsId); }
  catch (e) {
    if (!warned.has(wsId)) { warned.add(wsId); console.error(`[argo] 비서 설정을 읽지 못해 꺼진 것으로 봅니다(${wsId}): ${String(e?.message ?? e).slice(0, 120)}`); }
  }
  cache.set(wsId, { sig, cfg });
  return cfg;
}
const unsealedWarned = new Set();
/** 엔진이 쓰는 설정 — 켜짐(enabled + 에이전트)이면 company.json 봉인이 이 파일 내용과 맞을 때만 돌려주고, 안 맞으면 null(꺼짐).
    꺼진 설정은 봉인을 보지 않고 그대로 돌려준다(어차피 꺼짐 — company.json을 더 읽지 않는다). 다른 회사 비서 판정(tick.mjs pickCompany)도 이 함수를 써서
    봉인 없는 설정이 이 회사를 쉬게 만들지 못한다. company.json을 읽지 못하면 꺼짐(돈·메일 읽기를 쓰지 않는 쪽). */
export async function loadEffectiveAssistantConfig(wsId) {
  const cfg = await loadAssistantConfig(wsId);
  if (!cfg?.enabled || !cfg.agent) return cfg;
  let seal = null;
  try { const v = JSON.parse(await readFile(paths(wsId).company, 'utf8'))?.[SEAL_FIELD]; seal = typeof v === 'string' ? v : null; } catch { /* 없음·손상 — 봉인 없음 */ }
  if (seal === cfg.seal) { unsealedWarned.delete(wsId); return cfg; }
  if (!unsealedWarned.has(wsId)) { unsealedWarned.add(wsId); console.error(`[argo] 비서 설정이 설정 화면 밖에서 바뀌어 꺼진 것으로 봅니다(${wsId}) — 설정 화면에서 다시 켜면 돌아갑니다`); }
  return null;
}
export const _resetAssistantConfigCacheForTest = () => { cache.clear(); warned.clear(); unsealedWarned.clear(); };
