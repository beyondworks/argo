// 자동화 루틴 — 크루에게 반복 지시를 예약(매일/매주)하거나 즉시 실행한다.
// 실행 = 일반 채팅 턴과 동일 경로(chat) → 결과가 vault 기억으로 남고 자동 링크된다.
import { paths } from './workspace.mjs';
// chat은 **동적 임포트**(runRoutine 안) — chat.mjs가 이 파일을 정적으로 임포트하므로(예약 도구),
// 여기서도 정적이면 유일한 정적-정적 순환이 된다. 지금은 함수 참조뿐이라 동작하지만, 어느 쪽이든
// 톱레벨 부작용이 추가되는 순간 TDZ ReferenceError로 Next 라우트가 500이 된다(전수리뷰 2026-07-30 #3).
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
    // 함수형 패치 — 현재 상태를 보고 결정해야 하는 변경(루프 수동 정지 사유 등)은 락 안에서 읽고 쓴다
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

/** schedule: { type: 'daily'|'weekly', time: 'HH:MM', dow?: 0-6, times?: ['HH:MM'...], dows?: [0-6...] }
    복수 필드(times/dows)가 있으면 우선, 없으면 단수 필드 — 기존 루틴·구버전 동기화 하위호환.
    (export: 단위 테스트용 — 순수 함수) */
const TIME_RE = /^\d{2}:\d{2}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** 시간대 검증 — IANA 이름(Asia/Seoul 등)만. 못 알아보면 null(기기 로컬로 폴백).
    Intl이 유일한 판별기다 — 목록을 손으로 들고 있으면 낡는다. */
export function normalizeTz(tz) {
  const name = String(tz ?? '').trim();
  if (!name) return null;
  try { new Intl.DateTimeFormat('en-US', { timeZone: name }); return name; } catch { return null; }
}

