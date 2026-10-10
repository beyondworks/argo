// 능동 비서(하트비트) 설정 쓰기·보기(2단계) — 설정 API(app/api/companies/[ws]/assistant/route.js)가 부른다. 관리 화면은 루틴 화면의 하트비트 칸
// (app/c/[ws]/routines/heartbeat-card.jsx — 유건 10/10), 에이전트 카드 하트비트 탭은 보기 전용이다.
//
// 쓰기 = assistant.json + company.json 봉인(config.mjs 머리 주석). 둘은 assistant.json의 프로세스 간 잠금 안에서 파일 → 봉인 순서로 쓴다.
// 그 사이에 엔진 틱이 끼면 둘이 어긋나 그 틱은 꺼짐(쓰기·호출 0)이다 — 켜진 쪽으로 잘못 가는 순서는 없다.
//
// 화면이 다루는 칸: 켜기·일시 정지(+ 어느 에이전트), 확인 주기(일정 전체 읽기 간격), 일정 알림 몇 분 전, 내일 일정 요약(저녁 묶음) 시각, 조용한 시간과 그 예외, 메일.
// 끄기(삭제)는 removeAssistantSettings — 다른 회사를 끌 때와 같은 offFile이라 봉인과 다시 맞춰질 수 없고, 다시 만들면 기본값에서 시작한다.
// 아침 묶음 시각은 고르지 않는다 — 조용한 시간이 끝나는 시각이다(설계 13절 "조용한 시간 끝과 같게"). 고를 필요 없는 값은 제품이 정한다.
// 볼 것은 일정·메일(할 일·거래 5단계). 처음 켤 때 메일은 사용자가 "무엇을 알려 줄까요 → 메일"을 고른 때만 켜고, 할 일·거래는 false로 적는다 — 사용자가 따로 켜기 전에는
// 읽지 않는다(설계 3.2 "동의 없이 메일을 읽지 않는다"). 하루 즉시 알림 상한(dailyCap)은 제품이 정하는 값이라 고르는 칸이 없다(저장값·기본값 10 그대로 — 엔진이 쓰고 상태 칸에 "n/상한"으로 보인다).
//
// 화면 밖 칸 이어받기: 봉인이 맞는 파일이면 이 화면이 다루지 않는 칸(나중 단계의 칸, 볼 것)을 그대로 둔다 — 새 버전 기기가 저장한 칸을 옛 화면이 지우지 않게.
// 봉인이 안 맞거나 없으면 처음 켜는 것처럼 기본값에서 시작한다 — 화면 밖에서 바뀐 값(예: 에이전트가 심은 watch.mail:true)을 다시 봉인하지 않게.
//
// 사용자당 비서 1명(설계 3.2): 켜거나 바꾸면 같은 주인의 다른 회사에서 켜져 있던(봉인이 맞는) 비서를 끈다. 다른 기기에서 거의 같은 때 켠 경우는
// 엔진이 켠 시각이 늦은 쪽만 돌린다(rules.mjs assistantCompanyOf). 이 기기의 저장끼리는 한 줄로 세운다(SAVE_LOCK).
// 다른 회사를 끌 때는 그 회사의 assistant.json만 꺼짐으로 쓰고 company.json(봉인)은 건드리지 않는다(H63, #865 3차 검수 R7) — 사용자가 손대지 않은 회사의
// company.json을 다시 쓰면, 다른 기기에서 방금 보관한 그 회사가 동기화의 보관 마커 규칙(sync.mjs syncTombstones: company.json 수정 시각 ≥ 보관 시각이면
// "보관 이후 수정" → 마커 철회)에 걸려 되살아났다. 꺼진 설정은 엔진이 봉인을 보지 않으므로(config.mjs) 모든 버전에서 꺼짐이고, 화면은 이 꺼짐을
// "화면 밖 변경" 없이 꺼짐으로 보인다.
// 끈 파일의 모양(offFile, #894 보안 검토 두 건): { enabled: false, agent }만 쓴다 — 봉인과 다시 맞춰질 수 없고, 이어받을 값도 담지 않는다.
//  · company.json 봉인은 예전 '켜짐' 바이트를 가리키므로, 켜짐 파일에서 enabled만 false로 바꿔 두면(fd04f4a7) 회사 폴더에 쓸 수 있는 누구든(에이전트 파일 도구 포함)
//    enabled를 true로 한 글자 바꿔 봉인이 맞는 켜짐을 만들 수 있었다 — 사용자가 지금 비서를 끄면 이전 회사 비서가 저절로 살아났다.
//  · 이어받을 값을 봉인 안 된 칸(inherit)에 두고 다시 켤 때 쓰면(7251c8a9) 누구든 그 칸을 넣거나 고쳐 두었다가, 사용자가 '켜기'를 누르는 순간 그 값이 봉인됐다
//    (값 세탁 — 비서를 켠 적 없는 회사에 손으로 만든 파일에도 걸렸다). 그래서 봉인이 안 맞는 파일은 어떤 칸이 있든 저장·화면 모두 기본값이다(이 PR 전과 같은 규칙).
//    다시 켜면 설정은 기본값에서 시작한다 — 이어받기가 필요하면 지금 비서의 봉인 파일에 담아 오는 방식으로 후속.
//  · agent는 남긴다 — 방에서 복구(recover.mjs recoveryTargets)가 이전 비서의 1:1 방을 읽어 두 방 알림을 막는 데 쓴다(읽기만). 이 값도 봉인 안 된 값이라 고쳐 두면
//    같은 주인의 다른 개인 에이전트 방을 읽게 되지만, 세는 것은 그 주인의 개인 1:1 방에서 에이전트가 쓴 비서 알림 글(as: 표지 + meta.notification)뿐이라
//    결과는 '그 사람에게 실제로 이미 보낸 알림'을 다시 보내지 않는 것까지다. 다시 켤 때는 카드의 에이전트를 쓴다(파일 값 아님).
//
// 보기 = 설정 + 지금 비서(회사·에이전트) + 상태. 전부 로컬 파일·메모리에서 읽는다 — Supabase 호출 0(리스 주인은 동기화가 이미 읽은 메모리 값, 로그인은 기기 세션 파일과
// 사망 마커 — 회전을 일으키지 않는 읽기 전용 판정).
// 상태 파일(.assistant/state.json)은 기기 로컬이라 실행 기기가 이 기기일 때만 마지막 확인·오늘 알림 수를 보여 준다.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { paths, loadCompany, updateCompany, getDeviceId } from '../workspace.mjs';
import { writeJsonAtomic } from '../jsonstore.mjs';
import { withLock } from '../mutex.mjs';
import { listCompanyIds } from '../hub.mjs';
import { readAgentCard } from '../persona.mjs';
import { loadDeviceSession, deviceSessionDead } from '../devicesession.mjs';
import { leaseCheck, deviceLabel } from '../sync.mjs';
import { normalizeTz } from '../routine-time.mjs';
import { codedError } from '../coded-error.mjs';
import { ASSISTANT_FILE, SEAL_FIELD, LEAD_CHOICES, INTERVAL_CHOICES, sealOf, normalizeAssistantConfig } from './config.mjs';
import { normalizeState, stateFile } from './state.mjs';
import { minuteInQuiet, dateIn, assistantCompanyOf, assistantMuted } from './rules.mjs';
import { assistantRunnerStatus } from './tick.mjs';
import { mailStatusView } from './mail.mjs';

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const toMin = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const fileOf = (wsId) => join(paths(wsId).root, ASSISTANT_FILE);
const lockAssistant = (wsId, fn) => withLock(`assistant:${wsId}`, fn, { file: fileOf(wsId), mkParent: false }); // 동기화(isFileLockedRel)와 같은 파일 잠금
const hostTz = () => { try { return new Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch { return null; } };

/** assistant.json 원문 + 봉인 대조 — { text, obj, cfg, sealed } | null(파일 없음). 손상(JSON 아님)이면 obj·cfg null, sealed false. */
const sealedText = (obj) => `${JSON.stringify(obj, null, 2)}\n`; // writeSealed와 같은 모양
export async function readAssistantFile(wsId, company = null) {
  let text;
  try { text = await readFile(fileOf(wsId), 'utf8'); } catch (e) { if (e?.code === 'ENOENT') return null; throw e; }
  let obj = null;
  try { const v = JSON.parse(text); obj = v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch { /* 손상 */ }
  const co = company ?? (await loadCompany(wsId).catch(() => null));
  const seal = co?.[SEAL_FIELD];
  return { text, obj, cfg: obj ? normalizeAssistantConfig(obj) : null, sealed: !!obj && seal === sealOf(text) };
}

/** 봉인해서 쓰기 — 파일을 쓰고 그 바이트의 해시를 company.json에 적는다. 반드시 lockAssistant 안에서 부른다. */
/** 다른 회사로 옮기며 끄는 파일(머리 주석) — 꺼짐과 에이전트(방에서 복구용)만. */
function offFile(obj) {
  const agent = normalizeAssistantConfig(obj).agent;
  return { enabled: false, ...(agent ? { agent } : {}) };
}

async function writeSealed(wsId, obj) {
  const text = sealedText(obj);
  await writeJsonAtomic(fileOf(wsId), text);
  await updateCompany(wsId, () => ({ [SEAL_FIELD]: sealOf(text) }));
  return text;
}

/** 입력 검증(순수) — 문제 있으면 errorCode, 없으면 null. 아침 묶음 = 조용한 시간 끝.
    touched(Set: lead·interval·evening·from·to)를 주면 보낸 칸이 걸린 규칙만 본다 — 새 버전이 봉인해 저장한 값을 이 버전이 받지 않아도
    끄기·다른 칸 저장이 막히지 않게(#865 3차 검수 LOW). 두 칸 이상 걸린 규칙은 걸린 칸이 모두 시각 모양일 때만 본다. */
export function settingsProblem({ leadMinutes, intervalMinutes, eveningAt, quiet }, touched = null) {
  const t = (k) => !touched || touched.has(k);
  const times = { evening: eveningAt, from: quiet.from, to: quiet.to };
  const isTime = (k) => HHMM_RE.test(String(times[k]));
  if (t('lead') && !LEAD_CHOICES.includes(leadMinutes)) return 'assistant_lead_invalid';
  if (t('interval') && !INTERVAL_CHOICES.includes(intervalMinutes)) return 'assistant_interval_invalid'; // 10분 미만 없음(DB 조회 부하 — config.mjs INTERVAL_CHOICES)
  if (Object.keys(times).some((k) => t(k) && !isTime(k))) return 'assistant_time_invalid';
  const rule = (...ks) => ks.some(t) && ks.every(isTime);
  if (rule('from', 'to') && quiet.from === quiet.to) return 'assistant_quiet_empty';
  if (rule('evening', 'from', 'to') && minuteInQuiet(toMin(eveningAt), quiet)) return 'assistant_evening_in_quiet'; // 조용한 시간 안의 저녁 묶음은 그날 나가지 않는다(rules.mjs bundleDue)
  if (rule('to', 'evening') && toMin(quiet.to) >= toMin(eveningAt)) return 'assistant_evening_before_morning';
  return null;
}

const agentExists = (wsId, slug) => readAgentCard(wsId, slug).then(() => true, (e) => (e?.code === 'NOT_FOUND' ? false : Promise.reject(e)));
const SLUG_OK = (v) => typeof v === 'string' && v.length > 0 && v.length <= 100 && !/[\\/\0]/.test(v) && v !== '.' && v !== '..';
const bool = (v) => (typeof v === 'boolean' ? v : undefined);

/** 저장 전체(이 회사 쓰기 + 다른 회사 끄기)를 한 줄로 — 같은 주인의 두 회사에 켜기가 거의 동시에 오면(두 창) 각 저장이 자기 회사를 켠 뒤
    서로를 꺼서 둘 다 꺼졌다(#865 2차 검수 LOW, 격리 서버 8/8 재현). 줄을 세우면 나중 저장이 앞 저장의 회사를 끄고 하나만 남는다.
    저장은 사람이 값을 바꿀 때만 오므로 기다림은 앞 저장 하나(로컬 파일 몇 개)다. 프로세스 안 순서라 같은 데이터 폴더를 두 설정 서버가 동시에 받는 경우는
    덮지 않는다 — 그때도 결과는 꺼지는 쪽이고 보기는 그대로 보인다. 키는 회사 잠금(`assistant:<회사>`)과 겹치지 않게 다른 모양이다(같은 키 중첩 = 교착). */
const SAVE_LOCK = 'assistant-settings-save';

/**
 * 설정 저장. input(전부 선택) = { enabled, agent, intervalMinutes, leadMinutes, eveningAt, quiet: { from, to, calendarAlerts }, calendar, mail, tz }.
 *  - enabled: true  → 켜기(또는 이 에이전트로 바꾸기·다시 켜기). agent 필수·이 회사에 있어야 한다. 켠 시각을 지금으로, tz는 화면(브라우저) 값.
 *  - enabled: false → 일시 정지(에이전트·값은 그대로 적어 둔다 — 다시 켜면 그 값으로).
 *  - agent만(enabled 없이) → 담당 에이전트만 바꾼다(켜짐·꺼짐·켠 시각 그대로 — 일시 정지 중 담당 바꾸기). 이 회사에 있어야 한다.
 *  - 그 밖 칸만 → 값만 바꾼다(켜짐·에이전트·켠 시각 그대로).
 * 반환 = { changedOthers: [wsId] }(이 저장으로 꺼진 다른 회사).
 */
export function saveAssistantSettings(wsId, input = {}, opts = {}) {
  return withLock(SAVE_LOCK, () => saveInLine(wsId, input, opts));
}

async function saveInLine(wsId, input, { now = Date.now() } = {}) {
  const inp = input && typeof input === 'object' ? input : {};
  const enabledIn = bool(inp.enabled);
  if (enabledIn === true && !SLUG_OK(inp.agent)) throw codedError('assistant_agent_not_found', '하트비트로 정할 에이전트가 필요합니다');
  if (enabledIn === true && !(await agentExists(wsId, inp.agent))) throw codedError('assistant_agent_not_found', `에이전트를 찾을 수 없습니다: ${inp.agent}`);
  const agentOnly = enabledIn === undefined && inp.agent !== undefined; // 담당만 바꾸기
  if (agentOnly && !(SLUG_OK(inp.agent) && (await agentExists(wsId, inp.agent)))) throw codedError('assistant_agent_not_found', `에이전트를 찾을 수 없습니다: ${String(inp.agent).slice(0, 100)}`);
  const company = await loadCompany(wsId);
  await lockAssistant(wsId, async () => {
    const cur = await readAssistantFile(wsId, await loadCompany(wsId));
    const sealed = cur?.sealed === true;
    const base = sealed ? cur.obj : {}; // 봉인이 안 맞으면 어떤 칸이 있든 기본값(머리 주석 — 봉인 안 된 값을 봉인하지 않는다)
    const prev = normalizeAssistantConfig(base); // 봉인 안 맞음·없음 = 기본값(꺼짐)
    const q = inp.quiet && typeof inp.quiet === 'object' ? inp.quiet : {};
    // 보내지 않은 칸은 봉인된 저장값 그대로 — 이 버전이 모르는 값(새 버전의 선택지)을 기본값으로 덮지 않는다(#865 3차 검수 LOW). 봉인이 안 맞으면 base = {}라 기본값.
    const bq = base.quiet && typeof base.quiet === 'object' ? base.quiet : {};
    const kept = (v, d) => (v !== undefined ? v : d);
    const touched = new Set([['lead', inp.leadMinutes], ['interval', inp.intervalMinutes], ['evening', inp.eveningAt], ['from', q.from], ['to', q.to]].filter(([, v]) => v !== undefined).map(([k]) => k));
    const next = {
      leadMinutes: touched.has('lead') ? Number(inp.leadMinutes) : kept(base.leadMinutes, prev.leadMinutes),
      // 확인 주기 — 칸이 없는 옛 파일(0.1.100 이하가 쓴 것)은 기본 15분을 적는다(엔진 정규화와 같은 값 — 동작은 그대로)
      intervalMinutes: touched.has('interval') ? Number(inp.intervalMinutes) : kept(base.intervalMinutes, prev.intervalMinutes),
      eveningAt: touched.has('evening') ? String(inp.eveningAt) : kept(base.eveningAt, prev.eveningAt),
      quiet: {
        from: touched.has('from') ? String(q.from) : kept(bq.from, prev.quiet.from),
        to: touched.has('to') ? String(q.to) : kept(bq.to, prev.quiet.to),
        calendarAlerts: bool(q.calendarAlerts) ?? kept(bq.calendarAlerts, prev.quiet.calendarAlerts),
      },
    };
    const bad = settingsProblem(next, touched);
    if (bad) throw codedError(bad, `하트비트 설정 값이 올바르지 않습니다(${bad})`);
    // 메일 — 화면이 보낸 때만 바꾼다(false 안 봄 · 'shadow' 미리 보기 · true 알림). 봉인이 안 맞는 파일에서는 base.watch를 버리므로(아래) 심은 메일 보기는 다시 봉인되지 않는다
    if (inp.mail !== undefined && ![false, 'shadow', true].includes(inp.mail)) throw codedError('assistant_mail_invalid', '메일 보기 값이 올바르지 않습니다');
    // 일정 — 화면의 "무엇을 알려 줄까요 → 일정" 칸이 보낸 때만 바꾼다(true·false). 일정·메일 둘 다 끄면 엔진은 쉰다(tick.mjs 'idle' — 호출 0)
    if (inp.calendar !== undefined && typeof inp.calendar !== 'boolean') throw codedError('assistant_bad_request', '일정 보기 값이 올바르지 않습니다');
    const baseWatch = sealed && base.watch && typeof base.watch === 'object' ? base.watch : { calendar: true, mail: false, tasks: false, deals: false };
    const enabled = enabledIn ?? prev.enabled;
    const agent = enabledIn === true || agentOnly ? inp.agent : prev.agent;
    // 켜기·바꾸기는 사용자의 마지막 선택 — 이미 켜져 있던 회사로 바꿔도 켠 시각을 지금으로 한다(이 기기에 없는 같은 주인의 회사가 다른 기기에서 더 늦게 켜졌어도 이 선택이 맡게 — rules.mjs assistantCompanyOf)
    const fresh = enabledIn === true;
    const enabledAtMs = !enabled ? null : fresh ? now : (prev.enabledAt ?? now);
    const out = {
      ...base,
      enabled,
      agent,
      enabledAt: enabledAtMs == null ? undefined : new Date(enabledAtMs).toISOString(),
      watch: { ...baseWatch, ...(inp.calendar !== undefined ? { calendar: inp.calendar } : {}), ...(inp.mail !== undefined ? { mail: inp.mail } : {}) },
      leadMinutes: next.leadMinutes,
      intervalMinutes: next.intervalMinutes,
      morningAt: next.quiet.to, // 아침 묶음 = 조용한 시간 끝
      eveningAt: next.eveningAt,
      quiet: next.quiet,
      dailyCap: kept(base.dailyCap, prev.dailyCap), // 화면 밖 칸 — 엔진의 하루 즉시 알림 상한(tick.mjs send)
      tz: (fresh ? normalizeTz(inp.tz) : null) ?? prev.tz ?? hostTz() ?? undefined,
    };
    if (!agent) delete out.agent;
    await writeSealed(wsId, out);
  });
  // 사용자당 1명 — 켜거나 바꾸면 같은 주인의 다른 회사에서 켜진(봉인 맞는) 비서를 끈다. 회사마다 그 회사의 잠금 안에서(중첩 없음).
  // 이 회사는 이미 켜졌으므로 다른 회사에서 난 오류는 기록만 하고 다음 회사로 간다 — 오류를 돌려주면 화면은 켜지지 않은 것처럼 보인다.
  // 끄지 못한 회사가 남아도 엔진은 켠 시각이 늦은 쪽(이 회사)만 돌리고(rules.mjs assistantCompanyOf), 그 회사 카드는 "다른 회사의 비서가 맡고 있음"을 보인다.
  const changedOthers = [];
  if (enabledIn === true) {
    const owner = company.ownerId ?? null;
    const failOther = (id, e) => console.error(`[argo] 비서: 다른 회사(${id})의 비서를 끄지 못했습니다 — 이 회사(${wsId})가 나중에 켜져 엔진은 이 회사만 돌립니다: ${String(e?.message ?? e).slice(0, 160)}`);
    const ids = await listCompanyIds().catch((e) => { failOther('*', e); return []; });
    for (const id of ids) {
      if (id === wsId) continue;
      try {
        const co = await loadCompany(id).catch(() => null);
        if (!co || (co.ownerId ?? null) !== owner) continue;
        await lockAssistant(id, async () => {
          const f = await readAssistantFile(id, await loadCompany(id));
          if (!f?.sealed || !f.cfg.enabled) return;
          // 봉인과 다시 맞춰질 수 없는 꺼짐 — company.json(봉인)은 건드리지 않는다(머리 주석 H63·보안 검토)
          await writeJsonAtomic(fileOf(id), sealedText(offFile(f.obj)));
          changedOthers.push(id);
        });
      } catch (e) { failOther(id, e); }
    }
  }
  return { changedOthers };
}

/**
 * 설정 지우기 — 루틴 → 내 하트비트 → 고급 '설정 지우기'(확인 창 뒤). 이 회사의 assistant.json을 offFile({ enabled: false, agent })로 쓰고, 이어서 company.json 봉인을 비운다.
 * 봉인을 비우는 이유(#분리 검수 M1): 봉인이 지우기 직전 '켜짐' 바이트를 가리킨 채면, 그 바이트를 그대로 되돌려 쓰는 것(옛 버전 기기의 에이전트 파일 쓰기)만으로 하트비트가 다시 켜졌다.
 * 파일 → 봉인 순서라 사이에 엔진 틱이 끼어도 꺼진 쪽이다. 사용자가 지금 손대는 회사라 company.json을 써도 H63(손대지 않은 회사의 보관 마커 되살림)에 걸리지 않는다(PUT도 같은 파일을 쓴다).
 * 보기는 '없음'이 되고, 다시 만들면 기본값에서 시작한다.
 * agent를 남기는 이유도 같다 — 방에서 복구가 이전 하트비트의 1:1 방을 읽어 같은 날 다시 만들어도 이미 보낸 알림을 다시 보내지 않는다.
 * 파일이 없으면 쓰지 않는다(쓰기 0). 반환 = { removed }.
 */
export function removeAssistantSettings(wsId) {
  return withLock(SAVE_LOCK, () => lockAssistant(wsId, async () => {
    const cur = await readAssistantFile(wsId, await loadCompany(wsId));
    if (!cur) return { removed: false };
    const off = offFile(cur.obj ?? {});
    const text = sealedText(off);
    const co = await loadCompany(wsId);
    if (text === cur.text && co?.[SEAL_FIELD] == null) return { removed: false }; // 이미 지운 모양 — 다시 쓰지 않는다(쓰기 0)
    if (text !== cur.text) await writeJsonAtomic(fileOf(wsId), text);
    if (co?.[SEAL_FIELD] != null) await updateCompany(wsId, () => ({ [SEAL_FIELD]: null }));
    return { removed: true };
  }));
}

/** 이 기기의 상태 파일 읽기(부작용 없음 — 손상 파일을 옮기지 않는다). 없거나 손상이면 null. */
async function readLocalState(wsId) {
  try { return normalizeState(JSON.parse(await readFile(stateFile(wsId), 'utf8'))); } catch { return null; }
}

const agentName = async (wsId, slug) => {
  try { const { meta } = await readAgentCard(wsId, slug); return typeof meta?.name === 'string' && meta.name.trim() ? meta.name.trim() : slug; } catch { return slug; }
};

/** 바꿔 끼우는 자리 — 테스트가 리스·기기 세션·기기 id를 넘긴다. */
export const viewDeps = { lease: leaseCheck, deviceSession: () => loadDeviceSession(), sessionDead: () => deviceSessionDead(), deviceId: () => getDeviceId() };

/**
 * 설정 화면이 그리는 값. 반환:
 *  { config: { enabled, agent, agentName, intervalMinutes, leadMinutes, morningAt, eveningAt, quiet, tz, calendar, mail },   — 봉인이 맞으면 파일 값, 아니면 기본값(꺼짐)
 *    unsealed,                         — 파일은 켜짐(enabled + 에이전트)인데 봉인이 안 맞음(설정 화면 밖에서 바뀜 → 엔진은 꺼짐)
 *    current: { ws, company, agent, name } | null,   — 지금 이 사용자의 비서(같은 주인의 회사들 중 봉인 맞는 켜짐, 켠 시각이 가장 늦은 쪽 — 엔진과 같은 판정)
 *    choices: { lead, interval },
 *    status: { login, muted, runner, device, code, codeAt, readAt, instantToday, instantSure, dailyCap } }   — dailyCap = 지금 비서 설정의 하루 즉시 알림 상한(화면 "n/상한")
 */
export async function assistantSettingsView(wsId, { now = Date.now(), deps = viewDeps } = {}) {
  const company = await loadCompany(wsId);
  const owner = company.ownerId ?? null;
  const here = await readAssistantFile(wsId, company);
  const cfg = here?.sealed ? here.cfg : normalizeAssistantConfig({}); // 봉인 안 맞음 = 기본값(꺼짐)
  // 같은 주인의 회사들 — 봉인 맞는 켜짐만(엔진 pickCompany와 같은 재료)
  const peers = [];
  const names = new Map();
  for (const id of await listCompanyIds()) {
    const co = id === wsId ? company : await loadCompany(id).catch(() => null);
    if (!co || (co.ownerId ?? null) !== owner) continue;
    const f = id === wsId ? here : await readAssistantFile(id, co).catch(() => null);
    if (f?.sealed && f.cfg.enabled && f.cfg.agent) { peers.push({ cid: id, ownerId: owner, cfg: f.cfg }); names.set(id, co.name ?? id); }
  }
  const cur = assistantCompanyOf(peers, owner);
  const curCfg = peers.find((p) => p.cid === cur)?.cfg;
  const current = cur ? { ws: cur, company: names.get(cur), agent: curCfg.agent, name: await agentName(cur, curCfg.agent) } : null;
  // 상태
  const li = deps.lease();
  const runner = assistantRunnerStatus(li, now);
  const device = runner === 'this_device' ? deviceLabel(await deps.deviceId().catch(() => '')) || null
    : li.holder?.deviceId ? deviceLabel(li.holder.deviceId) : null;
  const sess = deps.deviceSession();
  const st = runner === 'this_device' && current?.ws === wsId ? await readLocalState(wsId) : null;
  const tz = curCfg?.tz ?? cfg.tz;
  return {
    config: { enabled: cfg.enabled, agent: cfg.agent, agentName: cfg.agent ? await agentName(wsId, cfg.agent) : null, intervalMinutes: cfg.intervalMinutes, leadMinutes: cfg.leadMinutes, morningAt: cfg.morningAt, eveningAt: cfg.eveningAt, quiet: cfg.quiet, tz: cfg.tz, calendar: cfg.watch.calendar, mail: cfg.mailMode },
    unsealed: !!(here && !here.sealed && here.cfg?.enabled && here.cfg.agent),
    current,
    choices: { lead: [...LEAD_CHOICES], interval: [...INTERVAL_CHOICES] },
    status: {
      // 엔진과 같은 판정 — 엔진은 getFreshDeviceSession(msgr.sessionClient)이 돌려준 세션의 계정이 회사 주인일 때만 일정을 읽는다(tick.mjs session).
      // 갱신이 거절돼 죽은 세션(만료 + 사망 마커)은 파일이 남아 있어도 엔진에게는 null이다 — 회전을 일으키지 않는 deviceSessionDead로 같은 결과를 본다.
      // 네트워크 실패로 회전을 못 한 경우는 로그인 문제가 아니라서 여기서 로그인 필요로 보이지 않는다(재로그인으로 오진하지 않게 — devicesession.mjs 분리 검수 M3).
      login: !!owner && sess?.user?.id === owner && !deps.sessionDead(),
      muted: assistantMuted(company),
      runner,
      device,
      code: st?.status?.code ?? null,
      codeAt: st?.status?.at ?? 0,
      readAt: st?.cal?.readAt ?? 0,
      instantToday: st && st.day.date === dateIn(now, tz) ? st.day.instant : 0,
      instantSure: !(st && st.day.date === dateIn(now, tz) && st.day.sure === false), // false = 방에서 복구가 실패해 다른 기기가 보낸 수를 아직 모른다(화면 "확인 중")
      dailyCap: (curCfg ?? cfg).dailyCap,
      // 메일 확인 상태(이 기기가 실행 기기일 때만 — 상태 파일은 기기 로컬): 마지막 확인·오류 코드·미리 보기 기록 수
      mail: runner === 'this_device' && current?.ws === wsId && cfg.mailMode !== 'off' ? await mailStatusView(wsId, { now }).catch(() => null) : null,
    },
  };
}
