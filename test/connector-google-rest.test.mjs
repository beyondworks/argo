// 구글 정식 REST 백엔드(src/google-rest.mjs) — Gmail·캘린더 커넥터가 원격 MCP 대신 REST로 실행되는지 가짜 구글 서버로 잰다(2026-10-14 A안).
//  ① 도구 목록 — 이름이 카탈로그 readOnlyAllow·dangerous와 같고, 목록 조회에 네트워크가 없다
//  ② 읽기 — 결재 없이 바로 실행, 본문 디코드(UTF-8·EUC-KR)
//  ③ 쓰기 — 결재 게이트를 지나기 전에는 구글에 아무 요청도 가지 않고, 승인(결재 후속 실행) 뒤에만 나간다
//  ④ 토큰 만료 — 401이면 refresh_token으로 갱신·저장·재시도(refresh_token 보존, 동시 갱신 1회), invalid_grant면 reauth 강등
//  ⑤ 오류 문구 — 403(범위·API 꺼짐)·429·404·400·5xx·망 오류를 사람 문장으로, 토큰·secret은 어디에도 없다
//  ⑥ 보내기 잠금 — 어떤 도구·인자·결재 경로로도 */send에 요청이 가지 않는다
//  ⑦ 캘린더 — 현지 시각 → 시간대 반영, 알림 기본 none, 참석 응답은 내 참석자 행만 바꾼다, 빈 시간 계산
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from './helpers/tmp.mjs';
process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-conn-grest-')); // import보다 먼저
const { callConnectorTool, listConnectorTools, listConnections, connectorBriefing, closeConnectorPools, CONNECTOR_SECRETS_BASE } = await import('../src/connectors.mjs');
const { _setGoogleEndpoints, googleRestKind } = await import('../src/google-rest.mjs');
const { CONNECTOR_CATALOG } = await import('../src/market.mjs');
const { createCompany, paths } = await import('../src/workspace.mjs');
const { writeJsonAtomic, readJson } = await import('../src/jsonstore.mjs');
const { loadApprovals } = await import('../src/approvals.mjs');
const { _followUpForTest } = await import('../src/approval-actions.mjs');

// ── 가짜 구글(Gmail REST·Calendar REST·OAuth 토큰 엔드포인트) ──
const SECRET = 'GOCSPX-test-only-secret';
const reqs = [];          // { method, path, auth, body }
let valid = new Set(['ya29.old']);
let tokenCalls = 0;
let tokenDelayMs = 0;
let issued = 0;
const b64u = (s, enc = 'utf8') => Buffer.from(s, enc).toString('base64url');
const gErr = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const ERRS = {
  e403scope: [403, { error: { code: 403, message: 'Request had insufficient authentication scopes.', status: 'PERMISSION_DENIED', details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] } }],
  e403disabled: [403, { error: { code: 403, message: 'Gmail API has not been used in project 1 before or it is disabled.', errors: [{ reason: 'accessNotConfigured' }], status: 'PERMISSION_DENIED' } }],
  e403rate: [403, { error: { code: 403, message: 'User-rate limit exceeded', errors: [{ reason: 'userRateLimitExceeded' }] } }],
  e429: [429, { error: { code: 429, message: 'Quota exceeded', status: 'RESOURCE_EXHAUSTED' } }],
  e404: [404, { error: { code: 404, message: 'Requested entity was not found.', status: 'NOT_FOUND' } }],
  e400: [400, { error: { code: 400, message: 'Invalid id value; echo ya29.leaky-token and 1//leaky-refresh and GOCSPX-leaky', status: 'INVALID_ARGUMENT' } }],
  e503: [503, { error: { code: 503, message: 'Backend Error', status: 'UNAVAILABLE' } }],
};
const MSG_KO = { id: 'm1', threadId: 't1', labelIds: ['INBOX'], snippet: '안녕', payload: { mimeType: 'multipart/alternative', headers: [{ name: 'Subject', value: '회의 안내' }, { name: 'From', value: 'Kim <kim@example.com>' }, { name: 'To', value: 'me@example.com' }, { name: 'Date', value: 'Tue, 14 Oct 2026 10:00:00 +0900' }, { name: 'Message-ID', value: '<orig@example.com>' }],
  parts: [{ mimeType: 'text/plain', headers: [{ name: 'Content-Type', value: 'text/plain; charset="UTF-8"' }], body: { data: b64u('본문입니다 — 내일 10시') } }, { mimeType: 'text/html', body: { data: b64u('<p>본문</p>') } }] } };
