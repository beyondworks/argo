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

  // 마켓(market/route.js GET) — 200 + { results: [], error } 소프트 오류 계약(페이지는 목록을 유지한
  // 채 배너만 띄운다). Response는 라우트가 직접 만들고 문구만 apiMsgText로 그린다.
  // status: null = 문구 전용 — apiError로 그리면 results 없는 200 오류가 나가 페이지 스켈레톤이
  // 영구 고정되므로(setItems(undefined)) apiError가 fail-loud로 차단한다(분리 검수 LOW-1).
  market_top_failed: { status: null, ko: '추천 목록 로드 실패', en: 'Failed to load recommendations' },
  market_remote_failed: { status: null, ko: '원격 마켓 연결 실패', en: 'Remote market connection failed' },
  // 피드백(feedback/route.js) — FeedbackModal이 error를 그대로 렌더
  feedback_cloud_only: { status: 400, ko: '클라우드 모드(로그인)에서만 피드백을 보낼 수 있습니다', en: 'Feedback can be sent only in cloud mode (signed in)' },
  feedback_message_required: { status: 400, ko: '내용이 필요합니다', en: 'A message is required' },
  feedback_save_failed: { status: 500, ko: '저장에 실패했습니다. 잠시 후 다시 시도해 주세요', en: 'Failed to save. Please try again shortly' },
  // 크루 카드(agents/[slug]/route.js GET) — stale 링크로 크루 페이지가 로드 오류를 렌더
  crew_not_found: { status: 404, ko: '크루를 찾을 수 없습니다', en: 'Crew not found' },
  crew_card_read_failed: { status: 500, ko: '크루 카드를 읽지 못했습니다', en: 'Could not read the crew card' },
  // 기억 문서(vault/route.js GET·DELETE) — 깨진 위키링크·이미 삭제된 노트(detail = rel)
  vault_doc_not_found: { status: 404, ko: '문서를 찾을 수 없습니다', en: 'Document not found' },
  // 페어링 코드 발급(devices/route.js) — 셀프호스팅 연결 코드 카드가 error를 렌더
  devices_no_sync_creds: { status: 400, ko: '이 기기에 동기화 자격이 없습니다 — 환경변수 설정 또는 페어링이 먼저 필요합니다', en: 'This device has no sync credentials — set the environment variables or pair it first' },
  devices_no_owner: { status: 400, ko: '회사에 소유자(ownerId)가 없어 페어링할 수 없습니다', en: 'The company has no owner (ownerId), so it cannot be paired' },
  // 페어링 수신(pair/accept/route.js) — 홈 페어링 폼이 error를 렌더
  pair_owner_mismatch: { status: 403, ko: '연결 코드의 소유자가 현재 로그인 사용자와 다릅니다', en: 'The pairing code owner does not match the signed-in user' },
};

/** 표시 언어 문구만 필요한 자리(커스텀 응답 모양 유지 — 예: market의 200 + results 계약).
    detail이 있으면 `문구: detail` — 기존 라우트들의 동적 접미 형태 그대로(바이트 동일). */
export function apiMsgText(code, lang, detail) {
  const m = API_MSG[code];
  if (!m) throw new Error(`apiMsgText: 미등록 코드 ${code}`);
  const msg = lang === 'en' ? m.en : m.ko;
  return detail === undefined ? msg : `${msg}: ${detail}`;
}

/** 기능 라우트 공통 오류 응답. lang은 ko|en(그 외 값·미지정은 ko). 미등록 코드는 throw —
    authError와 같은 fail-loud 계약(오타가 조용히 빈 문구로 새지 않는다). */
export function apiError(code, lang, detail) {
  const msg = apiMsgText(code, lang, detail); // 미등록 코드는 여기서 throw
  const { status } = API_MSG[code];
  if (status == null) throw new Error(`apiError: 문구 전용 코드 ${code} — 응답 모양은 라우트 소유, apiMsgText로 그릴 것`);
  return Response.json({ error: msg, errorCode: code }, { status });
}
