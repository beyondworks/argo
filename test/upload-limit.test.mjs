// 2차 분리 검수 M3(2026-10-05): 11MB 첨부가 "첨부 실패: Failed to parse body as FormData."로 나왔다 — Next 미들웨어가 요청 본문을 10MB까지만 복제해(middlewareClientMaxBodySize 기본값)
// 라우트의 "파일당 10MB" 안내까지 가지 못했고, 10MB 파일도 멀티파트 오버헤드로 같은 실패였다(실측: 10,444,800바이트 통과·10,485,760 실패).
// 4차 검수(2026-10-05): 합계 20MB에 맞춘 본문 한도 21MB가 미들웨어가 잡는 모든 라우트의 요청당 버퍼를 두 배로 키웠다 → 요청 하나에 파일 하나, 한도는 파일 하나 + multipart 머리 여유.
// 잠그는 행동: ① 한도 상수 한 곳(app/lib/upload-limit.mjs)을 라우트·화면·next.config가 함께 쓴다 ② 화면은 보내기 전에 확인해 한도를 넘으면 요청 없이 사전 문구로 안내(ko/en)
// ③ 화면은 파일마다 요청 하나를 차례로 보낸다 ④ 라우트는 한도를 넘으면 413 + errorCode(본문이 잘려 오는 Content-Length 초과는 파싱 전에) ⑤ 본문 파싱 실패 같은 서버 원문은 화면에 나오지 않는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { register } from 'node:module';
import { UPLOAD_MAX_FILE_BYTES, UPLOAD_MULTIPART_ALLOWANCE_BYTES, UPLOAD_BODY_LIMIT_BYTES, uploadSizeProblem } from '../app/lib/upload-limit.mjs';
import { uploadAttachments } from '../app/lib/upload-files.mjs';
import { failureReason } from '../app/lib/error-text.mjs';
import { API_MSG } from '../app/apimsg.mjs';

const MiB = 1024 * 1024;
const file = (size, name = 'a.bin') => ({ name, size });
const tFor = () => (key) => `⟨${key}⟩`; // 사전 대역 — 일반 문구로 떨어졌다면 키가 보인다

test('한도 판정 — 파일 하나 10MB, 합계 한도는 없다(파일마다 요청이 따로)', () => {
  assert.equal(UPLOAD_MAX_FILE_BYTES, 10 * MiB);
  assert.equal(uploadSizeProblem([file(10 * MiB)]), null, '딱 10MB는 된다');
  assert.equal(uploadSizeProblem([file(10 * MiB + 1)]), 'upload_too_large');
  assert.equal(uploadSizeProblem([file(11 * MiB, 'big.bin'), file(1)]), 'upload_too_large');
  assert.equal(uploadSizeProblem([file(10 * MiB), file(10 * MiB), file(10 * MiB)]), null, '합계는 보지 않는다 — 요청 하나는 파일 하나');
  assert.equal(uploadSizeProblem([]), null); assert.equal(uploadSizeProblem(null), null);
});

test('미들웨어 본문 한도 = 파일 하나 + multipart 머리 여유 — 최악의 파일 이름도 들어가고, 파일 둘은 들어가지 않는다', async () => {
  assert.equal(UPLOAD_BODY_LIMIT_BYTES, UPLOAD_MAX_FILE_BYTES + UPLOAD_MULTIPART_ALLOWANCE_BYTES);
  assert.ok(UPLOAD_MULTIPART_ALLOWANCE_BYTES <= MiB, '여유는 머리 몇 KB 분량 — 합계 기준(21MB)으로 되돌리면 모든 라우트의 요청당 버퍼가 다시 커진다');
  const bodyBytes = async (entries) => { const fd = new FormData(); for (const [name, size, type] of entries) fd.append('file', new File([new Uint8Array(size)], name, { type })); return (await new Request('http://localhost/', { method: 'POST', body: fd }).arrayBuffer()).byteLength; };
  for (const [name, type] of [['a.bin', ''], ['가'.repeat(85) + '.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'], ['"'.repeat(255), 'application/octet-stream']]) {
    const n = await bodyBytes([[name, 10 * MiB, type]]);
    assert.ok(n <= UPLOAD_BODY_LIMIT_BYTES, `10MB 파일(이름 ${Buffer.byteLength(name)}바이트)의 본문 ${n}바이트가 한도 안`);
  }
  assert.ok(await bodyBytes([['a.bin', 6 * MiB, ''], ['b.bin', 6 * MiB, '']]) > UPLOAD_BODY_LIMIT_BYTES, '파일 둘을 한 요청에 담으면 한도를 넘는다 — 그래서 화면이 파일마다 보낸다');
});

