// 문서함·드라이브 서버(유건 10/2) — 순수 함수와 서버 함수 흐름(가짜 구글·가짜 Supabase·가짜 OCR).
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { listRequest, mapFile, mapDrive, exportFormat, importable, exportName, quoteQ, validId, scopesFor, hasScope, multipartBody, READ_SCOPE, WRITE_SCOPE } from '../server/drive.js';
import { ocrBytes, ocrProvider, sidecarUrl } from '../server/ocr.js';
import { seal } from '../server/seal.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; for (const k of ['OFFICE_OCR_URL', 'OFFICE_OCR_KEY', 'OFFICE_VISION_API_KEY', 'OFFICE_GOOGLE_CLIENT_ID', 'OFFICE_GOOGLE_CLIENT_SECRET', 'OFFICE_MAIL_KEY', 'VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY', 'OFFICE_SUPABASE_SERVICE_KEY', 'CRON_SECRET', 'R2_ENDPOINT', 'R2_OFFICE_BUCKET', 'R2_OFFICE_ACCESS_KEY_ID', 'R2_OFFICE_SECRET_ACCESS_KEY', 'R2_OFFICE_UPLOADS_OFF']) delete process.env[k]; });

test('드라이브 목록 요청: q > folder > view, 따옴표 이스케이프, 공유 드라이브는 drives', () => {
  assert.equal(quoteQ("a'b\\c"), "'a\\'b\\\\c'");
  const s = listRequest({ q: "김's 견적", folder: 'abc', view: 'starred' });
  assert.equal(s.params.q, "name contains '김\\'s 견적' and trashed = false");
  assert.equal(s.params.corpora, 'user');
  assert.equal(listRequest({ folder: 'F1_x-2' }).params.q, "'F1_x-2' in parents and trashed = false");
  assert.throws(() => listRequest({ folder: "x' or '1'='1" }), (e) => e.code === 'input'); // 폴더 id로 쿼리를 깨지 못한다
  assert.equal(listRequest({ view: 'home' }).params.orderBy, 'viewedByMeTime desc');
  assert.equal(listRequest({ view: 'shared' }).params.q, 'sharedWithMe = true and trashed = false');
  assert.equal(listRequest({ view: 'drives' }).path, '/drives');
  assert.equal(listRequest({ view: '??' }).params.q, "'root' in parents and trashed = false");
  assert.equal(listRequest({ view: 'starred', page: 'p2' }).params.pageToken, 'p2');
});

test('파일 줄: 바로가기는 대상으로, 공유 드라이브는 폴더처럼, 구글 문서류는 내보내기 형식', () => {
  const f = mapFile({ id: 's1', name: '바로가기', mimeType: 'application/vnd.google-apps.shortcut', shortcutDetails: { targetId: 't1', targetMimeType: 'application/pdf' }, size: '2048', owners: [{ displayName: '최민지' }] });
  assert.deepEqual([f.id, f.mimeType, f.size, f.owners, f.isFolder], ['t1', 'application/pdf', 2048, '최민지', false]);
  assert.equal(mapDrive({ id: 'd1', name: '팀' }).isFolder, true);
  assert.deepEqual(exportFormat('application/vnd.google-apps.document'), { mime: 'application/pdf', ext: '.pdf' });
  assert.equal(exportFormat('application/vnd.google-apps.form'), null);
  assert.equal(importable({ mimeType: 'application/vnd.google-apps.form' }), false); // 양식은 링크만
  assert.equal(importable({ mimeType: 'application/pdf' }), true);
  assert.equal(importable({ isFolder: true, mimeType: 'application/vnd.google-apps.folder' }), false);
  assert.equal(exportName('제안서', '.pdf'), '제안서.pdf'); assert.equal(exportName('표.xlsx', '.xlsx'), '표.xlsx');
  assert.ok(validId('1AbC_d-9')); assert.ok(!validId('../x'));
});

