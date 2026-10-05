// 스레드 맥락 토큰 예산(B3') — Claude SDK 다른 기기 이어받기 축. 실제 SDK 턴(claude-agent-sdk)을 로컬 가짜 Messages 엔드포인트로 돌린다
// (ARGO_CLAUDE_BASE_URL — 실자격·비용 0). 다른 기기의 세션은 resume하지 않고 새 세션에 스레드 맥락을 붙인다 — 종전 최근 6개 → 예산 + 누적 요약.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from './helpers/tmp.mjs';

const root = await mkdtemp(join(tmpdir(), 'argo-ctxb-sdk-'));
const home = await mkdtemp(join(tmpdir(), 'argo-ctxb-sdk-home-'));
Object.assign(process.env, { ARGO_ROOT: root, HOME: home, USERPROFILE: home, ARGO_ENC_VAULT: '0', ARGO_MODEL_CATALOG: 'off', ARGO_NATIVE_RUNNERS: 'off' });
for (const key of ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']) delete process.env[key];

const reqs = [];
const sse = (res, text) => {
  const ev = [['message_start', { type: 'message_start', message: { id: `m${reqs.length}`, type: 'message', role: 'assistant', model: 'claude-x', content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }], ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }], ['message_stop', { type: 'message_stop' }]];
  res.writeHead(200, { 'content-type': 'text/event-stream' }); for (const [e, d] of ev) res.write(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`); res.end();
};
const srv = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
    if (req.method === 'POST' && req.url.startsWith('/v1/messages')) {
      const body = JSON.parse(b || '{}'); const all = JSON.stringify(body.messages ?? []);
      const kind = all.includes('<conversation>') ? 'summary' : (body.tools ?? []).length ? 'turn' : 'other';
      reqs.push({ kind, messages: all });
      return sse(res, kind === 'summary' ? '요약-SDK 결정은 금요일 마감' : kind === 'turn' ? '턴 답' : 'title');
    }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}');
  });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
process.env.ARGO_CLAUDE_BASE_URL = `http://127.0.0.1:${srv.address().port}`;
after(() => srv.close());

const { createCompany, paths } = await import('../src/workspace.mjs');
const { saveRunnerCred } = await import('../src/runners/creds.mjs');
const { chat } = await import('../src/chat.mjs');
const { loadThread, threadSummary } = await import('../src/thread.mjs');
const ws = 'ctxb-sdk';
await createCompany(ws, '예산', 'owner', null, 'ko');
const p = paths(ws);
await mkdir(p.agents, { recursive: true });
await writeFile(join(p.agents, 'a.md'), '---\nname: 알파\nrole: 검증\nrunner: claude\n---\n검증 크루.\n');
await saveRunnerCred(ws, 'claude', 'apikey', `sk-ant-api03-${'x'.repeat(80)}`); // 형식만 맞춘 가짜 — 요청은 로컬 가짜로만
const T0 = 1_700_000_000_000;
const msgs = (n, len) => Array.from({ length: n }, (_, i) => ({ who: i % 2 ? 'crew' : 'user', text: `m${i}| ${'가'.repeat(len)}`, ts: T0 + i * 1000 }));
const otherDevice = (messages) => writeFile(join(p.chats, 'a.json'), JSON.stringify({ sessionId: 'old-sess', sessionDevice: 'other-device', messages }));

test('TBS1. 다른 기기 세션 — 6개 넘는 최근 대화를 새 세션 첫 글에 붙인다(요약 호출 없음)', async () => {
  await otherDevice(msgs(30, 20)); reqs.length = 0;
  const r = await chat(ws, 'a', '이어서', 'old-sess');
  assert.equal(r.reply, '턴 답');
  const turn = reqs.find((q) => q.kind === 'turn');
  for (const i of [0, 7, 29]) assert.ok(turn.messages.includes(`m${i}|`), `m${i} 줄`);
  assert.equal(reqs.filter((q) => q.kind === 'summary').length, 0);
});

test('TBS2. 다른 기기 세션 + 긴 스레드 — 같은 러너(Claude SDK) 원샷으로 요약 1회, 첫 글에 요약과 최근 대화, 스레드에 저장', async () => {
  await otherDevice(msgs(300, 400)); reqs.length = 0;
  const r = await chat(ws, 'a', '보고서 이어서', 'old-sess');
  assert.equal(r.reply, '턴 답');
  assert.equal(reqs.filter((q) => q.kind === 'summary').length, 1, '요약 1회');
  const turn = reqs.find((q) => q.kind === 'turn');
  assert.ok(turn.messages.includes('요약-SDK 결정은 금요일 마감'), '첫 글에 요약');
  assert.ok(turn.messages.includes('m299|'), '최근 대화');
  assert.ok(!turn.messages.includes('m0|'), '예산 밖 원문은 싣지 않는다');
  const s = threadSummary(await loadThread(ws, 'a'), null);
  assert.equal(s?.text, '요약-SDK 결정은 금요일 마감');
});
