// Anthropic Messages 와이어 포맷 HTTP 클라이언트 — 네이티브 엔진(하네스 통일 P-A, 2026-09-05)의 유일한 벤더 접점.
// openrouter·glm·kimi·grok·(API 키) claude는 전부 이 포맷을 받는다(runnerCredEnv의 ANTHROPIC_BASE_URL 스왑과 같은 사실).
// 오류는 SDK가 내던 문구 형식 `API Error: <status> <message>`로 던진다 — error-class·AUTH_ERR_RE·자가치유가 그대로 문다.

/** 자격 env(runnerCredEnv/sdkEnvFor 산출) → 베이스 URL + 인증 헤더(순수). 구독 OAuth(CLAUDE_CODE_OAUTH_TOKEN)는
    SDK 전용 — 정책 위험(설계서 개정 2026-09-05)으로 이 엔진이 받지 않는다. */
export function authFromEnv(env = {}, lang = 'ko') {
  const en = lang === 'en';
  // OpenAI Responses(Codex 구독 백엔드 또는 api.openai.com) — runnerCredEnv가 codex 자격에 ARGO_WIRE=responses를 찍는다(옵트인 플래그).
  // 헤더는 자격 계층(codex-oauth.codexHeaders)이 만든 것을 그대로 — 제3자 하네스 표기(originator)·계정 id는 여기서 다시 만들지 않는다.
  if (env.ARGO_WIRE === 'responses') {
    const rbase = String(env.RESPONSES_BASE_URL || '').trim().replace(/\/+$/, '');
    if (!rbase || !env.RESPONSES_TOKEN) throw Object.assign(new Error(en ? 'No Codex credential — connect it in Settings → AI connections' : 'Codex 자격이 없습니다 — 설정 → AI 연결에서 연결하세요'), { code: 'no_credential' });
    let headers = { authorization: `Bearer ${env.RESPONSES_TOKEN}` };
    try { if (env.RESPONSES_HEADERS) headers = { ...headers, ...JSON.parse(env.RESPONSES_HEADERS) }; } catch { /* 헤더 JSON 아님 — 기본만 */ }
    return { wire: 'responses', base: rbase, headers };
  }
  // Gemini(Google AI Studio API 키) — 와이어가 다르다(gemini-wire.mjs). runnerCredEnv가 gemini API 키 자격에 ARGO_WIRE=gemini를 찍는다.
  if (env.ARGO_WIRE === 'gemini') {
    const gbase = String(env.GEMINI_BASE_URL || GEMINI_DEFAULT_BASE).trim().replace(/\/+$/, '');
    if (!env.GEMINI_API_KEY) throw Object.assign(new Error(en ? 'No Gemini API key — connect it in Settings → AI connections' : 'Gemini API 키가 없습니다 — 설정 → AI 연결에서 연결하세요'), { code: 'no_credential' });
    return { wire: 'gemini', base: gbase, headers: { 'x-goog-api-key': env.GEMINI_API_KEY } };
  }
  const base = String(env.ANTHROPIC_BASE_URL || '').trim().replace(/\/+$/, '');
  if (!base) throw Object.assign(new Error(en ? 'Runner endpoint is not configured (ANTHROPIC_BASE_URL missing)' : '러너 엔드포인트가 설정되지 않았습니다(ANTHROPIC_BASE_URL 없음)'), { code: 'native_no_base' });
  if (env.CLAUDE_CODE_OAUTH_TOKEN) throw Object.assign(new Error(en ? 'This runner is connected with a subscription login, which the native engine cannot use — connect it with an API key in Settings → AI connections' : '이 러너는 구독 로그인으로 연결돼 있어 네이티브 엔진이 쓸 수 없습니다 — 설정 → AI 연결에서 API 키로 연결하세요'), { code: 'native_oauth_unsupported' });
  if (env.ANTHROPIC_AUTH_TOKEN) return { wire: 'messages', base, headers: { authorization: `Bearer ${env.ANTHROPIC_AUTH_TOKEN}` } };
  if (env.ANTHROPIC_API_KEY) return { wire: 'messages', base, headers: { 'x-api-key': env.ANTHROPIC_API_KEY } };
  throw Object.assign(new Error(en ? 'No runner credential found — connect it in Settings → AI connections' : '러너 자격이 없습니다 — 설정 → AI 연결에서 연결하세요'), { code: 'native_no_cred' });
}

