// 풀 오토 모드(회사 단위 스위치, 유건 확정 2026-09-26) — 연결 서비스 쓰기 결재의 **행동** 테스트.
// connector-gate-live.test.mjs와 같은 패턴(실제 서버를 띄우고 실제로 호출)이다. 여기서 잠그는 계약:
//  ① 기본(fullAuto=false)은 회귀 없음 — 기존 결재 게이트 그대로.
//  ② fullAuto=true + 주인 직접 턴(guest 아님)이면 일반 쓰기(delete/purchase/sensitive가 아님)는
//     결재 없이 실행되고, 활동 원장에 'approval' 타입 자동 승인 기록이 남는다(요구사항 c).
//  ③ 같은 상태에서도 삭제 계열 도구는 여전히 결재로 간다(요구사항 3 — 3계급은 fullAuto도 못 넘는다).
//  ④ fullAuto=true여도 손님 턴(isGuestCtx)은 여전히 guest_blocked — 적용 범위는 주인 직접 턴뿐(요구사항 2).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-fullauto-live-'));
const { startConnect, callConnectorTool, closeConnectorPools } = await import('../src/connectors.mjs');
const { loadApprovals } = await import('../src/approvals.mjs');
const { createCompany, updateCompany } = await import('../src/workspace.mjs');
const { readEvents } = await import('../src/events.mjs');
const { startOauthTestServer } = await import('./helpers/oauth-test-server.mjs');

const WS = 'co-fullauto-live';
await createCompany(WS, '풀오토 테스트사', 'captain');

const s = await startOauthTestServer({
  extraTools: [
    { name: 'delete_thread_demo', description: '데모 삭제(쓰기) — annotations.destructiveHint=true',
      annotations: { readOnlyHint: false, destructiveHint: true } },
    // readOnlyHint:false로 기본 게이트는 이미 결재 대상 — 여기서 재는 것은 fullAuto가 "이름에 charge가
    // 있으니 그래도 결재를 유지하는가"다(이름 없이 readOnlyHint:false만 있으면 send_mail_demo와 같은
    // general이라 풀 오토가 건너뛴다 — 그 차이를 이 도구가 보여준다).
    { name: 'charge_card_demo', description: '데모 결제(쓰기) — annotations.readOnlyHint=false',
      annotations: { readOnlyHint: false } },
    // 분리 검수 MEDIUM(2026-09-26) — 이름에 sensitive 단어(billing)가 있어도 readOnlyHint:true면
    // 애초에 결재 대상이 아니다(needsApprovalNow가 connectorToolNeedsApproval 단계에서 먼저 걸러낸다).
    // 단어 보강이 조회까지 결재로 몰아가지 않는지 이 도구로 확인한다.
    { name: 'get_billing_info_demo', description: '데모 조회(읽기) — annotations.readOnlyHint=true, 이름에 sensitive 단어 포함',
      annotations: { readOnlyHint: true } },
  ],
});
after(async () => { await closeConnectorPools(); await s.close(); });

const ID = 'demo-fullauto';
const { authUrl, done } = await startConnect(WS, { id: ID, url: s.mcpUrl, scopes: ['spike.read', 'spike.write'] });
{ // 브라우저·사람 동의 대역(connector-gate-live.test.mjs와 동일 패턴)
  const r1 = await fetch(authUrl, { redirect: 'manual' });
  await fetch(new URL(r1.headers.get('location')));
}
assert.equal((await done).ok, true, '사전 조건: 연결이 성립해야 게이트를 잴 수 있다');

test('풀 오토 꺼짐(기본값) — 일반 쓰기도 여전히 결재로 간다(회귀 없음)', async () => {
  const before = (await loadApprovals(WS)).length;
  const r = await callConnectorTool(WS, ID, 'send_mail_demo', { to: 'a@example.com', body: 'hi' }, { slug: 'captain' });
  assert.equal(r.error, 'approval_pending', '기본값(꺼짐)인데 결재 없이 나갔다');
  assert.equal((await loadApprovals(WS)).length, before + 1);
});

test('풀 오토 켜짐 + 주인 직접 턴 — 일반 쓰기는 결재 없이 실행되고 활동에 자동 승인이 기록된다', async () => {
  await updateCompany(WS, { fullAuto: true });
  const beforeApprovals = (await loadApprovals(WS)).length;
  // mirrorCtx 생략 = 본체 채팅·주인의 텔레그램과 같은 문맥(isGuestCtx가 kind !== 'msgr'로 false를 준다).
  const r = await callConnectorTool(WS, ID, 'send_mail_demo', { to: 'b@example.com', body: 'auto' }, { slug: 'captain' });
  assert.equal(r.ok, true, '풀 오토인데 결재가 걸렸다');
  assert.equal((await loadApprovals(WS)).length, beforeApprovals, '결재가 새로 등록됐다 — 풀 오토가 안 먹었다');
  assert.equal(s.counters.toolCalls.send_mail_demo ?? 0, 1, '실제 발송이 서버에 닿지 않았다');
  const ev = (await readEvents(WS)).filter((e) => e.type === 'approval' && e.id === 'auto').at(-1);
  assert.ok(ev, '풀 오토 자동 승인이 활동 원장에 안 남았다(요구사항 c)');
  assert.equal(ev.status, 'approved');
  assert.match(ev.action, /send_mail_demo/);
});

