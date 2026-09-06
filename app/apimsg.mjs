// 기능 라우트 오류 문구 사전 — 가드 계급(authmsg.mjs MSG)과 같은 계약의 기능 라우트 확장(#333 후속).
// 표시 언어(ko|en)로 사람 문구를 그려 내리고 errorCode를 함께 싣는다. ko 문구는 기존 프로덕션
// 문자열 그대로(회귀 0 — 쿠키 없는 요청·구버전 클라이언트·로그는 오늘과 동일하게 ko를 받는다).
// 순수 모듈 — next 의존 없음, 행동은 test/api-error-lang.test.mjs가 잠근다.
// 가드 계급 6코드(auth_required 등)는 authmsg.mjs가 정본이다 — 여기 다시 싣지 않는다.

// code: { status, ko, en } — 새 코드는 두 언어 모두 등록(다국어 상시 규칙, CLAUDE.md).
export const API_MSG = {
  // E2EE 관리(app/api/me/e2ee) — 설정 화면 E2eeCard가 error를 그대로 렌더한다(v0.1.52 신규 표면)
  e2ee_session_required: { status: 401, ko: '기기 연동 세션이 필요합니다 — Argo 앱에서 로그인해 주세요', en: 'A linked device session is required — sign in from the Argo app' },
  e2ee_already_on_this: { status: 400, ko: '이미 이 기기에서 켜져 있습니다', en: 'Already enabled on this device' },
  e2ee_already_on_other: { status: 409, ko: '이미 다른 기기에서 켜져 있습니다 — 그 기기에서 이 기기를 승인해 주세요', en: 'Already enabled on another device — approve this device from that device' },
  e2ee_plan_required: { status: 403, ko: '종단간 암호화는 동기화가 도는 상태(Pro·체험)에서 켤 수 있습니다', en: 'End-to-end encryption can be turned on while sync is active (Pro or trial)' },
  e2ee_no_key_here: { status: 400, ko: '이 기기에 열쇠가 없습니다 — 열쇠 보유 기기에서 승인해 주세요', en: 'This device holds no key — approve from a device that has the key' },
  e2ee_approve_target_required: { status: 400, ko: '승인할 기기를 지정해 주세요', en: 'Specify a device to approve' },
  e2ee_target_pubkey_missing: { status: 404, ko: '대상 기기의 공개키가 없습니다(앱 업데이트·로그인 확인)', en: 'The target device has no public key (check for app updates and sign-in)' },
  e2ee_retry_later: { status: 429, ko: '잠시 후 다시 시도해 주세요', en: 'Please try again shortly' },
  e2ee_already_has_key: { status: 400, ko: '이미 이 기기에 열쇠가 있습니다', en: 'This device already has the key' },
  e2ee_no_recovery: { status: 404, ko: '복구 코드가 설정돼 있지 않습니다', en: 'No recovery code is set up' },
  e2ee_bad_recovery_code: { status: 400, ko: '복구 코드가 맞지 않습니다', en: 'The recovery code is incorrect' },
  e2ee_revoke_target_required: { status: 400, ko: '제거할 기기를 지정해 주세요', en: 'Specify a device to remove' },
  e2ee_revoke_self: { status: 400, ko: '이 기기 자신은 제거할 수 없습니다', en: 'This device cannot remove itself' },
  e2ee_unknown_action: { status: 400, ko: '알 수 없는 action', en: 'Unknown action' },
  // 회의실(app/api/companies/[ws]/room·sessions) — 크루 발언 중 새 회의·전환·마치기 거절(코어 assertRoomIdle의 ROOM_BUSY).
  // 화면은 errorCode로 사전(room.busyGate)을 다시 그리고, 이 문구는 API 소비자·로그용 표시 언어 본문(#393 DELETE 문구 계승).
  room_busy: { status: 409, ko: '발언이 진행 중입니다 — 끝난 뒤 다시 시도해 주세요.', en: 'A crew is still speaking — try again after it finishes.' },
  // 팀 메신저 크루 등록(app/api/companies/[ws]/msgr)
  msgr_bad_request: { status: 400, ko: '조직 id·크루·허용 범위(all|list|owner)를 확인해 주세요', en: 'Check the organization id, crew, and allow scope (all|list|owner)' },
  msgr_crew_not_found: { status: 404, ko: '크루가 없습니다', en: 'Crew not found' },
  msgr_upstream: { status: 502, ko: '조직 서버 응답 오류 — 잠시 후 다시 시도해 주세요', en: 'Organization server error — please try again shortly' },
};

/** 기능 라우트 공통 오류 응답. lang은 ko|en(그 외 값·미지정은 ko). 미등록 코드는 throw —
    authError와 같은 fail-loud 계약(오타가 조용히 빈 문구로 새지 않는다). */
export function apiError(code, lang) {
  const m = API_MSG[code];
  if (!m) throw new Error(`apiError: 미등록 코드 ${code}`);
  return Response.json({ error: lang === 'en' ? m.en : m.ko, errorCode: code }, { status: m.status });
}
