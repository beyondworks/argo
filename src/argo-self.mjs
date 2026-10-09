// 에이전트의 아르고 자기 인식 — "지금 연결 밀도가 몇%지?", "내 루틴 뭐 있어?", "비서 돌고 있어?", "아침 정리 7시로 바꿔줘"에 답하는 재료.
// 에이전트 도구(chat.mjs makeCrewServer: argo_status·argo_help·argo_settings)가 이 모듈을 부른다. 도구 정의는 한 번이고 SDK·네이티브·Codex 다리가 같은 처리기를 쓴다.
//
// 원칙
//  - 화면과 같은 숫자: 데크 지표는 화면이 쓰는 함수(src/deck-metrics.mjs)로, 비서 상태는 설정 화면이 쓰는 assistantSettingsView로, 러너는 runnerStatus로 낸다.
//  - 읽기는 로컬 파일·메모리만 — 질문 한 번에 Supabase·네트워크 호출 0(DB 보호 규칙). 서버에만 있는 값(요금제 등)은 이 기기가 이미 받아 둔 값만 보여 준다.
//  - 비밀은 싣지 않는다: 토큰·키·가려진 키 조각(masked)·계정 이메일은 결과에 넣지 않는다.
//  - 설정 바꾸기는 허용 목록 키만. 바로 바꾸는 것은 서버가 판정한 "주인의 1:1 직접 지시" 턴뿐이고(settingsDirectTurn), 그 밖은 결재 카드, 금지 키는 거절.
//    출처는 도구 입력에 없다 — 에이전트가 무엇을 적어 보내도 판정이 바뀌지 않는다.
//  - 누가 물었나로 범위를 정한다: 상태·설정 값은 주인 1:1(같은 판정 settingsDirect)에서만. 그 밖(채널·회의실·다른 사람·손님·루틴·위임)은
//    그 방 사람이 이미 볼 수 있는 것과 기능 도움말만 — 도구 결과는 에이전트의 답을 거쳐 그 방에 그대로 나갈 수 있다.
//  - 회사는 지금 턴의 회사로 고정이다 — 도구 인자에 회사 id·경로 칸이 없다(zod가 모르는 키를 버린다). 루틴 id·에이전트 slug는 이 회사 안에서만 찾는다.
import { loadCompany } from './workspace.mjs';
import { scanAgents, listDocs } from './hub.mjs';
import { deckMetrics } from './deck-metrics.mjs';
import { loadRoutines, updateRoutine } from './routines.mjs';
import { loadApprovals } from './approvals.mjs';
import { getTurnStatus } from './turn-status.mjs';
import { assistantSettingsView, saveAssistantSettings } from './assistant/settings.mjs';
import { LEAD_CHOICES } from './assistant/config.mjs';
import { CAL_READ_MS } from './assistant/calendar.mjs';
import { settingsDirectTurn } from './gateway/msgr-handoff.mjs';
import { maskKeyLike } from './runners/shared.mjs';

const ko = (lang) => lang !== 'en';
const pick = (lang, k, e) => (ko(lang) ? k : e);
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/* ─── 출처 판정 ─────────────────────────────────────────────────────────────── */

// 설정을 바로 바꿔도 되는 턴인가 — 판정은 출처 함수들(ownerDirectTurn·ownerSoloTurn) 곁에 둔다(gateway/msgr-handoff.mjs settingsDirectTurn).
export { settingsDirectTurn };

/* ─── 설정 목록 ─────────────────────────────────────────────────────────────── */

const ASSIST_WHERE = { ko: '에이전트 카드 → 비서 탭', en: 'Agent card → Assistant tab' };

/** 에이전트가 바꿀 수 있는 설정(허용 목록). read(view) = 지금 값(비서 설정 화면 값), write(value, {agent}) = saveAssistantSettings 입력. 값 검증은 normalizeSettingValue + 저장 함수의 화면 규칙. */
export const SETTINGS = Object.freeze([
  {
    key: 'assistant.morning', type: 'time',
    label: { ko: '비서 아침 정리 시각(= 조용한 시간 끝)', en: 'Assistant morning summary time (= quiet hours end)' },
    where: { ko: `${ASSIST_WHERE.ko} → 조용한 시간 끝`, en: `${ASSIST_WHERE.en} → Quiet hours end` },
    read: (v) => v.config.quiet.to,
    write: (value) => ({ quiet: { to: value } }),
  },
  {
    key: 'assistant.evening', type: 'time',
    label: { ko: '비서 내일 일정 요약 시각', en: "Assistant tomorrow's summary time" },
    where: { ko: `${ASSIST_WHERE.ko} → 내일 일정 요약`, en: `${ASSIST_WHERE.en} → Tomorrow's summary` },
    read: (v) => v.config.eveningAt,
    write: (value) => ({ eveningAt: value }),
  },
  {
    key: 'assistant.quietFrom', type: 'time',
    label: { ko: '비서 조용한 시간 시작', en: 'Assistant quiet hours start' },
    where: { ko: `${ASSIST_WHERE.ko} → 조용한 시간 시작`, en: `${ASSIST_WHERE.en} → Quiet hours start` },
    read: (v) => v.config.quiet.from,
    write: (value) => ({ quiet: { from: value } }),
  },
  {
    key: 'assistant.lead', type: 'choice', choices: [...LEAD_CHOICES],
    label: { ko: '비서 일정 알림(몇 분 전)', en: 'Assistant event reminder (minutes before)' },
    where: { ko: `${ASSIST_WHERE.ko} → 일정 알림`, en: `${ASSIST_WHERE.en} → Event reminder` },
    read: (v) => v.config.leadMinutes,
    write: (value) => ({ leadMinutes: value }),
  },
  {
    key: 'assistant.quietAlerts', type: 'bool',
    label: { ko: '조용한 시간에도 일정 알림은 보내기', en: 'Still send event reminders during quiet hours' },
    where: { ko: `${ASSIST_WHERE.ko} → 조용한 시간에도 일정 알림은 보내기`, en: `${ASSIST_WHERE.en} → Still send event reminders during quiet hours` },
    read: (v) => v.config.quiet.calendarAlerts,
    write: (value) => ({ quiet: { calendarAlerts: value } }),
  },
  {
    key: 'assistant.enabled', type: 'bool',
    label: { ko: '비서 켜기·끄기', en: 'Assistant on/off' },
    where: { ko: `${ASSIST_WHERE.ko} → 비서 켜기 / 비서 끄기`, en: `${ASSIST_WHERE.en} → Turn on / Turn off assistant` },
    read: (v) => v.config.enabled,
    // 켤 때 에이전트 — 지정해 둔 비서가 있으면 그 에이전트, 없으면 이 도구를 부른 에이전트(write의 두 번째 인자)
    write: (value, { agent }) => (value ? { enabled: true, agent } : { enabled: false }),
    turnsOn: (value) => value === true, // 켜면 같은 주인의 다른 회사 비서가 꺼진다(계정마다 한 명 — settings.mjs saveAssistantSettings)
  },
  {
    key: 'assistant.agent', type: 'agent',
    label: { ko: '비서 에이전트(누가 비서인가)', en: 'Assistant agent (who the assistant is)' },
    where: { ko: `${ASSIST_WHERE.ko} → 이 에이전트로 바꾸기`, en: `${ASSIST_WHERE.en} → Use this agent instead` },
    read: (v) => v.config.agent ?? '',
    // 바꾸기만 — 꺼진 비서를 켜지 않는다(켜기는 assistant.enabled로만, applySetting이 꺼짐이면 거절). 저장 함수가 에이전트 교체를 enabled:true로만 받아 켜진 상태에서만 부른다
    write: (value) => ({ enabled: true, agent: value }),
    turnsOn: () => true, // 켜진 회사의 비서 교체도 "지금 비서"를 이 회사로 다시 정한다
  },
  {
    key: 'routine.time', type: 'time', needsId: true,
    label: { ko: '루틴 실행 시각(시각 하나인 1회·매일·매주 루틴)', en: 'Routine time (once/daily/weekly routines with one time)' },
    where: { ko: '루틴 화면 → 그 루틴 편집 → 시각', en: 'Routines → edit the routine → Time' },
  },
  {
    key: 'company.lang', type: 'choice', choices: ['ko', 'en'],
    label: { ko: '에이전트 응답 언어', en: 'Agent response language' },
    where: { ko: '설정 → 일반 → 에이전트 응답 언어', en: 'Settings → General → Agent response language' },
  },
]);

