// DeepSeek Local 러너 — OpenAI 호환 API(llamacpp/vLLM 등)를 직접 호출하는 실행 경로.
// Anthropic SDK(query())를 쓰지 않고 fetch로 /v1/chat/completions를 호출한다.
// (러너 추가 2026-08-06)

/** OpenAI 호환 서버의 기본 URL — env로 오버라이드 가능. */
export const DEEPSEEK_LOCAL_DEFAULT_BASE = 'http://100.103.65.62:8080';
export const DEEPSEEK_LOCAL_DEFAULT_MODEL = 'qwen3.6-27b-q4';

/** Base URL의 표준 OpenAI 경로(`/v1`)는 UI·외부 클라이언트가 자주 포함한다.
    내부 호출은 항상 root에 `/v1/...`를 붙이므로 끝의 `/v1`만 제거해 중복 경로를 막는다. */
export function normalizeDeepseekLocalBase(baseUrl) {
  const value = String(baseUrl ?? '').trim() || DEEPSEEK_LOCAL_DEFAULT_BASE;
  return value.replace(/\/+$/, '').replace(/\/v1$/i, '') || DEEPSEEK_LOCAL_DEFAULT_BASE;
}

/** 저장된 로컬 러너 자격 파싱 — URL-only, API-key-only, URL|API-key를 모두 지원한다. */
export function parseDeepseekLocalCredential(value) {
  const v = String(value ?? '').trim();
  if (v.includes('|')) {
    const [base, ...rest] = v.split('|');
    return { baseUrl: (base || DEEPSEEK_LOCAL_DEFAULT_BASE).trim(), apiKey: rest.join('|').trim() };
  }
  if (/^https?:\/\//i.test(v)) return { baseUrl: v, apiKey: '' };
  return { baseUrl: DEEPSEEK_LOCAL_DEFAULT_BASE, apiKey: v };
}

function authHeaders(apiKey = '') {
  const key = String(apiKey || process.env.DEEPSEEK_LOCAL_API_KEY || '').trim();
  return key
    ? { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }
    : { 'Content-Type': 'application/json' };
}

async function request(url, init = {}, timeoutMs = 10_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** OpenAI 호환 chat/completions 원시 호출. 도구가 있으면 표준 tools/tool_choice를 전달하고
    assistant message 전체(tool_calls 포함)를 반환한다. */
export async function openAICompatCompletion(baseUrl, {
  messages, model, apiKey = '', tools = [], timeoutMs = 300_000, signal = null,
}) {
  const url = `${normalizeDeepseekLocalBase(baseUrl)}/v1/chat/completions`;
  const headers = authHeaders(apiKey);
  const controller = new AbortController();
  const relayAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) relayAbort();
  else signal?.addEventListener('abort', relayAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException('Qwen API 요청 시간 초과', 'TimeoutError')), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: model || DEEPSEEK_LOCAL_DEFAULT_MODEL,
        messages,
        stream: false,
        ...(tools.length ? { tools, tool_choice: 'auto' } : {}),
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Qwen 3.6 27B API 오류 (${res.status}): ${body.slice(0, 200)}`);
    }
    const data = await res.json();
    const choice = data.choices?.[0];
    if (!choice?.message || typeof choice.message !== 'object') throw new Error('Qwen 3.6 27B API 응답에 assistant message가 없다.');
    return { message: choice.message, usage: data.usage ?? {}, finishReason: choice.finish_reason ?? null, model: data.model ?? null };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', relayAbort);
  }
}

/** 기존 단발 소비자(oneshot/검증)의 호환 래퍼. */
export async function deepseekLocalCall(baseUrl, { systemPrompt, userMessage, model, apiKey = '', timeoutMs = 300_000, signal = null }) {
  const messages = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: userMessage });
  const result = await openAICompatCompletion(baseUrl, { messages, model, apiKey, timeoutMs, signal });
  return {
    text: typeof result.message.content === 'string' ? result.message.content : '',
    usage: result.usage,
    model: result.model,
  };
}

function addUsage(total, next = {}) {
  for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens']) {
    if (Number.isFinite(Number(next[key]))) total[key] = (total[key] ?? 0) + Number(next[key]);
  }
  return total;
}

function normalizeToolCalls(message, round) {
  const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  if (calls.length) return calls;
  // 구형 OpenAI 호환 서버의 function_call 단일 형식도 받아 표준 tool_calls로 정규화한다.
  if (message?.function_call?.name) {
    return [{ id: `legacy-${round}`, type: 'function', function: message.function_call }];
  }
  return [];
}

/** 표준 OpenAI tool loop: assistant.tool_calls → 서버 실행 → role=tool 결과 재주입 → 최종 답변.
    executeTool(name,args)는 Argo 권한 게이트를 통과한 문자열 결과를 반환해야 한다. */
export async function runOpenAICompatToolLoop(baseUrl, {
  systemPrompt, userMessage, model, apiKey = '', tools = [], executeTool,
  timeoutMs = 300_000, signal = null, maxRounds = 24, maxToolCalls = 64,
  onToolCall = async () => {},
}) {
  const messages = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: userMessage });
  const usage = {};
  const calls = [];
  let actualModel = null;
  const deadline = new AbortController();
  const relayAbort = () => deadline.abort(signal?.reason);
  if (signal?.aborted) relayAbort();
  else signal?.addEventListener('abort', relayAbort, { once: true });
  const timer = setTimeout(() => deadline.abort(new DOMException('Qwen 도구 턴 시간 초과', 'TimeoutError')), timeoutMs);

  try {
    for (let round = 1; round <= maxRounds; round += 1) {
      if (deadline.signal.aborted) throw deadline.signal.reason || Object.assign(new Error('중단됨'), { aborted: true });
      const result = await openAICompatCompletion(baseUrl, { messages, model, apiKey, tools, timeoutMs, signal: deadline.signal });
      addUsage(usage, result.usage);
      actualModel = result.model || actualModel;
      const assistant = result.message;
      const toolCalls = normalizeToolCalls(assistant, round);
      if (!toolCalls.length) {
        const text = typeof assistant.content === 'string' ? assistant.content.trim() : '';
        if (!text) throw new Error('Qwen 3.6 27B가 빈 응답을 반환했다.');
        return { text, usage, calls, model: actualModel, messages };
      }
      if (typeof executeTool !== 'function') throw new Error('도구 호출을 실행할 Argo 브리지가 없다.');
      if (calls.length + toolCalls.length > maxToolCalls) throw new Error(`도구 호출 상한(${maxToolCalls})을 넘었다.`);

      messages.push({
        role: 'assistant',
        content: typeof assistant.content === 'string' ? assistant.content : null,
        tool_calls: toolCalls,
      });
      for (let index = 0; index < toolCalls.length; index += 1) {
        if (deadline.signal.aborted) throw deadline.signal.reason || Object.assign(new Error('중단됨'), { aborted: true });
        const call = toolCalls[index];
        const name = String(call?.function?.name ?? '').trim();
        const id = String(call?.id || `tool-${round}-${index}`);
        let args = {};
        let output;
        try {
          const raw = call?.function?.arguments;
          args = typeof raw === 'string' ? JSON.parse(raw || '{}') : (raw && typeof raw === 'object' ? raw : {});
          if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('도구 인자는 JSON object여야 한다.');
          await onToolCall({ name, args, id, round });
          if (deadline.signal.aborted) throw deadline.signal.reason || Object.assign(new Error('중단됨'), { aborted: true });
          output = await executeTool(name, args, { signal: deadline.signal });
        } catch (error) {
          if (deadline.signal.aborted) throw deadline.signal.reason || error;
          output = `도구 호출 오류(${name || 'unknown'}): ${String(error?.message || error)}`;
        }
        const record = { id, name, args, output: String(output ?? '').slice(0, 120_000) };
        calls.push(record);
        messages.push({ role: 'tool', tool_call_id: id, name, content: record.output });
      }
    }
    throw new Error(`도구 실행 라운드 상한(${maxRounds})에 도달했다.`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', relayAbort);
  }
}

/** 서버 연결 확인 — /v1/models 조회 후 실제 completion 인증 probe. 반환: { ok: boolean|null }.
    llama.cpp는 /v1/models를 공개해도 completion에는 API 키를 요구할 수 있으므로 models만으로
    연결됨을 판정하면 저장은 성공하지만 첫 대화가 401로 죽는다. */
export async function verifyDeepseekLocal(baseUrl, apiKey = '') {
  try {
    const root = normalizeDeepseekLocalBase(baseUrl);
    const headers = authHeaders(apiKey);
    const modelsRes = await request(`${root}/v1/models`, { headers });
    if (!modelsRes.ok) return { ok: modelsRes.status === 401 || modelsRes.status === 403 ? false : null };
    const data = await modelsRes.json().catch(() => ({}));
    const model = data.data?.[0]?.id || data.models?.[0]?.id || DEEPSEEK_LOCAL_DEFAULT_MODEL;
    const probe = await request(`${root}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        stream: false,
      }),
    });
    if (probe.status === 401 || probe.status === 403) return { ok: false };
    if (probe.ok) return { ok: true };
    // 이 서버는 인증 통과 후 요청 형식 오류를 400 + "messages is required"로 반환한다.
    // 실제 추론을 실행하지 않아 연결 확인이 모델 생성 지연에 매달리지 않게 한다.
    if (probe.status === 400) {
      const body = await probe.text().catch(() => '');
      if (/messages[\s\S]{0,80}required|required[\s\S]{0,80}messages/i.test(body)) return { ok: true };
    }
    return { ok: null };
  } catch {
    return { ok: null };
  }
}
