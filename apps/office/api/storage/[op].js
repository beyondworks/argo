// 파일 저장소 서버 함수(Vercel, 로컬은 vite.config.js가 같은 파일을 연결) — R2 서명 주소만 만든다. 파일 바이트는 이 함수를 지나지 않는다(브라우저 ↔ R2 직접).
// 핵심 규칙(설계안 3장, 총괄 승인 10/2): **DB 함수가 허락한 키만 서명한다** — 요청 본문의 키는 DB에 묻는 데만 쓰고, 서명은 DB가 돌려준 키·크기·형식으로 한다.
//   upload-url {key}   → r2_object_pending_mine(사용자 JWT) → PUT 서명 주소(5분, 형식·크기·if-none-match: * 서명)
//   commit {key}       → 같은 판정 → R2 HEAD 크기 = 자리 크기면 r2_object_commit(서비스 키), 다르면 R2 삭제 + r2_object_fail → 409 file_size_mismatch
//   read-url {keys}    → r2_object_read_grant(사용자 JWT, 최대 50) → 허락된 키만 GET 서명 주소(10분)
//   flush {keys}       → 로그인 확인 → r2_object_deleting(서비스 키 — DB가 이미 지우기로 정한 키만) → R2 삭제 → r2_object_forget
// 서비스 키로 하는 일은 상태 바꾸기(commit·fail·forget)와 deleting 조회뿐 — 권한 판정은 그 전에 사용자 JWT 함수가 한다.
// env: VITE_SUPABASE_URL · VITE_SUPABASE_ANON_KEY · OFFICE_SUPABASE_SERVICE_KEY · R2_ENDPOINT · R2_OFFICE_BUCKET · R2_OFFICE_ACCESS_KEY_ID · R2_OFFICE_SECRET_ACCESS_KEY
//      R2_OFFICE_UPLOADS_OFF=1 이면 올리기 서명을 멈춘다(503 — 긴급 차단, 열기·지우기는 그대로). R2 변수가 없으면 503 r2_not_configured(Preview 배포는 일부러 비워 둔다).
// 부하: 올리기 1건 = 이 함수 2회(upload-url·commit), 열기 = 화면 한 번에 여러 키 1회(화면이 주소를 만료 1분 전까지 다시 쓴다). 폴링 없음. 서명 주소·키는 로그에 남기지 않는다.
import { r2FromEnv, eachLimited } from '../../server/r2.js';

const env = process.env;
const fail = (status, code) => Object.assign(new Error(code), { status, code });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const MAX_KEYS = 50;
/** 화면이 미리보기하는 형식만 그대로 연다. 나머지(html·svg·문서 등)는 내려받기로 서명한다(검수 9) — 화면은 fetch로 바이트를 받으므로 미리보기에 영향 없다 */
const INLINE = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/heic', 'image/bmp', 'text/plain']);
const codeOf = (t) => /file_[a-z_]+/.exec(t)?.[0];
const STATUS = { file_forbidden: 403, file_input: 400, file_missing: 409, file_size_mismatch: 409, file_conflict: 409, file_quota: 507, file_too_big: 413, file_daily_limit: 429 };

