// 오피스 패널이 개인 1:1(조직 없는 방)로 갈 때의 오피스 도구(0.1.105) — 개인 공간 쌍둥이가 있는 에이전트는 패널 글이 개인 1:1로 가서(crew-assign.js crewRoom)
// mirrorCtx.orgId가 비고, 할 일·페이지·거래·회사·문서함 도구가 아예 실리지 않았다(chat.mjs tools 조건). 상주 2026-10-13 잡 6393: 할 일 도구가 인트라넷 MCP뿐이라 그쪽에 썼다.
// 고친 뒤: 패널 글이 보고 있는 오피스 조직(meta.office_org)을 싣고, 게이트웨이가 주인 혼자 1:1 + 주인이 그 조직 구성원인지 서버에서 확인한 때만 ctx.officeOrgId를 둔다.
// 쓰기는 그대로 확인 카드(panelWriteGate). 라이브 DB 호출 0.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-panel-personal-')); // import보다 먼저(레포 관례)
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
const { makeCrewServer } = await import('../src/chat.mjs');
const { createCompany } = await import('../src/workspace.mjs');
const { crewToolSpecs } = await import('../src/engine/native-query.mjs');
const { createCrewMcpBridge } = await import('../src/engine/crew-mcp.mjs');
const proposals = await import('../src/gateway/office-proposals.mjs');
const msgr = await import('../src/gateway/msgr.mjs');

const WS = 'panel-personal';
await createCompany(WS, '개인패널사', 'captain');

const ORG = '11111111-1111-4111-8111-111111111111';
// 개인 1:1 패널 턴의 맥락 — 조직이 없다(orgId 없음). officeOrgId는 게이트웨이가 확인한 뒤에만 둔다
const personal = (extra = {}) => ({ kind: 'msgr', uid: 'u1', origin: 'u1', channelKind: 'dm', channelId: 'ch', crewId: 'c', officePanel: true, proposals: [], handoffs: [], ...extra });

async function sdk(mirrorCtx, fn) {
  const srv = makeCrewServer(WS, 'ay', '에이', [], 0, [], mirrorCtx, 'ko');
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await srv.instance.connect(st);
  const client = new Client({ name: 't', version: '1' }); await client.connect(ct);
  try { return await fn(client); } finally { await client.close(); }
}
const toolNames = (ctx) => sdk(ctx, async (c) => (await c.listTools()).tools.map((t) => t.name));

test('원인 재현 — 개인 1:1 패널 턴(조직 확인 없음)에는 조직 오피스 도구가 없다(지금과 같아야 한다)', async () => {
  const names = await toolNames(personal());
  for (const n of ['office', 'office_files', 'office_work', 'office_deals']) assert.ok(!names.includes(n), n);
  assert.ok(names.includes('calendar') && names.includes('office_mail'), '개인 기록 도구는 그대로');
});

test('개인 1:1 패널 턴 + 확인된 오피스 조직 → 할 일·페이지·거래·회사·문서함 도구가 실린다', async () => {
  const names = await toolNames(personal({ officeOrgId: ORG }));
  for (const n of ['office', 'office_files', 'office_work', 'office_deals']) assert.ok(names.includes(n), n);
});

test('개인 1:1 패널 턴의 task_add는 실행하지 않고 확인 카드로, 제안에 그 조직이 붙는다', async () => {
  const ctx = personal({ officeOrgId: ORG });
  const out = await sdk(ctx, async (c) => (await c.callTool({ name: 'office_work', arguments: { action: 'task_add', title: '견적 회신' } })).content[0].text);
  assert.match(out, /확인 카드\(p1\)로 올렸다: 할 일 추가: 견적 회신/);
  assert.equal(ctx.proposals.length, 1);
  assert.equal(ctx.proposals[0].org, ORG, '[실행] 때 같은 조직으로 실행하게');
  assert.equal(proposals.proposalsMeta(ctx).office_proposals[0].org, ORG, '답 글 meta에도 실린다');
});