/** 에이전트가 바꾸지 못하는 설정 — 결제·삭제·해고·자격 증명·권한·공유 범위. 어디서 사람이 바꾸는지와 함께 알려 준다. */
export const FORBIDDEN_SETTINGS = Object.freeze([
  { keys: ['company.budgetUsd', 'budget', 'billing', 'plan', 'subscription', 'payment'], why: { ko: '결제·요금제·지출 한도', en: 'billing, plan, and spending limit' }, where: { ko: '설정 → 기기·데이터 → 기기 간 동기화(요금제·구독 관리)', en: 'Settings → Devices & data → Cross-device Sync (plan, Manage subscription)' } },
  { keys: ['company.fullAuto', 'fullAuto'], why: { ko: '풀 오토(결재 없이 실행하는 권한)', en: 'full auto (permission to act without approval)' }, where: { ko: '설정 → 일반 → 풀 오토 모드', en: 'Settings → General → Full auto mode' } },
  { keys: ['company.computerUse', 'computerUse'], why: { ko: '컴퓨터 유즈(화면 조작 권한)', en: 'computer use (screen control permission)' }, where: { ko: '사용자가 직접 정하는 회사 설정', en: 'a company setting only the user decides' } },
  { keys: ['company.credSync', 'credSync'], why: { ko: '자격 증명 동기화', en: 'credential sync' }, where: { ko: '설정 → 기기·데이터 → 기기 간 동기화 → 자격 증명 동기화', en: 'Settings → Devices & data → Cross-device Sync → Credential sync' } },
  { keys: ['runner.key', 'runner.credential', 'apiKey', 'token', 'connection.telegram', 'connection.slack', 'connector'], why: { ko: 'API 키·토큰·로그인 연결(자격 증명)', en: 'API keys, tokens, and login connections (credentials)' }, where: { ko: '설정 → AI 연결 → 러너 연결 / 설정 → 연결', en: 'Settings → AI connection → Runner connections / Settings → Connections' } },
  { keys: ['company.delete', 'company.archive', 'agent.delete', 'agent.fire', 'data.delete', 'memory.delete', 'routine.delete'], why: { ko: '삭제·해고', en: 'deletion and firing agents' }, where: { ko: '설정 → 위험 구역 → 회사 삭제 / 에이전트 카드 → 해고', en: 'Settings → Danger zone → Delete / Agent card → Fire' } },
  { keys: ['assistant.watch', 'assistant.watch.mail', 'assistant.watch.tasks', 'assistant.watch.deals', 'sharing', 'permission', 'org.member', 'visibility'], why: { ko: '권한·공유 범위(무엇을 읽게 할지, 누구와 나눌지)', en: 'permissions and sharing scope' }, where: { ko: '해당 설정 화면', en: 'the matching settings screen' } },
]);

const lower = (s) => String(s ?? '').trim().toLowerCase();
const settingOf = (key) => SETTINGS.find((s) => lower(s.key) === lower(key)) ?? null;
const forbiddenOf = (key) => FORBIDDEN_SETTINGS.find((f) => f.keys.some((k) => lower(k) === lower(key) || lower(key).startsWith(`${lower(k)}.`))) ?? null;

/** 설정 변경 판정(순수) — 'apply'(바로) | 'approval'(결재 카드) | 'forbidden'(거절) | 'unknown'(없는 키). */
export function settingPolicy({ key, direct = false, guest = false } = {}) {
  if (forbiddenOf(key)) return 'forbidden';
  if (!settingOf(key)) return 'unknown';
  return direct && !guest ? 'apply' : 'approval';
}

/** 값 정규화·검증(순수) — { value } 또는 { error }. */
export function normalizeSettingValue(def, raw, lang = 'ko') {
  if (def.type === 'time') {
    const s = String(raw ?? '').trim();
    const m = /^(\d{1,2}):?(\d{2})$/.exec(s) ?? /^(\d{1,2})$/.exec(s);
    const v = m ? `${String(Number(m[1])).padStart(2, '0')}:${m[2] ?? '00'}` : '';
    return HHMM_RE.test(v) ? { value: v } : { error: pick(lang, `시각은 HH:MM(24시간제)로 적어라 — 받은 값: ${s || '(비어 있음)'}`, `Use HH:MM (24-hour) — got: ${s || '(empty)'}`) };
  }
  if (def.type === 'bool') {
    const s = lower(raw);
    if (raw === true || ['true', 'on', '1', '켜기', '켬', '켜짐'].includes(s)) return { value: true };
    if (raw === false || ['false', 'off', '0', '끄기', '끔', '꺼짐'].includes(s)) return { value: false };
    return { error: pick(lang, 'true(켜기) 또는 false(끄기)로 적어라', 'Use true (on) or false (off)') };
  }
  if (def.type === 'choice') {
    const hit = def.choices.find((c) => String(c) === String(raw ?? '').trim());
    return hit !== undefined ? { value: hit } : { error: pick(lang, `가능한 값: ${def.choices.join(', ')}`, `Allowed values: ${def.choices.join(', ')}`) };
  }
  if (def.type === 'agent') {
    const s = String(raw ?? '').trim();
    // 카드 문구에 들어가는 값 — 제어·양방향 문자를 받지 않는다(결재 카드 문구 조작 방어, approvals.mjs와 같은 문자 집합). 실제 존재는 적용 때 본다
    const bad = /[\x00-\x1f\x7f\u2028\u2029\u202a-\u202e\u2066-\u2069\\/]/.test(s) || s.length > 100;
    return s && !bad ? { value: s } : { error: pick(lang, '에이전트 slug를 적어라(argo_status section=agents의 [ ] 안 값)', 'Give the agent slug (the value in [ ] from argo_status section=agents)') };
  }
  return { error: 'unsupported' };
}

const showVal = (v, lang) => (v === true ? pick(lang, '켜짐', 'on') : v === false ? pick(lang, '꺼짐', 'off') : v === '' || v == null ? pick(lang, '(없음)', '(none)') : String(v));

/** 결재 카드 문구(순수) — 승인 때 payload와 다시 맞춰 보는 기준(카드에 보인 것 = 실제로 바뀌는 것). */
export function settingActionText({ key, id = null, value, offWs = null }, lang = 'ko') {
  const def = settingOf(key);
  const label = def ? def.label[ko(lang) ? 'ko' : 'en'] : key;
  // 다른 회사 비서가 꺼지는 변경은 카드에 그 사실을 적는다(회사 이름은 싣지 않는다 — 카드는 채널에 보일 수 있다. 주인은 계정마다 비서 한 명이라 어느 회사인지 안다)
  const off = offWs ? pick(lang, ' · 같은 계정의 다른 회사 비서가 꺼짐', " · turns off the assistant in this account's other company") : '';
  return pick(lang, `설정 변경 — ${label}${id ? ` [${id}]` : ''} → ${showVal(value, lang)}${off}`, `Change setting — ${label}${id ? ` [${id}]` : ''} → ${showVal(value, lang)}${off}`);
}

/** 이 변경이 꺼뜨릴 다른 회사의 비서 — { ws, name } | null. 설정 화면과 같은 판정(assistantSettingsView current: 같은 주인의 켜진 비서 중 나중에 켠 쪽). */
async function otherAssistantOff(wsId, def, value) {
  if (!def.turnsOn?.(value)) return null;
  const cur = (await assistantSettingsView(wsId)).current;
  return cur && cur.ws !== wsId ? { ws: cur.ws, name: cur.company } : null;
}

