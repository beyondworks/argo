// SDK 크루 표면(use_connector) 행동 테스트 — 설계서 docs/mcp-oauth-design.md §2-2 (US-3).
//
// 소스 문자열 단언이 아니라 **크루 MCP 서버를 실제로 띄워** 도구 목록·호출을 돌린다(이 레포 교훈:
// "소스문자열 테스트는 분기가 도는지를 못 본다"). 상대 서버는 test/helpers/oauth-test-server.mjs
// (자동승인 AS+RS)라 브라우저·실계정 0으로 OAuth 왕복부터 도구 호출까지 실제로 돈다.
// 임시 ARGO_ROOT 자가 설정 — 실데이터 미접촉(connectors.test와 동일 패턴).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-conn-surface-')); // import보다 먼저
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
const { startConnect, closeConnectorPools, connectorBriefing, CONNECTOR_SECRETS_BASE } = await import('../src/connectors.mjs');
const { makeCrewServer, connectorToolDescription, commonDirectives, CONNECTOR_DESC_CAP } = await import('../src/chat.mjs');
const { createCompany, WS_ROOT } = await import('../src/workspace.mjs');
const { readEvents } = await import('../src/events.mjs');
const { startOauthTestServer } = await import('./helpers/oauth-test-server.mjs');

const WS = 'co-surface'; // 연결 1개(실왕복)
const WS_EMPTY = 'co-surface-empty'; // 연결 0
const WS_REAUTH = 'co-surface-reauth'; // 재연결 필요 1개
const WS_PENDING = 'co-surface-pending'; // 미성립(연결 중·실패)만
for (const [id, name] of [[WS, '표면 테스트사'], [WS_EMPTY, '무연결사'], [WS_REAUTH, '재연결사'], [WS_PENDING, '미성립사']]) await createCompany(id, name, 'captain');

const servers = [];
const clients = [];
after(async () => {
  for (const c of clients) await c.close().catch(() => {});
  await closeConnectorPools();
  for (const s of servers) await s.close();
});

/** 브라우저·사람 동의 대역(connectors.test와 동일) — 인가 URL GET(302) → 콜백 귀환 GET. */
async function approve(authUrl) {
  const r1 = await fetch(authUrl, { redirect: 'manual' });
  assert.equal(r1.status, 302, `authorize는 302여야 한다 (got ${r1.status})`);
  return fetch(new URL(r1.headers.get('location')));
}

/** 크루 MCP 서버를 인메모리로 띄우고 붙은 클라이언트를 돌려준다 — 실제 tools/list·tools/call이 돈다. */
async function crewClient(wsId, connectors, lang = 'ko') {
  const server = makeCrewServer(wsId, 'pepper', '페퍼', [], 0, [], null, lang, connectors);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const cli = new Client({ name: 'surface-test', version: '1.0.0' });
  await server.instance.connect(serverSide);
  await cli.connect(clientSide);
  clients.push(cli);
  return cli;
}
const toolNames = async (cli) => (await cli.listTools()).tools.map((t) => t.name);
const textOf = (r) => (r.content ?? []).map((c) => c.text ?? '').join('\n');
const HANGUL = /[가-힣]/;

// ── 실연결 1건 — 이 파일의 모든 "연결됨" 시나리오가 이 왕복 위에서 돈다 ──
const S1 = await startOauthTestServer();
servers.push(S1);
const ID1 = 'demo-surface';
{
  const { authUrl, done } = await startConnect(WS, { id: ID1, url: S1.mcpUrl, scopes: ['spike.read', 'spike.write'] });
  await approve(authUrl);
  assert.equal((await done).ok, true, '사전 조건: 커넥터 연결 왕복이 성립해야 한다');
}

