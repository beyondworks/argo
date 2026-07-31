// 커넥터 카탈로그 + 2모드 디스커버리 행동 테스트 (US-2 — 설계서 docs/mcp-oauth-design.md §2-3·§2-4).
//
// 이 스토리가 지키는 계약 두 가지:
//  ① 카탈로그 항목(제품 데이터) → serverDef(코어 인자) 변환이 **순수 함수**로 확정된다.
//  ② 표준 모드(PRM/DCR 자동)와 고정 모드(사전 등록 client_id)가 **같은 startConnect 경로로 수렴**하고,
//     차이는 오직 "DCR을 부르는가"뿐이다 — 그걸 테스트 AS의 DCR 카운터로 행동 관측한다(1 vs 0).
// 상대는 US-1이 승격해 둔 test/helpers/oauth-test-server.mjs(자동승인 AS+RS)라 브라우저·실계정 0으로 돈다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-conncat-')); // import보다 먼저
const {
  CONNECTOR_CATALOG, CONNECTOR_CATALOG_EN, connectorCatalogFor,
  connectorMode, connectorCatalogItemErrors, connectorServerDef,
  mergeConnectorStatus, connectConnector,
} = await import('../src/market.mjs');
const { listConnections, disconnectConnector, callConnectorTool, closeConnectorPools, CONNECTOR_SECRETS_BASE } = await import('../src/connectors.mjs');
const { createCompany, WS_ROOT } = await import('../src/workspace.mjs');
const { startOauthTestServer } = await import('./helpers/oauth-test-server.mjs');

const WS = 'co-conncat';
await createCompany(WS, '커넥터 카탈로그 테스트사', 'captain');

const servers = [];
async function newServer(opts) { const s = await startOauthTestServer(opts); servers.push(s); return s; }
after(async () => { await closeConnectorPools(); for (const s of servers) await s.close(); });

/** 브라우저·사람 동의 대역(connectors.test와 동일 계약) — 인가 URL GET(302) → 콜백 귀환 GET. */
async function approve(authUrl) {
  const r1 = await fetch(authUrl, { redirect: 'manual' });
  assert.equal(r1.status, 302, `authorize는 302여야 한다 (got ${r1.status})`);
  return fetch(new URL(r1.headers.get('location')));
}
const conn = async (id) => (await listConnections(WS)).find((c) => c.id === id);

// ── ① 스키마 검증 — 잘못된 항목은 화면에 카드로 뜨기 전에 걸러야 한다 ──
const OK_ITEM = { id: 'demo-std', name: '데모 커넥터', url: 'https://mcp.example.com/mcp', scopes: ['a.read'], note: '설명' };

test('스키마 — 유효 항목은 오류 0, 위반 항목은 필드명으로 지목된다', () => {
  assert.deepEqual(connectorCatalogItemErrors(OK_ITEM), []);
  assert.deepEqual(connectorCatalogItemErrors({ ...OK_ITEM, id: 'Bad Id' }), ['id']);
  assert.deepEqual(connectorCatalogItemErrors({ ...OK_ITEM, name: '  ' }), ['name']);
  assert.deepEqual(connectorCatalogItemErrors({ ...OK_ITEM, scopes: ['ok', 42] }), ['scopes']);
  assert.deepEqual(connectorCatalogItemErrors({ ...OK_ITEM, dangerous: 'send_mail' }), ['dangerous']);
  assert.deepEqual(connectorCatalogItemErrors({ ...OK_ITEM, oauth: {} }), ['oauth.client_id']);
  assert.deepEqual(connectorCatalogItemErrors(null), ['item']);
});

test('스키마 — 평문 http 원격은 등재 자체가 거부된다(코어의 TLS 판정과 단일 출처)', () => {
  // 카탈로그가 통과시키면 "연결" 버튼이 생기고 startConnect에서야 터진다. 판정은 한 곳(isTlsOrLoopback)에서만.
  assert.deepEqual(connectorCatalogItemErrors({ ...OK_ITEM, url: 'http://mcp.example.com/mcp' }), ['url']);
  assert.deepEqual(connectorCatalogItemErrors({ ...OK_ITEM, url: 'http://127.0.0.1:8080/mcp' }), [], 'loopback은 예외(로컬 테스트 서버)');
  assert.deepEqual(connectorCatalogItemErrors({ ...OK_ITEM, url: 'ftp://x/mcp' }), ['url']);
});