/** 지금 값 읽기 — { value, view } | { error }. */
async function currentValue(wsId, def, { id = null, lang = 'ko' } = {}) {
  if (def.key.startsWith('assistant.')) { const view = await assistantSettingsView(wsId); return { value: def.read(view), view }; }
  if (def.key === 'routine.time') {
    const r = (await loadRoutines(wsId)).find((x) => x.id === id);
    if (!r) return { error: pick(lang, `그런 루틴이 없다: ${id ?? '(id 없음)'}. argo_status section=routines로 id를 확인하라.`, `No routine with id ${id ?? '(none)'}. Check ids with argo_status section=routines.`) };
    const sc = r.schedule ?? {};
    if (sc.type === 'interval') return { error: pick(lang, 'N분마다 도는 루틴은 시각이 없다 — 간격은 루틴 화면에서 바꾼다.', 'Interval routines have no time — change the interval on the Routines screen.') };
    const times = Array.isArray(sc.times) && sc.times.length ? sc.times : [sc.time];
    if (times.length !== 1) return { error: pick(lang, '시각이 여러 개인 루틴은 루틴 화면에서 바꾼다.', 'Routines with several times are changed on the Routines screen.') };
    return { value: times[0], routine: r };
  }
  if (def.key === 'company.lang') return { value: (await loadCompany(wsId)).lang ?? 'ko' };
  return { error: 'unsupported' };
}

/**
 * 설정 적용(바로 바꾸기·결재 승인 공용) — { ok, before, after, text } | { ok:false, text }.
 * slug = 이 도구를 부른 에이전트(비서를 켤 때 지정된 비서가 없으면 이 에이전트).
 */
export async function applySetting(wsId, { key, id = null, value }, { slug = null, lang = 'ko' } = {}) {
  const def = settingOf(key);
  if (!def || forbiddenOf(key)) return { ok: false, text: pick(lang, `바꿀 수 없는 설정: ${key}`, `Not a changeable setting: ${key}`) };
  const norm = normalizeSettingValue(def, value, lang);
  if (norm.error) return { ok: false, text: norm.error };
  const cur = await currentValue(wsId, def, { id, lang });
  if (cur.error) return { ok: false, text: cur.error };
  const before = cur.value;
  if (before === norm.value) return { ok: true, before, after: before, unchanged: true, text: pick(lang, `이미 ${showVal(before, lang)}(으)로 되어 있다 — 바꾸지 않았다(${def.label.ko}).`, `Already ${showVal(before, lang)} — nothing changed (${def.label.en}).`) };
  if (def.key.startsWith('assistant.')) {
    const agent = def.key === 'assistant.agent' ? norm.value : (cur.view.config.agent ?? slug);
    if (def.key === 'assistant.agent' && !(await scanAgents(wsId)).agents.some((a) => a.slug === agent)) {
      return { ok: false, text: pick(lang, `이 회사에 없는 에이전트: ${agent}`, `No such agent in this company: ${agent}`) };
    }
    if (def.key === 'assistant.agent' && !cur.view.config.enabled) {
      return { ok: false, text: pick(lang, '이 회사 비서가 꺼져 있어 에이전트만 바꾸지 않았다 — 켜려면 assistant.enabled를 true로(비서를 켜는 일이라 따로 확인받는다).', "This company's assistant is off, so the agent was not changed — to turn it on use assistant.enabled=true (a separate step).") };
    }
    let res;
    try { res = await saveAssistantSettings(wsId, def.write(norm.value, { agent })); }
    catch (e) { return { ok: false, text: assistantErrorText(e, lang) }; }
    const after = def.read(await assistantSettingsView(wsId));
    const offNames = await Promise.all((res?.changedOthers ?? []).map((id) => loadCompany(id).then((c) => c?.name ?? id, () => id)));
    const offText = offNames.length ? pick(lang, ` 계정마다 비서는 한 명이라 다른 회사(${offNames.join(', ')})의 비서는 꺼졌다 — 사용자에게 이것도 알려라.`, ` One assistant per account, so the assistant in ${offNames.join(', ')} was turned off — tell the user this too.`) : '';
    return { ok: true, before, after, offCompanies: res?.changedOthers ?? [], text: `${changedText(def, before, after, lang)}${offText}` };
  }
  if (def.key === 'routine.time') {
    const r = cur.routine;
    const sc = r.schedule ?? {};
    await updateRoutine(wsId, r.id, { schedule: { ...sc, time: norm.value, times: [norm.value] } });
    return { ok: true, before, after: norm.value, text: changedText(def, before, norm.value, lang, r.title) };
  }
  if (def.key === 'company.lang') {
    const { updateCompany } = await import('./workspace.mjs');
    await updateCompany(wsId, { lang: norm.value });
    return { ok: true, before, after: norm.value, text: changedText(def, before, norm.value, lang) };
  }
  return { ok: false, text: 'unsupported' };
}

/** 결재 승인 뒤 적용 — 카드를 올릴 때 계산한 "꺼질 다른 회사 비서"가 지금도 같은지 다시 본다. 다르면(그 사이 다른 회사에서 비서를 켜거나 끔) 카드에 보인 것과
    실제로 일어날 일이 달라지므로 적용하지 않는다. 반환 = 후속 보고 문구(appliedNote). */
export async function applyApprovedSetting(wsId, p, { slug = null } = {}) {
  const lang = p.lang ?? 'ko';
  const def = settingOf(p.key);
  if (def) {
    const off = await otherAssistantOff(wsId, def, normalizeSettingValue(def, p.value, lang).value);
    if ((off?.ws ?? null) !== (p.offWs ?? null)) return pick(lang, '적용 취소 — 결재를 올린 뒤 다른 회사의 비서 상태가 바뀌어, 카드에 보인 것과 실제로 일어날 일이 다르다. 사용자에게 다시 확인받아라.', "Not applied — another company's assistant changed after the card was filed, so the card no longer matches what would happen. Ask the user again.");
  }
  return appliedNote(p, await applySetting(wsId, { key: p.key, id: p.id ?? null, value: p.value }, { slug, lang }), lang);
}

/** 결재 승인 뒤 적용 결과 문구(순수) — 후속 턴이 원래 방(채널일 수 있다)에 보고하므로 이전 값은 싣지 않는다. 새 값과 화면 위치만. */
export function appliedNote({ key, value }, r, lang = 'ko') {
  const def = settingOf(key);
  if (!r?.ok || !def) return pick(lang, `적용 실패 — ${r?.text ?? key}`, `Not applied — ${r?.text ?? key}`);
  const L = ko(lang) ? 'ko' : 'en';
  const off = r.offCompanies?.length ? pick(lang, ' 같은 계정의 다른 회사 비서는 꺼졌다(계정마다 한 명).', " The assistant in this account's other company was turned off (one per account).") : '';
  return pick(lang, `적용 완료 — ${def.label.ko} → ${showVal(r.after ?? value, lang)}(화면: ${def.where.ko}).${off} 이전 값은 말하지 마라.`,
    `Applied — ${def.label[L]} → ${showVal(r.after ?? value, lang)} (screen: ${def.where.en}).${off} Don't mention the previous value.`);
}

function assistantErrorText(e, lang) {
  const code = e?.code ?? '';
  const ko_ = {
    assistant_quiet_empty: '조용한 시간 시작과 끝이 같으면 안 된다.',
    assistant_evening_in_quiet: '내일 일정 요약 시각이 조용한 시간 안에 있다 — 조용한 시간 밖으로 정해야 나간다.',
    assistant_evening_before_morning: '아침 정리(조용한 시간 끝)는 내일 일정 요약보다 앞이어야 한다.',
    assistant_time_invalid: '시각 형식이 맞지 않는다(HH:MM).',
    assistant_lead_invalid: `일정 알림은 ${LEAD_CHOICES.join('·')}분 전 중 하나다.`,
    assistant_agent_not_found: '비서로 정할 에이전트를 찾지 못했다.',
  };
  const en_ = {
    assistant_quiet_empty: 'Quiet hours start and end cannot be the same.',
    assistant_evening_in_quiet: "Tomorrow's summary falls inside quiet hours — pick a time outside them.",
    assistant_evening_before_morning: "The morning summary (quiet hours end) must be earlier than tomorrow's summary.",
    assistant_time_invalid: 'Time must be HH:MM.',
    assistant_lead_invalid: `Event reminder must be one of ${LEAD_CHOICES.join('/')} minutes.`,
    assistant_agent_not_found: 'Could not find the agent to make the assistant.',
  };
  const msg = (ko(lang) ? ko_ : en_)[code];
  return `${pick(lang, '바꾸지 못했다', 'Not changed')}: ${msg ?? String(e?.message ?? e).slice(0, 160)}`;
}

