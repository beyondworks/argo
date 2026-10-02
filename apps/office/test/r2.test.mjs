// R2 서명 모듈(server/r2.js) — AWS 문서 예시 값으로 서명 값을 잠그고, 엄격 가짜 R2(test/helpers/fake-r2.mjs — 서명을 따로 계산)로
// 실제 R2 실측(2026-10-02, scripts/r2-smoke.mjs)과 같은 거절을 확인한다: 다른 크기·다른 형식·두 번째 PUT·만료 주소.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { presignUrl, r2Client, r2FromEnv, checkKey, eachLimited } from '../server/r2.js';
import { startFakeR2 } from './helpers/fake-r2.mjs';

// AWS 공식 문서 "Authenticating Requests: Using Query Parameters" 예시(실제 키가 아니라 문서의 예시 값이다)
test('서명 값: AWS 문서의 서명 주소 예시와 같다(GET, 86400초, 2013-05-24)', async () => {
  const url = await presignUrl({ url: 'https://examplebucket.s3.amazonaws.com/test.txt', method: 'GET', expires: 86400, region: 'us-east-1', datetime: '20130524T000000Z',
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' });
  const q = new URL(url).searchParams;
  assert.equal(q.get('X-Amz-Signature'), 'aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404');
  assert.equal(q.get('X-Amz-SignedHeaders'), 'host');
  assert.equal(q.get('X-Amz-Credential'), 'AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request');
});

let fake;
before(async () => { fake = await startFakeR2({ origins: ['http://localhost:5190'] }); });
after(() => fake.close());

test('PUT 서명 주소: 형식·크기·if-none-match를 서명에 넣고(5분), 브라우저에 보낼 헤더에는 크기를 넣지 않는다', async () => {
  const r2 = r2Client(fake.config);
  const p = await r2.presign({ method: 'PUT', key: 'o-1/files/a.pdf', contentType: 'application/pdf', contentLength: 5 });
  const q = new URL(p.url).searchParams;
  assert.equal(q.get('X-Amz-SignedHeaders'), 'content-length;content-type;host;if-none-match');
  assert.equal(q.get('X-Amz-Expires'), '300');
  assert.deepEqual(p.headers, { 'content-type': 'application/pdf', 'if-none-match': '*' });
  const g = await r2.presign({ method: 'GET', key: 'o-1/files/a.pdf' });
  assert.equal(new URL(g.url).searchParams.get('X-Amz-Expires'), '600');
  assert.equal(new URL(g.url).pathname, `/${fake.bucket}/o-1/files/a.pdf`);
});

test('만료·키 검사: 1~3600초만, 앞 슬래시·..·빈 칸·제어 문자·1024바이트 넘는 키는 거절', async () => {
  const r2 = r2Client(fake.config);
  for (const expires of [0, 3601, 1.5]) await assert.rejects(r2.presign({ method: 'GET', key: 'a', expires }), (e) => e.code === 'expires');
  for (const k of ['', '/a', 'a/../b', 'a//b', 'a\u0000b', 'a\\b', 'k'.repeat(1025)]) assert.throws(() => checkKey(k), (e) => e.code === 'key', JSON.stringify(k.slice(0, 10)));
  assert.equal(checkKey('o-1/esign/2/s-3-0-abc.png'), 'o-1/esign/2/s-3-0-abc.png');
  await assert.rejects(r2.presign({ method: 'DELETE', key: 'a' }), (e) => e.code === 'method', '브라우저용 서명은 GET·PUT만');
  assert.throws(() => r2FromEnv({ R2_ENDPOINT: 'x' }), (e) => e.status === 503 && e.code === 'r2_not_configured');
});

test('가짜 R2(실측과 같은 규칙): 같은 크기 200 → 다른 크기·다른 형식 403 → 두 번째 PUT 412 → 만료 403', async () => {
  const r2 = r2Client(fake.config);
  const put = async (key, len, body, type = 'application/pdf', headerType) => {
    const p = await r2.presign({ method: 'PUT', key, contentType: type, contentLength: len });
    return fetch(p.url, { method: 'PUT', headers: { ...p.headers, ...(headerType ? { 'content-type': headerType } : {}) }, body: new Uint8Array(body) });
  };
  assert.equal((await put('t/a.pdf', 3, 3)).status, 200);
  assert.equal((await put('t/b.pdf', 3, 4)).status, 403, '서명보다 크면 거절');
  assert.equal((await put('t/c.pdf', 3, 2)).status, 403, '서명보다 작으면 거절');
  assert.equal((await put('t/d.pdf', 3, 3, 'application/pdf', 'image/png')).status, 403, '다른 형식');
  assert.ok(!fake.objects.has('t/b.pdf') && !fake.objects.has('t/c.pdf') && !fake.objects.has('t/d.pdf'));
  const twice = await put('t/a.pdf', 3, 3);
  assert.equal(twice.status, 412, '이미 있는 키에는 다시 못 쓴다');
  const old = await presignUrl({ url: `${fake.endpoint}/${fake.bucket}/t/a.pdf`, method: 'GET', expires: 60, datetime: '20200101T000000Z', ...fake.config });
  assert.equal((await fetch(old)).status, 403, '만료 주소');
});

// 이유(운영 결함 10/3): Node fetch는 기본으로 accept-encoding: gzip을 보내고, R2는 text/*·json을 gzip으로 답하며 Content-Length를 뺀다.
// 그러면 HEAD 크기가 NaN이 되어 commit이 file_size_mismatch로 거절된다(운영 문서함에서 .txt 올리기 실패). PDF만 쓴 시험은 이 경우를 못 봤다.
test('HEAD 크기는 압축 대상 형식(text·json)에서도 정확하다 — 서버는 accept-encoding: identity로 묻는다', async () => {
  const r2 = r2Client(fake.config);
  for (const [k, type] of [['g/a.txt', 'text/plain'], ['g/b.json', 'application/json'], ['g/c.csv', 'text/csv'], ['g/d.pdf', 'application/pdf']]) {
    await r2.put(k, new TextEncoder().encode('x'.repeat(73)), { contentType: type });
    assert.equal((await r2.head(k)).bytes, 73, type);
    await r2.del(k);
  }
});

test('서버 전용 요청(헤더 서명): put·head·get·del·list, 없는 키 HEAD는 null·DELETE는 성공', async () => {
  const r2 = r2Client(fake.config);
  const { etag } = await r2.put('s/x.png', new Uint8Array([1, 2, 3]), { contentType: 'image/png' });
  assert.match(etag, /^[0-9a-f]{32}$/);
  assert.deepEqual(await r2.head('s/x.png'), { bytes: 3, etag, mime: 'image/png' });
  assert.deepEqual([...await r2.get('s/x.png')], [1, 2, 3]);
  await assert.rejects(r2.put('s/x.png', new Uint8Array([9]), { ifNoneMatch: true }), (e) => e.code === 'file_conflict');
  await r2.put('s/x.png', new Uint8Array([9]), { contentType: 'image/png' }); // 덮어쓰기(서명본 다시 만들기)
  assert.equal((await r2.head('s/x.png')).bytes, 1);
  assert.deepEqual(await r2.list('s/'), ['s/x.png']);
  assert.equal(await r2.del('s/x.png'), true);
  assert.equal(await r2.del('s/x.png'), true, '없는 키도 성공');
  assert.equal(await r2.head('s/x.png'), null);
  await assert.rejects(r2.get('s/x.png'), (e) => e.code === 'missing_file');
  assert.ok(fake.log.filter((l) => l.key.startsWith('s/')).every((l) => l.auth === 'header' && l.status === 'ok'));
  const wrong = r2Client({ ...fake.config, secretAccessKey: 'other' });
  await assert.rejects(wrong.get('t/a.pdf'), (e) => e.code === 'r2', '다른 비밀 키는 거절');
});

test('CORS(가짜 버킷): 허용 출처만 사전 요청 204, 아니면 403', async () => {
  const pre = (origin) => fetch(`${fake.endpoint}/${fake.bucket}/t/a.pdf`, { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'PUT', 'access-control-request-headers': 'content-type,if-none-match' } });
  assert.equal((await pre('http://localhost:5190')).status, 204);
  assert.equal((await pre('https://evil.example')).status, 403);
});

test('여러 키를 n개씩: 실패한 키만 false', async () => {
  const out = await eachLimited(['a', 'b', 'c'], 2, async (k) => { if (k === 'b') throw new Error('x'); });
  assert.deepEqual([...out], [['a', true], ['b', false], ['c', true]]);
});

test('로컬 실측·한 바퀴는 개발 버킷만: R2_OFFICE_DEV_* 를 앱 이름으로 옮기고, 운영 버킷(argo-office)이면 거절', async () => {
  const { devR2Env } = await import('../scripts/r2-dev-env.mjs');
  const base = { R2_ENDPOINT: 'https://x.r2.cloudflarestorage.com', R2_OFFICE_DEV_ACCESS_KEY_ID: 'devid', R2_OFFICE_DEV_SECRET_ACCESS_KEY: 'devsecret', R2_OFFICE_BUCKET: 'argo-office', R2_OFFICE_ACCESS_KEY_ID: 'prodid', R2_OFFICE_SECRET_ACCESS_KEY: 'prodsecret' };
  assert.deepEqual(devR2Env({ ...base, R2_OFFICE_DEV_BUCKET: 'argo-office-dev' }),
    { R2_ENDPOINT: base.R2_ENDPOINT, R2_OFFICE_BUCKET: 'argo-office-dev', R2_OFFICE_ACCESS_KEY_ID: 'devid', R2_OFFICE_SECRET_ACCESS_KEY: 'devsecret' }, '운영 키는 쓰지 않는다');
  assert.throws(() => devR2Env({ ...base, R2_OFFICE_DEV_BUCKET: 'argo-office' }), /운영 버킷/);
  assert.throws(() => devR2Env({ ...base, R2_OFFICE_DEV_BUCKET: ' Argo-Office ' }), /운영 버킷/);
  assert.throws(() => devR2Env({ ...base, R2_OFFICE_DEV_BUCKET: '' }), /R2_OFFICE_DEV_/, '개발 변수가 없으면 운영 변수로 넘어가지 않는다');
  assert.throws(() => devR2Env({ ...base, R2_OFFICE_DEV_BUCKET: 'argo-office-dev', R2_OFFICE_DEV_ACCESS_KEY_ID: 'prodid' }), /운영 키/, '개발 이름에 운영 키를 넣어도 거절');
});
