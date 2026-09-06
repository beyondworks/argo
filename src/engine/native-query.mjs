// Argo 소유 도구 루프(네이티브 엔진) — 하네스 통일 P-A(설계서 개정 2026-09-05).
// SDK `query()`와 **같은 메시지 스트림**을 낸다: system/init → assistant{message:{model,content}} → result{subtype,...}.
// 그래서 chat.mjs의 하류(상태 표시·도구 집계·산출물·usage·오류 표면·자가치유)는 한 줄도 바뀌지 않는다.
// 통일의 요점: 내장 도구·외부 MCP 전부가 permission-gate(canUseTool)를 지난다. 크루 도구(mcp__crew__*)는 서버측 코드라 SDK와 같이 무검사.
import { z } from 'zod';
import { authFromEnv, callMessages } from './messages-http.mjs';
import { BUILTIN_SPECS, builtinRunners, shellEnv } from './builtin-tools.mjs';
import { BROWSER_SPECS, browserRunners } from './browser-tools.mjs';
import { COMPUTER_SPECS, computerRunners } from './computer-tools.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { connectMcpServers } from './mcp-client.mjs';
import { loadNativeSession, saveNativeSession, IMAGE_MAX_B64 } from './session.mjs';
import { appendEvent } from '../events.mjs';

export const NATIVE_DEFAULT_MAX_TOKENS = 8192; // SDK 기본 32000이 OpenRouter 선불 잔액 402를 부르던 것 완화(실측 2026-09-05)
export const NATIVE_MAX_STEPS = 60;
const TOOL_RESULT_CAP = 60_000;

export { NATIVE_DEFAULT_RUNNERS, nativeRunnerEnabled } from './native-flags.mjs'; // 판정은 순수 모듈에(creds·catalog와 공유, 순환 없음)

const stripSchema = (s) => { const { $schema, ...rest } = s ?? {}; return rest; };

/** 도구 스키마 정규화(순수) — 모든 object 노드에 `required` 배열을 보장한다(중첩·items·anyOf/oneOf/allOf·$defs 포함, 입력 비파괴).
    xAI의 Anthropic 호환 /v1/messages는 object 스키마에 required가 없으면 null로 보고 400을 낸다
    (`Schema validation failed: /required: null is not of type "array"` — 사용자 제보 실측 2026-09-06: 같은 payload에 required:[]를 더하면 200,
    v0.1.62의 browser_snapshot·browser_back·browser_screenshot·computer_screenshot이 그 모양이라 Grok 네이티브 턴이 전부 죽었다).
    빈 required는 JSON Schema로 적법하고 MCP 서버들이 흔히 내보내는 모양이라 다른 벤더(Anthropic·OpenRouter·GLM·Kimi)에도 안전하다.
    내장 도구 정의를 고치는 대신 여기(스펙 조립 단일 지점)에서 정규화하는 이유: MCP·크루 도구 스키마는 우리가 편집할 수 없다. */
export function ensureRequired(schema, depth = 0, seen = new WeakSet()) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema) || depth > 64 || seen.has(schema)) return schema;
  seen.add(schema); // 순환 참조 방어(JSON.parse 산출엔 없지만 인메모리 스키마엔 있을 수 있다)
  const rec = (x) => ensureRequired(x, depth + 1, seen);
  const mapObj = (o) => (o && typeof o === 'object' && !Array.isArray(o) ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, rec(v)])) : o);
  const out = { ...schema };
  const isObj = out.type === 'object' || (Array.isArray(out.type) && out.type.includes('object'));
  if (isObj && !Array.isArray(out.required)) out.required = []; // 없음·null·true(Swagger 2.0 관례) 전부 배열로
  // 하위 스키마가 사는 모든 자리(JSON Schema 2020-12 적용자 키워드) — MCP 서버가 prefixItems·patternProperties·if/then 아래 object를 주면 거기도 xAI 검증 대상(검수 M1)
  for (const k of ['properties', 'patternProperties', 'dependentSchemas', '$defs', 'definitions']) if (out[k] !== undefined) out[k] = mapObj(out[k]);
  for (const k of ['items', 'additionalProperties', 'additionalItems', 'unevaluatedProperties', 'unevaluatedItems', 'contains', 'propertyNames', 'not', 'if', 'then', 'else']) {
    if (out[k] && typeof out[k] === 'object') out[k] = Array.isArray(out[k]) ? out[k].map(rec) : rec(out[k]);
  }
  for (const k of ['prefixItems', 'anyOf', 'oneOf', 'allOf']) if (Array.isArray(out[k])) out[k] = out[k].map(rec);
  return out;
}

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

