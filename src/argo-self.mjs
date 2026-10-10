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
import { readAgentCard, updateAgentMeta, cardRules, setAgentRules } from './persona.mjs';
import { effortLevels } from './model-effort.mjs';
import { recentSelfPosts, selfKindLabel } from './self-posts.mjs';
import { deckMetrics } from './deck-metrics.mjs';
import { createHash } from 'node:crypto';
import { loadRoutines, updateRoutine, removeRoutine } from './routines.mjs';
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

const ASSIST_WHERE = { ko: '에이전트 카드 → 하트비트 탭', en: 'Agent card → Heartbeat tab' };

/** 에이전트가 바꿀 수 있는 설정(허용 목록). read(view) = 지금 값(비서 설정 화면 값), write(value, {agent}) = saveAssistantSettings 입력. 값 검증은 normalizeSettingValue + 저장 함수의 화면 규칙. */
export const SETTINGS = Object.freeze([
  {
    key: 'assistant.morning', type: 'time',
    label: { ko: '하트비트 아침 정리 시각(= 조용한 시간 끝)', en: 'Heartbeat morning summary time (= quiet hours end)' },
    where: { ko: `${ASSIST_WHERE.ko} → 조용한 시간 끝`, en: `${ASSIST_WHERE.en} → Quiet hours end` },
    read: (v) => v.config.quiet.to,
    write: (value) => ({ quiet: { to: value } }),
  },
  {
    key: 'assistant.evening', type: 'time',
    label: { ko: '하트비트 내일 일정 요약 시각', en: "Heartbeat tomorrow's summary time" },
    where: { ko: `${ASSIST_WHERE.ko} → 내일 일정 요약`, en: `${ASSIST_WHERE.en} → Tomorrow's summary` },
    read: (v) => v.config.eveningAt,
    write: (value) => ({ eveningAt: value }),
  },
  {
    key: 'assistant.quietFrom', type: 'time',
    label: { ko: '하트비트 조용한 시간 시작', en: 'Heartbeat quiet hours start' },
    where: { ko: `${ASSIST_WHERE.ko} → 조용한 시간 시작`, en: `${ASSIST_WHERE.en} → Quiet hours start` },
    read: (v) => v.config.quiet.from,
    write: (value) => ({ quiet: { from: value } }),
  },
  {
    key: 'assistant.lead', type: 'choice', choices: [...LEAD_CHOICES],
    label: { ko: '하트비트 일정 알림(몇 분 전)', en: 'Heartbeat event reminder (minutes before)' },
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
    label: { ko: '하트비트(예전 이름 비서) 켜기·끄기', en: 'Heartbeat (formerly Assistant) on/off' },
    where: { ko: `${ASSIST_WHERE.ko} → 하트비트 켜기 / 하트비트 끄기`, en: `${ASSIST_WHERE.en} → Turn on / Turn off heartbeat` },
    read: (v) => v.config.enabled,
    // 켤 때 에이전트 — 지정해 둔 비서가 있으면 그 에이전트, 없으면 이 도구를 부른 에이전트(write의 두 번째 인자)
    write: (value, { agent }) => (value ? { enabled: true, agent } : { enabled: false }),
    ownerOnly: true, // 켜면 같은 계정의 다른 회사 비서가 꺼진다(계정마다 한 명) — 주인 1:1에서만, 결재 카드로도 올리지 않는다(카드는 채널에 보일 수 있어 다른 회사 사정을 적을 수 없다)
  },
  {
    key: 'assistant.agent', type: 'agent',
    label: { ko: '하트비트 에이전트(어느 에이전트가 맡는가)', en: 'Heartbeat agent (which agent runs it)' },
    where: { ko: `${ASSIST_WHERE.ko} → 이 에이전트로 바꾸기`, en: `${ASSIST_WHERE.en} → Use this agent instead` },
    read: (v) => v.config.agent ?? '',
    // 바꾸기만 — 꺼진 비서를 켜지 않는다(켜기는 assistant.enabled로만, applySetting이 꺼짐이면 거절). 저장 함수가 에이전트 교체를 enabled:true로만 받아 켜진 상태에서만 부른다
    write: (value) => ({ enabled: true, agent: value }),
    ownerOnly: true, // 교체도 "지금 비서"를 이 회사로 다시 정한다 — 위와 같은 이유로 주인 1:1에서만
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
  // ── 내 에이전트 카드(자기 카드만 — 동료 카드·이름·팀은 update_profile 결재) ──
  // 저장은 카드 화면과 같은 함수(updateAgentMeta·setAgentRules), 러너·모델·강도 검증은 카드 화면의 선택지 규칙과 같다(prepareSetting).
  {
    key: 'agent.role', type: 'text', max: 80, card: true,
    label: { ko: '내 역할(직함)', en: 'My role (title)' },
    where: { ko: '에이전트 카드 → 정보 수정 → 역할', en: 'Agent card → Edit info → Role' },
  },
  {
    key: 'agent.runner', type: 'runner', card: true,
    label: { ko: '내 러너', en: 'My runner' },
    where: { ko: '에이전트 카드 → 개요 → 엔진(러너)', en: 'Agent card → Overview → Engine (runner)' },
  },
  {
    key: 'agent.model', type: 'model', card: true,
    label: { ko: '내 모델', en: 'My model' },
    where: { ko: '에이전트 카드 → 개요 → 엔진(모델)', en: 'Agent card → Overview → Engine (model)' },
  },
  {
    key: 'agent.effort', type: 'effort', card: true,
    label: { ko: '내 추론 강도', en: 'My reasoning effort' },
    where: { ko: '에이전트 카드 → 개요 → 엔진 → 추론 강도', en: 'Agent card → Overview → Engine → Effort' },
  },
  // 지시문(일하는 방식 규칙)은 다음 턴부터 늘 실리는 지시다 — 턴 안에서 읽은 웹·메일 글이 오래 남는 지시를 바꾸지 못하게 주인 1:1에서도 결재 카드(바뀌기 전·후 규칙을 카드에 싣는다)
  {
    key: 'agent.rules.add', type: 'text', max: 200, card: true, approvalAlways: true,
    label: { ko: '일하는 방식 규칙 추가', en: 'Add a working rule' },
    where: { ko: '에이전트 카드 → 방식 → 일하는 방식', en: 'Agent card → Working style → Working rules' },
  },
  {
    key: 'agent.rules.remove', type: 'ruleRef', card: true, approvalAlways: true,
    label: { ko: '일하는 방식 규칙 삭제', en: 'Remove a working rule' },
    where: { ko: '에이전트 카드 → 방식 → 일하는 방식', en: 'Agent card → Working style → Working rules' },
  },
  // ── 루틴 고치기(이 회사 루틴 — 만들기는 schedule_task, 지우기는 cancel_routine) ──
  {
    key: 'routine.title', type: 'text', max: 80, needsId: true,
    label: { ko: '루틴 제목', en: 'Routine title' },
    where: { ko: '루틴 화면 → 그 루틴 편집 → 제목', en: 'Routines → edit the routine → Title' },
  },
  {
    // 오래 남아 자동으로 실행되는 지시라 지시문 규칙과 같이 주인 1:1에서도 결재 카드. 결재 카드 사유 칸에 새 글 전체가 보이는 길이(380자)까지만 — 더 긴 내용은 루틴 화면에서
    key: 'routine.prompt', type: 'text', max: 380, needsId: true, approvalAlways: true,
    label: { ko: '루틴 내용(매번 할 일)', en: 'Routine instruction (what to do each run)' },
    where: { ko: '루틴 화면 → 그 루틴 편집 → 내용', en: 'Routines → edit the routine → Instruction' },
  },
  {
    key: 'routine.days', type: 'days', needsId: true,
    label: { ko: '루틴 요일(매주 루틴)', en: 'Routine weekdays (weekly routines)' },
    where: { ko: '루틴 화면 → 그 루틴 편집 → 요일', en: 'Routines → edit the routine → Days' },
  },
  {
    key: 'routine.interval', type: 'interval', needsId: true,
    label: { ko: '루틴 간격(N분마다 도는 루틴, 10~1440분)', en: 'Routine interval (every-N-minutes routines, 10–1440)' },
    where: { ko: '루틴 화면 → 그 루틴 편집 → 간격', en: 'Routines → edit the routine → Interval' },
  },
  {
    key: 'routine.enabled', type: 'bool', needsId: true,
    label: { ko: '루틴 켜기·끄기', en: 'Routine on/off' },
    where: { ko: '루틴 화면 → 그 루틴 → 켜기/끄기', en: 'Routines → the routine → On/Off' },
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
  { keys: ['assistant.watch', 'assistant.watch.mail', 'assistant.watch.tasks', 'assistant.watch.deals', 'assistant.mail', 'agent.skills', 'agent.mcp', 'agent.scope', 'sharing', 'permission', 'org.member', 'visibility'], why: { ko: '권한·공유 범위(무엇을 읽게 할지, 누구와 나눌지)', en: 'permissions and sharing scope' }, where: { ko: '해당 설정 화면', en: 'the matching settings screen' } },
]);

const lower = (s) => String(s ?? '').trim().toLowerCase();
const settingOf = (key) => SETTINGS.find((s) => lower(s.key) === lower(key)) ?? null;
const forbiddenOf = (key) => FORBIDDEN_SETTINGS.find((f) => f.keys.some((k) => lower(k) === lower(key) || lower(key).startsWith(`${lower(k)}.`))) ?? null;

/** 설정 변경 판정(순수) — 'apply'(바로) | 'approval'(결재 카드) | 'forbidden'(거절) | 'unknown'(없는 키). */
export function settingPolicy({ key, direct = false, guest = false } = {}) {
  if (forbiddenOf(key)) return 'forbidden';
  const def = settingOf(key);
  if (!def) return 'unknown';
  if (def.approvalAlways) return 'approval'; // 지시문 규칙 — 주인 1:1에서도 결재
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
  if (def.type === 'text') {
    const s = String(raw ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!s) return { error: pick(lang, '값이 비어 있다', 'Value is empty') };
    if (/[\x00-\x1f\x7f\u2028\u2029\u202a-\u202e\u2066-\u2069]/.test(s)) return { error: pick(lang, '쓸 수 없는 글자(제어·방향 문자)가 있다', 'Contains control or bidi characters') }; // 카드 문구 조작 방어
    return s.length <= (def.max ?? 200) ? { value: s } : { error: pick(lang, `${def.max}자 이내로 적어라(지금 ${s.length}자)`, `Keep it within ${def.max} characters (now ${s.length})`) };
  }
  if (def.type === 'runner') {
    const s = lower(raw);
    if (['', 'auto', '자동', 'default', '기본'].includes(s)) return { value: '' };
    return /^[a-z0-9_-]{1,30}$/.test(s) ? { value: s } : { error: pick(lang, '러너 id를 적어라(argo_status section=runners의 [ ] 안 값) — 자동이면 auto', 'Give a runner id (the value in [ ] from argo_status section=runners), or auto') };
  }
  if (def.type === 'model') {
    const s = String(raw ?? '').trim();
    return /^[A-Za-z0-9._:/\[\]-]{1,100}$/.test(s) ? { value: s } : { error: pick(lang, '모델 id를 적어라(argo_settings action=list의 모델 목록)', 'Give a model id (see argo_settings action=list)') };
  }
  if (def.type === 'effort') {
    const s = lower(raw);
    if (['', 'default', '기본', 'auto'].includes(s)) return { value: '' };
    return /^[a-z]{1,10}$/.test(s) ? { value: s } : { error: pick(lang, '강도 id를 적어라(low·medium·high·xhigh·max 등) — 기본이면 default', 'Give an effort id (low, medium, high, xhigh, max…), or default') };
  }
  if (def.type === 'ruleRef') {
    const s = String(raw ?? '').replace(/\s+/g, ' ').trim();
    return s && s.length <= 2000 ? { value: s } : { error: pick(lang, '지울 규칙의 번호(argo_status section=me) 또는 규칙 문장을 적어라', 'Give the rule number (argo_status section=me) or its exact text') }; // 화면에서 더한 긴 규칙도 번호로 지울 수 있게(카드 문구는 showSetting이 줄인다)
  }
  if (def.type === 'days') {
    const names = { 일: 0, 월: 1, 화: 2, 수: 3, 목: 4, 금: 5, 토: 6, sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
    const parts = String(raw ?? '').toLowerCase().split(/[\s,·/]+/).map((x) => x.replace(/요일$/, '').trim()).filter(Boolean);
    const out = parts.map((x) => (/^[0-6]$/.test(x) ? Number(x) : names[x.slice(0, x.length > 1 && /^[a-z]/.test(x) ? 3 : 1)]));
    if (!parts.length || out.some((d) => d === undefined)) return { error: pick(lang, '요일을 0(일)~6(토) 숫자나 월·수·금처럼 적어라', 'Use 0 (Sun)–6 (Sat) or names like mon,wed,fri') };
    return { value: [...new Set(out)].sort((a, b) => a - b).join(',') };
  }
  if (def.type === 'interval') {
    const n = Number(String(raw ?? '').replace(/분|min(utes)?/gi, '').trim());
    return Number.isInteger(n) && n >= 10 && n <= 1440 ? { value: n } : { error: pick(lang, '간격은 10~1440분 사이 정수다', 'Interval must be a whole number of minutes, 10–1440') };
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
const DAY_NAMES = { ko: ['일', '월', '화', '수', '목', '금', '토'], en: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] };
const clip = (v, n) => { const t = String(v ?? ''); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
/** 설정 종류에 맞춘 값 표시(순수) — 요일은 이름, 자동·기본은 말로, 긴 글은 줄여서. 결재 카드 문구에도 쓴다(승인 때 같은 함수로 다시 만들어 대조). */
function showSetting(def, v, lang) {
  if (def?.type === 'days' && typeof v === 'string' && v) return v.split(',').map((d) => DAY_NAMES[ko(lang) ? 'ko' : 'en'][Number(d)] ?? d).join(ko(lang) ? '·' : '/');
  if (def?.type === 'runner' && v === '') return pick(lang, '자동 — 첫 연결 러너', 'Auto — first connected runner');
  if (def?.type === 'effort' && v === '') return pick(lang, '강도 기본', 'Default effort');
  if (def?.type === 'interval' && v !== '' && v != null) return pick(lang, `${v}분마다`, `every ${v} min`);
  if ((def?.type === 'text' && (def.max ?? 0) > 200) || def?.type === 'ruleRef') return `"${clip(v, 120)}"`; // 결재 카드 문구 300자 안에 들게
  return showVal(v, lang);
}

/** 결재 카드 문구(순수) — 승인 때 payload와 다시 맞춰 보는 기준(카드에 보인 것 = 실제로 바뀌는 것). */
export function settingActionText({ key, id = null, value, model, index, o1 }, lang = 'ko') {
  const def = settingOf(key);
  const label = def ? def.label[ko(lang) ? 'ko' : 'en'] : key;
  const extra = (def?.type === 'runner' && model !== undefined ? pick(lang, ` (모델 ${model || '—'})`, ` (model ${model || '—'})`) : '') // 러너를 바꾸면 화면처럼 그 러너의 첫 모델로 — 카드에 같이 보인다
    + (o1 ? pick(lang, ' · 주인 1:1에서 요청', " · requested in the owner's 1:1") : '');
  const shown = index ? pick(lang, `규칙 ${index}번`, `rule #${index}`) : showSetting(def, value, lang); // 남이 보는 방의 규칙 삭제는 번호만
  return pick(lang, `설정 변경 — ${label}${id ? ` [${id}]` : ''} → ${shown}${extra}`, `Change setting — ${label}${id ? ` [${id}]` : ''} → ${shown}${extra}`);
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
  if (def.card) {
    let card;
    try { card = await readAgentCard(wsId, id); } catch { return { error: pick(lang, '내 에이전트 카드를 읽지 못했다.', "Couldn't read my agent card.") }; }
    const m = card.meta ?? {};
    const rules = cardRules(card.md);
    const v = { 'agent.role': m.role ?? '', 'agent.runner': m.runner ?? '', 'agent.model': m.model ?? '', 'agent.effort': m.effort ?? '' }[def.key];
    return { value: def.key.startsWith('agent.rules.') ? rules : v, meta: m, rules };
  }
  if (def.key.startsWith('routine.')) {
    const r = (await loadRoutines(wsId)).find((x) => x.id === id);
    if (!r) return { error: pick(lang, `그런 루틴이 없다: ${id ?? '(id 없음)'}. argo_status section=routines로 id를 확인하라.`, `No routine with id ${id ?? '(none)'}. Check ids with argo_status section=routines.`) };
    const sc = r.schedule ?? {};
    if (def.key === 'routine.days' && sc.type !== 'weekly') return { error: pick(lang, '매주 루틴이 아니라 요일이 없다 — 주기는 루틴 화면에서 바꾼다.', 'Not a weekly routine, so it has no weekdays — change the cycle on the Routines screen.') };
    if (def.key === 'routine.interval' && sc.type !== 'interval') return { error: pick(lang, 'N분마다 도는 루틴이 아니라 간격이 없다 — 주기는 루틴 화면에서 바꾼다.', 'Not an every-N-minutes routine, so it has no interval — change the cycle on the Routines screen.') };
    const value = { 'routine.title': r.title ?? '', 'routine.prompt': r.prompt ?? '', 'routine.days': (sc.dows ?? [sc.dow ?? 1]).slice().sort((a, b) => a - b).join(','), 'routine.interval': sc.everyMinutes, 'routine.enabled': r.enabled !== false }[def.key];
    return { value, routine: r };
  }
  return { error: 'unsupported' };
}

/**
 * 바꾸기 전 준비(바로 바꾸기·결재 공용) — 화면과 같은 선택지 규칙으로 값을 확정한다. { value, extra } | { error }.
 *  - 러너: 숨김 러너는 새로 못 고르고(지금 값이면 그대로), 연결(유효)된 러너만 — 카드 화면 선택지(authed)와 같다. 바꾸면 그 러너의 첫 모델(화면 동작).
 *  - 모델: 러너가 자동이면 고를 수 없다(화면도 모델 칸이 비어 있다). 그 러너의 모델 목록(id·이름)에서만.
 *  - 강도: 화면에 강도 칸이 보이는 러너(자동·claude·codex)만, 그 러너·모델의 단계(effortLevels)만.
 *  - 규칙: 지금 규칙 목록(before)과 바뀐 뒤 목록(after)을 같이 싣는다 — 결재 카드에 보이고, 승인 때 그 사이 규칙이 바뀌었으면 적용하지 않는다.
 */
async function prepareSetting(wsId, def, value, { id = null, lang = 'ko', full = true } = {}) { // full=false — 주인 1:1이 아닌 턴의 결재 올리기: 연결·목록 대조는 승인 때(성공/실패 차이로 주인 상태가 그 방에 새지 않게)
  if (!def.card && !def.key.startsWith('routine.')) return { value };
  const cur = await currentValue(wsId, def, { id, lang });
  if (cur.error) return { error: cur.error };
  if (def.key === 'agent.runner' || def.key === 'agent.model') {
    const [{ RUNNERS, runnerStatus, isHiddenRunner }, { effectiveModels, loadRemoteCatalog }] = await Promise.all([import('./runners.mjs'), import('./runners/catalog-remote.mjs')]);
    await loadRemoteCatalog({ timeoutMs: 2000 }).catch(() => null); // 카드 화면 목록(app/api/runners)과 같은 원격 오버레이 — TTL 캐시라 대개 호출 0
    const runner = def.key === 'agent.runner' ? value : String(cur.meta.runner ?? '');
    if (!full && def.key === 'agent.model') return { value };
    if (!full) return Object.hasOwn(RUNNERS, runner) && !isHiddenRunner(runner) ? { value: runner, extra: { model: effectiveModels(runner)[0]?.id ?? '' } } : { error: 'runner' };
    if (def.key === 'agent.model' && !runner) return { error: pick(lang, '러너가 자동이라 모델을 고를 수 없다(카드 화면도 같다) — agent.runner로 러너를 먼저 정하라.', 'The runner is Auto, so a model cannot be picked (same on the card screen) — set agent.runner first.') };
    if (!runner) return { value: '', extra: { model: '' } };
    if (!Object.hasOwn(RUNNERS, runner)) return { error: pick(lang, `없는 러너: ${runner}. 가능한 값: ${Object.keys(RUNNERS).filter((r) => !isHiddenRunner(r)).join(', ')}, auto`, `Unknown runner: ${runner}. Options: ${Object.keys(RUNNERS).filter((r) => !isHiddenRunner(r)).join(', ')}, auto`) };
    if (isHiddenRunner(runner) && runner !== cur.meta.runner) return { error: pick(lang, `${RUNNERS[runner].name} 러너는 새로 고를 수 없다.`, `${RUNNERS[runner].name} can no longer be chosen.`) };
    const st = (await runnerStatus(wsId, { forPick: true }).catch(() => ({})))?.[runner]?.company ?? {};
    if (!st.connected || st.invalid) return { error: pick(lang, `${RUNNERS[runner].name} 러너가 연결돼 있지 않다(또는 재연결 필요) — 사용자에게 설정 → AI 연결에서 연결해 달라고 안내하라.`, `${RUNNERS[runner].name} isn't connected (or needs reconnecting) — ask the user to connect it in Settings → AI connection.`) };
    const models = effectiveModels(runner);
    if (def.key === 'agent.runner') return { value: runner, extra: { model: models[0]?.id ?? '' } };
    const hit = models.find((m) => m.id === value) ?? models.find((m) => lower(m.label) === lower(value));
    if (!hit) return { error: pick(lang, `${RUNNERS[runner].name} 러너의 모델이 아니다: ${value}. 고를 수 있는 모델: ${models.map((m) => m.id).join(', ')} (다른 러너 모델이면 agent.runner를 먼저 바꿔라)`, `Not a ${RUNNERS[runner].name} model: ${value}. Options: ${models.map((m) => m.id).join(', ')} (for another runner's model, change agent.runner first)`) };
    return { value: hit.id };
  }
  if (def.key === 'agent.effort') {
    if (!full) return ['', ...effortLevels('codex', 'gpt-6-sol')].includes(value) ? { value } : { error: 'effort' }; // 형식만 — 이 러너·모델이 받는지는 승인 때
    const runner = String(cur.meta.runner ?? '');
    if (runner && runner !== 'claude' && runner !== 'codex') return { error: pick(lang, '이 러너는 추론 강도를 고르지 않는다(카드 화면에도 칸이 없다).', "This runner has no effort setting (the card screen doesn't show one either).") };
    const levels = effortLevels(runner, cur.meta.model);
    return value === '' || levels.includes(value) ? { value } : { error: pick(lang, `가능한 강도: ${levels.join(', ')}, default`, `Allowed effort: ${levels.join(', ')}, default`) };
  }
  if (def.key === 'agent.rules.add') {
    if (cur.rules.includes(value)) return { error: pick(lang, '이미 있는 규칙이다.', 'That rule already exists.') };
    return { value, extra: { before: cur.rules, after: [...cur.rules, value] } };
  }
  if (def.key === 'agent.rules.remove') {
    // 주인 1:1이 아니면 번호로만 받고 규칙 원문을 읽어 싣지 않는다 — 승인 때 그때의 규칙에서 그 번호 문장을 확정한다(applyCardSetting)
    // h = 올린 때 그 번호 문장의 대조값(원문 아님) — 승인 전에 규칙 순서가 바뀌면 엉뚱한 규칙을 지우지 않게(재검수 2차 M)
    if (!full) return /^\d{1,3}$/.test(value) && Number(value) >= 1 ? { value: String(Number(value)), extra: { index: Number(value), h: ruleHash(cur.rules[Number(value) - 1]) } } : { error: 'rule-number' };
    const i = /^\d+$/.test(value) ? Number(value) - 1 : cur.rules.indexOf(value);
    if (!(i >= 0 && i < cur.rules.length)) return { error: pick(lang, `그런 규칙이 없다. 지금 규칙: ${cur.rules.map((r, n) => `${n + 1}) ${clip(r, 60)}`).join(' / ') || '(없음)'}`, `No such rule. Current rules: ${cur.rules.map((r, n) => `${n + 1}) ${clip(r, 60)}`).join(' / ') || '(none)'}`) };
    return { value: cur.rules[i], extra: { before: cur.rules, after: cur.rules.filter((_, n) => n !== i) } };
  }
  return { value };
}

/** 규칙 결재 카드의 바뀌기 전·후(순수) — 사유 칸에 싣는다(500자 안에서 규칙마다 줄여서). */
export function rulesDiffText(before = [], after = [], lang = 'ko') {
  const list = (xs) => (xs.length ? xs.map((r, n) => `${n + 1}) ${clip(r, 60)}`).join(' ') : pick(lang, '(없음)', '(none)'));
  return pick(lang, `바뀌기 전 ${before.length}개: ${list(before)} → 바뀐 뒤 ${after.length}개: ${list(after)}`, `Before (${before.length}): ${list(before)} → After (${after.length}): ${list(after)}`);
}

/**
 * 설정 적용(바로 바꾸기·결재 승인 공용) — { ok, before, after, text } | { ok:false, text }.
 * slug = 이 도구를 부른 에이전트(비서를 켤 때 지정된 비서가 없으면 이 에이전트).
 */
export async function applySetting(wsId, { key, id = null, value, model, before: rulesBefore, after: rulesAfter, index, h, from = null }, { slug = null, lang = 'ko' } = {}) {
  const def = settingOf(key);
  if (!def || forbiddenOf(key)) return { ok: false, text: pick(lang, `바꿀 수 없는 설정: ${key}`, `Not a changeable setting: ${key}`) };
  const norm = normalizeSettingValue(def, value, lang);
  if (norm.error) return { ok: false, text: norm.error };
  if (def.card) {
    const r = await applyCardSetting(wsId, def, { slug: id ?? slug, value: norm.value, model, rulesBefore, rulesAfter, index, h, lang });
    return r;
  }
  const cur = await currentValue(wsId, def, { id, lang });
  if (cur.error) return { ok: false, text: cur.error };
  if (def.key.startsWith('routine.') && def.key !== 'routine.time') return applyRoutineSetting(wsId, def, { cur, value: norm.value, slug, lang, from });
  const before = cur.value;
  if (before === norm.value) return { ok: true, before, after: before, unchanged: true, text: pick(lang, `이미 ${showVal(before, lang)}(으)로 되어 있다 — 바꾸지 않았다(${def.label.ko}).`, `Already ${showVal(before, lang)} — nothing changed (${def.label.en}).`) };
  if (def.key.startsWith('assistant.')) {
    const agent = def.key === 'assistant.agent' ? norm.value : (cur.view.config.agent ?? slug);
    if (def.key === 'assistant.agent' && !(await scanAgents(wsId)).agents.some((a) => a.slug === agent)) {
      return { ok: false, text: pick(lang, `이 회사에 없는 에이전트: ${agent}`, `No such agent in this company: ${agent}`) };
    }
    if (def.key === 'assistant.agent' && !cur.view.config.enabled) {
      return { ok: false, text: pick(lang, '이 회사 하트비트가 꺼져 있어 에이전트만 바꾸지 않았다 — 켜려면 assistant.enabled를 true로(하트비트를 켜는 일이라 따로 확인받는다).', "This company's heartbeat is off, so the agent was not changed — to turn it on use assistant.enabled=true (a separate step).") };
    }
    let res;
    try { res = await saveAssistantSettings(wsId, def.write(norm.value, { agent })); }
    catch (e) { return { ok: false, text: assistantErrorText(e, lang), raw: !ASSIST_ERR_CODES.has(e?.code) }; }
    const after = def.read(await assistantSettingsView(wsId));
    const offNames = await Promise.all((res?.changedOthers ?? []).map((id) => loadCompany(id).then((c) => c?.name ?? id, () => id)));
    const offText = offNames.length ? pick(lang, ` 하트비트는 계정마다 한 곳에서만 켜져서 다른 회사(${offNames.join(', ')})의 하트비트는 꺼졌다 — 사용자에게 이것도 알려라.`, ` Heartbeat runs in one place per account, so the heartbeat in ${offNames.join(', ')} was turned off — tell the user this too.`) : '';
    return { ok: true, before, after, offCompanies: res?.changedOthers ?? [], text: `${changedText(def, before, after, lang)}${offText}` };
  }
  if (def.key === 'routine.time') {
    const r = cur.routine;
    const sc = r.schedule ?? {};
    try { await updateRoutine(wsId, r.id, { schedule: { ...sc, time: norm.value, times: [norm.value] } }); }
    catch (e) { return { ok: false, text: pick(lang, `바꾸지 못했다: ${String(e?.message ?? e).slice(0, 160)}`, `Not changed: ${String(e?.message ?? e).slice(0, 160)}`), raw: true }; }
    return { ok: true, before, after: norm.value, text: changedText(def, before, norm.value, lang, r.title) };
  }
  if (def.key === 'company.lang') {
    const { updateCompany } = await import('./workspace.mjs');
    try { await updateCompany(wsId, { lang: norm.value }); }
    catch (e) { return { ok: false, text: pick(lang, `바꾸지 못했다: ${String(e?.message ?? e).slice(0, 160)}`, `Not changed: ${String(e?.message ?? e).slice(0, 160)}`), raw: true }; }
    return { ok: true, before, after: norm.value, text: changedText(def, before, norm.value, lang) };
  }
  return { ok: false, text: 'unsupported' };
}

const sameList = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]);

/** 내 카드 설정 적용 — 카드 화면과 같은 저장 함수. 규칙은 결재 때 본 before가 지금 규칙과 같을 때만 after로 바꾼다(그 사이 바뀌었으면 적용 안 함). */
const ruleHash = (s) => (s == null ? '' : createHash('sha256').update(String(s)).digest('hex').slice(0, 16));
async function applyCardSetting(wsId, def, { slug, value, model, rulesBefore, rulesAfter, index, h, lang }) {
  if (def.key === 'agent.rules.remove' && index) { // 번호로 올린 규칙 삭제 — 승인 때의 규칙에서 그 번호를 확정(번호가 범위 밖이면 적용 안 함)
    const cur = await currentValue(wsId, def, { id: slug, lang });
    if (cur.error) return { ok: false, text: cur.error, raw: true };
    const i = Number(index) - 1;
    if (!Number.isInteger(i) || i < 0 || i >= cur.rules.length || String(Number(index)) !== String(value)) return { ok: false, text: pick(lang, `승인할 때 규칙 ${index}번이 없어 적용하지 않았다.`, `Not applied — there was no rule #${index} at approval time.`) };
    if (!h || ruleHash(cur.rules[i]) !== h) return { ok: false, text: pick(lang, `규칙이 바뀌어 적용하지 않았다 — 지금 규칙 ${index}번은 올린 때의 그 규칙이 아니다.`, `Not applied — the rules changed; rule #${index} is no longer the one requested.`) };
    const after = cur.rules.filter((_, n) => n !== i);
    try { await setAgentRules(wsId, slug, after); }
    catch (e) { return { ok: false, text: pick(lang, '바꾸지 못했다.', 'Not changed.'), raw: true, err: e }; }
    return { ok: true, before: cur.rules, after, text: pick(lang, `바꿨다 — 규칙 ${index}번을 지웠다.`, `Changed — removed rule #${index}.`) };
  }
  // raw — 준비 오류(지금 규칙·연결 상태·모델 목록이 든 글)는 결재 후속 보고(원래 방으로 간다)에 싣지 않는다(appliedNote). 바로 바꾸기에서는 그대로 보인다
  const prep = await prepareSetting(wsId, def, value, { id: slug, lang });
  if (prep.error) return { ok: false, text: prep.error, raw: true };
  const cur = await currentValue(wsId, def, { id: slug, lang });
  if (cur.error) return { ok: false, text: cur.error, raw: true };
  if (def.key.startsWith('agent.rules.')) {
    if (!sameList(cur.rules, rulesBefore) || !sameList(prep.extra?.after, rulesAfter)) return { ok: false, text: pick(lang, '결재를 올린 뒤 규칙이 바뀌어 적용하지 않았다 — 지금 규칙으로 다시 올려라.', 'The rules changed after the approval was filed, so it was not applied — file it again from the current rules.') };
    try { await setAgentRules(wsId, slug, rulesAfter); }
    catch (e) { return { ok: false, text: pick(lang, '바꾸지 못했다.', 'Not changed.'), raw: true, err: e }; }
    return { ok: true, before: cur.rules, after: rulesAfter, text: pick(lang, `바꿨다 — ${def.label.ko}: ${rulesDiffText(cur.rules, rulesAfter, lang)}`, `Changed — ${def.label.en}: ${rulesDiffText(cur.rules, rulesAfter, lang)}`) };
  }
  const next = prep.value;
  const nextModel = def.key === 'agent.runner' ? (model !== undefined ? model : prep.extra?.model ?? '') : undefined;
  if (def.key === 'agent.runner' && model !== undefined && model !== (prep.extra?.model ?? '')) return { ok: false, text: pick(lang, '결재를 올린 뒤 그 러너의 모델 목록이 바뀌어 적용하지 않았다 — 다시 올려라.', "The runner's model list changed after filing, so it was not applied — file it again.") };
  // 같은 값(같은 러너를 다시 고른 경우 포함 — 모델 유지)이면 쓰지 않는다
  if (cur.value === next) return { ok: true, before: cur.value, after: next, unchanged: true, text: pick(lang, `이미 ${showSetting(def, next, lang)}(으)로 되어 있다 — 바꾸지 않았다(${def.label.ko}).`, `Already ${showSetting(def, next, lang)} — nothing changed (${def.label.en}).`) };
  const patch = { 'agent.role': { role: next }, 'agent.runner': { runner: next, model: nextModel }, 'agent.model': { model: next }, 'agent.effort': { effort: next } }[def.key];
  let after;
  try { after = await updateAgentMeta(wsId, slug, patch); }
  catch (e) { return { ok: false, text: pick(lang, `바꾸지 못했다: ${String(e?.message ?? e).slice(0, 160)}`, `Not changed: ${String(e?.message ?? e).slice(0, 160)}`), raw: true }; }
  const afterVal = { 'agent.role': after.role ?? '', 'agent.runner': after.runner ?? '', 'agent.model': after.model ?? '', 'agent.effort': after.effort ?? '' }[def.key];
  const effortNote = (cur.meta.effort ?? '') !== (after.effort ?? '') ? pick(lang, ` 추론 강도는 새 모델에 맞춰 ${after.effort || '강도 기본'}(으)로 바뀌었다(이전 ${cur.meta.effort || '강도 기본'}).`, ` Effort changed to ${after.effort || 'default'} for the new model (was ${cur.meta.effort || 'default'}).`) : '';
  const tail = def.key === 'agent.runner' ? pick(lang, ` 모델은 화면처럼 그 러너의 첫 모델(${after.model || '—'})로 바뀌었다(이전 모델 ${cur.meta.model || '—'}).`, ` The model switched to that runner's first model (${after.model || '—'}), like the screen does (was ${cur.meta.model || '—'}).`) + effortNote
    : def.key !== 'agent.effort' ? effortNote : '';
  return { ok: true, before: cur.value, after: afterVal, text: `${changedText(def, cur.value, afterVal, lang)}${tail}` };
}

/** 루틴 설정 적용(제목·내용·요일·간격·켜기) — 루틴 화면과 같은 저장 함수(updateRoutine — 같은 검증). */
async function applyRoutineSetting(wsId, def, { cur, value, slug, lang, from = null }) {
  const r = cur.routine; const sc = r.schedule ?? {};
  if (cur.value === value) return { ok: true, before: cur.value, after: value, unchanged: true, text: pick(lang, `이미 ${showSetting(def, value, lang)}(으)로 되어 있다 — 바꾸지 않았다(${def.label.ko}).`, `Already ${showSetting(def, value, lang)} — nothing changed (${def.label.en}).`) };
  const patch = def.key === 'routine.title' ? { title: value }
    : def.key === 'routine.prompt' ? { prompt: value }
      : def.key === 'routine.days' ? { schedule: { ...sc, dows: value.split(',').map(Number) } }
        : def.key === 'routine.interval' ? { schedule: { ...sc, everyMinutes: value } }
          : { enabled: value };
  // 출처(from)가 있는 루틴은 풀 오토로 돌지 않는다. 결재로 고친 루틴(주인 1:1이 아닌 턴의 요청)은 늘 출처를 남기고(끄기 제외),
  // 주인 1:1에서는 다른 에이전트의 루틴을 다시 켤 때만 남긴다(cancel_routine의 다시 켜기와 같은 규칙)
  const disabling = def.key === 'routine.enabled' && value === false;
  const reFrom = disabling ? null : from ?? (r.agentSlug !== slug ? slug : null); // originFor와 같다 — 다른 에이전트의 루틴을 고치면(제목·내용·요일·간격·다시 켜기) 지금 에이전트를 출처로
  try { await updateRoutine(wsId, r.id, patch, reFrom ? { from: reFrom } : {}); }
  catch (e) { return { ok: false, text: pick(lang, `바꾸지 못했다: ${String(e?.message ?? e).slice(0, 160)}`, `Not changed: ${String(e?.message ?? e).slice(0, 160)}`), raw: true }; }
  return { ok: true, before: cur.value, after: value, text: changedText(def, cur.value, value, lang, r.title) };
}

/** 결재 승인 뒤 적용 — 반환 = 후속 보고 문구(appliedNote, 결재를 올린 방으로 간다). 주인 1:1 전용 키(비서 켜기·교체)는 결재로 적용하지 않는다(카드를 고쳐 넣은 경우 방어). */
export async function applyApprovedSetting(wsId, p, { slug = null } = {}) {
  const lang = p.lang ?? 'ko';
  const def = settingOf(p.key);
  if (def?.ownerOnly) return pick(lang, '적용 안 함 — 이 설정은 결재로 바꾸지 않는다(주인 1:1에서만).', "Not applied — this setting isn't changed through approvals (owner's 1:1 only).");
  let r;
  if (def?.card && (!p.id || p.id !== (p.by ?? slug))) return pick(lang, '적용 안 함 — 에이전트는 자기 카드만 바꾼다.', 'Not applied — agents change only their own card.'); // 결재 파일을 고쳐 남의 카드를 가리키게 해도
  try { r = await applySetting(wsId, { key: p.key, id: p.id ?? null, value: p.value, ...(p.model !== undefined ? { model: p.model } : {}), ...(p.before ? { before: p.before, after: p.after } : {}), ...(p.index ? { index: p.index, h: p.h } : {}),
    // 결재로 고친 루틴은 결재 파일이 출처를 잃어도 올린 에이전트를 출처로. 주인 1:1에서 올린 카드(o1 — 카드 문구에 보여 대조된다)는 originFor 규칙(applyRoutineSetting)
    ...(def?.key?.startsWith('routine.') && !p.o1 ? { from: p.from ?? p.by ?? slug } : {}) }, { slug: p.o1 ? (p.by ?? slug) : slug, lang }); }
  catch { r = { ok: false, raw: true }; }
  return appliedNote(p, r, lang);
}

/** 결재 승인 뒤 적용 결과 문구(순수) — 후속 턴이 원래 방(채널일 수 있다)에 보고하므로 이전 값은 싣지 않는다. 새 값과 화면 위치만. */
export function appliedNote({ key, value, index }, r, lang = 'ko') {
  const def = settingOf(key);
  // 실패 이유는 이 모듈이 만든 문구만(화면 규칙 위반 등) — 원문 오류(경로·내부 메시지가 섞일 수 있다)는 방으로 내보내지 않는다
  if (!r?.ok || !def) return r?.text && !r.raw ? pick(lang, `적용 실패 — ${r.text}`, `Not applied — ${r.text}`)
    : pick(lang, `적용 실패 — ${def ? def.label.ko : '설정'}을(를) 바꾸지 못했다. 주인에게 화면에서 확인해 달라고 안내하라.`, `Not applied — couldn't change ${def ? def.label.en : 'the setting'}. Ask the owner to check it on screen.`);
  const L = ko(lang) ? 'ko' : 'en';
  const shown = index ? pick(lang, `규칙 ${index}번 삭제`, `rule #${index} removed`) : def.key.startsWith('agent.rules.') ? showSetting(def, value, lang) : showSetting(def, r.after ?? value, lang); // 규칙은 이번 한 줄만(전체 목록은 원래 방으로 보내지 않는다)
  return pick(lang, `적용 완료 — ${def.label.ko} → ${shown}(화면: ${def.where.ko}). 이전 값은 말하지 마라.`,
    `Applied — ${def.label[L]} → ${shown} (screen: ${def.where.en}). Don't mention the previous value.`);
}

/* ─── 예약 끄기·켜기·지우기(cancel_routine) — 설정 바꾸기와 같은 권한 표 ─────────────────────────────
 * 바로 하는 것은 주인이 1:1에서 직접 시킨 턴(settingsDirectTurn)뿐이다. 그 밖(루틴·장시간 작업·위임·쪽지·세션 메시지·메신저 채널·결재 후속 —
 * 턴 안에서 읽은 웹·파일·메일 글이 이끈 호출 포함)은 결재 카드(kind 'routine')로 가고, 주인이 승인하면 서버가 적용한다. 손님은 처리기에서 거절(chat.mjs).
 * 카드 문구는 서버가 아는 값(예약 id·제목·동작)으로만 만들고, 승인 뒤 적용 직전에 같은 문구를 다시 만들어 대조한다(설정 결재와 같은 방어). */
const ROUTINE_ACTIONS = Object.freeze({
  off: { ko: '예약 끄기', en: 'Turn off schedule' },
  on: { ko: '예약 다시 켜기', en: 'Turn schedule back on' },
  delete: { ko: '예약 삭제', en: 'Delete schedule' },
});
const ROUTINE_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const routineTitle = (s) => String(s ?? '').replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, 80);

