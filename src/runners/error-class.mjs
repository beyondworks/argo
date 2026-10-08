// 러너 오류 분류(순수) — 벤더 원문을 "사용자가 할 일"로 바꾸는 코드 표.
//
// 왜(2026-09-05 유건 지시 "100% 확실하게"): 같은 실패가 Argo에선 "API Error: 400"으로, Hermes·OpenClaw에선
// 구조화 코드(status·reasonCode)로 표면화된다(OpenClaw docs/auth-credential-semantics.md의 status 버킷
// ok·auth·rate_limit·billing·timeout·format·no_model, Hermes agent/api_error_summary.py의 status_code 우선 분류).
// 이 모듈이 그 표를 Argo에 둔다. 의존 0 — chat.mjs·라우트·UI·테스트가 같은 표를 본다(이원화 금지).
//
// origin(출처)은 유건 판정 기준 "Argo에서 나는 오류가 진짜 벤더 오류면 Hermes·OpenClaw에서도 나야 한다"의
// 코드화다: 'vendor' = 어떤 클라이언트로 쏴도 같은 응답(한도·구독 정책·과부하·엔드포인트 설정), 'argo' = 이
// 기기·이 앱의 실행 환경(CLI 미발견·크래시), 'probe' = 같은 자격으로 맨 프로브를 쏴 봐야 갈린다(인증류·미상)
// — chat.mjs가 프로브 결과로 vendor/argo를 확정해 이벤트에 각인한다.

/** 구독 차단 — 인증 실패가 **아니다**. AUTH_ERR_RE로 자가치유(다른 러너로 갈아타기)하면 사용자 고지 없이
    실과금 키로 넘어간다. 상주 실측(2026-09-05) 원문 3건: "Your organization has disabled Claude subscription
    access for Claude Code · Use an Anthropic API key instead", Hermes 대시보드 카드 제목 "Required Extra Usage
    Credits to Use Subscription"(같은 벤더 정책). */
