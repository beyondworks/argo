// 화면 쪽 R2 모듈(src/core/r2.js) — 올리기 순서(upload-url → PUT → commit), 서명 주소·내용 캐시(같은 파일을 다시 열면 서버·R2를 부르지 않는다),
// 만료 주소 한 번 다시 받기, 지우기 요청 묶음. 가짜 서버 함수·가짜 R2는 fetch 자리에서 대신한다.
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const r2 = await import('../src/core/r2.js');
let calls, routes;
beforeEach(() => {
  calls = []; routes = {};
  r2.r2Deps.jwt = async () => 'jwt-1';
  r2.r2Deps.fetch = async (url, init = {}) => {
    const u = String(url), op = /\/api\/storage\/([\w-]+)/.exec(u)?.[1];
    calls.push({ op: op ?? (init.method ?? 'GET'), url: u, init, body: init.body && op ? JSON.parse(init.body) : null });
    const h = routes[op ?? `${init.method ?? 'GET'} ${u}`];
    if (!h) return new Response('{"error":"nope"}', { status: 404 });
    const out = await h(calls.at(-1));
    return out instanceof Response ? out : new Response(JSON.stringify(out));
  };
});

test('올리기: 서버가 준 주소·헤더 그대로 PUT하고 commit까지, 서버 함수에는 로그인 토큰을 붙인다', async () => {
  routes['upload-url'] = () => ({ key: 'k1', url: 'https://r2.test/k1?sig', headers: { 'content-type': 'application/pdf', 'if-none-match': '*' } });
  routes['PUT https://r2.test/k1?sig'] = () => new Response(null, { status: 200 });
  routes.commit = () => ({ key: 'k1', bytes: 3 });
  await r2.putObject('k1', new Blob(['abc']));
  assert.deepEqual(calls.map((c) => c.op), ['upload-url', 'PUT', 'commit']);
  assert.deepEqual(calls[1].init.headers, { 'content-type': 'application/pdf', 'if-none-match': '*' });
  assert.equal(calls[0].init.headers.authorization, 'Bearer jwt-1');
  assert.equal(calls[1].init.headers.authorization, undefined, 'R2에는 로그인 토큰을 보내지 않는다');
  routes['PUT https://r2.test/k1?sig'] = () => new Response(null, { status: 412 });
  await assert.rejects(r2.putObject('k1', new Blob(['abc'])), (e) => e.code === 'file_conflict');
  routes['upload-url'] = () => new Response('{"error":"file_quota"}', { status: 507 });
  await assert.rejects(r2.putObject('k2', new Blob(['abc'])), (e) => e.code === 'file_quota');
  r2.r2Deps.jwt = async () => null;
  await assert.rejects(r2.putObject('k3', new Blob(['abc'])), (e) => e.code === 'task_signin');
});

test('열기: 같은 파일을 다시 열면 서버도 R2도 부르지 않는다, 여러 키는 한 번에 묻는다, 허락 안 된 키는 file_missing', async () => {
  routes['read-url'] = ({ body }) => ({ urls: Object.fromEntries(body.keys.filter((k) => k !== 'secret').map((k) => [k, `https://r2.test/${k}?sig`])), expiresIn: 600 });
  routes['GET https://r2.test/a?sig'] = () => new Response('AAA');
  assert.equal(await (await r2.objectBlob('a')).text(), 'AAA');
  const n = calls.length;
  assert.equal(await (await r2.objectBlob('a')).text(), 'AAA');
  assert.equal(calls.length, n, '두 번째 열기는 호출 0');
  const u = await r2.readUrls(['a', 'b', 'c', 'secret']);
  assert.deepEqual(Object.keys(u), ['a', 'b', 'c']);
  assert.deepEqual(calls.filter((c) => c.op === 'read-url').at(-1).body.keys, ['b', 'c', 'secret'], '캐시에 있는 주소는 다시 묻지 않는다');
  await assert.rejects(r2.objectBlob('secret'), (e) => e.code === 'file_missing');
});

test('만료된 주소로 R2가 거절하면 주소를 새로 받아 한 번만 다시 한다', async () => {
  let n = 0;
  routes['read-url'] = ({ body }) => ({ urls: { [body.keys[0]]: `https://r2.test/x?v${++n}` }, expiresIn: 600 });
  routes['GET https://r2.test/x?v1'] = () => new Response('', { status: 403 });
  routes['GET https://r2.test/x?v2'] = () => new Response('fresh');
  assert.equal(await (await r2.objectBlob('x')).text(), 'fresh');
  assert.equal(calls.filter((c) => c.op === 'read-url').length, 2);
  routes['read-url'] = () => ({ urls: { y: 'https://r2.test/y' } });
  routes['GET https://r2.test/y'] = () => new Response('', { status: 403 });
  await assert.rejects(r2.objectBlob('y'), (e) => e.code === 'storage');
  assert.equal(calls.filter((c) => c.op === 'GET' && c.url === 'https://r2.test/y').length, 2, '두 번까지만');
});

test('지우기: 50개씩 flush, 지운 키는 캐시에서도 빠진다, 서버 실패는 삼킨다(정리 크론이 다시)', async () => {
  routes['read-url'] = () => ({ urls: { z: 'https://r2.test/z' } });
  routes['GET https://r2.test/z'] = () => new Response('Z');
  await r2.objectBlob('z');
  routes.flush = ({ body }) => (body.keys.length > 50 ? new Response('{}', { status: 400 }) : { deleted: body.keys.length });
  await r2.flushKeys(['z', ...Array.from({ length: 60 }, (_, i) => `k${i}`)]);
  assert.deepEqual(calls.filter((c) => c.op === 'flush').map((c) => c.body.keys.length), [50, 11]);
  routes.flush = () => new Response('{"error":"r2"}', { status: 502 });
  await r2.flushKeys(['q']);
  const before = calls.length;
  await r2.objectBlob('z');
  assert.equal(calls.length, before + 2, '지운 키는 다시 열면 주소·내용을 새로 받는다');
});