test('권한: 기본 읽기 전용, 보내기를 켤 때만 drive.file', () => {
  assert.deepEqual(scopesFor(false), [READ_SCOPE]);
  assert.deepEqual(scopesFor(true), [READ_SCOPE, WRITE_SCOPE]);
  assert.ok(hasScope(`openid ${READ_SCOPE}`, READ_SCOPE)); assert.ok(!hasScope(READ_SCOPE, WRITE_SCOPE));
});

test('여러 부분 업로드 본문: 메타데이터 다음 파일 바이트', () => {
  const { body, type } = multipartBody({ name: 'a.pdf', parents: ['root'] }, Buffer.from('PDF'), 'application/pdf', 'BND');
  assert.equal(type, 'multipart/related; boundary=BND');
  const s = body.toString();
  assert.ok(s.startsWith('--BND\r\nContent-Type: application/json')); assert.ok(s.includes('"parents":["root"]')); assert.ok(s.endsWith('PDF\r\n--BND--'));
});

const KEY = 'k'.repeat(32);
test('서버 OCR 설정(유건 10/2 — PaddleOCR 사이드카만, 문서를 구글로 보내지 않는다): https 또는 루프백 + 키가 있어야 켜진다', () => {
  assert.equal(ocrProvider({}), null);
  assert.equal(ocrProvider({ OFFICE_VISION_API_KEY: 'v' }), null, 'Vision 키만으로는 켜지지 않는다(구글 경로 없음)');
  assert.equal(ocrProvider({ OFFICE_OCR_URL: 'https://ocr.example.com' }), null, '키 없이는 끈다');
  assert.equal(ocrProvider({ OFFICE_OCR_URL: 'http://ocr.example.com', OFFICE_OCR_KEY: KEY }), null, '평문 http는 루프백만');
  assert.equal(ocrProvider({ OFFICE_OCR_URL: 'https://u:p@ocr.example.com', OFFICE_OCR_KEY: KEY }), null, '주소에 계정 정보 금지');
  assert.equal(ocrProvider({ OFFICE_OCR_URL: 'https://ocr.example.com', OFFICE_OCR_KEY: 'short' }), null, '짧은 키는 거절');
  assert.equal(ocrProvider({ OFFICE_OCR_URL: 'https://ocr.example.com/', OFFICE_OCR_KEY: KEY }), 'sidecar');
  assert.equal(ocrProvider({ OFFICE_OCR_URL: 'http://127.0.0.1:8765', OFFICE_OCR_KEY: KEY }), 'sidecar');
  assert.equal(sidecarUrl({ OFFICE_OCR_URL: 'https://ocr.example.com/base/', OFFICE_OCR_KEY: KEY }), 'https://ocr.example.com/base/ocr-bytes');
});

test('서버 OCR 호출: 사이드카 바이트 끝점(Bearer 키·원본 바이트·파일 이름), 대상 아님·설정 없음', async () => {
  await assert.rejects(ocrBytes({ bytes: Buffer.from('x'), mime: 'image/png' }, {}), (e) => e.status === 503);
  await assert.rejects(ocrBytes({ bytes: Buffer.from('x'), mime: 'image/png' }, { OFFICE_VISION_API_KEY: 'v' }), (e) => e.status === 503);
  const env = { OFFICE_OCR_URL: 'https://ocr.example.com/', OFFICE_OCR_KEY: KEY };
  await assert.rejects(ocrBytes({ bytes: Buffer.from('x'), mime: 'text/plain', name: 'a.txt' }, env), (e) => e.code === 'unsupported');
  let seen;
  const text = await ocrBytes({ bytes: Buffer.from('%PDF-1.4'), mime: 'application/pdf', name: '계약서.pdf' }, env,
    async (url, init) => { seen = { url, init }; return new Response(JSON.stringify({ text: '1쪽\n\n2쪽\n\n7쪽' })); });
  assert.equal(text, '1쪽\n\n2쪽\n\n7쪽');
  assert.equal(seen.url, 'https://ocr.example.com/ocr-bytes');
  assert.equal(seen.init.headers.authorization, `Bearer ${KEY}`);
  assert.equal(seen.init.headers['content-type'], 'application/octet-stream');
  assert.equal(decodeURIComponent(seen.init.headers['x-file-name']), '계약서.pdf');
  assert.equal(Buffer.from(seen.init.body).toString(), '%PDF-1.4'); // 원본 바이트 그대로(쪽 수 제한 없이 사이드카가 전부 읽는다)
  await assert.rejects(ocrBytes({ bytes: Buffer.from('x'), mime: 'image/png' }, env, async () => new Response('no', { status: 401 })), (e) => e.code === 'ocr');
});