/** 예약 변경 결재 카드 문구(순수) — 등록·적용 대조 공용. */
export function routineChangeText({ id, action, title }, lang = 'ko') {
  const a = ROUTINE_ACTIONS[action];
  if (!a) return '';
  return `${a[ko(lang) ? 'ko' : 'en']} — "${routineTitle(title)}" [${id}]`;
}

/** 예약 변경 결재 재료(순수) — { action, reason, payload, text }. from = 다시 켤 때 예약에 남길 출처(사장 직접이 아닌 턴이 켠 예약은 풀 오토로 돌지 않는다). */
export function routineChangeApproval({ routine, action, why = '', lang = 'ko', slug = null, from = null }) {
  const payload = { id: String(routine.id), action, title: routineTitle(routine.title), lang: ko(lang) ? 'ko' : 'en', ...(slug ? { by: slug } : {}), ...(action === 'on' && from ? { from } : {}) };
  const actionText = routineChangeText(payload, lang);
  const reason = maskKeyLike(String(why || '').replace(/[\r\n\t]+/g, ' ').trim()).slice(0, 500) || pick(lang, '에이전트가 올린 예약 변경 요청', 'Schedule change requested by an agent');
  return {
    action: actionText, reason, payload,
    text: pick(lang,
      `이 요청은 주인이 1:1에서 직접 시킨 것이 아니라서 바로 처리하지 않고 주인 결재로 올렸다(${actionText}). 승인되면 시스템이 처리하고 결과가 이어서 온다 — 승인 전에는 끄거나 지운 것처럼 말하지 마라.`,
      `This request didn't come from the owner directly in a 1:1, so it was filed for the owner's approval instead of being done (${actionText}). Once approved the system applies it and reports back — don't say it was turned off or deleted before then.`),
  };
}

