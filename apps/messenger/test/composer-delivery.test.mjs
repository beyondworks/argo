import test from 'node:test';
import assert from 'node:assert/strict';
import { createComposerDelivery, composerTransport, getComposerSession, clearComposerSessions, draftStore } from '../src/composer-delivery.mjs';

const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const file = (name) => ({ name, size: 4, type: 'text/plain' });
const transport = (overrides = {}) => ({ message: async () => 7, upload: async () => {}, attachment: async () => {}, ...overrides });

test('delayed send owns its snapshot and cannot clear the next draft; double click posts once', async () => {
  const wait = deferred(); let calls = 0;
  const session = createComposerDelivery(transport({ message: async () => { calls++; return wait.promise; } }));
  session.setText('first'); const sending = session.send([]);
  session.setText('next'); session.setFiles([file('next.txt')]);
  assert.equal(await session.send([]), false);
  wait.resolve(7); assert.equal(await sending, true);
  assert.equal(calls, 1); assert.equal(session.snapshot().text, 'next');
  assert.equal(session.snapshot().files[0].name, 'next.txt');
});

test('partial upload failure keeps failed File and retries only it on the original message', async () => {
  let messages = 0; const uploaded = []; const attached = []; let offline = true;
  const session = createComposerDelivery(transport({
    message: async () => { messages++; return 7; },
    upload: async (_job, item) => { uploaded.push(item.file.name); if (item.file.name === 'b.txt' && offline) throw Error('offline'); },
    attachment: async (job, item) => { attached.push([job.messageId, item.file.name]); },
  }));
  session.setFiles([file('a.txt'), file('b.txt')]);
  assert.equal(await session.send([]), false, 'attachment-only message accepted');
  assert.equal(session.snapshot().job.messageId, 7);
  assert.match(session.snapshot().job.error, /b.txt: offline/);
  session.setText('next draft'); offline = false;
  assert.equal(await session.retry(), true);
  assert.equal(messages, 1); assert.deepEqual(uploaded, ['a.txt', 'b.txt', 'b.txt']);
  assert.deepEqual(attached, [[7, 'a.txt'], [7, 'b.txt']]);
  assert.equal(session.snapshot().text, 'next draft');
});

test('metadata retry retains upload and stable attachment ID; unknown message result retains client ID', async () => {
  const ids = []; const attachmentIds = []; let failMessage = true; let failMeta = true; let uploads = 0;
  const session = createComposerDelivery(transport({
    message: async (job) => { ids.push(job.clientId); if (failMessage) throw Error('lost response'); return 9; },
    upload: async () => { uploads++; },
    attachment: async (_job, item) => { attachmentIds.push(item.id); if (failMeta) throw Error('metadata offline'); },
  }));
  session.setText('hello'); session.setFiles([file('x.txt')]);
  assert.equal(await session.send([]), false); failMessage = false;
  assert.equal(await session.retry(), false); failMeta = false;
  assert.equal(await session.retry(), true);
  assert.equal(new Set(ids).size, 1); assert.equal(new Set(attachmentIds).size, 1); assert.equal(uploads, 1);
});

test('channel navigation preserves draft and failed job, server/account keys isolate it; logout clears files', async () => {
  const one = getComposerSession('server/user/a', transport({ message: async () => { throw Error('offline'); } }));
  one.setText('unsent'); one.setFiles([file('private.txt')]); await one.send([]);
  one.setText('draft');
  assert.equal(getComposerSession('server/user/a', transport()), one);
  assert.equal(getComposerSession('server/user/b', transport()).snapshot().text, '');
  assert.equal(getComposerSession('other/user/a', transport()).snapshot().job, null);
  clearComposerSessions();
  assert.equal(one.snapshot().job, null);
  assert.equal(getComposerSession('server/user/a', transport()).snapshot().text, '');
  clearComposerSessions();
});

test('logout during message request stops attachment requests and late state delivery', async () => {
  const wait = deferred(); let uploads = 0;
  const session = createComposerDelivery(transport({ message: () => wait.promise, upload: async () => { uploads++; } }));
  session.setFiles([file('private.txt')]); const sending = session.send([]);
  session.dispose(); wait.resolve(8); await sending;
  assert.equal(uploads, 0); assert.equal(session.snapshot().job, null);
});

