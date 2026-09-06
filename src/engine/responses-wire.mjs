// OpenAI Responses 와이어 변환 — Codex 구독 백엔드(chatgpt.com/backend-api/codex)와 OpenAI 공개 API(api.openai.com/v1/responses)가 같은 형식을 받는다.
// 네이티브 엔진은 Anthropic Messages 형식(system·messages·tools)으로 말하고, 이 계층이 요청은 Responses(instructions·input 항목·function 도구)로,
// 응답은 Messages 응답 모양(content 블록·stop_reason·usage)으로 되돌린다. Hermes(openai-codex 프로바이더)·OpenClaw(openai 확장)와 같은 경로.
// 백엔드는 스트리밍만 확실히 지원하므로 stream:true로 보내고 SSE의 response.completed를 최종 응답으로 삼는다(JSON 응답도 수용).
import { extractErrorMessage } from './http-errors.mjs';

export const CODEX_BACKEND_BASE = 'https://chatgpt.com/backend-api/codex';
export const OPENAI_API_BASE = 'https://api.openai.com/v1';

const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : String(c ?? ''));
const dataUrl = (src) => `data:${src.media_type};base64,${src.data}`;

/** Messages 요청 → Responses 요청(순수). tool_use id = call_id 그대로 왕복하므로 id 매핑이 필요 없다. 이전 턴의 reasoning 항목은 보내지 않는다(store:false 무상태). */
export function toResponsesRequest({ system, messages, tools, model, effort, max_tokens }) {
  const input = [];
  for (const m of messages ?? []) {
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    if (typeof m.content === 'string') { input.push({ type: 'message', role, content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text: m.content }] }); continue; }
    let parts = [];
    const flush = () => { if (parts.length) { input.push({ type: 'message', role, content: parts }); parts = []; } };
    for (const b of m.content ?? []) {
      if (b?.type === 'text') parts.push({ type: role === 'assistant' ? 'output_text' : 'input_text', text: b.text });
      else if (b?.type === 'image' && b.source?.type === 'base64') parts.push({ type: 'input_image', image_url: dataUrl(b.source), detail: 'auto' });
      else if (b?.type === 'tool_use') { flush(); input.push({ type: 'function_call', call_id: b.id, name: b.name, arguments: JSON.stringify(b.input ?? {}) }); }
      else if (b?.type === 'tool_result') {
        flush();
        const inner = Array.isArray(b.content) ? b.content : [{ type: 'text', text: String(b.content ?? '') }];
        input.push({ type: 'function_call_output', call_id: b.tool_use_id, output: `${b.is_error ? '[error] ' : ''}${textOf(inner)}` });
        for (const x of inner) if (x?.type === 'image' && x.source?.type === 'base64') parts.push({ type: 'input_image', image_url: dataUrl(x.source), detail: 'auto' }); // 도구 결과 이미지는 이어지는 사용자 메시지로
      }
    }
    flush();
  }
  const fn = (tools ?? []).map((t) => ({ type: 'function', name: t.name, description: t.description ?? '', parameters: t.input_schema ?? { type: 'object', properties: {} }, strict: false }));
  return {
    model, ...(system ? { instructions: textOf(system) } : {}), input,
    ...(fn.length ? { tools: fn, tool_choice: 'auto', parallel_tool_calls: true } : {}),
    store: false, stream: true,
    ...(Number(max_tokens) > 0 ? { max_output_tokens: Number(max_tokens) } : {}), // 엔진 상한(CLAUDE_CODE_MAX_OUTPUT_TOKENS·기본 8192)을 그대로 싣는다 — 버리면 벤더 기본으로 무한정(검수 LOW-1)
    ...(effort ? { reasoning: { effort } } : {}),
  };
}