// ── ① 등재 조건 — "연결 0이면 도구 자체를 등재하지 않는다"(없는 능력 광고 금지, 설계서 §2-2) ──
test('연결 0 — use_connector가 크루 도구 목록에 없다', async () => {
  const brief = await connectorBriefing(WS_EMPTY);
  assert.deepEqual(brief, [], '연결이 없는 회사의 요약은 빈 배열');
  const names = await toolNames(await crewClient(WS_EMPTY, brief));
  assert.equal(names.includes('use_connector'), false, `연결 0인데 도구가 등재됐다: ${names.join(', ')}`);
  assert.equal(names.includes('request_approval'), true, '다른 크루 도구는 그대로 — 서버 자체는 살아 있다(대조군)');
});

test('미성립 연결(연결 중·실패)뿐 — 요약에서 빠지고 도구도 등재되지 않는다', async () => {
  // 성립하지 않은 시도를 능력으로 광고하면 크루가 "쓸 수 있다"고 답한 뒤 매번 실패한다.
  await writeFile(join(WS_ROOT, WS_PENDING, CONNECTOR_SECRETS_BASE), JSON.stringify({
    servers: {
      'half-open': { url: S1.mcpUrl, status: 'connecting' },
      'dead': { url: S1.mcpUrl, status: 'error', errorCode: 'connect_failed' },
    },
  }), { mode: 0o600 });
  const brief = await connectorBriefing(WS_PENDING);
  assert.deepEqual(brief, [], `성립하지 않은 연결이 요약에 실렸다: ${JSON.stringify(brief)}`);
  assert.equal((await toolNames(await crewClient(WS_PENDING, brief))).includes('use_connector'), false);
});

test('연결 1+ — use_connector가 등재되고 설명에 연결된 서버·도구가 실린다', async () => {
  const brief = await connectorBriefing(WS);
  assert.deepEqual(brief.map((c) => c.id), [ID1]);
  assert.deepEqual(brief[0].tools.slice().sort(), ['create_draft_demo', 'search_threads_demo', 'send_mail_demo'], '턴 시작 조회가 원격 도구 목록을 실제로 가져온다');

  const cli = await crewClient(WS, brief);
  const tools = (await cli.listTools()).tools;
  const uc = tools.find((t) => t.name === 'use_connector');
  assert.ok(uc, `use_connector 미등재: ${tools.map((t) => t.name).join(', ')}`);
  assert.match(uc.description, new RegExp(ID1), '설명에 연결된 서버 id');
  assert.match(uc.description, /search_threads_demo/, '설명에 그 서버의 도구 이름');
  assert.deepEqual(Object.keys(uc.inputSchema.properties).sort(), ['args', 'server', 'tool'], '입력 계약 { server, tool, args }');
});

// ── ② 수렴 — 호출이 코어 callConnectorTool 단일 경로를 타고 원격 서버까지 간다 ──
test('use_connector 실왕복 — 원격 응답이 그대로 오고 원장에 커넥터 호출이 남는다', async () => {
  const cli = await crewClient(WS, await connectorBriefing(WS));
  // 원격 서버만이 되돌려줄 수 있는 고유 토큰 — 표면이 지어낸 답을 원왕복으로 오인하지 않게.
  const marker = 'surface-roundtrip-42';
  const r = await cli.callTool({ name: 'use_connector', arguments: { server: ID1, tool: 'search_threads_demo', args: { query: marker } } });
  assert.equal(r.isError ?? false, false);
  assert.match(textOf(r), new RegExp(`demo results for "${marker}"`), '원격 MCP 서버의 실제 응답이 크루에게 그대로 전달된다');

  const ev = (await readEvents(WS)).find((e) => e.type === 'connector' && e.tool === 'search_threads_demo');
  assert.deepEqual({ server: ev?.server, ok: ev?.ok }, { server: ID1, ok: true }, '코어 원장 기록 — 호출이 callConnectorTool로 수렴했다는 부작용 증거');
});