/** 결재 승인 뒤 예약 변경 적용 — 반환 = 후속 보고 문구. 카드 문구 대조는 호출부(approval-actions)가 먼저 한다. */
export async function applyApprovedRoutineChange(wsId, p = {}) {
  const lang = p.lang ?? 'ko';
  if (!ROUTINE_ACTIONS[p.action] || !ROUTINE_ID_RE.test(String(p.id ?? ''))) return pick(lang, '적용 실패 — 결재 내용이 올바르지 않다. 사용자에게 다시 올려라.', 'Not applied — the approval is malformed. File it again.');
  const r = (await loadRoutines(wsId)).find((x) => x.id === p.id);
  const title = routineTitle(r?.title ?? p.title);
  if (!r) return pick(lang, `적용 안 함 — 예약 "${title}"은(는) 이미 없다.`, `Not applied — the schedule "${title}" no longer exists.`);
  if (p.action === 'delete') {
    await removeRoutine(wsId, p.id);
    return pick(lang, `적용 완료 — 예약 "${title}"을(를) 지웠다. 다시 필요하면 새로 걸어야 한다.`, `Applied — deleted the schedule "${title}". To bring it back, set it up again.`);
  }
  await updateRoutine(wsId, p.id, { enabled: p.action === 'on' }, p.action === 'on' && p.from ? { from: p.from } : {});
  return p.action === 'on'
    ? pick(lang, `적용 완료 — 예약 "${title}"을(를) 다시 켰다(루틴 화면에서 끌 수 있다).`, `Applied — turned the schedule "${title}" back on (you can turn it off on the Routines screen).`)
    : pick(lang, `적용 완료 — 예약 "${title}"을(를) 껐다(루틴 화면에서 다시 켤 수 있다).`, `Applied — turned off the schedule "${title}" (you can turn it back on on the Routines screen).`);
}

