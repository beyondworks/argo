// 오픈클로 플러그인 파일 받기·보내기(0.3.2) — 유건 2026-09-30 "헤르메스 포함 외부 에이전트랑 내부 에이전트 모두 파일 송수신 등이 가능해야해".
// 승인 기준: ① 대화면 봇 답글에, 원문이 없으면(예약 작업·능동 전송) 봇 새 글에 붙는다 ② 파일당 25MB — 넘으면 올리지 않고 방에 한 줄 ③ 글 쓸 수 있는 방만(서버 판정).
// 실제 src/api.js·channel.ts 코드로 돈다. 서버·저장소·OpenClaw SDK는 가짜 fetch·런타임이다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApprovalBridge } from '../integrations/openclaw-argo-msgr/src/contract.js';
import { makeApi, deliverFiles, findFileTurn, openFileTurn, downloadAttachments, fileNotice, ArgoMsgrError, MAX_FILE_BYTES, relayPrompt } from '../integrations/openclaw-argo-msgr/src/api.js';

const T = 'argo_bot_' + 'c'.repeat(48);
const BASE = 'https://x.supabase.co/functions/v1/msgr-bot';
const CH = '11111111-1111-4111-8111-111111111111';
const ATTEMPT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const json = (body, status = 200) => ({ ok: status < 400, status, headers: new Headers(), json: async () => body, text: async () => JSON.stringify(body) });

// 가짜 서버 + 저장소. 호출을 순서대로 기록한다: { m: 메서드 이름 또는 'PUT'/'GET', body, headers, url }
function fakeServer({ putStatus = 200, bodies = {}, nextId = 100 } = {}) {
  const log = [];
  let id = nextId;
  const f = async (url, init = {}) => {
    const u = new URL(url);
    if (u.host === 'storage.test') {
      if (init.method === 'PUT') { log.push({ m: 'PUT', url, headers: init.headers, body: init.body }); return putStatus >= 400 ? { ok: false, status: putStatus, headers: new Headers(), text: async () => `denied ${url}` } : json({}); }
      log.push({ m: 'GET', url });
      const b = bodies[u.pathname.split('/').pop()];
      return b instanceof Response ? b : new Response(b, { headers: { 'content-length': String(b.length) } });
    }
    const m = u.pathname.split('/').pop();
    const body = init.body ? JSON.parse(init.body) : Object.fromEntries(u.searchParams);
    log.push({ m, body, url });
    if (m === 'createUpload') return json({ ok: true, result: { storage_path: `org/${CH}/${body.message_id}/bot-abcdef12-f.bin`, upload_url: `https://storage.test/upload/sign/msgr/f?token=SECRETSIGN`, method: 'PUT', max_bytes: MAX_FILE_BYTES } });
    if (m === 'attachFile') return json({ ok: true, result: { file_id: `file-${log.length}`, message_id: body.message_id } });
    if (m === 'sendMessage') return json({ ok: true, result: { message_id: id++ } });
    if (m === 'getFile') return json({ ok: true, result: { file_id: body.file_id, file_path: `https://storage.test/dl/${body.file_id}?token=DLSIGN` } });
    return json({ ok: false, error_code: 404, description: 'no route' }, 404);
  };
  f.log = log;
  f.methods = () => log.map((c) => c.m);
  return f;
}
const file = (name, bytes = 'hello', mime = 'text/plain') => ({ name, load: async () => ({ data: Buffer.from(bytes), mime }) });
const api = (f) => makeApi({ url: BASE, token: T, fetchImpl: f, outboxDir: join(tmpdir(), 'argo-files-test-outbox') });

test('uploadFile: createUpload → PUT(본문·Content-Type·x-upsert) → attachFile 순서와 인자', async () => {
  const f = fakeServer();
  const out = await api(f).uploadFile(77, { name: '보고서.pdf', data: Buffer.from('%PDF-1'), mime: 'application/pdf' });
  assert.deepEqual(f.methods(), ['createUpload', 'PUT', 'attachFile']);
  assert.deepEqual(f.log[0].body, { message_id: 77, file_name: '보고서.pdf', file_size: 6 });
  assert.match(f.log[0].url, new RegExp(`/bot${T}/createUpload$`));
  assert.equal(f.log[1].url, 'https://storage.test/upload/sign/msgr/f?token=SECRETSIGN', '서버가 준 서명 주소 그대로');
  assert.deepEqual(f.log[1].headers, { 'Content-Type': 'application/pdf', 'x-upsert': 'false' });
  assert.equal(Buffer.from(f.log[1].body).toString(), '%PDF-1');
  assert.deepEqual(f.log[2].body, { message_id: 77, storage_path: `org/${CH}/77/bot-abcdef12-f.bin`, file_name: '보고서.pdf', mime_type: 'application/pdf' });
  assert.equal(out.message_id, 77);
});

test('uploadFile: 25MB 초과는 서버를 부르지 않고 413, 저장소 거절은 그 상태로(서명 token은 문구에서 지운다)', async () => {
  const f = fakeServer();
  await assert.rejects(api(f).uploadFile(1, { name: 'big.zip', data: { length: MAX_FILE_BYTES + 1 } }), (e) => e instanceof ArgoMsgrError && e.status === 413);
  assert.deepEqual(f.methods(), [], '서버 호출 0');
  const denied = fakeServer({ putStatus: 403 });
  await assert.rejects(api(denied).uploadFile(1, { name: 'a.txt', data: Buffer.from('x') }), (e) => e.status === 403 && /file upload failed/.test(e.description) && !/SECRETSIGN/.test(e.description) && e.description.includes('token=***'));
  assert.deepEqual(denied.methods(), ['createUpload', 'PUT'], '업로드가 안 됐으면 attachFile을 부르지 않는다');
});