const EUCKR = Buffer.from('c7d1b1dbc0d4b4cfb4d9', 'hex'); // '한글입니다'(EUC-KR)
const MSG_EUC = { id: 'm2', threadId: 't2', payload: { mimeType: 'text/plain', headers: [{ name: 'Subject', value: 'euc' }, { name: 'Content-Type', value: 'text/plain; charset=euc-kr' }], body: { data: EUCKR.toString('base64url') } } };
let event = null;
const resetEvent = () => { event = { id: 'ev1', summary: '주간 회의', start: { dateTime: '2026-10-20T10:00:00+09:00', timeZone: 'Asia/Seoul' }, end: { dateTime: '2026-10-20T11:00:00+09:00', timeZone: 'Asia/Seoul' }, attendees: [{ email: 'boss@example.com', organizer: true, responseStatus: 'accepted' }, { email: 'me@example.com', self: true, responseStatus: 'needsAction' }] }; };

const srv = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  const u = new URL(req.url, 'http://x');
  const body = raw && (req.headers['content-type'] ?? '').includes('json') ? JSON.parse(raw) : raw;
  reqs.push({ method: req.method, path: u.pathname, search: u.search, auth: req.headers.authorization ?? '', body });
  if (u.pathname === '/token') {
    tokenCalls += 1;
    if (tokenDelayMs) await new Promise((r) => setTimeout(r, tokenDelayMs));
    const f = new URLSearchParams(raw);
    if (f.get('client_secret') !== SECRET) return gErr(res, 401, { error: 'invalid_client' });
    if (f.get('refresh_token') !== '1//refresh-ok') return gErr(res, 400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
    const t = `ya29.new-${++issued}`; valid.add(t);
    return gErr(res, 200, { access_token: t, expires_in: 3599, token_type: 'Bearer', scope: 'https://www.googleapis.com/auth/gmail.modify' });
  }
  if (!valid.has((req.headers.authorization ?? '').replace(/^Bearer /, ''))) return gErr(res, 401, { error: { code: 401, message: 'Invalid Credentials', status: 'UNAUTHENTICATED' } });
  const p = u.pathname;
  const errKey = Object.keys(ERRS).find((k) => p.includes(`/${k}`));
  if (errKey) return gErr(res, ...ERRS[errKey]);
  if (/\/send$/.test(p)) return gErr(res, 200, { id: 'SENT' }); // 이 경로가 불리면 시험이 잡는다
  const G = '/gmail/v1/users/me';
  if (p === `${G}/threads`) return gErr(res, 200, { threads: [{ id: 't1', snippet: '안녕' }], resultSizeEstimate: 1 });
  if (p === `${G}/threads/t1`) return gErr(res, 200, { id: 't1', messages: [MSG_KO] });
  if (p === `${G}/messages/m1`) return gErr(res, 200, MSG_KO);
  if (p === `${G}/messages/m2`) return gErr(res, 200, MSG_EUC);
  if (p === `${G}/labels` && req.method === 'GET') return gErr(res, 200, { labels: [{ id: 'INBOX', name: 'INBOX', type: 'system' }, { id: 'Label_1', name: '거래처', type: 'user' }] });
  if (p === `${G}/labels` && req.method === 'POST') return gErr(res, 200, { id: 'Label_9', name: body.name });
  if (p === `${G}/drafts` && req.method === 'POST') return gErr(res, 200, { id: 'd1', message: { id: 'm9', threadId: body.message?.threadId ?? 't9' } });
  if (p === `${G}/drafts` && req.method === 'GET') return gErr(res, 200, { drafts: [{ id: 'd1', message: { id: 'm9' } }] });
  if (p === `${G}/drafts/d1`) return gErr(res, 200, { id: 'd1', message: MSG_KO });
  if (/\/(threads|messages)\/[^/]+\/(modify|trash|untrash)$/.test(p)) return gErr(res, 200, { id: p.split('/')[5], labelIds: body?.addLabelIds ?? [] });
  const CAL = '/calendar/v3';
  if (p === `${CAL}/calendars/primary` && req.method === 'GET') return gErr(res, 200, { id: 'me@example.com', timeZone: 'Asia/Seoul' });
  if (p === `${CAL}/users/me/calendarList`) return gErr(res, 200, { items: [{ id: 'me@example.com', summary: '내 캘린더', primary: true, accessRole: 'owner', timeZone: 'Asia/Seoul' }] });
  if (p === `${CAL}/calendars/primary/events` && req.method === 'GET') return gErr(res, 200, { items: [event] });
  if (p === `${CAL}/calendars/primary/events` && req.method === 'POST') return gErr(res, 200, { id: 'ev2', ...body });
  if (p === `${CAL}/calendars/primary/events/ev1` && req.method === 'GET') return gErr(res, 200, event);
  if (p === `${CAL}/calendars/primary/events/ev1` && req.method === 'PATCH') { event = { ...event, ...body }; return gErr(res, 200, event); }
  if (p === `${CAL}/calendars/primary/events/ev1` && req.method === 'DELETE') { res.writeHead(204); return res.end(); }
  if (p === `${CAL}/freeBusy`) return gErr(res, 200, { calendars: {
    primary: { busy: [{ start: '2026-10-20T01:00:00Z', end: '2026-10-20T02:00:00Z' }] },          // 10:00~11:00 KST
    'pal@example.com': { busy: [{ start: '2026-10-20T03:00:00Z', end: '2026-10-20T04:00:00Z' }] }, // 12:00~13:00 KST
    'ghost@example.com': { errors: [{ domain: 'global', reason: 'notFound' }] } } });
  return gErr(res, 404, { error: { code: 404, message: `no route ${req.method} ${p}` } });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${srv.address().port}`;
_setGoogleEndpoints({ gmail: `${base}/gmail/v1/users/me`, calendar: `${base}/calendar/v3`, token: `${base}/token` });
after(async () => { _setGoogleEndpoints(); await closeConnectorPools(); await new Promise((r) => srv.close(r)); });

// ── 회사·연결 기록 — startConnect가 남기는 모양 그대로(실주소 url·고정 client·토큰) ──
const WS = 'co-grest';
await createCompany(WS, '구글 REST 테스트사', 'captain');
const store = join(paths(WS).root, CONNECTOR_SECRETS_BASE);
const rec = (url, refresh = '1//refresh-ok', access = 'ya29.old') => ({ url, status: 'connected', authRequired: true,
  client: { client_id: 'test-client.apps.googleusercontent.com', client_secret: SECRET }, tokens: { access_token: access, token_type: 'Bearer', refresh_token: refresh } });
async function seed(over = {}) {
  await writeJsonAtomic(store, { servers: {
    gmail: rec('https://gmailmcp.googleapis.com/mcp/v1'),
    'google-calendar': rec('https://calendarmcp.googleapis.com/mcp/v1'),
    ...over,
  } });
}
beforeEach(async () => { reqs.length = 0; tokenCalls = 0; tokenDelayMs = 0; valid = new Set(['ya29.old']); resetEvent(); await seed(); });
const text = (r) => (r.content ?? []).map((c) => c.text).join('\n');
const json = (r) => JSON.parse(text(r));
const sendHits = () => reqs.filter((q) => /\/send(\b|$)/.test(q.path));
const SECRETS_RE = /ya29\.|1\/\/|GOCSPX-/;

const gmailItem = CONNECTOR_CATALOG.find((c) => c.id === 'gmail');
const calItem = CONNECTOR_CATALOG.find((c) => c.id === 'google-calendar');

test('① 도구 목록 — 카탈로그 이름과 같고, 원격 MCP·구글에 요청하지 않는다', async () => {
  assert.equal(googleRestKind(gmailItem.url), 'gmail');
  assert.equal(googleRestKind(calItem.url), 'calendar');
  assert.equal(googleRestKind('https://mcp.notion.com/mcp'), null, '다른 커넥터는 종전 MCP 경로');
  const g = await listConnectorTools(WS, 'gmail');
  assert.equal(g.ok, true);
  const names = g.tools.map((t) => t.name).sort();
  assert.deepEqual(names, [...gmailItem.readOnlyAllow, ...gmailItem.dangerous].sort(), 'Gmail 도구 이름이 카탈로그(읽기 6 + 쓰기 17)와 어긋난다');
  for (const t of g.tools) assert.equal(t.annotations.readOnlyHint, gmailItem.readOnlyAllow.includes(t.name), `${t.name} 읽기 여부`);
  assert.ok(!g.tools.some((t) => /send|reply|forward/.test(t.name)), '보내기 도구가 목록에 있다');
  const c = await listConnectorTools(WS, 'google-calendar');
  const writes = c.tools.filter((t) => !t.annotations.readOnlyHint).map((t) => t.name).sort();
  assert.deepEqual(writes, [...calItem.dangerous].sort(), '캘린더 쓰기 도구가 카탈로그 dangerous와 어긋난다');
  assert.equal(c.tools.length, 9);
  const brief = await connectorBriefing(WS);
  assert.deepEqual(brief.map((b) => b.id).sort(), ['gmail', 'google-calendar']);
  assert.ok(brief.every((b) => b.tools.length > 0), '브리핑에 도구가 비었다');
  assert.equal(reqs.length, 0, '도구 목록 조회가 네트워크를 썼다');
});

test('② 읽기 — 결재 없이 바로 실행되고 제목·발신자·본문이 온다(UTF-8·EUC-KR)', async () => {
  const s = await callConnectorTool(WS, 'gmail', 'search_threads', { query: 'is:unread' });
  assert.equal(s.ok, true, text(s));
  const sj = json(s);
  assert.equal(sj.threads[0].subject, '회의 안내');
  assert.equal(sj.threads[0].from, 'Kim <kim@example.com>');
  assert.match(reqs[0].search, /q=is%3Aunread/);
  assert.equal(reqs[0].auth, 'Bearer ya29.old');
  const m = json(await callConnectorTool(WS, 'gmail', 'get_message', { messageId: 'm1' }));
  assert.equal(m.body, '본문입니다 — 내일 10시');
  const e = json(await callConnectorTool(WS, 'gmail', 'get_message', { messageId: 'm2' }));
  assert.equal(e.body, '한글입니다', 'EUC-KR 본문이 깨졌다');
  const meta = json(await callConnectorTool(WS, 'gmail', 'get_message', { messageId: 'm1', messageFormat: 'METADATA_ONLY' }));
  assert.equal(meta.body, undefined, '메타데이터만 요청했는데 본문이 왔다');
  const labels = json(await callConnectorTool(WS, 'gmail', 'list_labels', {}));
  assert.deepEqual(labels.labels.map((l) => l.id), ['INBOX', 'Label_1']);
  assert.equal((await loadApprovals(WS)).length, 0, '읽기에 결재가 생겼다');
});

test('③ 쓰기 — 결재 전에는 구글 요청 0건, 결재 후속 실행에서만 초안이 만들어진다(보내지 않음)', async () => {
  const args = { to: ['pal@example.com'], subject: '견적 회신', body: '첨부 확인 부탁드립니다.' };
  const r = await callConnectorTool(WS, 'gmail', 'create_draft', args, { slug: 'pepper' });
  assert.equal(r.ok, false); assert.equal(r.error, 'approval_pending');
  assert.equal(reqs.length, 0, '결재 전에 구글로 요청이 나갔다');
  for (const t of ['trash_thread', 'mark_message_spam', 'create_label']) {
    const w = await callConnectorTool(WS, 'gmail', t, { threadId: 't1', messageId: 'm1', displayName: 'x' }, { slug: 'pepper' });
    assert.equal(w.error, 'approval_pending', `${t}가 결재 없이 실행됐다`);
  }
  const cal = await callConnectorTool(WS, 'google-calendar', 'delete_event', { eventId: 'ev1' }, { slug: 'pepper' });
  assert.equal(cal.error, 'approval_pending');
  assert.equal(reqs.length, 0, '결재 전에 구글로 요청이 나갔다');
  // 사장 승인 → 결재 후속 실행(approval-actions)이 같은 callConnectorTool로 실행한다
  const card = (await loadApprovals(WS)).find((a) => a.kind === 'connector' && a.payload.tool === 'create_draft');
  await _followUpForTest(WS, { ...card, status: 'approved' }, true, { runChat: async () => ({}) });
  const posts = reqs.filter((q) => q.method === 'POST' && q.path.endsWith('/drafts'));
  assert.equal(posts.length, 1, '승인 뒤 초안이 만들어지지 않았다');
  const mime = Buffer.from(posts[0].body.message.raw, 'base64url').toString('utf8');
  assert.match(mime, /^To: pal@example\.com\r\n/m);
  assert.match(mime, /^Subject: =\?UTF-8\?B\?/m, '한글 제목이 RFC 2047로 인코딩되지 않았다');
  assert.ok(mime.includes(Buffer.from('첨부 확인 부탁드립니다.').toString('base64')), '본문이 빠졌다');
  assert.equal(sendHits().length, 0, '보내기 엔드포인트가 불렸다');
});

test('③-1 초안 헤더 주입 — 제목의 줄바꿈은 헤더가 되지 않고, 주소 아닌 값은 거절된다', async () => {
  const r = await callConnectorTool(WS, 'gmail', 'create_draft', { to: ['a@example.com'], subject: 'hi\r\nBcc: evil@example.com', body: 'x' }, { approved: true });
  assert.equal(r.ok, true, text(r));
  const mime = Buffer.from(reqs.at(-1).body.message.raw, 'base64url').toString('utf8');
  assert.doesNotMatch(mime, /^Bcc:/m, '제목 줄바꿈으로 Bcc 헤더가 생겼다');
  const bad = await callConnectorTool(WS, 'gmail', 'create_draft', { to: ['a@example.com\r\nBcc: evil@example.com'] }, { approved: true });
  assert.equal(bad.ok, false);
  assert.match(text(bad), /plain email/);
});

test('③-2 답장 초안 — 원 메일 스레드·In-Reply-To를 잇고 받는 사람·제목을 채운다', async () => {
  const r = await callConnectorTool(WS, 'gmail', 'create_draft', { replyToMessageId: 'm1', body: '확인했습니다' }, { approved: true });
  assert.equal(r.ok, true, text(r));
  const post = reqs.find((q) => q.method === 'POST');
  assert.equal(post.body.message.threadId, 't1');
  const mime = Buffer.from(post.body.message.raw, 'base64url').toString('utf8');
  assert.match(mime, /^To: kim@example\.com\r\n/m);
  assert.match(mime, /^In-Reply-To: <orig@example\.com>/m);
  assert.equal(sendHits().length, 0);
});

test('③-3 라벨·휴지통·스팸 — 정해진 REST 경로와 본문으로 간다', async () => {
  const run = (t, a) => callConnectorTool(WS, 'gmail', t, a, { approved: true });
  assert.equal((await run('label_thread', { threadId: 't1', labelIds: ['Label_1'] })).ok, true);
  assert.deepEqual(reqs.at(-1).body, { addLabelIds: ['Label_1'] });
  await run('unlabel_message', { messageId: 'm1', labelIds: ['UNREAD'] });
  assert.deepEqual(reqs.at(-1).body, { removeLabelIds: ['UNREAD'] });
  await run('mark_thread_spam', { threadId: 't1' });
  assert.deepEqual(reqs.at(-1).body, { addLabelIds: ['SPAM'], removeLabelIds: ['INBOX'] });
  await run('unmark_message_spam', { messageId: 'm1' });
  assert.deepEqual(reqs.at(-1).body, { addLabelIds: ['INBOX'], removeLabelIds: ['SPAM'] });
  await run('trash_thread', { threadId: 't1' });
  assert.match(reqs.at(-1).path, /\/threads\/t1\/trash$/);
  await run('apply_sensitive_message_label', { messageId: 'm1', labelOption: 'TRASH' });
  assert.match(reqs.at(-1).path, /\/messages\/m1\/trash$/);
  await run('untrash_message', { messageId: 'm1' });
  assert.match(reqs.at(-1).path, /\/messages\/m1\/untrash$/);
  const lab = json(await run('create_label', { displayName: '거래처/신규', labelListVisibility: 'LABEL_HIDE' }));
  assert.equal(lab.name, '거래처/신규');
  assert.deepEqual(reqs.at(-1).body, { name: '거래처/신규', labelListVisibility: 'labelHide' });
  const traversal = await run('trash_thread', { threadId: '..' });
  assert.equal(traversal.ok, false, "'..' ID가 다른 경로로 새었다");
  assert.equal(sendHits().length, 0);
});

test('④ 토큰 만료 — 401이면 갱신해 저장하고 재시도한다(refresh_token 보존, 동시 호출도 갱신 1회)', async () => {
  valid = new Set(); // ya29.old 만료
  tokenDelayMs = 50;
  const [a, b] = await Promise.all([
    callConnectorTool(WS, 'gmail', 'list_labels', {}),
    callConnectorTool(WS, 'gmail', 'search_threads', {}),
  ]);
  assert.equal(a.ok, true, text(a)); assert.equal(b.ok, true, text(b));
  assert.equal(tokenCalls, 1, `동시 호출이 토큰을 ${tokenCalls}번 갱신했다`);
  const s = (await readJson(store, {})).servers.gmail;
  assert.equal(s.tokens.access_token, 'ya29.new-' + issued, '갱신 토큰이 저장되지 않았다');
  assert.equal(s.tokens.refresh_token, '1//refresh-ok', 'refresh_token이 사라졌다 — 다음 갱신이 실패한다');
  assert.equal(s.status, 'connected');
  const tokenReq = reqs.find((q) => q.path === '/token');
  const form = new URLSearchParams(tokenReq.body);
  assert.equal(form.get('grant_type'), 'refresh_token');
  assert.equal(form.get('client_id'), 'test-client.apps.googleusercontent.com');
  // 다음 호출은 저장된 새 토큰을 바로 쓴다(갱신 없음)
  tokenCalls = 0;
  assert.equal((await callConnectorTool(WS, 'gmail', 'list_labels', {})).ok, true);
  assert.equal(tokenCalls, 0);
});

test('④-1 기록에 secret이 없으면 카탈로그의 환경변수 이름으로 실행 환경에서 읽는다', async () => {
  const r0 = rec('https://gmailmcp.googleapis.com/mcp/v1'); delete r0.client.client_secret;
  await seed({ gmail: r0 });
  valid = new Set();
  const prev = process.env.ARGO_CONNECTOR_GOOGLE_CLIENT_SECRET;
  process.env.ARGO_CONNECTOR_GOOGLE_CLIENT_SECRET = SECRET;
  try { assert.equal((await callConnectorTool(WS, 'gmail', 'list_labels', {})).ok, true); }
  finally { if (prev === undefined) delete process.env.ARGO_CONNECTOR_GOOGLE_CLIENT_SECRET; else process.env.ARGO_CONNECTOR_GOOGLE_CLIENT_SECRET = prev; }
});

test('④-2 invalid_grant — 재연결 필요(reauth)로 강등하고 토큰을 지운다, 문구에 토큰 없음', async () => {
  await seed({ gmail: rec('https://gmailmcp.googleapis.com/mcp/v1', '1//revoked') });
  valid = new Set();
  const r = await callConnectorTool(WS, 'gmail', 'search_threads', {}, { lang: 'en' });
  assert.equal(r.ok, false); assert.equal(r.error, 'reauth_required');
  assert.match(text(r), /reconnect it in Settings/);
  assert.doesNotMatch(text(r), SECRETS_RE);
  const s = (await readJson(store, {})).servers.gmail;
  assert.equal(s.status, 'reauth'); assert.equal(s.tokens, undefined);
  assert.equal((await listConnections(WS)).find((c) => c.id === 'gmail').status, 'reauth', '연결 카드 상태가 reauth가 아니다');
  const again = await callConnectorTool(WS, 'gmail', 'search_threads', {});
  assert.equal(again.error, 'reauth_required');
  assert.equal(reqs.filter((q) => q.path !== '/token').length, 1, 'reauth 뒤에도 구글로 요청이 나갔다');
});

test('④-3 secret 문제(invalid_client) — 재연결로 안내하지 않고 운영 문제라고 말한다', async () => {
  const r0 = rec('https://gmailmcp.googleapis.com/mcp/v1'); r0.client.client_secret = 'GOCSPX-wrong';
  await seed({ gmail: r0 });
  valid = new Set();
  const r = await callConnectorTool(WS, 'gmail', 'list_labels', {});
  assert.equal(r.ok, false); assert.equal(r.error, 'call_failed');
  assert.match(text(r), /Argo 운영자/);
  assert.doesNotMatch(text(r), SECRETS_RE);
  assert.equal((await readJson(store, {})).servers.gmail.status, 'connected', '설정 문제인데 사용자 연결을 끊었다');
});

test('⑤ 구글 오류 — 사람이 읽을 문장으로, 토큰·secret 없이', async () => {
  const cases = [
    ['e403scope', /권한을 주지 않았습니다\(범위 부족\)/, /insufficient scope/],
    ['e403disabled', /API가 꺼져/, /API is turned off/],
    ['e403rate', /사용 한도/, /usage limit/],
    ['e429', /사용 한도/, /usage limit/],
    ['e404', /찾지 못했습니다/, /could not find/],
    ['e400', /받아들이지 않았습니다: Invalid id value/, /rejected the request: Invalid id value/],
    ['e503', /일시적으로 응답하지 않습니다\(HTTP 503\)/, /temporarily not responding \(HTTP 503\)/],
  ];
  for (const [id, ko, en] of cases) {
    const r = await callConnectorTool(WS, 'gmail', 'get_message', { messageId: id });
    assert.equal(r.ok, false); assert.equal(r.error, 'call_failed');
    assert.match(text(r), ko, `${id} ko: ${text(r)}`);
    assert.match(text(r), /^Gmail: /);
    assert.doesNotMatch(text(r), SECRETS_RE, `${id} 문구에 토큰·secret이 샜다: ${text(r)}`);
    const e = await callConnectorTool(WS, 'gmail', 'get_message', { messageId: id }, { lang: 'en' });
    assert.match(text(e), en, `${id} en: ${text(e)}`);
    assert.doesNotMatch(text(e), /[가-힣]/, `${id} en 문구에 한국어`);
  }
  assert.equal((await readJson(store, {})).servers.gmail.status, 'connected', '구글 오류가 연결 상태를 바꿨다');
});

test('⑤-1 망 오류 — 구글에 닿지 못하면 사람 문장', async () => {
  _setGoogleEndpoints({ gmail: 'http://127.0.0.1:9/gmail/v1/users/me', calendar: `${base}/calendar/v3`, token: `${base}/token` });
  try {
    const r = await callConnectorTool(WS, 'gmail', 'list_labels', {});
    assert.equal(r.ok, false);
    assert.match(text(r), /구글에 연결하지 못했습니다/);
  } finally { _setGoogleEndpoints({ gmail: `${base}/gmail/v1/users/me`, calendar: `${base}/calendar/v3`, token: `${base}/token` }); }
});

test('⑥ 보내기 잠금 — 보내기류 이름·전 도구·결재 경로 어디로도 */send에 요청하지 않는다', async () => {
  for (const t of ['send_message', 'send_draft', 'reply', 'forward', 'drafts.send']) {
    const pending = await callConnectorTool(WS, 'gmail', t, { draftId: 'd1', to: ['x@example.com'] }, { slug: 'pepper' });
    assert.equal(pending.error, 'approval_pending', `${t} — 목록 밖 도구가 결재 없이 통과했다`);
    const forced = await callConnectorTool(WS, 'gmail', t, { draftId: 'd1', to: ['x@example.com'] }, { approved: true });
    assert.equal(forced.ok, false, `${t}가 실행됐다`);
    assert.match(text(forced), /메일 보내기는 지원하지 않습니다/);
  }
  // 등재된 23개 도구 전부를 승인 상태로 돌려도 send 경로가 없다
  const all = (await listConnectorTools(WS, 'gmail')).tools.map((t) => t.name);
  for (const t of all) await callConnectorTool(WS, 'gmail', t, { threadId: 't1', messageId: 'm1', draftId: 'd1', labelIds: ['Label_1'], addLabelIds: ['Label_1'], labelOption: 'SPAM', displayName: 'L', to: ['x@example.com'], body: 'b' }, { approved: true });
  assert.ok(reqs.length > 23, '도구들이 실제로 실행되지 않았다');
  assert.equal(sendHits().length, 0, `보내기 엔드포인트가 불렸다: ${JSON.stringify(sendHits())}`);
  // 결재 카드를 승인해도 마찬가지(결재 후속 실행 경로)
  for (const card of (await loadApprovals(WS)).filter((a) => a.kind === 'connector' && a.status === 'pending')) {
    await _followUpForTest(WS, { ...card, status: 'approved' }, true, { runChat: async () => ({}) });
  }
  assert.equal(sendHits().length, 0);
});

test('⑦ 캘린더 — 현지 시각을 캘린더 시간대로 읽고, 알림 기본 none, 길이 유지, 참석 응답은 내 행만', async () => {
  const run = (t, a, o = { approved: true }) => callConnectorTool(WS, 'google-calendar', t, a, o);
  const l = await run('list_events', { startTime: '2026-10-20T10:00:00', endTime: '2026-10-21T00:00:00' }, {});
  assert.equal(l.ok, true, text(l));
  const q = new URLSearchParams(reqs.find((x) => x.path.endsWith('/events')).search);
  assert.equal(q.get('timeMin'), '2026-10-20T01:00:00.000Z', '10:00 KST가 UTC 01:00으로 바뀌지 않았다');
  assert.equal(q.get('singleEvents'), 'true');
  assert.equal(json(l).events[0].summary, '주간 회의');
  const c = await run('create_event', { summary: '고객 미팅', startTime: '2026-10-21T15:00:00', endTime: '2026-10-21T16:00:00', attendeeEmails: ['pal@example.com'] });
  assert.equal(c.ok, true, text(c));
  const post = reqs.find((x) => x.method === 'POST' && x.path.endsWith('/events'));
  assert.equal(new URLSearchParams(post.search).get('sendUpdates'), 'none', '알림 메일 기본값이 none이 아니다');
  assert.equal(post.body.start.dateTime, '2026-10-21T06:00:00.000Z');
  assert.equal(post.body.start.timeZone, 'Asia/Seoul');
  assert.deepEqual(post.body.attendees, [{ email: 'pal@example.com' }]);
  const u = await run('update_event', { eventId: 'ev1', startTime: '2026-10-20T14:00:00', notificationLevel: 'ALL' });
  assert.equal(u.ok, true, text(u));
  const patch = reqs.find((x) => x.method === 'PATCH');
  assert.equal(new URLSearchParams(patch.search).get('sendUpdates'), 'all');
  assert.equal(patch.body.end.dateTime, '2026-10-20T06:00:00.000Z', '시작만 바꿨는데 길이(1시간)가 유지되지 않았다');
  resetEvent(); reqs.length = 0;
  const resp = await run('respond_to_event', { eventId: 'ev1', responseStatus: 'accepted' });
  assert.equal(resp.ok, true, text(resp));
  const att = reqs.find((x) => x.method === 'PATCH').body.attendees;
  assert.equal(att.find((x) => x.self).responseStatus, 'accepted');
  assert.equal(att.find((x) => x.organizer).responseStatus, 'accepted', '남의 응답이 바뀌었다');
  const del = await run('delete_event', { eventId: 'ev1' });
  assert.equal(del.ok, true);
  assert.equal(new URLSearchParams(reqs.at(-1).search).get('sendUpdates'), 'none');
});

test('⑦-1 빈 시간 — 나와 참석자의 바쁜 시간을 피하고, 확인 못 한 참석자를 알려 준다', async () => {
  const r = await callConnectorTool(WS, 'google-calendar', 'suggest_time', { attendeeEmails: ['pal@example.com', 'ghost@example.com'], startTime: '2026-10-20T09:00:00', endTime: '2026-10-20T14:00:00', durationMinutes: 60 });
  assert.equal(r.ok, true, text(r));
  const j = json(r);
  const fb = reqs.find((x) => x.path.endsWith('/freeBusy')).body;
  assert.deepEqual(fb.items.map((x) => x.id), ['primary', 'pal@example.com', 'ghost@example.com']);
  assert.equal(fb.timeMin, '2026-10-20T00:00:00.000Z');
  assert.deepEqual(j.unavailable, ['ghost@example.com']);
  const starts = j.slots.map((s) => s.start);
  assert.ok(starts.includes('2026-10-20T09:00:00') && starts.includes('2026-10-20T11:00:00') && starts.includes('2026-10-20T13:00:00'), `빈 시간: ${starts}`);
  for (const s of starts) assert.ok(!['2026-10-20T10:00:00', '2026-10-20T12:00:00'].includes(s), `바쁜 시간이 제안됐다: ${s}`);
});

test('⑧ 손님 턴 — REST 백엔드도 손님 차단이 먼저다(구글 요청 0건)', async () => {
  const guest = { kind: 'msgr', uid: 'owner-uid', origin: 'someone-else' }; // connector-gmail 시험과 같은 손님 모양
  for (const t of ['search_threads', 'create_draft']) {
    const r = await callConnectorTool(WS, 'gmail', t, {}, { slug: 'captain', mirrorCtx: guest, approved: true });
    assert.equal(r.error, 'guest_blocked', `${t}: ${text(r)}`);
  }
  assert.equal(reqs.length, 0, '손님 턴에서 구글로 요청이 나갔다');
});
