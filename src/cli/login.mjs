// argo CLI 로그인 — 앱의 브라우저 핸드오프(app/login/page.jsx → /auth/paired → /api/device/link)를 Next 없이 CLI 안에 옮긴 것.
// 흐름: CLI가 127.0.0.1에 작은 페이지를 띄운다 → 브라우저에서 Google/GitHub로 로그인 → Supabase가 /auth/paired로 돌려보낸다
// (허용 목록 http://127.0.0.1:*/auth/paired — 앱과 같은 항목이라 설정 변경 없음) → 사용자가 "이 터미널 로그인"을 눌러야만
// 토큰이 CLI로 넘어오고, 검증(getUser) 뒤 기기 세션으로 저장한다.
// 앱과 같은 원칙: ① 명시적 승인(무클릭 링크로 세션이 넘어가지 않게) ② 브라우저 탭은 조각을 파싱만 하고 갱신하지 않는다(단일 소유자 —
// refresh 토큰 이중 소유는 GoTrue가 세션 가족째 폐기한다) ③ expires_at 0으로 저장해 첫 사용 때 바로 회전.
// 다른 웹사이트가 이 주소로 공격자 토큰을 밀어 넣는 것(로그인 CSRF)은 nonce(리다이렉트 주소에만 있음)가 막는다 — 일반 교차 출처 요청도
// Host는 127.0.0.1이라 Host 검사는 통과한다. Host 검사는 DNS 리바인딩(공격자 도메인을 127.0.0.1로 돌리는 것)만 막는다.
// 브라우저가 없는 서버는 `ssh -L <port>:127.0.0.1:<port> 서버`로 내 PC 브라우저에서 같은 주소를 연다(고정 포트).
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

export const DEFAULT_LOGIN_PORT = 38417;

