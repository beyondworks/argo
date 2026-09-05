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
export const QUOTA_RE = /weekly limit|rate.?limit|too many requests|\b429\b|quota exceeded|usage limit|run out of credits|insufficient.*(credit|balance|fund)|\b402\b/i;
export const OVERLOADED_RE = /\boverloaded\b|\b529\b|\b503\b|connection closed mid-response|server-side issue|\bECONNRESET\b|\bETIMEDOUT\b/i;
export const CLI_MISSING_RE = /러너 CLI를 찾지 못했습니다|runner cli not found|\bENOENT\b|command not found/i;
export const MODEL_UNAVAILABLE_RE = /does not support this model|model not found|unknown model|requested entity was not found|no such model|invalid model/i;

/** 코드 표 — UI i18n 키(chat.fail.<code>)와 1:1. 새 코드는 여기와 i18n에 **동시에**(테스트가 대조). */
export const FAIL_CODES = Object.freeze([
  'aborted', 'auth_expired', 'subscription_blocked', 'quota', 'vendor_overloaded',
  'endpoint_not_found', 'cli_missing', 'model_unavailable', 'crash', 'unknown',
]);
const ORIGIN = Object.freeze({
  aborted: 'user', auth_expired: 'probe', subscription_blocked: 'vendor', quota: 'vendor', vendor_overloaded: 'vendor',
  endpoint_not_found: 'vendor', cli_missing: 'argo', model_unavailable: 'vendor', crash: 'argo', unknown: 'probe',
});

/** 원문 + 호출자가 이미 아는 표식(flags) → { code, origin }. flags는 chat.mjs가 판정한 것을 그대로 받는다
    (aborted·endpointNotFound·credit·auth·crash·lockup) — AUTH_ERR_RE 등 기존 정규식을 여기로 옮기지 않는다
    (그 정규식은 자가치유 발동 조건이라 계약이 다르다; 이 표는 표시·통계 전용). 순서가 하중이다:
    구독 차단은 "authenticate" 단어가 섞여 와도 인증보다 먼저(자가치유 오발동 방지), 한도는 과부하보다 먼저. */
export function classifyRunnerError(msg, { flags = {} } = {}) {
  const s = String(msg ?? '');
  const out = (code) => ({ code, origin: ORIGIN[code] });
  if (flags.aborted) return out('aborted');
  if (SUBSCRIPTION_BLOCKED_RE.test(s)) return out('subscription_blocked');
  if (flags.endpointNotFound) return out('endpoint_not_found');
  if (flags.crash || flags.lockup) return out('crash');
  if (CLI_MISSING_RE.test(s)) return out('cli_missing');
  if (flags.credit || QUOTA_RE.test(s)) return out('quota');
  if (flags.auth || OAUTH_SESSION_EXPIRED_RE.test(s)) return out('auth_expired');
  if (MODEL_UNAVAILABLE_RE.test(s)) return out('model_unavailable');
  if (OVERLOADED_RE.test(s)) return out('vendor_overloaded');
  return out('unknown');
}

/** 구독 차단 안내 — 재연결이 아니라 **키 방식 전환**이 해법이라 runnerAuthNotice와 문구를 가른다. */
export const subscriptionBlockedNotice = (lang, runnerName = 'Claude') => (lang === 'en'
  ? `${runnerName} blocked subscription use from this app (vendor policy) — this is not a sign-in problem. Switch the connection to an API key in Settings → AI connections, or use another runner.`
  : `${runnerName} 구독을 이 앱에서 쓰는 것이 벤더 정책으로 차단됐습니다 — 로그인 문제가 아닙니다. 설정 → AI 연결에서 API 키 방식으로 바꾸거나 다른 러너를 지정해 주세요.`);
