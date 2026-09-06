// 벤더 HTTP 오류 본문 → 사용자 문구(순수). messages-http·gemini-wire가 공유한다(순환 임포트 없이).
/** 벤더 오류 본문에서 message만 — JSON `{error:{message}}` 우선, 아니면 앞 300자. 키 마스킹은 호출부(chat.mjs)가 한다. */
export function extractErrorMessage(text) {
  const s = String(text ?? '');
  try {
    const j = JSON.parse(s); const m = j?.error?.message ?? j?.message ?? j?.error; const code = j?.error?.code ?? j?.code;
    // code 필드 보존 — xAI는 {"code":"personal-team-blocked"}처럼 원인을 code에만 싣는다(분리 검수 HIGH-2: 버리면 크레딧 분류기가 못 문다)
    const msg = typeof m === 'string' && m ? m : '';
    if (msg || (typeof code === 'string' && code)) return `${msg}${typeof code === 'string' && code && !msg.includes(code) ? `${msg ? ' ' : ''}(${code})` : ''}`.slice(0, 600);
  } catch { /* 본문이 JSON이 아니다 */ }
  return s.replace(/\s+/g, ' ').trim().slice(0, 300);
}