const ASSIST_ERR_CODES = new Set(['assistant_quiet_empty', 'assistant_evening_in_quiet', 'assistant_evening_before_morning', 'assistant_time_invalid', 'assistant_lead_invalid', 'assistant_agent_not_found']);
function assistantErrorText(e, lang) {
  const code = e?.code ?? '';
  const ko_ = {
    assistant_quiet_empty: '조용한 시간 시작과 끝이 같으면 안 된다.',
    assistant_evening_in_quiet: '내일 일정 요약 시각이 조용한 시간 안에 있다 — 조용한 시간 밖으로 정해야 나간다.',
    assistant_evening_before_morning: '아침 정리(조용한 시간 끝)는 내일 일정 요약보다 앞이어야 한다.',
    assistant_time_invalid: '시각 형식이 맞지 않는다(HH:MM).',
    assistant_lead_invalid: `일정 알림은 ${LEAD_CHOICES.join('·')}분 전 중 하나다.`,
    assistant_agent_not_found: '하트비트로 정할 에이전트를 찾지 못했다.',
  };
  const en_ = {
    assistant_quiet_empty: 'Quiet hours start and end cannot be the same.',
    assistant_evening_in_quiet: "Tomorrow's summary falls inside quiet hours — pick a time outside them.",
    assistant_evening_before_morning: "The morning summary (quiet hours end) must be earlier than tomorrow's summary.",
    assistant_time_invalid: 'Time must be HH:MM.',
    assistant_lead_invalid: `Event reminder must be one of ${LEAD_CHOICES.join('/')} minutes.`,
    assistant_agent_not_found: 'Could not find the agent to use for heartbeat.',
  };
  const msg = (ko(lang) ? ko_ : en_)[code];
  return `${pick(lang, '바꾸지 못했다', 'Not changed')}: ${msg ?? String(e?.message ?? e).slice(0, 160)}`;
}