const TEXT = {
  ko: { title: 'Argo 터미널 로그인', pick: '로그인할 계정을 고르세요.', confirm: '이 터미널(argo CLI)을 이 계정으로 로그인할까요?', approve: '이 터미널 로그인', done: '로그인했습니다. 이 탭을 닫고 터미널로 돌아가세요.', fail: '로그인하지 못했습니다. 터미널에 나온 처음 주소를 다시 열어 시도하세요.', noToken: '로그인 정보를 받지 못했습니다. 처음부터 다시 시도하세요.' },
  en: { title: 'Argo terminal sign-in', pick: 'Choose the account to sign in with.', confirm: 'Sign this terminal (argo CLI) in with this account?', approve: 'Sign in this terminal', done: 'Signed in. Close this tab and return to the terminal.', fail: 'Sign-in failed. Open the first address shown in the terminal and try again.', noToken: 'No sign-in data was received. Start over from the terminal.' },
};
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>/* 앱 기본 테마 graphite와 같은 값(app/globals.css :root[data-theme='graphite'] — 다크는 시스템 설정을 따른다) */
:root{--bg:#fafafa;--card:#fff;--fg:#393939;--fg-2:#5e5e5e;--border:rgba(0,0,0,.12);--primary:#1a1a1a;--primary-fg:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#202020;--card:#252525;--fg:#cfcfcf;--fg-2:#a5a5a5;--border:rgba(255,255,255,.14);--primary:#ededed;--primary-fg:#1a1a1a}}
body{font:15px/1.6 'Pretendard Variable',Pretendard,-apple-system,BlinkMacSystemFont,sans-serif;background:var(--bg);color:var(--fg);display:grid;place-items:center;min-height:100vh;margin:0;padding:16px;box-sizing:border-box}
main{max-width:420px;width:100%;background:var(--card);border:1px solid var(--border);border-radius:14px;padding:28px;box-sizing:border-box}h1{font-size:19px;margin:0 0 10px}p{color:var(--fg-2)}
a.b,button{display:block;width:100%;box-sizing:border-box;margin-top:10px;padding:11px;border-radius:10px;border:1px solid var(--primary);background:var(--primary);color:var(--primary-fg);font:inherit;font-weight:600;text-align:center;text-decoration:none;cursor:pointer}
a.b.o{background:transparent;color:var(--fg);border-color:var(--border)}</style></head><body><main><h1>${esc(title)}</h1>${body}</main></body></html>`;

/** Host 헤더가 루프백인지(순수) — DNS 리바인딩으로 다른 이름을 127.0.0.1에 붙인 요청은 받지 않는다. */
export const isLoopback = (host) => /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(String(host ?? ''));

/** 로그인 서버 — 반환 { url, authorizeUrl(provider), done: Promise<user>, close() }. verify/save는 테스트가 끼운다. */
export async function startLoginServer({ supabaseUrl, anonKey, port = DEFAULT_LOGIN_PORT, lang = 'ko', providers = ['google', 'github'], verify, save } = {}) {
  if (!supabaseUrl || !anonKey) throw new Error('Supabase 공개 설정(URL·anon 키)이 없습니다 — ~/.argo/cli.json 또는 환경변수를 확인하세요');
  const tx = TEXT[lang === 'en' ? 'en' : 'ko'];
  const nonce = randomBytes(16).toString('hex');
  let settled = false; let resolveDone;
  const done = new Promise((res) => { resolveDone = res; }); // 검증 실패는 끝내지 않는다 — 브라우저에서 다시 시도할 수 있다
  const verifyToken = verify ?? (async (accessToken) => {
    const sb = createClient(supabaseUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data, error } = await sb.auth.getUser(accessToken);
    if (error || !data?.user) throw new Error('유효하지 않은 세션입니다');
    return data.user;
  });
  const saveSession = save ?? (async (session) => (await import('../devicesession.mjs')).saveDeviceSession({ url: supabaseUrl, anonKey, session }));
  let base = '';
  const authorizeUrl = (provider) => `${supabaseUrl}/auth/v1/authorize?provider=${encodeURIComponent(provider)}&redirect_to=${encodeURIComponent(`${base}/auth/paired?cli=${nonce}`)}`;

  const server = createServer(async (req, res) => {
    const send = (status, html, type = 'text/html; charset=utf-8') => { res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }); res.end(html); };
    if (!isLoopback(req.headers.host)) return send(403, 'forbidden', 'text/plain');
    const u = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && u.pathname === '/') {
      return send(200, page(tx.title, `<p>${esc(tx.pick)}</p>${providers.map((p, i) => `<a class="b${i ? ' o' : ''}" href="${esc(authorizeUrl(p))}">${esc(p === 'github' ? 'GitHub' : p === 'google' ? 'Google' : p)}</a>`).join('')}`));
    }
    if (req.method === 'GET' && u.pathname === '/auth/paired') {
      if (u.searchParams.get('cli') !== nonce) return send(400, page(tx.title, `<p>${esc(tx.fail)}</p>`));
      // 조각(#access_token…)은 서버로 오지 않는다 — 페이지가 파싱해 승인 버튼을 누를 때만 보낸다(자동 전송 금지).
      return send(200, page(tx.title, `<p id="m">${esc(tx.confirm)}</p><button id="a" hidden>${esc(tx.approve)}</button>
<script>const h=new URLSearchParams(location.hash.slice(1));history.replaceState(null,'','/auth/paired?cli=${nonce}');
const at=h.get('access_token'),rt=h.get('refresh_token'),m=document.getElementById('m'),a=document.getElementById('a');
if(!at||!rt){m.textContent=${JSON.stringify(tx.noToken)};}else{a.hidden=false;a.onclick=async()=>{a.disabled=true;
const r=await fetch('/bind',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({cli:${JSON.stringify(nonce)},access_token:at,refresh_token:rt})}).then(r=>r.ok).catch(()=>false);
a.hidden=true;m.textContent=r?${JSON.stringify(tx.done)}:${JSON.stringify(tx.fail)};};}</script>`));
    }
    if (req.method === 'POST' && u.pathname === '/bind') {
      let body = '';
      for await (const c of req) { body += c; if (body.length > 64_000) return send(413, 'too large', 'text/plain'); }
      let j = {}; try { j = JSON.parse(body); } catch { /* 아래에서 거절 */ }
      if (settled || j.cli !== nonce || !j.access_token || !j.refresh_token) return send(400, JSON.stringify({ ok: false }), 'application/json');
      try {
        const user = await verifyToken(j.access_token);
        await saveSession({ access_token: j.access_token, refresh_token: j.refresh_token, expires_at: 0, user }); // 0 = 첫 사용 때 바로 회전
        settled = true;
        send(200, JSON.stringify({ ok: true }), 'application/json');
        resolveDone({ id: user.id, email: user.email ?? '' });
      } catch {
        send(401, JSON.stringify({ ok: false }), 'application/json');
      }
      return;
    }
    send(404, 'not found', 'text/plain');
  });
  await new Promise((resolve, reject) => {
    server.once('error', (e) => (e.code === 'EADDRINUSE' && port ? server.listen(0, '127.0.0.1', resolve) : reject(e)));
    server.listen(port, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
  const close = () => new Promise((r) => server.close(() => r()));
  return { url: `${base}/`, port: server.address().port, authorizeUrl, done, close, _nonce: nonce };
}
