// 구글 원격 MCP(Gmail·Calendar)는 initialize·tools/list를 무인증으로 받고 tools/call에서만 401을 낸다(2026-10-14 실측).
// startConnect가 probe.connect 성공을 "무보호 서버"로 읽어 동의 없이 'connected'를 저장했고, 첫 도구 호출이 '인증 만료'로 떨어졌다(상주 재현, 총괄 2026-10-14).
// 잠그는 계약:
//  ① 진짜 무보호 서버(카탈로그에 oauth·scopes 없음)는 종전대로 바로 connected — authUrl 없음(회귀 핀, 수정 전에도 초록)
//  ② 인증이 필요한 항목(scopes 또는 고정 client_id)인데 initialize가 무인증으로 통과하면 connected를 저장하지 않고 동의 흐름(authUrl)으로 간다.
//     동의 뒤 토큰이 실제로 저장돼야만 connected — DCR(표준)·고정 client(구글) 두 모드 모두
//  ③ 인가 URL의 scope는 카탈로그 scope 그대로 — PRM scopes_supported 전체(구글은 mail.google.com 전권 포함)를 요청하지 않는다
//  ④ 옛 버전이 토큰 없이 'connected'로 저장한 기록(인증 필요 항목)은 목록·턴 요약·도구 호출에서 '재연결 필요'. 무보호 기록은 그대로
//  ⑤ 카탈로그의 Gmail·Calendar 둘 다 인증 필요 항목으로 판정된다
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFile, readFile } from 'node:fs/promises';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-open-init-')); // import보다 먼저
const { startConnect, listConnections, callConnectorTool, connectorBriefing, closeConnectorPools, CONNECTOR_SECRETS_BASE } = await import('../src/connectors.mjs');
const { CONNECTOR_CATALOG, connectorServerDef } = await import('../src/market.mjs');
const { createCompany, paths } = await import('../src/workspace.mjs');
const { startOauthTestServer } = await import('./helpers/oauth-test-server.mjs');

const WS = 'co-open-init';
await createCompany(WS, '열린 initialize 테스트사', 'captain');
const GOOGLE_LIKE = ['initialize', 'notifications/initialized', 'tools/list']; // 구글 실측과 같은 무인증 메서드
const servers = [];
const server = async (opts) => { const s = await startOauthTestServer(opts); servers.push(s); return s; };
after(async () => { await closeConnectorPools(); for (const s of servers) await s.close(); });
const approve = async (authUrl) => { const r1 = await fetch(authUrl, { redirect: 'manual' }); return fetch(new URL(r1.headers.get('location'))); };
const conn = async (id) => (await listConnections(WS)).find((c) => c.id === id);
const store = async () => JSON.parse(await readFile(join(paths(WS).root, CONNECTOR_SECRETS_BASE), 'utf8'));

test('① 진짜 무보호 서버(oauth·scopes 없음) — 종전대로 바로 connected, authUrl 없음', async () => {
  const s = await server({ publicMethods: ['*'] });
  const { authUrl, done } = await startConnect(WS, { id: 'open-all', url: s.mcpUrl });
  assert.equal(authUrl, null);
  assert.deepEqual(await done, { ok: true, serverId: 'open-all' });
  assert.equal((await conn('open-all')).status, 'connected');
  assert.equal((await callConnectorTool(WS, 'open-all', 'search_threads_demo', { query: 'q' })).ok, true, '무보호 서버의 도구는 토큰 없이 돈다');
});

test('② 표준(DCR) — initialize 무인증 통과여도 scopes가 있으면 동의로 간다. 동의 전 connected 아님, 동의 뒤 토큰 저장 + connected', async () => {
  const s = await server({ publicMethods: GOOGLE_LIKE });
  const { authUrl, done } = await startConnect(WS, { id: 'open-std', url: s.mcpUrl, scopes: ['spike.read'] });
  assert.ok(authUrl, '동의 URL이 없다 — initialize 통과를 연결 완료로 읽었다');
  assert.notEqual((await conn('open-std')).status, 'connected', '동의 전에 connected로 저장했다');
  await approve(authUrl);
  assert.deepEqual(await done, { ok: true, serverId: 'open-std' });
  const c = await conn('open-std');
  assert.equal(c.status, 'connected'); assert.equal(c.hasTokens, true, '토큰 없이 connected');
  assert.equal((await callConnectorTool(WS, 'open-std', 'search_threads_demo', { query: 'q' })).ok, true, '동의 뒤 도구 호출이 실제로 돈다');
});

