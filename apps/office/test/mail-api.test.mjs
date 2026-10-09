// 메일 서버 함수(api/mail, 15차) — 가짜 Supabase(봉인 토큰)와 가짜 Gmail로 끝까지: 메일함·검색·더 보기·초안 목록, 바뀐 것만 받기(history),
// 별표 라벨, 동시 호출 상한, 요청 제한(짧으면 한 번 다시·길면 남은 초를 화면에, 보내기는 다시 보내지 않음), 전달의 원문 첨부 싣기, 큰 메시지 올리기 주소, 초안 보내기·지우기.
import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { seal } from '../server/seal.js';
import { GET, POST } from '../api/mail/[op].js';

const realFetch = globalThis.fetch;
const KEY = randomBytes(32);
const API = 'http://gmail/gmail/v1/users/me', UP = 'http://gmail/upload/gmail/v1/users/me';
const ENV = { VITE_SUPABASE_URL: 'http://sb', VITE_SUPABASE_ANON_KEY: 'anon', OFFICE_MAIL_KEY: KEY.toString('base64'), OFFICE_GMAIL_API: API, OFFICE_GOOGLE_CLIENT_ID: 'cid', OFFICE_GOOGLE_CLIENT_SECRET: 'sec' };
const aad = (acc) => `u1:google:${acc}@x.com`;
const row = (acc) => ({ user_id: 'u1', provider: 'google', address: `${acc}@x.com`, status: 'ok', sealed: seal(KEY, 'refresh', aad(acc)), access_sealed: seal(KEY, `ACCESS-${acc}`, aad(acc)), access_expires: new Date(Date.now() + 3600e3).toISOString() });

let gmail, calls, inflight, peak;
beforeEach(() => {
  Object.assign(process.env, ENV); delete process.env.VERCEL_ENV;
  calls = []; inflight = 0; peak = 0;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    if (u.host === 'sb') {
      const fn = u.pathname.split('/').pop(), body = init.body ? JSON.parse(init.body) : {};
      if (fn === 'office_mail_secret') return new Response(JSON.stringify(body.p_account === 'missing' ? [] : [row(body.p_account)]));
      return new Response('null');
    }
    const call = { method: init.method ?? 'GET', path: u.pathname.replace('/gmail/v1/users/me', '').replace('/upload', '@upload'), q: u.searchParams, url: u, init, auth: init.headers?.authorization };
    calls.push(call);
    inflight++; peak = Math.max(peak, inflight);
    try { await new Promise((r) => setTimeout(r, 2)); return await gmail(call); } finally { inflight--; }
  };
});
afterEach(() => { globalThis.fetch = realFetch; for (const k of Object.keys(ENV)) delete process.env[k]; });

const ok = (body) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
const meta = (id, labels = ['INBOX'], extra = {}) => ({ id, threadId: `t-${id}`, labelIds: labels, internalDate: String(1790000000000 + Number(id.replace(/\D/g, '') || 0) * 1000), snippet: `snip ${id}`,
  payload: { headers: [{ name: 'From', value: `Kim <kim@x.com>` }, { name: 'To', value: 'a@x.com' }, { name: 'Subject', value: `subject ${id}` }] }, ...extra });
