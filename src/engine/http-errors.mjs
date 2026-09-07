// 벤더 HTTP 오류 본문 → 사용자 문구(순수). messages-http·gemini-wire가 공유한다(순환 임포트 없이).
/** 벤더 오류 본문에서 message만 — JSON `{error:{message}}` 우선, 아니면 앞 300자. 키 마스킹은 호출부(chat.mjs)가 한다. */
export function extractErrorMessage(text) {
  const s = String(text ?? '');
  try {
    const j = JSON.parse(s); const m = j?.error?.message ?? j?.message ?? j?.error; const code = j?.error?.code ?? j?.code;
    // code 필드 보존 — xAI는 {"code":"personal-team-blocked"}처럼 원인을 code에만 싣는다(분리 검수 HIGH-2: 버리면 크레딧 분류기가 못 문다).
    // Google은 error.status(NOT_FOUND·PERMISSION_DENIED)·details[].reason(API_KEY_INVALID)에만 계급을 싣는다 — 게이트 모델 강등(GATED_MODEL_ERR_RE)이 문다(검수 M1).
    const msg = typeof m === 'string' && m ? m : '';
    const reason = Array.isArray(j?.error?.details) ? j.error.details.map((d) => d?.reason).find((r) => typeof r === 'string' && r) : undefined;
    const tags = [...new Set([code, j?.error?.status, reason].filter((x) => typeof x === 'string' && x && !msg.includes(x)))];
    if (msg || tags.length) return `${msg}${tags.length ? `${msg ? ' ' : ''}(${tags.join(', ')})` : ''}`.slice(0, 600);
  } catch { /* 본문이 JSON이 아니다 */ }
  return s.replace(/\s+/g, ' ').trim().slice(0, 300);
}
/** 벤더 HTTP 호출 1회의 상한(Messages·Responses·Gemini 세 와이어 공통 기본값). 30분 — 옛 10분은 확장 사고(extended thinking·
    높은 추론 강도)를 한 응답 안에서 도는 모델을 결과 직전에 끊었다(제보 2026-09-07 "5분 시간초과·재시도도 반복 실패"와 같은 계열,
    CLI 러너 대화 턴 상한 CLI_CHAT_TURN_TIMEOUT_MS와 같은 값). 사장의 정지 버튼(signal)은 이 상한과 무관하게 즉시 끊는다. */
export const VENDOR_HTTP_TIMEOUT_MS = 30 * 60_000;