function changedText(def, before, after, lang, title = '') {
  const L = ko(lang) ? 'ko' : 'en';
  const name = `${def.label[L]}${title ? ` — ${title}` : ''}`;
  const empty = (before === '' || before == null) && def.type !== 'runner' && def.type !== 'effort'; // 비어 있던 값(예: 정해진 비서 없음)으로는 도구로 되돌릴 수 없다 — 화면 안내만(러너 자동·강도 기본은 값이다)
  const b = showSetting(def, before, lang); const a = showSetting(def, after, lang);
  const long = def.type === 'text' && (def.max ?? 0) > 200 && String(before ?? '').length > 120; // 긴 글(루틴 내용)은 되돌릴 수 있게 이전 글 전체를 에이전트에게만 남긴다(이 결과는 주인 1:1 턴에만 온다)
  return pick(lang,
    `바꿨다 — ${name}: ${b} → ${a}. 되돌리는 법: ${empty ? '' : `"${long ? '이전 내용' : b}(으)로 되돌려 줘"라고 하면 다시 바꾸고, `}화면에서는 ${def.where.ko}에서 바꾼다. 사용자에게 바꾼 값과 되돌리는 법을 짧게 알려라.${long ? `\n이전 내용 전체: ${before}` : ''}`,
    `Changed — ${name}: ${b} → ${a}. To undo: ${empty ? '' : `ask "change it back to ${long ? 'the previous text' : b}", or `}change it at ${def.where.en}. Tell the user the new value and how to undo it, briefly.${long ? `\nPrevious text in full: ${before}` : ''}`);
}

/**
 * argo_settings 처리(도구 처리기 본체) — 반환 { kind: 'text'|'approval', text, approval? }.
 * kind 'approval'이면 호출부(chat.mjs)가 같은 결재 경로(addApproval — 메신저 카드·텔레그램 버튼 포함)로 올린다.
 */