const get = async (op, q, jwt = 'jwt') => { const r = await GET(new Request(`http://x/api/mail/${op}?${new URLSearchParams(q)}`, { headers: jwt ? { authorization: `Bearer ${jwt}` } : {} })); return { status: r.status, headers: r.headers, body: await r.json() }; };
const post = async (op, body, jwt = 'jwt') => { const r = await POST(new Request(`http://x/api/mail/${op}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(jwt ? { authorization: `Bearer ${jwt}` } : {}) }, body: JSON.stringify(body) })); return { status: r.status, headers: r.headers, body: await r.json() }; };
const metaRoute = (c) => { const id = /\/messages\/([^/]+)$/.exec(c.path)?.[1]; return id && c.q.get('format') === 'metadata' ? ok(meta(id, id.startsWith('s') ? ['STARRED', 'INBOX', 'UNREAD'] : ['INBOX'])) : null; };

test('목록: 메일함 조건·다음 쪽 토큰·메일함은 라벨로(별표 포함)·메타는 동시에 5개까지', async () => {
  gmail = (c) => {
    if (c.path === '/messages') return ok({ messages: Array.from({ length: 12 }, (_, i) => ({ id: i === 0 ? 's0' : `m${i}` })), nextPageToken: 'P2' });
    return metaRoute(c) ?? new Response('{}', { status: 404 });
  };
  const r = await post('list', { account: 'acc', folder: 'starred', page: 'P1' });
  assert.equal(r.status, 200);
  const list = calls.find((c) => c.path === '/messages');
  assert.equal(list.q.get('q'), 'is:starred'); assert.equal(list.q.get('pageToken'), 'P1'); assert.equal(list.q.get('maxResults'), '30');
  assert.equal(list.auth, 'Bearer ACCESS-acc', '봉인을 푼 접근 토큰');
  assert.equal(r.body.items.length, 12); assert.equal(r.body.next, 'P2');
  const s0 = r.body.items.find((m) => m.gid === 's0');
  assert.deepEqual([s0.folder, s0.starred, s0.unread], ['inbox', true, true], '별표함에서 받은 메일도 제자리 메일함(받은편지함)');
  assert.ok(peak <= 5, `동시 Gmail 호출 ${peak}개 — 5개를 넘지 않는다`);
  assert.ok(calls.filter((c) => c.q.get('format') === 'metadata').every((c) => c.q.getAll('metadataHeaders').includes('Cc')));
});

// 이유(분리 검수 LOW-11): 검색어가 주소(GET)에 실리면 서버·CDN 접근 기록에 남는다 — 목록·검색은 요청 본문으로만
test('목록·검색은 POST 본문으로만: 주소로 오면(GET) 405, Gmail은 부르지 않는다', async () => {
  gmail = () => ok({ messages: [] });
  const r = await get('list', { account: 'acc', q: 'from:kim 비밀 거래' });
  assert.deepEqual([r.status, r.body], [405, { error: 'method' }]);
  assert.equal(calls.length, 0);
  assert.equal((await get('read', { account: 'acc', id: 'm1' })).status !== 405, true, '읽기·설정은 그대로 GET');
});

test('검색: Gmail 검색어를 그대로(300자까지), 메일함 조건은 쓰지 않는다 · 임시 보관함은 drafts.list(초안 id)', async () => {
  gmail = (c) => (c.path === '/messages' ? ok({ messages: [{ id: 'm1' }] }) : c.path === '/drafts' ? ok({ drafts: [{ id: 'D1', message: { id: 'm2' } }, { id: 'D2' }] }) : metaRoute(c) ?? new Response('{}', { status: 404 }));
  const r = await post('list', { account: 'acc', folder: 'inbox', q: ` from:kim has:attachment ${'x'.repeat(400)}` });
  const list = calls.find((c) => c.path === '/messages');
  assert.equal(list.q.get('q').length, 300); assert.ok(list.q.get('q').startsWith('from:kim has:attachment'));
  assert.equal(list.q.get('labelIds'), null);
  assert.equal(r.body.items[0].gid, 'm1');
  calls = [];
  const d = await post('list', { account: 'acc', folder: 'drafts' });
  assert.deepEqual(d.body.items.map((m) => [m.gid, m.draftId]), [['m2', 'D1']], '메시지 없는 초안은 건너뛴다');
});

test('바뀐 것만: 처음은 변경 번호만, 다음부터 history — 새 메일·라벨 바뀐 메일은 메타, 초안은 빼고, 지워진 메일은 gone', async () => {
  gmail = (c) => {
    if (c.path === '/profile') return ok({ historyId: '500' });
    if (c.path === '/history') return ok({ historyId: '510', history: [
      { messagesAdded: [{ message: { id: 'm7', labelIds: ['INBOX', 'UNREAD'] } }, { message: { id: 'dr1', labelIds: ['DRAFT'] } }] },
      { labelsAdded: [{ message: { id: 'm3', labelIds: ['INBOX', 'STARRED'] }, labelIds: ['STARRED'] }] },
      { messagesAdded: [{ message: { id: 'm9', labelIds: ['INBOX'] } }] }, { messagesDeleted: [{ message: { id: 'm9' } }] },
    ] });
    if (/\/messages\/m404$/.test(c.path)) return new Response('{}', { status: 404 });
    return metaRoute(c) ?? new Response('{}', { status: 404 });
  };
  const first = await post('sync', { accounts: [{ account: 'acc', since: null }] });
  assert.deepEqual(first.body.results, [{ account: 'acc', historyId: '500', primed: true }]);
  calls = [];
  const next = await post('sync', { accounts: [{ account: 'acc', since: '500' }, { account: 'missing', since: '1' }] });
  const [a, b] = next.body.results;
  const h = calls.find((c) => c.path === '/history');
  assert.equal(h.q.get('startHistoryId'), '500');
  assert.deepEqual(h.q.getAll('historyTypes').sort(), ['labelAdded', 'labelRemoved', 'messageAdded', 'messageDeleted']);
  assert.equal(a.historyId, '510');
  assert.deepEqual(a.changed.map((m) => m.gid).sort(), ['m3', 'm7']);
  assert.deepEqual(a.gone, ['m9'], '추가 뒤 지워진 메일은 지운 쪽만');
  assert.ok(!calls.some((c) => c.path.endsWith('/dr1')), '초안 메시지는 받지 않는다');
  assert.deepEqual(b, { account: 'missing', error: 'no_account' }, '한 계정의 오류가 다른 계정을 막지 않는다');
});

test('바뀐 것만: 기록이 만료(404)되면 지금 변경 번호로 reset, 한꺼번에 많이 바뀌면 reset, 형식이 틀린 since는 다시 맞춘다', async () => {
  gmail = (c) => (c.path === '/profile' ? ok({ historyId: '900' }) : c.path === '/history' ? new Response('{"error":{"code":404}}', { status: 404 }) : new Response('{}', { status: 404 }));
  assert.deepEqual((await post('sync', { accounts: [{ account: 'acc', since: '1' }] })).body.results[0], { account: 'acc', historyId: '900', reset: true });
  gmail = (c) => (c.path === '/history' ? ok({ historyId: '950', nextPageToken: 'more', history: [] }) : new Response('{}', { status: 404 }));
  assert.deepEqual((await post('sync', { accounts: [{ account: 'acc', since: '900' }] })).body.results[0], { account: 'acc', historyId: '950', reset: true });
  gmail = (c) => (c.path === '/profile' ? ok({ historyId: '7' }) : new Response('{}', { status: 404 }));
  assert.equal((await post('sync', { accounts: [{ account: 'acc', since: '12; drop' }] })).body.results[0].primed, true);
  assert.equal((await post('sync', { accounts: [] })).status, 400);
  assert.equal((await post('sync', { accounts: Array.from({ length: 11 }, () => ({ account: 'acc' })) })).status, 400, '한 번에 10개 계정까지');
});

test('별표: STARRED는 바꿀 수 있고 다른 라벨(TRASH 등)은 걸러진다', async () => {
  gmail = () => ok({});
  await post('modify', { account: 'acc', id: 'm1', add: ['STARRED', 'TRASH'], remove: ['SPAM', 'UNREAD'] });
  assert.deepEqual(JSON.parse(calls[0].init.body), { addLabelIds: ['STARRED'], removeLabelIds: ['UNREAD'] });
});

test('요청 제한: 짧으면(≤2초) 읽기는 한 번 쉬고 다시, 길면 429 + 남은 초(본문·Retry-After 헤더), 403 rateLimitExceeded도 같다', async () => {
  let n = 0;
  gmail = (c) => (c.path === '/messages' ? (n++ === 0 ? new Response('slow', { status: 429, headers: { 'retry-after': '0' } }) : ok({ messages: [] })) : new Response('{}', { status: 404 }));
  assert.equal((await post('list', { account: 'acc' })).status, 200);
  assert.equal(calls.length, 2, '한 번만 다시');
  calls = [];
  gmail = () => new Response('slow', { status: 429, headers: { 'retry-after': '30' } });
  const r = await post('list', { account: 'acc' });
  assert.deepEqual([r.status, r.body, r.headers.get('retry-after')], [429, { error: 'rate_limited', retryAfter: 30 }, '30']);
  assert.equal(calls.length, 1, '30초를 기다리라면 다시 보내지 않는다');
  gmail = () => new Response('{"error":{"errors":[{"reason":"userRateLimitExceeded"}],"message":"User-rate limit exceeded.  Retry after 2099-01-01T00:00:00.000Z"}}', { status: 403 });
  const q = await get('read', { account: 'acc', id: 'm1' });
  assert.equal(q.status, 429); assert.ok(q.body.retryAfter > 1000, '본문의 Retry after 날짜');
  let twice = 0;
  gmail = (c) => { if (c.path === '/messages/send') { twice++; return new Response('slow', { status: 429, headers: { 'retry-after': '0' } }); } return new Response('{}', { status: 404 }); };
  const s = await post('send', { account: 'acc', to: 'b@x.com', subject: 's', text: 't' });
  assert.equal(s.status, 429); assert.equal(twice, 1, '보내기는 요청 제한이어도 다시 보내지 않는다(두 번 나가지 않게)');
});

const att = (id, name, size) => ({ mimeType: 'application/pdf', filename: name, body: { attachmentId: id, size } });
test('전달: 원본 메일의 첨부를 서버가 받아 다시 싣는다(keep에 든 것만), 받는 사람이 없으면 보내지 않는다, 초안이 있으면 보낸 뒤 지운다', async () => {
  const sent = [];
  gmail = (c) => {
    if (c.path === '/messages/orig' && c.q.get('format') === 'full') return ok({ id: 'orig', payload: { mimeType: 'multipart/mixed', parts: [{ mimeType: 'text/plain', body: { data: Buffer.from('hi').toString('base64url') } }, att('A1', '견적.pdf', 3), att('A2', 'skip.pdf', 4)] } });
    if (c.path === '/messages/orig/attachments/A1') return ok({ data: Buffer.from('PDF').toString('base64url') });
    if (c.path === '/messages/send') { sent.push(JSON.parse(c.init.body)); return ok({ id: 'S1' }); }
    if (c.method === 'DELETE') return new Response(null, { status: 204 });
    return new Response('{}', { status: 404 });
  };
  assert.equal((await post('send', { account: 'acc', to: ' ', subject: 's', text: 't' })).status, 400);
  const r = await post('send', { account: 'acc', to: 'b@x.com', subject: 'Fwd: 견적', text: '전달합니다', html: '<p>전달합니다</p>', draftId: 'D9', carry: { from: 'message', id: 'orig' }, keep: [{ name: '견적.pdf', size: 3 }] });
  assert.equal(r.status, 200); assert.deepEqual(r.body, { id: 'S1' });
  const raw = Buffer.from(sent[0].raw, 'base64url').toString();
  assert.match(raw, /filename\*=UTF-8''%EA%B2%AC%EC%A0%81\.pdf/);
  assert.match(raw, new RegExp(Buffer.from('PDF').toString('base64')));
  assert.doesNotMatch(raw, /skip\.pdf/, 'keep에 없는 첨부는 싣지 않는다');
  assert.match(raw, /multipart\/alternative/, '글자·HTML 두 갈래');
  assert.ok(!calls.some((c) => c.path.endsWith('/attachments/A2')), '빼낸 첨부는 받지도 않는다');
  assert.ok(calls.some((c) => c.method === 'DELETE' && c.path === '/drafts/D9'));
  assert.equal((await post('send', { account: 'acc', to: 'b@x.com', carry: { from: 'message', id: '../x' } })).status, 400, '원본 id 형식');
});

test('큰 메시지(3MB 넘음)는 Gmail 올리기 주소(multipart/related — JSON 메타 + message/rfc822)로, 스레드도 함께', async () => {
  let up = null;
  gmail = (c) => { if (c.path === '@upload/messages/send') { up = c; return ok({ id: 'BIG' }); } return new Response('{}', { status: 404 }); };
  const data = Buffer.alloc(3.2 * 1024 * 1024, 7).toString('base64');
  const r = await post('send', { account: 'acc', to: 'b@x.com', subject: 's', text: 't', threadId: 'T1', attachments: [{ name: 'big.bin', type: 'application/octet-stream', data }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(up.q.get('uploadType'), 'multipart');
  assert.match(up.init.headers['content-type'], /^multipart\/related; boundary=argo-up-[0-9a-f]{16}$/);
  const body = Buffer.from(up.init.body).toString('latin1');
  assert.match(body, /Content-Type: application\/json; charset=UTF-8\r\n\r\n\{"threadId":"T1"\}\r\n/);
  assert.match(body, /Content-Type: message\/rfc822\r\n\r\n[\s\S]*To: b@x\.com/);
  assert.ok(!calls.some((c) => c.path === '/messages/send'), 'JSON raw 경로는 쓰지 않는다');
});

test('초안: 처음은 만들고(초안 id·메시지 id), 다음은 같은 초안을 고친다(스레드 유지), 초안 첨부는 초안에서 다시 싣는다 · 바로 보내기·지우기', async () => {
  const seen = [];
  gmail = (c) => {
    seen.push(`${c.method} ${c.path}`);
    if (c.method === 'POST' && c.path === '/drafts') return ok({ id: 'D1', message: { id: 'g1' } });
    if (c.method === 'GET' && c.path === '/drafts/D1') return ok({ id: 'D1', message: { id: 'g1', payload: { mimeType: 'multipart/mixed', parts: [att('X1', 'a.pdf', 3)] } } });
    if (c.path === '/messages/g1/attachments/X1') return ok({ data: Buffer.from('AAA').toString('base64url') });
    if (c.method === 'PUT' && c.path === '/drafts/D1') { const b = JSON.parse(c.init.body); assert.equal(b.id, 'D1'); assert.equal(b.message.threadId, 'T7'); assert.match(Buffer.from(b.message.raw, 'base64url').toString(), /a\.pdf/); return ok({ id: 'D1', message: { id: 'g2' } }); }
    if (c.path === '/drafts/send') return ok({ id: 'S2' });
    if (c.method === 'DELETE' && c.path === '/drafts/GONE') return new Response('{}', { status: 404 });
    if (c.method === 'DELETE') return new Response(null, { status: 204 });
    return new Response('{}', { status: 404 });
  };
  assert.deepEqual((await post('draft', { account: 'acc', to: 'b@x.com', subject: 's', text: 't' })).body, { draftId: 'D1', gid: 'g1' });
  assert.deepEqual((await post('draft', { account: 'acc', draftId: 'D1', threadId: 'T7', to: 'b@x.com', subject: 's', text: 't2', carry: { from: 'draft', id: 'D1' }, keep: [{ name: 'a.pdf', size: 3 }] })).body, { draftId: 'D1', gid: 'g2' });
  assert.deepEqual((await post('draftSend', { account: 'acc', draftId: 'D1' })).body, { id: 'S2' });
  assert.deepEqual(JSON.parse(calls.find((c) => c.path === '/drafts/send').init.body), { id: 'D1' });
  assert.deepEqual((await post('draftDelete', { account: 'acc', draftId: 'GONE' })).body, { ok: true }, '이미 없는 초안은 성공');
  assert.equal((await post('draftDelete', { account: 'acc', draftId: 'a/b' })).status, 400);
  assert.equal((await post('draft', { account: 'acc', draftId: '../x', to: 'b' })).status, 400);
});

test('로그인 없이 부르면 401, 모르는 동작은 404, 바꾸는 동작은 GET으로 부를 수 없다', async () => {
  gmail = () => ok({});
  assert.equal((await post('sync', { accounts: [{ account: 'acc' }] }, null)).status, 401);
  assert.equal((await post('nope', {})).status, 404);
  assert.equal((await get('sync', { accounts: '[]' })).status, 405);
  assert.equal((await get('draftDelete', { account: 'acc', draftId: 'D1' })).status, 405);
});

// 이유(유건 10/9 "휴지통 삭제도"): Gmail 휴지통(30일 뒤 Gmail이 지운다)으로 옮기기·되돌리기 — 영구 삭제는 하지 않는다. 같은 요청을 다시 보내도 결과가 같아 요청 제한 때 한 번 다시.
// 이미 없는 메일(404)을 휴지통으로 = 성공(이미 사라졌다), 되돌리기 404는 실패(돌아오지 않았다).
test('휴지통: on이면 messages/{id}/trash, 아니면 untrash — 영구 삭제(DELETE)는 부르지 않는다', async () => {
  gmail = () => ok({});
  assert.equal((await post('trash', { account: 'acc', id: 'm1', on: true })).status, 200);
  assert.equal((await post('trash', { account: 'acc', id: 'm2', on: false })).status, 200);
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), ['POST /messages/m1/trash', 'POST /messages/m2/untrash']);
  assert.ok(calls.every((c) => c.method !== 'DELETE'));
  calls = [];
  gmail = () => new Response('{}', { status: 404 });
  assert.equal((await post('trash', { account: 'acc', id: 'gone', on: true })).status, 200, '이미 없으면 성공');
  assert.notEqual((await post('trash', { account: 'acc', id: 'gone', on: false })).status, 200, '되돌리기 404는 실패');
  assert.equal((await post('trash', { account: 'acc', id: 'x/../y', on: true }, null)).status, 401, '로그인 없이는 못 부른다');
  calls = [];
  for (const bad of [{ id: '..', on: true }, { on: true }, { id: 'x/../y', on: true }, { id: 'm1', on: 'false' }, { id: 'm1', on: null }]) {
    assert.equal((await post('trash', { account: 'acc', ...bad })).status, 400, `입력 검증(검수 #899): ${JSON.stringify(bad)}`);
  }
  assert.deepEqual(calls, [], '잘못된 입력은 Gmail을 부르지 않는다');
});

// 이유(10/9 휴지통 메일함): 휴지통 목록은 TRASH 라벨로 받는다 — 받은 메일은 'trash'.
test('목록: 휴지통 메일함 = labelIds TRASH', async () => {
  gmail = (c) => (c.path === '/messages' ? ok({ messages: [{ id: 'm1' }] }) : c.q.get('format') === 'metadata' ? ok(meta('m1', ['TRASH', 'INBOX'])) : new Response('{}', { status: 404 }));
  const r = await post('list', { account: 'acc', folder: 'trash' });
  assert.equal(calls.find((c) => c.path === '/messages').q.get('labelIds'), 'TRASH');
  assert.equal(calls.find((c) => c.path === '/messages').q.get('includeSpamTrash'), 'true');
  assert.equal(r.body.items[0].folder, 'trash');
});
