// 구글 드라이브 서버 함수(Vercel, 로컬은 vite.config.js가 같은 파일을 연결) — 판정은 요청자의 Supabase JWT로 한다.
// 문서함 파일 바이트는 R2: 가져오기는 그 사람 권한으로 자리(file.reserve — 키는 DB가 정함)를 받은 뒤 서버가 R2에 직접 올리고,
// 서버가 보낸 바이트라 크기를 알므로 HEAD 없이 서비스 키 r2_object_commit으로 확인 기록한다(서비스 키로 하는 일은 이것과 실패 정리뿐).
// 연결은 메일과 같은 방식(OAuth 코드 + PKCE, 갱신 토큰을 OFFICE_MAIL_KEY로 봉인해 office_drive_secrets에). 기본은 읽기 전용(drive.readonly),
// '드라이브로 보내기'·'새 폴더'를 처음 쓸 때만 drive.file(이 앱이 만든 파일만)을 더 받는다.
// env: OFFICE_GOOGLE_CLIENT_ID · OFFICE_GOOGLE_CLIENT_SECRET · OFFICE_MAIL_KEY · OFFICE_ORIGIN · VITE_SUPABASE_URL · VITE_SUPABASE_ANON_KEY
//      OFFICE_SUPABASE_SERVICE_KEY(확인 기록) · R2_ENDPOINT · R2_OFFICE_BUCKET · R2_OFFICE_ACCESS_KEY_ID · R2_OFFICE_SECRET_ACCESS_KEY
// 부하: 목록은 사람이 열거나 폴더를 바꿀 때 Drive 호출 1회(DB 0), 접근 토큰 갱신은 최대 시간당 1회 쓰기, 가져오기는 파일당 R2 PUT 1 + DB 쓰기 3(자리·확인·등록).
import { mailKey, seal, unseal, sealState, openState } from '../../server/seal.js';
import { listRequest, mapFile, mapDrive, exportFormat, exportName, importable, isGoogleNative, validId, scopesFor, hasScope, READ_SCOPE, WRITE_SCOPE, multipartBody, FOLDER_MIME } from '../../server/drive.js';
import { classify, safeName, MAX_BYTES } from '../../src/files/model.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { r2FromEnv } from '../../server/r2.js';

const env = process.env;
const over = (name, def) => (env.VERCEL_ENV !== 'production' && env[name]) || def; // 가짜 구글 서버로 흐름 전체를 시험할 때만
const G = {
  auth: () => over('OFFICE_GOOGLE_AUTH_URL', 'https://accounts.google.com/o/oauth2/v2/auth'),
  token: () => over('OFFICE_GOOGLE_TOKEN_URL', 'https://oauth2.googleapis.com/token'),
  revoke: () => over('OFFICE_GOOGLE_REVOKE_URL', 'https://oauth2.googleapis.com/revoke'),
  api: () => over('OFFICE_DRIVE_API', 'https://www.googleapis.com/drive/v3'),
  upload: () => over('OFFICE_DRIVE_UPLOAD', 'https://www.googleapis.com/upload/drive/v3'),
};
const origin = () => env.OFFICE_ORIGIN || 'http://localhost:5190';
const redirectUri = () => `${origin()}/me/files/connect`;
const fail = (status, code) => Object.assign(new Error(code), { status, code });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const UUID = /^[0-9a-f-]{36}$/i;
const supa = () => env.VITE_SUPABASE_URL, anon = () => env.VITE_SUPABASE_ANON_KEY;

