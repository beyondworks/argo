// 참조(cc) 공유 노트는 사장의 1:1 지시·결과다 — 범위가 있는 턴(메신저 채널·텔레그램 그룹·손님)의 프롬프트에 실리면
// 그 방 참여자에게 샌다(검수 K46, 2026-09-22). 실제 SDK를 로컬 가짜 Messages 엔드포인트로 돌려 요청 본문으로 확인한다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from './helpers/tmp.mjs';

const root = await mkdtemp(join(tmpdir(), 'argo-shared-scope-'));
const home = await mkdtemp(join(tmpdir(), 'argo-shared-scope-home-'));
Object.assign(process.env, { ARGO_ROOT: root, HOME: home, USERPROFILE: home, ARGO_ENC_VAULT: '0', ARGO_MODEL_CATALOG: 'off', ARGO_NATIVE_RUNNERS: 'off' });
for (const key of ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']) delete process.env[key];

let bodies = [];
const sse = (res, evs) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); for (const [e, d] of evs) res.write(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`); res.end(); };
const srv = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
    if (req.method === 'POST' && req.url.startsWith('/v1/messages')) {
      bodies.push(b);
      return sse(res, [['message_start', { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'claude-x', content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } }],
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } }], ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }], ['message_stop', { type: 'message_stop' }]]);
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
const { appendSharedNote } = await import('../src/thread.mjs');
const { msgrJournal } = await import('../src/gateway/msgr-handoff.mjs');
const ws = 'shared-scope';
await createCompany(ws, '공유 범위', 'owner', null, 'ko');
const p = paths(ws);
await mkdir(p.agents, { recursive: true });
await writeFile(join(p.agents, 'x.md'), '---\nname: 엑스\nrole: 검증\nrunner: claude\n---\n검증용.\n');
await saveRunnerCred(ws, 'claude', 'apikey', `sk-ant-api03-${'x'.repeat(80)}`); // 형식만 맞춘 가짜 — 요청은 로컬 가짜 엔드포인트로만 간다

const OWNER = '11111111-1111-4111-8111-111111111111';
const channelCtx = { kind: 'msgr', chatType: 'group', channelKind: 'public', orgId: 'org-1', channelId: 'ch-1', crewId: 'crew-1', threadRoot: 1, sourceMsgId: 1,
  uid: OWNER, wsId: ws, origin: OWNER, hop: 0, orgSlug: null, channelName: 'general', peers: [], handoffs: [] };
const SECRET = 'CC-SECRET-9999 사장이 동료에게 준 비공개 지시';
const seed = async () => { await writeFile(join(p.chats, 'x.json'), JSON.stringify({ messages: [] })); await appendSharedNote(ws, 'x', SECRET); };
const pending = async () => JSON.parse(await readFile(join(p.chats, 'x.json'), 'utf8')).messages.filter((m) => m.shared && m.pending).length;
const sent = () => bodies.join('\n');

test('메신저 채널 턴: 사장의 cc 공유 노트를 프롬프트에 싣지 않고, 노트는 다음 1:1 턴을 위해 남긴다', async () => {
  await seed(); bodies = [];
  await chat(ws, 'x', '채널 질문', null, { mirrorCtx: channelCtx, source: 'messenger', journal: msgrJournal('org-1', 'ch-1', false) });
  assert.ok(bodies.length >= 1, '실제 SDK가 가짜 엔드포인트로 요청했다');
  assert.doesNotMatch(sent(), /CC-SECRET-9999/, '사장의 cc 노트가 채널 턴 프롬프트에 실렸다');
  assert.equal(await pending(), 1, '채널 턴이 cc 노트를 소비했다');
});

test('텔레그램 그룹 턴: cc 공유 노트를 싣지 않고 남긴다', async () => {
  await seed(); bodies = [];
  await chat(ws, 'x', '그룹 질문', null, { mirrorCtx: { chatId: -1001, chatType: 'supergroup' }, source: 'telegram' });
  assert.ok(bodies.length >= 1, '실제 SDK가 가짜 엔드포인트로 요청했다');
  assert.doesNotMatch(sent(), /CC-SECRET-9999/, '사장의 cc 노트가 그룹 턴 프롬프트에 실렸다');
  assert.equal(await pending(), 1, '그룹 턴이 cc 노트를 소비했다');
});

test('사장 1:1 턴(범위 없음): cc 공유 노트를 싣고 소비한다(기존 동작 유지)', async () => {
  await seed(); bodies = [];
  await chat(ws, 'x', '이어서', null, {});
  assert.match(sent(), /CC-SECRET-9999/, '1:1 턴에 cc 노트가 빠졌다');
  assert.equal(await pending(), 0, '1:1 턴이 cc 노트를 소비하지 않았다');
});
