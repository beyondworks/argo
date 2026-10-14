// Gmail 커넥터 등재(유건 지시 2026-10-14, 0.1.108) — 구글 캘린더와 같은 방식: 구글 공식 원격 MCP, 고정 client_id + client_secret_env.
// 여기 적힌 값은 전부 2026-10-14 무인증 실측이다(gmailmcp.googleapis.com/mcp/v1 tools/list·도구별 PRM) — 추측으로 고치면 연결이 조용히 깨진다.
//  ① 카탈로그 — ko·en 같은 id·url·scopes·oauth, 고정 모드, secret은 이름만
//  ② scopes — 23개 도구 전부를 덮는 좁은 쪽 하나(gmail.modify). mail.google.com(영구 삭제·발송 전권)은 쓰지 않는다
//  ③ 결재 — 쓰기 17개(readOnlyHint=false)는 결재 대상, 읽기 6개는 바로. 서버 annotations가 비어도 보완 목록으로 잡힌다
//  ④ 손님 턴 — Gmail도 연결 여부와 상관없이 guest_blocked(러너 무관 단일 지점)
//  ⑤ 허용 목록(fail-closed, 검수 1·총괄 결정 2026-10-14) — 실측 읽기 6개만 결재 없이. 새 도구·readOnlyHint를 잘못 준 도구도 결재. 캘린더는 종전대로
//  ⑥ 테스트 사용자 한정 — 구글이 access_denied로 돌려보내거나 구글 화면에서 멈춰 시간이 지나면 등록 안내로 저장(원인을 숨기지 않는다)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-conn-gmail-')); // import보다 먼저
const { CONNECTOR_CATALOG, CONNECTOR_CATALOG_EN, connectorMode, connectorCatalogFor } = await import('../src/market.mjs');
const { connectorToolNeedsApproval, callConnectorTool } = await import('../src/connectors.mjs');
const { createCompany } = await import('../src/workspace.mjs');
const { startConnect, listConnections, closeConnectorPools } = await import('../src/connectors.mjs');
const { startOauthTestServer } = await import('./helpers/oauth-test-server.mjs');

// 실측 tools/list(2026-10-14) — 이름과 readOnlyHint만. 서버가 도구를 바꾸면 이 표와 카탈로그를 같이 갱신한다.
const GMAIL_TOOLS = [
  ['create_draft', false], ['list_drafts', true], ['get_draft', true], ['get_thread', true], ['get_message', true], ['search_threads', true],
  ['label_thread', false], ['unlabel_thread', false], ['apply_sensitive_thread_label', false], ['trash_thread', false], ['untrash_thread', false],
  ['mark_thread_spam', false], ['unmark_thread_spam', false], ['list_labels', true], ['label_message', false], ['update_message_labels', false],
  ['unlabel_message', false], ['apply_sensitive_message_label', false], ['trash_message', false], ['untrash_message', false],
  ['mark_message_spam', false], ['unmark_message_spam', false], ['create_label', false],
].map(([name, readOnlyHint]) => ({ name, annotations: { readOnlyHint } }));
const WRITES = GMAIL_TOOLS.filter((t) => !t.annotations.readOnlyHint).map((t) => t.name);
const READS = GMAIL_TOOLS.filter((t) => t.annotations.readOnlyHint).map((t) => t.name);

// ── 실서버(가짜 OAuth·MCP, 시험 정의 전에 준비 — 최상위 await가 시험 사이에 있으면 실행기가 앞 시험만 돌리고 끝난다) — 카탈로그 id 'gmail'로 연결해 실제 호출 경로(callConnectorTool → needsApprovalNow)에서 잰다 ──
const WS2 = 'co-gmail-live';
await createCompany(WS2, '지메일 실서버 테스트사', 'captain');
const srv = await startOauthTestServer({ extraTools: [
  { name: 'search_threads', annotations: { readOnlyHint: true } },        // 허용 목록 안의 읽기
  { name: 'brand_new_tool', annotations: { readOnlyHint: true } },        // 구글이 새로 더한 도구(목록 밖) — 읽기라고 말해도
] });
after(async () => { await closeConnectorPools(); await srv.close(); });
{
  const { authUrl, done } = await startConnect(WS2, { id: 'gmail', url: srv.mcpUrl, scopes: ['spike.read'] });
  const r1 = await fetch(authUrl, { redirect: 'manual' });
  await fetch(new URL(r1.headers.get('location')));
  assert.equal((await done).ok, true, '사전 조건: 연결이 성립해야 게이트를 잴 수 있다');
}

const ko = CONNECTOR_CATALOG.find((c) => c.id === 'gmail');
const en = CONNECTOR_CATALOG_EN.find((c) => c.id === 'gmail');