/** 비전(이미지 입력) 지원 판정(순수) — 스크린샷을 이미지 블록으로 보낼지. 모르는 모델은 텍스트(파일 경로)만 — 이미지 미지원 모델에 이미지를 보내면
    벤더 400이 나므로(새 오류 금지) 보수적으로. env ARGO_VISION_MODELS: '*' 전부 / 'none' 없음 / 목록(부분 문자열). */
export function visionCapable(model, env = process.env) {
  const raw = String(env.ARGO_VISION_MODELS ?? '').trim();
  const m = String(model ?? '').toLowerCase();
  if (raw === '*') return true;
  if (raw === 'none') return false;
  if (raw) return raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean).some((s) => m.includes(s));
  return /claude|gpt-4o|gpt-4\.1|gpt-5|\bo[134]\b|gemini|grok-(2-vision|3|4)|glm-4\.?\d?v|glm-5|qwen[^/]*vl|pixtral|llava|minimax|kimi-k[23]|vision/.test(m);
}

/** 네이티브 턴 전용 안내(시스템 프롬프트 꼬리) — 브라우저·컴퓨터 도구가 있음을 크루가 알게. */
export function nativeToolsDirective(lang = 'ko') {
  return lang === 'en'
    ? `\n- Browser use: browser_navigate → browser_snapshot (refs like [e3]) → browser_click / browser_type / browser_press / browser_scroll; browser_screenshot for a visual check; browser_eval for page data. It runs in Argo's own Chrome profile (not the captain's daily browser) — logins persist across turns there. Computer use: computer_screenshot first, then computer_click / computer_type / computer_key / computer_scroll / computer_drag with screenshot coordinates. Ask before actions that leave the company (purchases, sending, posting) — file an approval.\n`
    : `\n- 브라우저 유즈: browser_navigate → browser_snapshot([e3] 같은 ref) → browser_click / browser_type / browser_press / browser_scroll, 눈으로 확인은 browser_screenshot, 페이지 데이터는 browser_eval. Argo 전용 크롬 프로필에서 돈다(사장의 일상 브라우저가 아니다 — 거기서 한 로그인은 턴을 넘어 유지된다). 컴퓨터 유즈: computer_screenshot을 먼저 찍고 그 좌표로 computer_click / computer_type / computer_key / computer_scroll / computer_drag. 회사 밖으로 나가는 행동(구매·발송·게시)은 실행 전에 결재를 올려라.\n`;
}

/** 내장 도구 사양 + 실행기 묶음 — 파일·셸·웹 + 브라우저 유즈 + 컴퓨터 유즈(하네스 통일: 러너 무관 같은 도구·같은 게이트) */
/** 윈도우 셸 사다리 폴백 알림기(순수 팩토리) — 동봉 busybox를 못 쓰면(없음·백신 격리·실행 거부) 조용히 퇴화하지 않고 활동 피드에 드러낸다(shell-backend.mjs).
    회사당 프로세스 1회 — 매 명령마다 적재하면 타임라인이 덮인다. appendFn·noted 주입은 테스트용. */
