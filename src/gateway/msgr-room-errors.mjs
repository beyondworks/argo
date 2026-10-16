// 메신저 방에 올리는 실패 글 — 로컬 오류 원문을 방(손님 포함 방 사람 전원)에 싣지 않는다(검수 D26, 정비사 원장 P-C13).
// 실측: 모델 실패 때 손님 화면에 "처리 실패: API Error … check your inference gateway (127.0.0.1:5291)"가 그대로 올라와 주인 쪽 로컬 엔드포인트가 드러났다.
// 첨부 실패도 같은 모양 — 파일 읽기 오류 원문(EACCES 등)에는 주인 컴퓨터의 절대 경로가 들어 있다.
// 상세는 주인에게만: 실패 턴은 chat()이 회사 활동 로그에 원문과 함께 남기고(appendEvent ok:false), 게이트웨이는 로컬 콘솔에 남긴다.
import { pick } from './protocol.mjs';
import { RUNNERS } from '../runners/catalog.mjs'; // 러너 표시 이름만 읽는다(원문·계정·토큰은 싣지 않는다)

/** 크루 턴 실패 — 방에 올리는 일반 문구(원문 없음). */
export const roomTurnFailure = (lang = 'ko') => pick(
  '에이전트가 지금 답하지 못했습니다. 주인이 Argo 활동에서 원인을 확인할 수 있습니다.',
  'The agent could not answer right now. Its owner can see the cause in Argo activity.', lang);

/** 실패가 실행기의 AI 로그인 만료 때문인가 → 그 러너 id(모르면 'unknown') | null. chat.mjs가 붙이는 필드만 본다 — 원문 문자열을 다시 판정하지 않는다
    (벤더 문구 판정은 chat.mjs AUTH_ERR_RE·surfaceRunnerFailure 한 곳). 우선순위: 자가치유 전 처음 만료된 러너(authFailedRunner — 대체 러너까지 실패하면
    마지막 오류는 대체 러너의 것이다, 2026-10-13 상주 Claude OAuth 만료 → codex 재시도 실패 사례) → 게이트가 끊은 러너(authExpired) → 분류 코드 auth_expired의 실패 러너. */
export function roomAuthRunner(e) {
  if (!e || typeof e !== 'object' || e.aborted || e.subscriptionBlocked) return null;
  if (typeof e.authFailedRunner === 'string' && e.authFailedRunner) return e.authFailedRunner;
  if (typeof e.authExpired === 'string' && e.authExpired) return e.authExpired;
  if (e.failCode === 'auth_expired' || e.authExpired || e.authError) return typeof e.failRunner === 'string' && e.failRunner ? e.failRunner : 'unknown';
  return null;
}

/** 크루 턴 실패 — 원인을 아는 경우만 원인과 고칠 곳을 말하고, 그 밖은 일반 문구(roomTurnFailure). 방(손님 포함)에 오르므로 원문·계정·토큰은 싣지 않는다 —
    러너 이름(Claude 등)과 할 일만. 다시 로그인은 실행기 주인만 할 수 있어 "주인이"라고 말한다(데스크톱: 설정 → AI 연결, 서버: 그 기기에서 다시 로그인). */
export function roomTurnFailureFor(e, lang = 'ko', { ownerCause = null } = {}) {
  const runner = roomAuthRunner(e);
  if (!runner) return ownerCause ? roomOwnerFailure(ownerCause, lang) ?? roomTurnFailure(lang) : roomTurnFailure(lang);
  const name = RUNNERS[runner]?.name;
  return name
    ? pick(`이 에이전트를 돌리는 실행기의 ${name} 로그인이 만료돼 답하지 못했습니다. 실행기 주인이 ${name}에 다시 로그인하면 다시 답할 수 있습니다(Argo 데스크톱: 설정 → AI 연결).`,
      `The ${name} login on the runner behind this agent has expired, so it could not answer. Once the runner's owner signs in to ${name} again, it can answer again (Argo desktop: Settings → AI connection).`, lang)
    : pick('이 에이전트를 돌리는 실행기의 AI 로그인이 만료돼 답하지 못했습니다. 실행기 주인이 다시 로그인하면 다시 답할 수 있습니다(Argo 데스크톱: 설정 → AI 연결).',
      "The AI login on the runner behind this agent has expired, so it could not answer. Once the runner's owner signs in again, it can answer again (Argo desktop: Settings → AI connection).", lang);
}