test('① 카탈로그 — ko·en 짝(같은 id·url·scopes·oauth), 고정 모드, secret은 환경변수 이름만', () => {
  assert.ok(ko && en, 'Gmail이 ko·en 카탈로그에 모두 있어야 한다');
  assert.equal(ko.url, 'https://gmailmcp.googleapis.com/mcp/v1', '경로 /mcp/v1이 계약이다(캘린더와 같음)');
  for (const k of ['url', 'scopes', 'oauth', 'dangerous']) assert.deepEqual(en[k], ko[k], `en 미러의 ${k}가 ko와 다르다`);
  assert.equal(connectorMode(ko), 'fixed', 'DCR 미지원(구글) — 고정 모드여야 연결된다');
  const cal = CONNECTOR_CATALOG.find((c) => c.id === 'google-calendar');
  assert.deepEqual(ko.oauth, cal.oauth, '캘린더와 같은 Argo 구글 OAuth 클라이언트');
  assert.equal(ko.oauth.client_secret, undefined, '소스에 secret 값이 실렸다 — 이 레포는 public이다');
  assert.equal(ko.name, 'Gmail'); assert.equal(en.name, 'Gmail');
  assert.doesNotMatch(en.note, /[가-힣]/, 'en 안내에 한국어');
  assert.deepEqual(connectorCatalogFor('en').map((c) => c.id), connectorCatalogFor('ko').map((c) => c.id));
});

test('② scopes — 23개 도구 전부를 덮는 좁은 하나(gmail.modify), 전권 mail.google.com은 쓰지 않는다', () => {
  assert.deepEqual(ko.scopes, ['https://www.googleapis.com/auth/gmail.modify']);
  assert.ok(!ko.scopes.includes('https://mail.google.com/'));
  assert.equal(GMAIL_TOOLS.length, 23);
  assert.ok(!GMAIL_TOOLS.some((t) => /send/.test(t.name)), '실측 시점에 발송 도구가 없다 — 생기면 안내 문구(보내기 없음)를 고친다');
});

test('③ 결재 — 쓰기 17개는 결재, 읽기 6개는 바로. 서버 annotations가 비어도 보완 목록이 쓰기를 잡는다', () => {
  assert.equal(WRITES.length, 17); assert.equal(READS.length, 6);
  assert.deepEqual([...ko.dangerous].sort(), [...WRITES].sort(), '보완 목록이 실측 쓰기 도구와 어긋난다');
  for (const n of WRITES) {
    assert.equal(connectorToolNeedsApproval(n, GMAIL_TOOLS, ko.dangerous), true, `${n} — annotations로`);
    assert.equal(connectorToolNeedsApproval(n, [], ko.dangerous), true, `${n} — annotations가 비어도 보완 목록으로`);
  }
  for (const n of READS) assert.equal(connectorToolNeedsApproval(n, GMAIL_TOOLS, ko.dangerous), false, `${n} — 읽기는 바로`);
});

test('④ 손님 턴 — Gmail 도구도 guest_blocked(연결 여부보다 먼저 막힌다)', async () => {
  const WS = 'co-gmail-guest';
  await createCompany(WS, '지메일 손님 테스트사', 'captain');
  const guest = { kind: 'msgr', uid: 'owner-uid', origin: 'someone-else' };
  for (const tool of ['search_threads', 'create_draft', 'trash_thread']) {
    const r = await callConnectorTool(WS, 'gmail', tool, {}, { slug: 'captain', mirrorCtx: guest });
    assert.equal(r.error, 'guest_blocked', `${tool} — 손님 턴인데 막히지 않았다`);
  }
  const en = await callConnectorTool(WS, 'gmail', 'search_threads', {}, { slug: 'captain', mirrorCtx: guest, lang: 'en' });
  assert.equal(en.error, 'guest_blocked');
});

test('⑤ 허용 목록 판정(순수) — 목록 밖은 annotations와 상관없이 결재, 칸이 없는 항목(캘린더)은 종전 판정', () => {
  assert.deepEqual([...ko.readOnlyAllow].sort(), [...READS].sort(), '허용 목록 = 실측 읽기 6개');
  assert.deepEqual(en.readOnlyAllow, ko.readOnlyAllow);
  const lying = [{ name: 'trash_thread', annotations: { readOnlyHint: true } }, { name: 'brand_new_tool', annotations: { readOnlyHint: true } }];
  assert.equal(connectorToolNeedsApproval('trash_thread', lying, ko.dangerous, ko.readOnlyAllow), true, 'readOnlyHint를 잘못 줘도 결재');
  assert.equal(connectorToolNeedsApproval('brand_new_tool', lying, ko.dangerous, ko.readOnlyAllow), true, '목록에 없는 새 도구는 결재');
  assert.equal(connectorToolNeedsApproval('search_threads', [], [], ko.readOnlyAllow), false, '허용 목록의 읽기는 annotations가 없어도 바로');
  const cal = CONNECTOR_CATALOG.find((c) => c.id === 'google-calendar');
  assert.equal(cal.readOnlyAllow, undefined, '캘린더는 허용 목록을 쓰지 않는다(종전 동작)');
  assert.equal(connectorToolNeedsApproval('brand_new_tool', lying, cal.dangerous, cal.readOnlyAllow), false, '캘린더는 서버 annotations를 그대로 따른다');
});