// ── ② 2모드 변환(순수) — 이 분기가 스토리의 심장이다 ──
test('모드 판별 — oauth.client_id 유무가 표준/고정을 가른다', () => {
  assert.equal(connectorMode(OK_ITEM), 'standard');
  assert.equal(connectorMode({ ...OK_ITEM, oauth: { client_id: 'x' } }), 'fixed');
  assert.equal(connectorMode({ ...OK_ITEM, oauth: {} }), 'standard', 'client_id 없는 oauth는 고정 모드가 아니다');
  assert.equal(connectorMode(undefined), 'standard');
});

test('변환 — 표준 모드 serverDef에는 oauth가 실리지 않는다(SDK가 DCR로 스스로 등록)', () => {
  const def = connectorServerDef(OK_ITEM);
  assert.deepEqual(def, { id: 'demo-std', url: 'https://mcp.example.com/mcp', scopes: ['a.read'] });
  assert.equal('oauth' in def, false);
});

test('변환 — 고정 모드는 client_id(+선택 secret)를 그대로 넘긴다', () => {
  const def = connectorServerDef({ ...OK_ITEM, id: 'demo-fix', oauth: { client_id: 'cid-1', client_secret: 'csec-1' } });
  assert.deepEqual(def, {
    id: 'demo-fix', url: 'https://mcp.example.com/mcp', scopes: ['a.read'],
    oauth: { client_id: 'cid-1', client_secret: 'csec-1' },
  });
  const noSecret = connectorServerDef({ ...OK_ITEM, oauth: { client_id: 'cid-2' } });
  assert.equal('client_secret' in noSecret.oauth, false, '없는 secret을 지어내지 않는다(퍼블릭 클라이언트)');
});

test('변환 — 잘못된 항목은 조용히 넘어가지 않고 던진다', () => {
  assert.throws(() => connectorServerDef({ ...OK_ITEM, url: 'http://evil.example/mcp' }), /url/);
});

test('변환 — scopes 배열은 복사된다(카탈로그 상수를 코어가 손대지 못한다)', () => {
  const item = { ...OK_ITEM, scopes: ['a.read', 'a.write'] };
  const def = connectorServerDef(item);
  def.scopes.push('injected');
  assert.deepEqual(item.scopes, ['a.read', 'a.write']);
});

// ── ③ 구글 실측 PRM 픽스처 — 스키마가 실제 등재 대상을 담을 수 있는가 ──
// 출처: 스파이크 리포트 §①(2026-07-31 무자격 프로브 실측). resource·authorization_servers는 리포트가
// 기록한 값 그대로다. scopes_supported는 리포트가 축약 표기(mail.google.com / gmail.modify /
// gmail.readonly)로 남긴 3종이라 그 표기를 그대로 옮겼다 — 이 테스트가 보는 것은 scope **문자열 값**이
// 아니라 "PRM이 선언한 집합을 카탈로그가 그대로 담아 1회 동의로 넘기는가"이다(스파이크 §② 특이점 2).
const GMAIL_PRM = {
  resource: 'https://gmailmcp.googleapis.com/mcp',
  authorization_servers: ['https://accounts.google.com/'],
  scopes_supported: ['mail.google.com', 'gmail.modify', 'gmail.readonly'],
};

