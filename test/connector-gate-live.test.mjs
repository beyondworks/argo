// 결재 게이트 **행동** 테스트 — 실제 서버를 띄우고 실제로 호출해서, 쓰기가 막히는지 본다.
//
// 왜 따로 있나(분리 검수 실측 2026-08-01): 첫 판의 배선 잠금은 소스 문자열 정규식뿐이었다.
// 검수가 `needsApprovalNow`의 반환을 `false && …`로 바꿔 게이트를 **런타임에서 통째로 죽였는데**
// 정규식은 그대로 매치되고 순수함수 단위 테스트도 통과해서, 779개 스위트가 전부 초록이었다.
// 즉 외부 쓰기 결재가 사라져도 CI가 아무 말을 안 했다. 이 레포에 이미 기록된 실패 계열이다
// ("소스문자열 테스트는 분기 도는지를 못 본다").
//
// 여기서 잠그는 것은 배선이 아니라 **결과**다: 쓰기는 실행되지 않고 결재가 쌓인다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-gate-')); // import보다 먼저
const { startConnect, callConnectorTool, closeConnectorPools } = await import('../src/connectors.mjs');
const { loadApprovals } = await import('../src/approvals.mjs');
const { createCompany } = await import('../src/workspace.mjs');
const { startOauthTestServer } = await import('./helpers/oauth-test-server.mjs');

const WS = 'co-gate';
await createCompany(WS, '게이트 테스트사', 'captain');

const s = await startOauthTestServer();
after(async () => { await closeConnectorPools(); await s.close(); });

const ID = 'demo-gate';
const { authUrl, done } = await startConnect(WS, { id: ID, url: s.mcpUrl, scopes: ['spike.read', 'spike.write'] });
{ // 브라우저·사람 동의 대역
  const r1 = await fetch(authUrl, { redirect: 'manual' });
  await fetch(new URL(r1.headers.get('location')));
}
assert.equal((await done).ok, true, '사전 조건: 연결이 성립해야 게이트를 잴 수 있다');

test('읽기 도구는 그대로 실행된다 — 조회까지 막으면 크루가 아무것도 못 한다', async () => {
  const r = await callConnectorTool(WS, ID, 'search_threads_demo', { query: 'a' });
  assert.equal(r.ok, true, '읽기가 막혔다');
  assert.equal(r.error, undefined);
});

test('쓰기 도구는 실행되지 않고 결재가 쌓인다 — 이 테스트가 게이트의 유일한 행동 증거다', async () => {
  const before = (await loadApprovals(WS)).length;
  const r = await callConnectorTool(WS, ID, 'send_mail_demo', { to: 'demo@example.com', body: 'hi' }, { slug: 'captain' });
  assert.equal(r.ok, false, '외부 쓰기가 결재 없이 나갔다');
  assert.equal(r.error, 'approval_pending');
  const list = await loadApprovals(WS);
  assert.equal(list.length, before + 1, '결재가 등록되지 않았다 — 크루는 막혔는데 사장은 모른다');
  const it = list[0];
  assert.equal(it.kind, 'connector');
  assert.equal(it.slug, 'captain', '요청한 크루가 안 실렸다 — 승인 후 보고가 엉뚱한 대화로 간다');
  assert.equal(it.payload?.tool, 'send_mail_demo');
  // 부작용이 실제로 안 일어났는지 — 테스트 서버가 발송을 기록했다면 게이트가 뚫린 것이다.
  assert.equal(s.counters.toolCalls.send_mail_demo ?? 0, 0, '결재를 걸어놓고 발송은 이미 나갔다');
});

test('서버가 모르는 도구는 결재로 간다 — dangerous(닫힌 목록) 밖의 새 쓰기가 새지 않게', async () => {
  // 조회는 성공했는데 그 이름이 목록에 없는 경우. 통과시키면 어차피 서버가 거절하지만,
  // 그 경로를 열어두면 "annotations 없는 쓰기 도구"가 무결재로 나간다(분리 검수 실측).
  const r = await callConnectorTool(WS, ID, 'no_such_tool_here', {}, { slug: 'captain' });
  assert.equal(r.error, 'approval_pending', '모르는 도구가 결재 없이 서버로 나갔다');
});

