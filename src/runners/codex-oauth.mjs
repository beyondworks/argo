// Codex 구독 OAuth를 Argo가 직접 다룬다(하네스 통일 P-B, 2026-09-06 유건 승인) — Hermes auth_codex·codex_headers 실측 대조.
// 핵심 = 토큰 저장소 분리: CLI의 ~/.codex/auth.json을 공유하지 않고 회사 자격(.secrets.json runners.codex oauth = auth.json 원문)을 Argo가 독립
// 리프레시한다("한 앱의 refresh-token 회전이 다른 앱 세션을 무효화하지 않도록" — Argo가 겪은 'Refresh Token Already Used' 계열의 뿌리).
// 리프레시 실패(회전 경합·invalid_grant)는 CLI 파일에서 1회 재반입(자가치유), 그래도 안 되면 재로그인(authExpired). 429는 한도(재로그인으로 못 푼다).
// 정책 위험: 구독 토큰의 제3자 하네스 사용은 OpenAI 정책 변경에 취약 → 옵트인 플래그(ARGO_NATIVE_RUNNERS에 codex 명시) + app-server 경로 폴백 유지.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';

export const CODEX_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'; // codex CLI와 같은 client id(Hermes CODEX_OAUTH_CLIENT_ID)
export const CODEX_OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const ARGO_VERSION = (() => { try { return createRequire(import.meta.url)('../../package.json').version; } catch { return '0.0.0'; } })();

/** auth.json 원문(자격 value) → 토큰(순수). 형식 아님이면 null. */
export function parseCodexAuth(value) {
  try { const j = JSON.parse(String(value ?? '')); const t = j?.tokens; return t && typeof t.access_token === 'string' ? { access_token: t.access_token, refresh_token: t.refresh_token ?? '', account_id: t.account_id ?? '', id_token: t.id_token ?? '', raw: j } : null; }
  catch { return null; }
}
/** JWT payload(순수) — 서명 검증은 안 한다(만료·계정 id 읽기 전용). */
export function jwtClaims(token) {
  try { const p = String(token).split('.')[1]; return JSON.parse(Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (p.length % 4)) % 4), 'base64').toString('utf8')); } catch { return {}; }
}
export const accessExpiring = (access, skewSec = 120) => { const exp = Number(jwtClaims(access)?.exp); return Number.isFinite(exp) && exp <= Date.now() / 1000 + skewSec; };
export const accountIdOf = (tokens) => jwtClaims(tokens?.access_token)?.['https://api.openai.com/auth']?.chatgpt_account_id || tokens?.account_id || '';

/** 백엔드 헤더(순수) — 제3자 하네스임을 밝힌다(OpenAI 요구, Hermes 동일). codex CLI 위장 금지. */
export function codexHeaders(tokens) {
  const acct = accountIdOf(tokens);
  return { authorization: `Bearer ${tokens.access_token}`, originator: 'argo', 'user-agent': `Argo/${ARGO_VERSION}`, 'OpenAI-Beta': 'responses=experimental', ...(acct ? { 'ChatGPT-Account-ID': acct } : {}) };
}

/** 리프레시 1회(순수 HTTP) — 429는 한도(quota, 재로그인 무효), invalid_grant·refresh_token_reused는 재로그인(authExpired). */
export async function refreshCodexTokens(refreshToken, { fetchImpl = globalThis.fetch, tokenUrl = process.env.CODEX_OAUTH_TOKEN_URL || CODEX_OAUTH_TOKEN_URL } = {}) {
  if (!refreshToken) throw Object.assign(new Error('codex auth is missing refresh_token'), { authExpired: 'codex' });
  const r = await fetchImpl(tokenUrl, { method: 'POST', signal: AbortSignal.timeout(20_000),
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', 'user-agent': `Argo/${ARGO_VERSION}` },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: CODEX_OAUTH_CLIENT_ID }).toString() });
  const text = await r.text().catch(() => '');
  if (r.status === 429) throw Object.assign(new Error('codex quota exhausted (token endpoint 429)'), { quota: true, status: 429, retryAfter: Number(r.headers.get('retry-after')) || null });
  if (!r.ok) {
    const code = (() => { try { return JSON.parse(text)?.error; } catch { return ''; } })();
    const relogin = /invalid_grant|invalid_token|invalid_request|refresh_token_reused/.test(String(typeof code === 'string' ? code : code?.code ?? '') + text);
    throw Object.assign(new Error(`codex token refresh failed: ${r.status} ${text.slice(0, 120)}`), { status: r.status, ...(relogin ? { authExpired: 'codex' } : {}) });
  }
  let j; try { j = JSON.parse(text); } catch { throw new Error('codex token refresh returned invalid JSON'); }
  if (!j?.access_token) throw new Error('codex token refresh response missing access_token');
  return { access_token: j.access_token, refresh_token: j.refresh_token || refreshToken, id_token: j.id_token ?? '' };
}

/** CLI 파일(~/.codex/auth.json)에서 토큰을 1회 읽는다(쓰기 금지, 만료·refresh 없음이면 반입 안 함). */
export async function readCliCodexAuth(home = homedir()) {
  try { const t = parseCodexAuth(await readFile(join(home, '.codex', 'auth.json'), 'utf8')); return t && t.refresh_token && !accessExpiring(t.access_token, 0) ? t : null; } catch { return null; }
}

/** 갱신된 토큰을 auth.json 원문에 반영(순수) — CLI 파일 형식을 유지해 저장 값이 그대로 CLI 폴백에도 쓰인다. */
export function mergeCodexAuth(raw, next) {
  const out = { ...(raw ?? {}), tokens: { ...(raw?.tokens ?? {}), ...next }, last_refresh: new Date().toISOString() };
  if (!out.tokens.account_id) { const a = accountIdOf(out.tokens); if (a) out.tokens.account_id = a; }
  return JSON.stringify(out);
}