/** 가짜 Supabase·구글 — 경로별 응답. 가짜 R2(127.0.0.1) 요청은 진짜 fetch로 보낸다 */
function fake(routes) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith('http://127.0.0.1:') && !routes.some(([re]) => re.test(u))) return realFetch(url, init);
    calls.push({ url: u, init });
    for (const [re, fn] of routes) if (re.test(u)) return fn(u, init);
    return new Response('not found', { status: 404 });
  };
  return calls;
}
const req = (path, body, jwt = 'jwt-1') => new Request(`http://x${path}`, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });

test('api/files: 설정 상태, 문서함 파일 OCR → 그 사람 권한(office_file_get)이 준 키만 R2에서 받고 결과 저장', async () => {
  const { startFakeR2 } = await import('./helpers/fake-r2.mjs');
  const r2 = await startFakeR2();
  const files = await import('../api/files/[op].js');
  assert.deepEqual(await (await files.GET(new Request('http://x/api/files/config'))).json(), { ocr: null });
  assert.equal((await files.POST(req('/api/files/ocr', { org: null, id: '00000000-0000-0000-0000-000000000001' }))).status, 503);
  Object.assign(process.env, { OFFICE_OCR_URL: 'https://ocr.test', OFFICE_OCR_KEY: KEY, VITE_SUPABASE_URL: 'http://sb', VITE_SUPABASE_ANON_KEY: 'anon', ...r2.env });
  r2.objects.set('u-1/files/f.png', { bytes: Buffer.from('png'), type: 'image/png', etag: 'e' });
  let saved;
  const calls = fake([
    [/auth\/v1\/user/, () => new Response(JSON.stringify({ id: 'u1' }))],
    [/rpc\/office_ocr_take/, () => new Response('true')],
    [/rpc\/office_file_get/, () => new Response(JSON.stringify({ id: 'f', kind: 'file', storage_path: 'u-1/files/f.png', mime: 'image/png', filename: '명함.png' }))],
    [/ocr-bytes/, (u, init) => { assert.equal(Buffer.from(init.body).toString(), 'png'); return new Response(JSON.stringify({ text: '김민수 010-1234-5678' })); }],
    [/rpc\/office_file_write/, (u, init) => { saved = JSON.parse(init.body); return new Response('{"id":"f"}'); }],
  ]);
  const r = await files.POST(req('/api/files/ocr', { org: null, id: '00000000-0000-0000-0000-000000000001' }));
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { status: 'done', text: '김민수 010-1234-5678' });
  assert.equal(saved.p_action, 'file.ocr'); assert.equal(saved.p_data.ocr_status, 'done');
  assert.equal(calls.find((c) => /office_file_get/.test(c.url)).init.headers.authorization, 'Bearer jwt-1', '받을 키는 요청자 권한으로 정한다');
  assert.deepEqual(r2.log.map((l) => [l.method, l.key, l.status]), [['HEAD', 'u-1/files/f.png', 'ok'], ['GET', 'u-1/files/f.png', 'ok']], '크기를 먼저 보고 받는다');
  r2.objects.set('u-1/files/f.png', { bytes: Buffer.alloc(20 * 1024 * 1024 + 1), type: 'image/png', etag: 'e' });
  assert.equal((await files.POST(req('/api/files/ocr', { org: null, id: '00000000-0000-0000-0000-000000000001' }))).status, 413, '20MB 넘으면 받지 않는다');
  assert.equal((await files.POST(new Request('http://x/api/files/ocr', { method: 'POST', body: '{}' }))).status, 401);
  await r2.close();
});

