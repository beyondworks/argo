// CLI 러너 크루 도구(K94, 유건 지시 2026-09-22 "러너마다 편차가 없어야" + "권한에 걸리면 안 된다").
// ① 크루 다리 = SDK 크루 서버와 같은 도구 집합·같은 처리기(실제 stdio 자식 + MCP 클라이언트로 왕복)
// ② codex app-server의 MCP 도구 승인(mcpServer/elicitation/request)을 게이트 판정대로 응답 — 전엔 빈 응답이라 전부 거절됐다(실측)
// ③ 크루 서버 도구 상한이 codex config.toml·gemini settings에 실린다(동기 위임이 60초를 넘는다)
// ④ 프롬프트: 크루 도구는 있고 러너 셸 게이트는 없는 턴을 정확히 안내한다
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdir, readFile } from 'node:fs/promises';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-cli-crew-')); // import보다 먼저(레포 관례)
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
const { makeCrewServer, commonDirectives } = await import('../src/chat.mjs');
const { crewToolSpecs } = await import('../src/engine/native-query.mjs');
const { createCrewMcpBridge } = await import('../src/engine/crew-mcp.mjs');
const { runAppServerSession, makeApprovalJudge } = await import('../src/runners/codex-appserver.mjs');
const { writeCodexTurnConfig } = await import('../src/runners/codex.mjs');
const { geminiMcpServers } = await import('../src/runners/gemini.mjs');
const { createCompany, paths } = await import('../src/workspace.mjs');

const WS = 'cli-crew';
await createCompany(WS, 'CLI 크루사', 'captain');
const colleagues = [{ slug: 'bee', name: '비', role: '검증' }];
const bridges = [];
after(async () => { for (const b of bridges) await b.close(); });

test('크루 다리 — 실제 stdio 자식으로 SDK 크루 서버와 같은 도구 집합이 보이고, 같은 처리기가 돈다', async () => {
  // SDK 표면(인메모리 MCP)의 도구 목록 = 기준
  const sdk = makeCrewServer(WS, 'ay', '에이', colleagues, 0, [], null, 'ko');
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await sdk.instance.connect(st);
  const sdkClient = new Client({ name: 't', version: '1' }); await sdkClient.connect(ct);
  const sdkNames = (await sdkClient.listTools()).tools.map((t) => t.name).sort();
  await sdkClient.close();

  const sink = [];
  makeCrewServer(WS, 'ay', '에이', colleagues, 0, [], null, 'ko', [], '', sink);
  const bridge = await createCrewMcpBridge(crewToolSpecs(sink)); bridges.push(bridge);
  assert.equal(bridge.server.toolTimeoutSec, 1800);
  const transport = new StdioClientTransport({ command: bridge.server.command, args: bridge.server.args, env: { ...process.env, ...bridge.server.env }, stderr: 'pipe' });
  const client = new Client({ name: 'codex-like', version: '1' }); await client.connect(transport);
  try {
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(names, sdkNames, 'CLI 크루 다리의 도구 집합이 SDK 크루 서버와 다르다(러너 편차)');
    assert.ok(names.includes('delegate') && names.includes('request_approval') && names.includes('start_long_task'));
    const r = await client.callTool({ name: 'list_routines', arguments: {} });
    assert.ok(!r.isError && r.content[0].text.length > 0, '처리기가 실행되지 않았다');
    const bad = await client.callTool({ name: 'send_to_crew', arguments: {} }); // 필수 인자 누락 — 네이티브 엔진과 같은 입력 검증
    assert.equal(bad.isError, true);
  } finally { await client.close(); }
});

test('크루 다리 — 토큰 없는 요청은 403(같은 기기의 다른 프로세스가 크루 도구를 부를 수 없다)', async () => {
  const sink = [];
  makeCrewServer(WS, 'ay', '에이', colleagues, 0, [], null, 'ko', [], '', sink);
  const bridge = await createCrewMcpBridge(crewToolSpecs(sink)); bridges.push(bridge);
  const res = await fetch(bridge.server.env.ARGO_CREW_RELAY_URL, { method: 'POST', body: JSON.stringify({ op: 'list' }) });
  assert.equal(res.status, 403);
});

