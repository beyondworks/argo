// I-4 상주 노드 부트스트랩 — 가짜 Supabase 클라이언트·임시 ARGO_ROOT로 단계 순서·멱등·정직한 오류를 잠근다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-node-t-'));
const { bootstrapNode, nodeWs } = await import('../src/msgr-node.mjs');
const { loadCompany } = await import('../src/workspace.mjs');
const { loadDeviceSession } = await import('../src/devicesession.mjs');
const UID = '77777777-7777-4777-8777-777777777777', ORG = 'aaaaaaaa-0000-4000-8000-000000000001';
function fakeClient({ svc = UID, loginError = null } = {}) {
  const calls = [];
  const mk = () => ({
    auth: { async signInWithPassword() { calls.push('login'); return loginError ? { error: { message: loginError } } : { data: { session: { access_token: 'at', refresh_token: 'rt', expires_at: 9e9, user: { id: UID, email: 'node@example.test' } } } }; } },
    async rpc(name, args) { calls.push([name, args]); return name === 'msgr_accept_invite' ? { data: ORG } : { data: true }; },
    from() { return { select() { return this; }, eq() { return this; }, async single() { return { data: { id: ORG, name: '린 컴퍼니', slug: 'Lean Co', service_user_id: svc } }; } }; },
  });
  mk.calls = calls; return mk;
}
test('nodeWs — 조직 슬러그를 회사 id 규칙으로 세척', () => { assert.equal(nodeWs('Lean Co'), 'org-lean-co'); assert.equal(nodeWs(''), 'org-org'); assert.match(nodeWs('한글!'), /^org-/); });
test('bootstrapNode — 로그인 → 수락 → 세션 저장 → 조직 회사 → 하트비트, 재실행은 회사 재사용', async () => {
  const mk = fakeClient();
  const r = await bootstrapNode({ code: ' abc ', url: 'http://sb', anonKey: 'anon', email: 'n@x', password: 'p', mkClient: mk });
  assert.deepEqual(r, { orgId: ORG, ws: 'org-lean-co', uid: UID, orgName: '린 컴퍼니' });
  assert.deepEqual(mk.calls.filter(Array.isArray), [['msgr_accept_invite', { code: 'abc' }], ['msgr_node_heartbeat', { org: ORG }]], '수락 뒤 하트비트 순서·코드 트림');
  const c = await loadCompany('org-lean-co');
  assert.equal(c.name, '린 컴퍼니'); assert.equal(c.ownerId, UID); assert.deepEqual(c.msgr, { enabled: true, nodeOrgId: ORG });
  assert.equal(loadDeviceSession().user.id, UID, '노드 루트에 서비스 계정 기기 세션');
  const r2 = await bootstrapNode({ code: 'abc', url: 'http://sb', anonKey: 'anon', email: 'n@x', password: 'p', mkClient: fakeClient() });
  assert.equal(r2.ws, 'org-lean-co'); assert.equal((await loadCompany('org-lean-co')).created, c.created, '재실행은 기존 회사 유지');
});
test('bootstrapNode — 노드용이 아닌 코드·로그인 실패·코드 없음은 정직한 오류', async () => {
  await assert.rejects(bootstrapNode({ code: 'abc', url: 'u', anonKey: 'a', email: 'n', password: 'p', mkClient: fakeClient({ svc: 'someone-else' }) }), /노드용이 아닙니다/);
  await assert.rejects(bootstrapNode({ code: 'abc', url: 'u', anonKey: 'a', email: 'n', password: 'p', mkClient: fakeClient({ loginError: 'Invalid login' }) }), /로그인 실패: Invalid login/);
  await assert.rejects(bootstrapNode({ code: '', url: 'u', anonKey: 'a', mkClient: fakeClient() }), /ARGO_NODE_CODE/);
  await assert.rejects(bootstrapNode({ code: 'abc', mkClient: fakeClient() }), /NEXT_PUBLIC_SUPABASE_URL/);
});