test('풀 오토 켜짐 + 주인 직접 턴 — 삭제 계열(destructiveHint)은 여전히 결재로 간다', async () => {
  const before = (await loadApprovals(WS)).length;
  const r = await callConnectorTool(WS, ID, 'delete_thread_demo', {}, { slug: 'captain' });
  assert.equal(r.error, 'approval_pending', '풀 오토가 삭제까지 건너뛰었다 — 요구사항 3 위반');
  assert.equal((await loadApprovals(WS)).length, before + 1);
  assert.equal(s.counters.toolCalls.delete_thread_demo ?? 0, 0, '결재를 걸어놓고 삭제가 이미 나갔다');
});

test('풀 오토 켜짐 + 주인 직접 턴 — 이름만으로 판정되는 결제 계열(charge)도 결재로 간다', async () => {
  const before = (await loadApprovals(WS)).length;
  const r = await callConnectorTool(WS, ID, 'charge_card_demo', {}, { slug: 'captain' });
  assert.equal(r.error, 'approval_pending', 'annotations 없이 이름만으로도 결제 계열은 결재를 유지해야 한다');
  assert.equal((await loadApprovals(WS)).length, before + 1);
});

test('풀 오토 켜짐이어도 손님 턴은 그대로 guest_blocked — 적용 범위는 주인 직접 턴뿐(요구사항 2)', async () => {
  // isGuestCtx(msgr-handoff.mjs) 판정 그대로: uid !== origin → guest
  const guestCtx = { kind: 'msgr', uid: 'owner-uid', origin: 'someone-else' };
  const r = await callConnectorTool(WS, ID, 'send_mail_demo', { to: 'c@example.com', body: 'guest' }, { slug: 'captain', mirrorCtx: guestCtx });
  assert.equal(r.error, 'guest_blocked', '손님 턴인데 풀 오토가 실행을 허용했다');
});

test('풀 오토 켜짐 + 조직 채널 넘김 뿌리가 주인이 아닌 턴도 guest — 넘김 사슬도 걸린다', async () => {
  // uid === origin(겉보기엔 본인)이어도 rootAuthor가 다르면 isGuestCtx는 true다(넘김 뿌리 판정).
  const handoffGuestCtx = { kind: 'msgr', uid: 'owner-uid', origin: 'owner-uid', rootAuthor: 'someone-else' };
  const r = await callConnectorTool(WS, ID, 'send_mail_demo', { to: 'd@example.com', body: 'handoff-guest' }, { slug: 'captain', mirrorCtx: handoffGuestCtx });
  assert.equal(r.error, 'guest_blocked', '뿌리가 주인이 아닌 넘김 턴인데 풀 오토가 실행을 허용했다');
});

test('읽기 전용 도구는 이름에 sensitive 단어가 있어도 영향 없음 — 결재 자체가 애초에 없다(분리 검수 MEDIUM 반영)', async () => {
  // 이 시점 회사 상태는 fullAuto:true(위 테스트가 켰다) — 단어 보강이 조회까지 결재로 밀어붙이지 않는지
  // 가장 엄격한 조건(풀 오토 켜짐)에서 잰다. 결재가 전혀 등록되지 않고 그대로 실행돼야 한다.
  const before = (await loadApprovals(WS)).length;
  const r = await callConnectorTool(WS, ID, 'get_billing_info_demo', {}, { slug: 'captain' });
  assert.equal(r.ok, true, '읽기 전용인데 결재에 막혔다 — sensitive 단어 보강이 조회까지 건드렸다');
  assert.equal((await loadApprovals(WS)).length, before, '읽기 전용 호출인데 결재가 등록됐다');
  assert.equal(s.counters.toolCalls.get_billing_info_demo ?? 0, 1);
  // 풀 오토 자동 승인 기록도 없어야 한다 — 애초에 결재 대상이 아니었으니 "건너뛴 결재"라는 사실 자체가 없다.
  const ev = (await readEvents(WS)).filter((e) => e.type === 'approval' && e.id === 'auto' && /get_billing_info_demo/.test(e.action ?? ''));
  assert.equal(ev.length, 0, '결재 대상이 아니었던 조회까지 자동 승인 기록이 남았다(소음)');
});
