// 메일 서버 함수(Vercel, 로컬은 vite.config.js가 같은 파일을 연결) — Gmail·Google Workspace. 요청자의 Supabase JWT로만 움직인다(서비스 키 없음).
// env: OFFICE_GOOGLE_CLIENT_ID · OFFICE_GOOGLE_CLIENT_SECRET · OFFICE_MAIL_KEY · OFFICE_ORIGIN · VITE_SUPABASE_URL · VITE_SUPABASE_ANON_KEY
// 크루는 이 함수로 보내지 않는다(초안까지 — P4/P5). 여기의 send·draftSend는 사람이 보내기를 누를 때만.
// 메일 본문은 DB에 두지 않는다 — DB에는 계정과 봉인 토큰만(20260927171000_office_mail.sql). 변경 번호(historyId)도 화면이 그 기기에 둔다(15차, DB 쓰기 0).
// Gmail 호출 조절(15차 B3): 한 요청 안에서 동시에 4~5개까지(mapLimit), 요청 제한(429·403 rateLimit)은 짧으면(≤2초) 읽기·라벨만 한 번 쉬고 다시,
//   아니면 남은 초(retryAfter)를 화면에 넘긴다(Retry-After 헤더도). 보내기·초안 쓰기는 자동으로 다시 보내지 않는다(두 번 나가지 않게).
// 부하(15차 자동 갱신): 화면이 sync를 30초(메일 화면)·60초(다른 화면, 새 메일 알림을 켠 경우)마다 부른다 — 숨긴 탭은 0.
//   sync 한 번 = 서버 함수 1회 + 계정마다 DB 읽기 1(office_mail_secret, 쓰기 0 — 접근 토큰 갱신 때만 시간당 1번 쓴다) + Gmail history.list 1회
//   (+ 바뀐 메일 수만큼 메타 읽기). 열린 탭 하나·계정 하나, 메일 화면: 분당 서버 함수 2·DB 읽기 2·Gmail 2(바뀐 게 없을 때).
import { mailKey, seal, unseal, sealState, openState } from '../../server/seal.js';
import { envelope, content, buildMime, inlineImages, VIEWABLE, FOLDER_QUERY, SCOPES, missingScopes, MODIFY_LABELS, historyChanges, retryAfterSec, isRateLimited, mapLimit, pickCarry } from '../../server/gmail.js';
import { customerMatcher, gmailQuery, threadSignals } from '../../server/mail-signals.js';
import { createHash, randomBytes } from 'node:crypto';

const env = process.env;
// 가짜 구글 서버로 흐름 전체를 시험할 때만 주소를 바꾼다 — 운영 배포에서는 무시
const over = (name, def) => (env.VERCEL_ENV !== 'production' && env[name]) || def;
const G = {
  auth: () => over('OFFICE_GOOGLE_AUTH_URL', 'https://accounts.google.com/o/oauth2/v2/auth'),
  token: () => over('OFFICE_GOOGLE_TOKEN_URL', 'https://oauth2.googleapis.com/token'),
  revoke: () => over('OFFICE_GOOGLE_REVOKE_URL', 'https://oauth2.googleapis.com/revoke'),
  api: () => over('OFFICE_GMAIL_API', 'https://gmail.googleapis.com/gmail/v1/users/me'),
  upload: () => over('OFFICE_GMAIL_UPLOAD_API', G.api().replace('/gmail/v1/', '/upload/gmail/v1/')),
};
const origin = () => env.OFFICE_ORIGIN || 'http://localhost:5190';
const redirectUri = () => `${origin()}/me/mail/connect`;
const fail = (status, code, message = code) => Object.assign(new Error(message), { status, code });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PAGE = '30';                                       // 한 번에 받는 목록 수 — 더 보기는 다음 쪽 토큰으로
const META = new URLSearchParams([['format', 'metadata'], ...['From', 'To', 'Cc', 'Subject', 'Date'].map((h) => ['metadataHeaders', h])]);
const SMALL_RAW = 3 * 1024 * 1024;                       // 이보다 큰 메시지는 Gmail 올리기 주소(multipart)로 보낸다
const CARRY_MAX = 20 * 1024 * 1024;                      // 전달·초안에 다시 싣는 원문 첨부 합계(Gmail 25MB 한도 안)
const gid = (v) => { const s = String(v ?? ''); if (!/^[A-Za-z0-9_-]{1,200}$/.test(s)) throw fail(400, 'input'); return s; };

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