/* ── codex app-server 가짜 서버(스트림 이음매) ── */
function fakeServer(onTurnStart) {
  const input = new PassThrough(); const output = new PassThrough(); const received = [];
  const emit = (m) => output.write(JSON.stringify(m) + '\n');
  let buf = '';
  input.on('data', (d) => {
    buf += d.toString(); let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue;
      const m = JSON.parse(line); received.push(m);
      if (m.method === 'initialize') emit({ id: m.id, result: {} });
      else if (m.method === 'thread/start') emit({ id: m.id, result: { thread: { id: 't1' } } });
      else if (m.method === 'turn/start') { emit({ id: m.id, result: { turn: { id: 'u1', status: 'inProgress' } } }); onTurnStart(emit); }
    }
  });
  return { input, output, received };
}
// 0.149.1 실측 모양(2026-09-22) — 도구 이름은 message 문장에만 있다
const elicit = (id, server, tool, params) => ({ id, method: 'mcpServer/elicitation/request', params: { threadId: 't1', turnId: 'u1', serverName: server, mode: 'form',
  _meta: { codex_approval_kind: 'mcp_tool_call', tool_params: params }, message: `Allow the ${server} MCP server to run tool "${tool}"?`, requestedSchema: { type: 'object', properties: {} } } });

async function sessionWith(requests, judge) {
  const srv = fakeServer((emit) => {
    requests.forEach((r, i) => emit(elicit(900 + i, ...r)));
    setTimeout(() => { emit({ method: 'item/completed', params: { item: { type: 'agentMessage', id: 'a1', text: 'ok' } } }); emit({ method: 'turn/completed', params: { turn: { id: 'u1', status: 'completed' } } }); }, 50);
  });
  await runAppServerSession({ input: srv.input, output: srv.output, prompt: 'p', cwd: '/w', timeoutMs: 5000, judge });
  return requests.map((_, i) => srv.received.find((m) => m.id === 900 + i)?.result?.action ?? null);
}

test('codex app-server — MCP 도구 승인 요청을 실제 게이트로 판정한다: 크루·일반 도구는 accept, 금지 구역 경로는 decline, 이름 미상은 decline', async () => {
  const judge = makeApprovalJudge(paths(WS).root);
  const actions = await sessionWith([
    ['crew', 'delegate', { to: 'bee', task: '확인' }],
    ['argo_browser', 'browser_navigate', { url: 'https://example.com' }],
    ['filesystem', 'write_file', { path: join(paths(WS).root, 'capabilities.json'), content: '{}' }],
    ['probe', '', {}],
  ], judge);
  assert.deepEqual(actions, ['accept', 'accept', 'decline', 'decline']);
});

test('codex app-server — MCP 승인은 판정자에 서버·도구·인자를 그대로 넘긴다', async () => {
  const seen = [];
  const actions = await sessionWith([['crew', 'request_approval', { request: 'x', reason: 'y' }]], async (kind, payload) => { seen.push({ kind, ...payload }); return 'decline'; });
  assert.deepEqual(seen, [{ kind: 'mcp', server: 'crew', tool: 'request_approval', params: { request: 'x', reason: 'y' } }]);
  assert.deepEqual(actions, ['decline']);
});

test('크루 서버 도구 상한 — codex config.toml은 [mcp_servers.crew] 안(하위 env 표 앞)에, gemini는 timeout(ms)으로', async () => {
  const home = await mkdtemp(join(tmpdir(), 'argo-cli-crew-home-'));
  await writeCodexTurnConfig(home, { crew: { command: process.execPath, args: ['w.mjs'], env: { K: 'v' }, toolTimeoutSec: 1800 }, other: { command: process.execPath, args: ['o.mjs'] } });
  const toml = await readFile(join(home, 'config.toml'), 'utf8');
  const crew = toml.slice(toml.indexOf('[mcp_servers.crew]'), toml.indexOf('[mcp_servers.crew.env]'));
  assert.match(crew, /\ntool_timeout_sec = 1800\n/);
  assert.doesNotMatch(toml.slice(toml.indexOf('[mcp_servers.other]')), /tool_timeout_sec/, '크루 다리가 아닌 서버에 상한을 바꿔 쓰면 안 된다');
  const g = geminiMcpServers({ crew: { command: process.execPath, toolTimeoutSec: 1800 }, other: { command: process.execPath } });
  assert.equal(g.crew.timeout, 1_800_000);
  assert.equal(g.other.timeout, undefined);
});