export async function argoSettings(wsId, { action = 'list', key = '', id = null, value = null, why = '' } = {}, { slug = null, lang = 'ko', direct = false, guest = false, via = null } = {}) { // via = 이 턴을 위임한 에이전트(다시 켜는 루틴의 출처)
  if (action === 'list') return { kind: 'text', text: await settingsList(wsId, { lang, direct, guest, slug }) };
  const policy = settingPolicy({ key, direct, guest });
  if (policy === 'forbidden') {
    const f = forbiddenOf(key); const L = ko(lang) ? 'ko' : 'en';
    return { kind: 'text', text: pick(lang,
      `이 설정은 에이전트가 바꿀 수 없다(${f.why.ko}). 바꾸지 말고, 사용자가 직접 ${f.where.ko}에서 바꾸도록 안내하라.`,
      `Agents cannot change this setting (${f.why[L]}). Don't change it — tell the user to change it themselves at ${f.where.en}.`) };
  }
  const keyShown = String(key ?? '').replace(/[\x00-\x1f\x7f]+/g, ' ').slice(0, 60);
  if (policy === 'unknown') {
    return { kind: 'text', text: pick(lang,
      `"${keyShown}"는 에이전트가 바꿀 수 있는 설정 목록에 없다. argo_settings action=list로 바꿀 수 있는 설정을 확인하라. 목록에 없는 설정은 사용자가 화면에서 바꾸도록 안내하라.`,
      `"${keyShown}" is not on the list of settings agents can change. Check the list with argo_settings action=list; for anything else, tell the user where to change it on screen.`) };
  }
  const def = settingOf(key);
  if (def.card) id = slug; // 내 카드만 — 인자로 다른 에이전트를 가리킬 수 없다
  if (def.card && !slug) return { kind: 'text', text: pick(lang, '이 턴의 에이전트를 알 수 없다.', 'Unknown agent for this turn.') };
  if (def.needsId && !id) return { kind: 'text', text: pick(lang, '이 설정은 id가 필요하다(루틴 id — argo_status section=routines).', 'This setting needs an id (routine id — argo_status section=routines).') };
  if (!def.card && id != null && !/^[A-Za-z0-9_-]{1,40}$/.test(String(id))) return { kind: 'text', text: pick(lang, 'id 형식이 맞지 않는다(루틴 id).', 'Invalid id (routine id).') }; // 카드 문구에 들어가는 값 — 글자 제한
  const norm = normalizeSettingValue(def, value, lang);
  if (norm.error) return { kind: 'text', text: norm.error };
  const reveal = direct && !guest;
  // 루틴 고치기는 손님이 결재로도 올리지 못한다 — cancel_routine(#916)과 같은 규칙(루틴은 주인의 몸으로 미래 턴을 돈다)
  if (guest && def.key.startsWith('routine.')) return { kind: 'text', text: pick(lang, '루틴은 이 에이전트의 주인만 바꿀 수 있다 — 주인에게 직접 요청하라고 안내하라.', "Only this agent's owner can change routines — suggest asking the owner directly.") };
  // 지시문 규칙도 손님은 결재로도 올리지 못한다 — 오래 남는 지시를 남이 제안하게 두지 않는다(루틴과 같은 거절)
  if (guest && def.key.startsWith('agent.rules.')) return { kind: 'text', text: pick(lang, '일하는 방식 규칙은 이 에이전트의 주인만 바꿀 수 있다 — 주인에게 직접 요청하라고 안내하라.', "Only this agent's owner can change working rules — suggest asking the owner directly.") };
  // 화면과 같은 선택지 규칙으로 값을 확정(러너 연결·모델 목록·강도 단계·규칙 번호) — 바로 바꾸기·결재 공용. 주인 1:1이 아니면 연결·목록 대조는 승인 때 한다
  const prep = await prepareSetting(wsId, def, norm.value, { id, lang, full: reveal });
  // 주인 1:1이 아니면 오류에 카드·러너 연결 상태(지금 규칙·연결된 러너·모델 목록)를 싣지 않는다 — 도구 결과는 그 방으로 나갈 수 있다
  if (prep.error) return { kind: 'text', text: reveal || (!def.card && !def.key.startsWith('routine.')) ? prep.error : pick(lang, '그 값으로는 바꿀 수 없다 — 주인의 1:1에서 argo_settings action=list로 가능한 값을 확인하라.', "That value can't be used — check the allowed values with argo_settings action=list in the owner's 1:1.") };
  if (policy === 'apply') {
    const r = await applySetting(wsId, { key: def.key, id, value: prep.value }, { slug, lang });
    return { kind: 'text', text: r.text };
  }
  // 결재 — 주인의 1:1이 아닌 턴이다. 지금 값을 읽지도 알려 주지도 않는다(같다/다르다도 — 도구 결과는 그 방으로 나갈 수 있다).
  // 이미 같은 값이면 승인 뒤 적용 단계(applySetting)가 "이미 …"로 끝낸다. 사유는 에이전트가 쓴 글 — 키 모양 문자열을 가린다(maskKeyLike).
  if (def.ownerOnly) return { kind: 'text', text: pick(lang,
    `${def.label.ko}은(는) 주인이 1:1에서 직접 시킬 때만 바꾼다 — 결재 카드로도 올리지 않았다(계정의 다른 하트비트 설정까지 바뀌는 일이라). 주인에게 1:1에서 말해 달라고 안내하라.`,
    `${def.label.en} is changed only when the owner asks directly in a 1:1 — no approval card was filed (it affects the account's heartbeat elsewhere too). Suggest the owner ask in their 1:1.`) };
  const payload = { key: def.key, ...(id ? { id: String(id) } : {}), value: prep.value, lang: ko(lang) ? 'ko' : 'en', ...(slug ? { by: slug } : {}),
    ...(def.key === 'agent.runner' ? { model: prep.extra?.model ?? '' } : {}),
    ...(prep.extra?.before ? { before: prep.extra.before, after: prep.extra.after } : {}),
    ...(prep.extra?.index ? { index: prep.extra.index, h: prep.extra.h } : {}), // 남이 보는 방의 규칙 삭제 — 번호만(승인 때 지금 규칙에서 그 번호 문장을 확정)
    ...(def.approvalAlways && reveal ? { o1: true } : {}), // 주인 1:1에서 올린 늘-결재 카드(카드 문구에 보인다 — 루틴 출처 판정에 쓴다)
    // 루틴을 고친 출처 — 주인 1:1이 아닌 턴이 고친 루틴은 이후 풀 오토로 돌지 않는다(다시 켜기·내용·시각 모두, 승인 뒤에도 — 손님 결재 후속과 같은 원칙).
    // 주인 1:1에서 올린 카드는 originFor 규칙(다른 에이전트의 루틴이면 지금 에이전트)으로 승인 때 정한다
    ...(!reveal && def.key.startsWith('routine.') && def.key !== 'routine.time' && (def.key !== 'routine.enabled' || prep.value === true) ? { from: via ?? slug } : {}) };
  const why_ = maskKeyLike(String(why || '').replace(/[\r\n\t]+/g, ' ').trim());
  // 규칙 결재 — 카드에 바뀌기 전·후 규칙(주인 1:1에서 올린 카드). 남이 보는 방에서 올린 카드는 개수와 이번 한 줄만(지시문 전체를 그 방에 싣지 않는다)
  const diff = prep.extra?.index ? pick(lang, `규칙 ${prep.extra.index}번 삭제 — 승인할 때 그때의 규칙 ${prep.extra.index}번 문장을 지운다(그 번호가 없으면 적용하지 않는다)`, `Remove rule #${prep.extra.index} — on approval the rule at #${prep.extra.index} at that time is removed (not applied if there is no such number)`)
    : prep.extra?.before ? (reveal ? rulesDiffText(prep.extra.before, prep.extra.after, lang)
    : pick(lang, `규칙 ${prep.extra.before.length}개 → ${prep.extra.after.length}개(전·후 전체는 승인할 때 데크 결재함·주인 1:1에서 확인)`, `Rules ${prep.extra.before.length} → ${prep.extra.after.length} (full before/after: check in the Deck approvals or the owner's 1:1)`)) : '';
  // 긴 글(루틴 내용)은 카드 문구에 앞 120자만 보이므로, 주인이 무엇을 승인하는지 사유 칸에 새 글 전체를 싣는다(넘치면 앞부분)
  const full = def.key === 'routine.prompt' ? pick(lang, `새 내용 전체: ${prep.value}`, `New text in full: ${prep.value}`) : ''; // 380자 상한이라 사유 칸에 늘 전부 들어간다
  const reason = [diff, full, why_].filter(Boolean).join(' · ').slice(0, 500) || pick(lang, '에이전트가 올린 설정 변경 요청', 'Setting change requested by an agent');
  const shown = prep.extra?.index ? pick(lang, `규칙 ${prep.extra.index}번`, `rule #${prep.extra.index}`) : showSetting(def, prep.value, lang);
  return {
    kind: 'approval',
    approval: { action: settingActionText(payload, lang), reason, payload },
    text: def.approvalAlways && reveal ? pick(lang,
      `오래 남아 계속 실행되는 지시(일하는 방식 규칙·루틴 내용)는 주인 1:1에서도 바로 바꾸지 않고 결재 카드로 올렸다(${def.label.ko}: ${shown}) — 카드에 바뀌기 전·후가 보인다. 승인되면 시스템이 바꾸고 결과가 이어서 온다 — 승인 전에는 바뀐 것처럼 말하지 마라.`,
      `Standing instructions (working rules, routine instructions) are filed as an approval card even in the owner's 1:1 (${def.label.en}: ${shown}) — the card shows before and after. Once approved the system applies it and reports back — don't say it changed before then.`)
      : pick(lang,
        `이 요청은 주인이 1:1에서 직접 시킨 것이 아니라서 바로 바꾸지 않고 주인 결재로 올렸다(${def.label.ko} → ${shown}). 승인되면 시스템이 바꾸고 결과가 이어서 온다 — 승인 전에는 바뀐 것처럼 말하지 마라. 지금 값은 이 방에 알리지 않는다.`,
        `This request didn't come from the owner directly in a 1:1, so it was filed for the owner's approval instead of applied (${def.label.en} → ${shown}). Once approved the system applies it and reports back — don't say it changed before then. Don't share the current value here.`),
  };
}

