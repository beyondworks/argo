// 메신저 링크 미리보기 — 사람이 보낸 글의 첫 링크 카드를 보낼 때 한 번 만들어 그 글 meta에 저장한다(2026-10-02).
// 배포: `supabase functions deploy msgr-link-preview` (JWT 검증 켬 — 기본값. 로그인한 앱만 부른다)
// 환경변수: SUPABASE_URL·SUPABASE_ANON_KEY(엣지 기본 제공). 서비스 키는 쓰지 않는다 — 글 읽기·저장 모두 부른 사람 권한(RLS·RPC 검사).
// 규칙·SSRF 검사는 ../_shared/link-preview.js(게이트웨이·앱과 같은 파일), 요청 처리는 ./core.js.
// 남은 위험(기록): Deno fetch는 연결할 때 이름을 다시 풀어 검사한 주소와 다른 주소로 붙을 수 있다(DNS 재바인딩).
//   이름 풀기 → 검사 → 요청 사이 간격이 짧고, 리다이렉트마다 다시 검사하며, 응답은 HTML 512KB만 읽어 카드 글자만 돌려준다.
//   본체 게이트웨이(Node)는 연결 시점 주소 검사(lookup 훅)로 이 틈이 없다.
import { CORS, handle, jwtSub, readLimited } from './core.js';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const ANON = Deno.env.get('SUPABASE_ANON_KEY')!;
const UA = 'Mozilla/5.0 (compatible; ArgoLinkPreview/1.0; +https://argo.ceo)';

async function resolve(host: string): Promise<string[]> {
  const out: string[] = [];
  for (const kind of ['A', 'AAAA'] as const) {
    try { out.push(...(await Deno.resolveDns(host, kind))); } catch { /* 그 종류 레코드 없음 */ }
  }
  return out;
}

async function request(url: string, { timeoutMs, maxBytes }: { timeoutMs: number; maxBytes: number }) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      redirect: 'manual', signal: ctl.signal,
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1', 'Accept-Language': 'ko,en;q=0.8' },
    });
    const headers = { 'content-type': r.headers.get('content-type') ?? '', location: r.headers.get('location') ?? '' };
    const html = /^(text\/html|application\/xhtml\+xml)\b/i.test(headers['content-type']);
    if (r.status !== 200 || !html) { await r.body?.cancel().catch(() => {}); return { status: r.status, headers, body: new Uint8Array() }; }
    return { status: r.status, headers, body: await readLimited(r.body, maxBytes) };
  } finally { clearTimeout(timer); }
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });
  const auth = req.headers.get('Authorization') ?? '';
  const rest = (path: string, init: RequestInit = {}) => fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init, headers: { apikey: ANON, Authorization: auth, 'Content-Type': 'application/json' },
  });
  let body: unknown = null;
  try { body = await req.json(); } catch { /* 빈 본문 → 400 */ }
  const out = await handle({ sub: jwtSub(auth), body }, {
    getMessage: async (id: number) => {
      const r = await rest(`msgr_messages?id=eq.${id}&select=id,author_kind,author_user_id,body,created_at,deleted_at,meta`);
      if (!r.ok) return null;
      const rows = await r.json();
      return Array.isArray(rows) ? rows[0] ?? null : null;
    },
    setPreview: async (id: number, preview: unknown) => {
      const r = await rest('rpc/msgr_set_link_preview', { method: 'POST', body: JSON.stringify({ p_message: id, p_preview: preview }) });
      return r.ok && (await r.json()) === true;
    },
    net: { resolve, request },
  });
  return json(out.status, out.body);
});
