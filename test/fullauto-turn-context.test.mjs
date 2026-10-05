// 풀 오토 판정 줄(src/chat.mjs `const fullAuto = companyFullAuto === true && ownerDirect;`)을 실제 chat() 턴으로 잠근다(4차 분리 검수, 2026-10-05).
// 빈자리: 이 줄에서 메신저 맥락 판정(ownerDirectTurn → fullAutoAllowed)을 빼도 관련 테스트 255건이 초록이었다 — 게이트(connectors.mjs)가 mirrorCtx를
// 한 번 더 걸러 결과(결재·발송)가 같기 때문이다. 그 사이 손님·오피스·크루 넘김 턴의 모델에게는 "풀 오토 — 결재 없이 실행하라"가 간다.
// 여기서 보는 것(턴마다): ① 게이트가 받은 fullAuto 인자(로드 훅 기록 — helpers/connector-gate-spy.mjs) ② 모델에게 간 시스템 프롬프트의
// 풀 오토 문구 ③ 실제 결과(발송·결재). 사장 직접 턴(웹 채팅·주인의 메신저 글)은 켜지고, 손님·오피스·크루 넘김은 꺼진다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { register } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from './helpers/tmp.mjs';

register(new URL('./helpers/connector-gate-spy.mjs', import.meta.url)); // 아래 동적 임포트보다 먼저
const root = await mkdtemp(join(tmpdir(), 'argo-fa-ctx-'));
const home = await mkdtemp(join(tmpdir(), 'argo-fa-ctx-home-'));
Object.assign(process.env, { ARGO_ROOT: root, HOME: home, USERPROFILE: home, ARGO_ENC_VAULT: '0', ARGO_MODEL_CATALOG: 'off', ARGO_NATIVE_RUNNERS: 'off' });
for (const key of ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']) delete process.env[key];

// 가짜 모델 — 턴의 첫 도구 요청에서 use_connector(발송)를 한 번 부르고, 그 뒤엔 'done'. 도구가 실린 요청의 시스템 프롬프트를 남긴다
// (크루 도구 설명은 첫 요청에 실리지 않는다 — SDK가 MCP 도구를 지연 로드(ToolSearch)한다. 그래서 설명 대신 게이트 인자를 직접 본다)
let fire = null; let fired = false; const seen = [];
const sse = (res, evs) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); for (const [e, d] of evs) res.write(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`); res.end(); };
const start = () => ({ type: 'message_start', message: { id: `m${seen.length}`, type: 'message', role: 'assistant', model: 'claude-x', content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } });
const textReply = (res, text) => sse(res, [['message_start', start()], ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }], ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }], ['message_stop', { type: 'message_stop' }]]);
const srv = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
    if (req.method !== 'POST' || !req.url.startsWith('/v1/messages')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{}'); }
    const body = JSON.parse(b || '{}');
    if (!(body.tools ?? []).length) return textReply(res, 'title'); // 제목 생성 같은 도구 없는 부수 요청
    seen.push({ system: typeof body.system === 'string' ? body.system : JSON.stringify(body.system ?? '') });
    if (fire && !fired) {
      fired = true;
      return sse(res, [['message_start', start()],
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `tu${seen.length}`, name: fire.name, input: {} } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(fire.input) } }],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }], ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } }], ['message_stop', { type: 'message_stop' }]]);
    }
    return textReply(res, 'done');
  });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
process.env.ARGO_CLAUDE_BASE_URL = `http://127.0.0.1:${srv.address().port}`;

const { createCompany, paths, updateCompany } = await import('../src/workspace.mjs');
const { saveRunnerCred } = await import('../src/runners/creds.mjs');
const { chat } = await import('../src/chat.mjs');
const { startConnect, closeConnectorPools } = await import('../src/connectors.mjs');
const { loadApprovals } = await import('../src/approvals.mjs');
const { startOauthTestServer } = await import('./helpers/oauth-test-server.mjs');

const ws = 'fa-ctx';
await createCompany(ws, '풀 오토 맥락', 'owner', null, 'ko');
const p = paths(ws);
await mkdir(p.agents, { recursive: true });
await writeFile(join(p.agents, 'a.md'), '---\nname: 알파\nrole: 검증\nrunner: claude\n---\n검증용.\n');
await saveRunnerCred(ws, 'claude', 'apikey', `sk-ant-api03-${'x'.repeat(80)}`); // 형식만 맞춘 가짜 — 요청은 로컬 가짜 엔드포인트로만 간다
await updateCompany(ws, { fullAuto: true });

const s = await startOauthTestServer();
after(async () => { await closeConnectorPools(); await s.close(); srv.close(); });
const ID = 'demo-fa-ctx';
const { authUrl, done } = await startConnect(ws, { id: ID, url: s.mcpUrl, scopes: ['spike.read', 'spike.write'] });
{ const r1 = await fetch(authUrl, { redirect: 'manual' }); await fetch(new URL(r1.headers.get('location'))); }
assert.equal((await done).ok, true, '사전 조건: 커넥터 연결');

const OWNER = '11111111-1111-4111-8111-111111111111'; const GUEST = '22222222-2222-4222-8222-222222222222';
const msgr = (extra = {}) => ({ kind: 'msgr', chatType: 'group', channelKind: 'public', orgId: 'org-1', channelId: 'ch-1', crewId: 'crew-1', threadRoot: 1, sourceMsgId: 1,
  uid: OWNER, wsId: ws, origin: OWNER, hop: 0, orgSlug: null, channelName: 'general', peers: [], handoffs: [], ...extra });
const FULL_AUTO = /풀 오토 모드가 켜져/; // commonDirectives의 풀 오토 문구(ko) — 꺼진 턴의 글에는 없다
const sent = () => s.counters.toolCalls.send_mail_demo ?? 0;

/** 턴 하나 — 모델이 use_connector로 발송을 시도한다. 반환 = 게이트 인자·모델에게 간 글·결과 */
async function turn(label, mirrorCtx) {
  fire = { name: 'mcp__crew__use_connector', input: { server: ID, tool: 'send_mail_demo', args: { to: `${label}@example.com`, body: 'hi' } } };
  fired = false; seen.length = 0; globalThis.__connectorGateCalls = [];
  const before = sent(); const ap0 = new Set((await loadApprovals(ws)).map((x) => x.id));
  await chat(ws, 'a', '메일 보내 줘', null, mirrorCtx ? { mirrorCtx, source: 'messenger', journal: { off: true } } : {});
  const gate = globalThis.__connectorGateCalls.filter((c) => c.server === ID && c.tool === 'send_mail_demo');
  assert.equal(gate.length, 1, `${label}: 게이트를 한 번 지났다(모델의 발송 시도가 커넥터 단일 경로로 갔다)`);
  assert.ok(seen.length >= 1, `${label}: 실제 SDK 턴이 가짜 엔드포인트와 왕복했다`);
  return {
    gateFullAuto: gate[0].opts.fullAuto,
    system: seen[0].system,
    sent: sent() - before,
    approvals: (await loadApprovals(ws)).filter((x) => !ap0.has(x.id)).length,
  };
}

test('사장 직접 턴(웹 채팅·주인의 메신저 글) — 게이트가 fullAuto=true를 받고, 모델에게도 풀 오토라고 알리고, 결재 없이 발송된다', async () => {
  for (const [label, ctx] of [['owner-web', null], ['owner-msgr', msgr()]]) {
    const r = await turn(label, ctx);
    assert.equal(r.gateFullAuto, true, `${label}: 게이트가 받은 fullAuto`);
    assert.match(r.system, FULL_AUTO, `${label}: 시스템 프롬프트의 풀 오토 지시`);
    assert.equal(r.sent, 1, `${label}: 바로 발송`); assert.equal(r.approvals, 0, `${label}: 결재 없음`);
  }
});

test('손님·오피스에서 맡긴 글·크루가 넘긴 글 — 회사가 풀 오토여도 게이트가 fullAuto=false를 받고, 모델에게 풀 오토라고 말하지 않는다', async () => {
  for (const [label, ctx, outcome] of [
    ['guest', msgr({ origin: GUEST }), { sent: 0, approvals: 0 }], // 손님 턴은 게이트가 아예 막는다(guest_blocked) — 주인의 연결 서비스를 쓰지 않는다
    ['office', msgr({ office: true }), { sent: 0, approvals: 1 }], // 오피스에서 맡긴 글(메일·페이지 같은 바깥 자료) — 주인의 도구는 쓰되 쓰기는 결재로
    ['handoff', msgr({ handoffFrom: 'crew-2' }), { sent: 0, approvals: 1 }], // 크루가 스스로 넘긴 글 — 사장이 시킨 일이 아니다
  ]) {
    const r = await turn(label, ctx);
    assert.equal(r.gateFullAuto, false, `${label}: 게이트가 받은 fullAuto — 호출부(chat.mjs)가 이미 꺼서 넘긴다`);
    assert.doesNotMatch(r.system, FULL_AUTO, `${label}: 시스템 프롬프트가 풀 오토라고 말하지 않는다`);
    assert.equal(r.sent, outcome.sent, `${label}: 발송`); assert.equal(r.approvals, outcome.approvals, `${label}: 결재`);
  }
});