test('⑤ 실제 호출 — 허용 목록의 읽기는 바로 실행, 목록 밖 새 도구와 readOnlyHint=true인 목록 밖 도구는 결재(서버에 닿지 않음)', async () => {
  const ok = await callConnectorTool(WS2, 'gmail', 'search_threads', {}, { slug: 'captain' });
  assert.equal(ok.ok, true, '허용 목록의 읽기가 막혔다');
  assert.equal(srv.counters.toolCalls.search_threads, 1);
  for (const tool of ['brand_new_tool', 'search_threads_demo']) { // search_threads_demo = 서버가 readOnlyHint=true를 주는 목록 밖 도구
    const before = srv.counters.toolCalls[tool] ?? 0;
    const r = await callConnectorTool(WS2, 'gmail', tool, { query: 'q' }, { slug: 'captain' });
    assert.equal(r.error, 'approval_pending', `${tool} — 허용 목록 밖인데 결재 없이 실행됐다`);
    assert.equal(srv.counters.toolCalls[tool] ?? 0, before, `${tool} — 결재 전에 서버에 닿았다`);
  }
});

async function deny(serverDef, { timeoutMs } = {}) {
  const { authUrl, done } = await startConnect(WS2, serverDef, timeoutMs ? { timeoutMs } : {});
  if (!timeoutMs) {
    const u = new URL(authUrl);
    const cb = new URL(u.searchParams.get('redirect_uri'));
    cb.searchParams.set('error', 'access_denied'); cb.searchParams.set('state', u.searchParams.get('state'));
    await fetch(cb);
  }
  return done;
}

test('⑥ 테스트 사용자 한정 — 구글이 access_denied로 돌려보내면 등록 안내(ko·en), 원래 사유는 errorDetail에 남는다', async () => {
  const out = await deny({ id: 'gmail-deny', url: srv.mcpUrl, scopes: ['spike.read'], testUsersOnly: true });
  assert.equal(out.errorCode, 'test_users_only');
  assert.equal(out.error, '연결이 거부되었습니다(access_denied). 구글 검수 전이라 등록된 사용자만 연결할 수 있습니다 — 연결할 Gmail 주소를 yg@leankim.xyz로 보내 등록을 요청하세요');
  const en = (await listConnections(WS2, { lang: 'en' })).find((c) => c.id === 'gmail-deny');
  assert.equal(en.error, 'The connection was denied (access_denied). This app is awaiting Google\'s review, so only registered users can connect — email the Gmail address you want to connect to yg@leankim.xyz to request registration');
  assert.equal(en.errorDetail, 'access_denied');
});

test('⑥ 테스트 사용자 한정 — 구글 화면에서 멈춰 시간이 지나도 같은 안내(시간 초과 사유를 함께)', async () => {
  const out = await deny({ id: 'gmail-timeout', url: srv.mcpUrl, scopes: ['spike.read'], testUsersOnly: true }, { timeoutMs: 300 });
  assert.equal(out.errorCode, 'test_users_only');
  assert.match(out.error, /Error 403: access_denied.*등록된 사용자만/);
  assert.match(out.error, /yg@leankim\.xyz로 보내 등록을 요청하세요$/, '시간 초과 안내에도 등록 요청 연락처');
});

test('⑥ 대조 — testUsersOnly가 없는 항목(캘린더 등)은 종전 auth_denied 그대로', async () => {
  const out = await deny({ id: 'plain-deny', url: srv.mcpUrl, scopes: ['spike.read'] });
  assert.equal(out.errorCode, 'auth_denied');
  assert.doesNotMatch(out.error, /등록된 사용자만/);
  assert.equal(CONNECTOR_CATALOG.find((c) => c.id === 'google-calendar').testUsersOnly, undefined);
  assert.equal(ko.testUsersOnly, true); assert.equal(en.testUsersOnly, true);
});

test('⑦ 등록 요청 연락처 — 유건 지정 주소가 상수 한 곳에만 있고(src·app 전체 1회), ko·en 안내가 그 상수를 쓴다', async () => {
  const { CONNECTOR_REGISTER_EMAIL, connectorMessage } = await import('../src/connectors.mjs');
  assert.equal(CONNECTOR_REGISTER_EMAIL, 'yg@leankim.xyz');
  for (const lang of ['ko', 'en']) for (const d of ['access_denied', 120]) assert.ok(connectorMessage('test_users_only', lang, d).includes(CONNECTOR_REGISTER_EMAIL), `${lang}/${d}`);
  const { execFileSync } = await import('node:child_process');
  const hits = execFileSync('git', ['grep', '-c', 'yg@leankim.xyz', '--', 'src', 'app'], { cwd: new URL('..', import.meta.url), encoding: 'utf8' }).trim().split('\n');
  assert.deepEqual(hits, ['src/connectors.mjs:1'], '연락처를 다른 곳에 다시 적었다 — 상수 하나만 쓴다');
});
