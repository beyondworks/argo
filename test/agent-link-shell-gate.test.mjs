// v2 owner 턴의 고위험 셸 결재(D28) — 실제 권한 게이트(makePermissionGate)가 만든 결재가 실제 알림 버스(notify.mjs)로
// 본체 연결부(createAgentLinkHost)에 들어와 work.approval_request(위험 high)로 나가고, 승인되면 effect intent 뒤 로컬 결재가 풀린다(#1078 검수 중간 3).
// 가짜는 서버(약속 v1 판정 그대로)와 모델 턴뿐이다. 데이터 폴더는 임시 ARGO_ROOT.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from './helpers/tmp.mjs';

const root = await mkdtemp(join(tmpdir(), 'argo-link-shell-'));
process.env.ARGO_ROOT = join(root, 'workspaces');
const { createAgentLinkHost } = await import('../src/agent-link-host.mjs');
const { createFakeServer } = await import('../packages/agent-link/test/fake-server.mjs');
const { makePermissionGate } = await import('../src/permission-gate.mjs');
const { shellGateMsgr } = await import('../src/chat.mjs');
const { onNotify, emitNotify } = await import('../src/notify.mjs');
const { loadApprovals, resolveApproval } = await import('../src/approvals.mjs');
const { createCompany, paths } = await import('../src/workspace.mjs');
after(() => {});

const flush = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const until = async (cond, ms = 10_000) => { const end = Date.now() + ms; while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 10)); };

test('D28 실제 게이트 → 실제 알림 버스 → 연결부 → approval_request(high) → 승인 → intent 뒤 로컬 결재 approved, 결과는 후속 답', async () => {
  const ws = 'co-shell';
  await createCompany(ws, 'Shell QA', 'owner');
  await mkdir(paths(ws).agents, { recursive: true });
  let t = Date.parse('2026-10-18T00:00:00Z');
  const clock = { now: () => t, setTimeout: (fn, ms) => ({ fn, ms }), clearTimeout: () => {}, sleep: async (ms) => { t += ms; } };
  const server = createFakeServer({ now: clock.now, uid: 'u1' });
  const rpc0 = server.transport.rpc;
  server.transport.rpc = async (name, args) => (name === 'msgr2_device_register' ? { data: { device_id: 'c4d5e6f7-8091-4a2b-9c3d-4e5f6a7b8c03' }, error: null } : rpc0(name, args));
  const decisions = [];
  let gateResult = null;
  const host = createAgentLinkHost({
    getSession: async () => ({ client: {}, uid: 'u1' }),
    listOwnedAgents: async () => [{ ws, slug: 'pm', name: 'PM' }],
    // 모델 턴 대역: 실제 chat()이 만드는 것과 같은 게이트(link 범위 → shellGateMsgr)로 고위험 셸을 시도한다
    chat: async (w, slug, text, sid, opts) => {
      const gate = makePermissionGate(w, slug, paths(w).root, null, 'ko', [], { guest: false, msgr: shellGateMsgr(opts.mirrorCtx) });
      gateResult = await gate('Bash', { command: 'rm -rf ~/Documents/x' }, { toolUseID: 'tu-1' });
      return { reply: '결재를 올렸습니다' };
    },
    interruptTurn: async () => {},
    onNotify,
    // 결재 확정 대역 — 상태는 실제 approvals.mjs로 바꾸고, 후속 턴 답만 흉내 낸다
    resolveWithFollowUp: async (w, id, approve, opts) => {
      decisions.push({ id, approve, effect: server.effects.get(`approval:${id}`) ?? null });
      const item = await resolveApproval(w, id, approve, opts);
      emitNotify({ type: 'approval_followup', wsId: w, item, reply: '후속: 실행함' });
    },
    resolveApproval,
    planReplyFiles: async (w, body) => ({ body, files: [] }),
    readReplyFile: async () => new Uint8Array(),
    vaultDir: (w) => paths(w).vault,
    appVersion: '0.2.0',
    transportFor: () => server.transport,
    clock, linkClock: clock,
    log: () => {},
  });
  host.start();
  await until(() => !!host.link && server.agentIds.has(`${ws}/pm`) && server.rpcCount('msgr2_link_pending') > 0);
  const o = server.offer({ agent: server.agentIds.get(`${ws}/pm`) });
  server.push(o); await flush();
  await until(() => server.log.some((x) => x.args?.p_env?.type === 'work.approval_request'));
  assert.equal(gateResult?.behavior, 'deny', '실제 게이트가 막고 결재를 올렸다');
  const local = (await loadApprovals(ws)).find((a) => a.payload?.shell);
  assert.deepEqual(local.scope, { kind: 'link', work: o.work, room: o.data.room, owner: true });
  const req = server.log.find((x) => x.args?.p_env?.type === 'work.approval_request').args.p_env;
  assert.equal(req.data.risk, 'high');
  assert.equal(req.data.effect_key, `approval:${local.id}`);
  assert.match(req.data.action, /셸 명령 실행/);
  server.decide(o.work, req.data.approval_id, 'approve'); await flush();
  await until(() => server.sentOf('work.result', o.work).length > 0);
  assert.deepEqual(decisions, [{ id: local.id, approve: true, effect: 'intent' }], '승인 실행 순간 서버에 intent');
  assert.equal((await loadApprovals(ws)).find((a) => a.id === local.id).status, 'approved');
  assert.equal(server.effects.get(`approval:${local.id}`), 'done');
  assert.equal(server.sentOf('work.result', o.work)[0].data.text, '결재를 올렸습니다\n\n후속: 실행함');
  host.stop();
});