async function rpc(jwt, fn, args) {
  const r = await fetch(`${supa()}/rest/v1/rpc/${fn}`, { method: 'POST', headers: { apikey: anon(), authorization: `Bearer ${jwt}`, 'content-type': 'application/json' }, body: JSON.stringify(args) });
  if (r.status === 401) throw fail(401, 'signed_out');
  if (!r.ok) { const t = await r.text(); throw fail(/file_forbidden|42501/.test(t) ? 403 : /file_quota/.test(t) ? 507 : /file_too_big/.test(t) ? 413 : /file_limit/.test(t) ? 409 : 502, /file_quota/.test(t) ? 'quota' : /file_too_big/.test(t) ? 'too_big' : /file_limit/.test(t) ? 'limit' : 'db'); }
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}
/** 서비스 키로 상태만 바꾸기(r2_object_commit·r2_object_abandon·r2_object_forget) — 판정은 그 전에 사용자 JWT 자리 받기가 했다 */
async function svc(fn, args) {
  const key = env.OFFICE_SUPABASE_SERVICE_KEY;
  if (!key) throw fail(503, 'not_configured');
  const r = await fetch(`${supa()}/rest/v1/rpc/${fn}`, { method: 'POST', headers: { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(args) });
  if (!r.ok) throw fail(502, 'db');
  return r.json().catch(() => null);
}
async function me(jwt) {
  const r = await fetch(`${supa()}/auth/v1/user`, { headers: { apikey: anon(), authorization: `Bearer ${jwt}` } });
  if (!r.ok) throw fail(401, 'signed_out');
  return (await r.json()).id;
}
function client() {
  if (!env.OFFICE_GOOGLE_CLIENT_ID || !env.OFFICE_GOOGLE_CLIENT_SECRET) throw fail(503, 'not_configured');
  return { client_id: env.OFFICE_GOOGLE_CLIENT_ID, client_secret: env.OFFICE_GOOGLE_CLIENT_SECRET };
}
async function tokenCall(params) {
  const r = await fetch(G.token(), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...client(), ...params }) });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw fail(body.error === 'invalid_grant' ? 401 : 502, body.error === 'invalid_grant' ? 'expired' : 'google');
  return body;
}
const claims = (idToken) => JSON.parse(Buffer.from(String(idToken).split('.')[1] ?? '', 'base64url').toString() || '{}');
const aadOf = (row) => `${row.user_id}:drive:${row.address}`;

/** 접근 토큰 — 남은 시간이 1분 넘으면 저장해 둔 것, 아니면 갱신(바뀔 때만 쓴다). need: 꼭 있어야 하는 권한 */
async function access(jwt, need = READ_SCOPE) {
  const [row] = (await rpc(jwt, 'office_drive_secret', {})) ?? [];
  if (!row) throw fail(404, 'not_connected');
  if (!hasScope(row.scopes, need)) throw fail(403, need === WRITE_SCOPE ? 'need_write' : 'scopes');
  const key = mailKey(), aad = aadOf(row);
  if (row.access_sealed && Date.parse(row.access_expires) - Date.now() > 60_000) { const t = unseal(key, row.access_sealed, aad); if (t) return t; }
  const refresh = unseal(key, row.sealed, aad);
  if (!refresh) throw fail(401, 'expired');
  let tok;
  try { tok = await tokenCall({ grant_type: 'refresh_token', refresh_token: refresh }); } catch (e) {
    if (e.code === 'expired') await rpc(jwt, 'office_drive_mark', { p_status: 'expired' }); // 화면이 '다시 연결'을 띄운다(인트라넷 needsReconnect와 같은 자리)
    throw e;
  }
  await rpc(jwt, 'office_drive_token_put', { p_access_sealed: seal(key, tok.access_token, aad), p_expires: new Date(Date.now() + (tok.expires_in ?? 3600) * 1000).toISOString(), p_sealed: tok.refresh_token ? seal(key, tok.refresh_token, aad) : null });
  if (row.status !== 'ok') await rpc(jwt, 'office_drive_mark', { p_status: 'ok' });
  return tok.access_token;
}
async function drive(token, path, { params, raw = false, ...init } = {}, base = G.api()) {
  const r = await fetch(`${base}${path}${params ? `?${new URLSearchParams(params)}` : ''}`, { ...init, headers: { authorization: `Bearer ${token}`, ...init.headers } });
  if (r.status === 401) throw fail(401, 'expired');
  if (r.status === 403) { const t = await r.text(); throw fail(403, /insufficient/i.test(t) ? 'scopes' : 'forbidden'); }
  if (r.status === 404) throw fail(404, 'missing');
  if (!r.ok) throw fail(r.status === 429 || r.status >= 500 ? 502 : 400, 'google');
  return raw ? r : r.json();
}

