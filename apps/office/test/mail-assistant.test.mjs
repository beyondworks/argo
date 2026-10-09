// 메일 서버 함수 — 본체 비서의 메일 확인이 쓰는 두 가지(설계 proactive-assistant 4a 일부):
//  ① sync의 봉인 접근 토큰 왕복 — 비서가 들고 오면 접근 토큰을 갱신해도 DB에 쓰지 않는다(유휴 확인 DB 쓰기 0). 화면·도구 호출(들고 오지 않음)은 종전 그대로.
//  ② thread — 스레드 하나를 메일마다 새 글 앞부분만(인용·본문 전체·첨부 없이), 보낸편지 표지·Message-ID와 함께.
// 가짜 Supabase(RPC 기록)·가짜 구글 토큰 끝점·가짜 Gmail. 실제 계정·운영 DB를 쓰지 않는다.
import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { seal, unseal } from '../server/seal.js';
import { threadView, stripQuoted, authOf, envelope } from '../server/gmail.js';
import { GET, POST } from '../api/mail/[op].js';

const realFetch = globalThis.fetch;
const KEY = randomBytes(32);
const API = 'http://gmail/gmail/v1/users/me';
const ENV = { VITE_SUPABASE_URL: 'http://sb', VITE_SUPABASE_ANON_KEY: 'anon', OFFICE_MAIL_KEY: KEY.toString('base64'), OFFICE_GMAIL_API: API, OFFICE_GOOGLE_TOKEN_URL: 'http://token/t', OFFICE_GOOGLE_CLIENT_ID: 'cid', OFFICE_GOOGLE_CLIENT_SECRET: 'sec' };
const aad = (acc) => `u1:google:${acc}@x.com`;

let rows, rpcs, gcalls, tokenCalls, gmail, tokenReply;
const row = (acc, { accessExpires = Date.now() + 3600e3, status = 'ok' } = {}) => ({ user_id: 'u1', provider: 'google', address: `${acc}@x.com`, status,
  sealed: seal(KEY, `REFRESH-${acc}`, aad(acc)), access_sealed: seal(KEY, `DBACCESS-${acc}`, aad(acc)), access_expires: new Date(accessExpires).toISOString() });