test('api/files ocr(HIGH 1): 바이트 경로도 로그인 확인 뒤에만 OCR — 가짜 토큰은 401, 사이드카에 닿지 않는다', async () => {
  const files = await import('../api/files/[op].js');
  Object.assign(process.env, { OFFICE_OCR_URL: 'http://127.0.0.1:8765', OFFICE_OCR_KEY: KEY, VITE_SUPABASE_URL: 'http://sb', VITE_SUPABASE_ANON_KEY: 'anon' });
  const calls = fake([
    [/auth\/v1\/user/, () => new Response('{"msg":"bad jwt"}', { status: 401 })],
    [/rpc\/office_ocr_take/, () => new Response('true')],
    [/ocr-bytes/, () => new Response(JSON.stringify({ text: '새면 안 됨' }))],
  ]);
  const r = await files.POST(req('/api/files/ocr', { data: Buffer.from('png').toString('base64'), name: 'a.png', mime: 'image/png' }, 'forged'));
  assert.equal(r.status, 401);
  assert.ok(!calls.some((c) => /ocr-bytes/.test(c.url)), '인증 전 OCR 호출 없음');
  assert.ok(!calls.some((c) => /office_ocr_take/.test(c.url)));
});

test('api/files ocr(HIGH 1): 사람마다 시간당 한도 — 넘으면 429, 사이드카에 닿지 않는다(바이트·문서함 경로 모두)', async () => {
  const files = await import('../api/files/[op].js');
  Object.assign(process.env, { OFFICE_OCR_URL: 'http://127.0.0.1:8765', OFFICE_OCR_KEY: KEY, VITE_SUPABASE_URL: 'http://sb', VITE_SUPABASE_ANON_KEY: 'anon' });
  const calls = fake([
    [/auth\/v1\/user/, () => new Response(JSON.stringify({ id: 'u1' }))],
    [/rpc\/office_ocr_take/, (u, init) => { assert.equal(init.headers.authorization, 'Bearer jwt-1'); return new Response('false'); }],
    [/ocr-bytes/, () => new Response(JSON.stringify({ text: 'x' }))],
  ]);
  const a = await files.POST(req('/api/files/ocr', { data: Buffer.from('png').toString('base64'), name: 'a.png', mime: 'image/png' }));
  assert.equal(a.status, 429); assert.deepEqual(await a.json(), { error: 'rate_limited' });
  const b = await files.POST(req('/api/files/ocr', { org: null, id: '00000000-0000-0000-0000-000000000001' }));
  assert.equal(b.status, 429);
  assert.ok(!calls.some((c) => /ocr-bytes/.test(c.url)));
});

