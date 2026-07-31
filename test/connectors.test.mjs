// MCP OAuth 커넥터 코어 행동 테스트 — 설계서 docs/mcp-oauth-design.md §2-1·§2-4 / 스파이크 §④ US-1 검증 정의.
// 상대는 test/helpers/oauth-test-server.mjs(자동승인 AS+RS — 스파이크 실증 코드 승격)라 브라우저·실계정 0으로
// 실왕복이 돈다. "브라우저 + 사람 동의"는 approve() 헬퍼의 fetch 2회(인가 URL → 302 → 콜백)가 대역이다.
// 임시 ARGO_ROOT 자가 설정 — 실데이터 미접촉(account-scope 테스트와 동일 패턴).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-conn-')); // import보다 먼저
const { startConnect, callConnectorTool, listConnections, listConnectorTools, closeConnectorPools, CONNECTOR_SECRETS_BASE } = await import('../src/connectors.mjs');
const { createCompany, WS_ROOT } = await import('../src/workspace.mjs');
const { readEvents } = await import('../src/events.mjs');
const { startOauthTestServer } = await import('./helpers/oauth-test-server.mjs');

const WS = 'co-conn';
await createCompany(WS, '커넥터 테스트사', 'captain');
const storePath = join(WS_ROOT, WS, CONNECTOR_SECRETS_BASE);
const rawStore = async () => JSON.parse(await readFile(storePath, 'utf8'));

const servers = [];
async function newServer(opts) { const s = await startOauthTestServer(opts); servers.push(s); return s; }
after(async () => { await closeConnectorPools(); for (const s of servers) await s.close(); });

/** 브라우저·사람 동의 대역 — 인가 URL GET(302) → 콜백 귀환 GET. tamperState로 위조 콜백을 만든다. */
async function approve(authUrl, { tamperState } = {}) {
  const r1 = await fetch(authUrl, { redirect: 'manual' });
  assert.equal(r1.status, 302, `authorize는 302여야 한다 (got ${r1.status})`);
  const loc = new URL(r1.headers.get('location'));
  if (tamperState !== undefined) loc.searchParams.set('state', tamperState);
  return fetch(loc);
}

const conn = async (id) => (await listConnections(WS)).find((c) => c.id === id);

// ── ① 최초 연결 왕복: 디스커버리 → DCR → PKCE → localhost 콜백 → 토큰 영속 → 도구 호출 ──
const S1 = await newServer();
const ID1 = 'demo-main';

test('최초 연결 왕복 — DCR·PKCE·토큰 영속·도구 호출·원장까지', async () => {
  const { authUrl, done } = await startConnect(WS, { id: ID1, url: S1.mcpUrl, scopes: ['spike.read', 'spike.write'] });
  assert.ok(authUrl?.startsWith(S1.base), '인가 URL은 테스트 AS를 가리킨다');
  assert.match(authUrl, /code_challenge_method=S256/, 'PKCE S256');
  assert.equal((await conn(ID1)).status, 'connecting', '진행 중 상태를 폴링으로 볼 수 있다');

  await approve(authUrl);
  assert.deepEqual(await done, { ok: true, serverId: ID1 });
  assert.equal(S1.counters.dcr, 1, '카탈로그 client 없음 → SDK가 DCR로 자동 등록');

  const c = await conn(ID1);
  assert.equal(c.status, 'connected');
  assert.equal(c.hasTokens, true);

  const r = await callConnectorTool(WS, ID1, 'search_threads_demo', { query: 'is:unread' });
  assert.equal(r.ok, true);
  assert.equal(r.isError, false);
  assert.match(r.content[0].text, /demo results/);

  const ev = (await readEvents(WS)).find((e) => e.type === 'connector');
  assert.deepEqual({ server: ev.server, tool: ev.tool, ok: ev.ok }, { server: ID1, tool: 'search_threads_demo', ok: true }, '호출마다 원장 기록(활동 화면 원천)');
});

test('토큰 저장소 — 0600 · 시크릿은 목록 API에 새지 않는다', async () => {
  assert.equal((await stat(storePath)).mode & 0o777, 0o600, '커넥터 토큰 파일은 소유자 전용');
  const at = (await rawStore()).servers[ID1].tokens.access_token;
  assert.ok(at?.length > 10, '토큰이 영속되어 있다');
  assert.equal(JSON.stringify(await listConnections(WS)).includes(at), false, 'listConnections에 토큰 무노출');
});