export { extractErrorMessage } from './http-errors.mjs';

import { extractErrorMessage, VENDOR_HTTP_TIMEOUT_MS } from './http-errors.mjs';
import { callGemini, GEMINI_DEFAULT_BASE } from './gemini-wire.mjs';
import { callResponses } from './responses-wire.mjs';

const RETRYABLE = new Set([500, 502, 503, 504, 529]);

/** 다른 와이어가 전사에 남긴 사이드채널(gemini 사고 파트 gem_thought·thoughtSignature _gemSig)은 Anthropic 와이어에 보내지 않는다(순수) —
    크루 러너를 바꿔 같은 세션을 이어갈 때 알 수 없는 필드로 400이 나지 않게. */
export function stripForeignBlocks(messages) {
  return (messages ?? []).map((m) => (Array.isArray(m?.content)
    ? { ...m, content: m.content.filter((b) => b?.type !== 'gem_thought').map((b) => { if (b && typeof b === 'object' && '_gemSig' in b) { const { _gemSig, ...rest } = b; return rest; } return b; }) }
    : m)).filter((m) => !(Array.isArray(m?.content) && m.content.length === 0)); // 사고 파트만 든 메시지는 통째로(빈 content는 400 — 2R INFO)
}

/** POST /v1/messages 1회(+과부하·네트워크 1회 재시도). 실패는 `API Error: <status> <message>`(status 필드 동봉). */
export async function callMessages({ wire = 'messages', base, headers, body, effort = '', minOutputTokens = 0, signal, fetchImpl = globalThis.fetch, timeoutMs = VENDOR_HTTP_TIMEOUT_MS, retry = 1 }) {
  // 와이어별 옵션(effort·minOutputTokens)은 body 밖 — messages 갈래는 body를 원형 그대로 보내므로 본문에 섞이면 벤더로 새어 나간다(#445 2R N-HIGH-1)
  if (wire === 'gemini') return callGemini({ base, headers, body, minOutputTokens, signal, fetchImpl, timeoutMs, retry }); // 요청·응답 모양은 Messages 그대로, 변환은 gemini-wire가
  if (wire === 'responses') return callResponses({ base, headers, body, effort, signal, fetchImpl, timeoutMs, retry }); // effort(추론 강도)는 Responses에만 실린다
  const url = `${base}/v1/messages`;
  let attempt = 0;
  for (;;) {
    attempt += 1;
    const timeout = AbortSignal.timeout(timeoutMs);
    const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let r;
    try {
      r = await fetchImpl(url, {
        method: 'POST', signal: sig,
        headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', accept: 'application/json', ...headers },
        body: JSON.stringify(Array.isArray(body?.messages) ? { ...body, messages: stripForeignBlocks(body.messages) } : body),
      });
    } catch (e) {
      if (signal?.aborted) throw Object.assign(new Error('aborted'), { aborted: true, cause: e });
      if (attempt <= retry) { await new Promise((res) => setTimeout(res, 1500 * attempt)); continue; }
      throw Object.assign(new Error(`API Error: network ${String(e?.message || e)}`), { cause: e });
    }
    if (r.ok) return await r.json();
    const text = await r.text().catch(() => '');
    if (RETRYABLE.has(r.status) && attempt <= retry) { await new Promise((res) => setTimeout(res, 1500 * attempt)); continue; }
    throw Object.assign(new Error(`API Error: ${r.status} ${extractErrorMessage(text)}`), { status: r.status, body: text.slice(0, 2000) });
  }
}
