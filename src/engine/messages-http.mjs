// Anthropic Messages 와이어 포맷 HTTP 클라이언트 — 네이티브 엔진(하네스 통일 P-A, 2026-09-05)의 유일한 벤더 접점.
// openrouter·glm·kimi·grok·(API 키) claude는 전부 이 포맷을 받는다(runnerCredEnv의 ANTHROPIC_BASE_URL 스왑과 같은 사실).
// 오류는 SDK가 내던 문구 형식 `API Error: <status> <message>`로 던진다 — error-class·AUTH_ERR_RE·자가치유가 그대로 문다.

/** 자격 env(runnerCredEnv/sdkEnvFor 산출) → 베이스 URL + 인증 헤더(순수). 구독 OAuth(CLAUDE_CODE_OAUTH_TOKEN)는
    SDK 전용 — 정책 위험(설계서 개정 2026-09-05)으로 이 엔진이 받지 않는다. */
export function authFromEnv(env = {}) {
  const base = String(env.ANTHROPIC_BASE_URL || '').trim().replace(/\/+$/, '');
  if (!base) throw Object.assign(new Error('native engine: ANTHROPIC_BASE_URL missing'), { code: 'native_no_base' });
  if (env.CLAUDE_CODE_OAUTH_TOKEN) throw Object.assign(new Error('native engine: subscription OAuth is SDK-only'), { code: 'native_oauth_unsupported' });
  if (env.ANTHROPIC_AUTH_TOKEN) return { base, headers: { authorization: `Bearer ${env.ANTHROPIC_AUTH_TOKEN}` } };
  if (env.ANTHROPIC_API_KEY) return { base, headers: { 'x-api-key': env.ANTHROPIC_API_KEY } };
  throw Object.assign(new Error('native engine: no credential in env'), { code: 'native_no_cred' });
}

/** 벤더 오류 본문에서 message만(순수) — JSON `{error:{message}}` 우선, 아니면 앞 300자. 키 마스킹은 호출부(chat.mjs)가 한다. */
export function extractErrorMessage(text) {
  const s = String(text ?? '');
  try { const j = JSON.parse(s); const m = j?.error?.message ?? j?.message ?? j?.error; if (typeof m === 'string' && m) return m.slice(0, 600); } catch { /* 본문이 JSON이 아니다 */ }
  return s.replace(/\s+/g, ' ').trim().slice(0, 300);
}

const RETRYABLE = new Set([500, 502, 503, 504, 529]);

/** POST /v1/messages 1회(+과부하·네트워크 1회 재시도). 실패는 `API Error: <status> <message>`(status 필드 동봉). */
export async function callMessages({ base, headers, body, signal, fetchImpl = globalThis.fetch, timeoutMs = 600_000, retry = 1 }) {
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
        body: JSON.stringify(body),
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