async function settingsList(wsId, { lang, direct, guest, slug = null }) {
  const L = ko(lang) ? 'ko' : 'en';
  const reveal = direct && !guest; // 설정 값은 주인 1:1에서만(argoStatus와 같은 범위)
  const view = reveal ? await assistantSettingsView(wsId).catch(() => null) : null;
  const company = reveal ? await loadCompany(wsId).catch(() => ({})) : {};
  const card = reveal && slug ? await readAgentCard(wsId, slug).catch(() => null) : null;
  // 러너·모델·강도 선택지 — 카드 화면과 같은 목록(연결된 러너만, 그 러너의 모델, 그 모델의 강도). 카탈로그는 비밀이 아니라 어디서나 보인다
  const [{ RUNNERS, runnerStatus, isHiddenRunner }, { effectiveModels }] = await Promise.all([import('./runners.mjs'), import('./runners/catalog-remote.mjs')]);
  const st = reveal ? await runnerStatus(wsId, { forPick: true }).catch(() => ({})) : {};
  const usable = Object.keys(RUNNERS).filter((r) => !isHiddenRunner(r) && st?.[r]?.company?.connected && !st[r].company.invalid);
  const myRunner = String(card?.meta?.runner ?? '');
  const now = (def) => {
    if (!reveal) return pick(lang, '(주인의 1:1에서만 보여 준다)', "(shown only in the owner's 1:1)");
    if (def.key.startsWith('assistant.')) return view ? showVal(def.read(view), lang) : '?';
    if (def.key === 'company.lang') return company.lang ?? 'ko';
    if (def.card) {
      if (!card) return '?';
      if (def.key.startsWith('agent.rules.')) return pick(lang, `규칙 ${cardRules(card.md).length}개(argo_status section=me)`, `${cardRules(card.md).length} rules (argo_status section=me)`);
      const v = { 'agent.role': card.meta.role ?? '', 'agent.runner': myRunner, 'agent.model': card.meta.model ?? '', 'agent.effort': card.meta.effort ?? '' }[def.key];
      return def.key === 'agent.role' || def.key === 'agent.model' ? showVal(v, lang) : showSetting(def, v, lang);
    }
    return pick(lang, '루틴마다 다름(argo_status section=routines)', 'per routine (argo_status section=routines)');
  };
  const fmt = (d) => {
    if (!reveal && (d.type === 'runner' || d.type === 'model' || d.type === 'effort')) return pick(lang, ' · 가능한 값은 주인의 1:1에서 보여 준다', " · allowed values shown only in the owner's 1:1"); // 연결된 러너·내 러너는 주인 상태
    if (d.choices) return ` · ${pick(lang, '가능한 값', 'values')}: ${d.choices.join(', ')}`;
    if (d.type === 'runner') return ` · ${pick(lang, '가능한 값', 'values')}: ${[...usable, 'auto'].join(', ')}`;
    if (d.type === 'model') return myRunner && Object.hasOwn(RUNNERS, myRunner) ? ` · ${pick(lang, '가능한 값', 'values')}: ${effectiveModels(myRunner).map((m) => m.id).join(', ')}` : pick(lang, ' · 러너가 자동이면 고를 수 없다(agent.runner 먼저)', ' · not selectable while the runner is Auto (set agent.runner first)');
    if (d.type === 'effort') return ` · ${pick(lang, '가능한 값', 'values')}: ${[...effortLevels(myRunner, card?.meta?.model), 'default'].join(', ')}`;
    if (d.type === 'days') return pick(lang, ' · 요일(예: 1,3,5 또는 월,수,금)', ' · weekdays (e.g. 1,3,5 or mon,wed,fri)');
    if (d.type === 'interval') return pick(lang, ' · 분(10~1440)', ' · minutes (10–1440)');
    if (d.type === 'ruleRef') return pick(lang, ' · 규칙 번호 또는 문장', ' · rule number or text');
    if (d.type === 'text') return pick(lang, ` · 글(${d.max}자 이내)`, ` · text (up to ${d.max} chars)`);
    return d.type === 'time' ? ' · HH:MM' : d.type === 'bool' ? ' · true/false' : '';
  };
  const mode = direct && !guest
    ? pick(lang, '이 턴은 주인이 1:1에서 직접 시킨 턴이다 — 아래 설정은 바로 바뀐다(바꾼 값과 되돌리는 법을 알려라).', 'This is an owner-direct 1:1 turn — the settings below apply immediately (tell the user the new value and how to undo).')
    : pick(lang, '이 턴은 주인의 1:1 직접 지시가 아니다 — 바꾸면 주인 결재 카드로 올라간다.', "This turn isn't an owner-direct 1:1 — changes go to the owner as an approval card.");
  const rows = SETTINGS.map((d) => `- ${d.key} — ${d.label[L]} · ${pick(lang, '지금', 'now')}: ${now(d)}${fmt(d)}${d.needsId ? ' · id' : ''}${d.approvalAlways ? pick(lang, ' · 늘 결재 카드', ' · always an approval card') : ''} · ${pick(lang, '화면', 'screen')}: ${d.where[L]}`);
  const no = FORBIDDEN_SETTINGS.map((f) => `- ${f.why[L]} — ${f.where[L]}`);
  return [mode, pick(lang, '바꿀 수 있는 설정(key — 이름 · 지금 값 · 형식 · 화면 위치):', 'Changeable settings (key — name · now · format · screen):'), ...rows,
    pick(lang, '에이전트가 바꾸지 못하는 것(사용자가 화면에서 직접):', 'Agents cannot change (the user does it on screen):'), ...no,
    pick(lang, 'agent.* 키는 네 카드만 바꾼다. 루틴 만들기는 schedule_task, 지우기는 cancel_routine(주인 1:1이면 바로, 그 밖은 결재). 이름·팀·동료 카드·카드 섹션은 update_profile(결재)로 한다.', "agent.* keys change only your own card. Create routines with schedule_task, delete with cancel_routine (immediate in the owner's 1:1, otherwise an approval). Name, team, colleagues' cards and card sections use update_profile (approval).")].join('\n');
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
  other_company: ['다른 회사의 하트비트가 맡고 있음', "another company's heartbeat is handling it"],
  login_required: ['로그인 필요', 'sign-in needed'],
  muted: ['메신저 알림 종류에서 하트비트 알림이 꺼짐', 'heartbeat notifications muted in messenger'],
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
    pick(lang, '하트비트(능동 알림) — 설정 화면(에이전트 카드 → 하트비트 탭)과 같은 값', 'Heartbeat (proactive alerts) — same values as Agent card → Heartbeat tab'),
    `- ${pick(lang, '이 회사 하트비트', 'This company')}: ${c.enabled ? pick(lang, '켜짐', 'on') : pick(lang, '꺼짐', 'off')}${c.agent ? ` · ${pick(lang, '하트비트 에이전트', 'heartbeat agent')} ${c.agent}${c.agent === slug ? pick(lang, '(나)', ' (me)') : ''}` : ''}`,
    `- ${pick(lang, '지금 하트비트(계정마다 하나)', 'Current heartbeat (one per account)')}: ${v.current ? `${v.current.company} · ${v.current.name}` : pick(lang, '없음', 'none')}`,
    ...(v.unsealed ? [pick(lang, '- 설정 파일이 설정 화면 밖에서 바뀌어 멈춤 — 하트비트 탭에서 다시 켜면 돈다', '- Stopped: the settings file was changed outside the settings screen — turn it on again in the Heartbeat tab')] : []),
    `- ${pick(lang, '보는 것', 'Watches')}: ${pick(lang, '일정(읽기만)', 'calendar (read only)')} · ${pick(lang, '받는 곳', 'delivered to')}: ${pick(lang, '개인 공간 1:1 방', 'personal 1:1 room')} · ${pick(lang, '권한', 'permission')}: ${pick(lang, '알림만', 'notify only')}`,
    `- ${pick(lang, '일정 알림', 'Event reminder')}: ${c.leadMinutes}${pick(lang, '분 전', ' min before')} · ${pick(lang, '아침 정리(조용한 시간 끝)', 'Morning summary (quiet hours end)')}: ${c.quiet.to} · ${pick(lang, '내일 일정 요약', "Tomorrow's summary")}: ${c.eveningAt} · ${pick(lang, '조용한 시간', 'Quiet hours')}: ${c.quiet.from}~${c.quiet.to}${c.quiet.calendarAlerts ? pick(lang, '(일정 알림은 보냄)', ' (reminders still sent)') : ''}${c.tz ? ` · ${c.tz}` : ''}`,
    `- ${pick(lang, '실행 기기', 'Running on')}: ${runner}`,
    `- ${pick(lang, '확인 주기', 'Check cadence')}: ${pick(lang, `켜져 있으면 1분마다 차례를 보고, 일정은 ${CAL_READ_MS / 60_000}분마다 읽는다(조용한 시간에는 쉬었다가 끝나면 밤사이를 모아 아침 정리로 보낸다)`, `when on it checks every minute and reads the calendar every ${CAL_READ_MS / 60_000} min (rests during quiet hours, then sends the night's items in the morning summary)`)}`,
    here
      ? `- ${pick(lang, '마지막 일정 확인', 'Last calendar check')}: ${s.readAt ? `${fmtTime(s.readAt, lang)}(${ago(s.readAt, now, lang)})` : pick(lang, '아직 없음', 'not yet')} · ${pick(lang, '오늘 보낸 일정 알림', 'reminders sent today')}: ${s.instantToday}${pick(lang, '건', '')} · ${pick(lang, '상태', 'status')}: ${s.code ? (ASSIST_CODE[s.code]?.[L] ?? s.code) : pick(lang, '기록 없음', 'no record')}`
      : `- ${pick(lang, '마지막 일정 확인·오늘 보낸 알림 수는 실행 기기에만 기록된다 — 이 기기에서는 볼 수 없다', 'Last check and today\'s count are recorded only on the running device — not visible from this device')}`,
    `- ${pick(lang, '로그인', 'Sign-in')}: ${s.login ? pick(lang, '됨', 'ok') : pick(lang, '필요 — 이 기기에서 회사를 만든 계정으로 로그인', 'needed — sign in on this device with the account that created this company')}${s.muted ? pick(lang, ' · 메신저 알림 종류에서 하트비트 알림이 꺼져 있어 보내지 않음', ' · heartbeat notifications are muted in messenger') : ''}`,
  ];
  return lines.join('\n');
}

