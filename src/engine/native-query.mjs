// Argo 소유 도구 루프(네이티브 엔진) — 하네스 통일 P-A(설계서 개정 2026-09-05).
// SDK `query()`와 **같은 메시지 스트림**을 낸다: system/init → assistant{message:{model,content}} → result{subtype,...}.
// 그래서 chat.mjs의 하류(상태 표시·도구 집계·산출물·usage·오류 표면·자가치유)는 한 줄도 바뀌지 않는다.
// 통일의 요점: 내장 도구·외부 MCP 전부가 permission-gate(canUseTool)를 지난다. 크루 도구(mcp__crew__*)는 서버측 코드라 SDK와 같이 무검사.
import { z } from 'zod';
import { authFromEnv, callMessages } from './messages-http.mjs';
import { BUILTIN_SPECS, builtinRunners, shellEnv } from './builtin-tools.mjs';
import { connectMcpServers } from './mcp-client.mjs';
import { loadNativeSession, saveNativeSession } from './session.mjs';

export const NATIVE_DEFAULT_MAX_TOKENS = 8192; // SDK 기본 32000이 OpenRouter 선불 잔액 402를 부르던 것 완화(실측 2026-09-05)
export const NATIVE_MAX_STEPS = 60;
const TOOL_RESULT_CAP = 60_000;

