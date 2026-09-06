// Gemini(Google AI Studio, generativelanguage v1beta) 와이어 변환 — 네이티브 엔진은 Anthropic Messages 형식(system·messages·tools)으로 말하고,
// 이 계층이 요청은 generateContent(systemInstruction·contents·functionDeclarations)로, 응답은 Messages 응답 모양(content 블록·stop_reason·usage)으로 되돌린다.
// Hermes·OpenClaw의 gemini 프로바이더와 같은 공개 API 키 경로(구독 CLI가 아니다). 변환기는 순수 함수라 테스트가 직접 잠근다.
// 사고 파트·thoughtSignature는 블록에 실어 보존한다(gem_thought 블록·_gemSig 사이드채널) — 표시·도구 실행은 type으로 거르므로 새지 않고, 다음 요청이
// 받은 그대로 되돌린다(공식 계약: 서명이 붙은 파트를 제거·수정하지 말 것 — 분리 검수 H3).
import { extractErrorMessage } from './http-errors.mjs';

export const GEMINI_DEFAULT_BASE = 'https://generativelanguage.googleapis.com/v1beta';
/** generationConfig.maxOutputTokens 하한 — Gemini는 사고(thinking) 토큰이 이 상한에 포함된다(2.5 Pro는 사고 기본 켜짐). 엔진 기본 8192(OpenRouter 402 완화용)를
    그대로 쓰면 긴 사고가 가시 출력을 0으로 잘라 빈 답이 된다(분리 검수 H4). 상한은 절단 한계지 과금 단위가 아니라 올려도 비용이 늘지 않는다. */
export const GEMINI_MIN_OUTPUT_TOKENS = 16_384;

// Gemini functionDeclarations.parameters는 OpenAPI 3.0 부분집합 = 공식 Schema 필드 전부(REST 레퍼런스 대조 2026-09-06). `default`는 문서상 "무시하되 거절은 아님".
// JSON Schema 전용 구조($schema·additionalProperties·$ref/$defs·oneOf/allOf·const·type 배열)는 여기서 해석·변환한다 — MCP 도구 스키마가 흔히 준다(분리 검수 H2).
const SCHEMA_KEEP = new Set(['type', 'format', 'title', 'description', 'enum', 'maxItems', 'minItems', 'properties', 'required', 'minProperties', 'maxProperties', 'minLength', 'maxLength', 'pattern', 'example', 'propertyOrdering', 'default', 'items', 'minimum', 'maximum']);
const TYPES = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object']);

const arr = (x) => (Array.isArray(x) ? x : []);
const obj = (x) => (x && typeof x === 'object' && !Array.isArray(x) ? x : {});
function resolveRef(ref, root) {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return null;
  let cur = root;
  for (const seg of ref.slice(2).split('/')) { cur = cur?.[seg.replace(/~1/g, '/').replace(/~0/g, '~')]; if (cur === undefined) return null; }
  return cur && typeof cur === 'object' ? cur : null;
}

/** JSON Schema → Gemini Schema(순수). 불변식: 결과의 모든 노드에 type 또는 anyOf가 있다(Schema.type은 Required — $ref/oneOf 노드가 통째로 걷혀 `{}`가 되면 실벤더 400).
    $ref는 루트(#/$defs·#/definitions) 기준 인라인, oneOf→anyOf, allOf→얕은 병합, const→enum, type 배열·null 대안→nullable, enum은 STRING 전용. */
