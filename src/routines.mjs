// 자동화 루틴 — 크루에게 반복 지시를 예약(매일/매주)하거나 즉시 실행한다.
// 실행 = 일반 채팅 턴과 동일 경로(chat) → 결과가 vault 기억으로 남고 자동 링크된다.
import { paths } from './workspace.mjs';
import { normalizeRoutineNotifications, validateRoutineNotifications } from './routine-notifications.mjs';
// chat은 **동적 임포트**(runRoutine 안) — chat.mjs가 이 파일을 정적으로 임포트하므로(예약 도구),
// 여기서도 정적이면 유일한 정적-정적 순환이 된다. 지금은 함수 참조뿐이라 동작하지만, 어느 쪽이든
// 톱레벨 부작용이 추가되는 순간 TDZ ReferenceError로 Next 라우트가 500이 된다(전수리뷰 2026-07-30 #3).
import { emitNotify } from './notify.mjs';
import { runOneShot } from './oneshot.mjs'; // 자연어 → 루틴 초안(러너 독립 — 어떤 러너든 연결만 되면 동작)
import { writeJsonAtomic, readJson } from './jsonstore.mjs';
import { withLock } from './mutex.mjs';
import { routineHead, loopHead } from './inbound-marks.mjs'; // 머리말 = 1:1 화면 출처 카드와 같은 함수
import { LOOP_VERDICT_RE, parseLoopVerdict, loopVerdictLine, stripLoopVerdict } from './loop-verdict.mjs'; // 표지 = 엔진 판정·화면 제거와 같은 모듈
// 시각 판정(순수)은 routine-time.mjs가 원천 — 목록 화면(클라이언트)이 '만료' 표시에 같은 판정을
// 쓰기 위한 분리. 기존 소비자를 위해 그대로 재수출한다(임포트 경로 하위호환).
import { normalizeTz, zonedParts, onceSpent, CATCHUP_MS, missedSlots, formatMissedSlots, MISSED_LOOKBACK_DAYS } from './routine-time.mjs';
import { codedError } from './coded-error.mjs'; // 화면 문구 코드(F11)
import { isGoal, goalMode } from './goal-time.mjs'; // 목표 하트비트 = 루틴 한 종류(kind 'goal') — 판정은 순수 모듈 하나(스케줄러 선점과 같은 규칙)
export { normalizeTz, zonedParts, onceSpent, onceExpired } from './routine-time.mjs';

const lockKey = (wsId) => `routines:${wsId}`;
const lockRoutines = (wsId, fn) => withLock(lockKey(wsId), fn, { file: paths(wsId).routines }); // 프로세스 간 잠금 포함(M-b)

