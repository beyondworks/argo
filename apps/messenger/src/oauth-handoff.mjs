// 브라우저 핸드오프 로그인 — Argo 앱(app/login/page.jsx oauthViaBrowser + api/auth/pair + auth/paired)과 같은 계약.
// 웹뷰는 Google·GitHub 로그인 창을 못 띄운다(임베디드 웹뷰 차단·패스키 팝업 불가) → 앱 셸(src-tauri/src/pair.rs)이 루프백에
// 일회용 서버를 열고 code(브라우저용)+verifier(앱 전용)를 만든다 → 진짜 브라우저에서 provider 로그인 → Supabase가
// http://127.0.0.1:<port>/auth/paired?pair=<code> 로 되돌리면 그 페이지가 사용자 승인 뒤 세션을 code에 봉인 → 앱이
// verifier로 1회 회수해 supabase-js 세션으로 심는다. 외부 서버 의존 0 — 셀프호스트에서도 같은 코드가 돈다.
// 이메일 OTP를 버린 이유(2026-09-07 라이브 실측): Supabase 기본 메일 템플릿은 링크만 보내 코드가 없고, 내장 SMTP는 시간당
// 상한이 있다 — Argo 앱이 같은 이유로 이메일 로그인을 뺐다(login/page.jsx 주석).
// Tauri·fetch·타이머는 전부 주입받는 순수 모듈(test/msgr-oauth-handoff.test.mjs가 행동으로 잠근다).

export const PROVIDERS = ['apple', 'google', 'github']; // apple = App Store 4.8(제3자 로그인 제공 시 Sign in with Apple 필수). 웹 플로우(Services ID)라 브라우저 왕복은 google·github와 같다
export const PAIR_TIMEOUT_MS = 5 * 60_000;
export const PAIR_POLL_MS = 1500;

/** 브라우저에 열 authorize URL. redirect_to는 Supabase Redirect URLs 허용 목록에 http://127.0.0.1:<포트>/auth/paired(와일드카드 포트)가 있어야 한다. */
export function authorizeUrl({ supabaseUrl, port, provider, code }) {
  if (!PROVIDERS.includes(provider)) throw new Error('unknown provider');
  const back = `http://127.0.0.1:${port}/auth/paired?pair=${encodeURIComponent(code)}`;
  return `${supabaseUrl}/auth/v1/authorize?provider=${provider}&redirect_to=${encodeURIComponent(back)}`;
}

/**
 * 핸드오프 한 번. 성공하면 { access_token, refresh_token }, 실패는 Error(code):
 *   'not_app'(Tauri 밖) · 'start_failed'(루프백 서버 못 엶) · 'open_failed'(브라우저 못 엶) · 'timeout' · 'expired'.
 * deps: { invoke(cmd, args), openUrl(url), sleep(ms), now() }
 */
export async function handoff({ supabaseUrl, provider }, deps) {
  if (!deps.invoke) throw new Error('not_app');
  const st = await deps.invoke('pair_start').catch(() => null);
  if (!st?.port || !st?.code || !st?.verifier) throw new Error('start_failed');
  const { port, code, verifier } = st;
  try { await deps.openUrl(authorizeUrl({ supabaseUrl, port, provider, code })); } catch { throw new Error('open_failed'); }
  const started = deps.now();
  while (deps.now() - started < PAIR_TIMEOUT_MS) {
    await deps.sleep(PAIR_POLL_MS);
    const res = await deps.invoke('pair_claim', { code, verifier }).catch(() => ({ status: 'pending' }));
    if (res?.status === 'ready' && res.access_token && res.refresh_token) return { access_token: res.access_token, refresh_token: res.refresh_token };
    if (res?.status === 'expired') throw new Error('expired');
  }
  throw new Error('timeout');
}

/** GoTrue 공개 설정에서 켜진 제공자를 읽는다 → { apple, google, github } (boolean). 실패·모양 이상이면 null(= 게이팅 안 함).
    검수 #528 HIGH-2: 서버에 Apple이 꺼져 있으면 버튼이 죽은 채 보이고 5분 타임아웃까지 기다렸다. */
export async function fetchProviderSettings(supabaseUrl, fetchFn = globalThis.fetch, anonKey = '') {
  try {
    const r = await fetchFn(`${supabaseUrl}/auth/v1/settings`, { headers: { accept: 'application/json', ...(anonKey ? { apikey: anonKey } : {}) } }); // 호스티드 게이트웨이가 apikey를 요구해도 조용히 fail-open 되지 않게(검수 #530 L-4)
    if (!r?.ok) return null;
    const j = await r.json();
    const ext = j?.external;
    if (!ext || typeof ext !== 'object') return null;
    return Object.fromEntries(PROVIDERS.map((p) => [p, ext[p] !== false])); // 명시적으로 꺼진 것만 숨긴다 — 키가 없는(구버전) 응답은 보여 준다
  } catch { return null; }
}

/** 버튼 표시 판정(검수 #530 M-2: 행동으로 잠근다). enabled=null(미조회·실패) → 표시, 명시적 false만 숨김. */
export const providerShown = (enabled, p) => !enabled || enabled[p] !== false;
/** 서버가 제공자를 하나도 켜지 않았다(검수 #530 H-1: 버튼 0개면 안내와 서버 바꾸기 유도). */
export const noProviders = (enabled) => !!enabled && PROVIDERS.every((p) => enabled[p] === false);