test('화면: 한도를 넘으면 요청을 보내지 않고 사전 문구로 안내한다(ko·en) — 서버 원문 없음', async () => {
  let calls = 0; const fetchImpl = async () => { calls++; return new Response('{}', { status: 200 }); };
  for (const [lang, code] of [['ko', 'upload_too_large'], ['en', 'upload_too_large']]) {
    await assert.rejects(() => uploadAttachments('ws', [file(11 * MiB)], lang, fetchImpl), (e) => {
      assert.equal(e.data.errorCode, code); assert.equal(e.status, 413);
      assert.equal(e.message, lang === 'en' ? API_MSG[code].en : API_MSG[code].ko);
      assert.equal(failureReason(e, tFor()), e.message, '사전 문구라 그대로 보인다');
      return true;
    });
  }
  await assert.rejects(() => uploadAttachments('ws', [file(1000, 'ok.bin'), file(11 * MiB, 'big.bin')], 'ko', fetchImpl), (e) => e.data.errorCode === 'upload_too_large');
  assert.equal(calls, 0, '보내기 전에 막았다 — 한도 안의 파일도 먼저 보내지 않는다');
});

test('화면: 여러 파일은 파일마다 요청 하나를 차례로 보내고, 서버가 돌려준 목록을 보낸 순서대로 합친다', async () => {
  const sentNames = []; let inflight = 0; let maxInflight = 0;
  const fetchImpl = async (url, init) => {
    const entries = [...init.body.entries()];
    assert.equal(entries.length, 1, '요청 하나에 파일 하나'); assert.equal(entries[0][0], 'file');
    sentNames.push(entries[0][1].name);
    inflight++; maxInflight = Math.max(maxInflight, inflight); await new Promise((r) => setTimeout(r, 5)); inflight--;
    if (entries[0][1].name === 'fail.bin') return new Response(JSON.stringify({ error: 'x', errorCode: 'upload_too_large' }), { status: 413 });
    return new Response(JSON.stringify({ files: [{ rel: `files/${entries[0][1].name}`, name: entries[0][1].name }] }), { status: 200 });
  };
  const mk = (name, size) => new File([new Uint8Array(size)], name);
  const ok = await uploadAttachments('ws', [mk('a.bin', 10 * MiB), mk('b.bin', 10 * MiB), mk('c.bin', 3)], 'ko', fetchImpl); // 예전 합계 한도(20MB)를 넘는 묶음도 된다
  assert.deepEqual(sentNames, ['a.bin', 'b.bin', 'c.bin']);
  assert.deepEqual(ok.map((f) => f.name), ['a.bin', 'b.bin', 'c.bin']);
  assert.equal(maxInflight, 1, '차례로 — 동시에 보내지 않는다(서버 버퍼를 파일 하나로)');
  sentNames.length = 0;
  await assert.rejects(() => uploadAttachments('ws', [mk('a.bin', 1), mk('fail.bin', 1), mk('c.bin', 1)], 'en', fetchImpl), (e) => e.data?.errorCode === 'upload_too_large');
  assert.deepEqual(sentNames, ['a.bin', 'fail.bin'], '실패하면 남은 파일은 보내지 않는다');
});