// ── ③ 정직한 문구 — 미연결·재연결 필요에서 조용한 무동작 금지 ──
test('미연결 서버 호출 — 크루가 "연결되어 있지 않다"는 안내를 받는다(ko)', async () => {
  const cli = await crewClient(WS, await connectorBriefing(WS));
  const r = await cli.callTool({ name: 'use_connector', arguments: { server: 'never-connected', tool: 'x', args: {} } });
  assert.equal(r.isError, true, '실패는 실패로 — 성공처럼 보이면 크루가 "했다"고 답한다');
  assert.match(textOf(r), /연결되어 있지 않습니다/);
  // 텍스트만 보면 코어 문구를 **위조한 표면**도 통과한다(분리 검수 실증: 위조 변이가 12건 중 11건을
  // 지나갔다). 코어를 실제로 지났는지는 원장 부작용이 증명한다 — 실패 경로도 finally에서 기록된다.
  assert.ok(
    (await readEvents(WS)).some((e) => e.type === 'connector' && e.server === 'never-connected' && e.ok === false),
    '표면이 코어(callConnectorTool)를 실제로 지나야 한다 — 지어낸 문구 금지',
  );
});

test('영어 회사 — 도구 설명·오류 문구에 한국어 누출 0', async () => {
  const brief = await connectorBriefing(WS);
  const cli = await crewClient(WS, brief, 'en');
  const uc = (await cli.listTools()).tools.find((t) => t.name === 'use_connector');
  assert.equal(HANGUL.test(uc.description), false, `영어 모드 설명에 한국어: ${uc.description}`);
  const r = await cli.callTool({ name: 'use_connector', arguments: { server: 'never-connected', tool: 'x', args: {} } });
  assert.match(textOf(r), /is not connected/);
  assert.equal(HANGUL.test(textOf(r)), false, '영어 모드 오류 문구에 한국어');
  assert.ok(
    (await readEvents(WS)).some((e) => e.type === 'connector' && e.server === 'never-connected' && e.ok === false),
    '영어 경로도 코어를 지난다(문구만 영어로 지어내는 표면 배제)',
  );
});

test('재연결 필요 — 도구는 등재하되 표시하고, 호출은 정직한 재연결 안내를 준다', async () => {
  // 저장소를 직접 만든다: 만료·폐기를 실시간으로 재현하면 타이밍 의존 단언이 되고(CI 취약),
  // 여기서 검증할 것은 "상태가 reauth일 때 표면이 무엇을 하는가"뿐이다. 저장 포맷은
  // connectors.test가 이미 읽는 계약(.connector-secrets.json).
  const id = 'demo-stale';
  await writeFile(join(WS_ROOT, WS_REAUTH, CONNECTOR_SECRETS_BASE),
    JSON.stringify({ servers: { [id]: { url: S1.mcpUrl, status: 'reauth', errorCode: 'reauth_required' } } }), { mode: 0o600 });

  const brief = await connectorBriefing(WS_REAUTH);
  assert.deepEqual(brief, [{ id, status: 'reauth', tools: [], more: 0 }], '재연결 필요도 요약에 남는다 — 숨기면 사장이 재연결 사실을 못 듣는다');

  const cli = await crewClient(WS_REAUTH, brief);
  const uc = (await cli.listTools()).tools.find((t) => t.name === 'use_connector');
  assert.ok(uc, '재연결 필요뿐이어도 도구는 등재된다(호출해야 정직한 안내가 나간다)');
  assert.match(uc.description, /재연결 필요/, '설명에 상태 표시');

  const r = await cli.callTool({ name: 'use_connector', arguments: { server: id, tool: 'search_threads_demo', args: { query: 'q' } } });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /다시 연결해 주세요/, '"다시 연결하라"는 행동 지침까지 준다');
  assert.ok(
    (await readEvents(WS_REAUTH)).some((e) => e.type === 'connector' && e.server === id && e.ok === false),
    '재연결 안내도 코어가 낸 것이어야 한다',
  );
  assert.match(uc.description, /재연결 후 사용 가능/, 'reauth는 "지금 못 불러왔다"가 아니라 상태를 말한다');
});