test('transport recovers committed responses and uses scoped message lookup and fixed storage path', async () => {
  const filters = []; const inserted = []; const paths = [];
  const client = {
    from(table) {
      let inserting = false;
      const query = {
        insert(row) { inserting = true; inserted.push([table, row]); return query; },
        select() { return query; }, eq(k, v) { filters.push([table, k, v]); return query; },
        single: async () => ({ error: { message: 'response lost' } }),
        maybeSingle: async () => ({ data: table === 'msgr_messages' ? { id: 7 } : { id: 'att-id', message_id: 7 } }),
        then(resolve) { resolve(inserting ? { error: { message: 'response lost' } } : { data: null }); },
      }; return query;
    },
    storage: { from: () => ({ upload: async (path) => { paths.push(path); return { error: { message: 'already exists' } }; },
      list: async (_prefix, { search }) => ({ data: [{ name: search }] }) }) },
    auth: { getSession: async () => ({ data: { session: { user: { id: 'user' } } } }), refreshSession: async () => assert.fail('응답 유실은 인증 실패가 아니다 — 갱신하지 않는다') },
  };
  const io = composerTransport(client, { orgId: 'org', chId: 'ch', uid: 'user' });
  const job = { clientId: 'stable-client', body: 'body', mentions: [] };
  job.messageId = await io.message(job);
  const item = { id: 'att-id', key: '0-test.txt', file: file('test.txt') };
  await io.upload(job, item); await io.attachment(job, item);
  assert.equal(job.messageId, 7);
  assert.ok(filters.some(([t, k, v]) => t === 'msgr_messages' && k === 'author_user_id' && v === 'user'));
  assert.ok(filters.some(([t, k, v]) => t === 'msgr_messages' && k === 'channel_id' && v === 'ch'));
  assert.ok(filters.some(([t, k, v]) => t === 'msgr_messages' && k === 'client_msg_id' && v === 'stable-client'));
  assert.equal(inserted[1][1].storage_path, paths[0]);
  assert.equal(inserted[1][1].id, 'att-id');
});

test('답글(D17) — 답글 대상은 그 한 번의 전송 job에 실리고 reply_to로 들어가며, 보낸 뒤 비워진다. 답글이 아니면 reply_to 키가 없다', async () => {
  const jobs = []; const session = createComposerDelivery(transport({ message: async (job) => { jobs.push(job); return 9; } }));
  session.setReplyTo({ id: 42, who: 'B', body: '원글' }); session.setText('답합니다');
  assert.equal(await session.send([]), true);
  assert.equal(jobs[0].replyTo, 42); assert.equal(session.snapshot().replyTo, null, '보낸 뒤 답글 대상 비움');
  session.setText('그냥 글'); await session.send([]); assert.equal(jobs[1].replyTo, null);
  const rows = []; const client = { from: () => ({ insert: (row) => { rows.push(row); return { select: () => ({ single: async () => ({ data: { id: 1 }, error: null }) }) }; } }) };
  const tr = composerTransport(client, { orgId: 'o', chId: 'c', uid: 'u' });
  await tr.message({ body: 'x', mentions: [], clientId: 'k1', replyTo: 42 }); await tr.message({ body: 'y', mentions: [], clientId: 'k2', replyTo: null });
  assert.equal(rows[0].reply_to, 42); assert.equal('reply_to' in rows[1], false, '옛 모양 그대로(답글이 아닐 때)');
});