test('② 고정 client(구글 방식) — 같은 흐름, DCR 0회. ③ 인가 URL scope = 카탈로그 scope(PRM 전체 아님)', async () => {
  const s = await server({ publicMethods: GOOGLE_LIKE });
  const CID = 'argo-open-fixed';
  const { authUrl, done } = await startConnect(WS, { id: 'open-fix', url: s.mcpUrl, scopes: ['spike.read'], oauth: { client_id: CID } });
  assert.ok(authUrl, '동의 URL이 없다');
  assert.equal(new URL(authUrl).searchParams.get('scope'), 'spike.read', 'PRM scopes_supported(spike.read spike.write)가 아니라 카탈로그 scope만');
  assert.notEqual((await conn('open-fix')).status, 'connected');
  s.registerClient({ client_id: CID, redirect_uris: [new URL(authUrl).searchParams.get('redirect_uri')], token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], scope: 'spike.read' });
  await approve(authUrl);
  assert.deepEqual(await done, { ok: true, serverId: 'open-fix' });
  assert.equal(s.counters.dcr, 0);
  assert.equal((await conn('open-fix')).hasTokens, true);
  assert.equal((await callConnectorTool(WS, 'open-fix', 'search_threads_demo', { query: 'q' })).ok, true);
});

test('④ 옛 기록 — 토큰 없는 connected(인증 필요 항목)는 목록·턴 요약·도구 호출에서 재연결 필요, 무보호 기록은 그대로', async () => {
  const s = await server({ publicMethods: GOOGLE_LIKE });
  const file = join(paths(WS).root, CONNECTOR_SECRETS_BASE);
  const cur = await store();
  cur.servers['legacy-google'] = { url: s.mcpUrl, status: 'connected', client: { client_id: 'old-fixed' }, verifier: 'v' }; // 옛 버전이 남긴 모양(상주 실측: tokens 없음·verifier만)
  cur.servers['legacy-open'] = { url: s.mcpUrl, status: 'connected' }; // 무보호 서버 기록(client·authRequired 없음)
  await writeFile(file, JSON.stringify(cur));
  const g = await conn('legacy-google');
  assert.equal(g.status, 'reauth', '토큰 없는 connected를 연결된 것으로 광고했다');
  assert.equal(g.errorCode, 'reauth_required');
  assert.equal((await conn('legacy-open')).status, 'connected', '무보호 기록까지 재연결로 바꿨다');
  const brief = await connectorBriefing(WS, { deadlineMs: 2000 });
  assert.equal(brief.find((b) => b.id === 'legacy-google')?.status, 'reauth', '턴 요약이 연결됨으로 광고했다');
  const r = await callConnectorTool(WS, 'legacy-google', 'search_threads_demo', { query: 'q' }, { slug: 'captain' });
  assert.equal(r.error, 'reauth_required', '도구 호출이 토큰 없이 서버로 나갔다');
  assert.equal((await store()).servers['legacy-google'].status, 'connected', '읽기·판정만으로 저장소를 고쳐 쓰지 않는다(재연결 때 바뀐다)');
});

test('⑤ 카탈로그 — Gmail·Calendar 둘 다 인증 필요 항목(고정 client + scopes)', () => {
  for (const id of ['gmail', 'google-calendar']) {
    const item = CONNECTOR_CATALOG.find((c) => c.id === id);
    assert.ok(item?.oauth?.client_id && item.scopes?.length, id);
  }
  const prev = process.env.ARGO_CONNECTOR_GOOGLE_CLIENT_SECRET;
  process.env.ARGO_CONNECTOR_GOOGLE_CLIENT_SECRET = 'test-not-a-secret';
  try { for (const id of ['gmail', 'google-calendar']) { const d = connectorServerDef(CONNECTOR_CATALOG.find((c) => c.id === id)); assert.ok(d.oauth?.client_id && d.scopes?.length, id); } }
  finally { if (prev === undefined) delete process.env.ARGO_CONNECTOR_GOOGLE_CLIENT_SECRET; else process.env.ARGO_CONNECTOR_GOOGLE_CLIENT_SECRET = prev; }
});