test('개인 1:1 패널 턴의 읽기는 그 조직으로 처리기에 간다(조직 채널 거절 문구가 아니다)', async () => {
  const out = await sdk(personal({ officeOrgId: ORG }), async (c) => (await c.callTool({ name: 'office_work', arguments: { action: 'tasks' } })).content[0].text);
  assert.ok(!/조직 채널 대화에서만|not found/i.test(out), out);
  assert.match(out, /메신저|messenger/i, out); // 이 시험 환경에는 메신저 세션이 없어 세션 안내로 끝난다 — 조직 판정은 지났다
});

test('패널 턴이 아니면 officeOrgId가 있어도 싣지 않는다(일반 메신저 개인 턴은 지금 그대로)', async () => {
  const names = await toolNames(personal({ officePanel: undefined, proposals: undefined, officeOrgId: ORG }));
  assert.ok(!names.includes('office_work'));
});

test('조직 방 패널 턴은 지금 그대로 — 제안에 조직 표지가 붙지 않는다', async () => {
  const ctx = personal({ orgId: 'o', officeOrgId: ORG });
  await sdk(ctx, (c) => c.callTool({ name: 'office_work', arguments: { action: 'task_add', title: 'x' } }));
  assert.equal(ctx.proposals[0].org, undefined);
});