test('tools/list 캐시 — annotations가 그대로 통과한다(결재 분류의 원료)', async () => {
  const { ok, tools } = await listConnectorTools(WS, ID1);
  assert.equal(ok, true);
  const by = Object.fromEntries(tools.map((t) => [t.name, t]));
  assert.equal(by.search_threads_demo.annotations.readOnlyHint, true);
  assert.equal(by.send_mail_demo.annotations.readOnlyHint, false);
  assert.equal(by.create_draft_demo.annotations?.readOnlyHint, undefined, 'annotations 미제공 도구는 미제공 그대로(이름 휴리스틱 대상)');
});

// ── 사전 등록 client(구글류 DCR 미지원 — 설계서 §2-4 oauth.client_id) ──
test('사전 등록 client_id — SDK가 DCR을 건너뛰고 왕복이 성립한다', async () => {
  const s = await newServer();
  const id = 'demo-fixed';
  const { authUrl, done } = await startConnect(WS, { id, url: s.mcpUrl, scopes: ['spike.read'], oauth: { client_id: 'argo-fixed-client' } });
  // DCR 미지원 서버 대역: AS에 같은 client_id를 사전 배치(redirect_uri는 이번 시도의 포트 0 콜백)
  const redirectUri = new URL(authUrl).searchParams.get('redirect_uri');
  s.registerClient({
    client_id: 'argo-fixed-client', redirect_uris: [redirectUri], token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], scope: 'spike.read',
  });
  await approve(authUrl);
  assert.equal((await done).ok, true);
  assert.equal(s.counters.dcr, 0, 'clientInformation 제공 시 DCR 미호출(스파이크 §② 소스 확인의 행동 잠금)');
  assert.equal((await callConnectorTool(WS, id, 'search_threads_demo', { query: 'q' })).ok, true);
});

// ── ② 만료 → SDK 자동 refresh(코어는 저장 콜백만) ──
test('access 만료 후 호출 — refresh 그랜트로 자동 갱신·재시도된다', async () => {
  const s = await newServer({ accessTtlMs: 1_200 });
  const id = 'demo-ttl';
  const { authUrl, done } = await startConnect(WS, { id, url: s.mcpUrl, scopes: ['spike.read'] });
  await approve(authUrl);
  assert.equal((await done).ok, true);
  assert.equal((await callConnectorTool(WS, id, 'search_threads_demo', { query: 'a' })).ok, true);
  const before = (await rawStore()).servers[id].tokens.access_token;

  await new Promise((r) => setTimeout(r, 1_600)); // 만료 경과
  const r2 = await callConnectorTool(WS, id, 'send_mail_demo', { to: 'demo@example.com', body: 'hi' });
  assert.equal(r2.ok, true, '만료가 사용자 실패로 새지 않는다(SDK 투명 갱신 — 스파이크 실증의 행동 잠금)');
  assert.ok(s.counters.refreshGrants >= 1, 'refresh 그랜트 사용됨');
  assert.notEqual((await rawStore()).servers[id].tokens.access_token, before, '갱신 토큰이 영속됨');
  assert.equal((await conn(id)).status, 'connected');
});

// ── ③ refresh 실패 → "재연결 필요" 강등(조용한 무동작 금지) ──
test('refresh까지 실패 — reauth로 강등되고 이후 호출은 빠르게 정직 실패한다', async () => {
  const s = await newServer({ accessTtlMs: 1_200 });
  const id = 'demo-revoked';
  const { authUrl, done } = await startConnect(WS, { id, url: s.mcpUrl, scopes: ['spike.read'] });
  await approve(authUrl);
  assert.equal((await done).ok, true);
  assert.equal((await callConnectorTool(WS, id, 'search_threads_demo', { query: 'a' })).ok, true);

  s.revokeRefresh();
  await new Promise((r) => setTimeout(r, 1_600)); // 만료 경과 — 이제 갱신 수단이 없다
  const r = await callConnectorTool(WS, id, 'search_threads_demo', { query: 'b' });
  assert.equal(r.ok, false);
  assert.equal(r.isError, true);
  assert.equal(r.error, 'reauth_required');
  assert.equal((await conn(id)).status, 'reauth', '상태가 "재연결 필요"로 강등된다');

  const again = await callConnectorTool(WS, id, 'search_threads_demo', { query: 'c' });
  assert.equal(again.error, 'reauth_required', '강등 후엔 저장소 게이트가 즉시 정직 실패');
  const ev = (await readEvents(WS)).find((e) => e.type === 'connector' && e.server === id && e.ok === false);
  assert.ok(ev, '실패도 원장에 남는다');
});

