// 러너 OAuth 웹 브리지(PKCE) — 시작/콜백 리스너/코드 제출/완료 폴링.
// (runners.mjs 관심사 분리 2026-07-28)

import { randomBytes, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { saveRunnerCred } from './creds.mjs';
import { provisionGeminiCli, probeGeminiOAuth } from './gemini.mjs';

/* ─── 러너 OAuth 웹 브리지(공통) — "버튼 클릭 = 로그인 페이지" ───
   각 CLI가 내부에서 쓰는 표준 PKCE 플로우를 서버가 직접 수행한다(CLI는 TTY/localhost 콜백
   요구로 headless 대행 불가 — 실측). client id들은 각 CLI에 내장된 공개 상수
   (installed app의 client_secret은 시크릿으로 취급되지 않음 — Google 문서).
   흐름: 서버가 verifier/challenge 생성 → 인증 URL을 UI에 반환(사용자 기기에서 열림) →
   승인 후 받은 코드(claude: code#state 표시 / codex·gemini: localhost로 리다이렉트된 주소 전체)를
   UI에 붙여넣으면 서버가 토큰으로 교환 → 회사 자격으로 저장 → 암호화 동기화로 전 기기 전파. */
// claude는 WEB_OAUTH에서 제외(2026-07-18 철회). 이전 브리지(authorize=claude.ai/oauth/authorize,
// token=console.anthropic.com/v1/oauth/token, client 9d1c250a-…, scopes 'org:create_api_key
// user:profile user:inference')는 교환엔 성공하지만 러너(SDK)가 401로 거절하는 비 sk-ant-oat01
// 토큰(92자)을 반환했다 — "연결됨" 표시 후 전 턴 실패(실측, 장기 미궁 "러너 연결해도 대화 안 됨"의 원인).
// 현행 Claude Code CLI 바이너리 상수 실측: TOKEN_URL=platform.claude.com/v1/oauth/token,
// authorize=claude.com/cai/oauth/authorize·platform.claude.com/oauth/authorize,
// API_KEY_URL=api.anthropic.com/api/oauth/claude_cli/create_api_key(교환 후 후속 발급 단계),
// ROLES_URL=…/claude_cli/roles — 전혀 다른 세대의 미공개 플로우다. 역공학 재현은 다음 개편 때
// 같은 조용한 파손을 재발시키므로, 공식 발급 경로(claude setup-token) 붙여넣기로 일원화한다.
const WEB_OAUTH = {
  codex: {
    authorize: 'https://auth.openai.com/oauth/authorize',
    token: 'https://auth.openai.com/oauth/token',
    clientId: 'app_EMoamEEZ73f0CkXaXp7hrann', // Codex CLI 공개 클라이언트 id
    redirect: 'http://localhost:1455/auth/callback', // CLI 등록 콜백 — 사용자는 리다이렉트된 주소를 붙여넣는다
    scopes: 'openid profile email offline_access',
  },
  gemini: {
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    clientId: '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com', // gemini-cli 공개
    clientSecret: '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', // installed app 공개 상수 — 시크릿 아님(Google 문서)
    redirect: 'http://localhost:45289/oauth2callback',
    scopes: 'https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile',
    extra: { access_type: 'offline', prompt: 'consent' }, // refresh_token 확보
  },
};
const webAuthState = (globalThis.__argoWebAuth ??= {}); // { [runner]: { verifier, state, ts } }
const webAuthListeners = (globalThis.__argoWebAuthSrv ??= {}); // { [runner]: http.Server } — 1회용 콜백 리스너

/** 로컬 콜백 리스너 — 승인 후 브라우저가 돌아오는 localhost 콜백을 서버가 직접 받아 자동 교환한다.
    이전엔 "사이트에 연결할 수 없음" 오류 화면이 뜨고 사용자가 그 주소를 복사해 붙여넣어야 했다
    (실사용 신고 2026-07-19: 오류로 읽혀 연결 실패로 인지). 리스너가 받으면 복사 단계 자체가 없어지고
    브라우저에는 "연결되었습니다" 페이지가 뜬다. 포트 선점 실패(벤더 CLI 로그인 동시 실행 등)나
    호스팅 워커(사용자 기기가 아님)에선 조용히 건너뛴다 — 기존 붙여넣기 폴백이 그대로 동작한다. */
function startWebAuthListener(runner, wsId, cfg) {
  // 호스팅 가드 없음(2026-07-19 수정): 서비스 키를 가진 상주 웹(:3001)도 사용자 본인 맥이라 리스너가
  // 꺼지면 자동 연결이 안 됐다(실사용 신고 — 격리 dev에선 켜져서 검증이 또 가려짐). 원격 호스팅에서도
  // 리스너는 워커 루프백에서 놀다 TTL로 닫힐 뿐 무해하고, 위조 코드는 PKCE 교환이 차단한다(검수 확인).
  // 알려진 한계: webAuthState/리스너가 러너 단위 전역이라 다중 테넌트 동시 연결은 마지막 시작이 이긴다(기존과 동일).
  try { webAuthListeners[runner]?.close(); } catch { /* 이전 리스너 정리 */ }
  const target = new URL(cfg.redirect);
  const page = (title, body) => `<!doctype html><meta charset="utf-8"><title>Argo</title><body style="font-family:system-ui;display:grid;place-items:center;height:90vh"><div style="text-align:center"><h2>${title}</h2><p style="color:#666">${body}</p></div>`;
  const srv = createServer(async (req, res) => {
    try {
      const u = new URL(req.url, cfg.redirect);
      if (u.pathname !== target.pathname || !u.searchParams.get('code')) { res.statusCode = 404; res.end(); return; }
      const r = await submitRunnerWebAuth(wsId, runner, u.toString()); // 기존 검증 경로 그대로(state/verifier 확인 포함)
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(r.ok
        ? page('연결되었습니다', '이 창을 닫고 Argo로 돌아가세요 — 화면에 곧 "연결됨"이 표시됩니다.')
        : page('연결에 실패했습니다', 'Argo로 돌아가 다시 시도하거나, 이 페이지 주소를 복사해 붙여넣어 주세요.'));
      if (r.ok) { try { srv.close(); } catch { /* 이미 닫힘 */ } delete webAuthListeners[runner]; }
    } catch { res.statusCode = 500; res.end(); }
  });
  srv.on('error', () => { delete webAuthListeners[runner]; /* EADDRINUSE 등 — 붙여넣기 폴백 */ });
  srv.listen(Number(target.port), '127.0.0.1');
  webAuthListeners[runner] = srv;
  const ttl = setTimeout(() => { try { srv.close(); } catch { /* 이미 닫힘 */ } delete webAuthListeners[runner]; }, 10 * 60_000);
  ttl.unref?.();
}

export function startRunnerWebAuth(runner, wsId = null) {
  const cfg = WEB_OAUTH[runner];
  if (!cfg) return { ok: false, reason: 'unsupported' };
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  // state는 verifier와 무관한 별도 난수여야 한다. verifier를 state로 실으면(과거 설계) 사용자가
  // 붙여넣기 폴백에서 복사·공유하는 리다이렉트 주소에 code+verifier가 함께 실려, 그 주소만으로
  // 제3자가 어디서든 토큰 교환을 완료할 수 있다 — PKCE가 막으려던 코드 탈취의 재개방(감사 HIGH 2026-07-20).
  // verifier는 서버 메모리에만 두고, state는 submitRunnerWebAuth가 대조하는 1회용 CSRF 난수로만 쓴다.
  const state = randomBytes(16).toString('base64url');
  webAuthState[runner] = { verifier, state, ts: Date.now() };
  if (wsId) startWebAuthListener(runner, wsId, cfg); // 자동 수신 — 실패해도 붙여넣기 폴백 유지
  // 사용자가 브라우저에서 승인하는 동안 실행기를 미리 조달 — 저장 관문 프로브(probeGeminiOAuth)가 안 기다리게
  if (runner === 'gemini') provisionGeminiCli().catch(() => {});
  const u = new URL(cfg.authorize);
  for (const [k, v] of Object.entries(cfg.extra ?? {})) u.searchParams.set(k, v);
  u.searchParams.set('client_id', cfg.clientId);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('redirect_uri', cfg.redirect);
  u.searchParams.set('scope', cfg.scopes);
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('state', state);
  return { ok: true, url: u.toString() };
}

/** 붙여넣은 값에서 인증 코드 추출 — 전체 URL(localhost 콜백)·code#state·생 코드 모두 수용. */
function extractAuthCode(pasted) {
  const s = String(pasted).trim();
  if (s.includes('://')) {
    try {
      const u = new URL(s);
      return { code: u.searchParams.get('code') ?? '', state: u.searchParams.get('state') ?? '' };
    } catch { /* URL 아님 — 아래로 */ }
  }
  const [code, state] = s.split('#');
  return { code, state: state ?? '' };
}

/** id_token(JWT) 페이로드 디코드 — 서명 검증 불필요(우리가 방금 토큰 엔드포인트에서 직접 받은 값). */
function jwtPayload(tok) {
  try {
    const p = String(tok).split('.')[1];
    return JSON.parse(Buffer.from(p, 'base64url').toString());
  } catch { return {}; }
}

export async function submitRunnerWebAuth(wsId, runner, pasted) {
  const cfg = WEB_OAUTH[runner];
  const st = webAuthState[runner];
  if (!cfg) return { ok: false, reason: 'unsupported' };
  if (!st?.verifier) return { ok: false, reason: 'no-session' };
  if (Date.now() - st.ts > 10 * 60_000) return { ok: false, reason: 'expired' }; // 10분 — 다시 시작
  const { code, state } = extractAuthCode(pasted);
  if (!code) return { ok: false, reason: 'no-code' };
  // state 대조(CSRF·주소 위조 방어) — 발급 시 저장한 1회용 난수와 다르면 거절. 리스너·전체 URL 붙여넣기는
  // 벤더가 state를 항상 에코하므로 상시 대조되고, state 없는 생 코드 붙여넣기만 관용(PKCE 교환이 위조 코드 차단).
  if (state && st.state && state !== st.state) return { ok: false, reason: 'state-mismatch' };
  const params = {
    grant_type: 'authorization_code',
    code,
    client_id: cfg.clientId,
    redirect_uri: cfg.redirect,
    code_verifier: st.verifier,
    ...(cfg.clientSecret ? { client_secret: cfg.clientSecret } : {}),
  };
  let res;
  try {
    res = await fetch(cfg.token, {
      method: 'POST',
      headers: { 'content-type': cfg.jsonBody ? 'application/json' : 'application/x-www-form-urlencoded' },
      body: cfg.jsonBody ? JSON.stringify(params) : new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    return { ok: false, reason: 'network', detail: String(e.message || e).slice(0, 120) };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return { ok: false, reason: 'exchange-failed', detail: `${res.status} ${body.slice(0, 160)}` };
  }
  const d = await res.json().catch(() => ({}));
  if (runner === 'codex') {
    if (!d.access_token || !d.refresh_token) return { ok: false, reason: 'no-token' };
    // codex CLI의 auth.json 형식 그대로 저장 — runnerCredEnv가 격리 CODEX_HOME에 풀어준다
    const accountId = jwtPayload(d.id_token)?.['https://api.openai.com/auth']?.chatgpt_account_id ?? null;
    await saveRunnerCred(wsId, 'codex', 'oauth', JSON.stringify({
      OPENAI_API_KEY: null,
      tokens: { id_token: d.id_token, access_token: d.access_token, refresh_token: d.refresh_token, account_id: accountId },
      last_refresh: new Date().toISOString(),
    }));
  } else if (runner === 'gemini') {
    if (!d.access_token || !d.refresh_token) return { ok: false, reason: 'no-token' };
    // gemini CLI의 oauth_creds.json 형식
    const credsJson = JSON.stringify({
      access_token: d.access_token,
      refresh_token: d.refresh_token,
      scope: d.scope ?? cfg.scopes,
      token_type: d.token_type ?? 'Bearer',
      ...(d.id_token ? { id_token: d.id_token } : {}),
      expiry_date: Date.now() + (d.expires_in ?? 3600) * 1000,
    });
    // 저장 전 실사용 프로브 — 부적격(구글 개인 OAuth 차단) 확정이면 '연결됨'을 만들지 않는다.
    // 안내문만 붙이고 저장을 통과시키면 사용자는 첫 크루 영입에서야 실패를 만난다(실사용 신고 2026-07-20).
    const probe = await probeGeminiOAuth(credsJson);
    if (probe.ok === false) {
      return {
        ok: false, reason: 'ineligible',
        detail: '로그인은 성공했지만 저장하지 않았습니다 — 구글이 이 계정의 Gemini 개인 OAuth(무료 Code Assist)를 폐기하고 Antigravity로 이전했습니다. Antigravity 러너로 연결하시거나(이 컴퓨터의 agy 로그인 인식), API 키 방식으로 연결해 주세요(Google AI Studio에서 무료 발급). Login succeeded but was not saved — Google retired personal OAuth on the current Gemini CLI in favor of Antigravity. Connect the Antigravity runner (uses this computer’s agy login) or use an API key instead.',
      };
    }
    await saveRunnerCred(wsId, 'gemini', 'oauth', credsJson);
  }
  // 세션 종료 — verifier 재사용 금지. 완료 마커를 남겨 폴링(GET connect)이 "이번 브리지 세션이
  // 실제로 저장을 마쳤나"를 본다. 자격 존재만 보면 기존 자격 보유 러너의 재연결·방식 전환이
  // OAuth 승인 전에 2초 만에 거짓 '연결됨'이 된다(감사 2026-07-20 — 구독 전환했다고 믿는데 옛 키 과금).
  webAuthState[runner] = { saved: true, savedWs: wsId, ts: Date.now() };
  return { ok: true };
}

/** 웹 브리지 완료 여부(폴링용) — "이번 세션에서 이 스코프의 저장이 끝났나"만 true. 자격 존재와 무관. */
export function webAuthDone(runner, wsId) {
  const st = webAuthState[runner];
  return !!(st?.saved && st.savedWs === wsId);
}