test('api/drive: 설정 없음 503, 연결 안 됨 404, 목록·가져오기(구글 문서 → PDF 내보내기 → 자리 → R2 → 확인 → 등록)', async () => {
  const { startFakeR2 } = await import('./helpers/fake-r2.mjs');
  const r2 = await startFakeR2();
  const d = await import('../api/drive/[op].js');
  Object.assign(process.env, { VITE_SUPABASE_URL: 'http://sb', VITE_SUPABASE_ANON_KEY: 'anon', OFFICE_SUPABASE_SERVICE_KEY: 'svc-key', ...r2.env });
  fake([[/auth\/v1\/user/, () => new Response(JSON.stringify({ id: 'u1' }))]]);
  assert.equal((await d.POST(req('/api/drive/start', {}))).status, 503);
  const key = randomBytes(32);
  Object.assign(process.env, { OFFICE_GOOGLE_CLIENT_ID: 'cid', OFFICE_GOOGLE_CLIENT_SECRET: 'sec', OFFICE_MAIL_KEY: key.toString('base64') });
  const start = await (await d.POST(req('/api/drive/start', { write: false }))).json();
  const scope = new URL(start.url).searchParams.get('scope');
  assert.ok(scope.includes(READ_SCOPE) && !scope.includes(WRITE_SCOPE)); // 기본은 읽기 전용
  fake([[/rpc\/office_drive_secret/, () => new Response('[]')]]);
  assert.equal((await d.GET(req('/api/drive/list?view=mydrive'))).status, 404);
  const row = { user_id: 'u1', address: 'me@x.com', scopes: READ_SCOPE, status: 'ok', sealed: seal(key, 'r1', 'u1:drive:me@x.com'), access_sealed: seal(key, 'a1', 'u1:drive:me@x.com'), access_expires: new Date(Date.now() + 3600e3).toISOString() };
  let registered, uploaded;
  const order = [];
  fake([
    [/rpc\/office_drive_secret/, () => new Response(JSON.stringify([row]))],
    [/auth\/v1\/user/, () => new Response(JSON.stringify({ id: 'u1' }))],
    [/drive\/v3\/files\?/, (u, init) => { assert.equal(init.headers.authorization, 'Bearer a1'); return new Response(JSON.stringify({ files: [{ id: 'g1', name: '제안서', mimeType: 'application/vnd.google-apps.document' }] })); }],
    [/drive\/v3\/files\/g1\/export/, (u) => { assert.match(u, /mimeType=application%2Fpdf/); return new Response(Buffer.from('%PDF-1.4')); }],
    [/drive\/v3\/files\/g1\?/, () => new Response(JSON.stringify({ id: 'g1', name: '제안서', mimeType: 'application/vnd.google-apps.document' }))],
    [/rpc\/r2_object_commit/, (u, init) => { order.push('commit'); uploaded = { body: JSON.parse(init.body), auth: init.headers.authorization }; return new Response('{"state":"uploaded"}'); }],
    [/rpc\/office_file_write/, (u, init) => { const b = JSON.parse(init.body); order.push(b.p_action); if (b.p_action === 'file.create') { registered = b; return new Response('{"id":"x"}'); }
      assert.equal(b.p_data.size, Buffer.from('%PDF-1.4').length); assert.equal(b.p_data.storage_path, undefined, '키는 클라이언트(서버 함수)가 아니라 DB가 정한다');
      return new Response(JSON.stringify({ key: `u-u1/files/${b.p_data.id}.pdf` })); }],
  ]);
  const l = await (await d.GET(req('/api/drive/list?view=mydrive'))).json();
  assert.equal(l.files[0].name, '제안서');
  const out = await (await d.POST(req('/api/drive/import', { org: null, id: 'g1' }))).json();
  assert.equal(out.title, '제안서.pdf'); assert.equal(out.mime, 'application/pdf');
  const fkey = registered.p_data.storage_path;
  assert.match(fkey, /^u-u1\/files\/[0-9a-f-]{36}\.pdf$/);
  assert.equal(r2.objects.get(fkey).bytes.toString(), '%PDF-1.4', '서버가 R2에 직접 올렸다');
  assert.deepEqual(order, ['file.reserve', 'commit', 'file.create'], 'MEDIUM 1: 자리를 받은 뒤에만 올리고, 확인 기록 뒤 등록');
  assert.deepEqual([uploaded.body.p_key, uploaded.body.p_bytes, uploaded.auth], [fkey, 8, 'Bearer svc-key']);
  assert.equal(registered.p_data.source, 'drive'); assert.equal(registered.p_data.drive_id, 'g1');
  // 보내기는 drive.file이 없으면 need_write(화면이 쓰기 권한을 더 받는다)
  const e = await d.POST(req('/api/drive/export', { org: null, id: '00000000-0000-0000-0000-000000000001' }));
  assert.equal(e.status, 403); assert.deepEqual(await e.json(), { error: 'need_write' });
  assert.equal((await d.GET(req('/api/drive/import'))).status, 405); // 바꾸는 동작은 POST로만
  await r2.close();
});