export function normalizeSchedule(schedule = {}) {
  // 시각 예약은 **만든 사람의 시간대**에 묶인다(유건 지시 2026-07-28: "한국 사용자는 한국 시간으로").
  // 없으면 예약 시각을 실행하는 기기의 로컬로 읽는데, 그 기기가 다른 시간대(클라우드 워커=UTC,
  // 해외 기기)면 09:00 브리핑이 엉뚱한 시각에 터진다. 그래서 tz를 스케줄에 박아 함께 옮긴다.
  const tz = normalizeTz(schedule.tz);
  const withTz = (s) => (tz ? { ...s, tz } : s); // 없으면 붙이지 않는다 — 구버전 기기가 읽어도 무해
  // once = 특정 날짜에 1회(예약 발송). 실행되면 자동으로 꺼진다(runRoutine) — 반복 예약과 구분.
  if (schedule.type === 'once') {
    const date = String(schedule.date ?? '').trim();
    if (!DATE_RE.test(date)) throw new Error('1회 예약은 날짜(YYYY-MM-DD)가 필요합니다');
    const t = String(schedule.time ?? (Array.isArray(schedule.times) ? schedule.times[0] : '')).trim();
    if (!TIME_RE.test(t)) throw new Error('예약 시각은 HH:MM 형식');
    return withTz({ type: 'once', date, time: t, times: [t] });
  }
  // interval = N분마다 반복(크루 Start-loop — 실사용 요청 2026-07-27 "루프 잡"). 하한 10분:
  // [규모 질문] 루프 1개 = 매 발화가 LLM 턴 — 분 단위 루프 × 크루 수 × 회사 수가 곱으로 탄다.
  // 상한 1440분(하루). 구버전 기기 하위호환: time 슬롯이 없으면 구 isDue는 NaN 슬롯을 continue로
  // 건너뛰어 발화하지 않는다(깨지지 않고 조용히 대기 — 이 기기들은 업데이트 후 발화 시작).
  if (schedule.type === 'interval') {
    const every = Math.floor(Number(schedule.everyMinutes));
    if (!Number.isInteger(every) || every < 10 || every > 1440) throw new Error('반복 간격은 10~1440분');
    return { type: 'interval', everyMinutes: every };
  }
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

/** 회차 판정 마커 — 답변 **마지막 줄**. `LOOP: continue` / `LOOP: done <이유>` / `LOOP: blocked <필요한 결정>`.
    (export: 테스트·프롬프트 문구 앵커) */
export const LOOP_VERDICT_RE = /^\s*`?\s*LOOP\s*:\s*(continue|done|blocked)\b[\s.:\-—]*(.*?)\s*`?\s*[.。]?\s*$/i;
const LOOP_MISSING_LIMIT = 3; // 마커 연속 누락 허용 — CLI 러너가 형식을 못 지켜도 조용히 죽지 않되, 영영 헛돌지도 않게

/** 답변에서 판정 추출 — 마지막 비어있지 않은 줄만 본다. 마커가 없으면 { verdict:'continue', missing:true } —
    형식을 안 지킨 러너를 곧바로 정지시키지 않는다(연속 누락 상한은 runRoutine이 센다).
    (export: 단위 테스트용 — 순수 함수) */
export function parseLoopVerdict(reply) {
  const lines = String(reply ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1] ?? '';
  const m = last.match(LOOP_VERDICT_RE);
  if (!m) return { verdict: 'continue', reason: '', missing: true };
  return { verdict: m[1].toLowerCase(), reason: (m[2] ?? '').trim().slice(0, 300), missing: false };
}

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
    if (rel.length > 200) throw new Error('완료 조건 파일 경로는 200자 이내');
    if (rel.startsWith('/') || /^[A-Za-z]:/.test(rel) || rel.includes('\0')) throw new Error('완료 조건 경로는 회사 기억 안 상대경로만');
    if (rel.split('/').includes('..')) throw new Error('완료 조건 경로에 상위 탈출(..) 금지');
    if (!files.includes(rel)) files.push(rel);
  }
  if (!files.length) return null; // 파일 조건이 핵심 — 문구만으로는 조건이 성립하지 않는다
  if (files.length > VERIFY_MAX_FILES) throw new Error(`완료 조건 파일은 ${VERIFY_MAX_FILES}개까지`);
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
    return `[Routine: ${r.title}] Completion check failed (attempt ${attempt}). The routine is NOT done until these are satisfied — do not relax or reinterpret the conditions; produce the deliverables:\n${list}\nOriginal instruction:\n${r.prompt}`;
  }
  return `[루틴: ${r.title}] 완료 조건 미충족(${attempt}차 시도). 아래가 채워질 때까지 이 루틴은 완료가 아니다 — 조건을 완화하거나 재해석하지 말고 산출물을 완성하라:\n${list}\n원래 지시:\n${r.prompt}`;
}