function supa() { if (!env.VITE_SUPABASE_URL || !env.VITE_SUPABASE_ANON_KEY) throw fail(503, 'not_configured'); return env.VITE_SUPABASE_URL.replace(/\/+$/, ''); }
/** 사용자 JWT로 RPC — 사람 권한 그대로(DB 함수가 판정) */
async function rpc(jwt, fn, args) {
  const r = await fetch(`${supa()}/rest/v1/rpc/${fn}`, { method: 'POST', headers: { apikey: env.VITE_SUPABASE_ANON_KEY, authorization: `Bearer ${jwt}`, 'content-type': 'application/json' }, body: JSON.stringify(args) });
  const t = await r.text();
  if (r.status === 401) throw fail(401, 'signed_out');
  if (!r.ok) { const c = codeOf(t); throw fail(STATUS[c] ?? (/42501/.test(t) ? 403 : 502), c ?? 'db'); }
  return t ? JSON.parse(t) : null;
}
/** 서비스 키로 RPC — 상태 바꾸기·deleting 조회만 */
async function svc(fn, args) {
  if (!env.OFFICE_SUPABASE_SERVICE_KEY) throw fail(503, 'not_configured');
  const key = env.OFFICE_SUPABASE_SERVICE_KEY;
  const r = await fetch(`${supa()}/rest/v1/rpc/${fn}`, { method: 'POST', headers: { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(args) });
  const t = await r.text();
  if (!r.ok) { const c = codeOf(t); throw fail(STATUS[c] ?? 502, c ?? 'db'); }
  return t ? JSON.parse(t) : null;
}
async function me(jwt) {
  const r = await fetch(`${supa()}/auth/v1/user`, { headers: { apikey: env.VITE_SUPABASE_ANON_KEY, authorization: `Bearer ${jwt}` } });
  if (!r.ok) throw fail(401, 'signed_out');
  const id = (await r.json().catch(() => null))?.id;
  if (!id) throw fail(401, 'signed_out');
  return id;
}
const oneKey = (key) => { if (typeof key !== 'string' || !key || key.length > 600) throw fail(400, 'input'); return key; };
const manyKeys = (keys) => {
  if (!Array.isArray(keys) || !keys.length || keys.length > MAX_KEYS || keys.some((k) => typeof k !== 'string' || !k || k.length > 600)) throw fail(400, 'input');
  return [...new Set(keys)];
};

const OPS = {
  async 'upload-url'(jwt, { key }) {
    const r2 = r2FromEnv(env);
    if (env.R2_OFFICE_UPLOADS_OFF === '1') throw fail(503, 'uploads_paused');
    const row = await rpc(jwt, 'r2_object_pending_mine', { p_key: oneKey(key) });
    if (!row || row.state !== 'pending') throw fail(409, 'file_missing');
    if (row.expired) throw fail(409, 'file_expired'); // 만료된 자리(유예 중)에는 새 주소를 주지 않는다 — 진행 중인 느린 PUT의 확인만 받는다
    const p = await r2.presign({ method: 'PUT', key: row.key, contentType: row.mime || 'application/octet-stream', contentLength: Number(row.bytes) });
    return { key: row.key, url: p.url, headers: p.headers, expiresIn: p.expiresIn };
  },
  async commit(jwt, { key }) {
    const r2 = r2FromEnv(env);
    const row = await rpc(jwt, 'r2_object_pending_mine', { p_key: oneKey(key) });
    if (!row) throw fail(409, 'file_missing');
    if (row.state === 'uploaded') return { key: row.key, bytes: Number(row.bytes) }; // 다시 부르기 — 이미 확인됨(쓰기 없음)
    const h = await r2.head(row.key);
    if (!h) throw fail(409, 'file_missing'); // 아직 안 올라옴 — 자리는 만료까지 남아 다시 PUT할 수 있다
    if (h.bytes !== Number(row.bytes)) { // 서명된 크기를 R2가 강제하지만(실측 10/2) 최종 판정은 여기서 — 다르면 지우고 자리도 없앤다
      await r2.del(row.key);
      await svc('r2_object_fail', { p_keys: [row.key] });
      throw fail(409, 'file_size_mismatch');
    }
    const out = await svc('r2_object_commit', { p_key: row.key, p_bytes: h.bytes, p_etag: h.etag });
    return { key: row.key, bytes: Number(out?.bytes ?? h.bytes) };
  },
  async 'read-url'(jwt, { keys }) {
    const r2 = r2FromEnv(env);
    const asked = manyKeys(keys);
    const granted = new Map((await rpc(jwt, 'r2_object_read_grant', { p_keys: asked }) ?? []).map((g) => [g.key, g.mime]));
    const urls = {};
    for (const k of asked) if (granted.has(k)) urls[k] = (await r2.presign({ method: 'GET', key: k, attachment: !INLINE.has(granted.get(k)) })).url; // 요청에 섞인 남의 키는 빠진다
    return { urls, expiresIn: 600 };
  },
  async flush(jwt, { keys }) {
    const r2 = r2FromEnv(env);
    await me(jwt);
    const doomed = await svc('r2_object_deleting', { p_keys: manyKeys(keys) }) ?? [];
    const done = await eachLimited(doomed, 8, (k) => r2.del(k));
    const gone = doomed.filter((k) => done.get(k));
    if (gone.length) await svc('r2_object_forget', { p_keys: gone });
    return { deleted: gone.length, left: doomed.length - gone.length }; // 못 지운 키는 행이 남아 정리 크론이 다시 지운다
  },
};

async function handle(request, op, args) {
  try {
    if (!Object.hasOwn(OPS, op)) throw fail(404, 'op');
    const jwt = /^Bearer (.+)$/.exec(request.headers.get('authorization') ?? '')?.[1];
    if (!jwt) throw fail(401, 'signed_out');
    return json(await OPS[op](jwt, args ?? {}));
  } catch (e) {
    if (!e.status) console.error('[office storage]', op, e?.code ?? e?.message);
    return json({ error: e.code ?? 'server' }, e.status ?? 500); // DB·R2 원문은 화면에 보내지 않는다
  }
}
const opOf = (request) => new URL(request.url).pathname.split('/').pop();
const DESKTOP_ORIGINS = new Set(['tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost']);
function cors(request, response) {
  const source = request.headers.get('origin');
  response.headers.set('vary', 'Origin');
  if (DESKTOP_ORIGINS.has(source)) {
    response.headers.set('access-control-allow-origin', source);
    response.headers.set('access-control-allow-methods', 'POST, OPTIONS');
    response.headers.set('access-control-allow-headers', 'Authorization, Content-Type');
  }
  return response;
}
export async function GET(request) { return cors(request, json({ error: 'method' }, 405)); }
export async function POST(request) { return cors(request, await handle(request, opOf(request), await request.json().catch(() => ({})))); }
export async function OPTIONS(request) { return cors(request, new Response(null, { status: DESKTOP_ORIGINS.has(request.headers.get('origin')) ? 204 : 403 })); }