export function makeShellFallbackNoter(appendFn = appendEvent, noted = new Set()) {
  return (wsId) => (plan) => {
    if (noted.has(wsId)) return; noted.add(wsId);
    Promise.resolve(appendFn(wsId, { type: 'shell-fallback', ok: false, kind: plan.kind, file: plan.file, tried: (plan.tried ?? []).map((t) => `${t.kind}: ${t.reason}`) })).catch(() => {});
  };
}
const noteShellFallback = makeShellFallbackNoter();
export function builtinTools({ cwd, env, fetchImpl, wsId = 'ws', browser = true, computer = true }) {
  const runners = builtinRunners({ cwd, env, fetchImpl, onShellFallback: noteShellFallback(wsId) });
  const list = BUILTIN_SPECS.map((s) => ({ ...s, gated: true, run: (input, extra) => runners[s.name](input, extra) }));
  if (browser) { const br = browserRunners({ wsId, env }); list.push(...BROWSER_SPECS.map((s) => ({ ...s, gated: true, run: (input, extra) => br[s.name](input, extra) }))); }
  if (computer) { const cr = computerRunners(); list.push(...COMPUTER_SPECS.map((s) => ({ ...s, gated: true, run: (input, extra) => cr[s.name](input, extra) }))); }
  return list;
}

/** 이미지 결과({image,mime,note}) → tool_result content 블록(순수 조립 + 파일 저장). 비전 미지원 모델에는 경로만. */
export { IMAGE_MAX_B64 }; // 정본은 session.mjs(전사 예산 옆) — 브라우저·컴퓨터 스크린샷 사다리가 같은 값을 쓴다
export async function imageToolResult(out, { cwd, model, env = process.env, now = Date.now() }) {
  const mime = out.mime || 'image/png'; const ext = mime === 'image/jpeg' ? 'jpg' : 'png';
  // vault/files/ 아래 — 서빙 접두(files/)·산출물 칩이 닿는 곳이라 사장이 앱에서 열 수 있다(vault/screenshots는 서빙 밖 — 분리 검수 MEDIUM-4)
  const dir = join(cwd, 'vault', 'files', 'screenshots'); await mkdir(dir, { recursive: true });
  const name = `${new Date(now).toISOString().replace(/[:.]/g, '-')}.${ext}`; await writeFile(join(dir, name), out.image);
  const text = `${out.note ? `${out.note}\n` : ''}saved: vault/files/screenshots/${name}`;
  const b64 = out.image.toString('base64');
  if (b64.length > IMAGE_MAX_B64) return [{ type: 'text', text: `${text}\n(이미지가 커서(${Math.round(out.image.length / 1024)}KB) 전사에는 싣지 않았습니다 — 파일로 저장됨)` }];
  return visionCapable(model, env)
    ? [{ type: 'text', text }, { type: 'image', source: { type: 'base64', media_type: mime, data: b64 } }]
    : [{ type: 'text', text: `${text}\n(이 모델은 이미지 입력을 지원하지 않는 것으로 판정돼 파일로만 저장했습니다 — ARGO_VISION_MODELS로 조정 가능)` }];
}