export function cleanSchema(s, root = s, depth = 0) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return { type: 'string' };
  if (depth > 12) return { type: 'string', description: 'nested too deep' }; // 순환 $ref 방어
  if (typeof s.$ref === 'string') { const { $ref, ...rest } = s; const target = resolveRef($ref, root); return cleanSchema({ ...(target ?? {}), ...rest }, root, depth + 1); }
  let src = s;
  if (Array.isArray(src.allOf) && src.allOf.length) { // 교집합은 얕은 병합(properties·required 합집합, 나머지는 바깥 우선)
    let merged = { ...src }; delete merged.allOf;
    for (const b of src.allOf) {
      const r = (b && typeof b === 'object' ? (typeof b.$ref === 'string' ? resolveRef(b.$ref, root) : b) : null); if (!r) continue;
      // 비배열 required(Swagger 2.0 관례 `required: true`)·비객체 properties는 스프레드에서 TypeError — 배열/객체로 강제(3R M-1: 2R HIGH-1과 같은 턴 전멸 계열)
      merged = { ...r, ...merged, properties: { ...obj(r.properties), ...obj(merged.properties) }, required: [...new Set([...arr(merged.required), ...arr(r.required)])] };
    }
    // 해석 불가 가지(#/components/schemas/… 외부 $ref·null·문자열)뿐이면 병합 결과가 비어 있다 — undefined 접근으로 턴 전체가 TypeError로 죽던 것(2R HIGH-1)
    if (!Object.keys(merged.properties ?? {}).length) delete merged.properties; if (!(merged.required ?? []).length) delete merged.required;
    src = merged;
  }
  const out = {};
  let nullable = src.nullable === true;
  let hint = null; // 비문자 enum/const — Gemini enum은 STRING 전용이라 값을 문자열로 강등하면 도구가 받는 인자 타입이 바뀐다(2R LOW-1) → 원 타입 유지 + 허용값은 설명에
  for (const [k, v] of Object.entries(src)) {
    if (!SCHEMA_KEEP.has(k)) continue;
    if (k === 'type') { const arr = (Array.isArray(v) ? v : [v]).map((x) => String(x).toLowerCase()); if (arr.includes('null')) nullable = true; const t = arr.find((x) => TYPES.has(x)); if (t) out.type = t; continue; }
    if (k === 'properties') { if (v && typeof v === 'object' && !Array.isArray(v)) out.properties = Object.fromEntries(Object.entries(v).map(([n, p]) => [n, cleanSchema(p, root, depth + 1)])); continue; }
    if (k === 'items') { out.items = cleanSchema(Array.isArray(v) ? v[0] : v, root, depth + 1); continue; }
    if (k === 'enum') { if (Array.isArray(v) && v.length) { const vals = v.filter((x) => x !== null); if (vals.length !== v.length) nullable = true; if (vals.length) { if (vals.every((x) => typeof x === 'string')) out.enum = vals; else hint = vals; } } continue; }
    if (k === 'required' || k === 'propertyOrdering') { if (Array.isArray(v)) { const arr = v.filter((x) => typeof x === 'string'); if (arr.length) out[k] = arr; } continue; }
    if (k === 'description' || k === 'format' || k === 'title' || k === 'pattern') { if (typeof v === 'string') out[k] = v; continue; } // 문자열 필드는 문자열만(비문자 값은 벤더 400 — 4R INFO-1)
    out[k] = v;
  }
  if (src.const !== undefined && src.const !== null && !out.enum && !hint) { if (typeof src.const === 'string') out.enum = [src.const]; else hint = [src.const]; }
  const branches = Array.isArray(src.anyOf) ? src.anyOf : Array.isArray(src.oneOf) ? src.oneOf : null;
  if (branches && branches.length) {
    const isNull = (b) => !!b && typeof b === 'object' && (b.type === 'null' || (Array.isArray(b.type) && b.type.length && b.type.every((x) => x === 'null')) || (Array.isArray(b.enum) && b.enum.length && b.enum.every((x) => x === null)));
    if (branches.some(isNull)) nullable = true;
    const nonNull = branches.filter((b) => !isNull(b)).map((b) => cleanSchema(b, root, depth + 1));
    if (nonNull.length === 1) { const inline = nonNull[0]; if (inline.nullable) nullable = true; delete inline.nullable; Object.assign(out, { ...inline, ...out }); } // 단일 대안은 인라인(부모 description 등 우선)
    else if (nonNull.length > 1) { out.anyOf = nonNull; delete out.type; }
  }
  if (out.enum) out.type = 'string'; // Gemini enum은 STRING 전용(여기 도달하는 enum은 전부 문자열 값)
  if (hint) {
    out.description = `${out.description ? `${out.description} ` : ''}(allowed values: ${hint.map((x) => JSON.stringify(x)).join(', ')})`;
    if (!out.type && !out.anyOf) out.type = typeof hint[0] === 'number' ? (Number.isInteger(hint[0]) ? 'integer' : 'number') : typeof hint[0] === 'boolean' ? 'boolean' : 'string';
  }
  if (!out.type && !out.anyOf) out.type = out.properties ? 'object' : out.items ? 'array' : 'string';
  if (out.type !== 'object') { delete out.properties; delete out.required; delete out.propertyOrdering; delete out.minProperties; delete out.maxProperties; }
  if (out.type !== 'array') { delete out.items; delete out.minItems; delete out.maxItems; }
  if (out.type === 'object' && out.properties && !Object.keys(out.properties).length) delete out.properties; // 빈 properties는 거절
  if (out.required && out.properties) { out.required = out.required.filter((n) => n in out.properties); if (!out.required.length) delete out.required; }
  if (nullable) out.nullable = true;
  return out;
}