/** Gmail 응답 하나를 판정 — 401 다시 연결 / 요청 제한(남은 초) / 404 / 그 밖 */
async function judge(r) {
  if (r.status === 401) throw fail(401, 'expired');
  if (r.ok) return r.status === 204 ? null : r.json().catch(() => null);
  const text = await r.text();
  if (isRateLimited(r.status, text)) throw Object.assign(fail(429, 'rate_limited'), { retryAfter: retryAfterSec(r.headers.get('retry-after'), text) });
  throw fail(r.status === 404 ? 404 : r.status >= 500 ? 502 : 400, 'gmail', text); // 400은 다시 보내도 같다(보낼 목록이 재시도하지 않게)
}
/** Gmail 호출. retry: 읽기와 라벨 바꾸기(같은 요청을 다시 보내도 결과가 같다)만 — 요청 제한이 2초 이하면 한 번 쉬고 다시 */
async function gmail(token, path, init = {}, { retry = !init.method || init.method === 'GET' } = {}) {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(`${G.api()}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers } });
    try { return await judge(r); } catch (e) {
      if (e.code !== 'rate_limited' || !retry || attempt > 0 || (e.retryAfter ?? 1) > 2) { if (e.code === 'rate_limited') e.retryAfter = Math.max(1, e.retryAfter ?? 30); throw e; }
      await sleep(Math.max(0.2, e.retryAfter ?? 1) * 1000);
    }
  }
}
/** 메시지 보내기·초안 만들기/고치기 — 작은 메시지는 JSON raw, 큰 메시지(원문 첨부 전달)는 올리기 주소에 message/rfc822 그대로 */
async function putMessage(token, { method, path, meta = {}, wrap }, mime) {
  if (mime.length <= SMALL_RAW) return gmail(token, path, { method, body: JSON.stringify(wrap({ ...meta, raw: mime.toString('base64url') })) });
  const b = `argo-up-${randomBytes(8).toString('hex')}`;
  const body = Buffer.concat([Buffer.from(`--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(wrap(meta))}\r\n--${b}\r\nContent-Type: message/rfc822\r\n\r\n`), mime, Buffer.from(`\r\n--${b}--\r\n`)]);
  return judge(await fetch(`${G.upload()}${path}?uploadType=multipart`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/related; boundary=${b}` }, body }));
}
/** 원문 첨부 다시 싣기(전달·초안 고치기) — 같은 계정의 원본 메일(또는 지금 초안)에서 keep에 든 첨부만 받아 붙인다. 바이트는 이 함수 안에서만 오간다(화면 요청 한도와 무관) */
async function carried(token, carry, keep) {
  if (!carry) return [];
  const id = gid(carry.id);
  const msg = carry.from === 'draft' ? (await gmail(token, `/drafts/${id}?format=full`))?.message : await gmail(token, `/messages/${id}?format=full`);
  if (!msg) return [];
  const list = pickCarry(content(msg).attachments, keep).slice(0, 20);
  if (list.reduce((n, a) => n + (Number(a.size) || 0), 0) > CARRY_MAX) throw fail(413, 'too_big');
  return mapLimit(list, 3, async (a) => ({ name: a.name, type: a.type, bytes: Buffer.from((await gmail(token, `/messages/${encodeURIComponent(msg.id)}/attachments/${encodeURIComponent(a.id)}`)).data ?? '', 'base64url') }));
}
/** 화면이 보낸 메시지 칸만 꺼낸다(모르는 칸은 버린다) */
const message = (m, extra) => ({ from: m.from, to: m.to, cc: m.cc, subject: m.subject, text: m.text, html: typeof m.html === 'string' ? m.html : undefined, inReplyTo: m.inReplyTo, references: m.references,
  attachments: [...(Array.isArray(m.attachments) ? m.attachments.slice(0, 20) : []), ...extra] });

