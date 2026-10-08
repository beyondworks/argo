// 엄격 벤더 가짜 서버 — 제보·문서로 확인된 벤더별 거절 규칙을 누적한다(2026-09-06 Grok 400 제보 뒤 도입).
// 무엇이든 200을 주던 가짜 서버로는 벤더 엄격성을 볼 수 없어 v0.1.62 Grok 턴 전멸을 놓쳤다. 도구 스키마 테스트(native-tool-schema S3)와 검진 프로브 테스트가 이 서버 위에서 돈다 — 나머지 네이티브 엔진 테스트 이관은 후속.
// 규칙은 (name, check(body) → 거절 문구|null) 한 줄씩. 새 제보가 오면 규칙 한 줄을 더한다 — 같은 모양은 두 번 새지 않는다.
import { createServer } from 'node:http';

/** 본문 안 cache_control 자리 수(프롬프트 캐시 표지 — B1). */
const cacheMarks = (x) => { if (!x || typeof x !== 'object') return []; if (Array.isArray(x)) return x.flatMap(cacheMarks); return Object.entries(x).flatMap(([k, v]) => (k === 'cache_control' ? [v] : cacheMarks(v))); };
/** 캐시 표지를 모르는 벤더로 가정하는 규칙 — xAI·z.ai·Moonshot의 Anthropic 호환 엔드포인트가 cache_control을 받는지는 확인 안 함.
    모르는 필드에 400을 낸 전례(xAI required, 2026-09-06)가 있어 보수적으로 거절로 둔다 — 이 규칙이 있는 한 엔진이 그 벤더에 표지를 실으면 테스트가 red. */
const NO_CACHE_CONTROL = (body) => (cacheMarks(body).length ? 'Invalid request content: unknown field cache_control' : null);

const walkSchemas = (s, out = []) => { if (!s || typeof s !== 'object') return out; out.push(s); for (const v of Object.values(s.properties ?? {})) walkSchemas(v, out); if (s.items) walkSchemas(s.items, out); for (const k of ['anyOf', 'oneOf', 'allOf', 'prefixItems']) for (const v of s[k] ?? []) walkSchemas(v, out); return out; };

/** 벤더별 규칙 — Anthropic Messages 와이어(/v1/messages) 본문을 본다. */
export const VENDOR_RULES = {
  // xAI(Grok) — 사용자 제보 2026-09-06(v0.1.62): object 스키마에 required 배열이 없으면 `400 Invalid request content: Schema validation failed: [standard_violation] /required: null is not of type "array"`
  xai: [
    NO_CACHE_CONTROL,
    (body) => { for (const t of body.tools ?? []) for (const s of walkSchemas(t.input_schema)) if (s.type === 'object' && !Array.isArray(s.required)) return `Invalid request content: Schema validation failed: [standard_violation] /required: null is not of type "array" (invalid-argument) [tool ${t.name}]`; return null; },
  ],
  // GLM(z.ai)·Kimi(Moonshot)의 Anthropic 호환 엔드포인트 — 캐시 표지 보수 거절(위 NO_CACHE_CONTROL 주석)
  zai: [NO_CACHE_CONTROL],
  moonshot: [NO_CACHE_CONTROL],
  // Anthropic — 도구 이름·max_tokens 필수(공식 문서)
  anthropic: [
    // 프롬프트 캐시 표지는 요청당 4곳까지, type은 ephemeral(공식 문서 "A maximum of 4 blocks with cache_control")
    (body) => { const m = cacheMarks(body); if (m.length > 4) return `A maximum of 4 blocks with cache_control may be provided. Found ${m.length}.`; return m.find((v) => v?.type !== 'ephemeral') ? 'cache_control.type: Input should be \'ephemeral\'' : null; },
    (body) => (!Number.isInteger(body.max_tokens) || body.max_tokens < 1 ? 'max_tokens: Field required' : null),
    // 미지 최상위 필드 → 400(#445 2R N-HIGH-1: 프로브 전용 min_output_tokens가 messages 본문에 실려 나갔다 — 이 서버의 존재 이유가 정확히 '예상 밖 필드에 엄격한 벤더')
    (body) => { const bad = Object.keys(body).find((k) => !ANTHROPIC_TOP.has(k)); return bad ? `${bad}: Extra inputs are not permitted` : null; },
    (body) => { for (const t of body.tools ?? []) if (!/^[a-zA-Z0-9_-]{1,128}$/.test(String(t.name ?? ''))) return `tools.${t.name}.name: String should match pattern '^[a-zA-Z0-9_-]{1,128}$'`; return null; },
  ],
};

