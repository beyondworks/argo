// 엣지 함수 msgr-link-preview 요청 처리(core.js) — 가짜 글 조회·가짜 RPC·가짜 네트워크로 고정한다.
// 지키는 것: 로그인·작성자 본인만, 이미 카드 있으면 다시 가져오지 않음, 10분 지난 글은 안 함, 링크 없는 글은 네트워크 0,
// 주소는 요청 본문이 아니라 글 본문에서만, 실패는 카드 없음(다시 시도 없음), 512KB에서 읽기를 끊는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { handle, jwtSub, readHead, FRESH_MS } from '../supabase/functions/msgr-link-preview/core.js';

const ME = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const enc = (s) => new TextEncoder().encode(s);
const NOW = Date.parse('2026-10-02T10:00:00Z');
const msg = (o = {}) => ({ id: 7, author_kind: 'user', author_user_id: ME, body: '봐 https://example.com/a', created_at: new Date(NOW - 1000).toISOString(), deleted_at: null, meta: {}, ...o });
function deps(m, { page = '<head><meta property="og:title" content="제목"></head>', saved = true, claimed = true } = {}) {
  const log = { get: 0, set: [], req: [], claim: [] };
  return {
    log,
    d: {
      now: () => NOW,
      getMessage: async () => { log.get += 1; return m; },
      claim: async (id) => { log.claim.push(id); return claimed; },
      setPreview: async (id, p) => { log.set.push([id, p]); return saved; },
      net: { resolve: async () => ['93.184.216.34'], request: async (url) => { log.req.push(url); return { status: 200, headers: { 'content-type': 'text/html' }, body: enc(page) }; } },
    },
  };
}

test('정상: 내 글의 첫 링크를 한 번 가져와 저장하고 카드를 돌려준다', async () => {
  const { d, log } = deps(msg());
  const out = await handle({ sub: ME, body: { message_id: 7 } }, d);
  assert.equal(out.status, 200);
  assert.equal(out.body.preview.title, '제목');
  assert.deepEqual(log.req, ['https://example.com/a']);
  assert.equal(log.set.length, 1);
  assert.equal(log.set[0][0], 7);
});

test('주소는 요청 본문으로 받지 않는다 — 본문에 url을 넣어도 글 본문 링크만 쓴다', async () => {
  const { d, log } = deps(msg());
  await handle({ sub: ME, body: { message_id: 7, url: 'http://169.254.169.254/' } }, d);
  assert.deepEqual(log.req, ['https://example.com/a']);
});

test('거절: 로그인 없음 401, 잘못된 번호 400, 못 읽는 글 404, 남의 글·에이전트 글 403 — 네트워크 0', async () => {
  for (const [input, m, status] of [
    [{ sub: null, body: { message_id: 7 } }, msg(), 401],
    [{ sub: ME, body: { message_id: 'x' } }, msg(), 400],
    [{ sub: ME, body: {} }, msg(), 400],
    [{ sub: ME, body: { message_id: -1 } }, msg(), 400],
    [{ sub: ME, body: { message_id: 7 } }, null, 404],
    [{ sub: ME, body: { message_id: 7 } }, msg({ author_user_id: OTHER }), 403],
    [{ sub: ME, body: { message_id: 7 } }, msg({ author_kind: 'crew', author_user_id: null }), 403],
  ]) {
    const { d, log } = deps(m);
    const out = await handle(input, d);
    assert.equal(out.status, status, JSON.stringify(input));
    assert.equal(log.req.length + log.set.length, 0);
  }
});

test('다시 가져오지 않는다: 이미 카드가 있으면 그대로, 10분 지난 글·지운 글·링크 없는 글은 카드 없음', async () => {
  const existing = { v: 1, url: 'https://example.com/a', title: '있던 카드' };
  for (const [m, want] of [
    [msg({ meta: { link_preview: existing } }), existing],
    [msg({ created_at: new Date(NOW - FRESH_MS - 1).toISOString() }), null],
    [msg({ deleted_at: new Date(NOW).toISOString() }), null],
    [msg({ body: '링크 없음' }), null],
    [msg({ body: '`https://in-code.example`' }), null],
  ]) {
    const { d, log } = deps(m);
    const out = await handle({ sub: ME, body: { message_id: 7 } }, d);
    assert.deepEqual(out.body.preview, want);
    assert.equal(log.req.length, 0, '네트워크 0');
    assert.equal(log.set.length, 0, '쓰기 0');
  }
});

test('가져오기·저장 실패는 카드 없음(다시 시도 없음)', async () => {
  const noOg = deps(msg(), { page: '<p>본문만</p>' });
  assert.equal((await handle({ sub: ME, body: { message_id: 7 } }, noOg.d)).body.preview, null);
  assert.equal(noOg.log.set.length, 0);
  assert.equal(noOg.log.req.length, 1, '한 번만');
  const rpcNo = deps(msg(), { saved: false });
  assert.equal((await handle({ sub: ME, body: { message_id: 7 } }, rpcNo.d)).body.preview, null, 'RPC가 거절하면(10분·한 번 규칙) 카드 없음');
});