test('api/files sweep(MEDIUM 1): 화면 없이 서버가 정리 — 크론 비밀 없으면 401, 서비스 키로 목록 → R2 삭제 → 지운 키의 행만 정리', async () => {
  const { startFakeR2 } = await import('./helpers/fake-r2.mjs');
  const r2 = await startFakeR2();
  try {
    const files = await import('../api/files/[op].js');
    const cron = (secret) => new Request('http://x/api/files/sweep', { headers: secret ? { authorization: `Bearer ${secret}` } : {} });
    Object.assign(process.env, { VITE_SUPABASE_URL: 'http://sb', VITE_SUPABASE_ANON_KEY: 'anon' });
    assert.equal((await files.GET(cron('s'.repeat(32)))).status, 503, '설정 없으면 돌지 않는다');
    Object.assign(process.env, { CRON_SECRET: 's'.repeat(32), OFFICE_SUPABASE_SERVICE_KEY: 'svc-key', ...r2.env });
    for (const k of ['o-1/files/a.pdf', 'u-2/docs/b/c.pdf', 'o-1/files/keep.pdf']) r2.objects.set(k, { bytes: Buffer.from('x'), type: 'application/pdf', etag: 'e' });
    let forgot;
    const calls = [];
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      if (!u.startsWith('http://sb/')) return realFetch(url, init);
      calls.push({ url: u, init });
      if (/rpc\/office_storage_sweep$/.test(u)) return new Response(JSON.stringify({ keys: ['o-1/files/a.pdf', 'u-2/docs/b/c.pdf', 'o-1/files/gone.pdf'] }));
      if (/rpc\/r2_object_forget$/.test(u)) { forgot = JSON.parse(init.body).p_keys; return new Response(String(forgot.length)); }
      return new Response('not found', { status: 404 });
    };
    assert.equal((await files.GET(cron('wrong'))).status, 401);
    assert.equal((await files.GET(cron())).status, 401);
    assert.equal(calls.length, 0, '비밀이 틀리면 아무것도 부르지 않는다');
    const r = await files.GET(cron('s'.repeat(32)));
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { objects: 3, left: 0, rows: 3 }, '없는 키 DELETE도 성공(실측 204)');
    assert.deepEqual([...r2.objects.keys()], ['o-1/files/keep.pdf']);
    assert.deepEqual(forgot.sort(), ['o-1/files/a.pdf', 'o-1/files/gone.pdf', 'u-2/docs/b/c.pdf']);
    assert.ok(calls.every((c) => c.init.headers.authorization === 'Bearer svc-key'));
  } finally { await r2.close(); }
});

test('정리 실행기: R2 삭제가 실패한 키는 행 정리에서 뺀다(deleting으로 남아 다음 날 다시)', async () => {
  const { sweepStorage } = await import('../server/sweep.js');
  let forgot = null;
  const f = async (url, init = {}) => { if (/office_storage_sweep$/.test(url)) return new Response(JSON.stringify({ keys: ['a/ok', 'a/bad'] })); forgot = JSON.parse(init.body).p_keys; return new Response('1'); };
  const r2 = { del: async (k) => { if (k === 'a/bad') throw new Error('boom'); return true; } };
  assert.deepEqual(await sweepStorage({ url: 'http://sb', key: 'k', r2 }, f), { objects: 1, left: 1, rows: 1 });
  assert.deepEqual(forgot, ['a/ok']);
  const none = async (url) => { assert.match(url, /office_storage_sweep$/, '지울 것이 없으면 forget을 부르지 않는다'); return new Response('{"keys":[]}'); };
  assert.deepEqual(await sweepStorage({ url: 'http://sb', key: 'k', r2 }, none), { objects: 0, left: 0, rows: 0 });
});

