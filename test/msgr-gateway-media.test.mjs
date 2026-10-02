// 게이트웨이 첨부·링크 미리보기(2026-10-02) — 가짜 db·가짜 네트워크. 실 Supabase·실 모델·외부 네트워크 0.
// 고정: 개인 방 에이전트 파일은 p/<방>/<글>/<키>로 올리고 org_id NULL 행, 조직 방은 종전 경로, mime은 확장자로(빈 값 없음),
// 링크가 든 답은 같은 insert에 meta.link_preview, 실패·중단 답·링크 없는 답은 가져오지 않음,
// Node 요청기는 연결 시점에 내부 주소를 막고(재바인딩), 512KB에서 끊고, 리다이렉트를 따라가지 않는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from './helpers/tmp.mjs';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-msgr-media-'));
process.env.ARGO_ENC_VAULT = '0';
const M = await import('../src/gateway/msgr.mjs');
const { paths } = await import('../src/workspace.mjs');
const { nodeRequest, guardedLookup, replyLinkPreview } = await import('../src/gateway/link-preview-node.mjs');

const WS = 'lean-media-t1';
const OWNER = '11111111-1111-4111-8111-111111111111';
const ORG = 'aaaaaaaa-0000-4000-8000-000000000001';
const PCH = 'dddddddd-0000-4000-8000-000000000001';
const OCH = 'bbbbbbbb-0000-4000-8000-000000000001';
const CREW = 'cccccccc-0000-4000-8000-000000000001';
{
  const p = paths(WS);
  for (const d of [p.root, join(p.root, 'chats'), join(p.root, 'agents'), p.journal, p.files, join(p.vault, 'files')]) await mkdir(d, { recursive: true });
  await writeFile(p.company, JSON.stringify({ id: WS, name: '린', lang: 'ko', created: '2026-09-03' }));
  await writeFile(join(p.root, 'agents', 'seoyun.md'), '---\nname: 서윤\nrole: 마케터\n---\n');
  await writeFile(join(p.vault, 'files', 'chart.png'), 'PNG');
  await writeFile(join(p.vault, 'files', '보고서.md'), '# 보고서');
  await writeFile(join(p.vault, 'files', 'deck.pptx'), 'PPTX');
}

function fakeDb(orgId) {
  const calls = [];
  const rec = (...a) => calls.push(a);
  let n = 0; const executions = new Map();
  const db = {
    calls,
    async orgEntitled() { return true; },
    async orgConsentOk() { return true; },
    async crewBySlug() { return { id: CREW, org_id: orgId, slug: 'seoyun', display_name: '서윤', allow: 'all', allow_users: [], hosting: 'local' }; },
    async crewContext(_ws, crewId, msgId, channelId) {
      return {
        source: { id: msgId, author_kind: 'user', author_user_id: OWNER, crew_id: null, body: '정리해줘', reply_to: null, meta: {} },
        root: { id: msgId, author_kind: 'user', author_user_id: OWNER }, delivery_role: 'to', actor: OWNER,
        channel: { id: channelId, org_id: orgId, kind: orgId ? 'public' : 'dm', name: orgId ? 'general' : '', crew_memory: true, archived_at: null, excluded_crew_ids: [] },
        org: orgId ? { id: orgId, slug: 'lean', name: '린' } : null, peers: [{ id: crewId, slug: 'seoyun', display_name: '서윤', owner_user_id: OWNER, ws_id: WS }],
        settled_predecessors: [], settled_source: false, context: [], attachments: [],
      };
    },
    async memberName() { return '민수'; },
    async executionStopInfo() { return null; },
    async insertMessage(row) { rec('insertMessage', row); n += 1; return { id: 500 + n }; },
    async claimExecution(key) { executions.set(`${key.crewId}:${key.msgId}`, { attempt: key.attempt }); return { acquired: true, state: 'running', heartbeat_at: new Date().toISOString() }; },
    async finishExecution(key, row) { const e = executions.get(`${key.crewId}:${key.msgId}`); if (!e.row) e.row = await db.insertMessage(row); return e.row; },
    async heartbeatExecution() { return true; },
    async upload(path, buf, ct) { rec('upload', path, buf.length, ct); },
    async insertAttachment(row) { rec('insertAttachment', row); },
    async crewSeen() { return null; },
  };
  return db;
}
const job = (orgId, msgId) => ({ msgId, orgId, channelId: orgId ? OCH : PCH, crewId: CREW, slug: 'seoyun', text: '정리해줘', authorId: OWNER, threadRoot: msgId, hop: 0, origin: OWNER, createdAt: new Date().toISOString() });
const CARD = { v: 1, url: 'https://example.com/a', title: '제목', description: '', image: '', site: '' };

