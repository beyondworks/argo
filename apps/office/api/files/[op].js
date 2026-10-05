// 문서함 서버 함수(Vercel, 로컬은 vite.config.js가 같은 파일을 연결) — 글자 읽기(OCR)와 정리 크론. 파일 올리기·받기는 브라우저 ↔ R2가 직접 한다(api/storage).
// OCR은 요청자의 Supabase JWT로 판정한다: office_file_get(그 사람 권한)이 돌려준 키만 R2에서 받고(접근 키), 결과도 그 사람 권한으로 office_file_write에 쓴다.
// OCR 전에 반드시 ① Supabase로 로그인을 확인하고(가짜 토큰은 401) ② 사람마다 시간당 한도(office_ocr_take, 60회)를 센다(넘으면 429) — 두 경로(바이트·문서함 파일) 모두.
// env: OFFICE_OCR_URL + OFFICE_OCR_KEY(PaddleOCR 사이드카 — server/ocr.js 규칙) · VITE_SUPABASE_URL · VITE_SUPABASE_ANON_KEY
//      정리(sweep): OFFICE_SUPABASE_SERVICE_KEY · CRON_SECRET(Vercel 크론이 Authorization: Bearer로 보낸다) · R2_*(server/r2.js r2FromEnv)
// 공유 링크(15차, 로그인 없음 — 주소는 /f#<토큰>, 조각이라 공개 화면을 열 때도 서버로 가지 않는다): link = 이름·크기 보기, link-get = 5분짜리 내려받기 서명 주소. 서명 페이지(api/esign)와 같은 규칙 —
//   토큰은 본문(POST)으로만 받아 접근 기록에 남지 않고, 형식이 틀리면 DB에 묻지 않으며, DB에는 토큰의 SHA-256만 묻는다(office_file_link_open, service_role).
//   열 수 없는 이유(만료·끊김·지운 파일·없는 토큰)는 밖에 가르지 않고 모두 404 gone. 서명은 DB가 돌려준 키 하나로만 — 링크로는 그 파일 하나만 열린다.
//   요청 제한: 서명 페이지와 같이 따로 두지 않는다(토큰 256비트 — 맞혀 볼 수 없다. 공개 열기는 DB 쓰기 0).
import { ocrBytes, ocrProvider, OCR_MAX } from '../../server/ocr.js';
import { clip } from '../../src/files/model.js';
import { sweepStorage } from '../../server/sweep.js';
import { r2FromEnv } from '../../server/r2.js';
import { timingSafeEqual, createHash } from 'node:crypto';

const env = process.env;
const fail = (status, code) => Object.assign(new Error(code), { status, code });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const UUID = /^[0-9a-f-]{36}$/i;

async function rpc(jwt, fn, args) {
  const r = await fetch(`${env.VITE_SUPABASE_URL}/rest/v1/rpc/${fn}`, { method: 'POST', headers: { apikey: env.VITE_SUPABASE_ANON_KEY, authorization: `Bearer ${jwt}`, 'content-type': 'application/json' }, body: JSON.stringify(args) });
  if (r.status === 401) throw fail(401, 'signed_out');
  if (!r.ok) { const t = await r.text(); throw fail(/file_not_found/.test(t) ? 404 : /file_forbidden|42501/.test(t) ? 403 : 502, 'db'); }
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}
/** 로그인 확인(다른 오피스 서버 함수와 같은 방식 — api/mail·api/drive의 me) */
async function me(jwt) {
  const r = await fetch(`${env.VITE_SUPABASE_URL}/auth/v1/user`, { headers: { apikey: env.VITE_SUPABASE_ANON_KEY, authorization: `Bearer ${jwt}` } });
  if (!r.ok) throw fail(401, 'signed_out');
  const id = (await r.json().catch(() => null))?.id;
  if (!id) throw fail(401, 'signed_out');
  return id;
}
/** OCR 한 번 쓰기 전 — 로그인 확인 후 사람마다 시간당 한도를 센다 */
async function gate(jwt) {
  await me(jwt);
  if (await rpc(jwt, 'office_ocr_take', {}) !== true) throw fail(429, 'rate_limited');
}
/** R2에서 객체 받기 — 키는 office_file_get(사용자 JWT)이 돌려준 값만. 크기를 먼저 봐서 큰 파일은 받지 않는다 */
async function download(key) {
  const store = r2FromEnv(env);
  const h = await store.head(key).catch(() => { throw fail(502, 'storage'); });
  if (!h) throw fail(404, 'storage');
  if (h.bytes > OCR_MAX) throw fail(413, 'too_big');
  return Buffer.from(await store.get(key).catch((e) => { throw fail(e.status === 404 ? 404 : 502, 'storage'); }));
}