// D50(2026-09-19 설치본 실측): 가린 동안 토큰 갱신이 네트워크 오류로 실패하면 supabase-js가 세션 없음으로 보고 익명 키로 insert → RLS 401 원문이 카드에 떴고,
// 실패 카드가 Enter를 막았다. 로컬 스택 재현: 갱신 fetch 실패 → getSession null → rest 요청 Authorization = 익명 키.
function authClient({ inserts, session = true, refresh = true }) {
  const calls = { insert: 0, refresh: 0, lookup: 0 }; let signedIn = session;
  return { calls, client: {
    from() { const q = { insert() { return q; }, select() { return q; }, eq() { return q; },
      single: async () => inserts[calls.insert++] ?? { data: { id: 99 } },
      maybeSingle: async () => { calls.lookup++; return { data: null }; } }; return q; },
    auth: { getSession: async () => ({ data: { session: signedIn ? { user: { id: 'user' } } : null } }),
      refreshSession: async () => { calls.refresh++; if (!refresh) return { data: { session: null }, error: { message: 'Load failed' } }; signedIn = true; return { data: { session: { user: { id: 'user' } } }, error: null }; } },
  } };
}
const RLS = 'new row violates row-level security policy for table "msgr_messages"';
test('D50: 세션이 비어 있으면(갱신 실패 상태) 또 갱신을 기다리게 하지 않고 세션 문구 키로 바로 실패한다', async () => {
  const { client, calls } = authClient({ session: false, inserts: [{ status: 401, error: { code: '42501', message: RLS } }] });
  const io = composerTransport(client, { orgId: 'org', chId: 'ch', uid: 'user' });
  await assert.rejects(io.message({ clientId: 'c1', body: 'b', mentions: [] }), (e) => e.uiKey === 'msg.delivery.authExpired');
  assert.deepEqual([calls.insert, calls.refresh, calls.lookup], [1, 0, 0]);
  const again = authClient({ session: false, inserts: [{ status: 401, error: { code: '42501', message: RLS } }] });
  const session = createComposerDelivery(composerTransport(again.client, { orgId: 'org', chId: 'ch', uid: 'user' })); session.setText('b');
  assert.equal(await session.send([]), false);
  assert.equal(session.snapshot().job.errorKey, 'msg.delivery.authExpired', '카드는 원문 대신 이 키로 문구를 고른다');
});
test('D50: 사람이 누른 전송은 insert 전에 supabase-js의 갱신 실패 캐시(60초)를 비운다 — 설치된 auth-js가 그 필드를 쓰는지도 잠근다', async () => {
  const { client } = authClient({ inserts: [{ data: { id: 13 } }] });
  client.auth.lastRefreshFailure = { refreshToken: 'x', result: { error: { name: 'AuthRetryableFetchError' } }, expiresAt: Date.now() + 60_000 };
  const from = client.from; client.from = (t) => { assert.equal(client.auth.lastRefreshFailure, null, 'insert의 토큰 조회가 실제 갱신을 시도하도록 먼저 비운다'); return from(t); };
  assert.equal(await composerTransport(client, { orgId: 'org', chId: 'ch', uid: 'user' }).message({ clientId: 'c5', body: 'b', mentions: [] }), 13);
  const { readFileSync } = await import('node:fs'); const { createRequire } = await import('node:module');
  const src = readFileSync(createRequire(import.meta.url).resolve('@supabase/auth-js/dist/module/GoTrueClient.js'), 'utf8');
  assert.match(src, /this\.lastRefreshFailure = \{/, 'auth-js가 갱신 실패 캐시 필드를 바꿨다 — D50 재시도가 60초 동안 헛돈다. 비우는 방법을 다시 본다');
});
test('D50: 세션은 있는데 서버가 토큰을 거절(401·PGRST303)하면 한 번 갱신 뒤 한 번만 다시 보낸다', async () => {
  const { client, calls } = authClient({ inserts: [{ status: 401, error: { code: 'PGRST303', message: 'JWT expired' } }, { data: { id: 12 } }] });
  assert.equal(await composerTransport(client, { orgId: 'org', chId: 'ch', uid: 'user' }).message({ clientId: 'c4', body: 'b', mentions: [] }), 12);
  assert.deepEqual([calls.insert, calls.refresh], [2, 1]);
  const dead = authClient({ refresh: false, inserts: [{ status: 401, error: { code: 'PGRST303', message: 'JWT expired' } }] });
  await assert.rejects(composerTransport(dead.client, { orgId: 'org', chId: 'ch', uid: 'user' }).message({ clientId: 'c6', body: 'b', mentions: [] }), (e) => e.uiKey === 'msg.delivery.authExpired');
  assert.deepEqual([dead.calls.insert, dead.calls.refresh], [1, 1]);
});
test('D50: 세션이 살아 있는 403 거절(진짜 권한 없음)은 갱신하지 않는다 — 원인 은폐·헛 갱신 방지', async () => {
  const { client, calls } = authClient({ inserts: [{ status: 403, error: { code: '42501', message: RLS } }] });
  const io = composerTransport(client, { orgId: 'org', chId: 'ch', uid: 'user' });
  await assert.rejects(io.message({ clientId: 'c3', body: 'b', mentions: [] }), (e) => !e.uiKey && /row-level security/.test(e.message));
  assert.deepEqual([calls.insert, calls.refresh, calls.lookup], [1, 0, 1]);
});

// 유건 2026-09-24: 새로고침(⌘R·당겨서)해도 쓰던 글이 남아야 한다. 앱을 끄면 사라지는 sessionStorage — 로그아웃은 전부 지운다.
const memStorage = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; }, m }; };

