// Gemini(Google AI Studio, generativelanguage v1beta) 와이어 변환 — 네이티브 엔진은 Anthropic Messages 형식(system·messages·tools)으로 말하고,
// 이 계층이 요청은 generateContent(systemInstruction·contents·functionDeclarations)로, 응답은 Messages 응답 모양(content 블록·stop_reason·usage)으로 되돌린다.
// Hermes·OpenClaw의 gemini 프로바이더와 같은 공개 API 키 경로(구독 CLI가 아니다). 변환기는 순수 함수라 테스트가 직접 잠근다.
import { extractErrorMessage } from './http-errors.mjs';

export const GEMINI_DEFAULT_BASE = 'https://generativelanguage.googleapis.com/v1beta';

// Gemini functionDeclarations.parameters는 OpenAPI 부분집합 — JSON Schema 전용 키($schema·additionalProperties·default…)는 400으로 거절된다.
const SCHEMA_KEEP = new Set(['type', 'properties', 'required', 'description', 'enum', 'items', 'format', 'nullable', 'minimum', 'maximum', 'minItems', 'maxItems']);
export function cleanSchema(s) {
  if (!s || typeof s !== 'object') return s;
  if (Array.isArray(s)) return s.map(cleanSchema);
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    if (!SCHEMA_KEEP.has(k)) continue;
    if (k === 'type' && Array.isArray(v)) { out.type = v.find((x) => x !== 'null') ?? 'string'; if (v.includes('null')) out.nullable = true; continue; } // ['string','null'] → nullable
    if (k === 'properties') { out.properties = Object.fromEntries(Object.entries(v ?? {}).map(([n, p]) => [n, cleanSchema(p)])); continue; }
    if (k === 'items') { out.items = cleanSchema(v); continue; }
    out[k] = v;
  }
  if (out.type === 'object' && out.properties && Object.keys(out.properties).length === 0) delete out.properties; // 빈 properties는 거절
  return out;
}

const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : String(c ?? ''));

/** Messages 요청 → generateContent 요청(순수). tool_result는 functionResponse가 되는데 Gemini는 이름으로 짝을 맞추므로 앞선 tool_use의 id→name을 찾는다. */
export function toGeminiRequest({ system, messages, tools, max_tokens }) {
  const names = new Map();
  for (const m of messages ?? []) if (m.role === 'assistant' && Array.isArray(m.content)) for (const b of m.content) if (b?.type === 'tool_use') names.set(b.id, b.name);
  const contents = [];
  const push = (role, parts) => { if (!parts.length) return; const last = contents.at(-1); if (last && last.role === role) last.parts.push(...parts); else contents.push({ role, parts }); }; // 같은 역할 연속은 합친다
  for (const m of messages ?? []) {
    const role = m.role === 'assistant' ? 'model' : 'user';
    if (typeof m.content === 'string') { push(role, [{ text: m.content }]); continue; }
    const parts = [];
    for (const b of m.content ?? []) {
      if (b?.type === 'text') parts.push({ text: b.text });
      else if (b?.type === 'image' && b.source?.type === 'base64') parts.push({ inlineData: { mimeType: b.source.media_type, data: b.source.data } });
      else if (b?.type === 'tool_use') parts.push({ functionCall: { name: b.name, args: b.input ?? {} } });
      else if (b?.type === 'tool_result') {
        const inner = Array.isArray(b.content) ? b.content : [{ type: 'text', text: String(b.content ?? '') }];
        parts.push({ functionResponse: { name: names.get(b.tool_use_id) ?? 'tool', response: { result: textOf(inner), ...(b.is_error ? { error: true } : {}) } } });
        for (const x of inner) if (x?.type === 'image' && x.source?.type === 'base64') parts.push({ inlineData: { mimeType: x.source.media_type, data: x.source.data } }); // 스크린샷은 응답 옆 이미지 파트로
      }
    }
    push(role, parts);
  }
  const decls = (tools ?? []).map((t) => ({ name: t.name, description: t.description ?? '',
    ...(Object.keys(t.input_schema?.properties ?? {}).length ? { parameters: cleanSchema(t.input_schema) } : {}) }));
  return {
    ...(system ? { systemInstruction: { parts: [{ text: textOf(system) }] } } : {}),
    contents,
    ...(decls.length ? { tools: [{ functionDeclarations: decls }] } : {}),
    generationConfig: { maxOutputTokens: max_tokens },
  };
}

let seq = 0;
/** generateContent 응답 → Messages 응답 모양(순수). functionCall에는 id가 없어 우리가 만든다(전사 안에서만 유효). thought 파트는 버린다. */
export function fromGeminiResponse(json, model) {
  const cand = json?.candidates?.[0];
  if (!cand) throw Object.assign(new Error(`API Error: 400 Gemini returned no candidates (${json?.promptFeedback?.blockReason || 'empty'})`), { status: 400 });
  const content = [];
  for (const p of cand.content?.parts ?? []) {
    if (p?.thought) continue;
    if (typeof p?.text === 'string') content.push({ type: 'text', text: p.text });
    else if (p?.functionCall) content.push({ type: 'tool_use', id: `gem_${Date.now().toString(36)}_${++seq}`, name: p.functionCall.name, input: p.functionCall.args ?? {} });
  }
  const stop_reason = content.some((b) => b.type === 'tool_use') ? 'tool_use' : cand.finishReason === 'MAX_TOKENS' ? 'max_tokens' : 'end_turn';
  const u = json.usageMetadata ?? {};
  return { id: `gem_${Date.now().toString(36)}`, type: 'message', role: 'assistant', model: json.modelVersion || model, content, stop_reason,
    usage: { input_tokens: Number(u.promptTokenCount) || 0, output_tokens: Number(u.candidatesTokenCount) || 0 } };
}

const RETRYABLE = new Set([500, 502, 503, 504]);
/** POST models/{model}:generateContent 1회(+과부하·네트워크 1회 재시도). 실패는 `API Error: <status> <message>` — 무효 키(400 API_KEY_INVALID)는 401로 승격해
    인증 분류기(AUTH_TEXT_RE)·턴 전 게이트가 같은 계급으로 문다. */
export async function callGemini({ base, headers, body, signal, fetchImpl = globalThis.fetch, timeoutMs = 600_000, retry = 1 }) {
  const url = `${base}/models/${encodeURIComponent(body.model)}:generateContent`;
  const req = toGeminiRequest(body);
  let attempt = 0;
  for (;;) {
    attempt += 1;
    const timeout = AbortSignal.timeout(timeoutMs);
    const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let r;
    try { r = await fetchImpl(url, { method: 'POST', signal: sig, headers: { 'content-type': 'application/json', accept: 'application/json', ...headers }, body: JSON.stringify(req) }); }
    catch (e) {
      if (signal?.aborted) throw Object.assign(new Error('aborted'), { aborted: true, cause: e });
      if (attempt <= retry) { await new Promise((res) => setTimeout(res, 1500 * attempt)); continue; }
      throw Object.assign(new Error(`API Error: network ${String(e?.message || e)}`), { cause: e });
    }
    if (r.ok) return fromGeminiResponse(await r.json(), body.model);
    const text = await r.text().catch(() => '');
    if (RETRYABLE.has(r.status) && attempt <= retry) { await new Promise((res) => setTimeout(res, 1500 * attempt)); continue; }
    const status = r.status === 400 && /API_KEY_INVALID|API key not valid/i.test(text) ? 401 : r.status;
    throw Object.assign(new Error(`API Error: ${status} ${extractErrorMessage(text)}`), { status, body: text.slice(0, 2000) });
  }
}