const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : String(c ?? ''));
const sigOut = (b) => (typeof b?._gemSig === 'string' && b._gemSig ? { thoughtSignature: b._gemSig } : {});
const vendorId = (id) => (typeof id === 'string' && id && !id.startsWith('gem_') ? { id } : {}); // 벤더가 준 functionCall.id만 되싣는다(우리가 만든 gem_ id는 전사 안에서만 유효)

/** Messages 요청 → generateContent 요청(순수). tool_result는 functionResponse가 되는데 Gemini는 이름(과 벤더 id)으로 짝을 맞추므로 앞선 tool_use의 id→name을 찾는다. */
export function toGeminiRequest({ system, messages, tools, max_tokens, min_output_tokens }) {
  const names = new Map();
  for (const m of messages ?? []) if (m.role === 'assistant' && Array.isArray(m.content)) for (const b of m.content) if (b?.type === 'tool_use') names.set(b.id, b.name);
  const contents = [];
  const push = (role, parts) => { if (!parts.length) return; const last = contents.at(-1); if (last && last.role === role) last.parts.push(...parts); else contents.push({ role, parts }); }; // 같은 역할 연속은 합친다
  for (const m of messages ?? []) {
    const role = m.role === 'assistant' ? 'model' : 'user';
    if (typeof m.content === 'string') { push(role, [{ text: m.content }]); continue; }
    const parts = [];
    for (const b of m.content ?? []) {
      if (b?.type === 'text') parts.push({ text: b.text, ...sigOut(b) });
      else if (b?.type === 'gem_thought') parts.push({ thought: true, text: typeof b.text === 'string' ? b.text : '', ...sigOut(b) }); // 받은 그대로 되돌린다
      else if (b?.type === 'image' && b.source?.type === 'base64') parts.push({ inlineData: { mimeType: b.source.media_type, data: b.source.data } });
      else if (b?.type === 'tool_use') parts.push({ functionCall: { ...vendorId(b.id), name: b.name, args: b.input ?? {} }, ...sigOut(b) });
      else if (b?.type === 'tool_result') {
        const inner = Array.isArray(b.content) ? b.content : [{ type: 'text', text: String(b.content ?? '') }];
        const images = inner.filter((x) => x?.type === 'image' && x.source?.type === 'base64').map((x) => ({ inlineData: { mimeType: x.source.media_type, data: x.source.data } }));
        // 스크린샷은 FunctionResponse.parts(멀티모달 함수 응답 — 공식 경로, 분리 검수 M4). 형제 inlineData 파트는 "함수 응답 파트 수 = 호출 수" 검사에 걸릴 수 있다.
        parts.push({ functionResponse: { ...vendorId(b.tool_use_id), name: names.get(b.tool_use_id) ?? 'tool', response: { result: textOf(inner), ...(b.is_error ? { error: true } : {}) }, ...(images.length ? { parts: images } : {}) } });
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
    generationConfig: { maxOutputTokens: Math.max(Number(max_tokens) || 0, Number(min_output_tokens) > 0 ? Number(min_output_tokens) : GEMINI_MIN_OUTPUT_TOKENS) }, // 검진 프로브는 하한을 낮춘다(1R MEDIUM-1)
  };
}

let seq = 0;
const sigIn = (p) => (typeof p?.thoughtSignature === 'string' && p.thoughtSignature ? { _gemSig: p.thoughtSignature } : {});
/** generateContent 응답 → Messages 응답 모양(순수). functionCall id는 벤더가 주면 보존(functionResponse.id로 짝 맞춤 — M3), 없으면 우리가 만든다(전사 안에서만 유효).
    가시 파트(텍스트·함수 호출) 0은 조용한 빈 답이 아니라 오류다(H4) — SAFETY·RECITATION·MAX_TOKENS(사고가 상한 소진)·MALFORMED_FUNCTION_CALL… 사유를 실어 던진다. */
export function fromGeminiResponse(json, model) {
  const cand = json?.candidates?.[0];
  if (!cand) throw Object.assign(new Error(`API Error: 400 Gemini returned no candidates (${json?.promptFeedback?.blockReason || 'empty'})`), { status: 400, synthetic: true }); // synthetic = 벤더 HTTP 오류가 아니라 와이어가 합성(검진 프로브는 판정 불가로 흡수)
  const content = [];
  for (const p of cand.content?.parts ?? []) {
    if (p?.thought) content.push({ type: 'gem_thought', text: typeof p.text === 'string' ? p.text : '', ...sigIn(p) });
    else if (typeof p?.text === 'string') content.push({ type: 'text', text: p.text, ...sigIn(p) });
    else if (p?.functionCall) content.push({ type: 'tool_use', id: (typeof p.functionCall.id === 'string' && p.functionCall.id) || `gem_${Date.now().toString(36)}_${++seq}`, name: p.functionCall.name, input: p.functionCall.args ?? {}, ...sigIn(p) });
  }
  const u = json.usageMetadata ?? {};
  // 사고 토큰도 출력 과금(문서: 응답 가격 = 출력 + 사고 토큰 — M5). 대시보드 output·inPerOut이 2.5 Pro에서 상시 과소이던 것 교정.
  const usage = { input_tokens: Number(u.promptTokenCount) || 0, output_tokens: (Number(u.candidatesTokenCount) || 0) + (Number(u.thoughtsTokenCount) || 0) };
  if (!content.some((b) => b.type === 'tool_use' || (b.type === 'text' && b.text.trim()))) {
    const reason = String(cand.finishReason || 'UNKNOWN');
    // usage 동봉 — 차단 응답도 프롬프트 토큰은 썼다. native-query가 첫 스텝이어도 집계에 실을 수 있게(2R LOW-3)
    throw Object.assign(new Error(`API Error: 400 Gemini returned no usable content (finishReason=${reason}${cand.finishMessage ? ` — ${String(cand.finishMessage).slice(0, 200)}` : ''}${reason === 'MAX_TOKENS' ? ' — thinking consumed the output budget' : ''})`), { status: 400, finishReason: reason, usage, synthetic: true });
  }
  const stop_reason = content.some((b) => b.type === 'tool_use') ? 'tool_use' : cand.finishReason === 'MAX_TOKENS' ? 'max_tokens' : 'end_turn';
  return { id: `gem_${Date.now().toString(36)}`, type: 'message', role: 'assistant', model: json.modelVersion || model, content, stop_reason, usage };
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