test('개인 방 — 에이전트 파일을 p/<방>/<글>/<키>로 올리고 org_id NULL 첨부 행, mime은 확장자로', async () => {
  const db = fakeDb(null);
  const h = M.makeMsgrHandler(WS, { session: async () => ({ db, uid: OWNER }), linkPreview: async () => null,
    runChat: async () => ({ reply: '만들었어요: files/chart.png files/보고서.md files/deck.pptx', sessionId: null, artifacts: [] }) });
  await h(job(null, 3001));
  const reply = db.calls.find((c) => c[0] === 'insertMessage' && c[1].client_msg_id === `reply:${CREW}:3001`);
  assert.ok(reply, '답이 게시되지 않았다');
  const ups = db.calls.filter((c) => c[0] === 'upload');
  assert.deepEqual(ups.map((c) => c[1]), [`p/${PCH}/501/0-chart.png`, `p/${PCH}/501/1-file.md`, `p/${PCH}/501/2-deck.pptx`]);
  assert.deepEqual(ups.map((c) => c[3]), ['image/png', 'text/markdown', 'application/vnd.openxmlformats-officedocument.presentationml.presentation']);
  const rows = db.calls.filter((c) => c[0] === 'insertAttachment').map((c) => c[1]);
  assert.equal(rows.length, 3);
  for (const r of rows) { assert.equal(r.org_id, null); assert.match(r.storage_path, new RegExp(`^p/${PCH}/501/`)); assert.ok(r.mime, '빈 mime 없음'); }
  assert.deepEqual(rows.map((r) => r.name), ['chart.png', '보고서.md', 'deck.pptx']);
  assert.equal(db.calls.some((c) => c[0] === 'insertMessage' && c[1].client_msg_id?.startsWith('attfail:')), false, '개인 방 거절 안내가 더는 나가지 않는다');
});

test('조직 방 — 경로·org_id는 종전 그대로', async () => {
  const db = fakeDb(ORG);
  const h = M.makeMsgrHandler(WS, { session: async () => ({ db, uid: OWNER }), linkPreview: async () => null,
    runChat: async () => ({ reply: 'files/chart.png', sessionId: null, artifacts: [] }) });
  await h(job(ORG, 3002));
  const row = db.calls.find((c) => c[0] === 'insertAttachment')[1];
  assert.equal(row.org_id, ORG);
  assert.equal(row.storage_path, `${ORG}/${OCH}/501/0-chart.png`);
  assert.equal(row.mime, 'image/png');
});

test('링크가 든 답 — 보내기 전에 한 번 가져와 같은 insert의 meta.link_preview에 싣는다', async () => {
  const db = fakeDb(null);
  const asked = [];
  const h = M.makeMsgrHandler(WS, { session: async () => ({ db, uid: OWNER }), linkPreview: async (text) => { asked.push(text); return CARD; },
    runChat: async () => ({ reply: '참고: https://example.com/a', sessionId: null, artifacts: [] }) });
  await h(job(null, 3003));
  const reply = db.calls.find((c) => c[0] === 'insertMessage')[1];
  assert.deepEqual(reply.meta.link_preview, CARD);
  assert.equal(asked.length, 1, '한 번만');
  assert.equal(db.calls.filter((c) => c[0] === 'insertMessage').length, 1, '카드 때문에 쓰기가 늘지 않는다(같은 insert)');
});