/** 요청한 사람이 그 에이전트의 주인일 때(앱↔메신저 연결 감사 D6, 2026-10-15) — 주인이 고칠 수 있는 실행기 원인과 고칠 곳. 남의 요청이면 부르지 않는다
    (호출부가 ownerCause를 넘기지 않음 — 설정 정보는 주인에게만, 남의 요청은 주인 1:1 안내 #1026). cause = msgr-owner-notice ownerNoticeCause 결과.
    로그인 만료(auth)는 roomTurnFailureFor가 누구에게나 이미 말한다. 그 밖(한도·시간 초과 등)은 null → 일반 문구. 러너 이름과 할 일만(원문·계정·토큰 없음). */
// 사용 한도의 해제 시각(0.1.112) — 벤더 원문에서 읽을 수 있을 때만. Claude: "resets Oct 19 at 1pm (Asia/Seoul)" · "resets 3:30pm (Asia/Seoul)",
// Codex 앱서버 문구: "resets at <시각>". 읽은 값(달·일·시·분·시간대)만 쓰고 원문은 싣지 않는다. 못 읽으면 null — 문구에서 시각을 뺀다.
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const RESETS_RE = /\bresets\s+(?:at\s+)?(?:([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(?:\d{4},?\s+)?(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?(?:\s*\(([A-Za-z_]+(?:\/[A-Za-z_+\-]+)+)\))?/i;
export function parseLimitResets(text) {
  const m = RESETS_RE.exec(String(text ?? ''));
  if (!m) return null;
  const mon = m[1] ? MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1 : null;
  if (m[1] && (!mon || !(Number(m[2]) >= 1 && Number(m[2]) <= 31))) return null;
  const h12 = Number(m[3]); const minute = m[4] ? Number(m[4]) : 0;
  if (!(h12 >= 1 && h12 <= 12) || minute > 59) return null;
  const hour = (h12 % 12) + (m[5].toLowerCase() === 'p' ? 12 : 0);
  return { month: mon || null, day: mon ? Number(m[2]) : null, hour, minute, tz: m[6] ?? null };
}
/** 해제 시각 표기 — ko "10/19 13:00", en "Oct 19, 1:00 PM". 날짜가 없으면 시각만. 시간대가 서울이 아니면 덧붙인다(원문의 시간대 그대로 — 바꿔 계산하지 않는다). */
export function formatLimitResets(r, lang = 'ko') {
  if (!r) return '';
  const mm = String(r.minute).padStart(2, '0');
  const tz = r.tz && r.tz !== 'Asia/Seoul' ? r.tz : null;
  if (lang === 'en') {
    const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const t = `${r.hour % 12 || 12}:${mm} ${r.hour < 12 ? 'AM' : 'PM'}`;
    return `${r.month ? `${MON[r.month - 1]} ${r.day}, ` : ''}${t}${tz ? ` (${tz})` : ''}`;
  }
  return `${r.month ? `${r.month}/${r.day} ` : ''}${String(r.hour).padStart(2, '0')}:${mm}${tz ? `(${tz})` : ''}`;
}

export function roomOwnerFailure(cause, lang = 'ko') {
  if (cause?.kind === 'no_runner') return pick('이 에이전트를 돌리는 내 실행기에 연결된 AI가 없어 답하지 못했습니다. Argo 데스크톱 설정 → AI 연결에서 AI를 연결하면 다시 답할 수 있습니다.',
    "No AI is connected on your runner behind this agent, so it could not answer. Connect one in Argo desktop Settings → AI connection and it can answer again.", lang);
  if (cause?.kind === 'limit') { // 사용 한도(0.1.112) — 한도는 다른 러너로 저절로 넘어가지 않는다(runners.mjs) — 풀린 뒤 다시 또는 에이전트에 다른 러너 지정
    const name = RUNNERS[cause.runner]?.name ?? 'AI'; const when = formatLimitResets(cause.resets, lang);
    return pick(`이 에이전트를 돌리는 내 실행기의 ${name} 사용 한도에 걸려 답하지 못했습니다${when ? ` · ${when}에 풀립니다` : ''}. 풀린 뒤 다시 보내거나, Argo 데스크톱에서 이 에이전트에 다른 러너를 지정하세요(연결된 러너가 없으면 설정 → AI 연결).`,
      `The ${name} usage limit was reached${when ? ` (resets ${when})` : ''} on your runner behind this agent, so it could not answer. Send it again after that, or assign another runner to this agent in Argo desktop (connect one in Settings → AI connection if none).`, lang);
  }
  if (cause?.kind === 'crash') {
    const name = RUNNERS[cause.runner]?.name ?? 'AI';
    return pick(`내 실행기의 ${name} 프로그램이 응답하지 않고 멈춰 답하지 못했습니다. Argo를 다시 시작한 뒤에도 같으면 설정 → AI 연결에서 상태를 확인해 주세요.`,
      `The ${name} program on this runner stopped responding, so it could not answer. Restart Argo; if it keeps happening, check Settings → AI connection.`, lang);
  }
  return null;
}

/** 답하던 중 에이전트(상주)가 다시 시작돼 끊긴 턴(D25). 자동으로 다시 하지 않는 이유와 사용자가 할 일을 함께 말한다. */
export const roomTurnInterrupted = (lang = 'ko') => pick(
  '답하던 중 에이전트가 다시 시작돼 이 작업이 중단됐습니다. 일부 도구 실행이 이미 이뤄졌을 수 있어 자동으로 다시 하지 않습니다. 이어서 하려면 다시 지시해 주세요.',
  'The agent restarted while answering, so this task was interrupted. Some tool actions may already have run, so it will not redo them automatically. Ask again to continue.', lang);

/** 사람이 직접 중단시킨 턴(유건 확정 2026-09-26 — 크루 작업 중단) — 답 자리에 이 한 줄만 남기고 그때까지의 답은 올리지 않는다.
    D25(roomTurnInterrupted, 프로세스 재시작)와는 다른 사고: 프로세스는 살아 있고 사람이 멈춘 것이라 이유를 "다시 지시하라"가 아니라 누가 멈췄는지로 말한다.
    name=null(요청자를 모름 — 예: 주인이 msgr_request_stop을 거치지 않고 데스크톱 정지 버튼으로 이 메신저 턴을 멈춘 경우)이면
    "○○님이" 없이 일반 문구로(분리 검수 2026-09-26 L-5: 이름 없이 "님"을 붙이면 어색하다). */
export const roomTurnStopped = (name, lang = 'ko') => name
  ? pick(`${name}님이 작업을 중단했습니다.`, `${name} stopped this task.`, lang)
  : pick('작업이 중단되었습니다.', 'The task was stopped.', lang);

/** 첨부 한 건 실패 사유 — 우리가 만든 사유(없음·크기)만 그대로, 그 밖의 원문(경로가 들어 있을 수 있음)은 일반 사유로. */
export function roomAttachReason(e, lang = 'ko') {
  const msg = String(e?.message ?? e ?? '');
  if (/ENOENT/.test(msg)) return pick('파일이 없습니다', 'file not found', lang);
  if (e?.roomSafe) return msg.slice(0, 80); // 게이트웨이가 직접 만든 사유(예: 25MB 초과)
  // 무료 계정 첨부 저장 한도(20261011150000) — 업로드는 storage-api가 원문을 숨기고 SQLSTATE만('database error, code: PT402'), 첨부 행은 이름을 준다
  if (/\bmsgr_storage_limit\b|\bcode: PT402\b/.test(msg)) return pick('첨부 저장 공간이 가득 차 올리지 못했습니다', 'attachment storage is full', lang);
  return pick('파일을 읽거나 올리지 못했습니다', 'could not read or upload the file', lang);
}