test('구글 PRM 실측 픽스처 — 고정 모드 항목이 스키마를 통과하고 scope 합집합이 그대로 실린다', () => {
  // 구글 AS 메타데이터에 registration_endpoint가 없다(실측) → DCR 불가 → 반드시 고정 모드다.
  const item = {
    id: 'google-gmail', name: 'Gmail', note: '읽기·초안 작성(발송 도구는 서버에 없음 — 스파이크 §① 실측)',
    url: GMAIL_PRM.resource,
    scopes: GMAIL_PRM.scopes_supported,
    oauth: { client_id: 'argo-google-client.apps.googleusercontent.com' },
    dangerous: ['create_draft', 'label_thread'],
  };
  assert.deepEqual(connectorCatalogItemErrors(item), [], '실서버 형태가 스키마에 담긴다');
  assert.equal(connectorMode(item), 'fixed');
  const def = connectorServerDef(item);
  assert.equal(def.url, GMAIL_PRM.resource, 'PRM이 선언한 resource가 곧 카탈로그 url');
  assert.deepEqual(def.scopes, GMAIL_PRM.scopes_supported, '도구별 재동의를 막는 합집합 1회 동의');
  assert.equal(def.oauth.client_id, item.oauth.client_id);
  // AS는 카탈로그가 아니라 PRM에서 SDK가 찾는다(스파이크 §② 경계 지도) — 그래서 serverDef에 없다.
  assert.equal('authorization_server' in def, false);
  assert.match(GMAIL_PRM.authorization_servers[0], /^https:\/\//, 'AS는 https(SDK 디스커버리 대상)');
});

test('구글 3서버 분할 — 같은 client_id를 공유하되 서버별 url·scope는 각자 유지된다', () => {
  // gmail/drive/calendar가 서버 3개다(스파이크 ⑤-6). 한 client_id로 묶어도 카탈로그 항목은 3개다.
  const cid = 'argo-google-client.apps.googleusercontent.com';
  const items = [
    { id: 'google-gmail', name: 'Gmail', url: 'https://gmailmcp.googleapis.com/mcp', scopes: ['gmail.readonly'], oauth: { client_id: cid } },
    { id: 'google-drive', name: 'Drive', url: 'https://drivemcp.googleapis.com/mcp', scopes: ['drive.file'], oauth: { client_id: cid } },
    { id: 'google-calendar', name: 'Calendar', url: 'https://calendarmcp.googleapis.com/mcp', scopes: ['calendar.events'], oauth: { client_id: cid } },
  ];
  for (const it of items) assert.deepEqual(connectorCatalogItemErrors(it), [], it.id);
  const defs = items.map(connectorServerDef);
  assert.deepEqual(defs.map((d) => d.oauth.client_id), [cid, cid, cid]);
  assert.equal(new Set(defs.map((d) => d.url)).size, 3, '서버는 3개 — 토큰 저장소도 서버별로 갈린다');
});

// ── ④ 출하 카탈로그 자체의 계약 ──
test('출하 카탈로그 — 등재된 모든 항목은 스키마를 통과한다(등재 시점 게이트)', () => {
  for (const item of CONNECTOR_CATALOG) assert.deepEqual(connectorCatalogItemErrors(item), [], `ko:${item?.id}`);
  for (const item of CONNECTOR_CATALOG_EN) assert.deepEqual(connectorCatalogItemErrors(item), [], `en:${item?.id}`);
});

test('출하 카탈로그 — ko/en 미러는 id·url·scopes·oauth가 동일해야 한다(영어 회사가 다른 서버에 붙지 않게)', () => {
  for (const en of CONNECTOR_CATALOG_EN) {
    const ko = CONNECTOR_CATALOG.find((c) => c.id === en.id);
    assert.ok(ko, `en 전용 항목 금지: ${en.id}`);
    assert.equal(en.url, ko.url);
    assert.deepEqual(en.scopes ?? [], ko.scopes ?? []);
    assert.deepEqual(en.oauth ?? null, ko.oauth ?? null);
  }
  // 언어 선택은 항상 같은 개수를 돌려준다(en 미등재분은 ko로 폴백 — skill/mcp와 동일 관례).
  assert.equal(connectorCatalogFor('en').length, CONNECTOR_CATALOG.length);
  assert.equal(connectorCatalogFor('ko').length, CONNECTOR_CATALOG.length);
});

test('1차 등재는 0 — 실턴 미검증 항목을 싣지 않는다(구글 실서버는 US-8)', () => {
  // 이 단언이 깨지는 날 = 누군가 항목을 실었다는 뜻. 그때 "실턴 1회 통과분인가"를 사람이 확인하고
  // 이 테스트를 항목 검증(위 두 테스트)으로 갈아끼운다. 카탈로그 원칙을 문서가 아니라 게이트로 둔다.
  assert.deepEqual(CONNECTOR_CATALOG.map((c) => c.id), [], '검증 안 된 커넥터가 화면에 뜨면 "연결" 버튼이 거짓말이 된다');
});

// ── ⑤ 카탈로그 × 상태 병합(순수) ──
test('병합 — 연결 기록이 없으면 disconnected, 있으면 상태·오류코드가 실린다', () => {
  const catalog = [{ id: 'a', name: 'A', note: '설명', scopes: ['s1'], dangerous: ['send'] }, { id: 'b', name: 'B' }];
  const rows = mergeConnectorStatus(catalog, [{ id: 'b', status: 'reauth', hasTokens: true, errorCode: 'reauth_required', error: '만료' }]);
  assert.deepEqual(rows[0], { id: 'a', name: 'A', note: '설명', status: 'disconnected', hasTokens: false, scopes: ['s1'], dangerous: ['send'] });
  assert.deepEqual(rows[1], { id: 'b', name: 'B', note: '', status: 'reauth', hasTokens: true, errorCode: 'reauth_required', error: '만료' });
});

test('병합 — 카탈로그에서 내려간 연결은 orphan으로 남는다(해제 버튼이 사라지지 않게)', () => {
  const rows = mergeConnectorStatus([], [{ id: 'gone', status: 'connected', hasTokens: true }]);
  assert.deepEqual(rows, [{ id: 'gone', name: 'gone', note: '', status: 'connected', hasTokens: true, orphan: true }]);
});

test('병합 — 기본 인자로도 죽지 않는다(연결 0·카탈로그 0)', () => {
  assert.deepEqual(mergeConnectorStatus(), []);
});

// ── ⑥ 실왕복 — 두 모드가 같은 경로로 수렴한다(핵심 행동 증거) ──
test('표준 모드 실왕복 — 카탈로그에 oauth가 없으면 SDK가 DCR로 등록한다(DCR 1회)', async () => {
  const s = await newServer();
  const catalog = [{ id: 'std-live', name: '표준 데모', url: s.mcpUrl, scopes: ['spike.read'], note: '' }];
  const { authUrl, done } = await connectConnector(WS, 'std-live', { catalog });
  assert.ok(authUrl?.startsWith(s.base), '인가 URL은 테스트 AS를 가리킨다');
  await approve(authUrl);
  assert.deepEqual(await done, { ok: true, serverId: 'std-live' });
  assert.equal(s.counters.dcr, 1, '표준 모드 = 동적 클라이언트 등록 1회');
  assert.equal((await conn('std-live')).status, 'connected');
  assert.equal((await callConnectorTool(WS, 'std-live', 'search_threads_demo', { query: 'q' })).ok, true, '연결 후 도구가 실제로 돈다');
});

test('고정 모드 실왕복 — 카탈로그 client_id가 있으면 DCR을 건너뛴다(DCR 0회)', async () => {
  const s = await newServer();
  const CID = 'argo-catalog-fixed-client';
  const catalog = [{ id: 'fix-live', name: '고정 데모', url: s.mcpUrl, scopes: ['spike.read'], note: '', oauth: { client_id: CID } }];
  const { authUrl, done } = await connectConnector(WS, 'fix-live', { catalog });
  // DCR 미지원 서버(구글류) 대역 — AS에 같은 client_id를 사전 배치한다. redirect_uri는 이번 시도의 포트.
  s.registerClient({
    client_id: CID, redirect_uris: [new URL(authUrl).searchParams.get('redirect_uri')],
    token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'], scope: 'spike.read',
  });
  await approve(authUrl);
  assert.deepEqual(await done, { ok: true, serverId: 'fix-live' });
  assert.equal(s.counters.dcr, 0, '고정 모드 = DCR 미호출 — 모드 분기가 죽으면 여기서 1이 된다');
  assert.equal(s.counters.codeGrants, 1, '같은 startConnect 경로로 토큰 교환까지 수렴한다');
  assert.equal((await callConnectorTool(WS, 'fix-live', 'search_threads_demo', { query: 'q' })).ok, true);
});

test('카탈로그에 없는 id — 조용한 무동작 대신 정직 실패, 문구는 회사 언어를 따른다', async () => {
  await assert.rejects(connectConnector(WS, 'nope', { catalog: [] }), /카탈로그에 없는 커넥터/);
  await assert.rejects(connectConnector(WS, 'nope', { catalog: [], lang: 'en' }), /No such connector/);
});

// ── ⑦ 해제 — 토큰 삭제 + 풀 정리 ──
test('해제 — 자격이 사라지고 이후 호출은 미연결로 정직 실패한다', async () => {
  const s = await newServer();
  const catalog = [{ id: 'drop-live', name: '해제 데모', url: s.mcpUrl, scopes: ['spike.read'], note: '' }];
  const { authUrl, done } = await connectConnector(WS, 'drop-live', { catalog });
  await approve(authUrl);
  assert.equal((await done).ok, true);
  assert.equal((await conn('drop-live')).hasTokens, true);

  const out = await disconnectConnector(WS, 'drop-live');
  assert.deepEqual(out, { ok: true, removed: true });
  assert.equal(await conn('drop-live'), undefined, '목록에서 사라진다');
  // 저장소 원문에도 토큰이 남지 않는다 — "화면에서만 사라짐"이면 자격은 그대로 살아 있는 것이다.
  const raw = JSON.parse(await readFile(join(WS_ROOT, WS, CONNECTOR_SECRETS_BASE), 'utf8'));
  assert.equal('drop-live' in raw.servers, false);

  const r = await callConnectorTool(WS, 'drop-live', 'search_threads_demo', { query: 'q' });
  assert.equal(r.error, 'not_connected');
});

test('해제 — 없는 연결을 해제해도 터지지 않고 removed:false로 정직 보고', async () => {
  assert.deepEqual(await disconnectConnector(WS, 'never-existed'), { ok: true, removed: false });
});

test('해제 후 재연결 — 같은 카탈로그 항목으로 다시 연결된다(자격은 새로 받는다)', async () => {
  const s = await newServer();
  const catalog = [{ id: 'again-live', name: '재연결 데모', url: s.mcpUrl, scopes: ['spike.read'], note: '' }];
  const first = await connectConnector(WS, 'again-live', { catalog });
  await approve(first.authUrl);
  assert.equal((await first.done).ok, true);
  await disconnectConnector(WS, 'again-live');

  const second = await connectConnector(WS, 'again-live', { catalog });
  await approve(second.authUrl);
  assert.equal((await second.done).ok, true, '해제가 재연결 경로를 막지 않는다');
  assert.equal(s.counters.dcr, 2, '자격을 지웠으니 클라이언트 등록도 새로 한다(표준 모드)');
});

// ── ⑧ 라우트 배선 — next/headers 때문에 임포트가 안 되므로 소스로 잠근다(이 레포의 기존 관례) ──
test('마켓 라우트 — 커넥터 연결·해제가 guardCompany 뒤에 배선돼 있다', async () => {
  const src = await readFile(new URL('../app/api/companies/[ws]/market/route.js', import.meta.url), 'utf8');
  for (const [handler, body] of Object.entries({
    GET: src.split('export async function GET')[1].split('export async function')[0],
    POST: src.split('export async function POST')[1].split('export async function')[0],
    DELETE: src.split('export async function DELETE')[1],
  })) {
    assert.match(body, /guardCompany\(ws\)/, `${handler}에 회사 가드가 있어야 한다`);
  }
  assert.match(src, /kind === 'connector'/, 'POST 연결 분기');
  // 해제가 else(=MCP)로 흘러가면 존재하지 않는 MCP를 지우고 ok를 돌려주는 조용한 무동작이 된다.
  assert.match(src, /kind === 'connector'\) await disconnectConnector\(ws, id\)/, 'DELETE 해제 분기(명시)');
  assert.match(src, /mergeConnectorStatus\(connectorCatalogFor\(lang\), connections\)/, 'GET 병합(회사 언어)');
});
