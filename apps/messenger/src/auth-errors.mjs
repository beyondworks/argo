// 로그인 화면 오류 — GoTrue(서버)·브라우저가 돌려주는 영어 원문을 사전 키로(검수 D9: ko 화면에 "Invalid login credentials"가 그대로 떴다).
// 모르는 문구는 원문 그대로 둔다(정직 — friendlyErr와 같은 원칙). 순서가 곧 우선순위다.
const TABLE = [
  [/invalid login credentials/i, 'auth.err.credentials'],
  [/email not confirmed/i, 'auth.err.unconfirmed'],
  [/user already registered/i, 'auth.err.exists'],
  [/token has expired or is invalid|email link is invalid or has expired|otp_expired/i, 'auth.err.expired'],
  [/invalid refresh token|refresh token not found|refresh_token_not_found|auth session missing/i, 'auth.err.session'],
  [/invalid flow state|flow state (?:has )?expired|code verifier|invalid (?:auth(?:orization)? )?code|bad_code_verifier/i, 'auth.err.exchange'],
  [/access_denied|user_cancelled|user cancelled/i, 'auth.err.denied'],
  [/rate limit|too many requests|only request this after/i, 'auth.err.rateLimit'],
  [/signups? not allowed|signup is disabled|signups are disabled/i, 'auth.err.signupDisabled'],
  [/password should be|weak password|weak_password/i, 'auth.err.weakPassword'],
  [/failed to fetch|networkerror|network request failed|load failed/i, 'auth.err.network'],
];
export const authErrorKey = (msg) => TABLE.find(([re]) => re.test(String(msg ?? '')))?.[1] ?? null;
export const authErrorText = (msg, t) => { const k = authErrorKey(msg); return k ? t(k) : String(msg ?? ''); };
