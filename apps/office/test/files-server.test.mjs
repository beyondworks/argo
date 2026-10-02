// 문서함·드라이브 서버(유건 10/2) — 순수 함수와 서버 함수 흐름(가짜 구글·가짜 Supabase·가짜 OCR).
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { listRequest, mapFile, mapDrive, exportFormat, importable, exportName, quoteQ, validId, scopesFor, hasScope, multipartBody, READ_SCOPE, WRITE_SCOPE } from '../server/drive.js';
import { ocrBytes, visionText, ocrProvider } from '../server/ocr.js';
import { seal } from '../server/seal.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; for (const k of ['OFFICE_OCR_URL', 'OFFICE_VISION_API_KEY', 'OFFICE_GOOGLE_CLIENT_ID', 'OFFICE_GOOGLE_CLIENT_SECRET', 'OFFICE_MAIL_KEY', 'VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY']) delete process.env[k]; });

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

test('서버 OCR: 사이드카(바이트 끝점·키 헤더), Vision(그림·PDF 쪽 합치기), 설정 없음·대상 아님', async () => {
  assert.equal(ocrProvider({}), null);
  await assert.rejects(ocrBytes({ bytes: Buffer.from('x'), mime: 'image/png' }, {}), (e) => e.status === 503);
  await assert.rejects(ocrBytes({ bytes: Buffer.from('x'), mime: 'text/plain', name: 'a.txt' }, { OFFICE_OCR_URL: 'http://ocr' }), (e) => e.code === 'unsupported');
  let seen;
  const text = await ocrBytes({ bytes: Buffer.from('img'), mime: 'image/png', name: 'a.png' }, { OFFICE_OCR_URL: 'http://ocr/', OFFICE_OCR_KEY: 'k1' },
    async (url, init) => { seen = { url, init }; return new Response(JSON.stringify({ text: '사업자등록증' })); });
  assert.equal(text, '사업자등록증'); assert.equal(seen.url, 'http://ocr/ocr-bytes'); assert.equal(seen.init.headers['x-ocr-key'], 'k1');
  assert.equal(JSON.parse(seen.init.body).data, Buffer.from('img').toString('base64'));
  const pdf = await ocrBytes({ bytes: Buffer.from('%PDF'), mime: 'application/pdf' }, { OFFICE_VISION_API_KEY: 'v' },
    async (url) => { assert.match(url, /files:annotate/); return new Response(JSON.stringify({ responses: [{ responses: [{ fullTextAnnotation: { text: '1쪽' } }, { fullTextAnnotation: { text: '2쪽' } }] }] })); });
  assert.equal(pdf, '1쪽\n\n2쪽');
  assert.throws(() => visionText({ responses: [{ error: { message: 'bad' } }] }), (e) => e.code === 'ocr');
});

/** 가짜 Supabase·구글 — 경로별 응답 */
function fake(routes) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url); calls.push({ url: u, init });
    for (const [re, fn] of routes) if (re.test(u)) return fn(u, init);
    return new Response('not found', { status: 404 });
  };
  return calls;
}
const req = (path, body, jwt = 'jwt-1') => new Request(`http://x${path}`, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });

test('api/files: 설정 상태, 문서함 파일 OCR → 그 사람 권한으로 받고 결과 저장', async () => {
  const files = await import('../api/files/[op].js');
  assert.deepEqual(await (await files.GET(new Request('http://x/api/files/config'))).json(), { ocr: null });
  assert.equal((await files.POST(req('/api/files/ocr', { org: null, id: '00000000-0000-0000-0000-000000000001' }))).status, 503);
  Object.assign(process.env, { OFFICE_OCR_URL: 'http://ocr', VITE_SUPABASE_URL: 'http://sb', VITE_SUPABASE_ANON_KEY: 'anon' });
  let saved;
  const calls = fake([
    [/rpc\/office_file_get/, () => new Response(JSON.stringify({ id: 'f', kind: 'file', storage_path: 'u-1/f/명함.png', mime: 'image/png', filename: '명함.png' }))],
    [/storage\/v1\/object\/authenticated/, () => new Response(Buffer.from('png'))],
    [/ocr-bytes/, () => new Response(JSON.stringify({ text: '김민수 010-1234-5678' }))],
    [/rpc\/office_file_write/, (u, init) => { saved = JSON.parse(init.body); return new Response('{"id":"f"}'); }],
  ]);
  const r = await files.POST(req('/api/files/ocr', { org: null, id: '00000000-0000-0000-0000-000000000001' }));
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { status: 'done', text: '김민수 010-1234-5678' });
  assert.equal(saved.p_action, 'file.ocr'); assert.equal(saved.p_data.ocr_status, 'done');
  assert.ok(calls.find((c) => /authenticated\/office-files\/u-1\/f\/%EB%AA%85%ED%95%A8\.png/.test(c.url)).init.headers.authorization === 'Bearer jwt-1'); // 서비스 키가 아니라 요청자 JWT
  assert.equal((await files.POST(new Request('http://x/api/files/ocr', { method: 'POST', body: '{}' }))).status, 401);
});

test('api/drive: 설정 없음 503, 연결 안 됨 404, 목록·가져오기(구글 문서 → PDF 내보내기 → Storage → 등록)', async () => {
  const d = await import('../api/drive/[op].js');
  Object.assign(process.env, { VITE_SUPABASE_URL: 'http://sb', VITE_SUPABASE_ANON_KEY: 'anon' });
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
  fake([
    [/rpc\/office_drive_secret/, () => new Response(JSON.stringify([row]))],
    [/auth\/v1\/user/, () => new Response(JSON.stringify({ id: 'u1' }))],
    [/drive\/v3\/files\?/, (u, init) => { assert.equal(init.headers.authorization, 'Bearer a1'); return new Response(JSON.stringify({ files: [{ id: 'g1', name: '제안서', mimeType: 'application/vnd.google-apps.document' }] })); }],
    [/drive\/v3\/files\/g1\/export/, (u) => { assert.match(u, /mimeType=application%2Fpdf/); return new Response(Buffer.from('%PDF-1.4')); }],
    [/drive\/v3\/files\/g1\?/, () => new Response(JSON.stringify({ id: 'g1', name: '제안서', mimeType: 'application/vnd.google-apps.document' }))],
    [/storage\/v1\/object\/office-files\//, (u, init) => { uploaded = { u, init }; return new Response('{}'); }],
    [/rpc\/office_file_write/, (u, init) => { registered = JSON.parse(init.body); return new Response('{"id":"x"}'); }],
  ]);
  const l = await (await d.GET(req('/api/drive/list?view=mydrive'))).json();
  assert.equal(l.files[0].name, '제안서');
  const out = await (await d.POST(req('/api/drive/import', { org: null, id: 'g1' }))).json();
  assert.equal(out.title, '제안서.pdf'); assert.equal(out.mime, 'application/pdf');
  assert.match(uploaded.u, /office-files\/u-u1\//); assert.equal(uploaded.init.headers.authorization, 'Bearer jwt-1');
  assert.equal(registered.p_data.source, 'drive'); assert.equal(registered.p_data.drive_id, 'g1'); assert.equal(registered.p_data.storage_path, uploaded.u.split('/office-files/')[1].split('/').map(decodeURIComponent).join('/'));
  // 보내기는 drive.file이 없으면 need_write(화면이 쓰기 권한을 더 받는다)
  const e = await d.POST(req('/api/drive/export', { org: null, id: '00000000-0000-0000-0000-000000000001' }));
  assert.equal(e.status, 403); assert.deepEqual(await e.json(), { error: 'need_write' });
  assert.equal((await d.GET(req('/api/drive/import'))).status, 405); // 바꾸는 동작은 POST로만
});
