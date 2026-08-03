// Grok(xAI) 계정 로그인 — **기기 코드(device code)** 흐름.
//
// 왜 기기 코드인가: 콜백 리스너가 아예 필요 없다. codex·gemini가 쓰는 루프백 콜백은 상주
// (launchd 백그라운드)·헤드리스 VPS·포트 선점 환경에서 도달성 문제를 낳았고(v0.1.38 #223이 그
// 수습이다), xAI는 device_code를 지원하는 몇 안 되는 제공자다. 사용자는 주소에 가서 코드만 넣는다.
//
// 실측(2026-08-03, 이 세션이 직접 curl):
//   POST auth.x.ai/oauth2/device/code (client_id + scope)  → 200 device_code·user_code·interval 5·expires_in 1800
//   같은 요청에 가짜 client_id                              → 400 invalid_client "Unknown or disabled client"
//   → **차등 대조**로 이 client_id가 실제 등록·활성 상태임을 확인했다(문서만 보고 붙이지 않는다).
//   POST api.x.ai/v1/messages (가짜 키, Anthropic 형식)     → 400 "Incorrect API key" / 없는 경로 → 404
//   → 토큰은 Anthropic 호환 배관(ANTHROPIC_AUTH_TOKEN)으로 흐른다. x-api-key·Bearer 둘 다 같은 지점까지 간다.
//
// **미검증(정직 표기)**: 승인을 끝낸 실토큰으로 턴을 돌리지는 못했다(이 기기에 xAI 계정·크레딧 없음).
// 즉 "인증 → 토큰 수령"까지는 실측, "그 토큰으로 대화"는 코드 경로 대조까지다.

const CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828'; // 공개(퍼블릭) 클라이언트 — 비밀값 아님, DCR 미지원이라 사전 등록 id를 쓴다
const DEVICE_URL = 'https://auth.x.ai/oauth2/device/code';
const TOKEN_URL = 'https://auth.x.ai/oauth2/token';
// offline_access가 빠지면 갱신 토큰을 못 받아 만료마다 다시 로그인이다 — 실사용에서 가장 흔한 "왜 자꾸 풀리나".
const SCOPE = 'openid profile email offline_access grok-cli:access api:access';

const form = (o) => new URLSearchParams(o).toString();
const FORM_HEADERS = { 'content-type': 'application/x-www-form-urlencoded' };

/** 토큰 응답 → 저장 형식. expires_at은 절대시각(ms)이라 기기 시계만 맞으면 갱신 판단이 단순해진다. */
export function packGrokTokens(d, now = Date.now()) {
  const access = String(d?.access_token ?? '');
  if (!access) return null;
  return {
    access_token: access,
    // 갱신 응답이 refresh_token을 안 주는 제공자가 있다(회전 안 함) — 그때는 쓰던 것을 유지해야 한다.
    ...(d.refresh_token ? { refresh_token: String(d.refresh_token) } : {}),
    expires_at: now + (Number(d.expires_in) > 0 ? Number(d.expires_in) : 3600) * 1000,
  };
}

/** 저장된 값에서 실제 토큰만 꺼낸다 — JSON(현행)과 생 토큰(구형·수동 입력) 둘 다 받는다. */
export function grokAccessToken(stored) {
  if (!stored) return '';
  try {
    const d = JSON.parse(stored);
    // JSON인데 access_token이 없으면 **빈 문자열**이다. 원문을 돌려주면 refresh_token이 든
    // JSON 통째로 `ANTHROPIC_AUTH_TOKEN`에 실려 api.x.ai로 나간다(분리 검수 2026-08-03 L-1).
    return typeof d?.access_token === 'string' ? d.access_token : '';
  } catch { return String(stored); } // 구형(생 토큰) 관용 — JSON이 아니면 그 자체가 토큰이다
}

/** 만료까지 **5분** 미만이면 갱신 대상. 60초로 잡았더니 6분짜리 긴 턴이 시작 직후엔 유효했다가
    도중에 만료됐다(분리 검수 2026-08-03 L-3). 만료시각을 모르는 값(구형)은 손대지 않는다. */
export const GROK_REFRESH_MARGIN_MS = 5 * 60_000;
export function grokNeedsRefresh(stored, now = Date.now()) {
  try {
    const d = JSON.parse(stored);
    return !!(d?.refresh_token && Number(d?.expires_at) > 0 && Number(d.expires_at) - now < GROK_REFRESH_MARGIN_MS);
  } catch { return false; }
}