/** 락 안에서 목록 재로드 → 해당 id만 patch → 저장. 실행 중 삭제/비활성이 되돌려지는 것을 막는다. */
async function patchRoutine(wsId, id, patch) {
  return lockRoutines(wsId, async () => {
    const routines = await loadRoutines(wsId);
    const r = routines.find((x) => x.id === id);
    if (!r) return null; // 실행 중 삭제됐으면 조용히 포기(부활 금지)
    // 함수형 패치 — 현재 상태를 보고 결정해야 하는 변경(루프 수동 정지 사유 등)은 락 안에서 읽고 쓴다.
    // editedAt은 여기서 찍지 않는다 — patchRoutine은 실행 기록(runRoutine의 lastRun 등)도 지나가는 공용 관문이라,
    // 여기서 찍으면 루틴이 한 번 돌기만 해도 메신저의 대기 편집이 "로컬이 더 나중"으로 오판돼 버려진다(분리 검수 H1).
    // editedAt은 사람이 실제로 내용을 바꾼 경로(addRoutine·updateRoutine)에서만 호출부가 patch에 실어 보낸다.
    Object.assign(r, typeof patch === 'function' ? patch(r) : patch, { id: r.id });
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

/** 잠금 안에서 목록을 읽고 fn(list)로 고친다 — fn이 { save: true, value }를 돌려주면 저장하고 value를 돌려준다(저장 안 하면 쓰기 0).
    목표 하트비트(goal-heartbeat.mjs)가 만들기·상태 바꾸기·정리를 한 잠금 안에서 하려고 쓴다(루틴과 같은 파일·같은 잠금). */
export async function editRoutines(wsId, fn) {
  return lockRoutines(wsId, async () => {
    const routines = await loadRoutines(wsId);
    const r = await fn(routines);
    if (r?.save) await saveRoutines(wsId, routines);
    return r?.value;
  });
}

/** Delivery status is separate from execution success, and never overwrites a newer run. */
export async function recordRoutineNotificationDelivery(wsId, id, runAt, results, phase = 'result') {
  const statuses = ['sent', 'muted', 'unavailable', 'not_selected', 'failed', 'uncertain'];
  const reasons = ['invalid_destinations', 'not_connected', 'destination_unavailable', 'delivery_uncertain', 'delivery_failed'];
  const safe = results.filter((r) => ['telegram', 'slack', 'msgr'].includes(r.kind) && statuses.includes(r.status))
    .map((r) => ({ kind: r.kind, status: r.status, ...(reasons.includes(r.reason) ? { reason: r.reason } : {}) }));
  return lockRoutines(wsId, async () => {
    const routines = await loadRoutines(wsId);
    const routine = routines.find((r) => r.id === id);
    if (!routine || !runAt || routine.lastRun !== runAt) return false;
    if (phase === 'stop' && routine.lastNotificationDelivery?.runAt === runAt && routine.lastNotificationDelivery.phase !== 'stop') return false;
    routine.lastNotificationDelivery = { runAt, phase, results: safe };
    await saveRoutines(wsId, routines);
    return true;
  });
}

/** schedule: { type: 'daily'|'weekly', time: 'HH:MM', dow?: 0-6, times?: ['HH:MM'...], dows?: [0-6...] }
    복수 필드(times/dows)가 있으면 우선, 없으면 단수 필드 — 기존 루틴·구버전 동기화 하위호환.
    (export: 단위 테스트용 — 순수 함수) */
const TIME_RE = /^\d{2}:\d{2}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function normalizeSchedule(schedule = {}) {
  // 시각 예약은 **만든 사람의 시간대**에 묶인다(유건 지시 2026-07-28: "한국 사용자는 한국 시간으로").
  // 없으면 예약 시각을 실행하는 기기의 로컬로 읽는데, 그 기기가 다른 시간대(클라우드 워커=UTC,
  // 해외 기기)면 09:00 브리핑이 엉뚱한 시각에 터진다. 그래서 tz를 스케줄에 박아 함께 옮긴다.
  const tz = normalizeTz(schedule.tz);
  const withTz = (s) => (tz ? { ...s, tz } : s); // 없으면 붙이지 않는다 — 구버전 기기가 읽어도 무해
  // once = 특정 날짜에 1회(예약 발송). 실행되면 자동으로 꺼진다(runRoutine) — 반복 예약과 구분.
  if (schedule.type === 'once') {
    const date = String(schedule.date ?? '').trim();
    if (!DATE_RE.test(date)) throw codedError('routine_once_date_required', '1회 예약은 날짜(YYYY-MM-DD)가 필요합니다');
    const t = String(schedule.time ?? (Array.isArray(schedule.times) ? schedule.times[0] : '')).trim();
    if (!TIME_RE.test(t)) throw codedError('routine_time_format', '예약 시각은 HH:MM 형식');
    return withTz({ type: 'once', date, time: t, times: [t] });
  }
  // interval = N분마다 반복(크루 Start-loop — 실사용 요청 2026-07-27 "루프 잡"). 하한 10분:
  // [규모 질문] 루프 1개 = 매 발화가 LLM 턴 — 분 단위 루프 × 크루 수 × 회사 수가 곱으로 탄다.
  // 상한 1440분(하루). 구버전 기기 하위호환: time 슬롯이 없으면 구 isDue는 NaN 슬롯을 continue로
  // 건너뛰어 발화하지 않는다(깨지지 않고 조용히 대기 — 이 기기들은 업데이트 후 발화 시작).
  if (schedule.type === 'interval') {
    const every = Math.floor(Number(schedule.everyMinutes));
    if (!Number.isInteger(every) || every < 10 || every > 1440) throw codedError('routine_interval_range', '반복 간격은 10~1440분');
    return { type: 'interval', everyMinutes: every };
  }
  const type = schedule.type === 'weekly' ? 'weekly' : 'daily';
  const rawTimes = Array.isArray(schedule.times) && schedule.times.length ? schedule.times : [schedule.time];
  // 잘못된 항목은 통째로 거절 — 일부만 조용히 수용하면 사용자가 지정한 시각이 소리 없이 빠진다
  if (!rawTimes.every((t) => TIME_RE.test(t || ''))) throw codedError('routine_time_format', '예약 시각은 HH:MM 형식');
  const times = [...new Set(rawTimes)].sort();
  if (times.length > 8) throw codedError('routine_times_max', '예약 시각은 하루 8개까지');
  const rawDows = Array.isArray(schedule.dows) && schedule.dows.length ? schedule.dows : [schedule.dow ?? 1];
  const dows = [...new Set(rawDows.map(Number))].sort((a, b) => a - b);
  if (type === 'weekly' && !dows.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) throw codedError('routine_dow_range', '요일은 일(0)~토(6) 범위');
  // 단수 필드(time/dow)는 첫 값으로 함께 유지 — 이 파일을 읽는 구버전(다른 기기 동기화)이 깨지지 않는다
  return withTz({ type, time: times[0], times, dow: dows[0], ...(type === 'weekly' ? { dows } : {}) });
}

/* ─── 루프(interval 루틴의 자율 반복) ─────────────────────────────────────── */

/** loop 필드 정규화 — interval 루틴에만 유효(호출부가 타입을 보고 붙인다). 설정값(maxRuns/maxUsd)은
    클램프·기본값, 진행 카운터(runs/spentUsd/…)는 prev(디스크의 현재값)에서 이어받는다 — API 패치가
    회차·지출을 되돌리지 못하게. (export: 단위 테스트용 — 순수 함수) */
export const LOOP_MAX_RUNS_CAP = 200;
export function normalizeLoop(loop = {}, prev = null) {
  const src = loop && typeof loop === 'object' ? loop : {};
  let maxRuns = Math.floor(Number(src.maxRuns ?? prev?.maxRuns ?? 20));
  if (!Number.isFinite(maxRuns)) maxRuns = 20;
  maxRuns = Math.min(LOOP_MAX_RUNS_CAP, Math.max(1, maxRuns));
  const rawUsd = 'maxUsd' in src ? src.maxUsd : prev?.maxUsd ?? null;
  const usdNum = Number(rawUsd);
  const maxUsd = rawUsd == null || rawUsd === '' || !Number.isFinite(usdNum) || usdNum <= 0 ? null : Math.round(usdNum * 100) / 100;
  return {
    maxRuns, maxUsd,
    runs: Math.max(0, Math.floor(Number(prev?.runs) || 0)),
    spentUsd: Math.max(0, Number(prev?.spentUsd) || 0),
    lastVerdict: ['continue', 'done', 'blocked'].includes(prev?.lastVerdict) ? prev.lastVerdict : null,
    stoppedReason: ['done', 'blocked', 'maxRuns', 'maxUsd', 'manual'].includes(prev?.stoppedReason) ? prev.stoppedReason : null,
    missingVerdicts: Math.max(0, Math.floor(Number(prev?.missingVerdicts) || 0)),
    stoppedDetail: String(prev?.stoppedDetail ?? '').slice(0, 300), // 정지 상세(blocked의 필요한 결정·done의 이유) — 화면 표시용
  };
}

// 회차 판정 표지(정규식·판정)는 src/loop-verdict.mjs — 1:1 화면의 표시용 제거와 같은 규칙을 쓴다. 예전 경로 그대로 다시 내보낸다.
export { LOOP_VERDICT_RE, parseLoopVerdict };
const LOOP_MISSING_LIMIT = 3; // 마커 연속 누락 허용 — CLI 러너가 형식을 못 지켜도 조용히 죽지 않되, 영영 헛돌지도 않게

const isLoopRoutine = (r) => r?.schedule?.type === 'interval' && !!r.loop;

/* ─── 완료 조건(verify) — "다 됐어요"를 산출물로 증명해야 완료 ─────────────────
   docs/ai-coding-harness-research.md 장치 1(Stop Hook)의 제품화: 루틴이 ok로 끝나도
   산출물이 실제로 없으면 완료가 아니다(실사고 계보: 루틴 51회 ok·배달 0회). 조건은
   사용자만 편집한다 — 크루에게는 "조건을 바꾸지 말고 산출물을 완성하라"만 전달된다. */

export const VERIFY_MAX_FILES = 5;
export const VERIFY_MAX_RETRIES = 3;

/** verify 정규화(순수) — { files: [vault 상대경로 1~5], contains?: 문구, retries: 1~3 }.
    빈/무효 입력은 null(조건 없음). 절대경로·상위 탈출(..)·널문자는 거부한다 — 판정이
    회사 기억(vault) 밖 파일시스템을 읽는 통로가 되면 안 된다(경로 게이트 계열 원칙). */
export function normalizeVerify(verify) {
  if (!verify || typeof verify !== 'object') return null;
  const rawFiles = Array.isArray(verify.files) ? verify.files : [];
  const files = [];
  for (const f of rawFiles) {
    const rel = String(f ?? '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
    if (!rel) continue;
    if (rel.length > 200) throw codedError('routine_verify_path_len', '완료 조건 파일 경로는 200자 이내');
    if (rel.startsWith('/') || /^[A-Za-z]:/.test(rel) || rel.includes('\0')) throw codedError('routine_verify_path_relative', '완료 조건 경로는 회사 기억 안 상대경로만');
    if (rel.split('/').includes('..')) throw codedError('routine_verify_path_traversal', '완료 조건 경로에 상위 탈출(..) 금지');
    if (!files.includes(rel)) files.push(rel);
  }
  if (!files.length) return null; // 파일 조건이 핵심 — 문구만으로는 조건이 성립하지 않는다
  if (files.length > VERIFY_MAX_FILES) throw codedError('routine_verify_files_max', `완료 조건 파일은 ${VERIFY_MAX_FILES}개까지`);
  const contains = String(verify.contains ?? '').trim().slice(0, 200) || null;
  let retries = Math.floor(Number(verify.retries ?? 2));
  if (!Number.isFinite(retries)) retries = 2;
  retries = Math.min(VERIFY_MAX_RETRIES, Math.max(1, retries));
  return { files, contains, retries };
}

/** 완료 조건 판정 — vault 루트 기준으로 각 파일의 존재(+모든 파일의 문구 포함)를 검사.
    반환 { ok, failures: [사람이 읽는 사유…] }. 경로 게이트 2단: ① resolve(어휘) 프리픽스
    — 오염 저장값 조기 차단, ② realpath(실경로) 프리픽스 — vault 안에 심어둔 심볼릭 링크가
    밖을 가리키면 따라가지 않는다(검수 MEDIUM-2: 게이트 대상인 크루 본인이 ln -s로 조건을
    우회할 수 있었다). Windows junction은 실측 못 했다 — realpath가 해석하는 한 같은 게이트를 탄다. */
export async function checkVerify(wsId, verify, { lang = 'ko' } = {}) {
  const { readFile, realpath } = await import('node:fs/promises');
  const { resolve, sep } = await import('node:path');
  const lexRoot = resolve(paths(wsId).vault);
  // vault 자체가 심링크 경유일 수 있다(macOS /tmp→/private/tmp 등) — 실경로 기준으로 비교
  const root = await realpath(lexRoot).catch(() => lexRoot);
  const outside = (rel) => (lang === 'en' ? `${rel}: outside company memory — not checked` : `${rel}: 회사 기억 밖 경로 — 검사 불가`);
  const failures = [];
  for (const rel of verify.files) {
    const abs = resolve(lexRoot, rel);
    if (abs !== lexRoot && !abs.startsWith(lexRoot + sep)) { failures.push(outside(rel)); continue; }
    let real = null;
    try { real = await realpath(abs); } catch { /* 부재 — 아래 파일 없음 사유로 */ }
    if (real !== null && real !== root && !real.startsWith(root + sep)) { failures.push(outside(rel)); continue; }
    try {
      const buf = await readFile(real ?? abs, 'utf8'); // 검사 통과한 실경로로 읽는다 — realpath와 readFile 사이 링크 교체(TOCTOU) 봉쇄
      if (verify.contains && !buf.includes(verify.contains)) {
        failures.push(lang === 'en' ? `${rel}: missing required text "${verify.contains}"` : `${rel}: 필수 문구 "${verify.contains}" 없음`);
      }
    } catch {
      failures.push(lang === 'en' ? `${rel}: file not found` : `${rel}: 파일 없음`);
    }
  }
  return { ok: failures.length === 0, failures };
}

/** 재시도 프롬프트 — 실패 목록을 그대로 전하되, 조건 완화가 아니라 산출물 완성을 요구한다
    ("테스트 말고 코드를 고쳐라"의 루틴판). (export: 테스트 앵커 — 실패 목록이 실리는지) */
export function verifyRetryPrompt(r, failures, attempt, lang) {
  const list = failures.map((f) => `- ${f}`).join('\n');
  if (lang === 'en') {
    return `${routineHead(r.title, 'en')} Completion check failed (attempt ${attempt}). The routine is NOT done until these are satisfied — do not relax or reinterpret the conditions; produce the deliverables:\n${list}\nOriginal instruction:\n${r.prompt}`;
  }
  return `${routineHead(r.title, 'ko')} 완료 조건 미충족(${attempt}차 시도). 아래가 채워질 때까지 이 루틴은 완료가 아니다 — 조건을 완화하거나 재해석하지 말고 산출물을 완성하라:\n${list}\n원래 지시:\n${r.prompt}`;
}

/** 루프 프로토콜 문단 — 회차·상한·지난 결과를 주고 마지막 줄 마커를 요구한다(러너 무관 — 텍스트 규약). */
function loopProtocol(r, lang) {
  const n = (r.loop.runs ?? 0) + 1;
  const last = String(r.lastResult ?? '').trim();
  const budget = r.loop.maxUsd != null ? (lang === 'en' ? ` Loop budget: $${r.loop.spentUsd.toFixed(2)} of $${r.loop.maxUsd} used.` : ` 루프 예산: $${r.loop.maxUsd} 중 $${r.loop.spentUsd.toFixed(2)} 사용.`) : '';
  if (lang === 'en') {
    return `${loopHead('en')} This is run ${n} of at most ${r.loop.maxRuns} in a repeating loop.${budget}\nPrevious run summary: ${last || '(none — first run)'}\nDo the next step of the work. The VERY LAST line of your answer must be exactly one of:\n\`${loopVerdictLine('continue')}\` — more to do next run\n\`${loopVerdictLine('done', ' <one-line reason>')}\` — the goal is reached, stop the loop\n\`${loopVerdictLine('blocked', ' <the decision you need from the user>')}\` — you cannot proceed without a human decision`;
  }
  return `${loopHead('ko')} 이것은 반복 루프의 ${n}회차 / 최대 ${r.loop.maxRuns}회다.${budget}\n지난 회차 결과 요약: ${last || '(없음 — 첫 회차)'}\n이번 회차 몫의 일을 진행하라. 답변의 **마지막 줄**은 반드시 다음 셋 중 하나로만 끝내라:\n\`${loopVerdictLine('continue')}\` — 다음 회차에 할 일이 남음\n\`${loopVerdictLine('done', ' <한 줄 이유>')}\` — 목표 달성, 루프 종료\n\`${loopVerdictLine('blocked', ' <사용자에게 필요한 결정>')}\` — 사람 결정 없이는 진행 불가`;
}

/** 정지 사유 문장 — 알림(emitNotify)에 그대로 실린다. */
function loopStopMessage(reason, detail, lang, loop) {
  const en = lang === 'en';
  switch (reason) {
    case 'done': return en ? `Loop finished — ${detail || 'goal reached'}` : `루프 완료 — ${detail || '목표 달성'}`;
    case 'blocked': return en ? `Loop paused — needs your decision: ${detail || '(no detail)'}. Approve in the inbox to resume.` : `루프 멈춤 — 결정이 필요합니다: ${detail || '(상세 없음)'}. 결재함에서 승인하면 재개됩니다.`;
    case 'maxRuns': return en ? `Loop stopped — reached the run limit (${loop.maxRuns}).` : `루프 정지 — 최대 반복(${loop.maxRuns}회)에 도달했습니다.`;
    case 'maxUsd': return en ? `Loop stopped — reached the loop budget ($${loop.maxUsd}).` : `루프 정지 — 루프 예산($${loop.maxUsd})에 도달했습니다.`;
    default: return en ? 'Loop stopped.' : '루프 정지.';
  }
}

/* ─── 보고할 것이 없을 때(NO_REPORT)·빈 답·실패와 놓친 회차의 기록 ───────────────────
   루틴이 '안 돌았다'는 제보의 대부분은 실행은 됐지만 실패했거나 건너뛴 경우였고, 그 사실이 화면에 남지 않았다(2026-10-07 조사 —
   실패 28건 중 대화 기록에 남은 것 0건, 4시간 넘게 놓친 회차는 흔적 없음, 'Codex 러너가 빈 응답' 12건은 "보고할 게 없으면 아무 말도
   하지 말라"는 지시에 모델이 빈 답을 낸 것). 아래 문구는 대화 기록·알림·목록에 그대로 나간다(회사 언어). */

const NO_REPORT = 'NO_REPORT';
const TXT = {
  noReportResult: { ko: '보고할 내용 없음', en: 'Nothing to report' },
  noReportThread: { ko: '보고할 내용 없음 — 알림을 보내지 않았습니다.', en: 'Nothing to report — no notification was sent.' },
  // 표지 줄과 다른 줄(설명·보고)이 같이 온 답 — 대화 기록에 그 줄들을 남기고, 왜 알림이 없는지 덧붙인다
  noReportNote: { ko: '(보고할 내용 없음으로 답해 알림을 보내지 않았습니다.)', en: '(Answered as nothing to report — no notification was sent.)' },
};
/** 루틴 턴에 덧붙이는 보고 규칙(러너 무관 — 텍스트 규약). chat의 runnerNote로 넘겨 **러너 프롬프트에만** 붙는다 — 지시 원문(대화 기록·일지·
    턴 이벤트 msg·활동 '다시 실행')에는 싣지 않는다(검수 LOW: 일지에 쌓이면 밤사이 기억 정리가 이 규약을 메모로 만들 수 있다).
    마지막 문장: 빈 답·NO_REPORT를 성공으로 받으면 도구 실패 때의 침묵을 가린다(검수 지적) — 확인을 못 했으면 그 사실을 보고하게 한다. */
function noReportRule(lang = 'ko') {
  return lang === 'en'
    ? `\n\n---\n[Report rule] If this run has nothing to tell the user (for example zero new items or no change), reply with exactly one line: ${NO_REPORT} — nothing else; no notification is sent then. If there is something to report, report as usual and do not write ${NO_REPORT}. If an error kept you from checking, do not reply ${NO_REPORT} — report what you could not check.`
    : `\n\n---\n[보고 규칙] 이번 실행에서 사용자에게 알릴 내용이 없으면(예: 확인할 새 항목 0건, 변동 없음) 다른 말 없이 정확히 ${NO_REPORT} 한 줄만 답하라 — 그러면 알림이 가지 않는다. 알릴 내용이 있으면 평소대로 보고하고 ${NO_REPORT}는 쓰지 마라. 오류로 확인하지 못했다면 ${NO_REPORT}가 아니라 무엇을 확인하지 못했는지 보고하라.`;
}
// 표지 = 줄 머리의 NO_REPORT(대소문자 무시). 앞: 공백·인용(>)·목록 기호(- + • · 1. 1))·굵게·기울임·백틱·따옴표. 뒤: 닫는 꾸밈과 한국어 서술어('입니다'·'임').
// 줄 머리가 아니면(문장 속 '오늘은 NO_REPORT 대상이 아닙니다') 표지가 아니다. 서술어 뒤에 글자가 이어지는 'NO_REPORT입니다만 …'은 아래 noReportMark가 거른다.
const NO_REPORT_HEAD = /^[\s>]*(?:(?:[-+•·]|\d{1,3}[.)])\s+)?[\s>*_`"'“”]*no_report[*_`"'“”]*(?:\s*(?:입니다|임))?[*_`"'“”]*/iu;
const NO_REPORT_END = /^[\s*_`"'“”.。!]*$/u; // 표지 뒤가 마침표·꾸밈뿐 — 표지 줄
const NO_REPORT_SEP = /^\s*(?:[:：(（–—]|[-.。!](?=\s|$))/u; // 표지 뒤가 구분 기호 — 같은 줄 설명('NO_REPORT — 새 항목 0건', 'NO_REPORT (새 메일 없음)')
/** 한 줄이 표지인가 — 아니면 null, 맞으면 { note: 같은 줄 설명(없으면 '') }. 표지 뒤가 글자로 바로 이어지면('NO_REPORT였던', 'NO_REPORT 대상이 아닙니다',
    'NO_REPORTS') 표지가 아니다 — 보고로 둔다(알림을 잘못 막는 것보다 보내는 쪽이 안전). */
const NO_REPORT_LINE_MAX = 400; // 표지 줄은 짧다(꾸밈 + 60자 설명). 아래 정규식은 앞쪽 문자 집합(공백·>)이 겹쳐 머리가 맞지 않는 긴 줄에서 되짚기가 제곱으로 는다
function noReportMark(line) {
  if (line.length > NO_REPORT_LINE_MAX) return null; // 공백 5만 칸 + 'x no_report' 한 줄이 판정 한 번에 4초 걸렸다(검수 LOW) — 긴 줄은 표지가 아니다(보고로 보낸다)
  if (!/no_report/i.test(line)) return null; // 대부분의 줄은 여기서 끝난다
  const m = line.match(NO_REPORT_HEAD);
  if (!m) return null;
  const rest = line.slice(m[0].length);
  if (NO_REPORT_END.test(rest)) return { note: '' };
  if (!NO_REPORT_SEP.test(rest)) return null;
  return { note: rest.replace(/^[\s:：\-–—.。!]+/u, '').trim().replace(/^[(（](.*)[)）]$/u, '$1').trim() };
}
const FENCE_LINE = /^\s*(`{3,}|~{3,})[\w-]*\s*$/;
// 내용 줄 = 빈 줄·펜스 줄·보이지 않는 문자(U+200B 등)만 있는 줄이 아닌 줄. 'NO_REPORT\n\u200b'가 내용 두 줄로 보여 빈 알림이 나갔다(검수 LOW).
const BLANK_LINE = /^[\s\p{Default_Ignorable_Code_Point}]*$/u;
const isContent = (line) => !BLANK_LINE.test(line) && !FENCE_LINE.test(line);
const QUOTE_LINE = /^\s*>/;
const FENCE = /^\s*(`{3,}|~{3,})(.*)$/s;
/** 줄마다 코드 블록 안인가(펜스 줄 자신은 false). 닫는 펜스 = 여는 펜스와 같은 문자·그 이상 길이·뒤에 글자 없음. 닫히지 않으면 끝까지 코드 블록. */
function codeBlockLines(lines) {
  let open = null; // 여는 펜스('```'·'~~~~' …)
  return lines.map((line) => {
    const m = line.match(FENCE);
    if (open) {
      if (m && m[1][0] === open[0] && m[1].length >= open.length && !m[2].trim()) open = null;
      return open !== null;
    }
    if (m && !(m[1][0] === '`' && m[2].includes('`'))) open = m[1]; // 백틱 펜스의 정보 문자열에는 백틱이 없다(줄 안 코드 '```a```'는 펜스가 아니다)
    return false;
  });
}
/** 답의 NO_REPORT 판정(순수). marked면 알림·메신저 글을 보내지 않고, text(같은 줄 설명, 없으면 '')만 대화 기록에 남긴다. 아니면 보고. */
// 보안 검토(2026-10-08, 알림 억제): '표지 줄이 어디든 있으면 보고 없음'은 루틴이 읽은 바깥 글(메일 본문 등)에 NO_REPORT 한 줄을 심으면
// 그 글을 인용한 보고 전체가 알림 없이 사라진다. 그래서 내용 줄이 표지 한 줄뿐일 때만 보고 없음으로 본다 — 같은 줄 설명은 60자까지
// (그보다 길면 바깥 글이 한 줄 답을 유도해 보고를 표지 뒤에 숨기는 경로가 된다 — 보고로 보낸다).
// 표지가 다른 줄과 같이 오면 보고로 보낸다(알림을 잘못 막는 것보다 한 번 더 보내는 쪽이 안전하다).
const NO_REPORT_NOTE_MAX = 60;
function splitNoReport(text) {
  const raw = String(text ?? '');
  const lines = raw.split('\n');
  const content = lines.filter(isContent);
  if (content.length === 1) {
    const mark = noReportMark(content[0]);
    if (mark && mark.note.length <= NO_REPORT_NOTE_MAX) return { marked: true, text: mark.note };
  }
  // 보고로 보낼 때도 따로 떨어진 표지 줄(설명 없는 'NO_REPORT')은 엔진용이라 뗀다 — 알림·대화 기록에 토큰이 그대로 보이지 않게(검수 지적).
  // 인용(>) 줄과 코드 블록 속 줄은 바깥 글(메일 본문·명령 출력)일 가능성이 높아 떼지 않는다 — 주입 흔적이 사용자에게 보이게(보안 검토).
  // 그래서 떼는 줄은 언제나 코드 블록 밖이라 펜스 짝을 건드릴 일이 없다(옛 빈 블록 정규식은 앞 블록의 닫는 펜스와 뒤 블록의 여는 펜스를 빈 블록으로 보고
  // 지워 두 블록을 합쳤다 — 검수 MEDIUM). 같은 줄 설명이 붙은 줄은 보고 내용일 수 있어 그대로 둔다. 다 떼고 남는 내용이 없으면(표지 줄만 여러 개) 보고 없음.
  const inCode = codeBlockLines(lines);
  const kept = lines.filter((line, i) => {
    if (inCode[i] || QUOTE_LINE.test(line)) return true;
    const m = noReportMark(line);
    return !(m && !m.note);
  });
  if (kept.length === lines.length) return { marked: false, text: raw };
  if (!kept.some(isContent)) return { marked: true, text: '' };
  return { marked: false, text: kept.join('\n').replace(/\n{3,}/g, '\n\n').trim() };
}
/** 빈 답 — 실패 그대로(빈 답을 성공으로 받으면 도구 실패 때의 침묵을 가린다). 문구만 사용자가 알아듣게. 루프에는 보고 규칙이 없어 안내를 붙이지 않는다. */
function emptyAnswerError(lang, loop, cause = null) {
  const msg = lang === 'en'
    ? `The agent returned no answer at all${loop ? '' : ` (when there is nothing to report, it is now asked to reply ${NO_REPORT})`}`
    : `에이전트가 아무 답도 내지 않았습니다${loop ? '' : `(보고할 것이 없을 때는 ${NO_REPORT}로 답하도록 바뀌었습니다)`}`;
  return Object.assign(new Error(msg), cause ? { cause } : {});
}
const failedText = (reason, lang) => (lang === 'en' ? `This routine run failed — ${reason}` : `루틴 실행에 실패했습니다 — ${reason}`);
/** 놓친 회차 안내 한 줄 — 다음 실행의 대화 기록·건너뜀 알림이 같이 쓴다. 사실만 말한다: '4시간 안에 켜져 있으면 실행된다'는 isDue가 날짜를 넘겨
    따라잡지 않아(23:00 회차는 00:30에 켜져도 실행되지 않는다) 맞지 않는다(3차 검수 LOW). 활동 화면 문구(i18n activity.routineSkipped)도 같은 내용. */
function missedNote(slots, lang) {
  const list = formatMissedSlots(slots, lang);
  return lang === 'en'
    ? `${(slots?.length ?? 0) > 1 ? 'These runs were' : 'This run was'} skipped because this device was off or asleep at the scheduled time: ${list}.`
    : `${list} 회차는 예정 시각에 기기가 꺼져 있었거나 잠들어 있어 실행하지 못했습니다.`;
}
const companyLang = async (wsId) => {
  const { loadCompany } = await import('./workspace.mjs');
  return (await loadCompany(wsId).catch(() => ({}))).lang === 'en' ? 'en' : 'ko';
};

/** 놓친 회차를 남긴다 — 스케줄러 틱(클라우드 리더 기기)이 부른다. routines = 이번 틱에 읽은 목록: 잠금 없이 먼저 판정해
    **새로 놓친 회차가 없으면 쓰기·잠금 0**(유휴 틱). 있으면 잠금 안에서 다시 읽고 판정해 routine.missed에 더한다(다음 실행이 대화 기록에
    한 줄로 남기고 비운다 — 같은 회차를 두 번 알리지 않는 표지도 이것). 그리고 루틴마다 활동 기록 한 줄 + 알림 한 건(기존 알림 설정을
    그대로 탄다 — phase 'skipped', runAt = 마지막 놓친 슬롯이라 직전 실행의 배달 기록을 덮지 않는다). hasCrew = 에이전트 카드 판정(실행
    건너뜀과 같은 기준 — 카드 없는 루틴은 남기지 않는다). 반환: 새로 남긴 [{ routine, slots }]. */
export async function recordMissedSlots(wsId, routines, now = new Date(), { hasCrew = async () => true } = {}) {
  const fresh = (r) => { const seen = new Set((r.missed ?? []).map((m) => m?.at)); return missedSlots(r, now).filter((x) => !seen.has(x.at)); };
  const ids = new Set();
  for (const r of routines ?? []) if (fresh(r).length && await hasCrew(r.agentSlug)) ids.add(r.id);
  if (!ids.size) return [];
  const keepFrom = now.getTime() - MISSED_LOOKBACK_DAYS * 86_400_000; // 판정 기간 밖의 표지는 더 막을 게 없다 — 쌓이지 않게 정리
  const found = await lockRoutines(wsId, async () => {
    const list = await loadRoutines(wsId);
    const out = [];
    for (const r of list) {
      if (!ids.has(r.id)) continue;
      const slots = fresh(r);
      if (!slots.length) continue;
      r.missed = [...(r.missed ?? []).filter((m) => Date.parse(m?.at) >= keepFrom), ...slots];
      out.push({ routine: { ...r }, slots });
    }
    if (out.length) await saveRoutines(wsId, list);
    return out;
  });
  if (!found.length) return [];
  const { appendEvent } = await import('./events.mjs');
  const lang = await companyLang(wsId);
  for (const { routine: r, slots } of found) {
    await appendEvent(wsId, { type: 'routine-skipped', ok: false, slug: r.agentSlug, routineId: r.id, title: r.title, slots: slots.map(({ date, time }) => ({ date, time })) });
    // lastRun = 마지막 놓친 슬롯 — 메신저 글의 중복 방지 키(종류·루틴·lastRun·phase)가 놓친 날마다 달라야 한다. 저장된 lastRun 그대로면
    // 실행 없이 여러 날 놓친 루틴의 두 번째 건너뜀 글이 첫 글과 같은 키로 버려진다.
    const at = slots.at(-1).at;
    emitNotify({ type: 'routine', wsId, runAt: at, phase: 'skipped', ok: false, reply: missedNote(slots, lang), routine: { ...r, lastRun: at } });
  }
  return found;
}

/** 결재 승인 후 재개 — approval-actions(kind:'loop')가 부른다. 거절이면 부르지 않는다(정지 유지). */
export async function resumeLoop(wsId, id) {
  // 재검수(2차): 결재로 재개하는 것도 사람이 한 결정 — editedAt을 찍는다(메신저의 "나중 수정이 이긴다" 판정이 이 재개를 안다).
  return patchRoutine(wsId, id, (r) => (isLoopRoutine(r)
    ? { enabled: true, editedAt: new Date().toISOString(), loop: { ...r.loop, stoppedReason: null, stoppedDetail: '', missingVerdicts: 0 } }
    : { enabled: true, editedAt: new Date().toISOString() }));
}

/** 이 기기의 시간대 — 로컬 우선 제품이라 서버는 사용자 컴퓨터에서 돈다. 즉 여기서 읽은 시간대가
    곧 사용자의 시간대다(한국 사용자면 Asia/Seoul). 클라이언트가 tz를 보내면 그쪽이 우선. */
const hostTz = () => { try { return new Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch { return null; } };

export async function addRoutine(wsId, { agentSlug, title, prompt, schedule, enabled = true, loop = null, verify = null, msgr = null, notifications, from = null }) { // from = 사장 직접 턴이 아닌 턴(또는 다른 크루에게 건 예약)의 시작점 크루 — 실행 턴이 풀 오토가 아니다
  if (!agentSlug || !title?.trim() || !prompt?.trim()) throw codedError('routine_fields_required', '에이전트·제목·지시가 필요합니다');
  if (msgr && msgr.wsId !== wsId) throw new Error('메신저 예약 회사 불일치');
  const destinations = await validateRoutineNotifications(wsId, agentSlug, notifications);
  const sched = normalizeSchedule({ tz: hostTz(), ...schedule });
  const ver = sched.type === 'interval' ? null : normalizeVerify(verify); // 자율 루프는 자체 판정(LOOP:)이 있어 1차 범위 밖
  const routine = {
    id: `r${Date.now().toString(36)}`,
    agentSlug, title: title.trim(), prompt: prompt.trim(),
    // 만들 때 시간대를 각인한다 — 이후 어느 기기(클라우드 워커 포함)가 돌려도 만든 사람의 시각으로
    // 발화한다. 명시값이 있으면 그것을, 없으면 이 기기(=사용자 컴퓨터)의 시간대를 쓴다.
    schedule: sched,
    enabled,
    created: new Date().toISOString(),
    // editedAt = 사람이 내용을 고친 시각만(생성도 사람이 한 일이므로 찍는다) — 실행(runRoutine)은 안 찍는다.
    // 메신저 미러의 "나중 수정이 이긴다" 판정과 미러 스냅샷 해시가 이 값을 쓴다(분리 검수 H1).
    editedAt: new Date().toISOString(),
    lastRun: null, lastOk: null, lastResult: '',
    ...(destinations !== undefined ? { notifications: destinations } : {}),
    // 루프 — interval에만. 다른 타입에 loop가 오면 조용히 버린다(의미 없는 필드를 저장하지 않는다)
    ...(sched.type === 'interval' && loop ? { loop: normalizeLoop(loop) } : {}),
    ...(ver ? { verify: ver } : {}),
    ...(msgr ? { msgr: (await import('./gateway/msgr-handoff.mjs')).messengerOrigin({ ...msgr, kind: 'msgr' }) } : {}),
    // 출처 — 있으면 실행 때 notOwnerDirect로 잇는다(풀 오토 아님). 없으면(사장이 만든 것·사장 직접 턴에서 자기 일로 만든 것·이 필드 전의 옛 루틴) 종전대로
    ...(typeof from === 'string' && from ? { from } : {}),
  };
  return lockRoutines(wsId, async () => {
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
    if (!patch.title?.trim()) throw codedError('routine_title_required', '제목이 필요합니다');
    out.title = patch.title.trim();
  }
  if ('prompt' in patch) {
    if (!patch.prompt?.trim()) throw codedError('routine_prompt_required', '지시가 필요합니다');
    out.prompt = patch.prompt.trim();
  }
  if ('agentSlug' in patch) {
    if (!patch.agentSlug) throw codedError('routine_crew_required', '에이전트가 필요합니다');
    out.agentSlug = patch.agentSlug;
  }
  if ('schedule' in patch) out.schedule = normalizeSchedule(patch.schedule);
  if ('enabled' in patch) out.enabled = !!patch.enabled;
  if ('notifications' in patch) out.notifications = normalizeRoutineNotifications(patch.notifications);
  if ('verify' in patch) out.verify = patch.verify && typeof patch.verify === 'object' ? { files: patch.verify.files, contains: patch.verify.contains, retries: patch.verify.retries } : null;
  // loop 설정(maxRuns/maxUsd)만 통과 — 카운터 병합·interval 여부 판정은 updateRoutine이 현재 루틴을 보고 한다
  if ('loop' in patch) out.loop = patch.loop && typeof patch.loop === 'object' ? { maxRuns: patch.loop.maxRuns, maxUsd: patch.loop.maxUsd } : null;
  return out;
}

/** opts.from — 사장 직접 턴이 아닌 턴이 고칠 때(cancel_routine의 다시 켜기) 그 크루로 출처를 바꾼다. 사람 편집(API·화면)은 출처를 지우거나 바꾸지 않는다(화이트리스트 밖). */
export async function updateRoutine(wsId, id, patch, { from = null } = {}) {
  const clean = sanitizeRoutinePatch(patch);
  // 목표 하트비트는 루틴 편집 경로(화면·API·메신저 편집·cancel_routine)로 바꾸지 않는다 — 켜고 끄기도 목표의 상태(일시 정지·끝)와 같이 움직여야 해서 goal-heartbeat.mjs만 쓴다
  if (isGoal((await loadRoutines(wsId)).find((r) => r.id === id))) throw codedError('routine_is_goal', '목표 하트비트는 루틴 화면의 목표 목록에서 바꿉니다');
  if ('notifications' in clean || 'agentSlug' in clean) {
    const before = (await loadRoutines(wsId)).find((r) => r.id === id);
    if (!before) throw codedError('routine_not_found', '루틴을 찾을 수 없습니다');
    if ('notifications' in clean && clean.notifications === undefined) throw new Error('Invalid routine notification channels');
    const next = 'notifications' in clean ? clean.notifications : before.notifications;
    const changed = JSON.stringify(next) !== JSON.stringify(before.notifications)
      || ('agentSlug' in clean && clean.agentSlug !== before.agentSlug);
    if (changed) await validateRoutineNotifications(wsId, clean.agentSlug ?? before.agentSlug, next);
  }
  const r = await patchRoutine(wsId, id, (cur) => {
    const out = { ...clean, editedAt: new Date().toISOString(), ...(typeof from === 'string' && from ? { from } : {}) }; // 사람 편집 경로(H1) — patchRoutine 자체는 더 이상 이 값을 안 찍는다
    const nextSched = out.schedule ?? cur.schedule;
    if ('verify' in out) out.verify = nextSched?.type === 'interval' ? null : normalizeVerify(out.verify);
    else if (nextSched?.type === 'interval' && cur.verify) out.verify = null; // interval로 바꾸면 기존 조건도 비운다
    if (nextSched?.type !== 'interval') {
      // interval이 아닌 루틴엔 loop가 없다 — 패치의 loop는 무시하고, 타입을 바꿨으면 기존 루프 상태도 비운다
      if (cur.loop || 'loop' in out) out.loop = null; else delete out.loop;
      return out;
    }
    if ('loop' in out) out.loop = out.loop ? normalizeLoop(out.loop, cur.loop) : null;
    const base = out.loop ?? cur.loop;
    if (base && 'enabled' in out) {
      // 수동 정지 = stoppedReason 'manual'(이미 사유가 있으면 유지). 다시 켜면 사유·누락 카운터를 비운다(지금 재개)
      out.loop = out.enabled
        ? { ...base, stoppedReason: null, stoppedDetail: '', missingVerdicts: 0 }
        : { ...base, stoppedReason: base.stoppedReason ?? 'manual' };
    }
    return out;
  });
  if (!r) throw codedError('routine_not_found', '루틴을 찾을 수 없습니다');
  return r;
}

/** 해고한 크루의 루틴을 끈다(지우지 않는다 — 제목·지시·일정은 남겨 다른 크루로 바꿔 다시 켤 수 있게). 켜진 채 남으면 예약마다
    "없는 크루" 실패 알림이 갔다(F4, 2026-10-05). editedAt — 사람의 행동(해고)에서 나온 변경이라 메신저 대기 편집보다 나중으로 친다.
    반환: 끈 루틴 수. */
export async function disableRoutinesForCrew(wsId, slug) {
  return lockRoutines(wsId, async () => {
    const routines = await loadRoutines(wsId);
    const at = new Date().toISOString();
    let n = 0;
    for (const r of routines) {
      if (r.agentSlug !== slug || (!r.enabled && !(isGoal(r) && r.goal.status === 'paused'))) continue; // 일시 정지한 목표 하트비트도 끝낸다(남으면 동시 개수 자리를 차지한다)
      r.enabled = false; r.editedAt = at; n += 1;
      if (r.loop) r.loop = { ...r.loop, stoppedReason: r.loop.stoppedReason ?? 'manual' }; // 루프 정지 사유(수동)와 같은 표시
      if (isGoal(r) && !['done', 'blocked', 'expired', 'failed'].includes(r.goal.status)) r.goal = { ...r.goal, status: 'stopped', endedAt: at, outbox: null, claim: null }; // 해고한 에이전트의 목표 하트비트는 끝(남은 알림도 보내지 않는다 — 보낼 에이전트가 없다)
    }
    if (n) await saveRoutines(wsId, routines);
    return n;
  });
}

export async function removeRoutine(wsId, id) {
  return lockRoutines(wsId, async () => {
    const routines = await loadRoutines(wsId);
    await saveRoutines(wsId, routines.filter((x) => x.id !== id));
  });
}

/** 루틴 실행 — 새 세션 1턴. 결과 요약을 루틴에 기록(전체는 vault 핸드오버에).
    chat()은 수 분 걸리므로 락 밖에서 돌리고, 결과 기록만 락 안에서 해당 루틴 필드에 반영한다
    — 실행 도중 사용자가 다른 루틴을 지우거나 이 루틴을 꺼도 낡은 전체 스냅샷으로 되돌리지 않는다. */
export async function runRoutine(wsId, id, { chatFn = null, startAt = null, session } = {}) {
  // 목표 하트비트 — 같은 스케줄러 선점(lastRun)을 거쳐 왔다. 실행은 목표 엔진이 한다(동적 임포트 — chat과 같은 순환 차단 이유)
  if (isGoal((await loadRoutines(wsId)).find((r) => r.id === id))) return (await import('./goal-heartbeat.mjs')).runGoal(wsId, id, { chatFn });
  // startAt = 테스트 전용(시작 시각 주입) — "시작이 예약 시각을 가로지르는 실행"은 실제 분 경계를
  // 기다리지 않고는 재현할 수 없다(catch의 once 끄기 판정 시계가 이 각인을 쓴다).
  // 시작 각인과 함께 놓친 회차 표지(missed — 스케줄러 recordMissedSlots)를 꺼내 비운다: 이번 실행이 대화 기록에 한 줄로 남긴다(같은 회차를 두 번 남기지 않게).
  let pendingMissed = null;
  const r0 = await patchRoutine(wsId, id, (cur) => {
    pendingMissed = Array.isArray(cur.missed) && cur.missed.length ? cur.missed : null;
    return { lastRun: (startAt ?? new Date()).toISOString(), ...('missed' in cur ? { missed: undefined } : {}) };
  });
  if (!r0) throw codedError('routine_not_found', '루틴을 찾을 수 없습니다');
  // Edits apply to the next execution: never send an in-flight result to a newly chosen recipient.
  const resultRoutine = (current) => ({ ...(current ?? r0), title: r0.title, agentSlug: r0.agentSlug,
    lastRun: r0.lastRun, notifications: r0.notifications, msgr: r0.msgr });
  const loop = isLoopRoutine(r0);
  // 회사 언어 — 루프·완료 조건 재시도 지시(검수 MEDIUM-1), 보고 규칙, 실패·건너뜀 안내가 쓴다
  const lang = await companyLang(wsId);
  // 대화 기록 범위 — 성공 턴이 chat에서 받는 범위(contextScope)와 같게: 메신저발은 그 채널, 그 밖은 결과가 나가는 목적지(briefingCtx).
  // 실패·건너뜀 안내처럼 chat을 거치지 않는 기록도 이 범위로 남아야 공유 목적지의 기록이 주인 1:1 맥락에 섞이지 않는다.
  const destCtx = async () => (await import('./gateway.mjs')).briefingCtx(wsId, 'routine', r0.agentSlug, { notifications: r0.notifications });
  const recordScope = async () => {
    const { turnScope } = await import('./thread.mjs');
    return r0.msgr ? turnScope({ ...r0.msgr, kind: 'msgr' }) : turnScope(await destCtx());
  };
  // 사람이 읽는 지시(대화 기록·1:1 화면 카드·일지·턴 이벤트가 읽는 모양) — 루프가 아니면 보고 규칙(NO_REPORT)을 runnerNote로 러너 프롬프트에만 붙인다
  const userMsg = `${routineHead(r0.title, 'ko')} ${r0.prompt}${loop ? loopProtocol(r0, lang) : ''}`;
  let pending = userMsg; // 아직 대화 기록에 답과 짝지어 남기지 못한 지시 — 실패하면 실패 안내를 그 답 자리에 두고 남긴다(chat 전 실패 포함)
  // 루프 정지 알림 — blocked면 사장 결재로 푼다(승인 → approval-actions(kind:'loop')가 resumeLoop, 거절 → 정지 유지). 성공·실패 경로 공용.
  const announceStop = async (r, stop, msgr) => {
    if (stop.reason === 'blocked') {
      const { addApproval } = await import('./approvals.mjs');
      await addApproval(wsId, {
        slug: r0.agentSlug, kind: 'loop',
        action: lang === 'en' ? `Resume loop — ${r0.title}`.slice(0, 300) : `루프 재개 — ${r0.title}`.slice(0, 300),
        reason: stop.detail, payload: { routineId: id },
        // 회차 턴의 기록(msgr — 이어 실행 근거 포함)이 없으면(실패 회차) 저장된 예약 기록에 예약 근거를 붙인다 — 이 결재도 예약의 이어 실행이다(카드 출처 = 원래 글, 실행 완료)
        ...(r0.msgr ? { msgr: msgr ?? { ...r0.msgr, continuation: { kind: 'routine' } } } : {}),
      }).catch((e) => console.error(`[argo] 루프 결재 등록 실패(${wsId}/${id}):`, e.message));
    }
    emitNotify({ type: 'routine', wsId, runAt: r0.lastRun, routine: resultRoutine(r), phase: 'stop', ok: true, reply: loopStopMessage(stop.reason, stop.detail, lang, r?.loop ?? r0.loop) });
  };
  try {
    const chat = chatFn ?? (await import('./chat.mjs')).chat; // 순환 차단 — 파일 상단 주석 참조. chatFn=테스트 주입(실 러너 불필요)
    // runnerNote = 러너 프롬프트에만 붙는 덧붙임(보고 규칙) — 지시 원문(message)과 따로 넘긴다(chat.mjs runnerNote)
    const run = r0.msgr
      ? async (message, runnerNote = '') => (await import('./gateway/msgr.mjs')).runMessengerContinuation(wsId, r0.agentSlug, r0.msgr, message, null, { runChat: chat, session, loopTurn: loop, continuation: { kind: 'routine' }, ...(r0.from ? { notOwnerDirect: r0.from } : {}), ...(runnerNote ? { runnerNote } : {}) }) // loopTurn — 채널 글에서 판정 표지를 넘김 줄 앞에서 뺀다 · continuation = 예약 턴이 올리는 결재 카드의 이어 실행 근거
      : async (message, runnerNote = '') => {
        // 결과가 공유 목적지(슬랙 채널·텔레그램 그룹·메신저 채널)로 나가면 그 범위 맥락만 — 주인 대화를 붙이지 않는다(gateway briefingCtx, 동적 임포트 = 순환 차단)
        const ctx = await destCtx();
        return chat(wsId, r0.agentSlug, message, null, { source: 'routine', ...(ctx ? { mirrorCtx: ctx } : {}), ...(r0.from ? { notOwnerDirect: r0.from } : {}), ...(runnerNote ? { runnerNote } : {}) }); // 출처 있는 루틴 = 풀 오토 아님(출처·프롬프트는 그대로)
      };
    // 빈 답은 실패다(성공으로 받으면 도구 실패 때의 침묵을 가린다) — 러너 무관하게 여기서 한 번 판정하고 문구를 알아듣게 바꾼다.
    // CLI 경로는 chat이 빈 답을 이미 던진다(emptyReply 표지 — 대화 턴 문구는 그대로 두고 루틴에서만 바꾼다), SDK·네이티브 경로는 빈 문자열이 돌아온다.
    // 메신저발은 판정 표지·넘김 줄을 뗀 뒤의 본문(reply)과 원문(replyForChecks)이 둘 다 비어야 빈 답이다(루프 판정 줄만 있는 답은 빈 답이 아니다).
    const runTurn = async (message, runnerNote) => {
      let t;
      try { t = await run(message, runnerNote); } catch (e) { throw e?.emptyReply ? emptyAnswerError(lang, loop, e) : e; }
      if (!String(t?.reply ?? '').trim() && !String(t?.replyForChecks ?? '').trim()) throw emptyAnswerError(lang, loop);
      return t;
    };
    // 대화 기록의 답 — NO_REPORT 표지는 엔진용이라 화면에 그대로 두지 않는다(루프는 표지 규칙 밖). 표지와 같이 온 설명은 여기(대화 기록)에만 남는다.
    const recorded = (t) => {
      if (loop) return t.reply;
      const nr = splitNoReport(t.reply);
      if (!nr.marked) return nr.text;
      return nr.text ? `${nr.text}\n\n${TXT.noReportNote[lang]}` : TXT.noReportThread[lang];
    };
    // 한 턴 = 실행 + 대화 기록(지시와 답을 짝지어). 루틴만 기록이 빠져 있어서 실행 중엔 채팅창에 보이다가 끝나면 사라졌다
    // (신고 2026-07-28 "루틴 돌면서 채팅이 올라왔다가 실행되고 나니 유실") — 사장 직접 대화·위임·쪽지 배달은 전부 appendTurn을 한다.
    // 기록은 chat **직후**(완료 조건 검사 전) — 재시도·최종 실패(throw)와 무관하게 모든 턴이 자기 지시와 짝지어 남는다.
    // 기록 실패는 무증상으로 삼키지 않는다(비용은 나갔는데 화면에 없다 — scheduler의 쪽지 경로와 동일 규칙). 루틴 결과는 막지 않는다.
    // pending은 이 함수 하나가 세우고 비운다(첫 실행·재시도 공용) — 기록 뒤의 어떤 실패에서도 catch가 지시를 두 번 쓰지 않는다.
    const recordedTurn = async (message, runnerNote = '') => {
      pending = message;
      const t = await runTurn(message, runnerNote);
      const { appendTurn } = await import('./thread.mjs');
      await appendTurn(wsId, r0.agentSlug, { userMsg: message, reply: recorded(t), handover: t.handover, sessionId: null, via: 'routine', artifacts: t.artifacts, contextScope: t.contextScope })
        .catch((e) => console.error(`[argo] 루틴 스레드 기록 실패(${wsId}/${r0.agentSlug}):`, e.message));
      pending = null;
      return t;
    };
    if (pendingMissed) { // 지난 실행 뒤 건너뛴 회차 — 이번 실행의 지시 앞에 루틴에서 온 글 한 줄로(같은 날 여러 회차는 한 묶음)
      const { appendLine } = await import('./thread.mjs');
      const scope = await recordScope().catch(() => null);
      await appendLine(wsId, r0.agentSlug, { who: 'user', via: 'routine', text: `${routineHead(r0.title, 'ko')} ${missedNote(pendingMissed, lang)}`, ...(scope ? { contextScope: scope } : {}) })
        .catch((e) => console.error(`[argo] 루틴 건너뜀 기록 실패(${wsId}/${r0.agentSlug}):`, e.message));
    }
    // 완료 조건 저장값 정규화는 chat **전** — 오염된 저장값이면 LLM 비용을 쓰기 전에 실패하고,
    // 사유에 루틴 제목을 붙여 어느 설정 문제인지 드러낸다(검수 LOW-2).
    let ver = null;
    if (r0.verify && !loop) {
      try { ver = normalizeVerify(r0.verify); } catch (e) {
        throw new Error(lang === 'en' ? `[${r0.title}] completion check config invalid: ${e.message}` : `[${r0.title}] 완료 조건 설정 오류: ${e.message}`);
      }
    }
    let t = await recordedTurn(userMsg, loop ? '' : noReportRule(lang));
    // 완료 조건(verify) — 산출물이 실제로 없으면 "다 됐어요"를 인정하지 않는다. 미충족이면 실패
    // 목록을 그대로 들려 재시도(retries회), 그래도 미충족이면 throw로 기존 실패 표면
    // (lastOk:false + 알림)에 정직하게 태운다.
    if (ver) {
      let verifyTried = 0;
      let res = await checkVerify(wsId, ver, { lang });
      while (!res.ok && verifyTried < ver.retries) {
        verifyTried += 1;
        const retryMsg = verifyRetryPrompt(r0, res.failures, verifyTried + 1, lang);
        t = await recordedTurn(retryMsg); // 재시도는 산출물을 요구하는 지시 — 보고 규칙(NO_REPORT)을 붙이지 않는다
        res = await checkVerify(wsId, ver, { lang });
      }
      if (!res.ok) {
        const tried = verifyTried + 1; // 최초 1회 + 재시도
        throw new Error(lang === 'en'
          ? `Completion check failed after ${tried} attempt(s): ${res.failures.join(' · ')}`
          : `완료 조건 미충족(${tried}회 시도): ${res.failures.join(' · ')}`);
      }
    }
    // 사용자에게 나가는 답(알림 이벤트 → 텔레그램·슬랙·메신저, 마지막 결과 요약, 지금 실행 응답) — 루프 회차 답 끝의 판정 표지(LOOP: …)는
    // 엔진용이라 여기서 한 번만 뺀다. 판정(아래 parseLoopVerdict)과 1:1 대화 기록은 원문 그대로. 메신저발 루프는
    // runMessengerContinuation(loopTurn)이 넘김 줄을 붙이기 전에 이미 뺐다 — 두 번 빼지 않는다.
    // 보고할 것이 없음 — 답에 NO_REPORT 표지가 있음(다른 줄·같은 줄 설명이 같이 와도 — 그 설명은 대화 기록에만) 또는 루프 회차 답이 판정 줄뿐.
    // 이때는 알림·메신저 글을 보내지 않는다(제목만 있는 글이 갔다). 결과 요약·지금 실행 응답은 알아듣는 말로.
    let shown = loop ? (r0.msgr ? t.reply : stripLoopVerdict(t.reply)) : (() => { const nr = splitNoReport(t.reply); return nr.marked ? '' : nr.text; })();
    const quiet = !String(shown).trim();
    if (quiet) shown = TXT.noReportResult[lang];
    const summary = shown.replace(/\s+/g, ' ').slice(0, 160);
    // 1회 예약은 **성공하면** 스스로 꺼진다 — 산출이 이미 나갔으니 예약 시각에 또 보내지 않는다
    // (미래 예약을 미리 시험해 성공한 경우도 동일 — 이중 발송 방지). 실패는 catch가 다르게 다룬다.
    // 당일 자동 재시도는 없다: 시작 시 lastRun을 각인하므로 isDue가 같은 슬롯을 다시 due로 만들지
    // 않는다(검수 LOW-3 실측 — 옛 주석 "켜둬 당일 재시도 허용"은 거짓이었다).
    const patch = { lastOk: true, lastResult: summary };
    let stop = null; // { reason, detail }
    if (loop) {
      const v = parseLoopVerdict(t.replyForChecks ?? t.reply);
      const L = { ...normalizeLoop(r0.loop, r0.loop) };
      L.runs += 1;
      L.spentUsd = Math.round((L.spentUsd + (Number(t.costUsd) || 0)) * 10000) / 10000; // 구독(OAuth)·CLI 턴은 costUsd null → 0
      L.lastVerdict = v.verdict;
      L.missingVerdicts = v.missing ? L.missingVerdicts + 1 : 0;
      // 정지 조건 — 먼저 걸린 하나만 사유로 남긴다(판정 > 누락 상한 > 회차 > 예산)
      if (v.verdict === 'done') stop = { reason: 'done', detail: v.reason };
      else if (v.verdict === 'blocked') stop = { reason: 'blocked', detail: v.reason };
      else if (L.missingVerdicts >= LOOP_MISSING_LIMIT) stop = { reason: 'blocked', detail: lang === 'en' ? `No LOOP verdict in ${LOOP_MISSING_LIMIT} consecutive runs — check the agent's runner/output format` : `${LOOP_MISSING_LIMIT}회 연속 LOOP 판정 누락 — 에이전트의 러너·출력 형식을 확인해 주세요` };
      else if (L.runs >= L.maxRuns) stop = { reason: 'maxRuns', detail: '' };
      else if (L.maxUsd != null && L.spentUsd >= L.maxUsd) stop = { reason: 'maxUsd', detail: '' };
      if (stop) { L.stoppedReason = stop.reason; L.stoppedDetail = String(stop.detail ?? '').slice(0, 300); patch.enabled = false; }
      patch.loop = L;
    }
    // 타입 판정은 디스크 현재값(cur) — 실행 중 편집으로 타입이 바뀐 루틴을 스냅샷 기준으로
    // 잘못 끄지 않는다(검수 LOW-1: catch와 기준 통일). enabled:false 덮어쓰기라 루프 정지와 무충돌.
    const r = await patchRoutine(wsId, id, (cur) => ({ ...patch, ...(cur.schedule?.type === 'once' ? { enabled: false } : {}) }));
    if (stop) await announceStop(r, stop, t.msgr);
    if (!quiet) emitNotify({ type: 'routine', wsId, runAt: r0.lastRun, routine: resultRoutine(r), ok: true, reply: shown, ...(t.msgr ? { msgr: t.msgr, msgrReply: t.msgrReply } : {}) }); // 메신저 브리핑 푸시
    return { ok: true, reply: shown, handover: t.handover, ...(quiet ? { noReport: true } : {}), ...(loop ? { loop: r?.loop ?? null, stopped: stop?.reason ?? null } : {}) };
  } catch (e) {
    const msg = String(e.message || e).slice(0, 160);
    // 1회 예약은 **예약 시각이 지난 실패**면 끈다 — 같은 슬롯은 lastRun 각인으로 재발화하지 않아,
    // 켜둔 채 두면 목록에 영영 '가동'으로 남는 좀비가 된다(검수 LOW-3). 반면 예약 시각 **전**의
    // 실패(목록 '실행'으로 미리 시험)는 켜둔다 — 끄면 살아 있는 미래 예약이 취소된다(검수
    // MEDIUM-1). 판정 시계는 **실행 시작 시각**(r0.lastRun 각인과 동일) — 실패 시각으로 재면
    // 슬롯을 가로지른 시험 실행(시작<슬롯≤실패)에서 소비되지 않은 슬롯(isDue가 아직 발화할
    // 예약)이 꺼진다(2R LOW-A). 실패는 lastOk:false + 알림으로 드러나고, 재실행은 '실행'으로.
    // 스케줄은 디스크 현재값(cur)으로 판정 — 실행 중 편집을 스냅샷 기준으로 잘못 끄지 않는다.
    // 루프는 실패한 회차도 센다(위험 파일 검수 R-3, 2026-09-23) — 안 세면 시작 때 각인한 lastRun 덕에 다음 주기에 또 돌아
    // 러너가 끊긴 루프가 회차·연속 무판정 상한을 영영 못 만나고 실패 알림만 쌓는다. 실패 = 판정 없는 회차.
    let stop = null;
    const loopPatch = {};
    if (loop) {
      const L = { ...normalizeLoop(r0.loop, r0.loop) };
      L.runs += 1;
      L.missingVerdicts += 1;
      if (L.missingVerdicts >= LOOP_MISSING_LIMIT) stop = { reason: 'blocked', detail: lang === 'en' ? `${LOOP_MISSING_LIMIT} consecutive runs without a verdict — last error: ${msg}` : `${LOOP_MISSING_LIMIT}회 연속 판정 없이 끝남 — 마지막 오류: ${msg}` };
      else if (L.runs >= L.maxRuns) stop = { reason: 'maxRuns', detail: '' };
      if (stop) { L.stoppedReason = stop.reason; L.stoppedDetail = String(stop.detail).slice(0, 300); loopPatch.enabled = false; }
      loopPatch.loop = L;
    }
    const r = await patchRoutine(wsId, id, (cur) => ({ lastOk: false, lastResult: msg, ...loopPatch, ...(onceSpent(cur.schedule, new Date(r0.lastRun)) ? { enabled: false } : {}) }));
    // 실패도 대화 기록에 남긴다(종전엔 성공 때만 남아 실패 28건이 화면에 0건이었다 — 2026-10-07 조사). 답과 짝을 못 지은 지시가 있으면
    // 성공 때와 같은 모양의 지시 + 답 자리에 실패 안내, 이미 다 남긴 뒤의 실패(완료 조건 최종 미충족)면 안내 한 줄만 — 지시를 두 번 쓰지 않는다.
    // noContext — 화면에는 보이되 다음 턴 맥락(최근 대화·누적 요약)에는 싣지 않는다: 실패 안내는 에이전트가 한 말이 아니고, 대화 실패 턴(failed)도
    // 맥락에서 빠진다(검수 LOW — 텔레그램 그룹·슬랙 채널 범위 루틴이면 오류 원문이 그 그룹 맥락에 실렸다). 기록 실패는 실패 처리(lastOk·알림·throw)를 막지 않는다.
    {
      const { appendTurn, appendLine } = await import('./thread.mjs');
      const scope = await recordScope().catch(() => null);
      const text = failedText(String(e?.message || e).slice(0, 500), lang);
      await (pending
        ? appendTurn(wsId, r0.agentSlug, { userMsg: pending, reply: text, handover: null, sessionId: null, via: 'routine', noContext: true, ...(scope ? { contextScope: scope } : {}) })
        : appendLine(wsId, r0.agentSlug, { who: 'crew', text, noContext: true, ...(scope ? { contextScope: scope } : {}) }))
        .catch((err) => console.error(`[argo] 루틴 실패 기록 실패(${wsId}/${r0.agentSlug}):`, err.message));
    }
    if (stop) await announceStop(r, stop, null);
    emitNotify({ type: 'routine', wsId, runAt: r0.lastRun, routine: resultRoutine(r), ok: false, reply: msg });
    throw e;
  }
}

/** 스케줄러용 — 이 분(minute)에 실행해야 하나. catch-up 정책·시간대 판정(CATCHUP_MS·zonedParts·
    normalizeTz·onceSpent)은 routine-time.mjs가 원천이다. */
export function isDue(routine, now = new Date()) {
  if (routine?.kind === 'goal') return !!goalMode(routine, now); // 목표 하트비트 — 다음 확인 시각·기한·하루 상한·못 보낸 알림(goal-time.mjs)
  if (!routine.enabled) return false;
  const s = routine.schedule ?? {};
  // interval — 마지막 실행에서 everyMinutes 경과 시 due. lastRun 선점(claimRoutine)이 그대로
  // 이중 실행을 막고, 슬립으로 놓친 틱은 다음 틱에 자연 캐치업된다(시각 슬롯 개념 없음).
  if (s.type === 'interval') {
    const every = Math.floor(Number(s.everyMinutes)) * 60_000;
    if (!Number.isFinite(every) || every < 10 * 60_000) return false; // 오염 방어 — 하한 미달은 발화 금지
    if (!routine.lastRun) return true;
    return now - new Date(routine.lastRun) >= every;
  }
  const times = Array.isArray(s.times) && s.times.length ? s.times : [s.time];
  const dows = Array.isArray(s.dows) && s.dows.length ? s.dows : [s.dow ?? 1];
  // 달력 판정은 **루틴의 시간대**로 한다(schedule.tz). 없으면 기기 로컬 — 구 루틴 동작 불변.
  const tz = normalizeTz(s.tz);
  const zp = zonedParts(now, tz);
  if (s.type === 'weekly' && !dows.includes(zp.dow)) return false;
  // 1회 예약 — 지정 날짜에만. 이미 실행됐으면(lastRun) 다시 발화하지 않는다(아래 슬롯 판정과 이중 방어).
  if (s.type === 'once') {
    const today = `${zp.year}-${String(zp.month).padStart(2, '0')}-${String(zp.day).padStart(2, '0')}`;
    if (s.date !== today) return false;
  }
  const nowMin = zp.hour * 60 + zp.minute; // 그 시간대의 자정 이후 분
  // 슬롯별 판정 — 각 시각이 독립 슬롯. 앞 슬롯 실행(lastRun 갱신)이 뒤 슬롯을 막지 않는다
  // (lastRun < 뒤 슬롯 sched이므로). 스케줄러의 선점 마킹(lastRun=now)과도 그대로 호환된다.
  for (const tm of times) {
    const [h, m] = String(tm ?? '').split(':').map(Number);
    if (!Number.isInteger(h) || !Number.isInteger(m)) continue;
    // 예약 시각의 절대 순간 = now에서 "그 시간대 기준 경과 분"만큼 되돌린 지점. 시간대별 Date를
    // 만들 수 없으니(JS 한계) 차이로 역산한다 — lastRun 비교가 절대 시각이라 이 형태여야 맞물린다.
    // 알려진 한계 — DST **가을 되돌림** 날에는 벽시계 1시간이 실시간 2시간이라, 두 번째
    // 01:xx에서 역산한 sched가 첫 실행의 lastRun보다 뒤로 나와 같은 슬롯이 한 번 더 발화한다
    // (분리 검수 실측: America/New_York 2026-11-01 01:10). 봄 건너뜀은 정상. 영향 = DST 시간대 ×
    // 연 1일 × 되풀이 시각대에서 LLM 턴 1회 중복(한국은 DST 없음). 근본 해법은 슬롯 정체성을
    // 절대시각이 아니라 "그 시간대의 날짜+시각 문자열"로 lastRun에 기록하는 것 — 표면이 커서 후속.
    const behindMin = nowMin - (h * 60 + m);
    if (behindMin < 0) continue;             // 아직 예약 시각 전(그 시간대 기준)
    const sched = new Date(now.getTime() - behindMin * 60_000 - now.getSeconds() * 1000 - now.getMilliseconds());
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

/** 반복 지시문 설계 규격 — 한 줄 요청을 "그대로 복사"하지 않고 설계된 지시문으로 확장한다(유건 지시
    2026-08-05: "입력한 프롬프트 그대로 사용되고 있음" — Claude Code 루틴 수준의 설계 표방).
    DRAFT(자연어→초안)와 REFINE(직접 입력 확장)이 같은 규격을 공유한다 — 두 생성 경로의 품질이 갈리지 않게.
    (export: 회귀 테스트용 — 규격 문구가 두 프롬프트에 실리는지 앵커) */
export const PROMPT_DESIGN_SPEC = `prompt는 사용자의 한 줄 요청을 **설계된 반복 지시문**으로 확장한 것이어야 한다(원문 복사 금지). 사용자의 언어로, 아래 구조의 마크다운으로 작성한다:
- **목적**: 이 루틴이 왜 도는지 한 줄(요청의 의도를 해석해 명시).
- **할 일**: 실행 단계 2~5개 — 무엇을 확인/수집/작성하는지 구체적으로.
- **산출물**: 결과의 형식(예: 불릿 요약 5줄, 표, 파일 저장 위치)과 분량.
- **기준**: 잘된 결과의 조건 1~2개 + 자료가 없거나 실패했을 때 대신 할 일 한 줄.
요청에 없는 사실(고유명사·수치·링크)을 지어내지 않는다 — 모호하면 단계 안에 "~를 먼저 파악"으로 담는다.`;

const DRAFT_PROMPT = (text, roster) => `너는 루틴(반복 업무) 설계자다. 사용자의 요청을 아래 JSON으로만 변환해 출력하라. JSON 외 텍스트·설명 금지.
스키마: {"title": "짧은 제목", "prompt": "설계된 반복 지시문(아래 설계 규격)", "schedule": {"type": "daily"|"weekly", "times": ["HH:MM", ...], "dows": [0-6 정수 배열 — weekly일 때만, 0=일요일]}, "agentSlug": "아래 에이전트 목록의 slug — 사용자가 특정 에이전트를 지목했을 때만, 아니면 null"}
에이전트 목록:
${roster || '(없음)'}
설계 규격:
${PROMPT_DESIGN_SPEC}
규칙:
- 요일 언급이 있으면 weekly + dows. "평일"=[1,2,3,4,5], "주말"=[0,6]. 요일 언급이 없으면 daily.
- 시각은 24시간 HH:MM. 복수 언급이면 전부 넣는다. 시각 언급이 없으면 ["09:00"].
- 시각·주기와 무관한 내용은 전부 prompt의 설계에 반영한다. 사용자의 언어를 유지한다.
- 이벤트 트리거 요청(예: "메일이 오면", "댓글 달리면", "~할 때마다")은 아직 미지원 — 그때만 {"unsupported": "trigger", "reason": "무엇이 트리거인지 한 줄"}을 출력한다.
사용자 요청: <<<${text}>>>`;

const REFINE_PROMPT = (text, agentLine) => `너는 루틴(반복 업무) 설계자다. 사용자가 직접 적은 반복 지시문을 아래 설계 규격으로 확장해, {"prompt": "확장된 지시문"} JSON으로만 출력하라. JSON 외 텍스트·설명 금지.
${agentLine ? `실행할 에이전트: ${agentLine}\n` : ''}설계 규격:
${PROMPT_DESIGN_SPEC}
- 시각·요일 언급은 지시문에서 뺀다(스케줄은 별도 필드가 담당).
사용자 지시문: <<<${text}>>>`;

/** 직접 입력 지시문 → 설계 확장. 반환 { prompt }. 실패는 throw(원문 안내) — 저장을 막지 않는 프리필 전용이라
    호출부(UI)는 실패 시 원문 유지가 폴백이다(외부 의존 기능의 폴백 경로 원칙). */
export async function refineRoutinePrompt(wsId, text, { agent = null, lang = 'ko' } = {}) {
  if (!String(text ?? '').trim()) throw new Error(lang === 'en' ? 'Write the instruction first' : '지시문을 먼저 적어주세요');
  const agentLine = agent ? `${agent.name}${agent.role ? ` (${agent.role})` : ''}` : '';
  const { text: out } = await runOneShot(wsId, REFINE_PROMPT(String(text).slice(0, 2000), agentLine), { lang, timeoutMs: 3 * 60_000 });
  let parsed;
  try {
    parsed = extractJson(out);
  } catch {
    throw new Error(lang === 'en' ? 'Could not refine — try again' : '설계 확장에 실패했습니다 — 다시 시도해 주세요');
  }
  const prompt = String(parsed?.prompt ?? '').trim();
  if (!prompt) throw new Error(lang === 'en' ? 'Could not refine — try again' : '설계 확장에 실패했습니다 — 다시 시도해 주세요');
  return { prompt: prompt.slice(0, 8000) };
}

/** 자연어 한 줄 → 루틴 초안. 반환 { draft } 또는 { unsupported, reason }. 러너 미연결 등은 throw(원문 안내). */
export async function draftRoutineFromText(wsId, text, { agents = [], lang = 'ko' } = {}) {
  if (!String(text ?? '').trim()) throw new Error(lang === 'en' ? 'Describe the routine first' : '루틴 내용을 먼저 적어주세요');
  const roster = agents.map((a) => `- ${a.slug}: ${a.name} (${a.role ?? ''})`).join('\n');
  const { text: out } = await runOneShot(wsId, DRAFT_PROMPT(String(text).slice(0, 1000), roster), { lang, timeoutMs: 3 * 60_000 }); // 90s→180s: 이 값이 이제 SDK 경로에도 걸린다(이전엔 CLI 전용, SDK는 무제한) — 느린 모델의 정상 초안이 잘리지 않게
  let parsed;
  try {
    parsed = extractJson(out);
  } catch {
    throw new Error(lang === 'en' ? 'Could not parse the request — try rephrasing it' : '요청을 해석하지 못했습니다 — 표현을 바꿔 다시 시도해 주세요');
  }
  return validateRoutineDraft(parsed, { agents });
}