const sumUsage = (acc, u = {}) => {
  for (const k of ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']) acc[k] = (acc[k] ?? 0) + (Number(u[k]) || 0);
  return acc;
};

async function* run(opts, ac, isInterrupted) {
  const { wsId, slug, prompt, cwd, systemPrompt, env = {}, model, crewTools = [], mcpServers = {}, canUseTool, lang = 'ko',
    resume = null, maxTokens, maxSteps = NATIVE_MAX_STEPS, fetchImpl = globalThis.fetch, saveSession = true, effort = '' } = opts;
  if (!model) throw new Error('native engine: model is required');
  const { base, headers, wire } = authFromEnv(env, lang);
  const max_tokens = Number(maxTokens) || Number(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS) || NATIVE_DEFAULT_MAX_TOKENS;
  const sess = await loadNativeSession(wsId, slug, resume);
  const mcp = await connectMcpServers(mcpServers, { env: shellEnv(env), cwd });
  // 컴퓨터 유즈는 명시 옵트인만(회사 설정 computerUse — 분리 검수 CRITICAL-2: 화면 채널은 권한 게이트 하드라인을 우회한다)
  const tools = [...builtinTools({ cwd, env, fetchImpl, wsId, browser: opts.browser !== false, computer: opts.computer === true }), ...crewToolSpecs(crewTools), ...mcp.tools];
  const byName = new Map(tools.map((t) => [t.name, t]));
  const specs = tools.map((t) => ({ name: t.name, description: t.description, input_schema: ensureRequired(t.input_schema) })); // 벤더로 나가는 스키마의 단일 관문
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
        res = await callMessages({ wire, base, headers, effort, signal: ac.signal, fetchImpl,
          body: { model, max_tokens, system: systemPrompt, messages: sess.messages, ...(specs.length ? { tools: specs } : {}) } });
      } catch (e) {
        // 이미 토큰을 쓴 뒤의 실패는 SDK처럼 usage를 실은 실패 result로 낸다(분리 검수 MEDIUM-1: 던지기만 하면 appendUsage 미도달,
        // 예산·대시보드 과소 집계). 원문은 errors[]에 — chat.mjs가 `턴 실패: … — <원문>`으로 감싸도 401/402 정규식이 문다.
        if (e?.usage && !e?.aborted) sumUsage(usage, e.usage); // 차단 응답(SAFETY 등)도 프롬프트 토큰은 썼다 — 첫 스텝이어도 집계(2R LOW-3)
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
        let text = ''; let isError = false; let blocks = null;
        if (!t) { text = `unknown tool: ${u.name}`; isError = true; }
        else {
          try {
            const input = u.input ?? {};
            const gate = t.gated && canUseTool ? await canUseTool(u.name, input) : { behavior: 'allow', updatedInput: input };
            if (gate?.behavior !== 'allow') { text = gate?.message || 'denied by permission gate'; isError = true; }
            else {
              const out = await t.run(gate.updatedInput ?? input, { signal: ac.signal });
              if (out && typeof out === 'object' && Buffer.isBuffer(out.image)) blocks = await imageToolResult(out, { cwd, model, env }); // 스크린샷(브라우저·컴퓨터)
              else text = String(out ?? '');
            }
          } catch (e) { text = `tool error: ${String(e?.message || e)}`; isError = true; }
        }
        results.push({ type: 'tool_result', tool_use_id: u.id, content: blocks ?? (text.slice(0, TOOL_RESULT_CAP) || '(empty)'), ...(isError ? { is_error: true } : {}) });
      }
      sess.messages.push({ role: 'user', content: results });
      if (saveSession) await saveNativeSession(wsId, slug, sess); // 단계마다 영속 — 중단·크래시에도 문맥 보존
    }
  } finally {
    await mcp.close();
  }
}

/** 원샷(도구 없는 단발 생성 — 크루 카드 생성·직함·기억 정리·브리핑)용 — oneshot.mjs가 플래그 러너에서 SDK query 대신 쓴다(P-A').
    반환 { text, usage, model }. 실패는 callMessages가 `API Error: <status> <msg>`로 던진다(oneshot의 자가치유·안내 경로 그대로). */
export async function nativeOneShot({ env = {}, model, prompt, systemPrompt = '', maxTokens, signal, lang = 'ko', fetchImpl = globalThis.fetch, effort = '' }) {
  if (!model) throw new Error('native engine: model is required');
  const { base, headers, wire } = authFromEnv(env, lang);
  const max_tokens = Number(maxTokens) || Number(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS) || NATIVE_DEFAULT_MAX_TOKENS;
  const res = await callMessages({ wire, base, headers, signal, fetchImpl, effort, // effort는 Responses 와이어(codex)만 싣는다 — 원샷 호출부는 크루 카드가 없어 벤더 기본 강도(2R N4)
    body: { model, max_tokens, ...(systemPrompt ? { system: systemPrompt } : {}), messages: [{ role: 'user', content: String(prompt) }] } });
  const text = (Array.isArray(res?.content) ? res.content : []).filter((b) => b?.type === 'text').map((b) => b.text).join('\n').trim();
  return { text, usage: sumUsage({}, res?.usage), model: res?.model || model };
}

/** SDK query()와 같은 소비 계약: `for await (const msg of q)` + `q.interrupt()`. */
export function nativeQuery(opts) {
  const ac = new AbortController();
  let interrupted = false;
  const gen = run(opts, ac, () => interrupted);
  gen.interrupt = async () => { interrupted = true; ac.abort(); };
  return gen;
}