function changedText(def, before, after, lang, title = '') {
  const L = ko(lang) ? 'ko' : 'en';
  const name = `${def.label[L]}${title ? ` — ${title}` : ''}`;
  const empty = before === '' || before == null; // 비어 있던 값(예: 정해진 비서 없음)으로는 도구로 되돌릴 수 없다 — 화면 안내만
  return pick(lang,
    `바꿨다 — ${name}: ${showVal(before, lang)} → ${showVal(after, lang)}. 되돌리는 법: ${empty ? '' : `"${showVal(before, lang)}(으)로 되돌려 줘"라고 하면 다시 바꾸고, `}화면에서는 ${def.where.ko}에서 바꾼다. 사용자에게 바꾼 값과 되돌리는 법을 짧게 알려라.`,
    `Changed — ${name}: ${showVal(before, lang)} → ${showVal(after, lang)}. To undo: ${empty ? '' : `ask "change it back to ${showVal(before, lang)}", or `}change it at ${def.where.en}. Tell the user the new value and how to undo it, briefly.`);
}

/**
 * argo_settings 처리(도구 처리기 본체) — 반환 { kind: 'text'|'approval', text, approval? }.
 * kind 'approval'이면 호출부(chat.mjs)가 같은 결재 경로(addApproval — 메신저 카드·텔레그램 버튼 포함)로 올린다.
 */
export async function argoSettings(wsId, { action = 'list', key = '', id = null, value = null, why = '' } = {}, { slug = null, lang = 'ko', direct = false, guest = false } = {}) {
  if (action === 'list') return { kind: 'text', text: await settingsList(wsId, { lang, direct, guest }) };
  const policy = settingPolicy({ key, direct, guest });
  if (policy === 'forbidden') {
    const f = forbiddenOf(key); const L = ko(lang) ? 'ko' : 'en';
    return { kind: 'text', text: pick(lang,
      `이 설정은 에이전트가 바꿀 수 없다(${f.why.ko}). 바꾸지 말고, 사용자가 직접 ${f.where.ko}에서 바꾸도록 안내하라.`,
      `Agents cannot change this setting (${f.why[L]}). Don't change it — tell the user to change it themselves at ${f.where.en}.`) };
  }
  if (policy === 'unknown') {
    return { kind: 'text', text: pick(lang,
      `"${key}"는 에이전트가 바꿀 수 있는 설정 목록에 없다. argo_settings action=list로 바꿀 수 있는 설정을 확인하라. 목록에 없는 설정은 사용자가 화면에서 바꾸도록 안내하라.`,
      `"${key}" is not on the list of settings agents can change. Check the list with argo_settings action=list; for anything else, tell the user where to change it on screen.`) };
  }
  const def = settingOf(key);
  if (def.needsId && !id) return { kind: 'text', text: pick(lang, '이 설정은 id가 필요하다(루틴 id — argo_status section=routines).', 'This setting needs an id (routine id — argo_status section=routines).') };
  if (id != null && !/^[A-Za-z0-9_-]{1,40}$/.test(String(id))) return { kind: 'text', text: pick(lang, 'id 형식이 맞지 않는다(루틴 id).', 'Invalid id (routine id).') }; // 카드 문구에 들어가는 값 — 글자 제한
  const norm = normalizeSettingValue(def, value, lang);
  if (norm.error) return { kind: 'text', text: norm.error };
  if (policy === 'apply') {
    const r = await applySetting(wsId, { key: def.key, id, value: norm.value }, { slug, lang });
    return { kind: 'text', text: r.text };
  }
  // 결재 — 주인의 1:1이 아닌 턴이다. 지금 값을 읽지도 알려 주지도 않는다(같다/다르다도 — 도구 결과는 그 방으로 나갈 수 있다).
  // 이미 같은 값이면 승인 뒤 적용 단계(applySetting)가 "이미 …"로 끝낸다. 사유는 에이전트가 쓴 글 — 키 모양 문자열을 가린다(maskKeyLike).
  const off = await otherAssistantOff(wsId, def, norm.value);
  const payload = { key: def.key, ...(id ? { id: String(id) } : {}), value: norm.value, lang: ko(lang) ? 'ko' : 'en', ...(slug ? { by: slug } : {}), ...(off ? { offWs: off.ws } : {}) };
  const reason = maskKeyLike(String(why || '').replace(/[\r\n\t]+/g, ' ').trim()).slice(0, 500) || pick(lang, '에이전트가 올린 설정 변경 요청', 'Setting change requested by an agent');
  return {
    kind: 'approval',
    approval: { action: settingActionText(payload, lang), reason, payload },
    text: pick(lang,
      `이 요청은 주인이 1:1에서 직접 시킨 것이 아니라서 바로 바꾸지 않고 주인 결재로 올렸다(${def.label.ko} → ${showVal(norm.value, lang)}${off ? ' · 승인되면 같은 계정의 다른 회사 비서가 꺼진다' : ''}). 승인되면 시스템이 바꾸고 결과가 이어서 온다 — 승인 전에는 바뀐 것처럼 말하지 마라. 지금 값은 이 방에 알리지 않는다.`,
      `This request didn't come from the owner directly in a 1:1, so it was filed for the owner's approval instead of applied (${def.label.en} → ${showVal(norm.value, lang)}${off ? " · approving turns off the assistant in this account's other company" : ''}). Once approved the system applies it and reports back — don't say it changed before then. Don't share the current value here.`),
  };
}

async function settingsList(wsId, { lang, direct, guest }) {
  const L = ko(lang) ? 'ko' : 'en';
  const reveal = direct && !guest; // 설정 값은 주인 1:1에서만(argoStatus와 같은 범위)
  const view = reveal ? await assistantSettingsView(wsId).catch(() => null) : null;
  const company = reveal ? await loadCompany(wsId).catch(() => ({})) : {};
  const now = (def) => {
    if (!reveal) return pick(lang, '(주인의 1:1에서만 보여 준다)', "(shown only in the owner's 1:1)");
    if (def.key.startsWith('assistant.')) return view ? showVal(def.read(view), lang) : '?';
    if (def.key === 'company.lang') return company.lang ?? 'ko';
    return pick(lang, '루틴마다 다름(argo_status section=routines)', 'per routine (argo_status section=routines)');
  };
  const mode = direct && !guest
    ? pick(lang, '이 턴은 주인이 1:1에서 직접 시킨 턴이다 — 아래 설정은 바로 바뀐다(바꾼 값과 되돌리는 법을 알려라).', 'This is an owner-direct 1:1 turn — the settings below apply immediately (tell the user the new value and how to undo).')
    : pick(lang, '이 턴은 주인의 1:1 직접 지시가 아니다 — 바꾸면 주인 결재 카드로 올라간다.', "This turn isn't an owner-direct 1:1 — changes go to the owner as an approval card.");
  const rows = SETTINGS.map((d) => `- ${d.key} — ${d.label[L]} · ${pick(lang, '지금', 'now')}: ${now(d)}${d.choices ? ` · ${pick(lang, '가능한 값', 'values')}: ${d.choices.join(', ')}` : d.type === 'time' ? ' · HH:MM' : d.type === 'bool' ? ' · true/false' : ''}${d.needsId ? ' · id' : ''} · ${pick(lang, '화면', 'screen')}: ${d.where[L]}`);
  const no = FORBIDDEN_SETTINGS.map((f) => `- ${f.why[L]} — ${f.where[L]}`);
  return [mode, pick(lang, '바꿀 수 있는 설정(key — 이름 · 지금 값 · 형식 · 화면 위치):', 'Changeable settings (key — name · now · format · screen):'), ...rows,
    pick(lang, '에이전트가 바꾸지 못하는 것(사용자가 화면에서 직접):', 'Agents cannot change (the user does it on screen):'), ...no,
    pick(lang, '루틴 켜기·끄기는 cancel_routine, 에이전트 이름·역할·러너·모델은 update_profile(결재)로 한다.', 'Routine on/off uses cancel_routine; agent name/role/runner/model uses update_profile (approval).')].join('\n');
}