/** 루프 프로토콜 문단 — 회차·상한·지난 결과를 주고 마지막 줄 마커를 요구한다(러너 무관 — 텍스트 규약). */
function loopProtocol(r, lang) {
  const n = (r.loop.runs ?? 0) + 1;
  const last = String(r.lastResult ?? '').trim();
  const budget = r.loop.maxUsd != null ? (lang === 'en' ? ` Loop budget: $${r.loop.spentUsd.toFixed(2)} of $${r.loop.maxUsd} used.` : ` 루프 예산: $${r.loop.maxUsd} 중 $${r.loop.spentUsd.toFixed(2)} 사용.`) : '';
  if (lang === 'en') {
    return `\n\n---\n[Loop protocol] This is run ${n} of at most ${r.loop.maxRuns} in a repeating loop.${budget}\nPrevious run summary: ${last || '(none — first run)'}\nDo the next step of the work. The VERY LAST line of your answer must be exactly one of:\n\`LOOP: continue\` — more to do next run\n\`LOOP: done <one-line reason>\` — the goal is reached, stop the loop\n\`LOOP: blocked <the decision you need from the boss>\` — you cannot proceed without a human decision`;
  }
  return `\n\n---\n[루프 프로토콜] 이것은 반복 루프의 ${n}회차 / 최대 ${r.loop.maxRuns}회다.${budget}\n지난 회차 결과 요약: ${last || '(없음 — 첫 회차)'}\n이번 회차 몫의 일을 진행하라. 답변의 **마지막 줄**은 반드시 다음 셋 중 하나로만 끝내라:\n\`LOOP: continue\` — 다음 회차에 할 일이 남음\n\`LOOP: done <한 줄 이유>\` — 목표 달성, 루프 종료\n\`LOOP: blocked <사장에게 필요한 결정>\` — 사람 결정 없이는 진행 불가`;
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

/** 결재 승인 후 재개 — approval-actions(kind:'loop')가 부른다. 거절이면 부르지 않는다(정지 유지). */
export async function resumeLoop(wsId, id) {
  return patchRoutine(wsId, id, (r) => (isLoopRoutine(r)
    ? { enabled: true, loop: { ...r.loop, stoppedReason: null, stoppedDetail: '', missingVerdicts: 0 } }
    : { enabled: true }));
}

/** 이 기기의 시간대 — 로컬 우선 제품이라 서버는 사용자 컴퓨터에서 돈다. 즉 여기서 읽은 시간대가
    곧 사용자의 시간대다(한국 사용자면 Asia/Seoul). 클라이언트가 tz를 보내면 그쪽이 우선. */
const hostTz = () => { try { return new Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch { return null; } };

export async function addRoutine(wsId, { agentSlug, title, prompt, schedule, enabled = true, loop = null, verify = null }) {
  if (!agentSlug || !title?.trim() || !prompt?.trim()) throw new Error('크루·제목·지시가 필요합니다');
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
    lastRun: null, lastOk: null, lastResult: '',
    // 루프 — interval에만. 다른 타입에 loop가 오면 조용히 버린다(의미 없는 필드를 저장하지 않는다)
    ...(sched.type === 'interval' && loop ? { loop: normalizeLoop(loop) } : {}),
    ...(ver ? { verify: ver } : {}),
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
  if ('verify' in patch) out.verify = patch.verify && typeof patch.verify === 'object' ? { files: patch.verify.files, contains: patch.verify.contains, retries: patch.verify.retries } : null;
  // loop 설정(maxRuns/maxUsd)만 통과 — 카운터 병합·interval 여부 판정은 updateRoutine이 현재 루틴을 보고 한다
  if ('loop' in patch) out.loop = patch.loop && typeof patch.loop === 'object' ? { maxRuns: patch.loop.maxRuns, maxUsd: patch.loop.maxUsd } : null;
  return out;
}

export async function updateRoutine(wsId, id, patch) {
  const clean = sanitizeRoutinePatch(patch);
  const r = await patchRoutine(wsId, id, (cur) => {
    const out = { ...clean };
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
export async function runRoutine(wsId, id, { chatFn = null, startAt = null } = {}) {
  // startAt = 테스트 전용(시작 시각 주입) — "시작이 예약 시각을 가로지르는 실행"은 실제 분 경계를
  // 기다리지 않고는 재현할 수 없다(catch의 once 끄기 판정 시계가 이 각인을 쓴다).
  const r0 = await patchRoutine(wsId, id, { lastRun: (startAt ?? new Date()).toISOString() });
  if (!r0) throw new Error('루틴을 찾을 수 없습니다');
  try {
    const chat = chatFn ?? (await import('./chat.mjs')).chat; // 순환 차단 — 파일 상단 주석 참조. chatFn=테스트 주입(실 러너 불필요)
    const loop = isLoopRoutine(r0);
    let lang = 'ko';
    if (loop || r0.verify) { // verify도 lang을 쓴다 — 검수 MEDIUM-1: en 회사의 재시도 지시가 한국어로 나가던 것
      const { loadCompany } = await import('./workspace.mjs');
      lang = (await loadCompany(wsId).catch(() => ({}))).lang === 'en' ? 'en' : 'ko';
    }
    // 완료 조건 저장값 정규화는 chat **전** — 오염된 저장값이면 LLM 비용을 쓰기 전에 실패하고,
    // 사유에 루틴 제목을 붙여 어느 설정 문제인지 드러낸다(검수 LOW-2).
    let ver = null;
    if (r0.verify && !loop) {
      try { ver = normalizeVerify(r0.verify); } catch (e) {
        throw new Error(lang === 'en' ? `[${r0.title}] completion check config invalid: ${e.message}` : `[${r0.title}] 완료 조건 설정 오류: ${e.message}`);
      }
    }
    const userMsg = `[루틴: ${r0.title}] ${r0.prompt}${loop ? loopProtocol(r0, lang) : ''}`;
    let t = await chat(wsId, r0.agentSlug, userMsg, null, { source: 'routine' });
    // 대화 스레드에 남긴다 — 루틴만 이게 빠져 있어서, 실행 중엔 채팅창에 보이다가 끝나면 사라졌다
    // (신고 2026-07-28 "루틴 돌면서 채팅이 올라왔다가 실행되고 나니 유실"). 저장한 적이 없었던 것.
    // 사장 직접 대화·위임·쪽지 배달은 전부 appendTurn을 한다 — 루틴만 비대칭이었다.
    // 기록 실패는 무증상으로 삼키지 않는다(비용은 나갔는데 화면에 없다 — scheduler의 쪽지 경로와 동일 규칙).
    // 기록은 chat **직후**(완료 조건 검사 전) — 재시도·최종 실패(throw)와 무관하게 모든 턴이
    // 자기 지시와 짝지어 스레드에 남는다(재시도 턴은 아래 루프가 각자 기록).
    const { appendTurn } = await import('./thread.mjs');
    await appendTurn(wsId, r0.agentSlug, { userMsg, reply: t.reply, handover: t.handover, sessionId: null, via: 'routine', artifacts: t.artifacts })
      .catch((e) => console.error(`[argo] 루틴 스레드 기록 실패(${wsId}/${r0.agentSlug}):`, e.message));
    // 완료 조건(verify) — 산출물이 실제로 없으면 "다 됐어요"를 인정하지 않는다. 미충족이면 실패
    // 목록을 그대로 들려 재시도(retries회), 그래도 미충족이면 throw로 기존 실패 표면
    // (lastOk:false + 알림)에 정직하게 태운다.
    if (ver) {
      let verifyTried = 0;
      let res = await checkVerify(wsId, ver, { lang });
      while (!res.ok && verifyTried < ver.retries) {
        verifyTried += 1;
        const retryMsg = verifyRetryPrompt(r0, res.failures, verifyTried + 1, lang);
        t = await chat(wsId, r0.agentSlug, retryMsg, null, { source: 'routine' });
        await appendTurn(wsId, r0.agentSlug, { userMsg: retryMsg, reply: t.reply, handover: t.handover, sessionId: null, via: 'routine', artifacts: t.artifacts })
          .catch((e) => console.error(`[argo] 루틴 재시도 스레드 기록 실패(${wsId}/${r0.agentSlug}):`, e.message));
        res = await checkVerify(wsId, ver, { lang });
      }
      if (!res.ok) {
        const tried = verifyTried + 1; // 최초 1회 + 재시도
        throw new Error(lang === 'en'
          ? `Completion check failed after ${tried} attempt(s): ${res.failures.join(' · ')}`
          : `완료 조건 미충족(${tried}회 시도): ${res.failures.join(' · ')}`);
      }
    }
    const summary = t.reply.replace(/\s+/g, ' ').slice(0, 160);
    // 1회 예약은 **성공하면** 스스로 꺼진다 — 산출이 이미 나갔으니 예약 시각에 또 보내지 않는다
    // (미래 예약을 미리 시험해 성공한 경우도 동일 — 이중 발송 방지). 실패는 catch가 다르게 다룬다.
    // 당일 자동 재시도는 없다: 시작 시 lastRun을 각인하므로 isDue가 같은 슬롯을 다시 due로 만들지
    // 않는다(검수 LOW-3 실측 — 옛 주석 "켜둬 당일 재시도 허용"은 거짓이었다).
    const patch = { lastOk: true, lastResult: summary };
    let stop = null; // { reason, detail }
    if (loop) {
      const v = parseLoopVerdict(t.reply);
      const L = { ...normalizeLoop(r0.loop, r0.loop) };
      L.runs += 1;
      L.spentUsd = Math.round((L.spentUsd + (Number(t.costUsd) || 0)) * 10000) / 10000; // 구독(OAuth)·CLI 턴은 costUsd null → 0
      L.lastVerdict = v.verdict;
      L.missingVerdicts = v.missing ? L.missingVerdicts + 1 : 0;
      // 정지 조건 — 먼저 걸린 하나만 사유로 남긴다(판정 > 누락 상한 > 회차 > 예산)
      if (v.verdict === 'done') stop = { reason: 'done', detail: v.reason };
      else if (v.verdict === 'blocked') stop = { reason: 'blocked', detail: v.reason };
      else if (L.missingVerdicts >= LOOP_MISSING_LIMIT) stop = { reason: 'blocked', detail: lang === 'en' ? `No LOOP verdict in ${LOOP_MISSING_LIMIT} consecutive runs — check the crew's runner/output format` : `${LOOP_MISSING_LIMIT}회 연속 LOOP 판정 누락 — 크루의 러너·출력 형식을 확인해 주세요` };
      else if (L.runs >= L.maxRuns) stop = { reason: 'maxRuns', detail: '' };
      else if (L.maxUsd != null && L.spentUsd >= L.maxUsd) stop = { reason: 'maxUsd', detail: '' };
      if (stop) { L.stoppedReason = stop.reason; L.stoppedDetail = String(stop.detail ?? '').slice(0, 300); patch.enabled = false; }
      patch.loop = L;
    }
    // 타입 판정은 디스크 현재값(cur) — 실행 중 편집으로 타입이 바뀐 루틴을 스냅샷 기준으로
    // 잘못 끄지 않는다(검수 LOW-1: catch와 기준 통일). enabled:false 덮어쓰기라 루프 정지와 무충돌.
    const r = await patchRoutine(wsId, id, (cur) => ({ ...patch, ...(cur.schedule?.type === 'once' ? { enabled: false } : {}) }));
    if (stop) {
      if (stop.reason === 'blocked') {
        // 막힘 = 사장 결재로 푼다. 승인 → approval-actions(kind:'loop')가 resumeLoop, 거절 → 정지 유지.
        const { addApproval } = await import('./approvals.mjs');
        await addApproval(wsId, {
          slug: r0.agentSlug, kind: 'loop',
          action: lang === 'en' ? `Resume loop — ${r0.title}`.slice(0, 300) : `루프 재개 — ${r0.title}`.slice(0, 300),
          reason: stop.detail, payload: { routineId: id },
        }).catch((e) => console.error(`[argo] 루프 결재 등록 실패(${wsId}/${id}):`, e.message));
      }
      emitNotify({ type: 'routine', wsId, routine: r ?? r0, ok: true, reply: loopStopMessage(stop.reason, stop.detail, lang, r?.loop ?? r0.loop) });
    }
    emitNotify({ type: 'routine', wsId, routine: r ?? r0, ok: true, reply: t.reply }); // 메신저 브리핑 푸시
    return { ok: true, reply: t.reply, handover: t.handover, ...(loop ? { loop: r?.loop ?? null, stopped: stop?.reason ?? null } : {}) };
  } catch (e) {
    const msg = String(e.message || e).slice(0, 160);
    // 1회 예약은 **예약 시각이 지난 실패**면 끈다 — 같은 슬롯은 lastRun 각인으로 재발화하지 않아,
    // 켜둔 채 두면 목록에 영영 '가동'으로 남는 좀비가 된다(검수 LOW-3). 반면 예약 시각 **전**의
    // 실패(목록 '실행'으로 미리 시험)는 켜둔다 — 끄면 살아 있는 미래 예약이 취소된다(검수
    // MEDIUM-1). 판정 시계는 **실행 시작 시각**(r0.lastRun 각인과 동일) — 실패 시각으로 재면
    // 슬롯을 가로지른 시험 실행(시작<슬롯≤실패)에서 소비되지 않은 슬롯(isDue가 아직 발화할
    // 예약)이 꺼진다(2R LOW-A). 실패는 lastOk:false + 알림으로 드러나고, 재실행은 '실행'으로.
    // 스케줄은 디스크 현재값(cur)으로 판정 — 실행 중 편집을 스냅샷 기준으로 잘못 끄지 않는다.
    const r = await patchRoutine(wsId, id, (cur) => ({ lastOk: false, lastResult: msg, ...(onceSpent(cur.schedule, new Date(r0.lastRun)) ? { enabled: false } : {}) }));
    emitNotify({ type: 'routine', wsId, routine: r ?? r0, ok: false, reply: msg });
    throw e;
  }
}

/** 스케줄러용 — 이 분(minute)에 실행해야 하나. */
// 예약 시각을 놓쳐도(슬립·재시작으로 폴러가 그 분을 건너뜀) 당일 안에서 1회 catch-up 한다.
// 예전엔 정확히 그 분에만 due라, 그 분을 놓치면 그날은 조용히 스킵돼(아침 브리핑 유실) 스케줄러
// 신뢰가 무너졌다. 지연 상한(4h)으로 23:59에 09:00을 늦게 쏘는 것은 막는다.
const CATCHUP_MS = 4 * 60 * 60 * 1000;

/** 주어진 시간대에서 본 now의 달력 조각. tz가 없으면 기기 로컬(구 동작 그대로).
    Intl로 뽑는 이유: Date는 기기 로컬과 UTC만 알고, 임의 IANA 시간대는 못 만든다.
    (export: 단위 테스트용 — 순수 함수) */
export function zonedParts(now, tz) {
  if (!tz) {
    return {
      year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate(),
      hour: now.getHours(), minute: now.getMinutes(), dow: now.getDay(),
    };
  }
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false, weekday: 'short',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(now).map((x) => [x.type, x.value]));
  const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: Number(p.year), month: Number(p.month), day: Number(p.day),
    // hourCycle에 따라 자정이 24로 오는 구현이 있다 — 0으로 정규화하지 않으면 00:00 루틴이 영원히 안 뜬다
    hour: Number(p.hour) % 24, minute: Number(p.minute), dow: DOW[p.weekday] ?? 0,
  };
}

/** once 슬롯이 이미 지났나 — 실패 시 끄기의 게이트(순수). 예약 시각 **전**의 실패(목록 '실행'으로
    미리 시험해 본 경우)에 꺼 버리면 살아 있는 미래 예약이 취소된다(검수 MEDIUM-1 실측). isDue와
    같은 시간대 규칙(zonedParts + schedule.tz). once가 아니면 false. (export: 단위 테스트용) */
export function onceSpent(schedule, now = new Date()) {
  if (schedule?.type !== 'once') return false;
  const zp = zonedParts(now, normalizeTz(schedule.tz));
  const today = `${zp.year}-${String(zp.month).padStart(2, '0')}-${String(zp.day).padStart(2, '0')}`;
  if (schedule.date !== today) return String(schedule.date ?? '') < today; // YYYY-MM-DD는 문자열 비교 = 날짜 비교
  // 시각 원천은 isDue와 동일하게 times 우선 — 오염 저장값(time≠times[0])에서 두 판정이 갈려
  // 발화 전 예약이 "경과"로 꺼지는 일이 없게 한다(2R LOW-B).
  const [h, m] = String((Array.isArray(schedule.times) && schedule.times[0]) || schedule.time || '').split(':').map(Number);
  if (!Number.isInteger(h) || !Number.isInteger(m)) return true; // 오염된 시각 — 미래라고 단정할 수 없으니 기존(끄기) 쪽으로
  return zp.hour * 60 + zp.minute >= h * 60 + m;
}

export function isDue(routine, now = new Date()) {
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
스키마: {"title": "짧은 제목", "prompt": "설계된 반복 지시문(아래 설계 규격)", "schedule": {"type": "daily"|"weekly", "times": ["HH:MM", ...], "dows": [0-6 정수 배열 — weekly일 때만, 0=일요일]}, "agentSlug": "아래 크루 목록의 slug — 사용자가 특정 크루를 지목했을 때만, 아니면 null"}
크루 목록:
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
${agentLine ? `실행할 크루: ${agentLine}\n` : ''}설계 규격:
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
