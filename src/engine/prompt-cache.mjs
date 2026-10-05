// 프롬프트 캐시 표지(cache_control) — 네이티브 엔진은 매 턴 전사 전체를 다시 보낸다. Anthropic은 같은 앞부분을 표지로 캐시해
// 다시 읽는 값을 깎아 준다. 표지는 **받는다고 확인된 엔드포인트에만** 싣는다(순수·의존성 0):
//   Anthropic API(ARGO_CLAUDE_BASE_URL, 기본 api.anthropic.com) — 모든 모델
//   OpenRouter(OPENROUTER_BASE_URL, 기본 openrouter.ai/api) — anthropic/* 모델만(그 밖 제공사는 이 필드를 모를 수 있다)
// xAI·z.ai·Moonshot·Gemini·Responses 와이어에는 싣지 않는다 — 모르는 필드에 400을 낸 전례(Grok required, 2026-09-06)가 있다.
// 판정은 모델 이름이 아니라 엔드포인트로 한다(GLM 엔드포인트에 claude 이름을 줘도 표지를 싣지 않는다).
// 표지는 보내는 사본에만 붙인다 — 세션 파일에 남으면 크루가 러너를 바꿔 같은 세션을 이을 때 그 벤더가 400을 낸다.

const norm = (u) => String(u ?? '').trim().replace(/\/+$/, '').toLowerCase();

/** 이 요청에 표지를 실을까(순수). procEnv는 테스트용 주입. */
export function cacheEligible({ wire = 'messages', base, model, procEnv = process.env }) {
  if (wire !== 'messages') return false;
  const b = norm(base);
  if (!b) return false;
  if (b === norm(procEnv.ARGO_CLAUDE_BASE_URL || 'https://api.anthropic.com')) return true;
  if (b === norm(procEnv.OPENROUTER_BASE_URL || 'https://openrouter.ai/api')) return /^anthropic\//i.test(String(model ?? '').trim());
  return false;
}

const MARK = Object.freeze({ type: 'ephemeral' });
// 표지를 직접 달 수 없는 블록 — 사고 블록(문서: thinking 블록은 직접 표지 불가)·빈 텍스트(문서: 빈 텍스트 블록에 표지 불가)·다른 와이어 사이드채널
const markable = (b) => b && typeof b === 'object' && !['thinking', 'redacted_thinking', 'gem_thought'].includes(b.type) && !(b.type === 'text' && !String(b.text ?? '').length);

/** 메시지 마지막 표지 가능 블록에 표지를 단 사본(순수). 달 자리가 없으면 null. */
function markMessage(m) {
  const content = typeof m?.content === 'string' ? (m.content.length ? [{ type: 'text', text: m.content }] : []) : Array.isArray(m?.content) ? m.content : [];
  const i = content.findLastIndex(markable);
  if (i < 0) return null;
  return { ...m, content: content.map((b, j) => (j === i ? { ...b, cache_control: MARK } : b)) };
}

const isPrompt = (m) => m?.role === 'user' && (typeof m.content === 'string' || (Array.isArray(m.content) && !m.content.some((b) => b?.type === 'tool_result')));

/** 요청 본문 → 표지를 단 사본(순수, 입력 비파괴). 최대 4곳: 도구 정의 끝·system 끝·마지막 메시지·그 앞의 마지막 사장 지시.
    마지막 메시지 표지가 이번 호출까지의 앞부분을 캐시에 쓰고, 앞 지시 표지가 직전 턴까지 쓴 캐시를 읽는다(도구 결과가 많아 자동 되돌아보기 20블록을 넘어도). */
export function withCacheControl(body) {
  const out = { ...body };
  if (Array.isArray(body.tools) && body.tools.length) out.tools = body.tools.map((t, i) => (i === body.tools.length - 1 ? { ...t, cache_control: MARK } : t));
  if (typeof body.system === 'string' && body.system.length) out.system = [{ type: 'text', text: body.system, cache_control: MARK }];
  else if (Array.isArray(body.system) && body.system.some(markable)) { const i = body.system.findLastIndex(markable); out.system = body.system.map((b, j) => (j === i ? { ...b, cache_control: MARK } : b)); }
  if (Array.isArray(body.messages) && body.messages.length) {
    const msgs = body.messages.slice();
    const lastIdx = msgs.length - 1;
    const last = markMessage(msgs[lastIdx]); if (last) msgs[lastIdx] = last;
    const prev = msgs.findLastIndex((m, i) => i < lastIdx && isPrompt(m));
    if (prev >= 0) { const pm = markMessage(msgs[prev]); if (pm) msgs[prev] = pm; }
    out.messages = msgs;
  }
  return out;
}
