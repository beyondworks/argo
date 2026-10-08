// 능동 비서 설정 쓰기·보기(2단계) — 설정 API(app/api/companies/[ws]/assistant/route.js)가 부른다. 화면은 에이전트 카드 "비서" 탭.
//
// 쓰기 = assistant.json + company.json 봉인(config.mjs 머리 주석). 둘은 assistant.json의 프로세스 간 잠금 안에서 파일 → 봉인 순서로 쓴다.
// 그 사이에 엔진 틱이 끼면 둘이 어긋나 그 틱은 꺼짐(쓰기·호출 0)이다 — 켜진 쪽으로 잘못 가는 순서는 없다.
//
// 화면이 다루는 칸: 켜기·끄기(+ 어느 에이전트), 일정 알림 몇 분 전, 내일 일정 요약(저녁 묶음) 시각, 조용한 시간과 그 예외.
// 아침 묶음 시각은 고르지 않는다 — 조용한 시간이 끝나는 시각이다(설계 13절 "조용한 시간 끝과 같게"). 고를 필요 없는 값은 제품이 정한다.
// 볼 것은 일정 하나뿐이다(메일 4단계, 할 일·거래 5단계). 처음 켤 때 메일·할 일·거래는 false로 적는다 — 그 단계가 나와도 사용자가 따로 켜기 전에는
// 읽지 않는다(설계 3.2 "동의 없이 메일을 읽지 않는다"). 하루 즉시 알림 상한은 3단계가 쓰는 값이라 이 화면에 없다(저장값·기본값 그대로).
//
// 화면 밖 칸 이어받기: 봉인이 맞는 파일이면 이 화면이 다루지 않는 칸(나중 단계의 칸, 볼 것)을 그대로 둔다 — 새 버전 기기가 저장한 칸을 옛 화면이 지우지 않게.
// 봉인이 안 맞거나 없으면 처음 켜는 것처럼 기본값에서 시작한다 — 화면 밖에서 바뀐 값(예: 에이전트가 심은 watch.mail:true)을 다시 봉인하지 않게.
//
// 사용자당 비서 1명(설계 3.2): 켜거나 바꾸면 같은 주인의 다른 회사에서 켜져 있던(봉인이 맞는) 비서를 끈다. 다른 기기에서 거의 같은 때 켠 경우는
// 엔진이 켠 시각이 늦은 쪽만 돌린다(rules.mjs assistantCompanyOf).
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
import { ASSISTANT_FILE, SEAL_FIELD, LEAD_CHOICES, sealOf, normalizeAssistantConfig } from './config.mjs';
import { normalizeState, stateFile } from './state.mjs';
import { minuteInQuiet, dateIn, assistantCompanyOf, assistantMuted } from './rules.mjs';
import { assistantRunnerStatus } from './tick.mjs';

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const toMin = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const fileOf = (wsId) => join(paths(wsId).root, ASSISTANT_FILE);
const lockAssistant = (wsId, fn) => withLock(`assistant:${wsId}`, fn, { file: fileOf(wsId), mkParent: false }); // 동기화(isFileLockedRel)와 같은 파일 잠금
const hostTz = () => { try { return new Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch { return null; } };

/** assistant.json 원문 + 봉인 대조 — { text, obj, cfg, sealed } | null(파일 없음). 손상(JSON 아님)이면 obj·cfg null, sealed false. */
export async function readAssistantFile(wsId, company = null) {
  let text;
  try { text = await readFile(fileOf(wsId), 'utf8'); } catch (e) { if (e?.code === 'ENOENT') return null; throw e; }
  let obj = null;
  try { const v = JSON.parse(text); obj = v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch { /* 손상 */ }
  const co = company ?? (await loadCompany(wsId).catch(() => null));
  return { text, obj, cfg: obj ? normalizeAssistantConfig(obj) : null, sealed: !!obj && co?.[SEAL_FIELD] === sealOf(text) };
}

/** 봉인해서 쓰기 — 파일을 쓰고 그 바이트의 해시를 company.json에 적는다. 반드시 lockAssistant 안에서 부른다. */
async function writeSealed(wsId, obj) {
  const text = `${JSON.stringify(obj, null, 2)}\n`;
  await writeJsonAtomic(fileOf(wsId), text);
  await updateCompany(wsId, () => ({ [SEAL_FIELD]: sealOf(text) }));
  return text;
}

/** 입력 검증(순수) — 문제 있으면 errorCode, 없으면 null. 아침 묶음 = 조용한 시간 끝. */
export function settingsProblem({ leadMinutes, eveningAt, quiet }) {
  if (!LEAD_CHOICES.includes(leadMinutes)) return 'assistant_lead_invalid';
  if (![eveningAt, quiet.from, quiet.to].every((v) => HHMM_RE.test(String(v)))) return 'assistant_time_invalid';
  if (quiet.from === quiet.to) return 'assistant_quiet_empty';
  if (minuteInQuiet(toMin(eveningAt), quiet)) return 'assistant_evening_in_quiet'; // 조용한 시간 안의 저녁 묶음은 그날 나가지 않는다(rules.mjs bundleDue)
  if (toMin(quiet.to) >= toMin(eveningAt)) return 'assistant_evening_before_morning';
  return null;
}

const agentExists = (wsId, slug) => readAgentCard(wsId, slug).then(() => true, (e) => (e?.code === 'NOT_FOUND' ? false : Promise.reject(e)));
const SLUG_OK = (v) => typeof v === 'string' && v.length > 0 && v.length <= 100 && !/[\\/\0]/.test(v) && v !== '.' && v !== '..';
const bool = (v) => (typeof v === 'boolean' ? v : undefined);

/**
 * 설정 저장. input(전부 선택) = { enabled, agent, leadMinutes, eveningAt, quiet: { from, to, calendarAlerts }, tz }.
 *  - enabled: true  → 켜기(또는 이 에이전트로 바꾸기). agent 필수·이 회사에 있어야 한다. 켠 시각을 지금으로, tz는 화면(브라우저) 값.
 *  - enabled: false → 끄기(에이전트는 그대로 적어 둔다).
 *  - 그 밖 칸만 → 값만 바꾼다(켜짐·에이전트·켠 시각 그대로).
 * 반환 = { changedOthers: [wsId] }(이 저장으로 꺼진 다른 회사).
 */
export async function saveAssistantSettings(wsId, input = {}, { now = Date.now() } = {}) {
  const inp = input && typeof input === 'object' ? input : {};
  const enabledIn = bool(inp.enabled);
  if (enabledIn === true && !SLUG_OK(inp.agent)) throw codedError('assistant_agent_not_found', '비서로 정할 에이전트가 필요합니다');
  if (enabledIn === true && !(await agentExists(wsId, inp.agent))) throw codedError('assistant_agent_not_found', `에이전트를 찾을 수 없습니다: ${inp.agent}`);
  const company = await loadCompany(wsId);
  await lockAssistant(wsId, async () => {
    const cur = await readAssistantFile(wsId, await loadCompany(wsId));
    const sealed = cur?.sealed === true;
    const base = sealed ? cur.obj : {};
    const prev = normalizeAssistantConfig(base); // 봉인 안 맞음·없음 = 기본값(꺼짐)
    const q = inp.quiet && typeof inp.quiet === 'object' ? inp.quiet : {};
    const next = {
      leadMinutes: inp.leadMinutes !== undefined ? Number(inp.leadMinutes) : prev.leadMinutes,
      eveningAt: inp.eveningAt !== undefined ? String(inp.eveningAt) : prev.eveningAt,
      quiet: {
        from: q.from !== undefined ? String(q.from) : prev.quiet.from,
        to: q.to !== undefined ? String(q.to) : prev.quiet.to,
        calendarAlerts: bool(q.calendarAlerts) ?? prev.quiet.calendarAlerts,
      },
    };
    const bad = settingsProblem(next);
    if (bad) throw codedError(bad, `비서 설정 값이 올바르지 않습니다(${bad})`);
    const enabled = enabledIn ?? prev.enabled;
    const agent = enabledIn === true ? inp.agent : prev.agent;
    // 켜기·바꾸기는 사용자의 마지막 선택 — 이미 켜져 있던 회사로 바꿔도 켠 시각을 지금으로 한다(이 기기에 없는 같은 주인의 회사가 다른 기기에서 더 늦게 켜졌어도 이 선택이 맡게 — rules.mjs assistantCompanyOf)
    const fresh = enabledIn === true;
    const enabledAtMs = !enabled ? null : fresh ? now : (prev.enabledAt ?? now);
    const out = {
      ...base,
      enabled,
      agent,
      enabledAt: enabledAtMs == null ? undefined : new Date(enabledAtMs).toISOString(),
      watch: sealed && base.watch && typeof base.watch === 'object' ? base.watch : { calendar: true, mail: false, tasks: false, deals: false },
      leadMinutes: next.leadMinutes,
      morningAt: next.quiet.to, // 아침 묶음 = 조용한 시간 끝
      eveningAt: next.eveningAt,
      quiet: next.quiet,
      dailyCap: prev.dailyCap,
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
          const { enabledAt: _drop, ...rest } = f.obj;
          await writeSealed(id, { ...rest, enabled: false });
          changedOthers.push(id);
        });
      } catch (e) { failOther(id, e); }
    }
  }
  return { changedOthers };
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
 *  { config: { enabled, agent, leadMinutes, morningAt, eveningAt, quiet, tz },   — 봉인이 맞으면 파일 값, 아니면 기본값(꺼짐)
 *    unsealed,                         — 파일은 켜짐(enabled + 에이전트)인데 봉인이 안 맞음(설정 화면 밖에서 바뀜 → 엔진은 꺼짐)
 *    current: { ws, company, agent, name } | null,   — 지금 이 사용자의 비서(같은 주인의 회사들 중 봉인 맞는 켜짐, 켠 시각이 가장 늦은 쪽 — 엔진과 같은 판정)
 *    choices: { lead },
 *    status: { login, muted, runner, device, code, codeAt, readAt, instantToday } }
 */
export async function assistantSettingsView(wsId, { now = Date.now(), deps = viewDeps } = {}) {
  const company = await loadCompany(wsId);
  const owner = company.ownerId ?? null;
  const here = await readAssistantFile(wsId, company);
  const cfg = here?.sealed ? here.cfg : normalizeAssistantConfig({});
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
    config: { enabled: cfg.enabled, agent: cfg.agent, leadMinutes: cfg.leadMinutes, morningAt: cfg.morningAt, eveningAt: cfg.eveningAt, quiet: cfg.quiet, tz: cfg.tz },
    unsealed: !!(here && !here.sealed && here.cfg?.enabled && here.cfg.agent),
    current,
    choices: { lead: [...LEAD_CHOICES] },
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
    },
  };
}
