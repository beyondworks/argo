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
  e2ee_approve_self: { status: 400, ko: '이 기기 자신은 승인 대상이 아닙니다 — 다른 기기에서 이 기기를 승인해 주세요', en: 'This device cannot approve itself — approve it from another device' },
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
  room_busy: { status: 409, ko: '발언이 진행 중입니다 — 끝난 뒤 다시 시도해 주세요.', en: 'An agent is still speaking — try again after it finishes.' },
  // 팀 메신저 크루 등록(app/api/companies/[ws]/msgr)
  msgr_notify_bad_request: { status: 400, ko: '알림 설정 요청이 올바르지 않습니다 — 켜기/끄기 값만 받습니다', en: 'Bad notification setting request — only an on/off value is accepted' },
  msgr_bad_request: { status: 400, ko: '조직 id·에이전트·허용 범위(all|list|owner)를 확인해 주세요', en: 'Check the organization id, agent, and allow scope (all|list|owner)' },
  msgr_crew_not_found: { status: 404, ko: '에이전트가 없습니다', en: 'Agent not found' },
  msgr_upstream: { status: 502, ko: '조직 서버 응답 오류 — 잠시 후 다시 시도해 주세요', en: 'Organization server error — please try again shortly' },
  // 회사 정보(app/api/companies/[ws] GET) — 없음(404 company_not_found)과 구분되는 읽기 실패(F3, 2026-10-05)
  // 엔진 오류 코드(src/coded-error.mjs codedError, F11 2026-10-05) — ko는 엔진이 던지던 문장 그대로(회귀 0)
  crew_not_found: { status: 404, ko: '존재하지 않는 에이전트입니다', en: 'This agent does not exist' },
  team_not_found: { status: 404, ko: '해당 팀의 에이전트가 없습니다', en: 'No agents are in that team' },
  approval_not_found: { status: 404, ko: '존재하지 않는 결재입니다', en: 'This approval does not exist' },
  approval_already_resolved: { status: 409, ko: '이미 처리된 결재입니다', en: 'This approval was already handled' },
  approval_org_policy: { status: 403, ko: '조직 정책: 이 결재는 팀 메신저에서 조직 관리자(결재권자)만 확정할 수 있습니다', en: 'Organization policy: only an org admin (approver) can decide this, in the team messenger' },
  routine_not_found: { status: 404, ko: '루틴을 찾을 수 없습니다', en: 'Routine not found' },
  routine_fields_required: { status: 400, ko: '에이전트·제목·지시가 필요합니다', en: 'An agent, title and instruction are required' },
  routine_title_required: { status: 400, ko: '제목이 필요합니다', en: 'A title is required' },
  routine_prompt_required: { status: 400, ko: '지시가 필요합니다', en: 'An instruction is required' },
  routine_crew_required: { status: 400, ko: '에이전트가 필요합니다', en: 'An agent is required' },
  // 루틴 예약·완료 조건 형식 검증(src/routines.mjs normalizeSchedule·normalizeVerify, UL6) — ko는 엔진이 던지던 문장 그대로
  routine_once_date_required: { status: 400, ko: '1회 예약은 날짜(YYYY-MM-DD)가 필요합니다', en: 'A one-time schedule needs a date (YYYY-MM-DD)' },
  routine_time_format: { status: 400, ko: '예약 시각은 HH:MM 형식', en: 'Schedule times must be in HH:MM format' },
  routine_interval_range: { status: 400, ko: '반복 간격은 10~1440분', en: 'The repeat interval must be 10 to 1440 minutes' },
  routine_times_max: { status: 400, ko: '예약 시각은 하루 8개까지', en: 'At most 8 schedule times per day' },
  routine_dow_range: { status: 400, ko: '요일은 일(0)~토(6) 범위', en: 'The weekday must be Sunday (0) to Saturday (6)' },
  routine_verify_path_len: { status: 400, ko: '완료 조건 파일 경로는 200자 이내', en: 'A completion-check file path must be 200 characters or fewer' },
  routine_verify_path_relative: { status: 400, ko: '완료 조건 경로는 회사 기억 안 상대경로만', en: 'Completion-check paths must be relative paths inside the company memory' },
  routine_verify_path_traversal: { status: 400, ko: '완료 조건 경로에 상위 탈출(..) 금지', en: 'Completion-check paths cannot go up a folder (..)' },
  routine_verify_files_max: { status: 400, ko: '완료 조건 파일은 5개까지', en: 'At most 5 completion-check files' },
  // 크루 영입 — 이름이 회의실 내부 이름(room-)과 겹침(app/api/companies/[ws]/agents POST). 라우트는 이름이 든 문장도 error로 함께 내린다
  crew_slug_reserved: { status: 400, ko: '에이전트 이름이 회의실 내부 이름(room-)과 겹칩니다 — 다른 이름으로 영입해 주세요', en: "That agent name collides with the meeting room's internal name (room-) — please hire with a different name" },
  // 라우트 입력 검증(회사 설정·기억·크루 카드) — ko는 라우트가 내리던 문장 그대로
  company_name_required: { status: 400, ko: '이름이 필요합니다', en: 'A name is required' },
  company_budget_invalid: { status: 400, ko: '예산은 0 이상의 숫자', en: 'Budget must be a number of 0 or more' },
  company_lang_invalid: { status: 400, ko: '언어는 ko 또는 en이어야 합니다', en: 'Language must be ko or en' },
  vault_bad_request: { status: 400, ko: 'rel·content가 필요합니다', en: 'rel and content are required' },
  vault_note_only: { status: 400, ko: '주제 노트만 수정할 수 있습니다', en: 'Only topic notes can be edited' },
  vault_doc_not_found: { status: 404, ko: '문서를 찾을 수 없습니다', en: 'Document not found' },
  crew_card_not_found: { status: 404, ko: '에이전트를 찾을 수 없습니다', en: 'Agent not found' },
  // 카드 읽기 실패(agents/[slug] GET 500) — 라우트가 이 문구 뒤에 실제 사유를 붙여 내린다(원인을 가리지 않게)
  crew_card_read_failed: { status: 500, ko: '에이전트 카드를 읽지 못했습니다', en: "Couldn't read the agent card" },
  // 쪽지 보내기(app/api/companies/[ws]/mail POST) 입력 검증
  mail_fields_required: { status: 400, ko: '수신 에이전트와 내용이 필요합니다', en: 'A recipient agent and a message are required' },
  // 기억 문서 편집 충돌(app/api/companies/[ws]/vault PUT, F6) — 화면은 errorCode로 "새로 불러오기/내 것으로 덮기"를 고르게 한다
  vault_conflict: { status: 409, ko: '편집하는 동안 다른 곳에서 이 문서가 바뀌었습니다', en: 'This document changed elsewhere while you were editing' },
  // 삭제한(보관 폴더로 옮긴) 회사 되돌리기(app/api/archived-companies, F14) — 화면 이름은 '회사 삭제'(2026-10-05 용어 변경), 동작은 보관 그대로
  archive_not_found: { status: 404, ko: '삭제한 회사를 찾을 수 없습니다', en: 'Deleted company not found' },
  archive_restore_exists: { status: 409, ko: '이미 목록에 같은 회사가 있어 되돌릴 수 없습니다 — 목록에서 그 회사를 열어 보세요', en: 'The same company is already in your list, so it cannot be restored — open it from the list' },
  archive_restore_failed: { status: 500, ko: '회사를 되돌리지 못했습니다 — 잠시 후 다시 시도해 주세요', en: 'Could not restore the company — please try again shortly' },
  // 보관함(app/api/companies/[ws]/trash, 2차 검수 M3) — 항목이 이미 사라졌거나(복구·삭제가 먼저 일어남) 입력이 없을 때 시스템 원문(경로) 대신 문구
  trash_item_gone: { status: 404, ko: '이미 복구했거나 지운 대화예요 — 목록을 다시 불러왔어요', en: 'That conversation was already restored or deleted — the list was refreshed' },
  trash_bad_request: { status: 400, ko: '어떤 대화인지 알 수 없어요', en: 'Could not tell which conversation' },
  trash_failed: { status: 500, ko: '보관함 작업을 마치지 못했습니다 — 잠시 뒤 다시 시도해 주세요', en: "Couldn't finish that — please try again shortly" },
  // 첨부 업로드(app/api/companies/[ws]/chat/upload — 한도는 app/lib/upload-limit.mjs 한 곳)
  upload_too_large: { status: 413, ko: '파일은 하나에 10MB까지 첨부할 수 있어요', en: 'Each file can be up to 10MB' },
  company_load_failed: { status: 500, ko: '회사 정보를 불러오지 못했습니다 — 잠시 후 다시 시도해 주세요', en: "Couldn't load the company — please try again shortly" },
};

