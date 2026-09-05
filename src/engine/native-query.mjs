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
import { loadNativeSession, saveNativeSession } from './session.mjs';

export const NATIVE_DEFAULT_MAX_TOKENS = 8192; // SDK 기본 32000이 OpenRouter 선불 잔액 402를 부르던 것 완화(실측 2026-09-05)
export const NATIVE_MAX_STEPS = 60;
const TOOL_RESULT_CAP = 60_000;

/** 기본 네이티브 러너 — 키 기반 4종(전부 Anthropic Messages 와이어 포맷). 유건 승인 2026-09-05: 검수 3R·실벤더·산출물 스모크 뒤 기본 on. */
export const NATIVE_DEFAULT_RUNNERS = Object.freeze(['openrouter', 'glm', 'kimi', 'grok']);

/** 네이티브 러너 판정(순수) — env ARGO_NATIVE_RUNNERS: 미설정/빈 값 = 기본 4종 on · `none`/`off`/`0` = 전부 off(구 경로 SDK 폴백) · 목록 = 그 러너만.
    구독 OAuth(claude)는 목록에 넣어도 엔진이 거절한다(authFromEnv). */
export function nativeRunnerEnabled(runner, env = process.env) {
  const raw = String(env.ARGO_NATIVE_RUNNERS ?? '').trim().toLowerCase();
  const r = String(runner ?? '').toLowerCase();
  if (!raw) return NATIVE_DEFAULT_RUNNERS.includes(r);
  if (['none', 'off', '0', 'false'].includes(raw)) return false;
  return raw.split(',').map((s) => s.trim()).filter(Boolean).includes(r);
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
export function builtinTools({ cwd, env, fetchImpl, wsId = 'ws', browser = true, computer = true }) {
  const runners = builtinRunners({ cwd, env, fetchImpl });
  const list = BUILTIN_SPECS.map((s) => ({ ...s, gated: true, run: (input, extra) => runners[s.name](input, extra) }));
  if (browser) { const br = browserRunners({ wsId, env }); list.push(...BROWSER_SPECS.map((s) => ({ ...s, gated: true, run: (input, extra) => br[s.name](input, extra) }))); }
  if (computer) { const cr = computerRunners(); list.push(...COMPUTER_SPECS.map((s) => ({ ...s, gated: true, run: (input, extra) => cr[s.name](input, extra) }))); }
  return list;
}

/** 이미지 결과({image,mime,note}) → tool_result content 블록(순수 조립 + 파일 저장). 비전 미지원 모델에는 경로만. */
/** 이미지 1장의 base64 상한 — 세션 전사 상한(SESSION_MAX_CHARS 40만 자) 안에서 문맥이 남게. 넘으면 파일로만 저장하고 텍스트로 안내(분리 검수 HIGH-1). */
export const IMAGE_MAX_B64 = 300_000;
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
    resume = null, maxTokens, maxSteps = NATIVE_MAX_STEPS, fetchImpl = globalThis.fetch, saveSession = true } = opts;
  if (!model) throw new Error('native engine: model is required');
  const { base, headers } = authFromEnv(env, lang);
  const max_tokens = Number(maxTokens) || Number(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS) || NATIVE_DEFAULT_MAX_TOKENS;
  const sess = await loadNativeSession(wsId, slug, resume);
  const mcp = await connectMcpServers(mcpServers, { env: shellEnv(env), cwd });
  // 컴퓨터 유즈는 명시 옵트인만(회사 설정 computerUse — 분리 검수 CRITICAL-2: 화면 채널은 권한 게이트 하드라인을 우회한다)
  const tools = [...builtinTools({ cwd, env, fetchImpl, wsId, browser: opts.browser !== false, computer: opts.computer === true }), ...crewToolSpecs(crewTools), ...mcp.tools];
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
export async function nativeOneShot({ env = {}, model, prompt, systemPrompt = '', maxTokens, signal, lang = 'ko', fetchImpl = globalThis.fetch }) {
  if (!model) throw new Error('native engine: model is required');
  const { base, headers } = authFromEnv(env, lang);
  const max_tokens = Number(maxTokens) || Number(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS) || NATIVE_DEFAULT_MAX_TOKENS;
  const res = await callMessages({ base, headers, signal, fetchImpl,
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
