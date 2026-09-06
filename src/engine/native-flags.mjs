// 네이티브 엔진 러너 판정 — 순수·의존성 0. creds·catalog·chat이 같은 판정을 쓴다(native-query가 재수출).
/** 기본 네이티브 러너 — 키 기반. openrouter·glm·kimi·grok은 Anthropic Messages 와이어, gemini는 Google AI Studio API 키(generateContent 와이어 —
    gemini-wire.mjs). gemini는 **API 키 자격일 때만** 네이티브이고 구독(oauth)·host 자격은 CLI 경로 그대로다(catalog.isCliTurn). 유건 승인 2026-09-05·09-06. */
/** 네이티브 와이어 자격·선택 env — 크루 도구 자식(Bash)·MCP 서버 프로세스에는 절대 상속하지 않는다(shellEnv). 실행 중인 러너 자신의 자격도 도구에는
    필요 없다(printenv 한 번이면 전사·세션 파일·벤더 재전송으로 평문이 흐른다 — 분리 검수 HIGH-1). 새 와이어를 붙이면 여기 이름을 더한다. */
export const WIRE_ENV_KEYS = Object.freeze(['ARGO_WIRE', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_BASE_URL', 'RESPONSES_BASE_URL', 'RESPONSES_TOKEN', 'RESPONSES_HEADERS']);

export const NATIVE_DEFAULT_RUNNERS = Object.freeze(['openrouter', 'glm', 'kimi', 'grok', 'gemini']);

/** env ARGO_NATIVE_RUNNERS: 미설정/빈 값 = 기본 목록 on · `none`/`off`/`0`/`false` = 전부 off(구 경로 폴백) · 목록 = 그 러너만.
    구독 OAuth(claude)는 목록에 넣어도 엔진이 거절한다(authFromEnv). */
export function nativeRunnerEnabled(runner, env = process.env) {
  const raw = String(env.ARGO_NATIVE_RUNNERS ?? '').trim().toLowerCase();
  const r = String(runner ?? '').toLowerCase();
  if (!raw) return NATIVE_DEFAULT_RUNNERS.includes(r);
  if (['none', 'off', '0', 'false'].includes(raw)) return false;
  return raw.split(',').map((s) => s.trim()).filter(Boolean).includes(r);
}