/** 갱신 — 실패하면 null을 돌려주고 호출부는 쓰던 토큰을 그대로 쓴다(조용한 연결 해제보다 401이 낫다). */
export async function refreshGrokTokens(stored, fetchImpl = fetch) {
  let d; try { d = JSON.parse(stored); } catch { return null; }
  if (!d?.refresh_token) return null;
  try {
    const res = await fetchImpl(TOKEN_URL, {
      method: 'POST', headers: FORM_HEADERS,
      body: form({ grant_type: 'refresh_token', refresh_token: d.refresh_token, client_id: CLIENT_ID }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const next = packGrokTokens(await res.json().catch(() => ({})));
    if (!next) return null;
    // 회전하지 않는 제공자를 대비해 옛 refresh_token을 물려준다 — 안 물려주면 다음 갱신이 불가능해진다.
    return JSON.stringify({ refresh_token: d.refresh_token, ...next });
  } catch { return null; }
}

/** 기기 코드 발급 — 사용자가 갈 주소와 넣을 코드를 돌려준다. */
export async function startGrokDeviceLogin(fetchImpl = fetch) {
  const res = await fetchImpl(DEVICE_URL, {
    method: 'POST', headers: FORM_HEADERS, body: form({ client_id: CLIENT_ID, scope: SCOPE }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return { ok: false, reason: 'device-start-failed', detail: `${res.status} ${(await res.text().catch(() => '')).slice(0, 160)}` };
  const b = await res.json().catch(() => ({}));
  if (!b.device_code || !b.user_code) return { ok: false, reason: 'device-shape' };
  return {
    ok: true,
    deviceCode: String(b.device_code),
    userCode: String(b.user_code),
    url: String(b.verification_uri_complete ?? b.verification_uri ?? 'https://accounts.x.ai/oauth2/device'),
    interval: Number(b.interval) > 0 ? Number(b.interval) : 5,
    expiresIn: Number(b.expires_in) > 0 ? Number(b.expires_in) : 1800,
  };
}

/**
 * 승인됐는지 **한 번** 묻는다. 아직이면 pending — 부르는 쪽이 간격을 지켜 다시 묻는다.
 * 서버 안에서 루프를 돌리지 않는 이유: 사용자가 창을 닫아도 영원히 도는 폴링이 안 남는다.
 */
export async function pollGrokDeviceLogin(deviceCode, fetchImpl = fetch) {
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST', headers: FORM_HEADERS,
    body: form({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: deviceCode, client_id: CLIENT_ID }),
    signal: AbortSignal.timeout(15_000),
  });
  const b = await res.json().catch(() => ({}));
  if (res.ok) {
    const packed = packGrokTokens(b);
    return packed ? { ok: true, tokens: JSON.stringify(packed) } : { ok: false, reason: 'token-shape' };
  }
  // 표준 대기 신호는 오류가 아니다. 좁게 보면 되는 흐름을 실패로 끊는다(webauth 머리 주석의 교훈 2).
  const err = String(b.error ?? '');
  if (err === 'authorization_pending' || err === 'slow_down') return { ok: false, pending: true, slowDown: err === 'slow_down' };
  return { ok: false, reason: err || `http-${res.status}` };
}

/**
 * xAI "크레딧 없음 / 구독 필요" 판정 — **인증 실패가 아니다.** 토큰은 통과했고 계정 사정이다.
 *
 * 실측 2026-08-03(실계정 BYOA 토큰, 유건 기기): 세 엔드포인트가 같은 code를 준다.
 *   GET  /v1/models            403 {"code":"personal-team-blocked:spending-limit", "error":"You have run out of credits or need a Grok subscription…"}
 *   POST /v1/messages          403 (동일)
 *   POST /v1/chat/completions  402 (동일)
 *
 * 이걸 안 가르면 SDK가 403을 "Failed to authenticate"로 번역해 화면에 띄운다 — 사용자는 방금
 * 성공한 자기 로그인을 의심하며 재연결을 반복한다(실사용 신고 2026-08-03). 상태코드(402·403)가
 * 아니라 **본문 code/문구**로 판정한다: 같은 사정을 두 코드로 주는 것이 실측이고, 403을 통째로
 * 크레딧으로 몰면 진짜 권한 오류까지 오안내가 된다.
 */
export const isGrokCreditError = (text) => /personal-team-blocked|spending-limit|run out of credits|need a grok subscription/i.test(String(text ?? ''));

/** 충전·구독처를 함께 준다 — "안 된다"만 말하면 사용자가 갈 곳이 없다(openrouter 402 선례와 동형). */
export const grokCreditNotice = (lang) => (lang === 'en'
  ? 'Your xAI account has no credits (or needs a Grok subscription) — the sign-in itself worked. Add credits at https://console.x.ai or subscribe at https://grok.com/supergrok, then try again. You can also switch this crew to another engine.'
  : 'xAI 계정에 크레딧이 없거나 Grok 구독이 필요합니다 — 로그인 자체는 정상입니다. https://console.x.ai 에서 충전하거나 https://grok.com/supergrok 에서 구독한 뒤 다시 시도해 주세요. 이 크루의 엔진을 다른 러너로 바꿔도 됩니다.');
