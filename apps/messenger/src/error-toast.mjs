// 오류 문구 판정부. friendlyErr = 아는 서버 코드 → 사전 문구(모르면 원문 그대로 — 부르는 쪽이 원문을 쓰던 곳과 같게).
// toastError = 오류 토스트 한 곳에서 원문을 거른다(UX 판독 UXM-05, 2026-10-05: 원문을 넘기는 호출이 60곳이 넘었다 — 서버·JS 원문이 그대로 보이고 다음 행동이 없었다).
import { isNetworkFailure } from './net-errors.mjs';
import { DICT } from './i18n.js';

export const friendlyErr = (msg, t) => /msgr_session_refreshing/.test(msg) ? t('err.sessionRefreshing') : /msgr_crew_remove_owner_only/.test(msg) ? t('err.crewRemoveOwnerOnly') : /row-level security/.test(msg) ? t('err.denied') : /_check\b|violates check constraint/.test(msg) ? t('err.invalid') : /msgr_seat_limit/.test(msg) ? t('seat.limit') : /msgr_approver_not_member/.test(msg) ? t('set.policy.approverNotMember') : /msgr_org_locked|read-only/.test(msg) ? t('org.locked.short') : /msgr_room_limit/.test(msg) ? t('room.limit') : msg; // 무료 인원 한도(개인 공간 2026-09-30)

/** 기계가 낸 원문의 모양 — 서버 예외 코드(msgr_…)·Postgres·PostgREST·JS 오류. 사전 문구에는 없는 모양만(테스트가 사전 전체로 잠근다) */
export const MACHINE_ERROR = /\bmsgr_[a-z_]+|PGRST\d|\bviolates\b|duplicate key|\bJWT\b|(?:Type|Reference|Syntax|Range)Error|is not a function|Cannot read propert|null value in column|permission denied for|relation "|column "|non-2xx|status code \d|\bHTTP \d{3}\b|\bErr(?:or)?:/;

// 서버 코드의 갈래(화면 검수 UM1, 2026-10-05) — 권한·한도는 다시 해도 같은 거절이라 '잠시 뒤 다시 시도'가 틀린 안내였다.
const DENIED = /\bmsgr_(?:[a-z_]+_)?(?:forbidden|not_allowed|unauthorized|owner_only|admin_only)\b|\bmsgr_(?:node|transfer)_not_admin\b|permission denied for/;
const LIMIT = /\bmsgr_[a-z_]*(?:_limit|_too_big|_too_many(?:_[a-z]+)?|_too_large|_full|_exhausted)\b|payload too large|exceeded the maximum allowed size/i;
const TIMEOUT = /statement timeout|\bAbortError\b|signal is aborted|operation was aborted/i;
const MACHINE_PREFIX = /^(?:[A-Za-z]*Error|Err|Exception|PGRST\d+|\d{3})$/;

// 사전 문구(이미 번역해 넘긴 줄)는 그대로 — 'Attachment upload failed'가 연결 끊김('load failed')으로, read-only 안내가 짧은 잠김 문구로 바뀌던 것(UM1)
let dictLines = null;
const esc = (x) => x.replace(/[.*+?^$()|[\]\\]/g, '\\$&');
const fromDict = (line) => {
  if (!dictLines) {
    const exact = new Set(); const shaped = [];
    for (const pair of Object.values(DICT)) for (const v of pair) for (const l of String(v).split('\n')) {
      if (!l.trim()) continue;
      if (/\{\w+\}/.test(l)) { if (l.replace(/\{\w+\}|[\s\p{P}]/gu, '').length >= 6) shaped.push(new RegExp(`^${l.split(/\{\w+\}/).map(esc).join('.+?')}$`)); } else exact.add(l); // 변수뿐인 틀('{name}: {err}')은 모든 줄에 맞으므로 뺀다
    }
    dictLines = { exact, shaped };
  }
  return dictLines.exact.has(line) || dictLines.shaped.some((r) => r.test(line));
};

function oneLine(msg, t) {
  if (fromDict(msg)) return msg;
  if (isNetworkFailure(msg)) return t('err.offline');
  const f = friendlyErr(msg, t);
  if (f !== msg) return f;
  if (DENIED.test(msg)) return t('err.denied');
  if (LIMIT.test(msg)) return t('err.limit');
  if (TIMEOUT.test(msg)) return t('err.timeout');
  if (/(?<![\w"'])msgr_[a-z0-9_]+(?![\w"'])/.test(msg)) return t('err.code'); // 따옴표 안의 이름(제약·표 이름 "msgr_…")은 서버 코드가 아니다 // 그 밖 서버 코드 — 같은 요청은 같은 거절이라 다시 시도를 권하지 않는다
  return MACHINE_ERROR.test(msg) ? t('err.raw') : msg;
}
/** 한 줄 — 사람 말 머리(에이전트·파일 이름, '실패')는 남기고 뒤의 기계 원문만 바꾼다('Other Agent: msgr_crew_not_visible', '실패: msgr_bot_exists') */
function filterLine(line, t) {
  const whole = oneLine(line, t);
  if (whole === line) return line;
  const m = /^([^:\n]{1,60}):\s+(.+)$/.exec(line);
  if (m && !MACHINE_PREFIX.test(m[1].trim()) && !MACHINE_ERROR.test(m[1]) && oneLine(m[1], t) === m[1]) return `${m[1]}: ${oneLine(m[2], t)}`;
  return whole;
}

/** 토스트에 보일 문구 — 줄마다(여러 크루·파일 결과가 줄로 온다): 연결 끊김 → 연결 안내, 아는 서버 코드 → 그 문구, 권한 → 권한 없음, 한도 → 한도 문구,
    시간 초과 → 다시 시도 안내, 그 밖 서버 코드 → 다시 시도 없는 진단 안내, 기계 원문 → '처리하지 못했습니다 … 진단'(원문은 부르는 쪽이 진단 기록에),
    그 밖(이미 번역한 문구)은 그대로. 같은 줄은 한 번. phone = 폰 셸(설정 화면 구조가 달라 진단 경로가 다르다). */
export function toastError(raw, { t: tt, phone = false }) {
  const msg = String(raw ?? '');
  if (!msg) return '';
  const path = tt(phone ? 'diag.path.phone' : 'diag.path.desktop'); const t = (k, v) => tt(k, { path, ...v }); // 진단 안내는 실제 자리로(2차 검수 L-h — 폰 셸·데스크톱 설정이 다르다)
  return [...new Set(msg.split('\n').filter((l) => l.trim()).map((l) => filterLine(l, t)))].join('\n');
}
