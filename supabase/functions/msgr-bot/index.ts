// 아르고 메신저 봇 API — v2 VPS 서버 연결판(2026-10-23). 갈래는 v2.js routeOf 하나가 정한다:
//   GET /connect            → VPS 연결 스크립트(connect-bundle.js, 원본 integrations/server-connect/connect.py)
//   POST /link/<method>     → 그 스크립트의 보고·조회·완료(core.js handleLink + msgr2_server_link_* RPC)
//   /bot<argo_bot_v2…>/<m>  → v2 봇(v2.js handleV2 + msgr2_bot_* RPC)
//   그 밖(옛 v1 토큰 등)      → 일시 중단 응답(paused.js) — DB·외부 호출 없음. 옛 연결 도구가 다시 폴링하지 않게(2026-10-16 중단판 그대로).
// RPC는 anon 키로 부른다(토큰·연결 코드가 자격 — v1과 같은 방식). 권한·정책은 DB가 판정한다. 비밀값: SUPABASE_URL·SUPABASE_ANON_KEY(엣지 기본값).
// 롱폴 깨움(2026-10-25): 같은 anon 키로 Realtime 비공개 채널 'botw:…'(토큰에서 계산, wake.js)만 듣는다 — 받기 정책 msgr2_bot_wake_recv(20261025100000).
// 배포(맥 one): `supabase functions deploy msgr-bot --no-verify-jwt` — 봇·스크립트는 Supabase JWT가 없다.
import { parseRequest, handleLink, parseLinkPath, connectScript, createRejectMemory } from './core.js';
import { CONNECT_PY } from './connect-bundle.js';
import { routeOf, handleV2, linkRpcV2, pausedReply } from './v2.js';
import { pausedHoldMs } from './paused.js';
import { createWakeHub, wakeTopic } from './wake.js';
import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const ANON = Deno.env.get('SUPABASE_ANON_KEY')!;
const rejects = createRejectMemory(); // 무효 토큰 거부 기억 — 이 인스턴스 메모리(core.js 주석). DB에 쓰지 않는다
// 인스턴스 하나에 Realtime 연결 하나(채널은 롱폴마다 토픽별로 나눠 쓴다). 들어가기에 실패하면 처리기가 5초 폴링으로 돌아간다
const realtime = createClient(SUPABASE_URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
const listen = createWakeHub(realtime);

async function rpc(fn: string, args: Record<string, unknown>) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' }, body: JSON.stringify(args),
  });
  const j = r.status === 204 ? null : await r.json();
  if (!r.ok) throw new Error(j?.message ?? `rpc ${fn} ${r.status}`);
  return j;
}

const json = (status: number, body: unknown) => {
  const retry = (body as { parameters?: { retry_after?: number } })?.parameters?.retry_after;
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...(retry ? { 'Retry-After': String(retry) } : {}) } });
};

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const path = url.pathname;
  const peek = parseRequest(req.url, Object.fromEntries(req.headers), null); // 토큰만 본다(본문은 v2일 때만 읽는다)
  const route = routeOf({ method: req.method, path, token: peek.token });
  if (route === 'paused') {
    const userAgent = req.headers.get('user-agent') ?? '';
    const hold = pausedHoldMs({ path, userAgent, timeout: url.searchParams.get('timeout') }); // 옛 연결 도구가 retry_after를 따르지 않아 — 끊기 전까지 붙잡는다(DB 호출 없음)
    if (hold > 0) await new Promise((r) => setTimeout(r, hold));
    const r = pausedReply({ method: req.method, path, userAgent });
    return new Response(r.body, { status: r.status, headers: r.headers });
  }
  if (route === 'connect') {
    return new Response(connectScript(CONNECT_PY, `${SUPABASE_URL.replace(/\/$/, '')}/functions/v1/msgr-bot`), { headers: { 'Content-Type': 'text/x-python; charset=utf-8', 'Cache-Control': 'no-store' } });
  }
  let body: unknown = null;
  if (req.method === 'POST') { try { body = await req.json(); } catch { body = null; } }
  if (route === 'link') {
    const { status, body: out } = await handleLink(parseLinkPath(req.url) ?? '', (body && typeof body === 'object' ? body : {}) as Record<string, unknown>, linkRpcV2(rpc));
    return json(status, out);
  }
  const { status, body: out } = await handleV2(parseRequest(req.url, Object.fromEntries(req.headers), body), rpc, { rejects, listen, topicOf: wakeTopic });
  return json(status, out);
});