const OPS = {
  async config() { return { ocr: ocrProvider(env) }; },
  /** { org, id } = 문서함 파일을 읽어 결과를 저장 / { data(base64), name, mime } = 저장하지 않고 글만(사업자등록증 폼 채우기 — 요청 한도 안, 약 3MB) */
  async ocr(jwt, { org = null, id, data, name = '', mime = '' } = {}) {
    if (!ocrProvider(env)) throw fail(503, 'not_configured');
    if (data != null) {
      if (typeof data !== 'string' || data.length > 4_200_000) throw fail(413, 'too_big');
      await gate(jwt);
      const text = await ocrBytes({ bytes: Buffer.from(data, 'base64'), mime, name }, env);
      return { status: 'done', text: text.slice(0, 100_000) };
    }
    if ((org !== null && !UUID.test(String(org))) || !UUID.test(String(id ?? ''))) throw fail(400, 'input');
    await gate(jwt);
    const f = await rpc(jwt, 'office_file_get', { p_org: org, p_id: id });
    if (f.kind !== 'file' || !f.storage_path) throw fail(415, 'unsupported');
    let status = 'done', text = '';
    try { text = await ocrBytes({ bytes: await download(f.storage_path), mime: f.mime, name: f.filename || f.title }, env); }
    catch (e) { if (e.code === 'unsupported') status = 'unsupported'; else if (['storage', 'not_configured', 'r2_not_configured', 'too_big'].includes(e.code)) throw e; else status = 'failed'; }
    const { summary, full_text } = clip(text);
    await rpc(jwt, 'office_file_write', { p_org: org, p_action: 'file.ocr', p_data: { id, ocr_status: status, summary, full_text } });
    return { status, text: full_text };
  },
};

/* ── 공유 링크(로그인 없음) ── */
const LINK_TOKEN = /^[A-Za-z0-9_-]{40,64}$/; // src/files/links.js newLinkToken과 같은 모양
const LINK_TTL = 300; // 내려받기 서명 주소 5분
async function linkRow(token) {
  if (typeof token !== 'string' || !LINK_TOKEN.test(token)) throw fail(404, 'gone'); // 형식이 틀린 토큰은 DB에 묻지 않는다
  if (!env.VITE_SUPABASE_URL || !env.OFFICE_SUPABASE_SERVICE_KEY) throw fail(503, 'not_configured');
  const key = env.OFFICE_SUPABASE_SERVICE_KEY;
  const r = await fetch(`${env.VITE_SUPABASE_URL}/rest/v1/rpc/office_file_link_open`, { method: 'POST', headers: { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ p_hash: createHash('sha256').update(token).digest('hex') }) });
  if (!r.ok) throw fail(502, 'db');
  const t = await r.text();
  const row = t ? JSON.parse(t) : null;
  if (!row?.key) throw fail(404, 'gone');
  return row;
}
const PUBLIC = {
  /** 링크 화면 — 파일 이름·크기·형식·만료(R2 키는 돌려주지 않는다) */
  async link({ token } = {}) { const row = await linkRow(token); return { name: row.name, size: Number(row.size) || 0, mime: row.mime || '', expiresAt: row.expires_at, org: row.org ?? null }; },
  /** 내려받기 — 누를 때마다 토큰을 다시 확인하고 5분짜리 서명 주소(내려받기, 원래 이름) */
  async 'link-get'({ token } = {}) {
    const row = await linkRow(token);
    const p = await r2FromEnv(env).presign({ method: 'GET', key: row.key, expires: LINK_TTL, attachment: true, filename: row.name });
    return { url: p.url, expiresIn: p.expiresIn };
  },
};
async function publicHandle(op, args) {
  try { return json(await PUBLIC[op](args ?? {})); } catch (e) {
    if (!e.status) console.error('[office files] link', op, e?.code ?? e?.message);
    return json({ error: e.code ?? 'server' }, e.status ?? 500); // DB·저장소 원문은 밖에 보내지 않는다
  }
}

