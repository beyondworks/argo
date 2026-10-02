// 문서함 서버 함수(Vercel, 로컬은 vite.config.js가 같은 파일을 연결) — 글자 읽기(OCR)만. 파일 올리기·받기는 브라우저 ↔ Storage가 직접 한다.
// 요청자의 Supabase JWT로만 움직인다(서비스 키 없음): 파일은 그 사람 권한으로 Storage에서 받고, 결과도 그 사람 권한으로 office_file_write에 쓴다.
// env: OFFICE_OCR_URL(+OFFICE_OCR_KEY) 또는 OFFICE_VISION_API_KEY · VITE_SUPABASE_URL · VITE_SUPABASE_ANON_KEY
import { ocrBytes, ocrProvider, OCR_MAX } from '../../server/ocr.js';
import { clip } from '../../src/files/model.js';

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
/** 그 사람 권한으로 Storage 객체 받기(RLS office_files_read) */
async function download(jwt, path) {
  const r = await fetch(`${env.VITE_SUPABASE_URL}/storage/v1/object/authenticated/office-files/${path.split('/').map(encodeURIComponent).join('/')}`, { headers: { apikey: env.VITE_SUPABASE_ANON_KEY, authorization: `Bearer ${jwt}` } });
  if (!r.ok) throw fail(r.status === 404 || r.status === 400 ? 404 : 502, 'storage');
  const len = Number(r.headers.get('content-length') ?? 0);
  if (len > OCR_MAX) throw fail(413, 'too_big');
  return Buffer.from(await r.arrayBuffer());
}

const OPS = {
  async config() { return { ocr: ocrProvider(env) }; },
  /** { org, id } = 문서함 파일을 읽어 결과를 저장 / { data(base64), name, mime } = 저장하지 않고 글만(사업자등록증 폼 채우기 — 요청 한도 안, 약 3MB) */
  async ocr(jwt, { org = null, id, data, name = '', mime = '' } = {}) {
    if (!ocrProvider(env)) throw fail(503, 'not_configured');
    if (data != null) {
      if (typeof data !== 'string' || data.length > 4_200_000) throw fail(413, 'too_big');
      const text = await ocrBytes({ bytes: Buffer.from(data, 'base64'), mime, name }, env);
      return { status: 'done', text: text.slice(0, 100_000) };
    }
    if ((org !== null && !UUID.test(String(org))) || !UUID.test(String(id ?? ''))) throw fail(400, 'input');
    const f = await rpc(jwt, 'office_file_get', { p_org: org, p_id: id });
    if (f.kind !== 'file' || !f.storage_path) throw fail(415, 'unsupported');
    let status = 'done', text = '';
    try { text = await ocrBytes({ bytes: await download(jwt, f.storage_path), mime: f.mime, name: f.filename || f.title }, env); }
    catch (e) { if (e.code === 'unsupported') status = 'unsupported'; else if (e.code === 'storage' || e.code === 'not_configured') throw e; else status = 'failed'; }
    const { summary, full_text } = clip(text);
    await rpc(jwt, 'office_file_write', { p_org: org, p_action: 'file.ocr', p_data: { id, ocr_status: status, summary, full_text } });
    return { status, text: full_text };
  },
};

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
export async function GET(request) { return cors(request, opOf(request) === 'config' ? await handle(request, 'config') : json({ error: 'method' }, 405)); }
export async function POST(request) { return cors(request, await handle(request, opOf(request), await request.json().catch(() => ({})))); }
export async function OPTIONS(request) { return cors(request, new Response(null, { status: DESKTOP_ORIGINS.has(request.headers.get('origin')) ? 204 : 403 })); }
