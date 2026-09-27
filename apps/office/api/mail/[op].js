// 메일 서버 함수(Vercel, 로컬은 vite.config.js가 같은 파일을 연결) — Gmail·Google Workspace. 요청자의 Supabase JWT로만 움직인다(서비스 키 없음).
// env: OFFICE_GOOGLE_CLIENT_ID · OFFICE_GOOGLE_CLIENT_SECRET · OFFICE_MAIL_KEY · OFFICE_ORIGIN · VITE_SUPABASE_URL · VITE_SUPABASE_ANON_KEY
// 크루는 이 함수로 보내지 않는다(초안까지 — P4/P5). 여기의 send는 사람이 보내기를 누를 때만.
import { mailKey, seal, unseal, sealState, openState } from '../../server/seal.js';
import { envelope, content, buildRaw, inlineImages, VIEWABLE, FOLDER_QUERY, SCOPES, missingScopes } from '../../server/gmail.js';
import { createHash, randomBytes } from 'node:crypto';

const env = process.env;
// 가짜 구글 서버로 흐름 전체를 시험할 때만 주소를 바꾼다 — 운영 배포에서는 무시
const over = (name, def) => (env.VERCEL_ENV !== 'production' && env[name]) || def;
const G = {
  auth: () => over('OFFICE_GOOGLE_AUTH_URL', 'https://accounts.google.com/o/oauth2/v2/auth'),
  token: () => over('OFFICE_GOOGLE_TOKEN_URL', 'https://oauth2.googleapis.com/token'),
  revoke: () => over('OFFICE_GOOGLE_REVOKE_URL', 'https://oauth2.googleapis.com/revoke'),
  api: () => over('OFFICE_GMAIL_API', 'https://gmail.googleapis.com/gmail/v1/users/me'),
};
const origin = () => env.OFFICE_ORIGIN || 'http://localhost:5190';
const redirectUri = () => `${origin()}/me/mail/connect`;
const fail = (status, code, message = code) => Object.assign(new Error(message), { status, code });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

/* ── Supabase(요청자 권한) ── */
async function rpc(jwt, fn, args) {
  const r = await fetch(`${env.VITE_SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST', headers: { apikey: env.VITE_SUPABASE_ANON_KEY, authorization: `Bearer ${jwt}`, 'content-type': 'application/json' }, body: JSON.stringify(args),
  });
  if (r.status === 401) throw fail(401, 'signed_out');
  if (!r.ok) throw fail(r.status, 'db', await r.text());
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}
async function me(jwt) {
  const r = await fetch(`${env.VITE_SUPABASE_URL}/auth/v1/user`, { headers: { apikey: env.VITE_SUPABASE_ANON_KEY, authorization: `Bearer ${jwt}` } });
  if (!r.ok) throw fail(401, 'signed_out');
  return (await r.json()).id;
}

/* ── Google ── */
function client() {
  if (!env.OFFICE_GOOGLE_CLIENT_ID || !env.OFFICE_GOOGLE_CLIENT_SECRET) throw fail(503, 'not_configured');
  return { client_id: env.OFFICE_GOOGLE_CLIENT_ID, client_secret: env.OFFICE_GOOGLE_CLIENT_SECRET };
}
async function tokenCall(params) {
  const r = await fetch(G.token(), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...client(), ...params }) });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw fail(body.error === 'invalid_grant' ? 401 : 502, body.error === 'invalid_grant' ? 'expired' : 'google', body.error_description || body.error);
  return body;
}
const claims = (idToken) => JSON.parse(Buffer.from(String(idToken).split('.')[1] ?? '', 'base64url').toString() || '{}'); // 토큰 끝점이 TLS로 직접 준 값(OIDC 3.1.3.7)
const aadOf = (row) => `${row.user_id}:${row.provider}:${row.address}`;

/** 계정의 접근 토큰 — 남은 시간이 1분 넘으면 저장해 둔 것, 아니면 갱신해서 저장(바뀔 때만 쓴다) */
async function accessToken(jwt, account) {
  const [row] = (await rpc(jwt, 'office_mail_secret', { p_account: account })) ?? [];
  if (!row) throw fail(404, 'no_account');
  const key = mailKey(), aad = aadOf(row);
  if (row.access_sealed && Date.parse(row.access_expires) - Date.now() > 60_000) {
    const t = unseal(key, row.access_sealed, aad);
    if (t) return t;
  }
  const refresh = unseal(key, row.sealed, aad);
  if (!refresh) throw fail(401, 'expired');
  let tok;
  try { tok = await tokenCall({ grant_type: 'refresh_token', refresh_token: refresh }); } catch (e) {
    if (e.code === 'expired') await rpc(jwt, 'office_mail_mark', { p_account: account, p_status: 'expired' }); // 테스트 상태 앱은 7일 뒤 만료 — 화면이 "다시 연결"을 띄운다
    throw e;
  }
  await rpc(jwt, 'office_mail_token_put', { p_account: account, p_access_sealed: seal(key, tok.access_token, aad), p_expires: new Date(Date.now() + (tok.expires_in ?? 3600) * 1000).toISOString(), p_sealed: tok.refresh_token ? seal(key, tok.refresh_token, aad) : null });
  if (row.status !== 'ok') await rpc(jwt, 'office_mail_mark', { p_account: account, p_status: 'ok' });
  return tok.access_token;
}
async function gmail(token, path, init = {}) {
  const r = await fetch(`${G.api()}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers } });
  if (r.status === 401) throw fail(401, 'expired');
  if (!r.ok) throw fail(r.status === 404 ? 404 : r.status === 429 || r.status >= 500 ? 502 : 400, 'gmail', await r.text()); // 400은 다시 보내도 같다(보낼 목록이 재시도하지 않게)
  return r.status === 204 ? null : r.json();
}