/** 기능 라우트 공통 오류 응답. lang은 ko|en(그 외 값·미지정은 ko). 미등록 코드는 throw —
    authError와 같은 fail-loud 계약(오타가 조용히 빈 문구로 새지 않는다). */
export function apiError(code, lang) {
  const m = API_MSG[code];
  if (!m) throw new Error(`apiError: 미등록 코드 ${code}`);
  return Response.json({ error: lang === 'en' ? m.en : m.ko, errorCode: code }, { status: m.status });
}

/** 엔진·라우트 예외 → 응답. e.errorCode가 사전에 있으면 표시 언어 문구 + errorCode(apiError), 없으면 종전처럼 원문(fallbackStatus).
    (F11 — 엔진 오류가 한국어 고정이라 영어 화면에도 한국어가 나왔다) */
export function apiErrorFrom(e, lang, fallbackStatus = 400) {
  if (e?.errorCode && API_MSG[e.errorCode]) return apiError(e.errorCode, lang);
  return Response.json({ error: String(e?.message || e) }, { status: fallbackStatus });
}

/** 화면 쪽 오류 문구 — 응답 본문에 errorCode가 있고 사전(API_MSG + 가드 사전)에 있으면 **화면 언어**(lang) 문구를 쓴다. 서버가
    쿠키 없이 ko로 그렸어도 화면 언어를 따른다. 없으면 error 원문, 그것도 없으면 상태 숫자 문구. app/ui.jsx api()가 쓴다. */
export function errorTextFor(data, status, lang, extra = {}) {
  const m = data?.errorCode ? (API_MSG[data.errorCode] ?? extra[data.errorCode]) : null;
  if (m) return lang === 'en' ? m.en : m.ko;
  if (data?.error) return String(data.error);
  return lang === 'en' ? `Request failed (${status})` : `요청 실패 (${status})`;
}