/** 서버 정리(Vercel 크론 — Authorization: Bearer <CRON_SECRET>). 사람 계정으로는 부를 수 없다 */
async function sweep(request) {
  try {
    const secret = env.CRON_SECRET ?? '';
    if (secret.length < 16 || !env.OFFICE_SUPABASE_SERVICE_KEY || !env.VITE_SUPABASE_URL) throw fail(503, 'not_configured');
    const got = Buffer.from(/^Bearer (.+)$/.exec(request.headers.get('authorization') ?? '')?.[1] ?? ''), want = Buffer.from(secret);
    if (got.length !== want.length || !timingSafeEqual(got, want)) throw fail(401, 'unauthorized');
    const out = await sweepStorage({ url: env.VITE_SUPABASE_URL, key: env.OFFICE_SUPABASE_SERVICE_KEY, r2: r2FromEnv(env) });
    console.log('[office files] sweep', out.objects, 'objects', out.left, 'left', out.rows, 'rows', out.links, 'links'); // 개수만
    return json(out);
  } catch (e) {
    if (!e.status) console.error('[office files] sweep', e?.code ?? e?.message);
    return json({ error: e.code ?? 'server' }, e.status ?? 500);
  }
}

async function handle(request, op, args) {
  try {
    if (!Object.hasOwn(OPS, op)) throw fail(404, 'op');
    if (op === 'config') return json(await OPS.config());
    const jwt = /^Bearer (.+)$/.exec(request.headers.get('authorization') ?? '')?.[1];
    if (!jwt) throw fail(401, 'signed_out');
    return json(await OPS[op](jwt, args));
  } catch (e) {
    if (!e.status) console.error('[office files]', op, e?.message);
    return json({ error: e.code ?? 'server' }, e.status ?? 500); // OCR 서버·DB 원문은 화면에 보내지 않는다
  }
}
const opOf = (request) => new URL(request.url).pathname.split('/').pop();
const DESKTOP_ORIGINS = new Set(['tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost']);
function cors(request, response) {
  const source = request.headers.get('origin');
  response.headers.set('vary', 'Origin');
  if (DESKTOP_ORIGINS.has(source)) {
    response.headers.set('access-control-allow-origin', source);
    response.headers.set('access-control-allow-methods', 'GET, POST, OPTIONS');
    response.headers.set('access-control-allow-headers', 'Authorization, Content-Type');
  }
  return response;
}
export async function GET(request) {
  const op = opOf(request);
  if (op === 'sweep') return sweep(request); // 크론 전용 — 화면에서 부르지 않으므로 CORS를 붙이지 않는다
  return cors(request, op === 'config' ? await handle(request, 'config') : json({ error: 'method' }, 405));
}
export async function POST(request) {
  const op = opOf(request), body = await request.json().catch(() => ({}));
  if (Object.hasOwn(PUBLIC, op)) return cors(request, await publicHandle(op, body)); // 공유 링크 — 로그인 없이(토큰이 권한)
  return cors(request, await handle(request, op, body));
}
export async function OPTIONS(request) { return cors(request, new Response(null, { status: DESKTOP_ORIGINS.has(request.headers.get('origin')) ? 204 : 403 })); }