// ── ④ state 불일치 거부(CSRF 방어) ──
test('state 불일치 콜백 — 400 거부·토큰 교환 0·시도 종료', async () => {
  const s = await newServer();
  const id = 'demo-csrf';
  const { authUrl, done } = await startConnect(WS, { id, url: s.mcpUrl, scopes: ['spike.read'] });
  const res = await approve(authUrl, { tamperState: 'forged-state-value' });
  assert.equal(res.status, 400, '위조 콜백은 HTTP 400');
  const out = await done;
  assert.equal(out.ok, false);
  assert.match(out.error, /state/);
  assert.equal(s.counters.codeGrants, 0, '토큰 교환이 일어나지 않았다');
  const c = await conn(id);
  assert.equal(c.status, 'error');
  assert.equal(c.hasTokens, false);
});

// ── ⑤ 콜백 타임아웃(기본 120s — 테스트는 노브로 단축) ──
test('콜백 타임아웃 — 인가 미완이면 시도가 정직하게 만료된다', async () => {
  const s = await newServer();
  const id = 'demo-timeout';
  const { authUrl, done } = await startConnect(WS, { id, url: s.mcpUrl, scopes: ['spike.read'] }, { timeoutMs: 400 });
  assert.ok(authUrl, '인가 URL은 나왔지만 아무도 브라우저를 완료하지 않는다');
  const out = await done;
  assert.equal(out.ok, false);
  assert.match(out.error, /타임아웃/);
  assert.equal((await conn(id)).status, 'error');
});

// ── 미연결·도달 불가의 정직 실패 ──
test('미연결 서버 호출 — 조용한 무동작 대신 정직 실패 + 원장', async () => {
  const r = await callConnectorTool(WS, 'never-connected', 'any_tool', {});
  assert.equal(r.ok, false);
  assert.equal(r.error, 'not_connected');
  assert.ok((await readEvents(WS)).find((e) => e.type === 'connector' && e.server === 'never-connected' && e.ok === false));
});

test('도달 불가 서버 — startConnect가 즉시 오류를 던지고 상태를 남긴다', async () => {
  await assert.rejects(startConnect(WS, { id: 'demo-dead', url: 'http://127.0.0.1:9/mcp', scopes: [] }));
  assert.equal((await conn('demo-dead')).status, 'error');
});

// ── 보관 계약 잠금 — 불변식 전수 수색(2026-07-31)의 판정을 코드로 고정 ──
test('sync EXCLUDE — 커넥터 토큰은 동기화되지 않는다(기기·회사 스코프, workroots 원칙)', async () => {
  const { EXCLUDE } = await import('../src/sync.mjs');
  assert.equal(EXCLUDE(CONNECTOR_SECRETS_BASE), true);
});

test('권한 게이트 — 크루 파일 도구는 커넥터 토큰 파일을 읽고 쓸 수 없다(§2-4 하드라인)', async () => {
  const { makeIsForbidden } = await import('../src/permission-gate.mjs');
  const forbidden = makeIsForbidden(join(WS_ROOT, WS));
  assert.equal(await forbidden(storePath), true, '직속 도트파일 = 회사 금고(기존 규칙 자동 편입의 명시 잠금)');
});

test('권한 게이트(셸) — 자격 파일은 Bash 리터럴 방어에도 등재돼 있다(도구별 판정 갈림 금지)', async () => {
  // 분리 검수 M1 실측: 도트 규칙은 isForbidden에만 있어 같은 파일이 Read=deny / `cat`=allow로 갈렸다.
  // 파일 헤더가 스스로 금지한 패턴이라 셸 목록에도 자격 파일을 등재한다(1차 방어 — 완전 차단은 아님).
  const { makePermissionGate } = await import('../src/permission-gate.mjs');
  const gate = makePermissionGate(WS, 'captain', join(WS_ROOT, WS));
  for (const cmd of [`cat ${CONNECTOR_SECRETS_BASE}`, 'cat .secrets.json', `grep token ./${CONNECTOR_SECRETS_BASE}`]) {
    assert.equal((await gate('Bash', { command: cmd })).behavior, 'deny', `셸 리터럴 방어: ${cmd}`);
  }
  const ok = await gate('Bash', { command: 'ls vault' });
  assert.equal(ok.behavior, 'allow', '평범한 셸 작업은 그대로 통과(과차단 없음)');
});