export const SUBSCRIPTION_BLOCKED_RE = /organization has disabled claude subscription|subscription access for claude code|extra usage credits/i;
/** 상주 실측 1위(9건): 붙여넣은 setup-token 스냅숏은 Argo가 갱신 못 한다 — 사용자 행동은 "다시 로그인" 하나. */
export const OAUTH_SESSION_EXPIRED_RE = /oauth session expired|could not be refreshed/i;
// 인증 실패 원문(러너 무관) — 네이티브 엔진·SDK가 내는 `API Error: 401 …`류를 플래그 없이도 분류한다(하네스 통일 P-A).
// 403은 구독 차단·정책·권한이 섞여 있어 넣지 않는다(구독 차단은 위에서 먼저 잡힌다).
export const AUTH_TEXT_RE = /\b401\b|invalid (?:api[- ]?key|x-api-key|token|credentials?)|authentication[_ ]error|unauthori[sz]ed/i;
// session limit — 벤더 원문 "You've hit your session limit · resets 2:20pm (Asia/Seoul)"(사용자 피드백 2026-09-10, K02)
export const QUOTA_RE = /weekly limit|session limit|rate.?limit|too many requests|\b429\b|quota exceeded|usage limit|run out of credits|insufficient.*(credit|balance|fund)|\b402\b/i;
export const OVERLOADED_RE = /\boverloaded\b|\b529\b|\b503\b|connection closed mid-response|server-side issue|\bECONNRESET\b|\bETIMEDOUT\b/i;
// 확정 문구만 본다 — 진짜 CLI 미발견은 apiError(exec.mjs)가 e.code/짧은 stderr로 판정해 이 문구로 바꿔 준다.
// 원문 전체의 ENOENT·command not found를 보면 크루 셸 출력이 섞인 인증 만료·한도 실패까지 덮었다(K09).
export const CLI_MISSING_RE = /러너 CLI를 찾지 못했습니다|runner cli not found/i;
export const MODEL_UNAVAILABLE_RE = /does not support this model|model not found|unknown model|requested entity was not found|no such model|invalid model|not supported when using codex with a chatgpt account/i;
// 컨텍스트 길이 초과 — 벤더마다 문구가 다르다(상태도 400·413, Responses 스트림 실패는 502로 온다): Anthropic "prompt is too long: N tokens > L maximum"·
// "input length and `max_tokens` exceed context limit: N + M > L"·413 request_too_large, xAI "This model's maximum prompt length is L but the request contains N tokens.", OpenRouter·OpenAI 호환 "maximum context length is L tokens"·
// "context_length_exceeded", OpenAI Responses "Your input exceeds the context window of this model", Gemini "The input token count (N) exceeds the maximum number of
// tokens allowed (L)", z.ai(GLM) 1261 "Prompt too long"·"tokens in request more than max tokens allowed", Moonshot(Kimi) "exceeded model token limit".
// 출처: Gemini는 Google 개발자 포럼 원문, z.ai 1261은 docs.z.ai 오류 코드 표, 나머지는 opencode packages/llm/src/provider-error.ts의 벤더 문구 목록(2026-10-08 확인).
// 실벤더에 쏴서 받은 원문 대조는 아직 없다(제보 사용자의 원문도 받지 못함) — 실원문이 다르면 아래 낱말에 한 줄 더한다.
// 네이티브 엔진이 이 문구로 턴 안 예산 재시도(engine/turn-budget.mjs)를 하고, 그래도 실패하면 '컨텍스트 한도 초과' 머리 문구로 끝낸다(아래 두 낱말이 그 머리).
export const CONTEXT_EXCEEDED_RE = /prompt (?:is )?too long|request_too_large|context[_ ]length[_ ]exceeded|model_context_window_exceeded|maximum (?:prompt|context) length is \d|exceeds? (?:the )?(?:model'?s )?(?:maximum )?context (?:window|length|limit)|input token count.*exceeds the maximum|tokens in request more than max tokens allowed|exceeded model token limit|reduce the length of the messages|컨텍스트 한도 초과|context limit exceeded/i;
// 분당 토큰 한도("too many tokens per minute")·잔액(OpenRouter 402 "requires more credits, or fewer max_tokens")·출력 상한("max_tokens: … maximum allowed number of
// output tokens") 문구는 위 낱말에 걸리지 않는다(test/native-turn-budget TB10이 잠근다) — 넓은 낱말("too many tokens", "token limit")은 그래서 넣지 않았다.
export const isContextOverflowText = (s) => CONTEXT_EXCEEDED_RE.test(String(s ?? ''));
// 낡은 codex 관리본의 모델 거절 — codex.mjs codexOutdatedError가 만드는 확정 문구만 본다(그 함수와 한 쌍).
export const RUNNER_OUTDATED_RE = /Codex 실행기 업데이트가 아직 끝나지 않아|codex runner update is not finished/i;

/** 코드 표 — UI i18n 키(chat.fail.<code>)와 1:1. 새 코드는 여기와 i18n에 **동시에**(테스트가 대조). */
export const FAIL_CODES = Object.freeze([
  'aborted', 'auth_expired', 'subscription_blocked', 'quota', 'vendor_overloaded',
  'endpoint_not_found', 'cli_missing', 'runner_outdated', 'model_unavailable', 'crash', 'no_runner', 'context_exceeded', 'unknown',
]);
// no_runner = 이 기기·이 회사에 턴을 돌릴 러너 자격이 없다(chat.mjs 러너 확인 갈래가 flags.noRunner로 붙인다 — 문구로 분류하지 않는다).
const ORIGIN = Object.freeze({
  aborted: 'user', auth_expired: 'probe', subscription_blocked: 'vendor', quota: 'vendor', vendor_overloaded: 'vendor',
  endpoint_not_found: 'vendor', cli_missing: 'argo', runner_outdated: 'argo', model_unavailable: 'vendor', crash: 'argo', no_runner: 'argo', context_exceeded: 'vendor', unknown: 'probe',
});

/** 원문 + 호출자가 이미 아는 표식(flags) → { code, origin }. flags는 chat.mjs가 판정한 것을 그대로 받는다
    (aborted·noRunner·endpointNotFound·credit·auth·crash·lockup) — AUTH_ERR_RE 등 기존 정규식을 여기로 옮기지 않는다
    (그 정규식은 자가치유 발동 조건이라 계약이 다르다; 이 표는 표시·통계 전용). 순서가 하중이다:
    구독 차단은 "authenticate" 단어가 섞여 와도 인증보다 먼저(자가치유 오발동 방지), 한도는 과부하보다 먼저. */
export function classifyRunnerError(msg, { flags = {} } = {}) {
  const s = String(msg ?? '');
  const out = (code) => ({ code, origin: ORIGIN[code] });
  if (flags.aborted) return out('aborted');
  if (flags.noRunner) return out('no_runner');
  if (SUBSCRIPTION_BLOCKED_RE.test(s)) return out('subscription_blocked');
  if (flags.endpointNotFound) return out('endpoint_not_found');
  if (flags.crash || flags.lockup) return out('crash');
  if (CLI_MISSING_RE.test(s)) return out('cli_missing');
  if (RUNNER_OUTDATED_RE.test(s)) return out('runner_outdated');
  // 길이 초과는 한도(QUOTA_RE)보다 먼저 — Responses 스트림의 context_length_exceeded는 와이어가 429로 매겨 '\b429\b'에 먼저 걸린다(responses-wire finalFromSse)
  if (!flags.credit && isContextOverflowText(s)) return out('context_exceeded');
  if (flags.credit || QUOTA_RE.test(s)) return out('quota');
  if (flags.auth || OAUTH_SESSION_EXPIRED_RE.test(s) || AUTH_TEXT_RE.test(s)) return out('auth_expired');
  if (MODEL_UNAVAILABLE_RE.test(s)) return out('model_unavailable');
  if (OVERLOADED_RE.test(s)) return out('vendor_overloaded');
  return out('unknown');
}

/** 구독 차단 안내 — 재연결이 아니라 **키 방식 전환**이 해법이라 runnerAuthNotice와 문구를 가른다. */
export const subscriptionBlockedNotice = (lang, runnerName = 'Claude') => (lang === 'en'
  ? `${runnerName} blocked subscription use from this app (vendor policy) — this is not a sign-in problem. Switch the connection to an API key in Settings → AI connections, or use another runner.`
  : `${runnerName} 구독을 이 앱에서 쓰는 것이 벤더 정책으로 차단됐습니다 — 로그인 문제가 아닙니다. 설정 → AI 연결에서 API 키 방식으로 바꾸거나 다른 러너를 지정해 주세요.`);