/** 드라이브 가져오기 공통 준비 — 구글 문서 하나, 자리·확인·등록 경로 */
async function driveImportSetup({ createFails = false, abandoned = true, r2DeleteFails = false } = {}) {
  const { startFakeR2 } = await import('./helpers/fake-r2.mjs');
  const r2 = await startFakeR2();
  const key = randomBytes(32);
  Object.assign(process.env, { VITE_SUPABASE_URL: 'http://sb', VITE_SUPABASE_ANON_KEY: 'anon', OFFICE_SUPABASE_SERVICE_KEY: 'svc-key', OFFICE_GOOGLE_CLIENT_ID: 'cid', OFFICE_GOOGLE_CLIENT_SECRET: 'sec', OFFICE_MAIL_KEY: key.toString('base64'), ...r2.env });
  const row = { user_id: 'u1', address: 'me@x.com', scopes: READ_SCOPE, status: 'ok', sealed: seal(key, 'r1', 'u1:drive:me@x.com'), access_sealed: seal(key, 'a1', 'u1:drive:me@x.com'), access_expires: new Date(Date.now() + 3600e3).toISOString() };
  const order = [];
  const calls = fake([
    [/^http:\/\/127\.0\.0\.1:\d+\//, async (u, init) => { if (init.method === 'DELETE') { order.push('r2.delete'); if (r2DeleteFails) return new Response('boom', { status: 500 }); } return realFetch(u, init); }],
    [/rpc\/office_drive_secret/, () => new Response(JSON.stringify([row]))],
    [/auth\/v1\/user/, () => new Response(JSON.stringify({ id: 'u1' }))],
    [/drive\/v3\/files\/g1\?/, () => { order.push('google'); return new Response(JSON.stringify({ id: 'g1', name: 'a.pdf', mimeType: 'application/pdf' })); }],
    [/drive\/v3\/files\/g1/, () => new Response(Buffer.from('%PDF-1.4'))],
    [/rpc\/r2_object_commit/, () => { order.push('commit'); return new Response('{"state":"uploaded"}'); }],
    [/rpc\/r2_object_abandon/, (u, init) => { order.push('abandon'); return new Response(JSON.stringify(abandoned ? JSON.parse(init.body).p_keys : [])); }],
    [/rpc\/r2_object_forget/, () => { order.push('forget'); return new Response('1'); }],
    [/rpc\/office_file_write/, (u, init) => { const b = JSON.parse(init.body); order.push(b.p_action); if (b.p_action === 'file.create' && createFails) return new Response('{"message":"file_quota"}', { status: 400 }); return new Response(JSON.stringify(b.p_action === 'file.reserve' ? { key: `u-u1/files/${b.p_data.id}.pdf` } : { id: 'x' })); }],
  ]);
  return { r2, order, calls, d: await import('../api/drive/[op].js') };
}

test('재검수 LOW-A: 드라이브 가져오기 등록 실패 — 등록 전 행을 deleting으로(abandon) → R2 삭제 → forget, R2가 실패하면 행을 남겨 크론이 다시', async () => {
  let s = await driveImportSetup({ createFails: true });
  try {
    assert.equal((await s.d.POST(req('/api/drive/import', { org: null, id: 'g1' }))).status, 507);
    assert.deepEqual(s.order.slice(-4), ['file.create', 'abandon', 'r2.delete', 'forget'], '문서함 영구 삭제와 같은 순서');
    assert.equal(s.r2.objects.size, 0);
  } finally { await s.r2.close(); }
  s = await driveImportSetup({ createFails: true, r2DeleteFails: true });
  try {
    await s.d.POST(req('/api/drive/import', { org: null, id: 'g1' }));
    assert.deepEqual(s.order.slice(-3), ['file.create', 'abandon', 'r2.delete']);
    assert.ok(!s.order.includes('forget'), 'R2 삭제가 실패하면 행(deleting)을 남긴다 — 행 없는 객체가 생기지 않는다');
  } finally { await s.r2.close(); }
  s = await driveImportSetup({ createFails: true, abandoned: false });
  try {
    await s.d.POST(req('/api/drive/import', { org: null, id: 'g1' }));
    assert.ok(!s.order.includes('r2.delete'), '행이 이미 등록(claimed)됐으면 R2 객체를 지우지 않는다');
    assert.equal(s.r2.objects.size, 1);
  } finally { await s.r2.close(); }
});

test('검수 8: 긴급 차단(R2_OFFICE_UPLOADS_OFF=1)은 드라이브 가져오기(서버 PUT)도 막는다 — 구글에서 받기 전에 503', async () => {
  const s = await driveImportSetup();
  process.env.R2_OFFICE_UPLOADS_OFF = '1';
  try {
    const r = await s.d.POST(req('/api/drive/import', { org: null, id: 'g1' }));
    assert.equal(r.status, 503); assert.deepEqual(await r.json(), { error: 'uploads_paused' });
    assert.ok(!s.order.includes('google') && !s.order.includes('file.reserve'));
    assert.equal(s.r2.objects.size, 0);
  } finally { delete process.env.R2_OFFICE_UPLOADS_OFF; await s.r2.close(); }
});