// ── 분리 검수(PR #213) 지적 반영분의 행동 잠금 ──
test('콜백 서버는 loopback에만 열린다 — 바인드 주소가 관측되고, 아니면 연결이 중단된다(M2)', async () => {
  const s = await newServer();
  const { authUrl, callbackAddress, done } = await startConnect(WS, { id: 'demo-bind', url: s.mcpUrl, scopes: ['spike.read'] });
  assert.equal(callbackAddress, '127.0.0.1', 'LAN에 열리면 이 단언이 먼저 깨진다(설계서 §2-4 유일 네트워크 표면)');
  await approve(authUrl);
  assert.equal((await done).ok, true);
});

test('콜백 경로는 난수 세그먼트 — 포트만 아는 페이지는 진행 중 인가를 끊지 못한다(L3)', async () => {
  const s = await newServer();
  const { authUrl, done } = await startConnect(WS, { id: 'demo-path', url: s.mcpUrl, scopes: ['spike.read'] });
  const redirect = new URL(new URL(authUrl).searchParams.get('redirect_uri'));
  assert.match(redirect.pathname, /^\/callback\/[0-9a-f-]{36}$/, '경로에 난수 세그먼트');

  // 포트 스캔 대역 — 고정 경로 추측은 404이고, 시도는 살아 있어야 한다.
  assert.equal((await fetch(`${redirect.origin}/callback`)).status, 404);
  await approve(authUrl);
  assert.equal((await done).ok, true, '스캔이 시도를 죽이지 않는다');
});

test('평문 http 원격은 거부 — loopback만 예외(L2, OAuth 2.1 TLS 계약)', async () => {
  await assert.rejects(
    startConnect(WS, { id: 'demo-plain', url: 'http://mcp.example.com/mcp' }),
    /https/,
    '평문 원격은 베어러 토큰이 그대로 흐른다',
  );
  const { isTlsOrLoopback } = await import('../src/connectors.mjs');
  assert.deepEqual(
    ['https://x.example/mcp', 'http://127.0.0.1:9/mcp', 'http://localhost:9/mcp', 'http://x.example/mcp', 'ftp://x/mcp'].map(isTlsOrLoopback),
    [true, true, true, false, false],
  );
});

test('연결 성공 후 tools/list 실패 — 열린 클라이언트가 회수된다(M3 누수)', async () => {
  const { poolStats } = await import('../src/connectors.mjs');
  const s = await newServer();
  const id = 'demo-listfail';
  const { authUrl, done } = await startConnect(WS, { id, url: s.mcpUrl, scopes: ['spike.read'] });
  await approve(authUrl);
  assert.equal((await done).ok, true);

  s.setFailToolsList(true); // connect는 되고 tools/list만 실패하는 경로(구글류 401-at-call과 같은 형태)
  const before = { ...poolStats };
  const r = await callConnectorTool(WS, id, 'search_threads_demo', { query: 'x' });
  assert.equal(r.ok, false, '실패는 정직하게');
  assert.ok(poolStats.opened > before.opened, '클라이언트가 열렸다(전제)');
  assert.equal(poolStats.closed - before.closed, poolStats.opened - before.opened, '연 만큼 닫혔다 — close 할당이 늦으면 0이 된다');

  s.setFailToolsList(false);
  assert.equal((await callConnectorTool(WS, id, 'search_threads_demo', { query: 'x' })).ok, true, '다음 호출은 새 연결로 회복');
});

test('크루가 읽는 실패 문구는 회사 언어를 따른다 — 코드는 고정, 문구만 ko/en(L1)', async () => {
  const ko = await callConnectorTool(WS, 'never-connected', 'any_tool', {});
  const en = await callConnectorTool(WS, 'never-connected', 'any_tool', {}, { lang: 'en' });
  assert.equal(ko.error, en.error, '분기용 코드는 언어와 무관하게 안정');
  assert.match(ko.content[0].text, /연결/);
  assert.match(en.content[0].text, /not connected/i);
  assert.doesNotMatch(en.content[0].text, /[가-힣]/, '영어 모드에 한국어가 새지 않는다');
});
