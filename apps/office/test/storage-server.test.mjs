// 파일 저장소 서버 함수(api/storage) — "서버는 DB 함수가 허락한 키만 서명한다"를 행동으로 잠근다.
// 가짜 Supabase(RPC 경로별 응답)와 엄격 가짜 R2(서명을 따로 계산 — test/helpers/fake-r2.mjs)로 올리기 → 확인 → 열기 → 지우기를 끝까지 돈다.
import test, { afterEach, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startFakeR2 } from './helpers/fake-r2.mjs';

const realFetch = globalThis.fetch;
const ENV_KEYS = ['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY', 'OFFICE_SUPABASE_SERVICE_KEY', 'R2_ENDPOINT', 'R2_OFFICE_BUCKET', 'R2_OFFICE_ACCESS_KEY_ID', 'R2_OFFICE_SECRET_ACCESS_KEY', 'R2_OFFICE_UPLOADS_OFF'];
let fake;
before(async () => { fake = await startFakeR2(); });
after(() => fake.close());
afterEach(() => { globalThis.fetch = realFetch; for (const k of ENV_KEYS) delete process.env[k]; });

/** Supabase 주소는 routes로, 나머지(가짜 R2)는 진짜 fetch로 */
function supabase(routes) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (!u.startsWith('http://sb/')) return realFetch(url, init);
    const fn = /rpc\/(\w+)/.exec(u)?.[1] ?? (u.includes('/auth/v1/user') ? 'auth' : u);
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ fn, body, auth: init.headers?.authorization });
    const h = routes[fn];
    if (!h) return new Response('{"message":"no route"}', { status: 404 });
    const out = await h(body);
    return out instanceof Response ? out : new Response(JSON.stringify(out));
  };
  Object.assign(process.env, { VITE_SUPABASE_URL: 'http://sb', VITE_SUPABASE_ANON_KEY: 'anon', OFFICE_SUPABASE_SERVICE_KEY: 'svc-key', ...fake.env });
  return calls;
}
const post = async (op, body, jwt = 'user-jwt') => {
  const { POST } = await import('../api/storage/[op].js');
  const r = await POST(new Request(`http://x/api/storage/${op}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(jwt ? { authorization: `Bearer ${jwt}` } : {}) }, body: JSON.stringify(body) }));
  return { status: r.status, body: await r.json() };
};
const KEY = 'o-11111111-1111-4111-8111-111111111111/files/22222222-2222-4222-8222-222222222222.pdf';

test('upload-url: DB가 준 키·크기·형식으로만 서명한다 — 요청한 키가 아니라 DB 결과의 키, 자리가 없으면 서명하지 않는다', async () => {
  const calls = supabase({ r2_object_pending_mine: ({ p_key }) => (p_key === KEY ? { key: KEY, bytes: 5, mime: 'application/pdf', state: 'pending' } : null) });
  const ok = await post('upload-url', { key: KEY });
  assert.equal(ok.status, 200);
  const u = new URL(ok.body.url);
  assert.equal(decodeURIComponent(u.pathname), `/${fake.bucket}/${KEY}`);
  assert.equal(u.searchParams.get('X-Amz-SignedHeaders'), 'content-length;content-type;host;if-none-match');
  assert.deepEqual(ok.body.headers, { 'content-type': 'application/pdf', 'if-none-match': '*' });
  assert.equal(calls[0].auth, 'Bearer user-jwt', '판정은 사용자 JWT로');
  // 남의 키·없는 키: DB가 null → 서명 없이 409
  const other = await post('upload-url', { key: 'o-x/files/stolen.pdf' });
  assert.deepEqual(other, { status: 409, body: { error: 'file_missing' } });
  // DB가 다른 키를 돌려주면(요청 키를 그대로 서명하지 않는다는 뜻) 서명은 DB 키로
  supabase({ r2_object_pending_mine: () => ({ key: KEY, bytes: 5, mime: 'application/pdf', state: 'pending' }) });
  const swapped = await post('upload-url', { key: 'u-me/files/whatever.pdf' });
  assert.equal(decodeURIComponent(new URL(swapped.body.url).pathname), `/${fake.bucket}/${KEY}`);
  assert.equal(swapped.body.key, KEY);
  supabase({ r2_object_pending_mine: () => ({ key: KEY, bytes: 5, mime: 'application/pdf', state: 'uploaded' }) });
  assert.equal((await post('upload-url', { key: KEY })).status, 409, '이미 확인된 객체에는 다시 올리는 주소를 주지 않는다');
});

test('끝까지: 서명 주소로 R2에 PUT → commit(HEAD 크기 = 자리 크기) → 서비스 키로 확인 기록 → read-url은 허락된 키만 → GET', async () => {
  fake.objects.clear();
  let state = 'pending';
  const calls = supabase({
    r2_object_pending_mine: () => ({ key: KEY, bytes: 5, mime: 'application/pdf', state }),
    r2_object_commit: (b) => { state = 'uploaded'; return { state, bytes: b.p_bytes }; },
    r2_object_read_grant: ({ p_keys }) => p_keys.filter((k) => k === KEY).map((key) => ({ key, mime: 'application/pdf' })),
  });
  const up = (await post('upload-url', { key: KEY })).body;
  const put = await realFetch(up.url, { method: 'PUT', headers: up.headers, body: new Uint8Array([1, 2, 3, 4, 5]) });
  assert.equal(put.status, 200);
  const c = await post('commit', { key: KEY });
  assert.deepEqual(c, { status: 200, body: { key: KEY, bytes: 5 } });
  const commitCall = calls.find((x) => x.fn === 'r2_object_commit');
  assert.equal(commitCall.auth, 'Bearer svc-key'); assert.equal(commitCall.body.p_bytes, 5, '크기는 서버가 HEAD로 본 값');
  assert.match(commitCall.body.p_etag, /^[0-9a-f]{32}$/);
  assert.deepEqual(await post('commit', { key: KEY }), { status: 200, body: { key: KEY, bytes: 5 } }, '다시 부르면 그대로(서비스 키 쓰기 없음)');
  assert.equal(calls.filter((x) => x.fn === 'r2_object_commit').length, 1);
  const r = await post('read-url', { keys: [KEY, 'o-other/files/secret.pdf'] });
  assert.deepEqual(Object.keys(r.body.urls), [KEY], '요청에 섞인 남의 키는 서명하지 않는다');
  const got = await realFetch(r.body.urls[KEY]);
  assert.deepEqual([...new Uint8Array(await got.arrayBuffer())], [1, 2, 3, 4, 5]);
  assert.ok(fake.log.filter((l) => l.key === KEY).every((l) => l.status === 'ok'));
});

test('commit 크기 불일치: R2 객체를 지우고 r2_object_fail → 409 file_size_mismatch, 아직 안 올라왔으면 409 file_missing(자리는 남긴다)', async () => {
  fake.objects.clear();
  const calls = supabase({ r2_object_pending_mine: () => ({ key: KEY, bytes: 5, mime: 'application/pdf', state: 'pending' }), r2_object_fail: () => 1, r2_object_commit: () => assert.fail('불일치면 확인 기록을 쓰지 않는다') });
  assert.deepEqual(await post('commit', { key: KEY }), { status: 409, body: { error: 'file_missing' } });
  assert.equal(calls.filter((x) => x.fn === 'r2_object_fail').length, 0, '없으면 자리를 지우지 않는다(다시 PUT 가능)');
  fake.objects.set(KEY, { bytes: Buffer.from('123456'), type: 'application/pdf', etag: 'e' }); // 서명을 비켜 들어온 다른 크기(방어선 두 번째)
  assert.deepEqual(await post('commit', { key: KEY }), { status: 409, body: { error: 'file_size_mismatch' } });
  assert.ok(!fake.objects.has(KEY), '다른 크기 객체는 지운다');
  const f = calls.find((x) => x.fn === 'r2_object_fail');
  assert.deepEqual(f.body, { p_keys: [KEY] }); assert.equal(f.auth, 'Bearer svc-key');
});

test('flush: DB가 지우기로 정한(deleting) 키만 R2에서 지우고 그 행만 잊는다, 로그인 없으면 401', async () => {
  fake.objects.clear();
  for (const k of ['a/1', 'a/2', 'a/keep']) fake.objects.set(k, { bytes: Buffer.from('x'), type: 'text/plain', etag: 'e' });
  const calls = supabase({ auth: () => ({ id: 'u1' }), r2_object_deleting: ({ p_keys }) => p_keys.filter((k) => k !== 'a/keep'), r2_object_forget: ({ p_keys }) => p_keys.length });
  assert.equal((await post('flush', { keys: ['a/1'] }, null)).status, 401);
  const r = await post('flush', { keys: ['a/1', 'a/2', 'a/keep'] });
  assert.deepEqual(r, { status: 200, body: { deleted: 2, left: 0 } });
  assert.ok(fake.objects.has('a/keep') && !fake.objects.has('a/1') && !fake.objects.has('a/2'));
  assert.deepEqual(calls.find((x) => x.fn === 'r2_object_forget').body.p_keys.sort(), ['a/1', 'a/2']);
  assert.equal((await post('flush', { keys: [] })).status, 400);
  assert.equal((await post('read-url', { keys: Array.from({ length: 51 }, (_, i) => `k${i}`) })).status, 400, '한 번에 50개까지');
});

test('설정 없음·긴급 차단·로그인 없음: R2 변수가 없으면 503 r2_not_configured, R2_OFFICE_UPLOADS_OFF=1이면 올리기만 503', async () => {
  supabase({ r2_object_pending_mine: () => ({ key: KEY, bytes: 5, mime: 'application/pdf', state: 'pending' }), r2_object_read_grant: () => [{ key: KEY, mime: 'application/pdf' }] });
  delete process.env.R2_OFFICE_SECRET_ACCESS_KEY;
  assert.deepEqual(await post('upload-url', { key: KEY }), { status: 503, body: { error: 'r2_not_configured' } });
  assert.deepEqual(await post('read-url', { keys: [KEY] }), { status: 503, body: { error: 'r2_not_configured' } });
  Object.assign(process.env, fake.env, { R2_OFFICE_UPLOADS_OFF: '1' });
  assert.deepEqual(await post('upload-url', { key: KEY }), { status: 503, body: { error: 'uploads_paused' } });
  assert.equal((await post('read-url', { keys: [KEY] })).status, 200, '열기는 그대로');
  assert.equal((await post('upload-url', { key: KEY }, null)).status, 401);
  assert.equal((await post('nope', {})).status, 404);
});

test('검수 9: 미리보기 대상이 아닌 형식(html·svg 등)은 내려받기(attachment)로 서명한다 — R2 주소를 직접 열어도 그 형식으로 열리지 않는다', async () => {
  fake.objects.clear();
  const H = 'u-me/files/a.html', P = 'u-me/files/b.pdf', S = 'u-me/files/c.svg';
  for (const [k, t] of [[H, 'text/html'], [P, 'application/pdf'], [S, 'image/svg+xml']]) fake.objects.set(k, { bytes: Buffer.from('x'), type: t, etag: 'e' });
  supabase({ r2_object_read_grant: () => [{ key: H, mime: 'text/html' }, { key: P, mime: 'application/pdf' }, { key: S, mime: 'image/svg+xml' }] });
  const { body } = await post('read-url', { keys: [H, P, S] });
  const disp = (k) => new URL(body.urls[k]).searchParams.get('response-content-disposition');
  assert.equal(disp(H), 'attachment'); assert.equal(disp(S), 'attachment'); assert.equal(disp(P), null, 'PDF·그림은 미리보기 그대로');
  const r = await realFetch(body.urls[H]);
  assert.equal(r.headers.get('content-disposition'), 'attachment', '가짜 R2도 실제 R2처럼 응답 헤더를 바꾼다(실측 10/2)');
  assert.equal(r.status, 200, '쿼리도 서명에 들어 있다');
});

test('검수 4: 만료된 자리(유예 중)에는 새 올리기 주소를 주지 않고, 확인(commit)만 받는다', async () => {
  fake.objects.clear();
  supabase({ r2_object_pending_mine: () => ({ key: KEY, bytes: 1, mime: 'application/pdf', state: 'pending', expired: true }), r2_object_commit: (b) => ({ state: 'uploaded', bytes: b.p_bytes }) });
  assert.deepEqual(await post('upload-url', { key: KEY }), { status: 409, body: { error: 'file_expired' } });
  fake.objects.set(KEY, { bytes: Buffer.from('1'), type: 'application/pdf', etag: 'e' });
  assert.deepEqual(await post('commit', { key: KEY }), { status: 200, body: { key: KEY, bytes: 1 } }, '느린 PUT은 유예 안에서 확인된다');
});