const EFFORT_LABEL = { low: ['낮음 — 빠름', 'Low — fastest'], medium: ['보통', 'Medium'], high: ['높음', 'High'], xhigh: ['매우 높음', 'Extra high'], max: ['최대', 'Max'], ultra: ['최고', 'Ultra'] }; // app/i18n.jsx runner.effort.*
const scopeText = (v, names, lang) => { // 카드 '능력' 탭 — '' = 전체, 'none' = 사용 안 함, csv = 지정 목록(persona.mjs parseScopeList와 같은 계약)
  const s = String(v ?? '').trim();
  if (!s) return pick(lang, '전체 사용 — 새로 설치해도 자동 적용', 'all — new installs apply automatically');
  if (s.toLowerCase() === 'none') return pick(lang, '사용 안 함', 'not used');
  return `${pick(lang, '지정 목록', 'selected')}: ${s.split(',').map((x) => x.trim()).filter(Boolean).join(', ')}${names ? ` (${pick(lang, '설치', 'installed')} ${names})` : ''}`;
};

/** 나(이 에이전트) — 에이전트 카드 화면과 같은 값: 개요(이름·역할·팀·엔진)·능력(스킬·MCP 범위)·방식(일하는 방식 규칙)·하트비트·연결(텔레그램 직통 봇·메신저), 내 루틴, 대화 밖에서 보낸 최근 글, 내가 올린 결재. */
async function meSection(wsId, { lang, slug, now }) {
  const L = ko(lang) ? 0 : 1;
  const card = await readAgentCard(wsId, slug).catch(() => null);
  const m = card?.meta ?? {};
  const company = await loadCompany(wsId).catch(() => ({}));
  const [{ runnerStatus, autoRunnerOf, RUNNERS }, conn] = await Promise.all([import('./runners.mjs'), import('./connections.mjs')]);
  const st = await runnerStatus(wsId, { forPick: true }).catch(() => null);
  const auto = st ? autoRunnerOf(st, company.defaultRunner ?? null) : null;
  const runner = m.runner ? (Object.hasOwn(RUNNERS, m.runner) ? `${RUNNERS[m.runner].name} [${m.runner}]` : m.runner)
    : `${pick(lang, '자동 — 첫 연결 러너', 'Auto — first connected runner')}${auto ? pick(lang, `(지금은 ${auto})`, ` (now ${auto})`) : ''}`;
  const showEffort = !m.runner || m.runner === 'claude' || m.runner === 'codex'; // 카드 화면도 이 러너들에만 강도 칸을 보인다
  const effort = m.effort ? (EFFORT_LABEL[m.effort]?.[L] ?? m.effort) : pick(lang, '강도 기본', 'Default effort');
  const rules = card ? cardRules(card.md) : [];
  const conns = await conn.loadConnections(wsId).catch(() => ({}));
  const bot = conns?.telegram?.agents?.[slug] ?? null;
  const gw = bot?.token ? await conn.gatewayStatus(wsId).catch(() => null) : null;
  const g = gw?.agents?.[slug];
  const tg = !bot?.token ? pick(lang, '연결 안 됨', 'not connected')
    : `${g?.alive ? pick(lang, '가동 중', 'Live') : g?.holder === 'other' ? pick(lang, `다른 기기(${g.holderDevice ?? ''})에서 수신 중`, `Receiving on ${g.holderDevice ?? 'another device'}`) : pick(lang, '폴러 대기 중', 'Poller pending')}${bot.ownerId ? pick(lang, ' · 페어링됨', ' · paired') : pick(lang, ' · 페어링 전(카드의 연결 코드를 봇에게 DM)', ' · not paired yet (DM the pairing code on the card to the bot)')}`;
  const [routines, assistant, approvals, posts] = await Promise.all([
    routinesSection(wsId, { lang, slug, now, mine: true }),
    assistantSettingsView(wsId, { now }).catch(() => null),
    loadApprovals(wsId).catch(() => []),
    recentSelfPosts(wsId, slug, { now }).catch(() => []),
  ]);
  const c = assistant?.config;
  const amAssistant = c?.enabled && c.agent === slug;
  const mine = approvals.filter((a) => a.status === 'pending' && a.slug === slug);
  const lines = [
    pick(lang, '나 — 에이전트 카드와 같은 값', 'Me — same values as my agent card'),
    `- ${pick(lang, '이름', 'Name')}: ${m.name ?? slug} [${slug}] · ${pick(lang, '역할', 'Role')}: ${m.role || '-'} · ${pick(lang, '팀', 'Team')}: ${m.team || pick(lang, '무소속', 'none')}`,
    `- ${pick(lang, '엔진(개요 탭)', 'Engine (Overview tab)')}: ${pick(lang, '러너', 'runner')} ${runner} · ${pick(lang, '모델', 'model')} ${m.model || '—'}${showEffort ? ` · ${pick(lang, '추론 강도', 'effort')} ${effort}` : ''}`,
    `- ${pick(lang, '능력 탭', 'Abilities tab')}: ${pick(lang, '사용 스킬', 'Skills')} ${scopeText(m.skills, '', lang)} · ${pick(lang, '사용 플러그인(MCP)', 'Plugins (MCP)')} ${scopeText(m.mcp, '', lang)}`,
    `- ${pick(lang, '방식 탭 — 일하는 방식 규칙', 'Working style tab — rules')} ${rules.length}${pick(lang, '개', '')}${rules.length ? `: ${rules.slice(0, 15).map((r, i) => `${i + 1}) ${clip(r, 120)}`).join(' / ')}${rules.length > 15 ? pick(lang, ` …외 ${rules.length - 15}개`, ` …and ${rules.length - 15} more`) : ''}` : ''}`,
    `- ${pick(lang, '하트비트 탭', 'Heartbeat tab')}: ${amAssistant ? pick(lang, `나는 이 회사의 하트비트 에이전트다(켜짐) — 일정 알림 ${c.leadMinutes}분 전 · 아침 정리 ${c.quiet.to} · 내일 일정 요약 ${c.eveningAt} · 조용한 시간 ${c.quiet.from}~${c.quiet.to}. 자세한 상태는 argo_status section=assistant`, `I am this company's heartbeat agent (on) — reminders ${c.leadMinutes} min before · morning ${c.quiet.to} · tomorrow's summary ${c.eveningAt} · quiet ${c.quiet.from}–${c.quiet.to}. Details: argo_status section=assistant`)
      : c?.enabled ? pick(lang, `하트비트는 켜져 있고 담당은 ${c.agent}다(나 아님).`, `Heartbeat is on, handled by ${c.agent} (not me).`) : pick(lang, '이 회사 하트비트는 꺼져 있다.', "This company's heartbeat is off.")}`,
    `- ${pick(lang, '연결 탭 — 텔레그램 직통 봇', 'Links tab — Direct Telegram bot')}: ${tg}${bot?.botUsername ? ` (${bot.botUsername})` : ''}`,
    `- ${pick(lang, '아르고 메신저', 'Argo Messenger')}: ${company.msgr?.enabled ? pick(lang, '회사 에이전트가 메신저에 연결됨 — 개인 1:1 방에서 대화·알림', 'company agents are connected — chats and notices in the personal 1:1 room') : pick(lang, '연결 안 됨(설정 → 연결 → Argo 메신저 연결)', 'not connected (Settings → Connections → Argo Messenger)')}`,
    routines,
    posts.length ? [pick(lang, `내가 대화 밖에서 보낸 최근 글 ${posts.length}건(개인 1:1 방 — 하트비트 알림·루틴 결과)`, `Recent messages I sent outside a conversation: ${posts.length} (personal 1:1 room — heartbeat notices, routine results)`),
      ...posts.map((p) => `- ${fmtTime(Number(p.at), lang)} · ${selfKindLabel(p.kind, lang)}: ${p.text}`)].join('\n')
      : pick(lang, '내가 대화 밖에서 보낸 최근 글: 이 기기 기록에는 없다(7일 안·개인 1:1 방 기준).', 'Recent messages I sent outside a conversation: none recorded on this device (last 7 days, personal 1:1 room).'),
    pick(lang, `내가 올린 결재 중 대기 ${mine.length}건${mine.length ? `: ${mine.slice(0, 5).map((a) => a.action).join(' / ')}` : ''}`, `Pending approvals I filed: ${mine.length}${mine.length ? `: ${mine.slice(0, 5).map((a) => a.action).join(' / ')}` : ''}`),
    pick(lang, '바꾸기: argo_settings(agent.role·agent.runner·agent.model·agent.effort는 주인 1:1이면 바로, 규칙 agent.rules.add·remove는 늘 결재). 스킬·MCP 범위·텔레그램 연결은 사용자가 카드 화면에서.', 'To change: argo_settings (agent.role/runner/model/effort apply now in the owner\'s 1:1; agent.rules.add/remove always go to approval). Skill/MCP scope and the Telegram link are changed by the user on the card screen.'),
  ];
  return lines.join('\n');
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
    ...(s.lastError ? [`- ${pick(lang, '마지막 오류', 'Last error')}: ${maskKeyLike(String(s.lastError)).slice(0, 200)}`] : []),
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
  if (!full) return pick(lang, '아르고 상태(데크 숫자·에이전트·루틴·하트비트·러너·동기화·요금제·메신저 연결·결재)는 주인의 1:1에서만 보여 준다 — 이 대화는 주인의 1:1이 아니다(다른 사람이 보는 방이거나, 루틴·위임으로 온 턴). 상태를 말하지 말고, 필요하면 주인에게 1:1에서 물어보라고 안내하라. 기능 설명은 argo_help로 할 수 있다.',
    "Argo status (Deck numbers, agents, routines, heartbeat, runners, sync, plan, messenger connections, approvals) is shared only in the owner's 1:1 — this conversation is not (others may see this room, or it came from a routine or delegation). Don't state any of it; suggest asking in the owner's 1:1 if needed. Feature explanations are available via argo_help.");
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