/** Anthropic 와이어가 아닌 벤더 — 경로·인증 헤더·응답 모양이 다르다. 본문 규칙은 캐시 표지 거절(B1 표지는 Anthropic Messages 와이어 전용)과
    각 벤더의 최소 필수 필드다. Gemini(generateContent)는 모르는 필드를 'Unknown name' 400으로, OpenAI Responses는 'Unknown parameter' 400으로 거절한다고
    가정한다(엄격 쪽 가정 — 실벤더 확인 아님, 이 서버의 목적은 엔진이 그 와이어에 표지를 싣지 않는다는 것을 잠그는 것). */
const OTHER_WIRES = {
  gemini: {
    path: /^\/models\/[^/]+:generateContent$/, auth: (h) => !!h['x-goog-api-key'],
    rules: [
      (body) => (cacheMarks(body).length ? 'Invalid JSON payload received. Unknown name "cache_control": Cannot find field.' : null),
      (body) => (!Array.isArray(body.contents) || !body.contents.length ? 'contents is not specified' : null),
    ],
    ok: (body, n) => ({ status: 200, type: 'application/json', body: JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 }, responseId: `g${n}` }) }),
    bad: (msg) => JSON.stringify({ error: { code: 400, message: msg, status: 'INVALID_ARGUMENT' } }),
  },
  responses: {
    path: /^\/responses$/, auth: (h) => !!h.authorization,
    rules: [
      (body) => (cacheMarks(body).length ? "Unknown parameter: 'cache_control'." : null),
      (body) => (!body.model ? "Missing required parameter: 'model'." : null),
    ],
    ok: (body, n) => {
      const ev = { type: 'response.completed', response: { id: `resp_${n}`, model: body.model, status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }], usage: { input_tokens: 1, output_tokens: 1 } } };
      return { status: 200, type: 'text/event-stream', body: `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n` };
    },
    bad: (msg) => JSON.stringify({ error: { message: msg, type: 'invalid_request_error', param: null, code: 'unknown_parameter' } }),
  },
};

/** 컨텍스트 길이 초과 거절 — 벤더별 상태·본문 모양(제보 2026-10-08 Grok "50만·60만 컨텍스트 넘음" 뒤 추가). 문구 출처는 src/runners/error-class.mjs CONTEXT_EXCEEDED_RE 주석
    (Gemini는 포럼 원문, z.ai는 공식 오류 코드 표, 나머지는 공개 클라이언트의 벤더 문구 목록 — 실벤더에 쏴서 받은 원문 대조 아님). n = 요청 토큰(아래 셈), l = 한도.
    z.ai는 숫자 없는 문구라 엔진이 원문에서 한도를 못 읽는 갈래를 탄다. */
export const CONTEXT_REJECT = {
  xai: (n, l) => ({ status: 400, json: { code: 'Client specified an invalid argument', error: `This model's maximum prompt length is ${l} but the request contains ${n} tokens.` } }),
  anthropic: (n, l) => ({ status: 400, json: { type: 'error', error: { type: 'invalid_request_error', message: `prompt is too long: ${n} tokens > ${l} maximum` } } }),
  openrouter: (n, l) => ({ status: 400, json: { error: { message: `This endpoint's maximum context length is ${l} tokens. However, you requested about ${n} tokens (${n - 8192} of text input, 8192 in the output). Please reduce the length of either one, or use the "middle-out" transform to compress your prompt automatically.`, code: 400 } } }),
  zai: () => ({ status: 400, json: { error: { code: '1261', message: 'Prompt too long' } } }),
  moonshot: (n, l) => ({ status: 400, json: { error: { type: 'invalid_request_error', message: `Invalid request: Your request exceeded model token limit: ${l} (requested: ${n})` } } }),
  gemini: (n, l) => ({ status: 400, json: { error: { code: 400, message: `The input token count (${n}) exceeds the maximum number of tokens allowed (${l}).`, status: 'INVALID_ARGUMENT' } } }),
  responses: () => ({ status: 400, json: { error: { message: 'Your input exceeds the context window of this model. Please adjust your input and try again.', type: 'invalid_request_error', param: 'input', code: 'context_length_exceeded' } } }),
};
/** 요청 본문(날것 JSON)의 벤더 토큰 근사 — 정비사 실측(OpenRouter x-ai/grok-4.6, 2026-10-08): 한글 0.74, 그 밖 0.26 토큰/글자. 엔진 추정(utf-8 바이트/3)과 다르게 센다. */
export const vendorTokens = (raw) => { let h = 0; for (const ch of raw) if (ch >= '\uac00' && ch <= '\ud7a3') h += 1; return Math.ceil(h * 0.74 + (raw.length - h) * 0.26); };