test('화면: 정상 업로드는 파일 목록을 돌려주고, 서버 413은 사전 문구, 본문 파싱 실패(JSON 아님)는 서버 원문 대신 일반 문구', async () => {
  const ok = await uploadAttachments('ws', [file(1000)], 'ko', async (url, init) => {
    assert.equal(url, '/api/companies/ws/chat/upload'); assert.equal(init.method, 'POST'); assert.ok(init.body instanceof FormData);
    return new Response(JSON.stringify({ files: [{ rel: 'files/a', name: 'a.bin' }] }), { status: 200 });
  });
  assert.deepEqual(ok, [{ rel: 'files/a', name: 'a.bin' }]);
  const tooBig = await uploadAttachments('ws', [file(1000)], 'en', async () => new Response(JSON.stringify({ error: '서버 문구', errorCode: 'upload_too_large' }), { status: 413 })).catch((e) => e);
  assert.equal(failureReason(tooBig, tFor()), API_MSG.upload_too_large.en, '서버가 ko로 그렸어도 화면 언어');
  const parse = await uploadAttachments('ws', [file(1000)], 'ko', async () => new Response('Failed to parse body as FormData.', { status: 500 })).catch((e) => e);
  assert.equal(failureReason(parse, tFor()), '⟨common.reason.server⟩', '서버 원문이 아니라 일반 서버 문구');
  const net = await uploadAttachments('ws', [file(1000)], 'ko', async () => { throw new TypeError('Load failed'); }).catch((e) => e);
  assert.equal(failureReason(net, tFor()), '⟨common.reason.network⟩');
});

test('라우트: 한도를 넘으면 413 + errorCode(사전), 한도 안은 저장 — 실제 라우트', async () => {
  process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-upload-'));
  delete process.env.NEXT_PUBLIC_SUPABASE_URL; delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  register(new URL('./helpers/next-esm-resolve.mjs', import.meta.url));
  globalThis.__argoScheduler = true; globalThis.__argoGateway = true;
  const { createCompany } = await import('../src/workspace.mjs');
  await createCompany('up-co', '업로드 검증', 'owner', null, 'ko');
  const route = await import('../app/api/companies/[ws]/chat/upload/route.js');
  const post = async (files) => { const fd = new FormData(); for (const [name, size] of files) fd.append('file', new File([new Uint8Array(size)], name)); return route.POST(new Request('http://localhost/api/companies/up-co/chat/upload', { method: 'POST', body: fd }), { params: Promise.resolve({ ws: 'up-co' }) }); };
  const big = await post([['big.bin', 10 * MiB + 1]]); const b = await big.json();
  assert.equal(big.status, 413); assert.equal(b.errorCode, 'upload_too_large'); assert.equal(b.error, API_MSG.upload_too_large.ko);
  // 미들웨어 본문 한도를 넘는 요청 — 본문이 잘려 오므로 파싱하지 않고 Content-Length로 413(종전엔 'Failed to parse body as FormData' 500)
  const cut = await route.POST({ headers: new Headers({ 'content-length': String(UPLOAD_BODY_LIMIT_BYTES + 1) }), formData: async () => { throw new Error('파싱하면 안 된다'); } }, { params: Promise.resolve({ ws: 'up-co' }) });
  assert.equal(cut.status, 413); assert.equal((await cut.json()).errorCode, 'upload_too_large');
  const fine = await post([['ok.bin', 1000]]); assert.equal(fine.status, 200); assert.equal((await fine.json()).files.length, 1);
});

test('라우트·화면·next.config가 같은 상수를 쓴다 — 한도를 한 곳에서만 바꾼다', async () => {
  const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
  assert.match(read('app/api/companies/[ws]/chat/upload/route.js'), /uploadSizeProblem[\s\S]*lib\/upload-limit\.mjs/, '라우트도 같은 판정 함수');
  assert.doesNotMatch(read('app/api/companies/[ws]/chat/upload/route.js'), /10 \* 1024 \* 1024/, '라우트에 한도 숫자를 따로 두지 않는다');
  assert.match(read('app/lib/upload-files.mjs'), /uploadSizeProblem/);
  const { default: nextConfig } = await import('../next.config.mjs');
  assert.equal(nextConfig.experimental?.middlewareClientMaxBodySize, UPLOAD_BODY_LIMIT_BYTES, '미들웨어 본문 한도 = 파일 하나 + 머리 여유(10MB 파일도 라우트까지 가고, 다른 라우트 버퍼는 그 이상 커지지 않는다)');
  for (const f of ['app/c/[ws]/crew/[slug]/page.jsx', 'app/c/[ws]/room/page.jsx']) assert.match(read(f), /uploadAttachments\(/, `${f}: 공용 업로드 함수`);
});
