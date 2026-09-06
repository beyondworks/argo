// 엄격 벤더 가짜 서버 — 제보·문서로 확인된 벤더별 거절 규칙을 누적한다(2026-09-06 Grok 400 제보 뒤 도입).
// 무엇이든 200을 주던 가짜 서버로는 벤더 엄격성을 볼 수 없어 v0.1.62 Grok 턴 전멸을 놓쳤다. 도구 스키마 테스트(native-tool-schema S3)와 검진 프로브 테스트가 이 서버 위에서 돈다 — 나머지 네이티브 엔진 테스트 이관은 후속.
// 규칙은 (name, check(body) → 거절 문구|null) 한 줄씩. 새 제보가 오면 규칙 한 줄을 더한다 — 같은 모양은 두 번 새지 않는다.
import { createServer } from 'node:http';

const walkSchemas = (s, out = []) => { if (!s || typeof s !== 'object') return out; out.push(s); for (const v of Object.values(s.properties ?? {})) walkSchemas(v, out); if (s.items) walkSchemas(s.items, out); for (const k of ['anyOf', 'oneOf', 'allOf', 'prefixItems']) for (const v of s[k] ?? []) walkSchemas(v, out); return out; };

/** 벤더별 규칙 — Anthropic Messages 와이어(/v1/messages) 본문을 본다. */
export const VENDOR_RULES = {
  // xAI(Grok) — 사용자 제보 2026-09-06(v0.1.62): object 스키마에 required 배열이 없으면 `400 Invalid request content: Schema validation failed: [standard_violation] /required: null is not of type "array"`
  xai: [
    (body) => { for (const t of body.tools ?? []) for (const s of walkSchemas(t.input_schema)) if (s.type === 'object' && !Array.isArray(s.required)) return `Invalid request content: Schema validation failed: [standard_violation] /required: null is not of type "array" (invalid-argument) [tool ${t.name}]`; return null; },
  ],
  // Anthropic — 도구 이름·max_tokens 필수(공식 문서)
  anthropic: [
    (body) => (!Number.isInteger(body.max_tokens) || body.max_tokens < 1 ? 'max_tokens: Field required' : null),
    // 미지 최상위 필드 → 400(#445 2R N-HIGH-1: 프로브 전용 min_output_tokens가 messages 본문에 실려 나갔다 — 이 서버의 존재 이유가 정확히 '예상 밖 필드에 엄격한 벤더')
    (body) => { const bad = Object.keys(body).find((k) => !ANTHROPIC_TOP.has(k)); return bad ? `${bad}: Extra inputs are not permitted` : null; },
    (body) => { for (const t of body.tools ?? []) if (!/^[a-zA-Z0-9_-]{1,128}$/.test(String(t.name ?? ''))) return `tools.${t.name}.name: String should match pattern '^[a-zA-Z0-9_-]{1,128}$'`; return null; },
  ],
};

/** 엄격 가짜 벤더를 띄운다 — vendor 규칙 전부 통과하면 reply(body)로 응답(기본: 텍스트 'ok'), 위반하면 400 + Anthropic 오류 모양. */
/** Messages API 최상위 필드(공식 레퍼런스) — 이 밖은 벤더가 거절할 수 있는 필드로 본다. */
const ANTHROPIC_TOP = new Set(['model', 'max_tokens', 'messages', 'system', 'tools', 'tool_choice', 'metadata', 'stop_sequences', 'stream', 'temperature', 'top_p', 'top_k', 'thinking', 'service_tier']);

export async function startStrictVendor({ vendor = 'xai', reply = null } = {}) {
  const rules = [...(VENDOR_RULES[vendor] ?? []), ...(vendor !== 'anthropic' ? VENDOR_RULES.anthropic : [])];
  const calls = [];
  const srv = createServer((req, res) => {
    let d = ''; req.on('data', (c) => { d += c; });
    req.on('end', () => {
      let body = {}; try { body = JSON.parse(d || '{}'); } catch { /* 빈 본문 */ }
      calls.push({ url: req.url, headers: req.headers, body });
      // 경로·인증 헤더도 본다(1R LOW-4 잔여): 실벤더는 /v1/messages 밖은 404, 키 없는 요청은 401
      if (req.url !== '/v1/messages') { res.writeHead(404, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: `Not Found: ${req.url}` } })); }
      if (!req.headers['x-api-key'] && !req.headers.authorization) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'missing api key' } })); }
      for (const rule of rules) { const bad = rule(body); if (bad) { res.writeHead(400, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: bad } })); } }
      const out = typeof reply === 'function' ? reply(body, calls.length) : (reply ?? { id: `msg_${calls.length}`, type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } });
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(out));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${srv.address().port}`, calls, close: () => new Promise((r) => srv.close(r)) };
}