const ok = (body) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
beforeEach(() => {
  Object.assign(process.env, ENV); delete process.env.VERCEL_ENV;
  rows = {}; rpcs = []; gcalls = []; tokenCalls = 0; tokenReply = { access_token: 'NEWACCESS', expires_in: 3600 };
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    if (u.host === 'sb') {
      const fn = u.pathname.split('/').pop(); const body = init.body ? JSON.parse(init.body) : {};
      rpcs.push({ fn, body });
      if (fn === 'office_mail_secret') return ok(rows[body.p_account] ? [rows[body.p_account]] : []);
      return new Response('null');
    }
    if (u.host === 'token') { tokenCalls += 1; return ok(tokenReply); }
    const call = { path: u.pathname.replace('/gmail/v1/users/me', ''), q: u.searchParams, auth: init.headers?.authorization };
    gcalls.push(call);
    return gmail(call);
  };
});
afterEach(() => { globalThis.fetch = realFetch; for (const k of Object.keys(ENV)) delete process.env[k]; });
const post = async (op, body) => { const r = await POST(new Request(`http://x/api/mail/${op}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer jwt' }, body: JSON.stringify(body) })); return { status: r.status, body: await r.json() }; };
const writes = () => rpcs.filter((r) => r.fn !== 'office_mail_secret');

test('N15. sync 봉인 접근 토큰 왕복 — 비서가 들고 온 값이 살아 있으면 그것으로 부르고 DB 쓰기·토큰 갱신 0, 다음에 들고 올 값을 돌려준다', async () => {
  rows.a = row('a', { accessExpires: Date.now() - 1000 }); // DB 값은 만료 — 들고 온 값으로만 부를 수 있다
  const carry = { sealed: seal(KEY, 'CARRIED', aad('a')), expires: new Date(Date.now() + 30 * 60e3).toISOString() };
  gmail = (c) => (c.path === '/history' ? ok({ historyId: '120', history: [] }) : ok({ historyId: '120' }));
  const r = await post('sync', { accounts: [{ account: 'a', since: '100', access: carry }] });
  assert.equal(r.status, 200);
  assert.equal(gcalls[0].auth, 'Bearer CARRIED', '들고 온 접근 토큰으로');
  assert.equal(tokenCalls, 0);
  assert.deepEqual(writes(), [], 'DB 쓰기 0');
  assert.deepEqual(r.body.results[0].access, carry, '같은 값을 다시 돌려준다');
});

test('N15. sync 왕복 — 들고 온 값이 없거나 만료면 갱신하되 DB에 쓰지 않고 새 봉인 값을 돌려준다(그 값은 이 계정 주인만 풀린다)', async () => {
  rows.a = row('a', { accessExpires: Date.now() - 1000 });
  gmail = () => ok({ historyId: '120', history: [] });
  const r = await post('sync', { accounts: [{ account: 'a', since: '100', access: null }] });
  assert.equal(r.status, 200);
  assert.equal(tokenCalls, 1);
  assert.deepEqual(writes(), [], '접근 토큰 갱신을 DB에 쓰지 않는다');
  const back = r.body.results[0].access;
  assert.equal(unseal(KEY, back.sealed, aad('a')), 'NEWACCESS');
  assert.equal(unseal(KEY, back.sealed, 'u2:google:a@x.com'), null, '다른 사용자 aad로는 풀리지 않는다');
  assert.ok(Date.parse(back.expires) > Date.now() + 50 * 60e3);
  // 남의 계정 봉인 값을 들고 오면 풀리지 않아 갱신 경로로 간다(그 값으로 Gmail을 부르지 않는다)
  rows.b = row('b', { accessExpires: Date.now() - 1000 });
  gcalls = [];
  await post('sync', { accounts: [{ account: 'b', since: '100', access: back }] });
  assert.equal(gcalls[0].auth, 'Bearer NEWACCESS', 'b의 갱신 토큰으로 새로 받은 값(가짜 끝점은 같은 글자)');
  assert.equal(tokenCalls, 2, '남의 값은 풀리지 않아 다시 갱신');
});

test('N15. sync 왕복 — DB 값이 살아 있으면 그것을 쓰고 들고 갈 값으로 돌려준다 · 갱신 토큰이 바뀌면 그것만은 쓴다', async () => {
  rows.a = row('a');
  gmail = () => ok({ historyId: '120', history: [] });
  const r = await post('sync', { accounts: [{ account: 'a', since: '100', access: null }] });
  assert.equal(gcalls[0].auth, 'Bearer DBACCESS-a');
  assert.equal(unseal(KEY, r.body.results[0].access.sealed, aad('a')), 'DBACCESS-a');
  assert.deepEqual(writes(), []);
  rows.a = row('a', { accessExpires: Date.now() - 1000 });
  tokenReply = { access_token: 'NEW2', refresh_token: 'ROTATED', expires_in: 3600 };
  await post('sync', { accounts: [{ account: 'a', since: '100', access: null }] });
  const w = writes();
  assert.equal(w.length, 1, '갱신 토큰이 바뀐 드문 경우만 1행');
  assert.equal(w[0].fn, 'office_mail_token_put');
  assert.equal(unseal(KEY, w[0].body.p_sealed, aad('a')), 'ROTATED');
});

test('N15. 인접: 들고 오지 않는 호출(화면·도구)은 종전대로 — 만료면 갱신해 DB에 쓰고, 결과에 access 칸이 없다', async () => {
  rows.a = row('a', { accessExpires: Date.now() - 1000 });
  gmail = () => ok({ historyId: '120', history: [] });
  const r = await post('sync', { accounts: [{ account: 'a', since: '100' }] });
  assert.equal(r.body.results[0].access, undefined);
  assert.deepEqual(writes().map((x) => x.fn), ['office_mail_token_put']);
  assert.equal(unseal(KEY, writes()[0].body.p_access_sealed, aad('a')), 'NEWACCESS');
});

const b64 = (s) => Buffer.from(s).toString('base64url');
const msg = (id, { from = 'Vickie <vickie@lum.example>', labels = ['INBOX'], text = '', html = null, at = 1790000000000, mid = `<${id}@x>`, refs = '' } = {}) => ({
  id, threadId: 'T1', labelIds: labels, internalDate: String(at), snippet: text.slice(0, 50),
  payload: { mimeType: 'multipart/alternative', headers: [{ name: 'From', value: from }, { name: 'To', value: 'me@x.com' }, { name: 'Subject', value: 'Re: Kimi K3 script timeline' }, { name: 'Message-ID', value: mid }, ...(refs ? [{ name: 'References', value: refs }] : [])],
    parts: [...(text ? [{ mimeType: 'text/plain', body: { data: b64(text) } }] : []), ...(html ? [{ mimeType: 'text/html', body: { data: b64(html) } }] : []),
      { mimeType: 'application/pdf', filename: 'big.pdf', body: { attachmentId: 'ATT', size: 9_000_000 } }] },
});

test('thread: 메일마다 새 글만(인용 아래는 뺀다)·보낸편지 표지·Message-ID, 초안은 빼고, 첨부 바이트·본문 전체는 내려주지 않는다', async () => {
  rows.a = row('a');
  gmail = (c) => (c.path === '/threads/T1' ? ok({ id: 'T1', messages: [
    msg('m1', { from: 'Me <me@x.com>', labels: ['SENT'], text: 'Kimi K3 스크립트는 10/6까지 보내 드리겠습니다.', at: 1789000000000 }),
    msg('m2', { text: 'Could you confirm the exact delivery date?\n\nOn Wed, Oct 1, 2026 at 9:00 AM Me <me@x.com> wrote:\n> Kimi K3 스크립트는 10/6까지', refs: '<m1@x>' }),
    msg('d1', { labels: ['DRAFT'], text: '임시 초안' }),
  ] }) : new Response('{}', { status: 404 }));
  const r = await post('thread', { account: 'a', id: 'T1' });
  assert.equal(r.status, 200);
  assert.equal(gcalls.length, 1);
  assert.equal(gcalls[0].q.get('format'), 'full');
  const [m1, m2, ...rest] = r.body.messages;
  assert.equal(rest.length, 0, '초안은 빠진다');
  assert.equal(m1.sent, true); assert.equal(m2.sent, false);
  assert.equal(m2.text, 'Could you confirm the exact delivery date?', '인용 아래는 뺀다');
  assert.equal(m2.messageId, '<m2@x>'); assert.equal(m2.references, '<m1@x>');
  assert.equal(m2.addr, 'vickie@lum.example');
  assert.ok(!JSON.stringify(r.body).includes('ATT'), '첨부 id·바이트를 내려주지 않는다');
});

test('thread: 메일마다 1,500자·합쳐 6,000자(최근 메일부터)·최근 10통 · html만 있으면 글자로 · id 형식이 틀리면 400 · GET은 405', async () => {
  const long = 'x'.repeat(4000);
  const view = threadView({ messages: Array.from({ length: 12 }, (_, i) => msg(`m${i}`, { text: `${i}:${long}`, at: 1790000000000 + i })) }, 'a');
  assert.equal(view.length, 10, '최근 10통');
  assert.equal(view.at(-1).gid, 'm11');
  assert.ok(view.every((m) => m.text.length <= 1500));
  assert.equal(view.reduce((n, m) => n + m.text.length, 0), 6000, '합쳐 6,000자');
  assert.equal(view[0].text, '', '예산을 넘은 오래된 메일은 글 없이 머리만');
  assert.equal(view.at(-1).cut, true);
  assert.equal(threadView({ messages: [msg('h', { html: '<p>안녕하세요<br>일정 확인 부탁드립니다</p><script>x()</script>' })] }, 'a')[0].text, '안녕하세요\n일정 확인 부탁드립니다');
  assert.equal(stripQuoted('> 전부 인용'), '> 전부 인용', '전부 인용이면 원문 그대로');
  rows.a = row('a'); gmail = () => ok({ messages: [] });
  assert.equal((await post('thread', { account: 'a', id: '../x' })).status, 400);
  assert.equal((await GET(new Request('http://x/api/mail/thread?account=a&id=T1', { headers: { authorization: 'Bearer jwt' } }))).status, 405);
});

test('인증 결과(authOf) — 첫 Authentication-Results가 mx.google.com의 것일 때만, dmarc 결과와 DMARC가 본 머리 From 도메인 · 보낸 쪽이 심은 머리는 보지 않는다', () => {
  const m = (...vals) => ({ payload: { headers: vals.map((value) => ({ name: 'Authentication-Results', value })) } });
  const gmailAR = 'mx.google.com;\r\n       dkim=pass header.i=@accounts.google.com header.s=20230601 header.b=abc;\r\n       spf=pass (google.com: domain of x designates y) smtp.mailfrom=x@accounts.google.com;\r\n       dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=accounts.google.com';
  assert.deepEqual(authOf(m(gmailAR)), { dmarc: 'pass', from: 'accounts.google.com' });
  assert.deepEqual(authOf(m(gmailAR.replace('dmarc=pass', 'dmarc=fail'))), { dmarc: 'fail', from: 'accounts.google.com' });
  assert.deepEqual(authOf(m('mx.google.com; spf=pass')), { dmarc: 'none', from: '' });
  assert.equal(authOf(m('evil.example; dmarc=pass header.from=google.com')), null, '다른 서버가 쓴 결과는 보지 않는다');
  assert.deepEqual(authOf(m(gmailAR.replace('dmarc=pass', 'dmarc=fail'), 'mx.google.com; dmarc=pass header.from=google.com')), { dmarc: 'fail', from: 'accounts.google.com' }, '보낸 쪽이 아래에 심은 머리는 무시 — 첫 것(Gmail)만');
  assert.equal(authOf({ payload: { headers: [] } }), null);
  assert.deepEqual(authOf(m('mx.google.com; dmarc=pass header.from=<evil>')), { dmarc: 'pass', from: '' }, '도메인 모양이 아니면 비운다');
  const e = envelope({ id: 'g1', threadId: 't', labelIds: ['INBOX'], internalDate: '1790000000000', payload: { headers: [{ name: 'From', value: 'Google <no-reply@accounts.google.com>' }, { name: 'Authentication-Results', value: gmailAR }] } }, 'acc');
  assert.deepEqual(e.auth, { dmarc: 'pass', from: 'accounts.google.com' });
  assert.equal(envelope({ id: 'g2', payload: { headers: [] } }, 'acc').auth, undefined, '없으면 칸이 없다(화면 목록 모양 그대로)');
});

test('sync 메타 읽기는 Authentication-Results 머리를 같은 호출에 함께 청한다(호출 수 그대로)', async () => {
  rows.a = row('a');
  gmail = (c) => (c.path === '/history' ? ok({ historyId: '120', history: [{ messagesAdded: [{ message: { id: 'n1', labelIds: ['INBOX'] } }] }] })
    : c.path === '/messages/n1' ? ok({ id: 'n1', threadId: 't', labelIds: ['INBOX'], internalDate: '1790000000000', payload: { headers: [{ name: 'From', value: 'G <a@google.com>' }, { name: 'Authentication-Results', value: 'mx.google.com; dmarc=pass header.from=google.com' }] } })
    : ok({}));
  const r = await post('sync', { accounts: [{ account: 'a', since: '100', access: null }] });
  const meta = gcalls.find((c) => c.path === '/messages/n1');
  assert.ok(meta.q.getAll('metadataHeaders').includes('Authentication-Results'));
  assert.equal(gcalls.length, 2, 'history 1 + 메타 1 — 머리를 더 청해도 호출은 늘지 않는다');
  assert.deepEqual(r.body.results[0].changed[0].auth, { dmarc: 'pass', from: 'google.com' });
});

test('N15. 비서의 메울 구간 읽기(list)·스레드 읽기(thread)도 봉인 접근 토큰을 들고 오면 갱신해도 DB 쓰기 0 · 들고 오지 않는 화면 호출은 종전 그대로', async () => {
  rows.a = row('a', { accessExpires: Date.now() - 1000 });
  gmail = (c) => (c.path === '/messages' ? ok({ messages: [] }) : c.path === '/threads/T1' ? ok({ id: 'T1', messages: [msg('m1', { text: 'hi' })] }) : ok({}));
  const l = await post('list', { account: 'a', q: 'in:inbox after:1 before:2', access: null });
  const t = await post('thread', { account: 'a', id: 'T1', access: null });
  assert.deepEqual(writes(), [], 'list·thread 왕복은 DB 쓰기 0');
  assert.equal(unseal(KEY, l.body.access.sealed, aad('a')), 'NEWACCESS');
  assert.equal(unseal(KEY, t.body.access.sealed, aad('a')), 'NEWACCESS');
  tokenCalls = 0;
  await post('thread', { account: 'a', id: 'T1', access: t.body.access });
  assert.equal(tokenCalls, 0, '들고 온 값이 살아 있으면 갱신 0');
  const screen = await post('list', { account: 'a', folder: 'inbox' });
  assert.equal(screen.body.access, undefined);
  assert.deepEqual(writes().map((w) => w.fn), ['office_mail_token_put'], '화면 호출은 종전대로 갱신을 DB에');
});