test('jwtSub — Bearer JWT의 sub(uuid)만', () => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  assert.equal(jwtSub(`Bearer ${b64({ alg: 'HS256' })}.${b64({ sub: ME, role: 'authenticated' })}.sig`), ME);
  assert.equal(jwtSub(`Bearer ${b64({})}.${b64({ sub: 'not-uuid' })}.sig`), null);
  assert.equal(jwtSub('Bearer garbage'), null);
  assert.equal(jwtSub(''), null);
  assert.equal(jwtSub(null), null);
});

test('readHead — </head> 없이 1MB에 닿으면 끊고 나머지는 읽지 않는다', async () => {
  let pulled = 0;
  const stream = new ReadableStream({ pull(c) { pulled += 1; c.enqueue(new Uint8Array(100 * 1024).fill(65)); if (pulled > 30) c.close(); } });
  const out = await readHead(stream, 1024 * 1024);
  assert.equal(out.length, 1024 * 1024);
  assert.ok(pulled <= 12, `덜 읽음: ${pulled}`);
  assert.equal((await readHead(null, 10)).length, 0);
});

test('readHead — </head>를 만나면 바로 멈춘다(뒤 본문을 더 읽지 않는다)', async () => {
  let pulled = 0;
  const parts = ['<html><head><meta property="og:title" content="t"></he', 'ad><body>', 'x'.repeat(50000), 'y'.repeat(50000)];
  const stream = new ReadableStream({ pull(c) { const p = parts[pulled++]; if (p == null) { c.close(); return; } c.enqueue(new TextEncoder().encode(p)); } });
  const out = new TextDecoder().decode(await readHead(stream, 1024 * 1024));
  assert.equal(out, '<html><head><meta property="og:title" content="t">');
  assert.ok(pulled <= 3, `본문을 더 읽지 않았다: ${pulled}`);
});

test('index.ts — 서비스 키 없이 부른 사람 권한으로만 읽고 쓴다, 공통 규칙 파일을 쓴다', () => {
  const src = readFileSync(fileURLToPath(new URL('../supabase/functions/msgr-link-preview/index.ts', import.meta.url)), 'utf8');
  assert.doesNotMatch(src, /SERVICE_ROLE/);
  assert.match(src, /redirect: 'manual'/, '리다이렉트는 core가 홉마다 검사한다');
  assert.match(src, /readHead\(r\.body, maxBytes\)/, '</head>·1MB에서 멈추는 읽기(게이트웨이와 같은 headScanner)');
  const core = readFileSync(fileURLToPath(new URL('../supabase/functions/msgr-link-preview/core.js', import.meta.url)), 'utf8');
  assert.match(core, /from '\.\.\/_shared\/link-preview\.js'/);
  assert.match(src, /rpc\/msgr_claim_link_preview/, '가져오기 전 시도 표시 RPC');
});

// 검수(2026-10-02) LOW — 재시도 무제한: 가져오기 전에 시도 표시(msgr_claim_link_preview)를 남겨 한 글은 외부 요청을 한 번만 한다.
test('가져오기 전에 시도 표시를 한 번 남기고, 시도한 글·상한에 걸린 글·일회용 링크는 외부 요청 0', async () => {
  const ok = deps(msg());
  await handle({ sub: ME, body: { message_id: 7 } }, ok.d);
  assert.deepEqual(ok.log.claim, [7]);
  assert.equal(ok.log.req.length, 1);
  const tried = deps(msg({ meta: { link_preview_try: '2026-10-02T09:59:00Z' } }));
  assert.equal((await handle({ sub: ME, body: { message_id: 7 } }, tried.d)).body.preview, null);
  assert.equal(tried.log.claim.length + tried.log.req.length + tried.log.set.length, 0, '이미 시도한 글(저장 실패 포함)은 다시 가져오지 않는다');
  const limited = deps(msg(), { claimed: false });
  assert.equal((await handle({ sub: ME, body: { message_id: 7 } }, limited.d)).body.preview, null);
  assert.equal(limited.log.req.length + limited.log.set.length, 0, '시도 표시가 거절되면(한 번 규칙·분당 상한) 요청하지 않는다');
  const broken = deps(msg()); broken.d.claim = async () => { throw new Error('rpc 404'); };
  assert.equal((await handle({ sub: ME, body: { message_id: 7 } }, broken.d)).body.preview, null);
  assert.equal(broken.log.req.length, 0, '시도 표시 RPC가 없거나 실패하면 요청하지 않는다');
  const secret = deps(msg({ body: '로그인 https://app.example/login?token=abc' }));
  assert.equal((await handle({ sub: ME, body: { message_id: 7 } }, secret.d)).body.preview, null);
  assert.equal(secret.log.claim.length + secret.log.req.length, 0, '일회용 링크는 시도 표시(쓰기)도 하지 않는다');
});