/* ─── 상태 읽기 ─────────────────────────────────────────────────────────────── */

export const STATUS_SECTIONS = Object.freeze(['overview', 'deck', 'agents', 'me', 'routines', 'assistant', 'runners', 'sync', 'plan', 'messenger', 'approvals']);

const fmtTime = (ms, lang) => {
  if (!ms) return pick(lang, '없음', 'none');
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return pick(lang, '없음', 'none');
  return d.toLocaleString(ko(lang) ? 'ko-KR' : 'en-US', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
};
const ago = (ms, now, lang) => {
  if (!ms) return '';
  const m = Math.max(0, Math.round((now - ms) / 60_000));
  if (m < 1) return pick(lang, '방금', 'just now');
  if (m < 60) return pick(lang, `${m}분 전`, `${m} min ago`);
  const h = Math.round(m / 60);
  return h < 48 ? pick(lang, `${h}시간 전`, `${h} h ago`) : pick(lang, `${Math.round(h / 24)}일 전`, `${Math.round(h / 24)} days ago`);
};
const num = (n, lang) => Number(n ?? 0).toLocaleString(ko(lang) ? 'ko-KR' : 'en-US');

async function deckSection(wsId, { lang, now }) {
  const [docs, { agents }, approvals] = await Promise.all([listDocs(wsId), scanAgents(wsId), loadApprovals(wsId).catch(() => [])]);
  const d = deckMetrics({ docs, agentCount: agents.length, now });
  const pending = approvals.filter((a) => a.status === 'pending').length;
  const pctExact = d.linkedPercent.toFixed(1);
  const daily = d.daily.map((x) => `${x.date} ${x.count}`).join(' · ');
  return ko(lang) ? [
    '데크 계기판 — 지금 값(데크 화면과 같은 함수로 계산)',
    `- 기억: ${num(d.memoryCount, lang)}건 (오늘 +${d.today}) · 노트 ${num(d.notes, lang)} · 일지 ${num(d.conversations, lang)} · 이번 주 배운 주제 ${d.learnedThisWeek}건`,
    `- 에이전트: ${d.agents}명`,
    `- 기억 연결: 연결된 기억 ${d.linkedPercentShown}% (다이얼 표시) · 연결 ${num(d.links, lang)}쌍 (칩 표시)`,
    `  계산: 링크가 1개 이상인 기억 ${num(d.linked, lang)}건 ÷ (연결된 기억 ${num(d.linked, lang)} + 고립된 기억 ${num(d.isolated, lang)}) = ${pctExact}% → 반올림해 ${d.linkedPercentShown}%.`,
    `  링크는 기억 본문의 위키 링크(대괄호 두 겹으로 감싼 문서 이름 — 경로·파일 이름·제목 세 가지로 찾는다)이고, 같은 두 기억 사이는 한 쌍으로 센다(양방향 중복·자기 자신 링크 제외). 안내 노트 ${d.guides}건은 기억이 아니라 셈에서 뺀다.`,
    `  고립된 기억을 다른 기억과 위키 링크로 이으면 올라간다. 기억 화면의 그래프에서 고립된 점이 보인다.`,
    `- 구성: 대화 기록 ${num(d.conversations, lang)} · 지식 노트 ${num(d.notes, lang)}`,
    `- 일별 기억 적립(최근 14일, UTC 날짜): ${daily}`,
    `- 결재 대기: ${pending}건`,
  ].join('\n') : [
    'Deck — current values (computed with the same functions as the Deck screen)',
    `- Memory: ${num(d.memoryCount, lang)} (today +${d.today}) · notes ${num(d.notes, lang)} · journal ${num(d.conversations, lang)} · learned this week ${d.learnedThisWeek}`,
    `- Agents: ${d.agents}`,
    `- Memory Links: linked memories ${d.linkedPercentShown}% (dial) · ${num(d.links, lang)} pairs (chip)`,
    `  How: memories with at least one link ${num(d.linked, lang)} ÷ (linked ${num(d.linked, lang)} + isolated ${num(d.isolated, lang)}) = ${pctExact}% → rounded to ${d.linkedPercentShown}%.`,
    `  Links are wiki links inside memories (a document name in double square brackets, matched by path, file name, or title); each pair of memories counts once (no duplicates, no self-links). ${d.guides} guide note(s) are excluded — they are not memories.`,
    `  Linking isolated memories to others with wiki links raises it. The Memory screen graph shows isolated dots.`,
    `- Composition: conversations ${num(d.conversations, lang)} · knowledge notes ${num(d.notes, lang)}`,
    `- Daily memory accrual (last 14 days, UTC dates): ${daily}`,
    `- Pending approvals: ${pending}`,
  ].join('\n');
}

async function agentsSection(wsId, { lang, slug }) {
  const company = await loadCompany(wsId).catch(() => ({}));
  const { agents, broken } = await scanAgents(wsId);
  const lines = await Promise.all(agents.map(async (a) => {
    const st = await getTurnStatus(wsId, a.slug).catch(() => null);
    const runner = a.runner || (company.defaultRunner ? `${company.defaultRunner}${pick(lang, '(회사 기본)', ' (company default)')}` : pick(lang, '자동(연결된 러너)', 'auto (connected runner)'));
    const model = a.model || pick(lang, '러너 기본', 'runner default');
    const busy = st ? pick(lang, `작업 중(${st.stage})`, `working (${st.stage})`) : pick(lang, '대기', 'idle');
    return `- ${a.name}${a.slug === slug ? pick(lang, ' (나)', ' (me)') : ''} [${a.slug}] — ${a.role || '-'}${a.team ? ` · ${pick(lang, '팀', 'team')} ${a.team}` : ''} · ${pick(lang, '러너', 'runner')} ${runner} · ${pick(lang, '모델', 'model')} ${model}${a.effort ? ` · ${pick(lang, '추론 강도', 'effort')} ${a.effort}` : ''} · ${busy}`;
  }));
  return [pick(lang, `에이전트 ${agents.length}명`, `${agents.length} agents`), ...lines,
    ...(broken.count ? [pick(lang, `- 카드를 읽지 못한 에이전트 ${broken.count}명: ${broken.names.join(', ')}`, `- ${broken.count} agent card(s) could not be read: ${broken.names.join(', ')}`)] : [])].join('\n');
}

function scheduleLine(sc = {}, loop, lang) {
  const times = (Array.isArray(sc.times) && sc.times.length ? sc.times : [sc.time]).filter(Boolean).join(', ');
  const days = ko(lang) ? ['일', '월', '화', '수', '목', '금', '토'] : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  if (sc.type === 'once') return pick(lang, `1회 ${sc.date} ${times}`, `once ${sc.date} ${times}`);
  if (sc.type === 'weekly') return pick(lang, `매주 ${(sc.dows ?? [sc.dow]).map((d) => days[d] ?? d).join('·')} ${times}`, `weekly ${(sc.dows ?? [sc.dow]).map((d) => days[d] ?? d).join('/')} ${times}`);
  if (sc.type === 'interval') return pick(lang, `${sc.everyMinutes}분마다(최대 ${loop?.maxRuns ?? 20}회)`, `every ${sc.everyMinutes} min (max ${loop?.maxRuns ?? 20} runs)`);
  return pick(lang, `매일 ${times}`, `daily ${times}`);
}

function routineLines(rs, { lang, now }) {
  return rs.map((r) => {
    const lastAt = r.lastRun ? Date.parse(r.lastRun) : 0;
    const result = !r.lastRun ? pick(lang, '아직 실행 전', 'not run yet')
      : `${pick(lang, '마지막 실행', 'last run')} ${fmtTime(lastAt, lang)}(${ago(lastAt, now, lang)}) ${r.lastOk === false ? pick(lang, '실패', 'failed') : r.lastOk === true ? pick(lang, '성공', 'ok') : pick(lang, '진행 중이거나 결과 없음', 'running or no result')}`;
    const snippet = String(r.lastResult ?? '').replace(/\s+/g, ' ').trim().slice(0, 160);
    const loop = r.loop ? ` · ${pick(lang, '회차', 'runs')} ${r.loop.runs ?? 0}/${r.loop.maxRuns ?? 20}${r.loop.stoppedReason ? ` · ${pick(lang, '정지 사유', 'stopped')}: ${r.loop.stoppedReason}` : ''}` : '';
    const missed = Array.isArray(r.missed) && r.missed.length ? ` · ${pick(lang, '놓친 회차', 'missed')} ${r.missed.length}` : '';
    return `- ${r.title} [${r.id}] — ${scheduleLine(r.schedule, r.loop, lang)} · ${pick(lang, '담당', 'agent')} ${r.agentSlug} · ${r.enabled === false ? pick(lang, '정지', 'off') : pick(lang, '가동', 'on')} · ${result}${loop}${missed}${snippet ? `\n  ${pick(lang, '결과 요약', 'result')}: ${snippet}` : ''}`;
  });
}

async function routinesSection(wsId, { lang, slug, now, mine = false }) {
  const all = await loadRoutines(wsId);
  const rs = mine ? all.filter((r) => r.agentSlug === slug) : all;
  if (!rs.length) return mine ? pick(lang, '내가 맡은 루틴이 없다.', 'No routines assigned to me.') : pick(lang, '이 회사에 루틴이 없다.', 'This company has no routines.');
  return [mine ? pick(lang, `내 루틴 ${rs.length}개`, `My routines: ${rs.length}`) : pick(lang, `루틴 ${rs.length}개(루틴 화면과 같은 목록)`, `${rs.length} routines (same list as the Routines screen)`), ...routineLines(rs, { lang, now })].join('\n');
}

const ASSIST_CODE = {
  ok: ['정상', 'normal'],
  other_company: ['다른 회사의 비서가 맡고 있음', "another company's assistant is handling it"],
  login_required: ['로그인 필요', 'sign-in needed'],
  muted: ['메신저 알림 종류에서 비서 알림이 꺼짐', 'assistant notifications muted in messenger'],
  runner_outdated: ['실행 기기가 옛 버전', 'running device is outdated'],
  calendar_error: ['일정을 읽지 못함 — 다음 확인 때 다시 읽음', "couldn't read the calendar — retries at next check"],
  deliver_failed: ['알림을 보내지 못해 다시 보내는 중', "couldn't send — retrying"],
  personal_room_unavailable: ['개인 공간 1:1 방을 열 수 없음', "can't open the personal 1:1 room"],
};

async function assistantSection(wsId, { lang, slug, now }) {
  const v = await assistantSettingsView(wsId, { now });
  const c = v.config; const s = v.status;
  const L = ko(lang) ? 0 : 1;
  const runner = { this_device: pick(lang, `이 기기${s.device ? `(${s.device})` : ''}`, `this device${s.device ? ` (${s.device})` : ''}`), other_device: pick(lang, `다른 기기${s.device ? `(${s.device})` : ''}`, `another device${s.device ? ` (${s.device})` : ''}`), runner_outdated: pick(lang, `옛 버전 기기${s.device ? `(${s.device})` : ''} — 그 기기 업데이트 필요`, `old-version device${s.device ? ` (${s.device})` : ''} — update it`), no_runner: pick(lang, '지금 실행 중인 기기 없음', 'no device running it') }[s.runner] ?? s.runner;
  const here = s.runner === 'this_device' && v.current?.ws === wsId;
  const lines = [
    pick(lang, '비서(능동 알림) — 설정 화면(에이전트 카드 → 비서 탭)과 같은 값', 'Assistant (proactive alerts) — same values as Agent card → Assistant tab'),
    `- ${pick(lang, '이 회사 비서', 'This company')}: ${c.enabled ? pick(lang, '켜짐', 'on') : pick(lang, '꺼짐', 'off')}${c.agent ? ` · ${pick(lang, '비서 에이전트', 'assistant agent')} ${c.agent}${c.agent === slug ? pick(lang, '(나)', ' (me)') : ''}` : ''}`,
    `- ${pick(lang, '지금 비서(계정마다 한 명)', 'Current assistant (one per account)')}: ${v.current ? `${v.current.company} · ${v.current.name}` : pick(lang, '없음', 'none')}`,
    ...(v.unsealed ? [pick(lang, '- 설정 파일이 설정 화면 밖에서 바뀌어 멈춤 — 비서 탭에서 다시 켜면 돈다', '- Stopped: the settings file was changed outside the settings screen — turn it on again in the Assistant tab')] : []),
    `- ${pick(lang, '보는 것', 'Watches')}: ${pick(lang, '일정(읽기만)', 'calendar (read only)')} · ${pick(lang, '받는 곳', 'delivered to')}: ${pick(lang, '개인 공간 1:1 방', 'personal 1:1 room')} · ${pick(lang, '권한', 'permission')}: ${pick(lang, '알림만', 'notify only')}`,
    `- ${pick(lang, '일정 알림', 'Event reminder')}: ${c.leadMinutes}${pick(lang, '분 전', ' min before')} · ${pick(lang, '아침 정리(조용한 시간 끝)', 'Morning summary (quiet hours end)')}: ${c.quiet.to} · ${pick(lang, '내일 일정 요약', "Tomorrow's summary")}: ${c.eveningAt} · ${pick(lang, '조용한 시간', 'Quiet hours')}: ${c.quiet.from}~${c.quiet.to}${c.quiet.calendarAlerts ? pick(lang, '(일정 알림은 보냄)', ' (reminders still sent)') : ''}${c.tz ? ` · ${c.tz}` : ''}`,
    `- ${pick(lang, '실행 기기', 'Running on')}: ${runner}`,
    `- ${pick(lang, '확인 주기', 'Check cadence')}: ${pick(lang, `켜져 있으면 1분마다 차례를 보고, 일정은 ${CAL_READ_MS / 60_000}분마다 읽는다(조용한 시간에는 쉬었다가 끝나면 밤사이를 모아 아침 정리로 보낸다)`, `when on it checks every minute and reads the calendar every ${CAL_READ_MS / 60_000} min (rests during quiet hours, then sends the night's items in the morning summary)`)}`,
    here
      ? `- ${pick(lang, '마지막 일정 확인', 'Last calendar check')}: ${s.readAt ? `${fmtTime(s.readAt, lang)}(${ago(s.readAt, now, lang)})` : pick(lang, '아직 없음', 'not yet')} · ${pick(lang, '오늘 보낸 일정 알림', 'reminders sent today')}: ${s.instantToday}${pick(lang, '건', '')} · ${pick(lang, '상태', 'status')}: ${s.code ? (ASSIST_CODE[s.code]?.[L] ?? s.code) : pick(lang, '기록 없음', 'no record')}`
      : `- ${pick(lang, '마지막 일정 확인·오늘 보낸 알림 수는 실행 기기에만 기록된다 — 이 기기에서는 볼 수 없다', 'Last check and today\'s count are recorded only on the running device — not visible from this device')}`,
    `- ${pick(lang, '로그인', 'Sign-in')}: ${s.login ? pick(lang, '됨', 'ok') : pick(lang, '필요 — 이 기기에서 회사를 만든 계정으로 로그인', 'needed — sign in on this device with the account that created this company')}${s.muted ? pick(lang, ' · 메신저 알림 종류에서 비서 알림이 꺼져 있어 보내지 않음', ' · assistant notifications are muted in messenger') : ''}`,
  ];
  return lines.join('\n');
}

async function meSection(wsId, { lang, slug, now }) {
  const { agents } = await scanAgents(wsId);
  const me = agents.find((a) => a.slug === slug);
  const company = await loadCompany(wsId).catch(() => ({}));
  const head = me
    ? pick(lang, `나: ${me.name} [${me.slug}] — ${me.role || '-'}${me.team ? ` · 팀 ${me.team}` : ''} · 러너 ${me.runner || (company.defaultRunner ? `${company.defaultRunner}(회사 기본)` : '자동')} · 모델 ${me.model || '러너 기본'}${me.effort ? ` · 추론 강도 ${me.effort}` : ''}`,
      `Me: ${me.name} [${me.slug}] — ${me.role || '-'}${me.team ? ` · team ${me.team}` : ''} · runner ${me.runner || (company.defaultRunner ? `${company.defaultRunner} (company default)` : 'auto')} · model ${me.model || 'runner default'}${me.effort ? ` · effort ${me.effort}` : ''}`)
    : pick(lang, `나: ${slug}`, `Me: ${slug}`);
  const [routines, assistant, approvals] = await Promise.all([
    routinesSection(wsId, { lang, slug, now, mine: true }),
    assistantSettingsView(wsId, { now }).catch(() => null),
    loadApprovals(wsId).catch(() => []),
  ]);
  const amAssistant = assistant?.config?.enabled && assistant.config.agent === slug;
  const mine = approvals.filter((a) => a.status === 'pending' && a.slug === slug);
  return [head, routines,
    amAssistant ? pick(lang, '나는 이 회사의 비서다 — 자세한 상태는 argo_status section=assistant', 'I am this company\'s assistant — details: argo_status section=assistant') : pick(lang, '나는 이 회사의 비서가 아니다.', "I am not this company's assistant."),
    pick(lang, `내가 올린 결재 중 대기 ${mine.length}건${mine.length ? `: ${mine.slice(0, 5).map((a) => a.action).join(' / ')}` : ''}`, `Pending approvals I filed: ${mine.length}${mine.length ? `: ${mine.slice(0, 5).map((a) => a.action).join(' / ')}` : ''}`),
  ].join('\n');
}

async function approvalsSection(wsId, { lang }) {
  const pend = (await loadApprovals(wsId)).filter((a) => a.status === 'pending');
  if (!pend.length) return pick(lang, '결재 대기 0건.', 'No pending approvals.');
  return [pick(lang, `결재 대기 ${pend.length}건(데크 결재함·대화창 카드에서 승인)`, `${pend.length} pending approvals (approve from the Deck approvals card or the chat card)`),
    ...pend.slice(0, 10).map((a) => `- ${a.action} — ${a.slug}${a.from ? ` ← ${a.from}` : ''} · ${a.createdAt?.slice(0, 16).replace('T', ' ') ?? ''}`),
    ...(pend.length > 10 ? [pick(lang, `…외 ${pend.length - 10}건`, `…and ${pend.length - 10} more`)] : [])].join('\n');
}

async function runnersSection(wsId, { lang }) {
  const { runnerStatus } = await import('./runners.mjs'); // runners.mjs는 무겁다 — 이 구획을 볼 때만
  const st = await runnerStatus(wsId, { forPick: true });
  const company = await loadCompany(wsId).catch(() => ({}));
  const typeName = (t) => ({ apikey: pick(lang, 'API 키', 'API key'), oauth: pick(lang, '구독 로그인', 'subscription sign-in'), host: pick(lang, '이 컴퓨터 로그인', "this computer's login") }[t] ?? t);
  const rows = Object.entries(st).filter(([, s]) => !s.hidden || s.company?.connected).map(([id, s]) => {
    const c = s.company ?? {};
    const state = !c.connected ? pick(lang, '미연결', 'not connected')
      : c.invalid ? pick(lang, `재연결 필요(${typeName(c.type)})`, `reconnect needed (${typeName(c.type)})`)
      : pick(lang, `연결됨(${typeName(c.type)})`, `connected (${typeName(c.type)})`);
    return `- ${s.name} [${id}]: ${state}${s.retired ? pick(lang, ' · 제공 종료', ' · retired') : ''}`;
  });
  return [pick(lang, '러너 연결(설정 → AI 연결과 같은 판정 — 키·토큰 값은 싣지 않는다)', 'Runner connections (same as Settings → AI connection — keys and tokens are never shown)'), ...rows,
    pick(lang, `회사 기본 러너: ${company.defaultRunner ?? '없음(연결된 러너 중 자동)'}`, `Company default runner: ${company.defaultRunner ?? 'none (auto among connected)'}`)].join('\n');
}

async function syncSection(wsId, { lang, now }) {
  const { syncStatusFor, leaseCheck, deviceLabel } = await import('./sync.mjs'); // 메모리 값만 읽는다(네트워크 0)
  const s = syncStatusFor(wsId);
  const c = s.companies?.[wsId] ?? null;
  const li = leaseCheck();
  const skip = { 'idle-probe': pick(lang, '바뀐 것 없음(유휴 확인)', 'no changes (idle check)'), 'free-plan': pick(lang, '무료 요금제 — 이 기기에만 저장', 'free plan — stored on this device only'), 'foreign-owner': pick(lang, '다른 계정의 회사', "another account's company"), 'upload-denied': pick(lang, '업로드 거절 대기', 'upload denied, waiting'), 'retry-backoff': pick(lang, '오류 뒤 다시 시도 대기', 'waiting to retry after an error') };
  const lastAt = c?.ts ?? s.lastTs ?? 0;
  const lines = [
    pick(lang, '기기 간 동기화(설정 → 기기·데이터 → 기기 간 동기화와 같은 값)', 'Cross-device sync (same values as Settings → Devices & data → Cross-device Sync)'),
    `- ${pick(lang, '상태', 'State')}: ${s.on ? pick(lang, '가동 중', 'active') : pick(lang, '꺼짐', 'off')}${s.paywalled ? pick(lang, ' · 요금제 때문에 멈춤', ' · paused by plan') : ''}`,
    `- ${pick(lang, '실행 담당 기기', 'Running device')}: ${!li.syncOn || (li.leader && li.ownedAt > 0) ? pick(lang, '이 기기(폴러·루틴이 여기서 돈다)', 'this device (pollers and routines run here)') : li.holder?.deviceId ? pick(lang, `다른 기기(${deviceLabel(li.holder.deviceId)})`, `another device (${deviceLabel(li.holder.deviceId)})`) : pick(lang, '확인 중', 'checking')}`,
    `- ${pick(lang, '마지막 동기화', 'Last sync')}: ${lastAt ? `${fmtTime(lastAt, lang)}(${ago(lastAt, now, lang)})` : pick(lang, '이 실행에서는 아직 없음', 'none yet in this run')}${c?.skipped ? ` · ${skip[c.skipped] ?? c.skipped}` : ''}`,
    ...(c && !c.skipped ? [`- ${pick(lang, '이번 회차', 'Last cycle')}: ${pick(lang, '받음', 'pulled')} ${c.pulled ?? 0} · ${pick(lang, '올림', 'pushed')} ${c.pushed ?? 0} · ${pick(lang, '충돌', 'conflicts')} ${c.conflicts ?? 0} · ${pick(lang, '실패', 'failed')} ${c.failed ?? 0}`] : []),
    ...(s.lastError ? [`- ${pick(lang, '마지막 오류', 'Last error')}: ${String(s.lastError).slice(0, 200)}`] : []),
  ];
  return lines.join('\n');
}

async function planSection(wsId, { lang }) {
  const [{ syncStatus }, { readUsageSummary }, company] = await Promise.all([import('./sync.mjs'), import('./billing.mjs'), loadCompany(wsId).catch(() => ({}))]);
  const plan = syncStatus().plan; // 이 기기가 동기화하며 마지막으로 받은 값(조회 호출을 새로 하지 않는다) — 없으면 모른다고 말한다
  const u = await readUsageSummary(wsId).catch(() => null);
  const usd = (n) => `$${Number(n ?? 0).toFixed(2)}`;
  const row = (label, x) => (x ? `- ${label}: ${pick(lang, '턴', 'turns')} ${x.turns ?? 0}${x.hasCost ? ` · ${pick(lang, 'API 비용', 'API cost')} ${usd(x.costUsd)}` : ''}${x.subTurns ? ` · ${pick(lang, '구독 턴(추가 청구 없음)', 'subscription turns (no extra charge)')} ${x.subTurns}` : ''}` : null);
  return [
    pick(lang, '요금제·사용량', 'Plan and usage'),
    `- ${pick(lang, '요금제', 'Plan')}: ${plan ? { pro: 'Pro', trial: pick(lang, '체험', 'trial'), free: pick(lang, '무료', 'free') }[plan] ?? plan : pick(lang, '이 기기에서 확인한 값이 없다(설정 → 일반의 요금제 표시를 보라고 안내)', 'not known on this device (point the user to the plan shown in Settings → General)')}`,
    row(pick(lang, '오늘', 'Today'), u?.today),
    row(pick(lang, '이번 달', 'This month'), u?.month),
    `- ${pick(lang, '월 지출 한도', 'Monthly spending limit')}: ${company.budgetUsd > 0 ? usd(company.budgetUsd) : pick(lang, '없음', 'none')}`,
    pick(lang, '구독(OAuth)으로 연결한 러너의 턴은 돈이 따로 나가지 않는다. 금액은 API 키로 연결한 러너 턴만 센다.', 'Turns on subscription-connected runners cost nothing extra; amounts count only API-key runner turns.'),
  ].filter(Boolean).join('\n');
}

const RUNTIME_TEXT = {
  alive: ['정상 응답 중', 'responding normally'],
  waiting: ['아직 첫 응답을 기다리는 중', 'waiting for the first response'],
  offline: ['응답을 확인하지 못함 — 자동 복구 시도 중', 'not responding — automatic recovery in progress'],
  login: ['이 기기의 Argo 로그인이 필요', 'this device needs an Argo login'],
  owner: ['이 회사를 만든 계정으로 로그인해야 응답', 'sign in with the account that created this company'],
  company: ['회사 설정을 읽지 못해 시작하지 못함', "couldn't read company settings"],
};

async function messengerSection(wsId, { lang, now }) {
  const [{ msgrGatewayStatus, msgrRuntimeState, gatewayStatus, loadConnections }, { notifyChannelState }, { loadDeviceSession, deviceSessionDead }, company] = await Promise.all([
    import('./connections.mjs'), import('./msgr-notify.mjs'), import('./devicesession.mjs'), loadCompany(wsId).catch(() => ({}))]);
  const L = ko(lang) ? 0 : 1;
  const rt = msgrRuntimeState(await msgrGatewayStatus(wsId));
  const gw = await gatewayStatus(wsId).catch(() => null);
  const conns = await loadConnections(wsId).catch(() => ({}));
  const signedIn = !!loadDeviceSession()?.user?.id && !deviceSessionDead(); // 기기 세션 파일만 본다(토큰 갱신·네트워크 0)
  const ch = notifyChannelState({ connections: conns, company, signedIn });
  const onOff = (x) => (x.on ? pick(lang, '받음', 'on') : x.connected ? pick(lang, '안 받음', 'off') : pick(lang, '연결 안 됨', 'not connected'));
  const alive = (g) => (g?.alive ? pick(lang, '가동 중', 'running') : g?.holder === 'other' ? pick(lang, `다른 기기${g.holderDevice ? `(${g.holderDevice})` : ''}에서 수신 중`, `receiving on another device${g.holderDevice ? ` (${g.holderDevice})` : ''}`) : pick(lang, '수신 안 함', 'not receiving'));
  return [
    pick(lang, '메신저·알림 연결(설정 → 연결과 같은 판정 — 토큰·방 id는 싣지 않는다)', 'Messenger and notification connections (same as Settings → Connections — no tokens or room ids)'),
    `- ${pick(lang, 'Argo 메신저 응답 상태', 'Argo Messenger response status')}: ${RUNTIME_TEXT[rt.state]?.[L] ?? rt.state}${rt.lastTs ? ` · ${ago(rt.lastTs, now, lang)} ${pick(lang, '확인', 'checked')}` : ''} · ${pick(lang, '에이전트 연결', 'agents connected')}: ${company.msgr?.enabled ? pick(lang, '예', 'yes') : pick(lang, '아니오', 'no')}`,
    `- ${pick(lang, '텔레그램', 'Telegram')}: ${conns.telegram?.enabled && conns.telegram?.token ? pick(lang, '연결됨', 'connected') : pick(lang, '연결 안 됨', 'not connected')}${conns.telegram?.enabled ? ` · ${alive(gw?.telegram)}` : ''}`,
    `- ${pick(lang, '슬랙', 'Slack')}: ${conns.slack?.enabled && conns.slack?.token ? pick(lang, '연결됨', 'connected') : pick(lang, '연결 안 됨', 'not connected')}${conns.slack?.enabled ? ` · ${alive(gw?.slack)}` : ''}`,
    `- ${pick(lang, '알림 받을 메신저', 'Where notifications go')}: ${pick(lang, '아르고 메신저', 'Argo Messenger')} ${onOff(ch.msgr)} · ${pick(lang, '텔레그램', 'Telegram')} ${onOff(ch.telegram)} · ${pick(lang, '슬랙', 'Slack')} ${onOff(ch.slack)}`,
  ].join('\n');
}

/** 상태 읽기(도구 처리기 본체) — 반환 문자열. guest(주인이 아닌 사람이 시킨 턴)는 주인의 상태를 보지 않는다. */
export async function argoStatus(wsId, { section = 'overview', slug = null, lang = 'ko', full = false, now = Date.now() } = {}) {
  // full = 주인 1:1(runChat의 settingsDirect — 서버 판정). 아니면 주인의 상태를 하나도 읽지 않는다(손님·채널·회의실·루틴·위임 전부)
  if (!full) return pick(lang, '아르고 상태(데크 숫자·에이전트·루틴·비서·러너·동기화·요금제·메신저 연결·결재)는 주인의 1:1에서만 보여 준다 — 이 대화는 주인의 1:1이 아니다(다른 사람이 보는 방이거나, 루틴·위임으로 온 턴). 상태를 말하지 말고, 필요하면 주인에게 1:1에서 물어보라고 안내하라. 기능 설명은 argo_help로 할 수 있다.',
    "Argo status (Deck numbers, agents, routines, assistant, runners, sync, plan, messenger connections, approvals) is shared only in the owner's 1:1 — this conversation is not (others may see this room, or it came from a routine or delegation). Don't state any of it; suggest asking in the owner's 1:1 if needed. Feature explanations are available via argo_help.");
  const sec = STATUS_SECTIONS.includes(section) ? section : 'overview';
  const opts = { lang, slug, now };
  const safe = async (fn, name) => { try { return await fn(); } catch (e) { return pick(lang, `${name}: 읽지 못했다(${String(e?.message ?? e).slice(0, 120)}) — 추측하지 말고 읽지 못했다고 말하라.`, `${name}: could not read (${String(e?.message ?? e).slice(0, 120)}) — say so instead of guessing.`); } };
  const table = {
    deck: () => deckSection(wsId, opts),
    agents: () => agentsSection(wsId, opts),
    me: () => meSection(wsId, opts),
    routines: () => routinesSection(wsId, opts),
    assistant: () => assistantSection(wsId, opts),
    approvals: () => approvalsSection(wsId, opts),
    runners: () => runnersSection(wsId, opts),
    sync: () => syncSection(wsId, opts),
    plan: () => planSection(wsId, opts),
    messenger: () => messengerSection(wsId, opts),
  };
  if (sec !== 'overview') return safe(table[sec], sec);
  const parts = await Promise.all(['me', 'deck', 'assistant'].map((k) => safe(table[k], k)));
  return [...parts, pick(lang, `더 볼 수 있는 구획: ${STATUS_SECTIONS.filter((s) => s !== 'overview').join(', ')} — argo_status section=<이름>`, `More sections: ${STATUS_SECTIONS.filter((s) => s !== 'overview').join(', ')} — argo_status section=<name>`)].join('\n\n');
}