/** 변경분 받기(계정 하나) — since가 없으면 지금 변경 번호만, 기록이 만료됐거나(404) 너무 많이 바뀌었으면 reset(화면이 목록을 새로 받는다) */
async function syncOne(jwt, account, since) {
  const token = await accessToken(jwt, account);
  const profile = async (extra) => ({ historyId: String((await gmail(token, '/profile')).historyId ?? ''), ...extra });
  if (!/^\d{1,20}$/.test(String(since ?? ''))) return profile({ primed: true });
  const q = new URLSearchParams([['startHistoryId', String(since)], ['maxResults', '100'], ...['messageAdded', 'messageDeleted', 'labelAdded', 'labelRemoved'].map((x) => ['historyTypes', x])]);
  let h;
  try { h = await gmail(token, `/history?${q}`); } catch (e) { if (e.status === 404) return profile({ reset: true }); throw e; }
  const historyId = String(h?.historyId ?? since);
  if (h?.nextPageToken) return { historyId, reset: true };
  const { touched, gone } = historyChanges(h);
  if (touched.length > 30) return { historyId, reset: true };
  const missing = [];
  const changed = (await mapLimit(touched, 4, (id) => gmail(token, `/messages/${encodeURIComponent(id)}?${META}`).then((x) => envelope(x, account), (e) => { if (e.status === 404) { missing.push(id); return null; } throw e; }))).filter(Boolean);
  return { historyId, changed, gone: [...gone, ...missing] };
}