/** Responses 응답(최종 객체) → Messages 응답 모양(순수). reasoning 항목은 버리고 message·function_call만 블록으로. */
export function fromResponsesResponse(resp, model) {
  const content = [];
  for (const it of resp?.output ?? []) {
    if (it?.type === 'message') for (const p of it.content ?? []) { if (p?.type === 'output_text' || p?.type === 'refusal') content.push({ type: 'text', text: p.text ?? p.refusal ?? '' }); }
    else if (it?.type === 'function_call') { let input = {}; try { input = it.arguments ? JSON.parse(it.arguments) : {}; } catch { input = { _raw: String(it.arguments ?? '') }; } content.push({ type: 'tool_use', id: it.call_id || it.id, name: it.name, input }); }
  }
  const stop_reason = content.some((b) => b.type === 'tool_use') ? 'tool_use' : (resp?.status === 'incomplete' && resp?.incomplete_details?.reason === 'max_output_tokens') ? 'max_tokens' : 'end_turn';
  const u = resp?.usage ?? {};
  return { id: resp?.id || `resp_${Date.now().toString(36)}`, type: 'message', role: 'assistant', model: resp?.model || model, content, stop_reason,
    usage: { input_tokens: Number(u.input_tokens) || 0, output_tokens: Number(u.output_tokens) || 0, cache_read_input_tokens: Number(u.input_tokens_details?.cached_tokens) || 0 } };
}

/** SSE 본문 → 최종 response 객체(순수). response.completed가 정본, response.failed/error는 throw. 스트림이 아닌 JSON 본문도 수용. */
export function finalFromSse(text) {
  const t = String(text ?? '').trim();
  if (t.startsWith('{')) { const j = JSON.parse(t); if (j?.error) { const msg = extractErrorMessage(t); const status = /rate limit|usage limit|quota|too many requests|exceeded/i.test(msg) ? 429 : 502; throw Object.assign(new Error(`API Error: ${status} ${msg}`), { status }); } return j.response ?? j; }
  let final = null; let failed = null;
  for (const chunk of t.split(/\r?\n(?:\r?\n)+/)) { // SSE 프레임은 LF·CRLF 둘 다 적법(중간 프록시 재인코딩 — 검수 LOW-4)
    const data = chunk.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
    if (!data || data === '[DONE]') continue;
    let ev; try { ev = JSON.parse(data); } catch { continue; }
    if (ev.type === 'response.completed' || ev.type === 'response.incomplete') final = ev.response;
    else if (ev.type === 'response.failed') failed = ev.response?.error?.message || 'response failed';
    else if (ev.type === 'error') failed = ev.error?.message || ev.message || 'stream error';
  }
  // 스트림 안 실패는 HTTP 200 뒤에 온다 — 한도류는 429, 나머지는 502(상류 실패)로 계급을 매긴다(400으로 못박으면 status 소비자에게 오정보 — 검수 LOW-5)
  if (failed) { const status = /rate limit|usage limit|quota|too many requests|exceeded/i.test(failed) ? 429 : 502; throw Object.assign(new Error(`API Error: ${status} ${failed}`), { status }); }
  if (!final) throw Object.assign(new Error('API Error: 502 Responses stream ended without response.completed'), { status: 502 });
  return final;
}

const RETRYABLE = new Set([500, 502, 503, 504]);
/** POST {base}/responses 1회(+과부하·네트워크 1회 재시도). 실패는 `API Error: <status> <message>`(status 동봉 — 401은 호출부가 리프레시 판단). */
export async function callResponses({ base, headers, body, effort, signal, fetchImpl = globalThis.fetch, timeoutMs = 600_000, retry = 1 }) {
  const url = `${base}/responses`;
  const req = toResponsesRequest({ ...body, effort });
  let attempt = 0;
  for (;;) {
    attempt += 1;
    const timeout = AbortSignal.timeout(timeoutMs);
    const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let r;
    try { r = await fetchImpl(url, { method: 'POST', signal: sig, headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...headers }, body: JSON.stringify(req) }); }
    catch (e) {
      if (signal?.aborted) throw Object.assign(new Error('aborted'), { aborted: true, cause: e });
      if (attempt <= retry) { await new Promise((res) => setTimeout(res, 1500 * attempt)); continue; }
      throw Object.assign(new Error(`API Error: network ${String(e?.message || e)}`), { cause: e });
    }
    const text = await r.text().catch(() => '');
    if (r.ok) return fromResponsesResponse(finalFromSse(text), body.model);
    if (RETRYABLE.has(r.status) && attempt <= retry) { await new Promise((res) => setTimeout(res, 1500 * attempt)); continue; }
    throw Object.assign(new Error(`API Error: ${r.status} ${extractErrorMessage(text)}`), { status: r.status, body: text.slice(0, 2000) });
  }
}
