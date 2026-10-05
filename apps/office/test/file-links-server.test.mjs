// 공유 링크 공개 서버 함수(api/files link·link-get, 15차) — 로그인 없이, 토큰이 권한. 엄격 가짜 R2(서명을 따로 계산)와 가짜 Supabase로:
// 형식이 틀린 토큰은 DB에 묻지 않는다 · DB에는 토큰의 SHA-256만 · 열 수 없는 이유는 모두 404 gone · R2 키는 밖에 내보내지 않는다 ·
// 내려받기는 DB가 준 키 하나로만 5분짜리 서명(원래 이름으로 내려받기).
import test, { afterEach, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { startFakeR2 } from './helpers/fake-r2.mjs';

const realFetch = globalThis.fetch;
const ENV_KEYS = ['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY', 'OFFICE_SUPABASE_SERVICE_KEY', 'R2_ENDPOINT', 'R2_OFFICE_BUCKET', 'R2_OFFICE_ACCESS_KEY_ID', 'R2_OFFICE_SECRET_ACCESS_KEY'];
const TOKEN = 'A'.repeat(20) + 'b_-'.repeat(7) + 'zz'; // 43자 base64url
const KEY = 'u-11111111-1111-4111-8111-111111111111/files/22222222-2222-4222-8222-222222222222.pdf';
const sha = (s) => createHash('sha256').update(s).digest('hex');
let fake;
before(async () => { fake = await startFakeR2(); });
after(() => fake.close());
afterEach(() => { globalThis.fetch = realFetch; for (const k of ENV_KEYS) delete process.env[k]; });

function supabase(open) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (!u.startsWith('http://sb/')) return realFetch(url, init);
    const body = JSON.parse(init.body);
    calls.push({ fn: /rpc\/(\w+)/.exec(u)?.[1], body, auth: init.headers?.authorization });
    const out = await open(body.p_hash);
    return out instanceof Response ? out : new Response(JSON.stringify(out));
  };
  Object.assign(process.env, { VITE_SUPABASE_URL: 'http://sb', VITE_SUPABASE_ANON_KEY: 'anon', OFFICE_SUPABASE_SERVICE_KEY: 'svc-key', ...fake.env });
  return calls;
}
const post = async (op, body, headers = {}) => {
  const { POST } = await import('../api/files/[op].js');
  const r = await POST(new Request(`http://x/api/files/${op}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }));
  return { status: r.status, body: await r.json() };
};
const row = { name: '도면 최종.pdf', size: 3, mime: 'application/pdf', key: KEY, expires_at: '2026-11-03T00:00:00Z', org: null };

test('링크 보기: 로그인 없이 이름·크기·형식·만료만 — R2 키는 돌려주지 않고, DB에는 토큰이 아니라 SHA-256을 서비스 키로 묻는다', async () => {
  const calls = supabase((h) => (h === sha(TOKEN) ? row : null));
  const r = await post('link', { token: TOKEN });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { name: '도면 최종.pdf', size: 3, mime: 'application/pdf', expiresAt: '2026-11-03T00:00:00Z', org: null });
  assert.ok(!JSON.stringify(r.body).includes(KEY), 'R2 키는 밖에 나가지 않는다');
  assert.deepEqual(calls.map((c) => [c.fn, c.body, c.auth]), [['office_file_link_open', { p_hash: sha(TOKEN) }, 'Bearer svc-key']]);
  assert.ok(!JSON.stringify(calls).includes(TOKEN), '토큰 원문은 DB로 가지 않는다');
});

test('열 수 없는 링크: 없는·만료·끊김·지운 파일(DB가 null) → 404 gone, 형식이 틀린 토큰은 DB에 묻지도 않는다, DB 오류 원문은 내보내지 않는다', async () => {
  const calls = supabase(() => null);
  assert.deepEqual(await post('link', { token: TOKEN }), { status: 404, body: { error: 'gone' } });
  assert.deepEqual(await post('link-get', { token: TOKEN }), { status: 404, body: { error: 'gone' } });
  const before = calls.length;
  for (const bad of ['short', `${TOKEN}/../x`, 'x'.repeat(65), null, 42]) assert.deepEqual(await post('link', { token: bad }), { status: 404, body: { error: 'gone' } }, String(bad));
  assert.equal(calls.length, before, '형식이 틀리면 DB를 부르지 않는다');
  supabase(() => new Response('permission denied for table office_file_links', { status: 500 }));
  assert.deepEqual(await post('link', { token: TOKEN }), { status: 502, body: { error: 'db' } });
});

test('내려받기: 누를 때마다 토큰을 다시 확인 → DB가 준 키 하나로 5분짜리 서명 주소(내려받기·원래 이름) → 그 주소로 그 파일만 받는다', async () => {
  fake.objects.clear();
  fake.objects.set(KEY, { bytes: Buffer.from('PDF'), type: 'application/pdf', etag: 'e' });
  fake.objects.set('u-11111111-1111-4111-8111-111111111111/files/other.pdf', { bytes: Buffer.from('NO'), type: 'application/pdf', etag: 'e2' });
  supabase((h) => (h === sha(TOKEN) ? row : null));
  const r = await post('link-get', { token: TOKEN });
  assert.equal(r.status, 200);
  const u = new URL(r.body.url);
  assert.equal(u.searchParams.get('X-Amz-Expires'), '300');
  assert.equal(r.body.expiresIn, 300);
  assert.equal(decodeURIComponent(u.pathname), `/${fake.bucket}/${KEY}`);
  assert.equal(u.searchParams.get('response-content-disposition'), `attachment; filename*=UTF-8''${encodeURIComponent('도면 최종.pdf')}`);
  const got = await realFetch(r.body.url);
  assert.equal(got.status, 200, '엄격 가짜 R2가 서명을 따로 계산해 받아들인다');
  assert.equal(Buffer.from(await got.arrayBuffer()).toString(), 'PDF');
  assert.match(got.headers.get('content-disposition'), /^attachment; filename\*=UTF-8''/);
  const swapped = new URL(r.body.url); swapped.pathname = `/${fake.bucket}/u-11111111-1111-4111-8111-111111111111/files/other.pdf`;
  assert.equal((await realFetch(swapped)).status, 403, '같은 서명으로 다른 파일은 열 수 없다');
});

test('공개 동작은 로그인 동작과 섞이지 않는다 — OCR은 여전히 로그인 필요, 설정이 없으면 503', async () => {
  supabase(() => row);
  assert.equal((await post('ocr', { id: 'x' })).status, 401);
  delete process.env.OFFICE_SUPABASE_SERVICE_KEY;
  assert.deepEqual(await post('link', { token: TOKEN }), { status: 503, body: { error: 'not_configured' } });
});