test('프롬프트 — 크루 도구가 있는 CLI 턴은 도구로 결재·위임하라고 하고, 러너 셸 게이트는 없다고 정직하게 안내한다', () => {
  for (const lang of ['ko', 'en']) {
    const cli = commonDirectives({ hasTools: true, gated: false, lang });
    assert.match(cli, /request_approval/);
    assert.doesNotMatch(cli, /```argo/, '도구가 있는데 지시 블록으로 결재하라고 안내했다');
    assert.match(cli, lang === 'ko' ? /도구 게이트가 없어/ : /no tool gate/);
    const sdk = commonDirectives({ hasTools: true, lang });
    assert.match(sdk, lang === 'ko' ? /도구 게이트가 하드 차단한다/ : /The tool gate blocks them/);
  }
});

// ── 분리 검수(2026-09-22) 지적 잠금 ──
test('codex app-server — 처리하지 않는 서버 요청(권한 승격 등)에도 빈 응답을 보내 턴이 멈추지 않는다(검수 HIGH-1: 주석에 삼켜진 write)', async () => {
  const srv = fakeServer((emit) => {
    emit({ id: 950, method: 'item/permissions/requestApproval', params: { reason: 'x' } });
    emit({ id: 951, method: 'mcpServer/elicitation/request', params: { serverName: 'probe', mode: 'form', _meta: { codex_approval_kind: 'user_input' }, message: 'Pick one' } });
    setTimeout(() => { emit({ method: 'item/completed', params: { item: { type: 'agentMessage', id: 'a1', text: 'ok' } } }); emit({ method: 'turn/completed', params: { turn: { id: 'u1', status: 'completed' } } }); }, 50);
  });
  const { reply } = await runAppServerSession({ input: srv.input, output: srv.output, prompt: 'p', cwd: '/w', timeoutMs: 3000, judge: async () => 'accept' });
  assert.equal(reply, 'ok');
  assert.deepEqual(srv.received.find((m) => m.id === 950)?.result, {}, '미처리 요청에 응답이 없다 — codex가 응답을 기다리며 턴이 상한까지 멈춘다');
  assert.deepEqual(srv.received.find((m) => m.id === 951)?.result, {}, 'MCP 도구 승인이 아닌 elicitation은 열지 않는다(빈 응답=거절)');
});

test('codex app-server — 인자를 못 읽은 MCP 승인은 크루 서버 밖이면 닫는다(검수 MED-5), 인자 없는 도구({})는 통과', async () => {
  const judge = makeApprovalJudge(paths(WS).root);
  assert.equal(await judge('mcp', { server: 'filesystem', tool: 'write_file', params: '{"path":"x"}' }), 'decline');
  assert.equal(await judge('mcp', { server: 'filesystem', tool: 'write_file' }), 'decline');
  assert.equal(await judge('mcp', { server: 'crew', tool: 'list_routines' }), 'accept');
  assert.equal(await judge('mcp', { server: 'probe', tool: 'probe_time', params: {} }), 'accept'); // 0.149.1 실측: 인자 없는 호출도 {}로 온다
});

test('이중 실행 판정은 같은 대상·내용일 때만 — 다른 결재·다른 수신자 쪽지는 실행된다(검수 MED-3·4)', async () => {
  const { handledByTool } = await import('../src/cli-directives.mjs');
  const calls = [{ name: 'request_approval', input: { action: '견적 메일 발송', reason: 'r' } }, { name: 'delegate', input: { to: 'bee', task: 't' } }];
  assert.equal(handledByTool({ action: 'approval', request: '견적  메일 발송' }, calls), true, '같은 결재(공백 차이)는 건너뛴다');
  assert.equal(handledByTool({ action: 'approval', request: '계약서 서명' }, calls), false, '별개 결재가 버려졌다');
  assert.equal(handledByTool({ action: 'mail', to: 'cee', message: 'm' }, calls), false, '다른 수신자 쪽지가 버려졌다');
  assert.equal(handledByTool({ action: 'mail', to: 'BEE', message: 'm' }, calls), true);
  assert.equal(handledByTool({ action: 'schedule', prompt: 'x' }, calls), false);
  assert.equal(handledByTool({ action: 'approval', request: 'x' }, null), false, '다리 없는 러너(antigravity)는 종전대로 실행');
});

test('크루 다리 러너는 턴 격리 홈을 쓰는 codex만 — gemini CLI(회사당 홈)는 동시 턴 신원 섞임 때문에 제외(검수 HIGH-2)', async () => {
  const { RUNNERS } = await import('../src/runners.mjs');
  assert.equal(RUNNERS.codex.crewBridge, true);
  assert.ok(!RUNNERS.gemini.crewBridge && !RUNNERS.antigravity.crewBridge);
});