test('실패한 턴·미리보기 오류는 카드 없이 그대로 게시', async () => {
  const failed = fakeDb(null); let asked = 0;
  await M.makeMsgrHandler(WS, { session: async () => ({ db: failed, uid: OWNER }), linkPreview: async () => { asked += 1; return CARD; },
    runChat: async () => { throw new Error('러너 미연결 https://example.com'); } })(job(null, 3004));
  assert.equal(asked, 0, '실패 답은 링크를 가져오지 않는다');
  assert.equal(failed.calls.find((c) => c[0] === 'insertMessage')[1].meta.link_preview, undefined);
  const boom = fakeDb(null);
  await M.makeMsgrHandler(WS, { session: async () => ({ db: boom, uid: OWNER }), linkPreview: async () => { throw new Error('dns'); },
    runChat: async () => ({ reply: 'https://example.com/a', sessionId: null, artifacts: [] }) })(job(null, 3005));
  const r = boom.calls.find((c) => c[0] === 'insertMessage')[1];
  assert.equal(r.body, 'https://example.com/a');
  assert.equal(r.meta.link_preview, undefined);
});

test('replyLinkPreview — 링크 없는 답은 네트워크 0, 가짜 네트워크로 카드', async () => {
  let calls = 0;
  const net = { resolve: async () => { calls += 1; return ['93.184.216.34']; }, request: async () => { calls += 1; return { status: 200, headers: { 'content-type': 'text/html' }, body: new TextEncoder().encode('<title>카드</title>') }; } };
  assert.equal(await replyLinkPreview('링크 없음', net), null);
  assert.equal(calls, 0);
  assert.equal((await replyLinkPreview('보세요 https://example.com/x', net)).title, '카드');
});

// ── Node 요청기: 로컬 서버로 동작을 보되, 기본 lookup은 내부 주소를 막는다 ──
async function server(handler) {
  const s = createServer(handler);
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return { port: s.address().port, close: () => new Promise((r) => s.close(r)) };
}
const toLocal = (hostname, options, cb) => (options?.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4)); // 테스트 전용 — 이름을 로컬 서버로

test('guardedLookup — 이름이 내부 주소로 풀리면 연결하지 않는다(DNS 재바인딩 방어)', async () => {
  const s = await server((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>내부</title>'); });
  try {
    await assert.rejects(nodeRequest(`http://localhost:${s.port}/`, { timeoutMs: 2000, maxBytes: 1024 }), /blocked address|EBLOCKED/);
    await new Promise((resolve) => guardedLookup('localhost', { all: true }, (err) => { assert.equal(err?.code, 'EBLOCKED'); resolve(); }));
    await new Promise((resolve) => guardedLookup('localhost', {}, (err) => { assert.equal(err?.code, 'EBLOCKED'); resolve(); }));
  } finally { await s.close(); }
});

test('nodeRequest — HTML은 상한까지만, 3xx는 따라가지 않고 그대로, 비 HTML은 본문 없이, 시간 초과는 실패', async () => {
  const big = `<head><title>큰 문서</title></head>${'x'.repeat(700 * 1024)}`;
  const s = await server((req, res) => {
    if (req.url === '/big') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(big); }
    else if (req.url === '/hop') { res.writeHead(302, { location: 'http://169.254.169.254/' }); res.end(); }
    else if (req.url === '/img') { res.writeHead(200, { 'content-type': 'image/png' }); res.end(Buffer.alloc(10000)); }
    else if (req.url === '/slow') { setTimeout(() => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('late'); }, 1500); }
  });
  try {
    const opts = { timeoutMs: 3000, maxBytes: 512 * 1024 };
    const r1 = await nodeRequest(`http://fake.example:${s.port}/big`, opts, { lookup: toLocal });
    assert.equal(r1.status, 200);
    assert.equal(r1.body.length, 512 * 1024);
    const r2 = await nodeRequest(`http://fake.example:${s.port}/hop`, opts, { lookup: toLocal });
    assert.equal(r2.status, 302);
    assert.equal(r2.headers.location, 'http://169.254.169.254/');
    const r3 = await nodeRequest(`http://fake.example:${s.port}/img`, opts, { lookup: toLocal });
    assert.equal(r3.body.length, 0);
    await assert.rejects(nodeRequest(`http://fake.example:${s.port}/slow`, { timeoutMs: 300, maxBytes: 1024 }, { lookup: toLocal }), /timeout/);
  } finally { await s.close(); }
});