test('붙일 글 ① 그 요청에 이미 답글이 있으면 그 id — 같은 요청의 여러 파일은 같은 글, 새 글·답글 호출 없음', async () => {
  const f = fakeServer();
  const turn = openFileTurn({ accountId: 'default', chatId: CH + 'a', message: { message_id: 5, execution_attempt: ATTEMPT, peers: [] } });
  turn.finalId = 42;
  const r = await deliverFiles({ api: api(f), accountId: 'default', chatId: CH + 'a', turn, files: [file('a.txt'), file('b.txt')] });
  turn.end();
  assert.deepEqual(f.methods(), ['createUpload', 'PUT', 'attachFile', 'createUpload', 'PUT', 'attachFile']);
  assert.deepEqual(f.log.filter((c) => c.m === 'createUpload' || c.m === 'attachFile').map((c) => c.body.message_id), [42, 42, 42, 42]);
  assert.equal(r.messageId, 42);
  assert.deepEqual(r.sent, ['a.txt', 'b.txt']);
});

test('붙일 글 ② 답글이 아직이면 파일 이름으로 최종 답(reply·execution_attempt)을 먼저 보내 마감한 뒤 그 글에, 다음 파일은 같은 글에', async () => {
  const f = fakeServer({ nextId: 500 });
  const turn = openFileTurn({ accountId: 'default', chatId: CH + 'b', message: { message_id: 6, execution_attempt: ATTEMPT, peers: [] } });
  await deliverFiles({ api: api(f), accountId: 'default', chatId: CH + 'b', turn, files: [file('a.txt'), file('b.txt')] });
  assert.equal(turn.finalId, 500);
  turn.end();
  assert.deepEqual(f.methods(), ['sendMessage', 'createUpload', 'PUT', 'attachFile', 'createUpload', 'PUT', 'attachFile'], '마감이 첨부보다 먼저, 한 번만');
  assert.deepEqual(f.log[0].body, { chat_id: CH + 'b', text: 'a.txt, b.txt', reply_to_message_id: 6, execution_attempt: ATTEMPT, disposition: 'done', mentions: [] });
  assert.deepEqual(f.log.filter((c) => c.m === 'createUpload').map((c) => c.body.message_id), [500, 500]);
});

test('붙일 글 ③ 요청 맥락이 없으면 새 글(reply 없음) — text 없이 이어 오는 같은 전송의 파일은 그 새 글에, text가 있으면 새 글', async () => {
  const f = fakeServer({ nextId: 900 });
  await deliverFiles({ api: api(f), accountId: 'default', chatId: CH + 'c', files: [file('r.csv')], text: '주간 결과입니다' });
  assert.deepEqual(f.log[0].body, { chat_id: CH + 'c', text: '주간 결과입니다' }, 'reply_to_message_id·execution_attempt 없음');
  assert.equal(f.log[1].body.message_id, 900);
  await deliverFiles({ api: api(f), accountId: 'default', chatId: CH + 'c', files: [file('r2.csv')] });
  assert.equal(f.methods().filter((m) => m === 'sendMessage').length, 1, 'text 없는 이어지는 파일은 새 글을 쓰지 않는다');
  assert.equal(f.log.filter((c) => c.m === 'createUpload').at(-1).body.message_id, 900);
  await deliverFiles({ api: api(f), accountId: 'default', chatId: CH + 'c', files: [file('r3.csv')], text: '다른 결과' });
  assert.equal(f.log.filter((c) => c.m === 'createUpload').at(-1).body.message_id, 901, 'text가 있으면 별개 글');
});

test('25MB 초과: 올리지 않고(createUpload·PUT 없음), 요청을 마감하지도 않고, 방에 새 글 한 줄로 이유를 알린다', async () => {
  const f = fakeServer({ nextId: 300 });
  const turn = openFileTurn({ accountId: 'default', chatId: CH + 'd', message: { message_id: 7, execution_attempt: ATTEMPT, peers: [] } });
  const big = { name: '자료집', load: async () => ({ data: { length: MAX_FILE_BYTES + 1 }, mime: 'application/zip' }) };
  const r = await deliverFiles({ api: api(f), accountId: 'default', chatId: CH + 'd', turn, files: [big] });
  assert.deepEqual(f.methods(), ['sendMessage'], '안내 한 건만');
  assert.deepEqual(f.log[0].body, { chat_id: CH + 'd', text: '파일 자료집은 25MB를 넘어 올리지 못했습니다.' }, '답글이 아니라 새 글 — 요청은 열려 있다');
  assert.equal(turn.finalId, null);
  assert.equal(r.messageId, 300);
  turn.end();
  assert.equal(fileNotice('결과', new ArgoMsgrError(413, 'x')), '파일 결과는 25MB를 넘어 올리지 못했습니다.');
  assert.equal(fileNotice('report.zip', new ArgoMsgrError(413, 'x')), '파일 report.zip은(는) 25MB를 넘어 올리지 못했습니다.');
  assert.match(fileNotice('a.txt', new ArgoMsgrError(403, 'Forbidden: bot cannot post here')), /올리지 못했습니다\. \(Forbidden: bot cannot post here\)/);
});