test('도구 목록 조회 실패 — 서버는 남기되 "목록을 불러오지 못했다"고 정직 표기(빈 목록으로 위장 금지)', async () => {
  S1.setFailToolsList(true);
  await closeConnectorPools(); // 캐시된 목록이 아니라 새 조회가 실패 경로를 타게
  try {
    const brief = await connectorBriefing(WS);
    assert.deepEqual(brief, [{ id: ID1, status: 'connected', tools: [], more: 0 }], '조회 실패가 턴을 죽이지 않는다');
    assert.match(connectorToolDescription(brief, 'ko'), /불러오지 못했다/);
    assert.match(connectorToolDescription(brief, 'en'), /unavailable right now/);
  } finally {
    S1.setFailToolsList(false);
    await closeConnectorPools();
  }
});

// ── ④ 상한 — 설명은 매 턴 컨텍스트에 실린다(설계서 §2-2 "상한 두고 절단") ──
test('도구 이름 상한 — 서버당 cap개까지, 나머지는 개수로 압축', async () => {
  const brief = await connectorBriefing(WS, { cap: 1 });
  assert.equal(brief[0].tools.length, 1);
  assert.equal(brief[0].more, 2, '남은 도구는 개수로만');
  assert.match(connectorToolDescription(brief, 'ko'), /외 2개/);
  assert.match(connectorToolDescription(brief, 'en'), /\(\+2 more\)/);
});

test('설명 총량 상한 — 초과분은 절단 표시와 함께 잘린다', () => {
  const huge = [{ id: 'big', status: 'connected', tools: Array.from({ length: 400 }, (_, i) => `tool_${i}`), more: 0 }];
  const d = connectorToolDescription(huge, 'ko');
  assert.match(d, /…\(생략\)/);
  assert.equal(d.includes('tool_399'), false, '상한을 넘은 꼬리는 실제로 잘려야 한다');
  assert.match(connectorToolDescription(huge, 'en'), /…\(truncated\)/);
  assert.ok(d.length < CONNECTOR_DESC_CAP + 700, `설명이 상한 + 고정문 범위를 넘었다: ${d.length}자`);
});

// ── ⑤ 프롬프트 정합 — 커넥터는 러너 무관(MCP 절의 "SDK 턴에서 실행"과 다른 사실) ──
test('commonDirectives — 연결이 있을 때만 커넥터 절이 붙고, 러너 무관 사실을 말한다', () => {
  const none = commonDirectives({ hasTools: true, lang: 'ko' });
  assert.equal(/커넥터/.test(none), false, '연결 0이면 커넥터 문장 없음(없는 능력 광고 금지)');

  const ko = commonDirectives({ hasTools: true, lang: 'ko', connectors: [{ id: 'gmail', status: 'connected', tools: [], more: 0 }, { id: 'notion', status: 'reauth', tools: [], more: 0 }] });
  assert.match(ko, /러너와 무관하게/);
  assert.match(ko, /gmail, notion\(재연결 필요\)/, '상태까지 이름 줄에 정직 표기');
  assert.match(ko, /결재를 먼저 올려라/, '쓰기 계열 결재 경유 규칙(설계서 §2-4 1차 규칙)');

  const en = commonDirectives({ hasTools: true, lang: 'en', connectors: [{ id: 'gmail', status: 'connected', tools: [], more: 0 }] });
  assert.match(en, /any runner/);
  assert.equal(HANGUL.test(en.split('\n').find((l) => l.includes('connectors')) ?? ''), false, '영어 커넥터 절에 한국어 누출');
});

test('배선 — SDK 턴이 턴 요약을 크루 서버와 프롬프트 양쪽에 넘긴다(소스 고정)', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../src/chat.mjs', import.meta.url), 'utf8');
  assert.match(src, /const connectors = await connectorBriefing\(wsId\)/, 'SDK 턴이 커넥터 요약을 읽지 않는다');
  assert.match(src, /mirrorCtx, lang, connectors\)/, '크루 서버에 요약이 전달되지 않는다');
  assert.match(src, /commonDirectives\(\{ caps, connectedMcp, connectors,/, '시스템 프롬프트에 요약이 전달되지 않는다');
});
