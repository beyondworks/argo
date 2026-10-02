// 풀 오토는 사장이 직접 시킨 턴에만(유건 결정 2026-10-03, "위임도 막기") — 실제 SDK 턴(가짜 Messages 엔드포인트) + 실제 커넥터(OAuth 테스트 서버)로
// 커넥터 쓰기 게이트의 행동을 잠근다. 사장 직접 턴은 결재 없이 실행, 위임받은 동료 턴·쪽지 배달 턴은 결재로 간다.
// 장시간 작업·결재 후속 턴은 그 일을 시작한 턴이 사장 직접 턴이 아니면 그 크루를 from으로 이어받는다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, writeFile, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from './helpers/tmp.mjs';

const root = await mkdtemp(join(tmpdir(), 'argo-fa-owner-'));
const home = await mkdtemp(join(tmpdir(), 'argo-fa-owner-home-'));
Object.assign(process.env, { ARGO_ROOT: root, HOME: home, USERPROFILE: home, ARGO_ENC_VAULT: '0', ARGO_MODEL_CATALOG: 'off', ARGO_NATIVE_RUNNERS: 'off' });
for (const key of ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']) delete process.env[key];

// 가짜 모델 — 크루별(페르소나 마커) 첫 요청에 한 번 지정한 도구를 부르고, 그 뒤엔 'done'
let plan = {}; const firedBy = new Set(); const reqs = [];
const sse = (res, evs) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); for (const [e, d] of evs) res.write(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`); res.end(); };
const start = () => ({ type: 'message_start', message: { id: `m${reqs.length}`, type: 'message', role: 'assistant', model: 'claude-x', content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } });
const textReply = (res, text) => sse(res, [['message_start', start()], ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }], ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }], ['message_stop', { type: 'message_stop' }]]);
const srv = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
    if (req.method !== 'POST' || !req.url.startsWith('/v1/messages')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{}'); }
    const body = JSON.parse(b || '{}');
    const system = typeof body.system === 'string' ? body.system : JSON.stringify(body.system ?? '');
    if (!(body.tools ?? []).length) return textReply(res, 'title');
    const who = (/페르소나-([A-D])-마커/.exec(system)?.[1] ?? '?').toLowerCase();
    reqs.push({ who, messages: JSON.stringify(body.messages ?? []) });
    const fire = plan[who] && !firedBy.has(who) ? plan[who] : null;
    if (fire) {
      firedBy.add(who);
      return sse(res, [['message_start', start()],
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `tu-${who}`, name: fire.name, input: {} } }],
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
const { crewmailTurn } = await import('../src/scheduler.mjs');
const { _makeJobHandlerForTest, queueDir, JOBS_QUEUE } = await import('../src/gateway.mjs');
const { _followUpForTest } = await import('../src/approval-actions.mjs');
const { startOauthTestServer } = await import('./helpers/oauth-test-server.mjs');

const ws = 'fa-owner';
await createCompany(ws, '풀 오토 검수', 'owner', null, 'ko');
const p = paths(ws);
await mkdir(p.agents, { recursive: true });
for (const [slug, name] of [['a', '알파'], ['b', '브라보']]) await writeFile(join(p.agents, `${slug}.md`), `---\nname: ${name}\nrole: 검증\nrunner: claude\n---\n페르소나-${slug.toUpperCase()}-마커.\n`);
await saveRunnerCred(ws, 'claude', 'apikey', `sk-ant-api03-${'x'.repeat(80)}`); // 형식만 맞춘 가짜 — 요청은 로컬 가짜 엔드포인트로만 간다
await updateCompany(ws, { fullAuto: true });

const s = await startOauthTestServer();
after(async () => { await closeConnectorPools(); await s.close(); srv.close(); });
const ID = 'demo-fa';
const { authUrl, done } = await startConnect(ws, { id: ID, url: s.mcpUrl, scopes: ['spike.read', 'spike.write'] });
{ const r1 = await fetch(authUrl, { redirect: 'manual' }); await fetch(new URL(r1.headers.get('location'))); }
assert.equal((await done).ok, true, '사전 조건: 커넥터 연결');

const SEND = (to) => ({ name: 'mcp__crew__use_connector', input: { server: ID, tool: 'send_mail_demo', args: { to, body: 'hi' } } });
const sent = () => s.counters.toolCalls.send_mail_demo ?? 0;
const reset = (next) => { plan = next; firedBy.clear(); reqs.length = 0; };

test('사장 직접 턴 — 풀 오토 회사에서 커넥터 쓰기가 결재 없이 실행된다(대조군)', async () => {
  reset({ a: SEND('owner@example.com') });
  const before = sent(); const apBefore = (await loadApprovals(ws)).length;
  await chat(ws, 'a', '메일 보내', null, {});
  assert.equal(sent(), before + 1, '사장 직접 턴은 바로 발송');
  assert.equal((await loadApprovals(ws)).length, apBefore, '결재 없음');
});

test('위임받은 동료 턴 — 커넥터 쓰기가 결재로 간다(발송은 서버에 닿지 않는다)', async () => {
  reset({ a: { name: 'mcp__crew__delegate', input: { to: 'b', task: '메일 보내 줘' } }, b: SEND('deleg@example.com') });
  const before = sent(); const apBefore = (await loadApprovals(ws)).length;
  await chat(ws, 'a', '브라보에게 맡겨', null, {});
  assert.ok(reqs.some((r) => r.who === 'b'), '위임 턴이 돌았다');
  assert.equal(sent(), before, '위임 턴에서 결재 없이 발송됐다');
  const ap = (await loadApprovals(ws)).slice(apBefore);
  assert.equal(ap.length, 1); assert.equal(ap[0].slug, 'b');
});

test('쪽지 배달 턴 — 커넥터 쓰기가 결재로 간다', async () => {
  reset({ b: SEND('mail@example.com') });
  const before = sent(); const apBefore = (await loadApprovals(ws)).length;
  await crewmailTurn(ws, 'b', { id: 'm1', from: 'a', fromName: '알파', kind: 'to', message: '메일 보내 줘', hop: 1, chain: ['a'] }, { from: 'a', hop: 1, chain: ['a'] });
  assert.equal(sent(), before, '쪽지 턴에서 결재 없이 발송됐다');
  assert.equal((await loadApprovals(ws)).length, apBefore + 1);
});

test('장시간 작업 — 위임 턴에서 건 작업은 시작한 크루를 from으로 이어받아 실행된다(사장 직접 턴에서 건 작업은 from 없음)', async () => {
  const jobs = async () => { try { return await Promise.all((await readdir(queueDir(ws, JOBS_QUEUE))).filter((n) => n.endsWith('.json')).map(async (n) => JSON.parse(await readFile(join(queueDir(ws, JOBS_QUEUE), n), 'utf8')))); } catch { return []; } };
  const LONG = { name: 'mcp__crew__start_long_task', input: { title: '긴 일', prompt: '오래 걸리는 일' } };
  reset({ a: { name: 'mcp__crew__delegate', input: { to: 'b', task: '긴 일 걸어 줘' } }, b: LONG });
  await chat(ws, 'a', '맡겨', null, {});
  const fromDeleg = (await jobs()).find((j) => j.slug === 'b');
  assert.equal(fromDeleg?.from, 'a', '위임 턴에서 건 작업은 위임한 크루를 기록한다');
  reset({ a: LONG });
  await chat(ws, 'a', '직접 걸어', null, {});
  const direct = (await jobs()).find((j) => j.slug === 'a');
  assert.ok(direct && !direct.from, '사장 직접 턴에서 건 작업은 from 없음');
  // 실행 — 기록한 from을 턴에 넘긴다
  const seen = [];
  const handler = _makeJobHandlerForTest(ws, { runChat: async (w, slug, prompt, sid, opts) => { seen.push(opts); return { reply: 'ok', sessionId: null }; } });
  await handler({ ...fromDeleg, tries: 0 }); await handler({ ...direct, tries: 0 });
  assert.equal(seen[0].from, 'a'); assert.ok(!seen[1].from);
});

test('결재 후속 턴 — 사장 직접 턴이 아닌 턴에서 올린 결재의 후속은 그 크루를 from·chain으로 이어받는다', async () => {
  const seen = [];
  const runChat = async (w, slug, msg, sid, opts) => { seen.push(opts); return { reply: 'ok', sessionId: null }; };
  await _followUpForTest(ws, { id: 'ap1', slug: 'b', from: 'a', kind: 'action', action: '메일 발송', status: 'approved' }, true, { runChat });
  await _followUpForTest(ws, { id: 'ap2', slug: 'b', kind: 'action', action: '메일 발송', status: 'approved' }, true, { runChat });
  assert.equal(seen[0].from, 'a'); assert.deepEqual(seen[0].chain, ['a']);
  assert.ok(!seen[1].from, '사장 직접 턴에서 올린 결재의 후속은 그대로');
});
