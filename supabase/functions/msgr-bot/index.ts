// 아르고 메신저 봇 API — 외부 에이전트(헤르메스·오픈클로)가 봇 토큰으로 접속하는 플랫폼 주소(설계: 루트 MESSENGER-DESIGN.md 부록 N v3).
// 이 함수는 번역만 한다: HTTP ↔ msgr_bot_* RPC(anon 키 + 토큰). 권한·정책은 DB가 판정한다.
// 배포: `supabase functions deploy msgr-bot --no-verify-jwt` — 봇은 Supabase JWT가 없다(토큰이 자격). config.toml [functions.msgr-bot] verify_jwt = false.
import { handle, parseRequest, parseLinkPath, handleLink, connectScript } from './core.js';
import { CONNECT_PY } from './connect-bundle.js';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const ANON = Deno.env.get('SUPABASE_ANON_KEY')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''; // getFile 서명 URL 전용 — 경로는 RPC(msgr_bot_file)가 봇 권한을 판정한 뒤에만 나온다

async function sign(path: string, expiresIn: number): Promise<string | null> {
  if (!SERVICE) return null;
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/msgr/${path.split('/').map(encodeURIComponent).join('/')}`, {
    method: 'POST', headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ expiresIn }),
  });
  if (!r.ok) return null;
  const j = await r.json();
  return j?.signedURL ? `${SUPABASE_URL}/storage/v1${j.signedURL}` : null;
}

async function rpc(fn: string, args: Record<string, unknown>) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' }, body: JSON.stringify(args),
  });
  const j = r.status === 204 ? null : await r.json();
  if (!r.ok) throw new Error(j?.message ?? `rpc ${fn} ${r.status}`);
  return j;
}

Deno.serve(async (req) => {
  const path = new URL(req.url).pathname;
  // VPS 서버 연결: GET /connect = 서버에서 `curl … | python3 - <코드>`로 실행할 스크립트, POST /link/<method> = 그 스크립트의 보고·조회
  if (req.method === 'GET' && /\/connect\/?$/.test(path)) {
    return new Response(connectScript(CONNECT_PY, `${SUPABASE_URL.replace(/\/$/, '')}/functions/v1/msgr-bot`), { headers: { 'Content-Type': 'text/x-python; charset=utf-8', 'Cache-Control': 'no-store' } });
  }
  let body: unknown = null;
  if (req.method === 'POST') { try { body = await req.json(); } catch { body = null; } }
  const link = parseLinkPath(req.url);
  if (link) {
    const { status, body: out } = await handleLink(link, (body && typeof body === 'object' ? body : {}) as Record<string, unknown>, rpc);
    return new Response(JSON.stringify(out), { status, headers: { 'Content-Type': 'application/json' } });
  }
  const parsed = parseRequest(req.url, Object.fromEntries(req.headers), body);
  const { status, body: out } = await handle(parsed, rpc, { sign });
  return new Response(JSON.stringify(out), { status, headers: { 'Content-Type': 'application/json' } });
});