test('codex 크루 도구 다리(op:list)에도 같은 칸에서 office_work가 실린다', async () => {
  for (const [ctx, want] of [[personal(), false], [personal({ officeOrgId: ORG }), true]]) {
    const sink = [];
    makeCrewServer(WS, 'ay', '에이', [], 0, [], ctx, 'ko', [], null, sink);
    const bridge = await createCrewMcpBridge(crewToolSpecs(sink));
    try {
      const r = await fetch(bridge.server.env.ARGO_CREW_RELAY_URL, { method: 'POST', headers: { authorization: `Bearer ${bridge.server.env.ARGO_CREW_RELAY_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ op: 'list' }) });
      const names = (await r.json()).tools.map((t) => t.name);
      assert.equal(names.includes('office_work'), want, JSON.stringify(ctx.officeOrgId ?? null));
    } finally { await bridge.close(); }
  }
});

// 게이트웨이 판정 — 주인이 그 조직의 손님 아닌 구성원이고, 주인 혼자 1:1 패널 턴이고, 방에 조직이 없을 때만
test('게이트웨이: 패널 오피스 조직은 구성원 확인을 지난 때만(fail-closed)', async () => {
  const { panelOfficeOrg } = msgr;
  assert.equal(typeof panelOfficeOrg, 'function');
  const db = (role, removed = null) => ({ officeMember: async (org, uid) => (org === ORG && uid === 'u1' && role && !removed && role !== 'guest') });
  const base = { job: { panel: true, officeOrg: ORG, authorId: 'u1', orgId: null }, ch: { org_id: null }, uid: 'u1', solo: true };
  assert.equal(await panelOfficeOrg(db('member'), base), ORG, '구성원');
  assert.equal(await panelOfficeOrg(db('guest'), base), null, '손님');
  assert.equal(await panelOfficeOrg(db(null), base), null, '구성원 아님');
  assert.equal(await panelOfficeOrg({ officeMember: async () => { throw new Error('down'); } }, base), null, '조회 오류');
  assert.equal(await panelOfficeOrg({}, base), null, '확인 수단 없음');
  assert.equal(await panelOfficeOrg(db('member'), { ...base, solo: false }), null, '주인 혼자 1:1이 아님');
  assert.equal(await panelOfficeOrg(db('member'), { ...base, job: { ...base.job, authorId: 'u2' } }), null, '주인이 보낸 글이 아님');
  assert.equal(await panelOfficeOrg(db('member'), { ...base, job: { ...base.job, panel: false } }), null, '패널 글이 아님');
  assert.equal(await panelOfficeOrg(db('member'), { ...base, job: { ...base.job, orgId: 'o' } }), null, '조직 방은 그 조직 그대로');
  assert.equal(await panelOfficeOrg(db('member'), { ...base, ch: { org_id: 'o' } }), null, '조직 방(채널 기준)');
  assert.equal(await panelOfficeOrg(db('member'), { ...base, job: { ...base.job, officeOrg: undefined } }), null, '표지 없음');
});

test('패널 글 표지 office_org — uuid 모양만 받는다', () => {
  const { officeOrgOf } = proposals;
  assert.equal(typeof officeOrgOf, 'function');
  assert.equal(officeOrgOf({ meta: { source: 'office_panel', office_org: ORG } }), ORG);
  for (const bad of ['x', 1, null, [ORG], `${ORG} `, { id: ORG }]) assert.equal(officeOrgOf({ meta: { source: 'office_panel', office_org: bad } }), null, JSON.stringify(bad));
});

// [실행] — 제안에 붙은 조직으로, 그 조직 구성원인지 다시 확인한 뒤에만
const pReply = (org) => ({ id: 42, channel_id: 'ch1', author_kind: 'crew', crew_id: 'c1', meta: { office_proposals: [{ pid: 'p1', tool: 'office_work', args: { action: 'task_add', title: '견적 회신' }, summary: '할 일 추가: 견적 회신', ...(org ? { org } : {}) }] } });
const cJob = { channelId: 'ch1', crewId: 'c1', slug: 'pepper', authorId: 'u1', officeConfirm: { reply: 42, pid: 'p1' } };
const deps = (calls) => ({ owner: async () => 'u1', specs: () => [{ name: 'office_work', run: async (args, o) => { calls.push({ args, o }); return '할 일을 만들었다'; } }] });

test('카드 [실행] — 개인 1:1 제안은 그 조직으로 실행(구성원 재확인)', async () => {
  const calls = [];
  const db = { message: async () => pReply(ORG), officeMember: async (org, uid) => org === ORG && uid === 'u1' };
  const r = await msgr.runOfficeConfirm(db, { wsId: 'w', job: cJob, ctx: personal({ channelId: 'ch1' }), uid: 'u1', lang: 'ko' }, deps(calls));
  assert.equal(r.status, 'ran');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].o.ctx.orgId, ORG);
  assert.equal(calls[0].o.ctx.officePanel, false);
});

test('카드 [실행] — 그 조직 구성원이 아니면(조회 오류 포함) 실행하지 않는다', async () => {
  for (const member of [async () => false, async () => { throw new Error('down'); }]) {
    const calls = [];
    const r = await msgr.runOfficeConfirm({ message: async () => pReply(ORG), officeMember: member }, { wsId: 'w', job: cJob, ctx: personal({ channelId: 'ch1' }), uid: 'u1', lang: 'ko' }, deps(calls));
    assert.equal(calls.length, 0);
    assert.equal(r.status, 'error');
    assert.match(r.note, /아무것도 실행하지 않았다/);
  }
});

test('카드 [실행] — 조직 방의 제안(조직 표지 없음)은 지금 그대로 방의 조직으로', async () => {
  const calls = [];
  const r = await msgr.runOfficeConfirm({ message: async () => pReply(null) }, { wsId: 'w', job: cJob, ctx: personal({ channelId: 'ch1', orgId: 'o' }), uid: 'u1', lang: 'ko' }, deps(calls));
  assert.equal(r.status, 'ran');
  assert.equal(calls[0].o.ctx.orgId, 'o');
});

test('카드 [실행] — 조직 방 답에 다른 조직 표지가 있어도 방의 조직을 쓴다(표지는 개인 방에서만)', async () => {
  const calls = [];
  await msgr.runOfficeConfirm({ message: async () => pReply(ORG), officeMember: async () => true }, { wsId: 'w', job: cJob, ctx: personal({ channelId: 'ch1', orgId: 'o' }), uid: 'u1', lang: 'ko' }, deps(calls));
  assert.equal(calls[0].o.ctx.orgId, 'o');
});