test('draft text, mentions and reply survive a reload (new session on the same storage); files do not', () => {
  const storage = memStorage();
  const before = createComposerDelivery(transport(), undefined, draftStore(storage, 'k1'));
  before.setText('쓰던 글'); before.setMentions([{ kind: 'crew', id: 'c1' }]); before.setReplyTo({ id: 5, who: '민수', body: 'hi' }); before.setFiles([file('a.txt')]);
  const after = createComposerDelivery(transport(), undefined, draftStore(storage, 'k1'));
  const s = after.snapshot();
  assert.equal(s.text, '쓰던 글'); assert.deepEqual(s.mentions, [{ kind: 'crew', id: 'c1' }]); assert.equal(s.replyTo.id, 5); assert.deepEqual(s.files, []);
  assert.equal(createComposerDelivery(transport(), undefined, draftStore(storage, 'k2')).snapshot().text, '', 'other channel key stays empty');
});

test('sending clears the saved draft; an emptied draft is removed, not stored as empty', async () => {
  const storage = memStorage();
  const one = createComposerDelivery(transport(), undefined, draftStore(storage, 'k1'));
  one.setText('보낼 글'); await one.send([]);
  assert.equal(storage.m.size, 0);
  one.setText('x'); one.setText('');
  assert.equal(storage.m.size, 0);
});

test('logout clears every saved draft; broken or unavailable storage never breaks the composer', () => {
  const storage = memStorage();
  storage.setItem('unrelated', 'keep');
  getComposerSession('server/user/a', transport(), storage).setText('비밀 초안');
  clearComposerSessions(storage);
  assert.deepEqual([...storage.m.keys()], ['unrelated']);
  storage.setItem(draftStore(storage, 'k9').id, '{not json');
  assert.equal(createComposerDelivery(transport(), undefined, draftStore(storage, 'k9')).snapshot().text, '');
  const throwing = { getItem() { throw Error('denied'); }, setItem() { throw Error('denied'); }, removeItem() { throw Error('denied'); }, key: () => null, length: 0 };
  const s = createComposerDelivery(transport(), undefined, draftStore(throwing, 'k1')); s.setText('ok');
  assert.equal(s.snapshot().text, 'ok');
  assert.equal(createComposerDelivery(transport(), undefined, draftStore(undefined, 'k1')).snapshot().text, '');
});

test('first session application (app start / reload) keeps saved drafts; null storage skips the wipe', () => {
  const storage = memStorage();
  getComposerSession('server/user/a', transport(), storage).setText('새로고침 전 글');
  clearComposerSessions(null); // App.applySession: 이전 소유자 없음 = 첫 적용
  assert.equal(getComposerSession('server/user/a', transport(), storage).snapshot().text, '새로고침 전 글');
  clearComposerSessions(storage);
});

// 검수 2026-09-24: 만료 세션으로 새로고침 → 다른 계정 로그인이면 이전 계정 초안이 남던 경로. 첫 적용은 지금 계정 초안만 남긴다.
test('first application keeps only the signing-in user\'s drafts; recipients-only drafts are saved too', () => {
  const storage = memStorage();
  getComposerSession(JSON.stringify(['srv', 'userA', 'org', 'ch']), transport(), storage).setText('A의 글');
  getComposerSession(JSON.stringify(['srv', 'userB', 'org', 'ch']), transport(), storage).setRecipients([{ id: 'u9' }]);
  storage.setItem('unrelated', 'keep');
  clearComposerSessions(storage, { keepUser: 'userB' });
  const keys = [...storage.m.keys()].sort();
  assert.equal(keys.length, 2); assert.ok(keys.includes('unrelated')); assert.ok(keys.some((k) => k.includes('userB')));
  clearComposerSessions(storage, { keepUser: null });
  assert.deepEqual([...storage.m.keys()], ['unrelated']);
});