const OPS = {
  async config() { return { google: env.OFFICE_GOOGLE_CLIENT_ID ? { scopes: scopesFor(true) } : null }; },

  /** 연결 상태 — 계정 주소·만료·보내기 권한 */
  async status(jwt) {
    const r = await fetch(`${supa()}/rest/v1/office_drive_accounts?select=address,scopes,status`, { headers: { apikey: anon(), authorization: `Bearer ${jwt}` } });
    if (!r.ok) throw fail(r.status === 401 ? 401 : 502, r.status === 401 ? 'signed_out' : 'db');
    const [a] = await r.json();
    return a ? { connected: true, address: a.address, expired: a.status === 'expired', write: hasScope(a.scopes, WRITE_SCOPE) } : { connected: false };
  },

  async start(jwt, { write = false, hint } = {}) {
    const { client_id } = client();
    const uid = await me(jwt), verifier = randomBytes(32).toString('base64url');
    const q = new URLSearchParams({
      client_id, redirect_uri: redirectUri(), response_type: 'code', scope: ['openid', 'email', 'profile', ...scopesFor(write === true)].join(' '),
      access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true',
      state: sealState(mailKey(), { uid, v: verifier, kind: 'drive', write: write === true }), code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
    });
    if (hint) q.set('login_hint', String(hint));
    return { url: `${G.auth()}?${q}` };
  },

  async finish(jwt, { code, state }) {
    const st = openState(mailKey(), state);
    if (!st || st.kind !== 'drive' || !code || await me(jwt) !== st.uid) throw fail(400, 'state');
    const tok = await tokenCall({ grant_type: 'authorization_code', code, redirect_uri: redirectUri(), code_verifier: st.v });
    const need = scopesFor(st.write);
    if (need.some((s) => !hasScope(tok.scope, s))) { // 동의 화면에서 권한을 끈 경우 — 받은 토큰은 돌려준다
      await fetch(G.revoke(), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: tok.refresh_token || tok.access_token }) }).catch(() => {});
      throw fail(400, 'scopes');
    }
    if (!tok.refresh_token) throw fail(400, 'no_refresh');
    const c = claims(tok.id_token);
    if (!c.email || c.email_verified === false || c.aud !== client().client_id) throw fail(400, 'no_email');
    const address = c.email.toLowerCase(), key = mailKey(), aad = `${st.uid}:drive:${address}`;
    await rpc(jwt, 'office_drive_connect', { p_expect: st.uid, p_address: address, p_scopes: tok.scope ?? need.join(' '), p_sealed: seal(key, tok.refresh_token, aad) });
    await rpc(jwt, 'office_drive_token_put', { p_access_sealed: seal(key, tok.access_token, aad), p_expires: new Date(Date.now() + (tok.expires_in ?? 3600) * 1000).toISOString() });
    return { address };
  },

  /** 목록 — view(home|mydrive|shared|drives|starred) · folder · q · page */
  async list(jwt, args = {}) {
    const token = await access(jwt);
    const req = listRequest(args);
    const d = await drive(token, req.path, { params: req.params });
    return { files: req.path === '/drives' ? (d.drives ?? []).map(mapDrive) : (d.files ?? []).map(mapFile), next: d.nextPageToken ?? null, search: !!String(args.q ?? '').trim() };
  },

  /** 가져오기 — 드라이브 파일 하나를 이 사람 권한으로 문서함 Storage에 복사하고 등록. 구글 문서류는 PDF·xlsx·png로 내보내 받는다 */
  async import(jwt, { org = null, id, folderId = null, customerId = null }) {
    if ((org !== null && !UUID.test(String(org))) || !validId(id) || (folderId && !UUID.test(folderId)) || (customerId && !UUID.test(customerId))) throw fail(400, 'input');
    const store = r2FromEnv(env); // 설정이 없으면 구글에서 받기 전에 503
    if (env.R2_OFFICE_UPLOADS_OFF === '1') throw fail(503, 'uploads_paused'); // 긴급 차단 — 사람이 시킨 서버 올리기도 멈춘다(서명 그림·서명본은 막지 않는다, 검수 8)
    if (!env.OFFICE_SUPABASE_SERVICE_KEY) throw fail(503, 'not_configured');
    const token = await access(jwt);
    const meta = mapFile(await drive(token, `/files/${id}`, { params: { fields: 'id,name,mimeType,size,webViewLink,shortcutDetails', supportsAllDrives: 'true' } }));
    if (!importable(meta)) throw fail(415, 'link_only');
    if (meta.size && meta.size > MAX_BYTES) throw fail(413, 'too_big');
    const ex = isGoogleNative(meta.mimeType) ? exportFormat(meta.mimeType) : null;
    const res = ex ? await drive(token, `/files/${meta.id}/export`, { params: { mimeType: ex.mime }, raw: true })
      : await drive(token, `/files/${meta.id}`, { params: { alt: 'media', supportsAllDrives: 'true' }, raw: true });
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > MAX_BYTES) throw fail(413, 'too_big');
    const name = ex ? exportName(meta.name, ex.ext) : meta.name, mime = ex?.mime ?? meta.mimeType;
    const fid = randomUUID();
    const { key } = await rpc(jwt, 'office_file_write', { p_org: org, p_action: 'file.reserve', p_data: { id: fid, filename: safeName(name), size: bytes.length, mime } }); // 자리(용량·권한 — 키는 DB가 정함)
    let etag;
    try { ({ etag } = await store.put(key, bytes, { contentType: mime || 'application/octet-stream', ifNoneMatch: true })); } catch { throw fail(502, 'storage'); }
    try {
      await svc('r2_object_commit', { p_key: key, p_bytes: bytes.length, p_etag: etag });
      await rpc(jwt, 'office_file_write', { p_org: org, p_action: 'file.create', p_data: { id: fid, title: name, filename: name, mime, size: bytes.length, storage_path: key, source: 'drive', drive_id: meta.id,
        category: classify({ name, mime }), folder_id: folderId, customer_id: customerId } });
    } catch (e) { // 확인·등록 실패 → 등록 전 행을 deleting으로 → R2 삭제 → forget(문서함 영구 삭제와 같은 순서, 재검수 LOW-A).
      // 이미 기록이 가져간 객체는 abandon이 돌려주지 않아 지우지 않는다(검수 5). R2 삭제가 실패하면 행이 deleting으로 남아 정리 크론이 다시 지운다
      const doomed = await svc('r2_object_abandon', { p_keys: [key] }).catch(() => []);
      if (Array.isArray(doomed) && doomed.length) { try { await store.del(key); await svc('r2_object_forget', { p_keys: doomed }); } catch { /* 크론이 다시 */ } }
      throw e;
    }
    return { id: fid, title: name, mime, size: bytes.length };
  },

  /** 드라이브로 보내기 — 문서함 파일을 드라이브 폴더에 올린다(drive.file) */
  async export(jwt, { org = null, id, folder = 'root' }) {
    if ((org !== null && !UUID.test(String(org))) || !UUID.test(String(id ?? '')) || (folder !== 'root' && !validId(folder))) throw fail(400, 'input');
    const token = await access(jwt, WRITE_SCOPE);
    const f = await rpc(jwt, 'office_file_get', { p_org: org, p_id: id });
    if (f.kind !== 'file') throw fail(415, 'link_only');
    const bytes = await r2FromEnv(env).get(f.storage_path).catch((e) => { throw fail(e.status === 503 ? 503 : 502, e.status === 503 ? e.code : 'storage'); }); // 키는 office_file_get(사용자 JWT)이 준 값
    const { body, type } = multipartBody({ name: f.filename || f.title, parents: [folder] }, Buffer.from(bytes), f.mime);
    const out = await drive(token, '/files', { method: 'POST', params: { uploadType: 'multipart', supportsAllDrives: 'true', fields: 'id,name,webViewLink' }, headers: { 'content-type': type }, body }, G.upload());
    return { id: out.id, name: out.name, link: out.webViewLink ?? null };
  },

  /** 새 폴더(drive.file) — 인트라넷 api/drive/folder와 같다 */
  async mkdir(jwt, { name, parent = 'root' }) {
    const n = String(name ?? '').trim();
    if (!n || n.length > 200 || (parent !== 'root' && !validId(parent))) throw fail(400, 'input');
    const token = await access(jwt, WRITE_SCOPE);
    const out = await drive(token, '/files', { method: 'POST', params: { supportsAllDrives: 'true', fields: 'id,name,webViewLink' }, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: n, mimeType: FOLDER_MIME, parents: [parent] }) });
    return { id: out.id, name: out.name, link: out.webViewLink ?? null };
  },

  async disconnect(jwt) {
    const [row] = (await rpc(jwt, 'office_drive_secret', {})) ?? [];
    if (row) {
      const refresh = unseal(mailKey(), row.sealed, aadOf(row));
      if (refresh) await fetch(G.revoke(), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: refresh }) }).catch(() => {});
    }
    await rpc(jwt, 'office_drive_disconnect', {});
    return { ok: true };
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
    if (!e.status) console.error('[office drive]', op, e?.message);
    return json({ error: e.code ?? 'server' }, e.status ?? 500); // 구글·DB 원문은 화면에 보내지 않는다
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
async function get(request) {
  const op = opOf(request), q = Object.fromEntries(new URL(request.url).searchParams);
  return ['config', 'status', 'list'].includes(op) ? handle(request, op, q) : json({ error: 'method' }, 405); // 바꾸는 동작은 POST로만
}
export async function GET(request) { return cors(request, await get(request)); }
export async function POST(request) { return cors(request, await handle(request, opOf(request), await request.json().catch(() => ({})))); }
export async function OPTIONS(request) { return cors(request, new Response(null, { status: DESKTOP_ORIGINS.has(request.headers.get('origin')) ? 204 : 403 })); }
