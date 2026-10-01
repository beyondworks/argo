// argo CLI 로그인 — 앱의 브라우저 핸드오프(app/login/page.jsx → /auth/paired → /api/device/link)를 Next 없이 CLI 안에 옮긴 것.
// 흐름: CLI가 127.0.0.1에 작은 페이지를 띄운다 → 브라우저에서 Google/GitHub로 로그인 → Supabase가 /auth/paired로 돌려보낸다
// (허용 목록 http://127.0.0.1:*/auth/paired — 앱과 같은 항목이라 설정 변경 없음) → 사용자가 "이 터미널 로그인"을 눌러야만
// 토큰이 CLI로 넘어오고, 검증(getUser) 뒤 기기 세션으로 저장한다.
// 앱과 같은 원칙: ① 명시적 승인(무클릭 링크로 세션이 넘어가지 않게) ② 브라우저 탭은 조각을 파싱만 하고 갱신하지 않는다(단일 소유자 —
// refresh 토큰 이중 소유는 GoTrue가 세션 가족째 폐기한다) ③ expires_at 0으로 저장해 첫 사용 때 바로 회전.
// 다른 웹사이트가 이 주소로 공격자 토큰을 밀어 넣는 것(로그인 CSRF)은 nonce(리다이렉트 주소에만 있음)가 막는다 — 일반 교차 출처 요청도
// Host는 127.0.0.1이라 Host 검사는 통과한다. Host 검사는 DNS 리바인딩(공격자 도메인을 127.0.0.1로 돌리는 것)만 막는다.
// 같은 컴퓨터의 다른 프로세스(여러 OS 사용자가 쓰는 서버의 다른 계정 등)는 포트만 알면 예전엔 GET /에서 nonce가 든 링크를 읽고
// /bind에 자기 토큰을 넣어 이 터미널을 자기 계정으로 로그인시킬 수 있었다(검수 L1, 재현 확인). 그래서 네 겹으로 막는다:
// ① 첫 주소에 터미널에만 출력되는 비밀값(k)을 넣고 GET /에서 요구한다 — nonce는 k를 아는 쪽에만 보인다.
// ② /bind는 브라우저의 같은 출처 요청만(Sec-Fetch-Site: same-origin, 그 헤더가 없는 옛 브라우저는 Origin이 이 서버일 때만) + JSON만.
// ③ 모든 응답에 X-Frame-Options: DENY(+ frame-ancestors 'none') — 다른 페이지가 이 화면을 끼워 승인 버튼을 누르게 하지 못한다.
// ④ 저장 전에 터미널에서 계정 이메일을 보여 주고 y/N을 받는다(confirm) — 위가 모두 뚫려도 모르는 계정은 사람이 거절한다.
// 브라우저가 없는 서버는 `ssh -L <port>:127.0.0.1:<port> 서버`로 내 PC 브라우저에서 같은 주소를 연다(고정 포트).
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

export const DEFAULT_LOGIN_PORT = 38417;

