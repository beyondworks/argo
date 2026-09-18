// 채널별 세션을 **실제 SDK로** 돌린다(PR-B). 모델만 로컬 가짜 Messages 엔드포인트(ARGO_CLAUDE_BASE_URL — 실자격·비용 0)이고,
// 요청 본문에 무엇이 실려 갔는지로 확인한다. 크루 전역 기록은 주인이 데스크톱에서 나눈 대화라, 채널 턴 프롬프트에 붙으면 채널 참여자에게 샌다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from './helpers/tmp.mjs';

const root = await mkdtemp(join(tmpdir(), 'argo-ch-sess-sdk-'));
const home = await mkdtemp(join(tmpdir(), 'argo-ch-sess-sdk-home-'));
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
const { msgrJournal } = await import('../src/gateway/msgr-handoff.mjs');
const ws = 'ch-sess-sdk';
await createCompany(ws, '채널 세션', 'owner', null, 'ko');
const p = paths(ws);
await mkdir(p.agents, { recursive: true });
await writeFile(join(p.agents, 'x.md'), '---\nname: 엑스\nrole: 검증\nrunner: claude\n---\n검증용.\n');
await saveRunnerCred(ws, 'claude', 'apikey', `sk-ant-api03-${'x'.repeat(80)}`); // 형식만 맞춘 가짜 — 요청은 로컬 가짜 엔드포인트로만 간다

const OWNER = '11111111-1111-4111-8111-111111111111';
const ctxOf = (channelId) => ({ kind: 'msgr', chatType: 'group', channelKind: 'public', orgId: 'org-1', channelId, crewId: 'crew-1', threadRoot: 1, sourceMsgId: 1,
  uid: OWNER, wsId: ws, origin: OWNER, hop: 0, orgSlug: null, channelName: 'general', peers: [], handoffs: [] });
// 다른 기기에서 이어지는 턴(세션을 이 기기에서 못 잇는다) — 최근 기록을 프롬프트에 붙여 넣는 갈래
const history = {
  sessionId: 'desk-sess', sessionDevice: 'other-device', scopedSessions: { 'ch-1': { sessionId: 'ch1-sess', sessionDevice: 'other-device' } },
  messages: [
    { who: 'user', text: 'OWNER-PRIVATE-7777 주인 혼잣말', ts: 1 }, { who: 'crew', text: '알겠습니다', ts: 2 },
    { who: 'user', text: 'CHANNEL-ONE-5555 채널 지시', ts: 3, via: 'msgr', contextScope: { kind: 'msgr', channelId: 'ch-1' } },
    { who: 'user', text: 'CHANNEL-TWO-3333 다른 채널 지시', ts: 4, via: 'msgr', contextScope: { kind: 'msgr', channelId: 'ch-2' } },
  ],
};
const seed = () => writeFile(join(p.chats, 'x.json'), JSON.stringify(history));
const sent = () => bodies.join('\n');

test('실제 SDK 채널 턴: 다른 기기에서 이어질 때 그 채널 기록만 붙인다 — 주인 대화·다른 채널 기록은 싣지 않는다', async () => {
  await seed(); bodies = [];
  await chat(ws, 'x', '이어서 해 줘', 'ch1-sess', { mirrorCtx: ctxOf('ch-1'), source: 'messenger', journal: msgrJournal('org-1', 'ch-1', false) });
  assert.ok(bodies.length >= 1, '실제 SDK가 가짜 엔드포인트로 요청했다');
  assert.match(sent(), /CHANNEL-ONE-5555/, '같은 채널 기록은 이어 붙인다');
  assert.doesNotMatch(sent(), /OWNER-PRIVATE-7777/, '주인의 데스크톱 대화가 채널 턴에 실렸다');
  assert.doesNotMatch(sent(), /CHANNEL-TWO-3333/, '다른 채널 기록이 실렸다');
});

test('실제 SDK 데스크톱 턴: 주인 대화는 붙이고 채널 기록은 싣지 않는다(반대 방향 회귀 없음)', async () => {
  await seed(); bodies = [];
  await chat(ws, 'x', '이어서 해 줘', 'desk-sess', {});
  assert.match(sent(), /OWNER-PRIVATE-7777/, '주인 대화는 그대로 이어 붙는다');
  assert.doesNotMatch(sent(), /CHANNEL-(ONE|TWO)/, '채널 기록이 데스크톱 대화에 섞였다');
});

test('실제 SDK 채널 턴: 채널 범위 표지를 돌려주고, 기억 안 남김 채널은 세션도 돌려주지 않는다', async () => {
  const on = await chat(ws, 'x', '안녕', null, { mirrorCtx: ctxOf('ch-1'), source: 'messenger', journal: msgrJournal('org-1', 'ch-1', false) });
  assert.deepEqual(on.contextScope, { kind: 'msgr', channelId: 'ch-1', threadRoot: 1 });
  assert.ok(on.sessionId, '기억하는 채널은 세션을 돌려준다(채널 세션으로 저장됨)');
  const off = await chat(ws, 'x', '안녕', null, { mirrorCtx: ctxOf('ch-1'), source: 'messenger', journal: msgrJournal('org-1', 'ch-1', true) });
  assert.equal(off.sessionId, null, '기억 안 남김 채널이 세션을 남겼다');
});

test('실제 SDK 채널 턴: 기기 판정은 채널 세션 기준 — 전역 세션만 다른 기기여도 이 기기의 채널 세션을 잇는다', async () => {
  const { getDeviceId } = await import('../src/workspace.mjs');
  bodies = [];
  const first = await chat(ws, 'x', 'FIRST-TURN-4444', null, { mirrorCtx: ctxOf('ch-1'), source: 'messenger', journal: msgrJournal('org-1', 'ch-1', false) });
  assert.ok(first.sessionId, '전제: 이 기기에 실제 SDK 세션이 생겼다');
  await writeFile(join(p.chats, 'x.json'), JSON.stringify({ ...history, scopedSessions: { 'ch-1': { sessionId: first.sessionId, sessionDevice: await getDeviceId() } } }));
  bodies = [];
  await chat(ws, 'x', '이어서', first.sessionId, { mirrorCtx: ctxOf('ch-1'), source: 'messenger', journal: msgrJournal('org-1', 'ch-1', false) });
  assert.doesNotMatch(sent(), /다른 기기에서 이어짐/, '전역 세션의 기기로 판정해 채널 세션을 버렸다');
  assert.match(sent(), /FIRST-TURN-4444/, '이 기기의 채널 세션을 이어받았다(이전 턴이 요청에 실린다)');
});