/** Messages API 최상위 필드(공식 레퍼런스) — 이 밖은 벤더가 거절할 수 있는 필드로 본다. */
const ANTHROPIC_TOP = new Set(['model', 'max_tokens', 'messages', 'system', 'tools', 'tool_choice', 'metadata', 'stop_sequences', 'stream', 'temperature', 'top_p', 'top_k', 'thinking', 'service_tier']);

/** 엄격 가짜 벤더를 띄운다 — vendor 규칙 전부 통과하면 reply(body)로 응답(기본: 텍스트 'ok'), 위반하면 400 + Anthropic 오류 모양. 경로는 /v1/messages만(404), 인증 헤더(x-api-key 또는 authorization) 없으면 401.
    vendor 'gemini'·'responses'는 그 와이어의 경로·인증·응답 모양(위 OTHER_WIRES)으로 받는다 — 그 와이어의 reply(body, n)는 { status, type, body(문자열) }를 돌려준다.
    contextLimit = 요청 토큰 한도(countTokens로 센다, 기본 vendorTokens) 또는 (호출 번호 n) → 한도 — 넘으면 그 벤더의 길이 초과 거절(CONTEXT_REJECT). calls[].tokens에 셈을 남긴다.
    countTokens = 요청 본문(날것 JSON) → 벤더 토큰 — 해시·압축 JSON처럼 벤더가 엔진 추정(바이트/3)보다 많이 세는 내용을 흉내 낼 때 바꾼다. */
export async function startStrictVendor({ vendor = 'xai', reply = null, contextLimit = null, countTokens = vendorTokens } = {}) {
  const rules = [...(VENDOR_RULES[vendor] ?? []), ...(vendor !== 'anthropic' ? VENDOR_RULES.anthropic : [])];
  const calls = [];
  const other = OTHER_WIRES[vendor];
  const srv = createServer((req, res) => {
    let d = ''; req.on('data', (c) => { d += c; });
    req.on('end', () => {
      let body = {}; try { body = JSON.parse(d || '{}'); } catch { /* 빈 본문 */ }
      const tokens = contextLimit === null ? null : countTokens(d);
      calls.push({ url: req.url, headers: req.headers, body, tokens });
      const limit = typeof contextLimit === 'function' ? contextLimit(calls.length) : contextLimit;
      const over = limit !== null && tokens > limit ? (CONTEXT_REJECT[vendor] ?? CONTEXT_REJECT.anthropic)(tokens, limit) : null;
      if (over) calls.at(-1).rejected = 'context';
      if (other) { // Gemini·Responses 와이어 — vendor: 'gemini' | 'responses'
        const send = (status, type, text) => { res.writeHead(status, { 'content-type': type }); res.end(text); };
        if (!other.path.test(req.url)) return send(404, 'application/json', other.bad(`Not Found: ${req.url}`));
        if (!other.auth(req.headers)) return send(401, 'application/json', other.bad('missing credential'));
        if (over) return send(over.status, 'application/json', JSON.stringify(over.json));
        for (const rule of other.rules) { const bad = rule(body); if (bad) return send(400, 'application/json', other.bad(bad)); }
        const out = typeof reply === 'function' ? reply(body, calls.length) : other.ok(body, calls.length);
        return send(out.status, out.type, out.body);
      }
      // 경로·인증 헤더도 본다(1R LOW-4 잔여): 실벤더는 /v1/messages 밖은 404, 키 없는 요청은 401
      if (req.url !== '/v1/messages') { res.writeHead(404, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: `Not Found: ${req.url}` } })); }
      if (!req.headers['x-api-key'] && !req.headers.authorization) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'missing api key' } })); }
      if (over) { res.writeHead(over.status, { 'content-type': 'application/json' }); return res.end(JSON.stringify(over.json)); }
      for (const rule of rules) { const bad = rule(body); if (bad) { res.writeHead(400, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: bad } })); } }
      const out = typeof reply === 'function' ? reply(body, calls.length) : (reply ?? { id: `msg_${calls.length}`, type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } });
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(out));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${srv.address().port}`, calls, close: () => new Promise((r) => srv.close(r)) };
}