test('한 파일이 실패해도 나머지는 올라가고, 서버가 거절한 사유는 안내에 남는다(403=방 밖·자기 글 아님)', async () => {
  const f = fakeServer({ nextId: 700 });
  const real = f;
  const wrapped = async (url, init) => { if (String(url).endsWith('/createUpload') && JSON.parse(init.body).file_name === 'no.txt') return json({ ok: false, error_code: 403, description: 'Forbidden: not your message' }, 403); return real(url, init); };
  const turn = openFileTurn({ accountId: 'default', chatId: CH + 'e', message: { message_id: 8, execution_attempt: ATTEMPT, peers: [] } });
  turn.finalId = 1;
  const r = await deliverFiles({ api: api(wrapped), accountId: 'default', chatId: CH + 'e', turn, files: [file('no.txt'), file('ok.txt')] });
  turn.end();
  assert.deepEqual(r.sent, ['ok.txt']);
  assert.equal(r.notices.length, 1);
  assert.match(r.notices[0], /no\.txt/); assert.match(r.notices[0], /not your message/);
  assert.equal(real.log.filter((c) => c.m === 'sendMessage').at(-1).body.text, r.notices[0]);
});

test('받기: getFile → 서명 URL 스트리밍 저장(25MB 상한) — 상한을 넘으면 중간에 끊고 파일을 지우며, 실패는 failed로 알린다', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'argo-files-in-'));
  try {
    const over = new Response(new ReadableStream({ start(c) { for (let i = 0; i < 26 * 16; i++) c.enqueue(new Uint8Array(65536)); c.close(); } })); // 26MB, content-length 없음
    const f = fakeServer({ bodies: { ok1: 'hello', ok2: 'world', big: over } });
    const m = { message_id: 31, attachments: [
      { file_id: 'ok1', file_name: 'dup.txt', mime_type: 'text/plain', file_size: 5 }, { file_id: 'ok2', file_name: 'dup.txt', mime_type: 'text/plain', file_size: 5 },
      { file_id: 'big', file_name: 'huge.bin', mime_type: 'application/octet-stream', file_size: 1000 }, { file_id: 'declared', file_name: 'declared.bin', file_size: MAX_FILE_BYTES + 1 },
      { file_name: 'no-id.txt' }] };
    const got = await downloadAttachments(api(f), m, { dir });
    assert.deepEqual(got.files.map((x) => [x.name, x.mime, x.size]), [['dup.txt', 'text/plain', 5], ['dup.txt', 'text/plain', 5]]);
    assert.notEqual(got.files[0].path, got.files[1].path, '같은 이름이 서로 덮어쓰지 않는다');
    assert.equal(await readFile(got.files[0].path, 'utf8'), 'hello'); assert.equal(await readFile(got.files[1].path, 'utf8'), 'world');
    assert.ok(got.files[0].path.startsWith(join(dir, '31')), '메시지 id 폴더');
    assert.deepEqual(got.failed.map((x) => x.name), ['huge.bin', 'declared.bin']);
    assert.deepEqual(got.failed.map((x) => x.reason), ['over 25 MB', 'over 25 MB']);
    assert.deepEqual((await readdir(join(dir, '31'))).sort(), ['1-dup.txt', 'dup.txt'], '넘은 파일은 남기지 않는다');
    assert.ok(!f.log.some((c) => c.m === 'getFile' && c.body.file_id === 'declared'), '선언 크기가 상한을 넘으면 getFile도 부르지 않는다');
    assert.ok(!f.log.some((c) => c.headers?.Authorization), '서명 URL에는 봇 인증을 싣지 않는다');
    assert.ok(!relayPrompt({ text: 'x' }, got).includes('token='), '프롬프트에 서명 주소가 없다');
    const p = relayPrompt({ text: '이 파일 봐줘' }, got);
    assert.match(p, /^이 파일 봐줘\n\n\[Attached files — saved locally, open them by path\]\n- .*dup\.txt \(dup\.txt, text\/plain, 5 bytes\)/);
    assert.match(p, /- huge\.bin \(not downloaded: over 25 MB\)/);
    assert.equal(relayPrompt({ text: 'a' }), relayPrompt({ text: 'a' }, { files: [], failed: [] }), '첨부가 없으면 프롬프트가 그대로다');
    assert.ok(!relayPrompt({ text: 'a' }).includes('Attached files'));
    assert.equal((await stat(dir)).isDirectory(), true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// ── 실제 channel.ts 배선(SDK는 흉내) ───────────────────────────────────────────────────────────────────────
async function loadChannel() {
  const src = (p) => new URL(`../integrations/openclaw-argo-msgr/${p}`, import.meta.url);
  let code = stripTypeScriptTypes(await readFile(src('src/channel.ts'), 'utf8'));
  for (const line of code.match(/import \{[\s\S]*?\} from "openclaw\/plugin-sdk\/[a-z-]+";/g) ?? []) code = code.replace(line, `const {${line.match(/\{([\s\S]*?)\}/)[1]}}=globalThis.__argoSdkFixture;`);
  code = code.replace('"./api.js"', JSON.stringify(src('src/api.js').href)).replace('"./contract.js"', JSON.stringify(src('src/contract.js').href))
    + `\n// files-fixture ${Math.random()}\nexport { handleInbound, resumeAgentTurn };`;
  return import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
}
async function withChannel(t, { server, deliverPayloads }) {
  const dir = await mkdtemp(join(tmpdir(), 'argo-files-ch-'));
  const prev = { fetch: globalThis.fetch, outbox: process.env.ARGO_MSGR_OUTBOX_DIR, files: process.env.ARGO_MSGR_FILES_DIR };
  process.env.ARGO_MSGR_OUTBOX_DIR = join(dir, 'outbox'); process.env.ARGO_MSGR_FILES_DIR = join(dir, 'files');
  t.after(async () => { globalThis.fetch = prev.fetch; delete globalThis.__argoSdkFixture; for (const [k, v] of [['ARGO_MSGR_OUTBOX_DIR', prev.outbox], ['ARGO_MSGR_FILES_DIR', prev.files]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } await rm(dir, { recursive: true, force: true }); });
  globalThis.__argoSdkFixture = { DEFAULT_ACCOUNT_ID: 'default', createChannelInboundEnvelopeBuilder: () => (o) => o.body, resolveOutboundMediaUrls: (p) => p.mediaUrls ?? (p.mediaUrl ? [p.mediaUrl] : []),
    createChannelApprovalCapability: (x) => x, createChannelApprovalNativeRuntimeAdapter: (x) => x, CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY: 'x' };
  globalThis.fetch = server;
  const channel = await loadChannel();
  const contexts = [], loads = [];
  channel.setArgoRuntime({
    media: { loadWebMedia: async (url, opts) => { loads.push([url, opts]); if (/huge/.test(url)) throw new Error('Media exceeds 25MB limit (got 26MB)'); if (/missing/.test(url)) throw new Error('ENOENT'); if (/bigdata/.test(url)) return { buffer: { length: MAX_FILE_BYTES + 1 }, contentType: 'application/zip', fileName: 'bigdata.zip' }; return { buffer: Buffer.from('DATA:' + url), contentType: 'text/plain', fileName: url.split('/').pop() }; } },
    channel: { activity: { record() {} }, routing: { resolveAgentRoute: () => ({ agentId: 'a', sessionKey: 's', accountId: 'default' }) }, inbound: {
      buildContext: (p) => { contexts.push(p); return {}; },
      dispatch: async ({ delivery: d }) => { await deliverPayloads(d, channel); } } } });
  return { channel, contexts, loads, dir };
}
const account = { url: BASE, token: T, accountId: 'default' };
const cfg = { channels: { 'argo-msgr': { accounts: { default: { url: BASE, token: T } } } } };
const msg = (over = {}) => ({ message_id: 5, text: '파일 만들어줘', chat: { id: CH, kind: 'public' }, from: { id: 'u' }, execution_attempt: ATTEMPT, peers: [], ...over });

test('channel: 첨부 받기 — getFile로 내려받아 경로를 프롬프트에 적고 media[] 사실로 에이전트에 넘긴다(상한 초과는 알림)', async (t) => {
  const over = new Response(new ReadableStream({ start(c) { for (let i = 0; i < 26 * 16; i++) c.enqueue(new Uint8Array(65536)); c.close(); } }));
  const server = fakeServer({ bodies: { a1: 'PDFBYTES', b1: over } });
  const { channel, contexts, dir } = await withChannel(t, { server, deliverPayloads: async (d) => { await d.deliver({ text: '읽었습니다' }, { kind: 'final' }); } });
  await channel.handleInbound({ m: msg({ message_id: 9, attachments: [{ file_id: 'a1', file_name: '계약서.pdf', mime_type: 'application/pdf', file_size: 8 }, { file_id: 'b1', file_name: 'huge.bin', mime_type: 'application/octet-stream', file_size: 10 }] }), account, cfg, log: () => {} });
  const saved = join(dir, 'files', '9', '계약서.pdf');
  assert.equal(await readFile(saved, 'utf8'), 'PDFBYTES');
  const ctx = contexts[0];
  assert.deepEqual(ctx.media, [{ path: saved, contentType: 'application/pdf', fileName: '계약서.pdf', sizeBytes: 8, messageId: '9' }]);
  assert.ok(ctx.message.bodyForAgent.includes(`- ${saved} (계약서.pdf, application/pdf, 8 bytes)`), '프롬프트에 경로');
  assert.match(ctx.message.bodyForAgent, /- huge\.bin \(not downloaded: over 25 MB\)/);
  assert.deepEqual(await readdir(join(dir, 'files', '9')), ['계약서.pdf'], '상한을 넘은 파일은 남지 않는다');
  assert.ok(server.log.some((c) => c.m === 'sendMessage' && c.body.reply_to_message_id === 9), '본문 처리는 그대로 답한다');
});

test('channel: 글 없이 파일만 온 메시지도 받는다 · 첨부가 없으면 media 키가 없다', async (t) => {
  const server = fakeServer({ bodies: { only: 'X' } });
  const { channel, contexts } = await withChannel(t, { server, deliverPayloads: async (d) => { await d.deliver({ text: 'ok' }, { kind: 'final' }); } });
  await channel.handleInbound({ m: msg({ message_id: 10, text: '', attachments: [{ file_id: 'only', file_name: 'x.txt', mime_type: 'text/plain', file_size: 1 }] }), account, cfg, log: () => {} });
  assert.equal(contexts[0].message.rawBody, 'x.txt'); assert.equal(contexts[0].media.length, 1);
  await channel.handleInbound({ m: msg({ message_id: 11 }), account, cfg, log: () => {} });
  assert.equal('media' in contexts[1], false);
});

test('channel: 답에 붙인 파일(mediaUrl) — 최종 답글을 먼저 보내고 그 글에 올린다(같은 요청의 여러 파일은 같은 글), 25MB 초과는 안내', async (t) => {
  const server = fakeServer({ nextId: 200 });
  const { channel, loads } = await withChannel(t, { server, deliverPayloads: async (d) => {
    await d.deliver({ text: '만들었습니다\nMSGR: done', mediaUrls: ['/ws/out/a.txt', '/ws/out/huge.zip', 'https://h.test/b.png'] }, { kind: 'final' });
  } });
  await channel.handleInbound({ m: msg({ message_id: 12 }), account, cfg, log: () => {} });
  assert.deepEqual(server.methods(), ['sendMessage', 'createUpload', 'PUT', 'attachFile', 'createUpload', 'PUT', 'attachFile', 'sendMessage']);
  assert.deepEqual(server.log[0].body, { chat_id: CH, text: '만들었습니다', reply_to_message_id: 12, execution_attempt: ATTEMPT, disposition: 'done', mentions: [] });
  assert.deepEqual(server.log.filter((c) => c.m === 'createUpload').map((c) => [c.body.message_id, c.body.file_name]), [[200, 'a.txt'], [200, 'b.png']]);
  assert.equal(Buffer.from(server.log.find((c) => c.m === 'PUT').body).toString(), 'DATA:/ws/out/a.txt');
  assert.deepEqual(server.log.at(-1).body, { chat_id: CH, text: '파일 huge.zip은(는) 25MB를 넘어 올리지 못했습니다.' });
  assert.ok(loads.every(([, o]) => o.maxBytes === MAX_FILE_BYTES + 1 && o.optimizeImages === false), '코어 로더에 25MB+1 상한, 이미지 재압축 없음');
});

test('channel: 글 없이 파일만 답해도 파일 이름으로 마감하고 붙인다 · 읽을 수 없는 파일은 안내', async (t) => {
  const server = fakeServer({ nextId: 400 });
  const { channel } = await withChannel(t, { server, deliverPayloads: async (d) => { await d.deliver({ mediaUrl: '/ws/only.csv' }, { kind: 'final' }); await d.deliver({ mediaUrl: '/ws/missing.csv' }, { kind: 'final' }); } });
  await channel.handleInbound({ m: msg({ message_id: 13 }), account, cfg, log: () => {} });
  assert.equal(server.log[0].body.text, 'only.csv, missing.csv'); assert.equal(server.log[0].body.reply_to_message_id, 13);
  assert.deepEqual(server.log.filter((c) => c.m === 'createUpload').map((c) => c.body.message_id), [400]);
  assert.equal(server.log.at(-1).body.text, '파일 missing.csv을(를) 올리지 못했습니다. (ENOENT)');
});

test('channel: 답하기 전에 sendMedia(message 도구) — 요청을 마감하지 않고 대기시켰다가 최종 답이 게시된 뒤 그 답글에 붙인다(넘김·멘션 유지)', async (t) => {
  const server = fakeServer({ nextId: 600 });
  let inTurn;
  const { channel, loads } = await withChannel(t, { server, deliverPayloads: async (d, ch) => {
    const out = ch.argoMsgrPlugin.outbound;
    const r1 = await out.sendMedia({ cfg, to: `argo-msgr:${CH}`, text: '첫 설명', mediaUrl: '/ws/r1.txt', accountId: 'default', replyToId: '14', mediaAccess: { localRoots: ['/ws'], readFile: async () => Buffer.from('x'), workspaceDir: '/ws' } });
    const r2 = await out.sendMedia({ cfg, to: `argo-msgr:${CH}`, text: '', mediaUrl: 'file:///ws/r2.txt', accountId: 'default', replyToId: 14 });
    inTurn = [r1, r2];
    assert.deepEqual(server.methods(), [], '파일 때문에 서버 호출도 요청 마감도 없다 — 대기 중');
    await d.deliver({ text: '@Peer 이어서 부탁해요\nMSGR: handoff' }, { kind: 'final' });
  } });
  await channel.handleInbound({ m: msg({ message_id: 14, peers: [{ id: 'peer', name: 'Peer' }] }), account, cfg, log: () => {} });
  assert.deepEqual(server.methods(), ['sendMessage', 'createUpload', 'PUT', 'attachFile', 'createUpload', 'PUT', 'attachFile'], '최종 답이 먼저, 파일은 그 뒤');
  assert.deepEqual(server.log[0].body, { chat_id: CH, text: '@Peer 이어서 부탁해요', reply_to_message_id: 14, execution_attempt: ATTEMPT, disposition: 'handoff', mentions: [{ kind: 'crew', id: 'peer' }] }, '진짜 답의 넘김·멘션이 살아 있다');
  assert.deepEqual(server.log.filter((c) => c.m === 'createUpload').map((c) => [c.body.message_id, c.body.file_name]), [[600, 'r1.txt'], [600, 'r2.txt']], '같은 요청의 파일은 그 답글에');
  assert.equal(server.log.filter((c) => c.m === 'sendMessage').length, 1, '새 글 없음');
  assert.deepEqual(inTurn.map((r) => r.messageId), ['', ''], '대기 중이라 글 id가 아직 없다');
  assert.deepEqual(loads[0][1].localRoots, ['/ws']); assert.equal(loads[0][1].hostReadCapability, true); assert.equal(loads[0][1].workspaceDir, '/ws');
});

test('channel: 최종 답 없이 턴이 끝나면(글 없이 파일만) 그때 도구 설명(없으면 파일 이름)으로 마감하고 붙인다', async (t) => {
  const server = fakeServer({ nextId: 650 });
  const { channel } = await withChannel(t, { server, deliverPayloads: async (d, ch) => {
    await ch.argoMsgrPlugin.outbound.sendMedia({ cfg, to: CH, text: '결과 파일입니다', mediaUrl: '/ws/only.csv', accountId: 'default', replyToId: '15' });
    await ch.argoMsgrPlugin.outbound.sendMedia({ cfg, to: CH, text: '', mediaUrl: '/ws/two.csv', accountId: 'default', replyToId: '15' });
  } });
  await channel.handleInbound({ m: msg({ message_id: 15 }), account, cfg, log: () => {} });
  assert.deepEqual(server.methods(), ['sendMessage', 'createUpload', 'PUT', 'attachFile', 'createUpload', 'PUT', 'attachFile']);
  assert.deepEqual(server.log[0].body, { chat_id: CH, text: '결과 파일입니다', reply_to_message_id: 15, execution_attempt: ATTEMPT, disposition: 'done', mentions: [] });
  const server2 = fakeServer({ nextId: 660 });
  const w2 = await withChannel(t, { server: server2, deliverPayloads: async (d, ch) => { await ch.argoMsgrPlugin.outbound.sendMedia({ cfg, to: CH, text: '', mediaUrl: '/ws/n.csv', accountId: 'default', replyToId: '16' }); } });
  await w2.channel.handleInbound({ m: msg({ message_id: 16 }), account, cfg, log: () => {} });
  assert.equal(server2.log[0].body.text, 'n.csv', '설명이 없으면 파일 이름');
});

test('channel: 대기 중 25MB 초과·읽기 실패 파일은 대기시키지 않고 방에 새 글 한 줄 — 요청은 마감하지 않는다', async (t) => {
  const server = fakeServer({ nextId: 670 });
  const { channel } = await withChannel(t, { server, deliverPayloads: async (d, ch) => {
    const r = await ch.argoMsgrPlugin.outbound.sendMedia({ cfg, to: CH, text: '', mediaUrl: '/ws/huge.zip', accountId: 'default', replyToId: '17' });
    assert.equal(r.messageId, '670', '안내 글 id');
    assert.deepEqual(server.methods(), ['sendMessage']);
    assert.deepEqual(server.log[0].body, { chat_id: CH, text: '파일 huge.zip은(는) 25MB를 넘어 올리지 못했습니다.' }, '답글도 execution_attempt도 아니다');
    // 코어 로더가 상한 없이 25MB+1 바이트를 그대로 돌려줘도 대기시키지 않는다
    await ch.argoMsgrPlugin.outbound.sendMedia({ cfg, to: CH, text: '', mediaUrl: '/ws/bigdata.zip', accountId: 'default', replyToId: '17' });
    assert.equal(server.log[1].body.text, '파일 bigdata.zip은(는) 25MB를 넘어 올리지 못했습니다.');
    await d.deliver({ text: '못 올렸습니다\nMSGR: done' }, { kind: 'final' });
  } });
  await channel.handleInbound({ m: msg({ message_id: 17 }), account, cfg, log: () => {} });
  assert.deepEqual(server.methods(), ['sendMessage', 'sendMessage', 'sendMessage'], '파일 업로드 없이 진짜 답만 이어진다');
  assert.equal(server.log[2].body.reply_to_message_id, 17);
});

test('요청 맥락 판정: 원문 id가 정확히 맞을 때만 그 요청 — 예약 작업·다른 세션·id 없음은 남의 요청을 닫지 않고 새 글', async (t) => {
  const A = openFileTurn({ accountId: 'default', chatId: CH + 'z', message: { message_id: 40, execution_attempt: ATTEMPT, peers: [] } });
  t.after(() => A.end());
  assert.equal(findFileTurn({ accountId: 'default', chatId: CH + 'z', replyToId: '40' }), A);
  assert.equal(findFileTurn({ accountId: 'default', chatId: CH + 'z', replyToId: 40 }), A);
  assert.equal(findFileTurn({ accountId: 'default', chatId: CH + 'z' }), null, '이 방에 요청이 하나뿐이어도 원문 id가 없으면 맥락 없음');
  assert.equal(findFileTurn({ accountId: 'default', chatId: CH + 'z', replyToId: '41' }), null, '다른 원문');
  assert.equal(findFileTurn({ accountId: 'default', chatId: CH + 'y', replyToId: '40' }), null, '다른 방');
  assert.equal(findFileTurn({ accountId: 'other', chatId: CH + 'z', replyToId: '40' }), null, '다른 계정');
  // 채널 배선: 예약 작업 sendMedia가 진행 중인 남의 요청에 붙지 않고, 그 요청의 진짜 답(넘김)이 그대로 나간다
  const server = fakeServer({ nextId: 710 });
  let cron;
  const { channel } = await withChannel(t, { server, deliverPayloads: async (d, ch) => {
    cron = await ch.argoMsgrPlugin.outbound.sendMedia({ cfg, to: CH, text: '예약 결과', mediaUrl: '/ws/cron.txt', accountId: 'default' });
    await d.deliver({ text: '@Peer 부탁\nMSGR: handoff' }, { kind: 'final' });
  } });
  await channel.handleInbound({ m: msg({ message_id: 18, peers: [{ id: 'peer', name: 'Peer' }] }), account, cfg, log: () => {} });
  assert.deepEqual(server.methods(), ['sendMessage', 'createUpload', 'PUT', 'attachFile', 'sendMessage']);
  assert.deepEqual(server.log[0].body, { chat_id: CH, text: '예약 결과' }, '새 글 — reply·execution_attempt 없음');
  assert.equal(cron.messageId, '710');
  assert.equal(server.log[4].body.execution_attempt, ATTEMPT); assert.equal(server.log[4].body.disposition, 'handoff'); assert.deepEqual(server.log[4].body.mentions, [{ kind: 'crew', id: 'peer' }]);
});

test('요청 맥락이 없는 sendMedia(예약 작업·능동 전송)는 봇 새 글에 붙인다', async (t) => {
  const server = fakeServer({ nextId: 800 });
  const CH2 = CH.replace(/^1/, '2');
  const { channel } = await withChannel(t, { server, deliverPayloads: async () => {} });
  const r = await channel.argoMsgrPlugin.outbound.sendMedia({ cfg, to: `argo-msgr:${CH2}`, text: '어제 작업 결과', mediaUrl: '/ws/cron.txt', accountId: 'default' });
  assert.deepEqual(server.methods(), ['sendMessage', 'createUpload', 'PUT', 'attachFile']);
  assert.deepEqual(server.log[0].body, { chat_id: CH2, text: '어제 작업 결과' }, 'reply·execution_attempt 없음');
  assert.equal(r.messageId, '800');
});

// ── 결재 재개 턴의 파일 → 후속 보고 글 ─────────────────────────────────────────────────────────────────────
function resumeBridge({ resume, followupResult = (n) => ({ message_id: 900 + n }) }) {
  const calls = [], spawned = [];
  const bridge = new ApprovalBridge({ api: { sendFollowup: async (id, text) => { calls.push(['followup', id, text]); return followupResult(calls.length); } }, resolve: async () => {},
    spawn: (fn) => { spawned.push(fn()); }, resume, sleep: async () => {}, followupRetryMs: [] });
  return { bridge, calls, spawned, run: async () => { await bridge.resumeAgent('ag-1', { status: 'approved', resume: true, decided_by_name: 'Kim' }, { source: { chat: { id: CH } }, sessionKey: 'sk', title: 't' }); await Promise.all(spawned); } };
}
test('재개 턴 파일: 후속 보고를 올린 뒤 그 글 id에 붙인다(대기) — 후속 보고 글이 방의 새 글로 따로 생기지 않는다', async () => {
  const order = [];
  const { calls, run } = resumeBridge({ resume: async () => ({ text: '결과입니다\nMSGR: done', names: ['a.txt'], attach: async (id) => { order.push(['attach', id]); } }) });
  await run();
  assert.deepEqual(calls, [['followup', 'ag-1', '결과입니다']], '후속 보고 한 번(표지는 뗀다)');
  assert.deepEqual(order, [['attach', 901]], '올라온 후속 보고 글 id에 붙는다');
});
test('재개 턴 파일: 답 글 없이 파일만이면 파일 이름으로 후속 보고를 올린 뒤 붙인다 · 후속 보고가 실패하면 붙이지 않는다', async () => {
  const order = [];
  const ok = resumeBridge({ resume: async () => ({ text: '', names: ['a.txt', 'b.txt'], attach: async (id) => { order.push(id); } }) });
  await ok.run();
  assert.deepEqual(ok.calls, [['followup', 'ag-1', 'a.txt, b.txt']]); assert.deepEqual(order, [901]);
  const bad = resumeBridge({ resume: async () => ({ text: '답', names: ['a.txt'], attach: async (id) => { order.push('bad' + id); } }), followupResult: () => { const e = new Error('nope'); e.status = 403; throw e; } });
  await bad.run();
  assert.deepEqual(order, [901], '후속 보고가 없으면 파일도 없다');
  const plain = resumeBridge({ resume: async () => '문자열 답' });
  await plain.run();
  assert.deepEqual(plain.calls, [['followup', 'ag-1', '문자열 답']], '파일이 없는 재개는 예전 그대로');
});
test('channel.resumeAgentTurn: 파일이 붙은 답은 { text, names, attach(글 id) } — attach는 그 후속 보고 글에 올린다', async (t) => {
  const server = fakeServer({ nextId: 950 });
  const { channel } = await withChannel(t, { server, deliverPayloads: async (d) => { await d.deliver({ text: '완료\nMSGR: done', mediaUrls: ['/ws/r.txt', '/ws/huge.zip'] }, { kind: 'final' }); } });
  const out = await channel.resumeAgentTurn({ account, cfg, log: () => {}, approvalId: 'ag-2', info: { source: { chat: { id: CH, kind: 'public' }, from: { id: 'u' } }, sessionKey: 'sk' }, text: 'go' });
  assert.equal(out.text, '완료'); assert.deepEqual(out.names, ['r.txt', 'huge.zip']);
  assert.deepEqual(server.methods(), [], 'attach 전에는 아무것도 올리지 않는다');
  await out.attach(777);
  assert.deepEqual(server.log.filter((c) => c.m === 'createUpload').map((c) => c.body.message_id), [777], '후속 보고 글에');
  assert.match(server.log.at(-1).body.text, /^파일 huge\.zip은\(는\) 25MB/, '초과 안내는 새 글 한 줄');
  assert.equal(server.log.at(-1).body.reply_to_message_id, undefined);
});

// ── 대기 파일이 조용히 사라지지 않는다 ─────────────────────────────────────────────────────────────────────
const sendOne = (ch, name, id) => ch.argoMsgrPlugin.outbound.sendMedia({ cfg, to: CH, text: '', mediaUrl: `/ws/${name}`, accountId: 'default', replyToId: String(id) });
const rejectReplies = (server, status = 409) => async (url, init) => { // execution_attempt가 실린 마감 답만 거절하는 서버
  if (String(url).endsWith('/sendMessage') && JSON.parse(init.body).execution_attempt) { server.log.push({ m: 'sendMessage', body: JSON.parse(init.body), rejected: true }); return json({ ok: false, error_code: status, description: 'Conflict: already replied' }, status); }
  return server(url, init);
};

test('대기 파일: 턴이 예외로 끝나면(답이 게시되지 않음) 파일마다 방에 새 글 한 줄로 알린다 — 원래 오류는 그대로 던진다', async (t) => {
  const server = fakeServer({ nextId: 730 });
  const { channel } = await withChannel(t, { server, deliverPayloads: async (d, ch) => { await sendOne(ch, '보고서', 20); await sendOne(ch, 'b.csv', 20); throw new Error('model crashed'); } });
  await assert.rejects(channel.handleInbound({ m: msg({ message_id: 20 }), account, cfg, log: () => {} }), /model crashed/);
  assert.deepEqual(server.methods(), ['sendMessage'], '업로드 없이 안내 한 건');
  assert.deepEqual(server.log[0].body, { chat_id: CH, text: '파일 보고서를 올리지 못했습니다. (답을 보내지 못했습니다)\n파일 b.csv을(를) 올리지 못했습니다. (답을 보내지 못했습니다)' }, '답글·execution_attempt 없는 새 글');
});

test('대기 파일: 마감 답 전송이 거절돼도(409 등) 파일을 버리지 않고 알린다', async (t) => {
  const server = fakeServer({ nextId: 740 });
  const { channel } = await withChannel(t, { server: rejectReplies(server), deliverPayloads: async (d, ch) => { await sendOne(ch, 'r.pdf', 21); await d.deliver({ text: '답\nMSGR: done' }, { kind: 'final' }); } });
  await assert.rejects(channel.handleInbound({ m: msg({ message_id: 21 }), account, cfg, log: () => {} }), (e) => e.status === 409);
  assert.ok(!server.methods().includes('createUpload'), '답이 없으니 올리지 않는다');
  assert.equal(server.log.at(-1).body.text, '파일 r.pdf을(를) 올리지 못했습니다. (답을 보내지 못했습니다)');
  assert.equal(server.log.at(-1).body.reply_to_message_id, undefined);
});

test('대기 파일: 턴 도중 sendText가 먼저 답글을 만들었으면 마감이 실패해도 그 답글에 붙인다(안내 없음)', async (t) => {
  const server = fakeServer({ nextId: 750 });
  const { channel } = await withChannel(t, { server: rejectReplies(server), deliverPayloads: async (d, ch) => {
    await sendOne(ch, 'r.pdf', 22);
    await ch.argoMsgrPlugin.outbound.sendText({ cfg, to: CH, text: '중간 답', accountId: 'default', replyToId: '22' });
    await d.deliver({ text: '끝\nMSGR: done' }, { kind: 'final' });
  } });
  await assert.rejects(channel.handleInbound({ m: msg({ message_id: 22 }), account, cfg, log: () => {} }), (e) => e.status === 409);
  assert.deepEqual(server.log.filter((c) => c.m === 'createUpload').map((c) => c.body.message_id), [750], 'sendText가 만든 답글에');
  assert.ok(!server.log.some((c) => /올리지 못했습니다/.test(c.body?.text ?? '')), '안내 없음');
});

test('대기 파일: 정상 종료면 대기가 비워져 마감 뒤 한 번만 올라간다(끝난 뒤 안내가 또 나가지 않는다)', async (t) => {
  const server = fakeServer({ nextId: 760 });
  const { channel } = await withChannel(t, { server, deliverPayloads: async (d, ch) => { await sendOne(ch, 'ok.txt', 23); await d.deliver({ text: '답' }, { kind: 'final' }); } });
  await channel.handleInbound({ m: msg({ message_id: 23 }), account, cfg, log: () => {} });
  assert.deepEqual(server.methods(), ['sendMessage', 'createUpload', 'PUT', 'attachFile']);
});

test('대기 파일 상한 10: 11번째는 읽지도 대기시키지도 않고 바로 안내 — 앞의 10개는 답글에 붙는다', async (t) => {
  const server = fakeServer({ nextId: 770 });
  const { channel, loads } = await withChannel(t, { server, deliverPayloads: async (d, ch) => {
    for (let i = 1; i <= 11; i++) await sendOne(ch, `f${i}.txt`, 24);
    await d.deliver({ text: '답' }, { kind: 'final' });
  } });
  await channel.handleInbound({ m: msg({ message_id: 24 }), account, cfg, log: () => {} });
  assert.equal(loads.length, 10, '11번째는 로더를 부르지 않는다');
  assert.deepEqual(server.log[0].body, { chat_id: CH, text: '파일 f11.txt을(를) 올리지 못했습니다. (한 글에는 파일을 10개까지 붙일 수 있습니다)' }, '즉시 새 글 안내');
  assert.equal(server.log[1].body.reply_to_message_id, 24);
  assert.equal(server.log.filter((c) => c.m === 'createUpload').length, 10);
  assert.deepEqual([...new Set(server.log.filter((c) => c.m === 'createUpload').map((c) => c.body.message_id))], [771]);
});
