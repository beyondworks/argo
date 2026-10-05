// 오류 문구 판정부. friendlyErr = 아는 서버 코드 → 사전 문구(모르면 원문 그대로 — 부르는 쪽이 원문을 쓰던 곳과 같게).
// toastError = 오류 토스트 한 곳에서 원문을 거른다(UX 판독 UXM-05, 2026-10-05: 원문을 넘기는 호출이 60곳이 넘었다 — 서버·JS 원문이 그대로 보이고 다음 행동이 없었다).
import { isNetworkFailure } from './net-errors.mjs';

export const friendlyErr = (msg, t) => /msgr_session_refreshing/.test(msg) ? t('err.sessionRefreshing') : /msgr_crew_remove_owner_only/.test(msg) ? t('err.crewRemoveOwnerOnly') : /row-level security/.test(msg) ? t('err.denied') : /_check\b|violates check constraint/.test(msg) ? t('err.invalid') : /msgr_seat_limit/.test(msg) ? t('seat.limit') : /msgr_approver_not_member/.test(msg) ? t('set.policy.approverNotMember') : /msgr_org_locked|read-only/.test(msg) ? t('org.locked.short') : /msgr_room_limit/.test(msg) ? t('room.limit') : msg; // 무료 인원 한도(개인 공간 2026-09-30)

/** 기계가 낸 원문의 모양 — 서버 예외 코드(msgr_…)·Postgres·PostgREST·JS 오류. 사전 문구에는 없는 모양만(테스트가 사전 전체로 잠근다) */
export const MACHINE_ERROR = /\bmsgr_[a-z_]+|PGRST\d|\bviolates\b|duplicate key|\bJWT\b|(?:Type|Reference|Syntax|Range)Error|is not a function|Cannot read propert|null value in column|permission denied for|relation "|column "|non-2xx|status code \d|\bHTTP \d{3}\b|\bErr(?:or)?:/;

/** 토스트에 보일 문구 — 연결 끊김 → 연결 안내, 아는 서버 코드 → 그 문구, 기계 원문 → '처리하지 못했습니다 … 진단'(원문은 부르는 쪽이 진단 기록에), 그 밖(이미 번역한 문구)은 그대로 */
export function toastError(raw, { t }) {
  const msg = String(raw ?? '');
  if (!msg) return '';
  if (isNetworkFailure(msg)) return t('err.offline');
  const f = friendlyErr(msg, t);
  if (f !== msg) return f;
  return MACHINE_ERROR.test(msg) ? t('err.raw') : msg;
}