test('결재 카드와 실행 대상이 어긋나면 실행하지 않는다 — 승인한 것과 다른 일이 벌어지지 않게', async () => {
  // CLI 러너는 도구 게이트를 지나지 않아 결재 파일을 직접 고칠 수 있다. 사장이 카드에서 본 것과
  // 다른 도구가 실행되면 승인이라는 절차 자체가 무의미해진다.
  const { resolveWithFollowUp } = await import('../src/approval-actions.mjs');
  const list = await loadApprovals(WS);
  const it = list.find((a) => a.kind === 'connector' && a.status === 'pending');
  assert.ok(it, '사전 조건: 대기 중인 커넥터 결재가 있어야 한다');
  const { writeJsonAtomic } = await import('../src/jsonstore.mjs');
  const { paths } = await import('../src/workspace.mjs');
  // 실존 도구로 바꾼다 — 없는 이름으로 바꾸면 서버가 거절해서, 재검증이 막은 건지 서버가 막은 건지
  // 구분이 안 된다(그러면 이 테스트는 아무것도 증명하지 못한다).
  const before = s.counters.toolCalls.create_draft_demo ?? 0;
  const tampered = list.map((a) => (a.id === it.id
    ? { ...a, payload: { ...a.payload, tool: 'create_draft_demo', args: { subject: 'tampered' } } } : a));
  await writeJsonAtomic(paths(WS).approvals, tampered);      // 결재 파일 변조(CLI 러너가 할 수 있는 일)
  await resolveWithFollowUp(WS, it.id, true);
  await new Promise((r) => setTimeout(r, 300));              // 후속 처리가 비동기
  assert.equal(s.counters.toolCalls.create_draft_demo ?? 0, before, '카드에 없던 도구가 실행됐다');
});

test('승인 우회구는 서버 전용 — approved:true로 통과한 호출은 실행된다', async () => {
  // 승인 후 실행 경로(approval-actions)가 쓰는 플래그. 이게 안 통하면 승인해도 같은 게이트를
  // 다시 만나 결재가 무한히 쌓인다. 크루 표면은 이 옵션을 넘길 수 없다(두 표면 다 slug만 넘긴다).
  const r = await callConnectorTool(WS, ID, 'send_mail_demo', { to: 'demo@example.com', body: 'ok' }, { approved: true });
  assert.equal(r.ok, true, '승인된 실행이 게이트에 다시 막혔다 — 무한 결재');
});

test("slug 없이 걸린 결재도 실제 크루로 귀속된다 — 유령 'crew'는 직통 봇 폴백 판정을 무산시킨다(분리 검수 LOW-3)", async () => {
  // 표면(chat·cli-directives)은 항상 실제 slug를 넘긴다 — 이 테스트는 slug 없는 코어 직접 호출이
  // 유령 'crew' 대신 기본 크루(defaultCrew 정본)로 등록되는지를 잠근다. 크루 2명 + 설정된 기본
  // 크루 = 두 번째 — 1명이면 agents[0] 사본과 구별이 안 돼 정본을 지워도 초록이다(재검수 LOW-1).
  await writeFile(join(process.env.ARGO_ROOT, WS, 'agents', 'alpha.md'), '---\nname: 알파\n---\n\n개발.\n');
  await writeFile(join(process.env.ARGO_ROOT, WS, 'agents', 'captain.md'), '---\nname: 캡틴\n---\n\n선장.\n');
  const { updateConnection } = await import('../src/connections.mjs');
  await updateConnection(WS, 'telegram', { token: 'gw-tok-gate', defaultCrew: 'captain' });
  const r = await callConnectorTool(WS, ID, 'send_mail_demo', { to: 'demo@example.com', body: 'ghost-probe' });
  assert.equal(r.error, 'approval_pending');
  const it = (await loadApprovals(WS)).find((a) => a.payload?.args?.body === 'ghost-probe'); // 인덱스 의존 금지(재검수 LOW-5)
  assert.equal(it?.slug, 'captain', "유령 'crew'로 등록됐다 — 카드 표기·텔레그램 직통 봇 폴백이 존재하지 않는 크루에 걸린다");
});
