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
import { cacheEligible, withCacheControl } from './prompt-cache.mjs';
import { compactPlan, compactTranscript, DEFAULT_CONTEXT_TOKENS, estimateTokens } from './compact.mjs';
import { squeezeToolResults, turnStartIndex, isContextOverflowError, windowAfterOverflow, limitFromOverflow, dropStoppedTurn, overflowStopNote, overflowErrorText, TURN_BUDGET_AT, TURN_SQUEEZE_TO, SQUEEZE_KEEP_RECENT, SQUEEZE_HEAD_CHARS, HARD_KEEP_RECENT, HARD_HEAD_CHARS } from './turn-budget.mjs';
import { randomUUID } from 'node:crypto';

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
  if (['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna'].includes(m)) return true; // Codex 서버 모델 목록 input_modalities: text·image(2026-10-07)
  return /claude|gpt-4o|gpt-4\.1|gpt-5|\bo[134]\b|gemini|grok-(2-vision|3|4)|glm-4\.?\d?v|glm-5|qwen[^/]*vl|pixtral|llava|minimax|kimi-k[23]|vision/.test(m);
}

/** 네이티브 턴 전용 안내(시스템 프롬프트 꼬리) — 브라우저·컴퓨터 도구가 있음을 크루가 알게. */
export function nativeToolsDirective(lang = 'ko') {
  return lang === 'en'
    ? `\n- Browser use: browser_status checks the provider and isolation without opening tabs; browser_navigate → browser_snapshot (refs like [e3]) → browser_click / browser_type / browser_press / browser_scroll; browser_screenshot for a visual check; browser_eval for page data. It runs in this agent's separate Chrome profile — cookies and logins are not shared with other agents or the user. Each work run has its own tab; the agent's logins persist across turns. For sign-in, navigate to the service then call browser_request_login, stop this run, and tell the user to sign in on the execution device and continue in a new run. Mobile remote control is unavailable. Computer use: computer_screenshot first, then computer_click / computer_type / computer_key / computer_scroll / computer_drag with screenshot coordinates. Ask before actions that leave the company (purchases, sending, posting) — file an approval.\n`
    : `\n- 브라우저 유즈: browser_status로 탭을 열지 않고 제공자·격리 상태를 확인한다. browser_navigate → browser_snapshot([e3] 같은 ref) → browser_click / browser_type / browser_press / browser_scroll, 눈으로 확인은 browser_screenshot, 페이지 데이터는 browser_eval. 에이전트별 전용 크롬 프로필에서 돈다(다른 에이전트·사용자의 쿠키와 로그인은 공유하지 않으며, 작업별 탭도 분리된다 — 이 에이전트의 로그인은 턴을 넘어 유지된다). 로그인이 필요하면 서비스 페이지를 연 뒤 browser_request_login으로 사용자에게 탭을 넘기고 이번 실행을 멈춘다. 실행 기기에서 로그인한 뒤 새 실행으로 이어간다(모바일 원격 제어 미지원). 컴퓨터 유즈: computer_screenshot을 먼저 찍고 그 좌표로 computer_click / computer_type / computer_key / computer_scroll / computer_drag. 회사 밖으로 나가는 행동(구매·발송·게시)은 실행 전에 결재를 올려라.\n`;
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
export function builtinTools({ cwd, env, fetchImpl, wsId = 'ws', slug = '', runId, browser = true, computer = true, browserTools }) {
  const runners = builtinRunners({ cwd, env, fetchImpl, onShellFallback: noteShellFallback(wsId) });
  const list = BUILTIN_SPECS.map((s) => ({ ...s, gated: true, run: (input, extra) => runners[s.name](input, extra) }));
  if (browser) { const br = browserTools ?? browserRunners({ wsId, slug, runId, env }); list.push(...BROWSER_SPECS.map((s) => ({ ...s, gated: true, run: (input, extra) => br[s.name](input, extra) }))); }
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

/** 표시용 assistant 내용(순수) — gem_thought 글과 와이어가 준 사고 요약을 thinking 블록으로 앞에 붙인다. 원본 배열은 바꾸지 않는다. */
export function displayContent(content, thoughts = null) {
  const extra = [];
  for (const b of content ?? []) if (b?.type === 'gem_thought' && typeof b.text === 'string' && b.text.trim()) extra.push({ type: 'thinking', thinking: b.text.trim() });
  for (const t of Array.isArray(thoughts) ? thoughts : []) if (typeof t === 'string' && t.trim()) extra.push({ type: 'thinking', thinking: t.trim() });
  return extra.length ? [...extra, ...content] : content;
}

async function* run(opts, ac, isInterrupted, inbox = { items: [], closed: false }) {
  const { wsId, slug, prompt, cwd, systemPrompt, env = {}, model, crewTools = [], mcpServers = {}, canUseTool, lang = 'ko',
    resume = null, maxTokens, maxSteps = NATIVE_MAX_STEPS, fetchImpl = globalThis.fetch, saveSession = true, effort = '' } = opts;
  if (!model) throw new Error('native engine: model is required');
  const { base, headers, wire } = authFromEnv(env, lang);
  const max_tokens = Number(maxTokens) || Number(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS) || NATIVE_DEFAULT_MAX_TOKENS;
  const sess = await loadNativeSession(wsId, slug, resume);
  const mcp = await connectMcpServers(mcpServers, { env: shellEnv(env), cwd });
  // 컴퓨터 유즈는 명시 옵트인만(회사 설정 computerUse — 분리 검수 CRITICAL-2: 화면 채널은 권한 게이트 하드라인을 우회한다)
  const browserTools = browserRunners({ wsId, slug, runId: opts.browserRunId ?? randomUUID(), env });
  const tools = [...builtinTools({ cwd, env, fetchImpl, wsId, slug, browserTools, browser: opts.browser !== false, computer: opts.computer === true }), ...crewToolSpecs(crewTools), ...mcp.tools];
  const byName = new Map(tools.map((t) => [t.name, t]));
  const specs = tools.map((t) => ({ name: t.name, description: t.description, input_schema: ensureRequired(t.input_schema) })); // 벤더로 나가는 스키마의 단일 관문
  const usage = {};
  let steps = 0;
  const cache = cacheEligible({ wire, base, model }); // 프롬프트 캐시 표지 — 받는다고 확인된 엔드포인트만(prompt-cache.mjs). 표지는 보내는 사본에만 단다
  try {
    yield { type: 'system', subtype: 'init', session_id: sess.id, model, tools: specs.map((s) => s.name),
      mcp_servers: [{ name: 'crew', status: 'connected' }, ...mcp.statuses] };
    sess.messages.push({ role: 'user', content: Array.isArray(prompt) ? prompt : String(prompt) });
    // 토큰 예산 — 창의 75%를 넘으면 최근 20턴 앞부분을 같은 러너 원샷으로 요약한다(compact.mjs). 요약 호출 토큰도 이 턴 사용량에 합산.
    const ctxWindow = Number(opts.contextTokens) > 0 ? Number(opts.contextTokens) : DEFAULT_CONTEXT_TOKENS;
    const plan = compactPlan(sess, { system: systemPrompt, tools: specs, window: ctxWindow });
    // 요약하는 동안 '앞 대화 정리 중' — SDK 자동 압축과 같은 모양의 상태 이벤트 1회(chat.mjs가 상태 단계 summarize로 옮긴다)
    if (!plan.skip) yield { type: 'system', subtype: 'status', status: 'compacting', session_id: sess.id };
    const packed = await compactTranscript(sess, { plan, lang,
      summarize: async (p) => {
        let r;
        // 요약이 실패해도 벤더가 이미 쓴 토큰(e.usage — Gemini MAX_TOKENS·차단 응답 등)은 이 턴 사용량에 합산한다(재검수 LOW)
        try { r = await nativeOneShot({ env, model, prompt: p, signal: ac.signal, lang, fetchImpl, effort }); } catch (e) { if (e?.usage && !e?.aborted) sumUsage(usage, e.usage); throw e; }
        sumUsage(usage, r.usage); return r.text;
      } });
    if (isInterrupted()) throw Object.assign(new Error('aborted'), { aborted: true });
    if (packed.compacted) yield { type: 'system', subtype: 'compact_boundary', session_id: sess.id, compact_metadata: { trigger: 'auto', pre_tokens: packed.preTokens } }; // SDK 자동 압축과 같은 모양 — chat.mjs가 스레드에 안내 줄을 남긴다
    // 턴 안 예산(turn-budget.mjs) — 위 압축은 턴 시작에만 돈다. 도구 반복 중 매 호출 전 추정이 창의 75%를 넘으면 오래된 도구 결과를 줄인다.
    // 창은 모델 창 그대로(압축의 128,000 상한은 턴 사이 전사 글자 상한과 짝이라 여기엔 쓰지 않는다). 벤더가 길이 초과로 거절하면 이 턴의 창을 거절 지점 기준으로 낮춘다.
    const fixedTokens = estimateTokens(systemPrompt) + estimateTokens(specs);
    let turnWindow = ctxWindow;
    // 실패 갈래가 '저장할 전사가 들어갈 크기인가'를 재는 확실한 값 둘(3차 검수 HIGH — 숫자 없는 거절 지점 = turnWindow는 한도의 위쪽 끝일 뿐이라 쓰지 않는다):
    let okTokens = 0;    // 이 턴에 벤더가 받아 준 가장 큰 요청의 추정(실측 하한)
    let knownWindow = 0; // 거절 원문의 숫자로 환산한 한도(숫자가 있을 때만)
    // pre = 매 호출 전(최근 결과 3개 보호), retry = 길이 초과 뒤 재전송(이번 턴 지시 뒤의 최근 결과 1개만 보호 — 앞 턴이 남긴 큰 결과는 줄인다),
    // final = 실패로 저장하기 직전(보호 없음 — 한 단계 결과만으로 넘친 전사를 그대로 저장하면 다음 턴마다 첫 호출에서 또 넘쳤다, 1차 검수 HIGH)
    const squeezed = (mode) => squeezeToolResults(sess.messages, { fixed: fixedTokens, target: Math.floor(turnWindow * TURN_SQUEEZE_TO), lang,
      keepRecent: mode === 'pre' ? SQUEEZE_KEEP_RECENT : mode === 'retry' ? HARD_KEEP_RECENT : 0,
      recentFrom: mode === 'retry' ? turnStartIndex(sess.messages) : 0,
      head: mode === 'pre' ? SQUEEZE_HEAD_CHARS : HARD_HEAD_CHARS });
    const squeeze = (mode) => {
      const r = squeezed(mode);
      if (r.squeezed) sess.messages = r.messages; // 저장 전사에도 반영된다(다음 저장이 이 전사를 쓴다)
      return r.squeezed;
    };
    for (;;) {
      if (isInterrupted()) throw Object.assign(new Error('aborted'), { aborted: true });
      steps += 1;
      if (steps > maxSteps) {
        yield { type: 'result', subtype: 'error_max_turns', session_id: sess.id, usage, total_cost_usd: null, is_error: true, num_turns: steps - 1, errors: [`max steps ${maxSteps}`] };
        return;
      }
      if (fixedTokens + estimateTokens(sess.messages) > turnWindow * TURN_BUDGET_AT) squeeze('pre');
      let res;
      for (let retried = false, resent = false, cut = false; ;) {
        const sent = fixedTokens + estimateTokens(sess.messages);
        try {
          const body = { model, max_tokens, system: systemPrompt, messages: sess.messages, ...(specs.length ? { tools: specs } : {}) };
          res = await callMessages({ wire, base, headers, effort, signal: ac.signal, fetchImpl, body: cache ? withCacheControl(body) : body });
          okTokens = Math.max(okTokens, sent);
          break;
        } catch (e) {
          // 이미 토큰을 쓴 뒤의 실패는 SDK처럼 usage를 실은 실패 result로 낸다(분리 검수 MEDIUM-1: 던지기만 하면 appendUsage 미도달,
          // 예산·대시보드 과소 집계). 원문은 errors[]에 — chat.mjs가 `턴 실패: … — <원문>`으로 감싸도 401/402 정규식이 문다.
          if (e?.usage && !e?.aborted) sumUsage(usage, e.usage); // 차단 응답(SAFETY 등)도 프롬프트 토큰은 썼다 — 첫 스텝이어도 집계(2R LOW-3)
          if (e?.aborted) throw e;
          const overflow = isContextOverflowError(e);
          if (overflow) {
            // 길이 초과 — 이 턴의 창을 거절 지점 기준으로 낮춘다(다시 보낸 요청도 거절되면 그 숫자로 한 번 더 — 아래 저장 전 줄이기의 목표가 된다).
            turnWindow = windowAfterOverflow(turnWindow, sent, e?.message);
            const known = limitFromOverflow(sent, e?.message);
            if (known !== null) knownWindow = knownWindow ? Math.min(knownWindow, known) : known;
            // 더 세게 줄여 같은 단계를 한 번만 다시 보낸다. 줄일 것이 없으면 같은 요청을 다시 보내지 않는다.
            if (!retried) { retried = true; if (squeeze('retry')) { resent = true; continue; } }
            // 안전망(3차 검수 HIGH): 1단계인데 줄여도 못 풀고 앞 턴이 중단 기록으로 끝났으면 그 턴을 걷어내고(main의 재개 정리와 같은 결과) 한 번만 다시 보낸다 —
            // 저장할 때의 판정(아래 fits)이 어떤 이유로 틀려도 그 전사가 대화를 영구히 막지 않게 하는 마지막 방어. 다시 보내도 넘치면 아래로(사실대로 실패).
            if (steps === 1 && !cut) { const rest = dropStoppedTurn(sess.messages); if (rest) { cut = true; sess.messages = rest; continue; } }
          }
          const spent = !!((usage.input_tokens ?? 0) + (usage.output_tokens ?? 0));
          if (overflow) {
            // 사실대로 끝낸다. 이 턴에 끝난 도구 결과가 있으면 크루 글 한 줄(중단 기록)로 꼬리를 닫아 저장한다 — 꼬리가 tool_result면 재개 정리가
            // 그 턴을 통째로 걷어내 다음 턴이 처음부터 다시 하다 같은 자리에서 또 넘쳤다. 원인 모를 거절(아래 종전 갈래)에는 붙이지 않는다(그 턴을 다시 보내면 또 거절될 수 있다).
            if (steps === 1 && !spent) throw Object.assign(new Error(overflowErrorText(e?.message, lang, { resent, cut })), { cause: e, status: e?.status });
            // 저장 전에 이번 단계 결과까지 한도 안으로 줄여 본다 — 그대로 저장하면 다음 턴들이 같은 전사를 이어받아 매번 넘친다.
            // 줄인 전사(+ 중단 기록, system·도구 정의 포함)가 실제로 들어갈 크기일 때만 꼬리를 닫는다: 기준은 확실한 값 — 원문 숫자로 환산한 한도와 이 턴에 벤더가 받아 준
            // 가장 큰 요청 — 중 큰 쪽의 75%(사전 기준선과 같은 여유 — 다음 지시가 붙을 자리). 숫자 없는 문구의 거절 지점(turnWindow)은 쓰지 않는다: 한도의 위쪽 끝일 뿐이라
            // 그 75%가 실제 한도를 넘을 수 있었다(3차 검수 HIGH, z.ai·Responses). 넘친 부분이 도구 '입력'(큰 Write·Edit·셸 heredoc)·지시·크루 글이면 줄일 것이 없다 — 그때 꼬리를 닫아 저장하면 다음 턴마다
            // 1단계에서 거절되고 저장 없이 던져 대화가 영구히 막혔다(2차 검수 HIGH). 들어가지 않으면 줄인 사본은 버리고 종전처럼 저장해 재개 정리가 이 턴을 걷어내게 둔다.
            const closed = [...squeezed('final').messages, { role: 'assistant', content: [{ type: 'text', text: overflowStopNote(lang) }] }];
            const fits = fixedTokens + estimateTokens(closed) <= TURN_BUDGET_AT * Math.max(knownWindow, okTokens);
            if (fits) sess.messages = closed;
            if (saveSession) await saveNativeSession(wsId, slug, sess);
            // '이어서 해 줘'는 다음 턴이 실제로 이 전사를 이어받을 때만 쓴다 — 이어 온 세션(sess.resumed)이어야 스레드가 이 세션 id를 쥐고 있다(실패 턴은 id를 남기지 않는다)
            yield { type: 'result', subtype: 'error_during_execution', session_id: sess.id, usage, total_cost_usd: null, is_error: true, num_turns: steps,
              errors: [overflowErrorText(e?.message, lang, { resent, cut, resumable: saveSession && fits && !!sess.resumed, dropped: saveSession && !fits })] };
            return;
          }
          if (!spent) throw e;
          if (saveSession) await saveNativeSession(wsId, slug, sess);
          yield { type: 'result', subtype: 'error_during_execution', session_id: sess.id, usage, total_cost_usd: null, is_error: true, num_turns: steps, errors: [String(e?.message || e)] };
          return;
        }
      }
      sumUsage(usage, res?.usage);
      const content = Array.isArray(res?.content) ? res.content : [];
      sess.messages.push({ role: 'assistant', content });
      // 표시용 사본 — 와이어가 따로 실어 준 사고(Gemini 사고 파트 gem_thought의 글·Responses reasoning 요약 res.thoughts)를 thinking 블록으로 앞에 둔다.
      // 전사(sess.messages)는 받은 그대로 — 벤더로 다시 가는 내용은 바뀌지 않는다(사고 옵션을 새로 켜지도 않는다: 모델이 준 만큼만).
      yield { type: 'assistant', message: { model: res?.model || model, content: displayContent(content, res?.thoughts) } };
      const uses = content.filter((b) => b?.type === 'tool_use');
      // tool_use 블록이 있으면 stop_reason과 무관하게 실행한다(분리 검수 HIGH-2: max_tokens 절단 응답의 tool_use를 버리면
      // 도구는 안 돌고 전사에는 짝 없는 tool_use가 남아 다음 턴이 죽는다).
      if (!uses.length) {
        const text = content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n').trim();
        if (saveSession) await saveNativeSession(wsId, slug, sess);
        // total_cost_usd: null — Anthropic 단가로 타 벤더를 계산하던 오액(openrouter 규칙)을 전 러너로. 토큰은 usage에.
        yield { type: 'result', subtype: 'success', result: text, session_id: sess.id, usage: { ...usage }, total_cost_usd: null, is_error: false, num_turns: steps };
        // 마지막 답을 쓰는 사이에 온 끼워 넣기 — SDK처럼 같은 실행 안에서 한 번 더 답한다(result가 한 번 더 나온다).
        // 확인과 닫기 사이에 await가 없어 이 뒤로 들어오는 끼워 넣기는 거절된다(호출부가 대기열에 남긴다).
        if (!inbox.items.length) { inbox.closed = true; return; }
        inbox.continued = inbox.items.splice(0); // 이 이어진 실행에 실린 끼워 넣기 — 실패하면 호출부가 이것만 실패로 표시한다
        sess.messages.push({ role: 'user', content: steerNote(inbox.continued, lang) });
        for (const k of Object.keys(usage)) delete usage[k]; // 앞 result가 이미 집계했다 — 다음 result는 이어진 몫만
        continue;
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
      // 도구 결과도 SDK query()처럼 type:'user' 메시지로 낸다 — chat.mjs가 작업 과정(turn-trace)에 결과를 짝지어 싣는다(2026-10-09).
      // 이 메시지를 받지 않는 소비자는 무시한다(chat.mjs 루프는 system·assistant·result만 분기). 전사(sess.messages)와 같은 배열을 그대로 보낸다 — 사본을 바꾸지 않는다.
      yield { type: 'user', message: { role: 'user', content: results.slice() }, parent_tool_use_id: null, session_id: sess.id };
      // 도구가 도는 사이에 온 끼워 넣기 — 다음 모델 호출에 도구 결과와 같이 싣는다(tool_result 블록 뒤 text 블록)
      if (inbox.items.length) results.push({ type: 'text', text: steerNote(inbox.items.splice(0), lang) });
      sess.messages.push({ role: 'user', content: results });
      if (saveSession) await saveNativeSession(wsId, slug, sess); // 단계마다 영속 — 중단·크래시에도 문맥 보존
    }
  } finally {
    inbox.closed = true; // 실패·중단·상한 종료도 이후 끼워 넣기를 거절한다
    await browserTools.close().catch(() => {});
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
  const inbox = { items: [], closed: false, continued: null };
  const gen = run(opts, ac, () => interrupted, inbox);
  gen.interrupt = async () => { interrupted = true; ac.abort(); };
  /** 끼워 넣기 — 멈추지 않고 다음 모델 호출에 싣는다. 실행이 끝났으면 false(호출부가 대기열에 남긴다). */
  gen.steer = async (text) => {
    if (inbox.closed || interrupted || !String(text ?? '').trim()) return false;
    inbox.items.push(String(text));
    return true;
  };
  gen.continuedTexts = () => inbox.continued; // 마지막 답 뒤 이어진 실행에 실린 끼워 넣기(없으면 null)
  return gen;
}

/** 끼워 넣은 사장 메시지를 모델에게 보이는 글로 감싼다(순수) — SDK(Claude Code)가 쓰는 표지와 같은 뜻. */
export function steerNote(texts, lang = 'ko') {
  const body = texts.join('\n\n');
  return lang === 'en' ? `The user sent a new message while you were working:\n${body}` : `사용자가 작업 중에 새 메시지를 보냈다:\n${body}`;
}