/** 플래그 러너 판정(순수) — ARGO_NATIVE_RUNNERS=openrouter,glm,kimi,grok. 기본 off(구 경로 = SDK). */
export function nativeRunnerEnabled(runner, env = process.env) {
  const set = String(env.ARGO_NATIVE_RUNNERS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return set.includes(String(runner ?? '').toLowerCase());
}

const stripSchema = (s) => { const { $schema, ...rest } = s ?? {}; return rest; };

/** makeCrewServer가 sink로 넘긴 정의({name, description, shape(zod), handler}) → 엔진 도구(순수). 이름은 SDK와 같은 mcp__crew__<name>. */
export function crewToolSpecs(defs = []) {
  return defs.map((d) => {
    const schema = z.object(d.shape ?? {});
    return {
      name: `mcp__crew__${d.name}`, description: d.description || d.name,
      input_schema: stripSchema(z.toJSONSchema(schema)), gated: false,
      run: async (input) => {
        const parsed = schema.safeParse(input ?? {});
        if (!parsed.success) throw new Error(`invalid input: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
        const r = await d.handler(parsed.data, {});
        const text = (r?.content ?? []).map((c) => (c.type === 'text' ? c.text : JSON.stringify(c))).join('\n');
        if (r?.isError) throw new Error(text || 'tool error');
        return text;
      },
    };
  });
}

/** 내장 도구 사양 + 실행기 묶음 */
export function builtinTools({ cwd, env, fetchImpl }) {
  const runners = builtinRunners({ cwd, env, fetchImpl });
  return BUILTIN_SPECS.map((s) => ({ ...s, gated: true, run: (input, extra) => runners[s.name](input, extra) }));
}

const sumUsage = (acc, u = {}) => {
  for (const k of ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']) acc[k] = (acc[k] ?? 0) + (Number(u[k]) || 0);
  return acc;
};

async function* run(opts, ac, isInterrupted) {
  const { wsId, slug, prompt, cwd, systemPrompt, env = {}, model, crewTools = [], mcpServers = {}, canUseTool, lang = 'ko',
    resume = null, maxTokens, maxSteps = NATIVE_MAX_STEPS, fetchImpl = globalThis.fetch, saveSession = true } = opts;
  if (!model) throw new Error('native engine: model is required');
  const { base, headers } = authFromEnv(env, lang);
  const max_tokens = Number(maxTokens) || Number(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS) || NATIVE_DEFAULT_MAX_TOKENS;
  const sess = await loadNativeSession(wsId, slug, resume);
  const mcp = await connectMcpServers(mcpServers, { env: shellEnv(env), cwd });
  const tools = [...builtinTools({ cwd, env, fetchImpl }), ...crewToolSpecs(crewTools), ...mcp.tools];
  const byName = new Map(tools.map((t) => [t.name, t]));
  const specs = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema }));
  const usage = {};
  let steps = 0;
  try {
    yield { type: 'system', subtype: 'init', session_id: sess.id, model, tools: specs.map((s) => s.name),
      mcp_servers: [{ name: 'crew', status: 'connected' }, ...mcp.statuses] };
    sess.messages.push({ role: 'user', content: Array.isArray(prompt) ? prompt : String(prompt) });
    for (;;) {
      if (isInterrupted()) throw Object.assign(new Error('aborted'), { aborted: true });
      steps += 1;
      if (steps > maxSteps) {
        yield { type: 'result', subtype: 'error_max_turns', session_id: sess.id, usage, total_cost_usd: null, is_error: true, num_turns: steps - 1, errors: [`max steps ${maxSteps}`] };
        return;
      }
      let res;
      try {
        res = await callMessages({ base, headers, signal: ac.signal, fetchImpl,
          body: { model, max_tokens, system: systemPrompt, messages: sess.messages, ...(specs.length ? { tools: specs } : {}) } });
      } catch (e) {
        // 이미 토큰을 쓴 뒤의 실패는 SDK처럼 usage를 실은 실패 result로 낸다(분리 검수 MEDIUM-1: 던지기만 하면 appendUsage 미도달,
        // 예산·대시보드 과소 집계). 원문은 errors[]에 — chat.mjs가 `턴 실패: … — <원문>`으로 감싸도 401/402 정규식이 문다.
        if (e?.aborted || !((usage.input_tokens ?? 0) + (usage.output_tokens ?? 0))) throw e;
        if (saveSession) await saveNativeSession(wsId, slug, sess);
        yield { type: 'result', subtype: 'error_during_execution', session_id: sess.id, usage, total_cost_usd: null, is_error: true, num_turns: steps, errors: [String(e?.message || e)] };
        return;
      }
      sumUsage(usage, res?.usage);
      const content = Array.isArray(res?.content) ? res.content : [];
      sess.messages.push({ role: 'assistant', content });
      yield { type: 'assistant', message: { model: res?.model || model, content } };
      const uses = content.filter((b) => b?.type === 'tool_use');
      // tool_use 블록이 있으면 stop_reason과 무관하게 실행한다(분리 검수 HIGH-2: max_tokens 절단 응답의 tool_use를 버리면
      // 도구는 안 돌고 전사에는 짝 없는 tool_use가 남아 다음 턴이 죽는다).
      if (!uses.length) {
        const text = content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n').trim();
        if (saveSession) await saveNativeSession(wsId, slug, sess);
        // total_cost_usd: null — Anthropic 단가로 타 벤더를 계산하던 오액(openrouter 규칙)을 전 러너로. 토큰은 usage에.
        yield { type: 'result', subtype: 'success', result: text, session_id: sess.id, usage, total_cost_usd: null, is_error: false, num_turns: steps };
        return;
      }
      const results = [];
      for (const u of uses) {
        if (isInterrupted()) throw Object.assign(new Error('aborted'), { aborted: true });
        const t = byName.get(u.name);
        let text = ''; let isError = false;
        if (!t) { text = `unknown tool: ${u.name}`; isError = true; }
        else {
          try {
            const input = u.input ?? {};
            const gate = t.gated && canUseTool ? await canUseTool(u.name, input) : { behavior: 'allow', updatedInput: input };
            if (gate?.behavior !== 'allow') { text = gate?.message || 'denied by permission gate'; isError = true; }
            else text = String(await t.run(gate.updatedInput ?? input, { signal: ac.signal }) ?? '');
          } catch (e) { text = `tool error: ${String(e?.message || e)}`; isError = true; }
        }
        results.push({ type: 'tool_result', tool_use_id: u.id, content: text.slice(0, TOOL_RESULT_CAP) || '(empty)', ...(isError ? { is_error: true } : {}) });
      }
      sess.messages.push({ role: 'user', content: results });
      if (saveSession) await saveNativeSession(wsId, slug, sess); // 단계마다 영속 — 중단·크래시에도 문맥 보존
    }
  } finally {
    await mcp.close();
  }
}

/** SDK query()와 같은 소비 계약: `for await (const msg of q)` + `q.interrupt()`. */
export function nativeQuery(opts) {
  const ac = new AbortController();
  let interrupted = false;
  const gen = run(opts, ac, () => interrupted);
  gen.interrupt = async () => { interrupted = true; ac.abort(); };
  return gen;
}