const TEXT = {
  ko: { title: 'Argo 터미널 로그인', pick: '로그인할 계정을 고르세요.', confirm: '이 터미널(argo CLI)을 이 계정으로 로그인할까요?', approve: '이 터미널 로그인', done: '로그인했습니다. 이 탭을 닫고 터미널로 돌아가세요.', fail: '로그인하지 못했습니다. 터미널에 나온 처음 주소를 다시 열어 시도하세요.', noToken: '로그인 정보를 받지 못했습니다. 처음부터 다시 시도하세요.', needKey: '터미널에 나온 주소를 그대로(끝까지) 열어 주세요.', checkTerminal: '터미널에서 계정을 확인하고 y를 눌러 주세요.', declined: '터미널에서 로그인을 취소했습니다. 다시 하려면 터미널에 나온 처음 주소를 여세요.' },
  en: { title: 'Argo terminal sign-in', pick: 'Choose the account to sign in with.', confirm: 'Sign this terminal (argo CLI) in with this account?', approve: 'Sign in this terminal', done: 'Signed in. Close this tab and return to the terminal.', fail: 'Sign-in failed. Open the first address shown in the terminal and try again.', noToken: 'No sign-in data was received. Start over from the terminal.', needKey: 'Open the full address shown in the terminal.', checkTerminal: 'Check the account in the terminal and press y.', declined: 'Sign-in was cancelled in the terminal. To retry, open the first address shown in the terminal.' },
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

/** /bind가 받는 요청인가(순수) — 브라우저가 이 서버의 페이지에서 보낸 같은 출처 요청만. Sec-Fetch-Site가 없는 옛 브라우저는 Origin으로 본다.
    교차 사이트 요청은 브라우저가 Sec-Fetch-Site(cross-site)와 자기 Origin을 붙이므로 둘 다 걸린다. 로컬 프로세스는 헤더를 꾸밀 수 있어서
    이 검사만으로는 막지 못한다 — 그쪽은 비밀값(k)과 터미널 확인이 막는다. */
export const sameOriginBind = (headers, base) => {
  const site = headers?.['sec-fetch-site'];
  if (site) return site === 'same-origin';
  return !!base && headers?.origin === base;
};

/** 로그인 서버 — 반환 { url, authorizeUrl(provider), done: Promise<user>, close() }. verify/save는 테스트가 끼운다.
    confirm(user) → Promise<boolean>: 저장 전에 터미널에서 계정을 확인한다(거절하면 저장하지 않고 계속 기다린다). 생략하면 확인 없이 저장. */
export async function startLoginServer({ supabaseUrl, anonKey, port = DEFAULT_LOGIN_PORT, lang = 'ko', providers = ['google', 'github'], verify, save, confirm } = {}) {
  if (!supabaseUrl || !anonKey) throw new Error('Supabase 공개 설정(URL·anon 키)이 없습니다 — ~/.argo/cli.json 또는 환경변수를 확인하세요');
  const tx = TEXT[lang === 'en' ? 'en' : 'ko'];
  const nonce = randomBytes(16).toString('hex');
  const key = randomBytes(16).toString('hex'); // 터미널에만 출력되는 첫 주소의 비밀값 — nonce와 따로 둔다(nonce는 Supabase 리다이렉트 주소에 실린다)
  let settled = false; let confirming = false; let resolveDone;
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
    const send = (status, html, type = 'text/html; charset=utf-8') => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY', 'content-security-policy': "frame-ancestors 'none'" });
      res.end(html);
    };
    if (!isLoopback(req.headers.host)) return send(403, 'forbidden', 'text/plain');
    const u = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && u.pathname === '/') {
      if (u.searchParams.get('k') !== key) return send(403, page(tx.title, `<p>${esc(tx.needKey)}</p>`));
      return send(200, page(tx.title, `<p>${esc(tx.pick)}</p>${providers.map((p, i) => `<a class="b${i ? ' o' : ''}" href="${esc(authorizeUrl(p))}">${esc(p === 'github' ? 'GitHub' : p === 'google' ? 'Google' : p)}</a>`).join('')}`));
    }
    if (req.method === 'GET' && u.pathname === '/auth/paired') {
      if (u.searchParams.get('cli') !== nonce) return send(400, page(tx.title, `<p>${esc(tx.fail)}</p>`));
      // 조각(#access_token…)은 서버로 오지 않는다 — 페이지가 파싱해 승인 버튼을 누를 때만 보낸다(자동 전송 금지).
      return send(200, page(tx.title, `<p id="m">${esc(tx.confirm)}</p><button id="a" hidden>${esc(tx.approve)}</button>
<script>const h=new URLSearchParams(location.hash.slice(1));history.replaceState(null,'','/auth/paired?cli=${nonce}');
const at=h.get('access_token'),rt=h.get('refresh_token'),m=document.getElementById('m'),a=document.getElementById('a');
if(!at||!rt){m.textContent=${JSON.stringify(tx.noToken)};}else{a.hidden=false;a.onclick=async()=>{a.disabled=true;a.hidden=true;m.textContent=${JSON.stringify(tx.checkTerminal)};
const r=await fetch('/bind',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({cli:${JSON.stringify(nonce)},access_token:at,refresh_token:rt})}).then(r=>r.status).catch(()=>0);
m.textContent=r===200?${JSON.stringify(tx.done)}:r===409?${JSON.stringify(tx.declined)}:${JSON.stringify(tx.fail)};};}</script>`));
    }
    if (req.method === 'POST' && u.pathname === '/bind') {
      const fail = (status) => send(status, JSON.stringify({ ok: false }), 'application/json');
      if (!sameOriginBind(req.headers, base)) return fail(403);
      if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) return fail(415); // text/plain 같은 "단순 요청"은 사전 확인 없이 교차 출처로 온다
      let body = '';
      for await (const c of req) { body += c; if (body.length > 64_000) return send(413, 'too large', 'text/plain'); }
      let j = {}; try { j = JSON.parse(body); } catch { /* 아래에서 거절 */ }
      if (settled || j.cli !== nonce || !j.access_token || !j.refresh_token) return fail(400);
      if (confirming) return fail(429); // 터미널 확인이 하나 진행 중 — 두 번째 계정을 끼워 넣지 못한다
      let user;
      try { user = await verifyToken(j.access_token); } catch { return fail(401); }
      if (confirm) {
        confirming = true;
        let ok = false;
        try { ok = await confirm({ id: user.id, email: user.email ?? '' }); } catch { ok = false; } finally { confirming = false; }
        if (!ok) return fail(409); // 터미널에서 거절 — 저장하지 않고 계속 기다린다(브라우저에서 다시 시도할 수 있다)
      }
      if (settled) return fail(400);
      try {
        await saveSession({ access_token: j.access_token, refresh_token: j.refresh_token, expires_at: 0, user }); // 0 = 첫 사용 때 바로 회전
        settled = true;
        send(200, JSON.stringify({ ok: true }), 'application/json');
        resolveDone({ id: user.id, email: user.email ?? '' });
      } catch {
        fail(401);
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
  return { url: `${base}/?k=${key}`, port: server.address().port, authorizeUrl, done, close, _nonce: nonce, _key: key };
}