/* ── 동작 ── */
const OPS = {
  // 화면이 연결 버튼·관리자 안내문을 그릴 때 — 클라이언트 ID는 공개값
  async config() { return { google: env.OFFICE_GOOGLE_CLIENT_ID ? { clientId: env.OFFICE_GOOGLE_CLIENT_ID, scopes: SCOPES } : null }; },

  async start(jwt, { hint } = {}) {
    const { client_id } = client();
    const uid = await me(jwt);
    const verifier = randomBytes(32).toString('base64url');
    const q = new URLSearchParams({
      client_id, redirect_uri: redirectUri(), response_type: 'code', scope: ['openid', 'email', 'profile', ...SCOPES].join(' '),
      access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true',               // consent: 다시 연결해도 갱신 토큰을 받는다
      state: sealState(mailKey(), { uid, v: verifier }), code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
    });
    if (hint) q.set('login_hint', hint);
    return { url: `${G.auth()}?${q}` };
  },

  async finish(jwt, { code, state }) {
    const st = openState(mailKey(), state);
    if (!st) throw fail(400, 'state');
    const tok = await tokenCall({ grant_type: 'authorization_code', code, redirect_uri: redirectUri(), code_verifier: st.v });
    const missing = missingScopes(tok.scope);
    if (missing.length) {                                                                    // 동의 화면에서 권한을 끈 경우 — 받은 토큰은 돌려준다
      await fetch(G.revoke(), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: tok.refresh_token || tok.access_token }) }).catch(() => {});
      throw fail(400, 'scopes');
    }
    if (!tok.refresh_token) throw fail(400, 'no_refresh');
    const c = claims(tok.id_token);
    if (!c.email || c.email_verified === false || c.aud !== client().client_id) throw fail(400, 'no_email'); // 이 앱 앞으로 발급된 신원만
    const address = c.email.toLowerCase(), key = mailKey(), aad = `${st.uid}:google:${address}`;
    const account = await rpc(jwt, 'office_mail_connect', { p_expect: st.uid, p_provider: 'google', p_address: address, p_name: c.name ?? '', p_hd: c.hd ?? '', p_sealed: seal(key, tok.refresh_token, aad) });
    await rpc(jwt, 'office_mail_token_put', { p_account: account, p_access_sealed: seal(key, tok.access_token, aad), p_expires: new Date(Date.now() + (tok.expires_in ?? 3600) * 1000).toISOString() });
    return { account, address };
  },

  async list(jwt, { account, folder = 'inbox', page }) {
    const token = await accessToken(jwt, account);
    const q = new URLSearchParams({ maxResults: '30', ...(FOLDER_QUERY[folder] ?? FOLDER_QUERY.inbox), ...(page ? { pageToken: page } : {}) });
    const res = await gmail(token, `/messages?${q}`);
    const meta = new URLSearchParams([['format', 'metadata'], ...['From', 'To', 'Subject', 'Date'].map((h) => ['metadataHeaders', h])]);
    const items = await Promise.all((res.messages ?? []).map((m) => gmail(token, `/messages/${m.id}?${meta}`).then((x) => envelope(x, account)).catch(() => null)));
    return { items: items.filter(Boolean).map((m) => ({ ...m, folder })), next: res.nextPageToken ?? null };
  },

  async read(jwt, { account, id }) {
    const token = await accessToken(jwt, account);
    const msg = await gmail(token, `/messages/${encodeURIComponent(id)}?format=full`);
    const c = content(msg);
    // 본문 속 그림은 함께 받아 넣는다(합쳐서 8MB까지 — 넘는 것은 자리만 남는다) — 따로 부르면 그림마다 왕복이 생긴다
    let budget = 8 * 1024 * 1024;
    const want = c.inline.filter((i) => i.data || (budget -= i.size) >= 0);
    const got = await Promise.all(want.map((i) => (i.data ? i : gmail(token, `/messages/${encodeURIComponent(id)}/attachments/${encodeURIComponent(i.id)}`).then((a) => ({ ...i, data: a.data })).catch(() => null))));
    const images = Object.fromEntries(got.filter(Boolean).map((i) => [i.cid, i]));
    const { inline, ...rest } = c;
    return { ...envelope(msg, account), ...rest, html: inlineImages(c.html, images) };
  },

  // 읽음·보관 — add/remove는 라벨 id(UNREAD·INBOX)만 허용
  async modify(jwt, { account, id, add = [], remove = [] }) {
    const ok = (l) => l.filter((x) => ['UNREAD', 'INBOX'].includes(x));
    const token = await accessToken(jwt, account);
    await gmail(token, `/messages/${encodeURIComponent(id)}/modify`, { method: 'POST', body: JSON.stringify({ addLabelIds: ok(add), removeLabelIds: ok(remove) }) });
    return { ok: true };
  },

  // 작성 중 초안(바뀔 때만 화면이 부른다) — 첫 저장은 만들고 그 뒤로는 같은 초안을 고친다
  async draft(jwt, { account, draftId, threadId, ...m }) {
    const token = await accessToken(jwt, account);
    const message = { raw: buildRaw(m), ...(threadId ? { threadId } : {}) };
    const d = draftId
      ? await gmail(token, `/drafts/${encodeURIComponent(draftId)}`, { method: 'PUT', body: JSON.stringify({ id: draftId, message }) })
      : await gmail(token, '/drafts', { method: 'POST', body: JSON.stringify({ message }) });
    return { draftId: d.id };
  },

  async send(jwt, { account, draftId, threadId, ...m }) {
    const token = await accessToken(jwt, account);
    const sent = await gmail(token, '/messages/send', { method: 'POST', body: JSON.stringify({ raw: buildRaw(m), ...(threadId ? { threadId } : {}) }) });
    if (draftId) await gmail(token, `/drafts/${encodeURIComponent(draftId)}`, { method: 'DELETE' }).catch(() => {});
    return { id: sent.id };
  },

  async disconnect(jwt, { account }) {
    const [row] = (await rpc(jwt, 'office_mail_secret', { p_account: account })) ?? [];
    if (!row) return { ok: true };
    const refresh = unseal(mailKey(), row.sealed, aadOf(row));
    if (refresh) await fetch(G.revoke(), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: refresh }) }).catch(() => {}); // 구글 쪽 권한 철회(실패해도 연결은 끊는다)
    await rpc(jwt, 'office_mail_disconnect', { p_account: account });
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
    if (!e.status) console.error('[office mail]', op, e);
    return json({ error: e.code ?? 'server' }, e.status ?? 500);                             // 구글·DB 원문은 화면에 보내지 않는다
  }
}
const opOf = (request) => new URL(request.url).pathname.split('/').pop();