/* ── 동작 ── */
const OPS = {
  // 화면이 연결 버튼·관리자 안내문을 그릴 때 — 클라이언트 ID는 공개값
  async config() { return { google: env.OFFICE_GOOGLE_CLIENT_ID ? { clientId: env.OFFICE_GOOGLE_CLIENT_ID, scopes: SCOPES } : null }; },

  async relay(_jwt, { state, code, error } = {}) {
    const st = openState(mailKey(), state);
    if (!st) throw fail(400, 'state');
    if (st.desktop !== true) return { desktop: false };
    if ((!code && !error) || (code && error)) throw fail(400, 'state');
    const q = new URLSearchParams({ state, ...(error ? { error: String(error) } : { code: String(code) }) });
    return { desktop: true, url: `argo-office://mail/callback?${q}` };
  },

  async start(jwt, { hint, desktop } = {}) {
    const { client_id } = client();
    const uid = await me(jwt);
    const verifier = randomBytes(32).toString('base64url');
    const q = new URLSearchParams({
      client_id, redirect_uri: redirectUri(), response_type: 'code', scope: ['openid', 'email', 'profile', ...SCOPES].join(' '),
      access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true',               // consent: 다시 연결해도 갱신 토큰을 받는다
      state: sealState(mailKey(), { uid, v: verifier, ...(desktop === true ? { desktop: true } : {}) }), code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
    });
    if (hint) q.set('login_hint', hint);
    return { url: `${G.auth()}?${q}` };
  },

  async finish(jwt, { code, state }) {
    const st = openState(mailKey(), state);
    if (!st) throw fail(400, 'state');
    if (!code || await me(jwt) !== st.uid) throw fail(400, 'state');
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

  /** 성과 기록 3단계 — 거래처 메일 만족도 신호. 메타데이터(보낸 사람·받는 사람·시각·앞부분 요약)만 읽고, 판정 근거·메일 id만 DB에 넣는다.
   *  6시간에 한 번(office_perf_mail_claim). 사람마다 계정 × 스레드 최대 50개 = Gmail 호출 최대 51회/계정(동시 4개씩). */
  async signals(jwt, { org }) {
    if (typeof org !== 'string' || !/^[0-9a-f-]{36}$/i.test(org)) throw fail(400, 'input');
    const r = await fetch(`${env.VITE_SUPABASE_URL}/rest/v1/office_mail_accounts?select=id,address,status&status=eq.ok`, { headers: { apikey: env.VITE_SUPABASE_ANON_KEY, authorization: `Bearer ${jwt}` } });
    if (!r.ok) throw fail(r.status === 401 ? 401 : 502, r.status === 401 ? 'signed_out' : 'db');
    const accounts = await r.json();
    if (!accounts.length) return { rows: 0, reason: 'no_account' };
    const customers = await rpc(jwt, 'office_perf_customers', { p_org: org });
    const q = gmailQuery(customers ?? [], 30);
    if (!q) return { rows: 0, reason: 'no_customer' };
    if (!(await rpc(jwt, 'office_perf_mail_claim', { p_org: org }))) return { rows: 0, reason: 'recent' };
    const match = customerMatcher(customers), meta = new URLSearchParams([['format', 'metadata'], ...['From', 'To', 'Date'].map((h) => ['metadataHeaders', h])]);
    let rows = 0, failed = 0;
    for (const acc of accounts) {
      try {
        const token = await accessToken(jwt, acc.id);
        const list = await gmail(token, `/threads?${new URLSearchParams({ q, maxResults: '50' })}`);
        const found = await mapLimit(list.threads ?? [], 4, (th) => gmail(token, `/threads/${encodeURIComponent(th.id)}?${meta}`).then((x) => {
          const msgs = (x.messages ?? []).map((m) => { const e = envelope(m, acc.id); return { id: e.gid, from: e.addr, to: e.to, at: e.at, snippet: e.snippet }; });
          return threadSignals(th.id, msgs, acc.address, match);
        }).catch(() => null));
        const put = found.filter(Boolean);
        if (put.length) rows += await rpc(jwt, 'office_perf_mail_put', { p_org: org, p_account: acc.id, p_rows: put });
      } catch (e) { if (e.code === 'signed_out') throw e; failed += 1; } // 한 계정이 만료돼도 다른 계정은 센다
    }
    if (failed === accounts.length) { await rpc(jwt, 'office_perf_mail_release', { p_org: org }).catch(() => {}); return { rows: 0, reason: 'error' }; } // 하나도 못 읽었으면 6시간 기다리지 않고 다음에 다시
    return { rows };
  },

  /** 목록 — 메일함(inbox·unread·starred·drafts·sent·archive) 또는 Gmail 검색어(q). page = 다음 쪽 토큰. 임시 보관함은 drafts.list(초안 id 포함) */
  async list(jwt, { account, folder = 'inbox', page, q }) {
    const token = await accessToken(jwt, account);
    const search = typeof q === 'string' && q.trim() ? q.trim().slice(0, 300) : null;
    const more = page ? { pageToken: String(page).slice(0, 300) } : {};
    const meta = (id, extra) => gmail(token, `/messages/${encodeURIComponent(id)}?${META}`).then((x) => ({ ...envelope(x, account), ...extra }), (e) => { if (e.code === 'rate_limited' || e.code === 'expired') throw e; return null; }); // 지워진 메일 하나는 건너뛴다
    if (folder === 'drafts' && !search) {
      const res = await gmail(token, `/drafts?${new URLSearchParams({ maxResults: PAGE, ...more })}`);
      const items = await mapLimit((res.drafts ?? []).filter((d) => d.message?.id), 5, (d) => meta(d.message.id, { draftId: d.id }));
      return { items: items.filter(Boolean), next: res.nextPageToken ?? null };
    }
    const res = await gmail(token, `/messages?${new URLSearchParams({ maxResults: PAGE, ...(search ? { q: search } : FOLDER_QUERY[folder] ?? FOLDER_QUERY.inbox), ...more })}`);
    const items = await mapLimit(res.messages ?? [], 5, (m) => meta(m.id));
    return { items: items.filter(Boolean), next: res.nextPageToken ?? null };
  },

  /** 바뀐 것만 받기(15차) — accounts: [{ account, since }] 최대 10개를 한 번에. 계정마다 결과·오류를 따로 돌려준다(한 계정의 만료가 다른 계정을 막지 않게) */
  async sync(jwt, { accounts } = {}) {
    if (!Array.isArray(accounts) || !accounts.length || accounts.length > 10) throw fail(400, 'input');
    const results = await mapLimit(accounts, 2, async ({ account, since } = {}) => {
      try { return { account, ...(await syncOne(jwt, account, since)) }; } catch (e) {
        if (e.code === 'signed_out') throw e;
        return { account, error: e.code ?? 'server', ...(e.retryAfter ? { retryAfter: e.retryAfter } : {}) };
      }
    });
    return { results };
  },

  async read(jwt, { account, id }) {
    const token = await accessToken(jwt, account);
    const msg = await gmail(token, `/messages/${encodeURIComponent(id)}?format=full`);
    const c = content(msg);
    // 본문 속 그림은 함께 받아 넣는다(합쳐서 8MB까지 — 넘는 것은 자리만 남는다) — 따로 부르면 그림마다 왕복이 생긴다
    let budget = 8 * 1024 * 1024;
    const want = c.inline.filter((i) => i.data || (budget -= i.size) >= 0);
    const got = await mapLimit(want, 4, (i) => (i.data ? i : gmail(token, `/messages/${encodeURIComponent(id)}/attachments/${encodeURIComponent(i.id)}`).then((a) => ({ ...i, data: a.data })).catch(() => null)));
    const images = Object.fromEntries(got.filter(Boolean).map((i) => [i.cid, i]));
    const { inline, ...rest } = c;
    return { ...envelope(msg, account), ...rest, html: inlineImages(c.html, images) };
  },

  // 읽음·보관·별표 — add/remove는 라벨 id(UNREAD·INBOX·STARRED)만 허용. 같은 요청을 다시 보내도 결과가 같아 요청 제한 때 한 번 다시 보낸다
  async modify(jwt, { account, id, add = [], remove = [] }) {
    const ok = (l) => (Array.isArray(l) ? l : []).filter((x) => MODIFY_LABELS.includes(x));
    const token = await accessToken(jwt, account);
    await gmail(token, `/messages/${encodeURIComponent(id)}/modify`, { method: 'POST', body: JSON.stringify({ addLabelIds: ok(add), removeLabelIds: ok(remove) }) }, { retry: true });
    return { ok: true };
  },

  // 휴지통(10/9) — Gmail 휴지통으로 옮기기·되돌리기만(30일 뒤 Gmail이 지운다, 영구 삭제는 하지 않는다). 다시 보내도 결과가 같다.
  // 이미 없는 메일을 휴지통으로 = 성공, 되돌리기가 404면 실패(돌아오지 않았다)
  async trash(jwt, { account, id, on }) {
    if (typeof on !== 'boolean') throw fail(400, 'input');
    const token = await accessToken(jwt, account);
    try { await gmail(token, `/messages/${gid(id)}/${on ? 'trash' : 'untrash'}`, { method: 'POST' }, { retry: true }); } catch (e) { if (!(on && e.status === 404)) throw e; }
    return { ok: true };
  },

  // 작성 중 초안(바뀔 때만 화면이 부른다) — 첫 저장은 만들고 그 뒤로는 같은 초안을 고친다. carry: 원문 첨부(전달·고치기) 다시 싣기
  // Gmail은 초안 일부만 고칠 수 없어(drafts.update = 메시지 전체 바꾸기) 첨부가 있으면 매번 다시 실어야 한다. 그래서 화면은 첨부가 있는 초안을
  // 첨부가 바뀐 때·닫을 때만 여기로 보내고(글만 바뀐 자동 저장은 그 기기에만 — pages/mail-model.js draftSavePlan), 첨부 없는 초안만 멈출 때마다 보낸다(분리 검수 MEDIUM-2)
  async draft(jwt, { account, draftId, threadId, carry, keep, ...m }) {
    const token = await accessToken(jwt, account);
    const mime = buildMime(message(m, await carried(token, carry, keep)));
    const meta = threadId ? { threadId: String(threadId) } : {};
    const d = draftId
      ? await putMessage(token, { method: 'PUT', path: `/drafts/${encodeURIComponent(gid(draftId))}`, meta, wrap: (x) => ({ id: draftId, message: x }) }, mime)
      : await putMessage(token, { method: 'POST', path: '/drafts', meta, wrap: (x) => ({ message: x }) }, mime);
    return { draftId: d.id, gid: d.message?.id ?? null };
  },

  async send(jwt, { account, draftId, threadId, carry, keep, ...m }) {
    if (!String(m.to ?? '').trim()) throw fail(400, 'input');
    const token = await accessToken(jwt, account);
    const mime = buildMime(message(m, await carried(token, carry, keep)));
    const sent = await putMessage(token, { method: 'POST', path: '/messages/send', meta: threadId ? { threadId: String(threadId) } : {}, wrap: (x) => x }, mime);
    if (draftId) await gmail(token, `/drafts/${encodeURIComponent(gid(draftId))}`, { method: 'DELETE' }).catch(() => {});
    return { id: sent.id };
  },

  // 임시 보관함에서 바로 보내기(15차 D5) — 초안 그대로(첨부·스레드 유지)
  async draftSend(jwt, { account, draftId }) {
    const token = await accessToken(jwt, account);
    const sent = await gmail(token, '/drafts/send', { method: 'POST', body: JSON.stringify({ id: gid(draftId) }) });
    return { id: sent?.id ?? null };
  },

  // 임시 보관함 메일 지우기(15차 D5, 화면이 확인을 받은 뒤) — 이미 없으면 성공으로 본다
  async draftDelete(jwt, { account, draftId }) {
    const token = await accessToken(jwt, account);
    try { await gmail(token, `/drafts/${encodeURIComponent(gid(draftId))}`, { method: 'DELETE' }); } catch (e) { if (e.status !== 404) throw e; }
    return { ok: true };
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

/** 오류 응답 — 구글·DB 원문은 화면에 보내지 않는다. 요청 제한이면 남은 초(본문 retryAfter + Retry-After 헤더) */
function failure(e) {
  const res = json({ error: e.code ?? 'server', ...(e.retryAfter ? { retryAfter: e.retryAfter } : {}) }, e.status ?? 500);
  if (e.retryAfter) res.headers.set('retry-after', String(e.retryAfter));
  return res;
}
async function handle(request, op, args) {
  try {
    if (!Object.hasOwn(OPS, op)) throw fail(404, 'op');
    if (op === 'config') return json(await OPS.config());
    if (op === 'relay') return json(await OPS.relay(null, args));
    const jwt = /^Bearer (.+)$/.exec(request.headers.get('authorization') ?? '')?.[1];
    if (!jwt) throw fail(401, 'signed_out');
    return json(await OPS[op](jwt, args));
  } catch (e) {
    if (!e.status) console.error('[office mail]', op, e);
    return failure(e);
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
  } catch (e) { return failure(e); }
}

async function get(request) {
  const q = Object.fromEntries(new URL(request.url).searchParams);
  const op = opOf(request);
  if (op === 'attachment') return attachment(request, q);
  return ['config', 'read'].includes(op) ? handle(request, op, q) : json({ error: 'method' }, 405); // 바꾸는 동작과 목록·검색(검색어가 주소·접근 기록에 남지 않게)은 POST로만
}
async function post(request) {
  return handle(request, opOf(request), await request.json().catch(() => ({})));
}

const DESKTOP_ORIGINS = new Set(['tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost']);
function cors(request, response) {
  const source = request.headers.get('origin');
  response.headers.set('vary', 'Origin');
  if (DESKTOP_ORIGINS.has(source)) {
    response.headers.set('access-control-allow-origin', source);
    response.headers.set('access-control-allow-methods', 'GET, POST, OPTIONS');
    response.headers.set('access-control-allow-headers', 'Authorization, Content-Type');
    response.headers.set('access-control-expose-headers', 'Retry-After');
  }
  return response;
}
export async function GET(request) { return cors(request, await get(request)); }
export async function POST(request) { return cors(request, await post(request)); }
export async function OPTIONS(request) { return cors(request, new Response(null, { status: DESKTOP_ORIGINS.has(request.headers.get('origin')) ? 204 : 403 })); }