// 첨부는 파일 그대로 내려준다(브라우저가 저장) — 메일 본문과 같이 DB를 거치지 않는다
async function attachment(request, q) {
  try {
    const jwt = /^Bearer (.+)$/.exec(request.headers.get('authorization') ?? '')?.[1];
    if (!jwt) throw fail(401, 'signed_out');
    const token = await accessToken(jwt, q.account);
    const a = await gmail(token, `/messages/${encodeURIComponent(q.id)}/attachments/${encodeURIComponent(q.att)}`);
    const view = VIEWABLE.test(q.type ?? '');                                                        // 볼 수 있는 형식만 형식 그대로, 나머지는 내려받기
    return new Response(Buffer.from(a.data, 'base64url'), { headers: { 'content-type': view ? q.type : 'application/octet-stream', 'x-content-type-options': 'nosniff', 'content-disposition': `${view ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(q.name || 'file')}`, 'cache-control': 'no-store' } });
  } catch (e) { return json({ error: e.code ?? 'server' }, e.status ?? 500); }
}

export async function GET(request) {
  const q = Object.fromEntries(new URL(request.url).searchParams);
  const op = opOf(request);
  if (op === 'attachment') return attachment(request, q);
  return ['config', 'list', 'read'].includes(op) ? handle(request, op, q) : json({ error: 'method' }, 405); // 바꾸는 동작은 POST로만
}
export async function POST(request) {
  return handle(request, opOf(request), await request.json().catch(() => ({})));
}
