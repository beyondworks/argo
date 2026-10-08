// 개인 공간 crew 1:1 결재·예약·긴 작업 — 본체 여는 스위치(PR-C, 계획 artifacts/rc-0195/personal-crew-room-features-plan.md 5-3).
// 주인과 자기 에이전트만 있는 개인 1:1(personal_pair = 'crew:<에이전트>')에서 주인이 시킨 일만 연다. 방 판정은 서버(msgr_is_own_crew_room)가 하고,
// 개인 결재는 정의자 RPC msgr_create_personal_approval로만 넣는다(표 직접 넣기 정책은 배포본 그대로 — PR-A #861).
// 앞쪽 '핀:' 테스트는 고치기 전 코드(origin/main)에서도 통과해야 하는 인접 행동이다(조직 1:1·조직 채널·친구 방·손님·다른 에이전트·#858 주인 혼자 1:1).
// 실 Supabase·실 모델·네트워크 0 — 가짜 db·가짜 러너. 서버 쪽 왕복은 test/msgr-personal-room-body-pg.test.mjs(pg 드릴)가 본다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from './helpers/tmp.mjs';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-personal-room-body-'));
const { createCompany, paths } = await import('../src/workspace.mjs');
const chatMod = await import('../src/chat.mjs'); // 이름 붙은 가져오기를 쓰지 않는다 — 고치기 전 코드에 없는 내보내기(shellGateMsgr)가 이 파일 전체(핀 포함)를 깨지 않게
const { runDirectives } = await import('../src/cli-directives.mjs');
const { loadRoutines } = await import('../src/routines.mjs');
const { loadApprovals } = await import('../src/approvals.mjs');
const gateway = await import('../src/gateway.mjs');
const M = await import('../src/gateway/msgr.mjs');
const H = await import('../src/gateway/msgr-handoff.mjs');
const { makePermissionGate, gateHooks } = await import('../src/permission-gate.mjs');
const { onNotify } = await import('../src/notify.mjs');

const OWNER = 'owner-uid'; const FRIEND = 'friend-uid';
const ORG = 'org-1'; const OCH = 'org-dm'; const GCH = 'org-ch'; const PCH = 'crew-1on1'; const FCH = 'friend-1on1';
const RLS = () => Object.assign(new Error('msgr db: new row violates row-level security policy for table "msgr_crew_approvals"'), { code: '42501' });

let seq = 0;
async function company({ lang = 'ko' } = {}) {
  const ws = `personal-body-${++seq}`;
  await createCompany(ws, '린', '유건', OWNER, lang);
  await mkdir(paths(ws).agents, { recursive: true });
  for (const [slug, name] of [['alpha', '알파'], ['beta', '베타']]) await writeFile(join(paths(ws).agents, `${slug}.md`), `---\nname: ${name}\nslug: ${slug}\n---\n`);
  return ws;
}
const peer = (ws, id, slug) => ({ id, slug, display_name: slug === 'alpha' ? '알파' : '베타', owner_user_id: OWNER, ws_id: ws });
/** 메신저 턴 문맥 — personal: 개인 방(org 없음). own: 서버 판정 결과(true crew 1:1 · false 친구 방 등 · undefined 모름). */
function ctxOf(ws, { org = null, channelId = org ? OCH : PCH, channelKind = 'dm', own, requester = OWNER, peers, lang, extra = {} } = {}) {
  return { kind: 'msgr', orgId: org, channelId, channelKind, crewId: 'a', threadRoot: 10, sourceMsgId: 10, uid: OWNER, wsId: ws, origin: requester, hop: 0,
    ...(requester !== OWNER ? { rootAuthor: requester } : {}), peers: peers ?? [peer(ws, 'a', 'alpha')], handoffs: [], ...(own !== undefined ? { ownCrewRoom: own } : {}), ...(lang ? { lang } : {}), ...extra };
}
function sdk(ws, ctx, name, { lang = 'ko', connectors = [] } = {}) {
  const sink = [];
  chatMod.makeCrewServer(ws, 'alpha', 'alpha', [{ slug: 'beta', name: '베타' }], 0, [], ctx, lang, connectors, '', sink);
  return sink.find((t) => t.name === name)?.handler ?? null;
}
const sdkNames = (ws, ctx) => { const sink = []; chatMod.makeCrewServer(ws, 'alpha', 'alpha', [{ slug: 'beta', name: '베타' }], 0, [], ctx, 'ko', [], '', sink); return sink.map((t) => t.name); };
const textOf = (r) => JSON.stringify(r);
/** 결재 카드 넣기·판정을 기록하는 가짜 db — 표 직접 넣기는 org 없는 행을 RLS로 거절한다(배포본 정책 그대로, PR-A 드릴 경우 17). */
function cardDb({ personalRpc = 'ok' } = {}) {
  const calls = [];
  const db = {
    calls,
    async insertApproval(row) { calls.push(['insertApproval', row]); if (row.org_id == null) throw RLS(); return { id: 'ap-row-org' }; },
    async createPersonalApproval(row) { calls.push(['createPersonalApproval', row]); return personalRpc === 'old' ? null : { id: 'ap-row-personal' }; },
    async insertMessage(row) { calls.push(['insertMessage', row]); return { id: 700 + calls.length }; },
    async updateApproval(id, patch) { calls.push(['updateApproval', id, patch]); return [{ id }]; },
    async canDecide(id) { calls.push(['canDecide', id]); return true; },
    async ownCrewRoom(ch, crew) { calls.push(['ownCrewRoom', ch, crew]); return true; },
  };
  return db;
}
const kinds = (db) => db.calls.map((c) => c[0]);
async function pushApproval(ws, item, db) {
  return M.msgrPush({ type: 'approval', wsId: ws, item }, { session: async () => ({ uid: OWNER, db }) });
}
const lastApproval = async (ws) => (await loadApprovals(ws)).at(-1);

/* ───────────────────────── 핀(고치기 전 코드에서도 통과) ───────────────────────── */

test('핀: 조직 1:1(dm)·조직 채널의 결재 카드 — 표 직접 넣기(org_id = 조직), 개인 RPC·개인 1:1 판정은 부르지 않는다', async () => {
  for (const [channelKind, channelId] of [['dm', OCH], ['private', GCH]]) {
    const ws = await company();
    const ctx = ctxOf(ws, { org: ORG, channelId, channelKind });
    const origin = H.messengerOrigin(ctx);
    assert.equal(origin.orgId, ORG);
    assert.equal('ownCrewRoom' in origin, false, '조직 기록 모양은 그대로');
    await sdk(ws, ctx, 'request_approval')({ action: '거래처에 견적서 메일 발송', reason: '월말 마감' });
    const item = await lastApproval(ws);
    assert.equal(item.msgr.orgId, ORG);
    const db = cardDb();
    assert.equal(await pushApproval(ws, item, db), true);
    assert.deepEqual(kinds(db), ['insertApproval', 'insertMessage', 'updateApproval', 'canDecide'], `${channelKind}: 조직 결재 경로 그대로`);
    assert.equal(db.calls[0][1].org_id, ORG);
    assert.match(db.calls[1][1].body, /조직 정책의 결재권자가 확정합니다/, '고위험 카드 문구 그대로(발송 = 고위험)');
    const saved = await lastApproval(ws);
    assert.equal(saved.msgr.rowId, 'ap-row-org'); assert.equal(saved.msgr.orgId, ORG); assert.equal(saved.msgr.ownerMayDecide, true);
  }
});

/** 처리기(makeMsgrHandler) 한 턴 — 봉투(crewContext)·실행 선점·답 게시를 흉내 낸다. 러너는 가짜(runChat)로 문맥만 받는다. */
function handlerRoom({ org = null, channelId = org ? OCH : PCH, kind = 'dm', author = OWNER, members = null, own = true } = {}) {
  const calls = []; const executions = new Map(); let n = 0;
  const people = members ?? [{ member_kind: 'user', member_id: OWNER }, { member_kind: 'crew', member_id: 'a' }];
  const client = { reads: 0, from(table) { const q = { select() { return q; }, eq() { return q; }, in() { return q; },
    then(res, rej) { client.reads += 1; return Promise.resolve(table === 'msgr_channel_members' ? { data: people, error: null } : { data: [], error: null }).then(res, rej); } }; return q; } };
  const db = {
    calls,
    async orgEntitled() { return true; }, async orgConsentOk() { return true; }, async personalConsentOk() { return true; },
    async crewBySlug(_uid, _ws, slug, orgId) { calls.push(['crewBySlug', orgId]); return { id: 'a', org_id: org, slug, display_name: '알파' }; },
    async crewContext(ws, crewId, msgId, chId) {
      const s = { id: msgId, channel_id: chId, author_kind: 'user', author_user_id: author, crew_id: null, body: '일 시작', reply_to: null, thread_root: null, meta: {} };
      return { source: s, root: { ...s }, delivery_role: 'to', actor: author,
        channel: { id: chId, org_id: org, kind, name: kind === 'dm' ? 'dm' : 'general', crew_memory: true, archived_at: null, excluded_crew_ids: [] },
        org: org ? { id: org, slug: 'lean', name: '린' } : null, peers: [peer(ws, crewId, 'alpha')], settled_predecessors: [], settled_source: false, context: [], attachments: [] };
    },
    async ownCrewRoom(ch, crew) { calls.push(['ownCrewRoom', ch, crew]); return own; },
    async memberName() { return '유건'; }, async executionStopInfo() { return null; }, async crewSeen() { return {}; },
    async insertMessage(row) { calls.push(['insertMessage', row]); n += 1; return { id: 900 + n }; },
    async claimExecution(key) { executions.set(`${key.crewId}:${key.msgId}`, {}); return { acquired: true, state: 'running', heartbeat_at: new Date().toISOString() }; },
    async finishExecution(key, row) { const e = executions.get(`${key.crewId}:${key.msgId}`); if (!e.row) e.row = await db.insertMessage(row); return e.row; },
    async heartbeatExecution() { return true; },
  };
  return { db, client, org, channelId, kind, author };
}
let msgSeq = 3000;
async function handlerTurn(ws, r, { lang } = {}) {
  const seen = [];
  const msgId = ++msgSeq;
  const h = M.makeMsgrHandler(ws, { session: async () => ({ db: r.db, uid: OWNER, client: r.client }), linkPreview: async () => null,
    runChat: async (_ws, _slug, _text, _sid, opts) => { seen.push({ ...opts.mirrorCtx }); return { reply: '네', sessionId: null, handover: null }; } });
  await h({ msgId, orgId: r.org, channelId: r.channelId, crewId: 'a', slug: 'alpha', text: '일 시작', authorId: r.author, threadRoot: msgId, hop: 0, origin: r.author, createdAt: new Date().toISOString(), channelKind: r.kind });
  return seen[0] ?? null;
}

test('핀: 조직 1:1·조직 채널 턴(run) — 개인 1:1 판정 RPC를 부르지 않고 문맥 모양에 ownCrewRoom·lang이 없다', async () => {
  for (const [kind, channelId] of [['dm', OCH], ['private', GCH]]) {
    const ws = await company();
    const r = handlerRoom({ org: ORG, channelId, kind });
    const ctx = await handlerTurn(ws, r);
    assert.ok(ctx, `${kind}: 러너가 불렸다`);
    assert.equal(ctx.orgId, ORG);
    assert.equal('ownCrewRoom' in ctx, false, `${kind}: 조직 문맥은 그대로`);
    assert.equal('lang' in ctx, false, `${kind}: 조직 문맥 모양 그대로(문맥 전체를 비교하는 핀 — msgr-bridge)`);
    assert.equal(r.db.calls.filter((c) => c[0] === 'ownCrewRoom').length, 0, `${kind}: 조직 턴은 판정 RPC 0`);
  }
});

test('핀: #858 주인 혼자 1:1(개인 crew 1:1) — 주인 직접 턴은 ownerSolo, 방 구성원 조회는 턴당 1건', async () => {
  const ws = await company();
  const r = handlerRoom();
  const ctx = await handlerTurn(ws, r);
  assert.equal(ctx.ownerSolo, true, '맥락 공유 표지 그대로');
  assert.equal(r.client.reads, 1, '구성원 조회 1건(판정 RPC는 이 조회와 별개)');
});

test('핀: 개인 방(친구 1:1·그룹·모르는 방)·다른 에이전트 대상·손님 — 결재·예약·긴 작업은 거절되고 결재함·예약·작업 대기열에 아무것도 남지 않는다', async () => {
  const ws = await company();
  const cases = [
    ['친구 1:1(서버 판정 false)', ctxOf(ws, { channelId: FCH, own: false })],
    ['판정 모름(옛 서버)', ctxOf(ws, { channelId: FCH })],
    ['손님(친구가 시킴)', ctxOf(ws, { channelId: FCH, requester: FRIEND, own: false })],
  ];
  for (const [label, ctx] of cases) {
    await assert.rejects(async () => sdk(ws, ctx, 'request_approval')({ action: '메일 발송', reason: '필요' }), Error, `${label}: 결재`);
    assert.match(textOf(await sdk(ws, ctx, 'schedule_task')({ title: '예약', prompt: '진행', type: 'daily', time: '09:00' })), /예약 실패|여기서는 쓸 수 없다/, `${label}: 예약`);
    assert.match(textOf(await sdk(ws, ctx, 'start_long_task')({ title: '작업', prompt: '진행' })), /작업 적재 실패|여기서는 쓸 수 없다/, `${label}: 긴 작업`);
    assert.throws(() => H.messengerOrigin(ctx), Error, `${label}: 기록`);
  }
  // 다른 에이전트 대상 — crew 1:1로 판정돼도(다른 에이전트가 방에 없다) 맡기지 못한다
  const own = ctxOf(ws, { own: true });
  assert.match(textOf(await sdk(ws, own, 'schedule_task')({ agentSlug: 'beta', title: '예약', prompt: '진행', type: 'daily', time: '09:00' })), /예약 실패/);
  assert.match(textOf(await sdk(ws, own, 'start_long_task')({ agentSlug: 'beta', title: '작업', prompt: '진행' })), /작업 적재 실패/);
  assert.equal((await loadApprovals(ws)).length, 0, '결재 0');
  assert.equal((await loadRoutines(ws)).length, 0, '예약 0');
  assert.deepEqual(await readdir(gateway.queueDir(ws, gateway.JOBS_QUEUE)).catch(() => []), [], '작업 0');
  // 손님은 예약·긴 작업을 손님 규칙(guestNo)으로 먼저 거절한다 — 지금 규칙 그대로(경우 8)
  assert.match(textOf(await sdk(ws, cases[2][1], 'schedule_task')({ title: '예약', prompt: '진행', type: 'daily', time: '09:00' })), /여기서는 쓸 수 없다/);
});

test('핀: crew 1:1에서 SDK는 맡기기 도구(delegate·send_to_crew)를 싣지 않는다 — 방에 다른 에이전트가 없다', async () => {
  const ws = await company();
  const names = sdkNames(ws, ctxOf(ws, { own: true }));
  assert.ok(names.includes('request_approval'));
  assert.equal(names.includes('delegate'), false); assert.equal(names.includes('send_to_crew'), false);
});

/* ───────────────────────── 새 동작(고치기 전 코드에서 실패) ───────────────────────── */

test('D28 재현 → 닫힘: 개인 crew 1:1 주인 턴의 고위험 셸 — 결재 항목이 이 방을 목적지로 지니고(SDK 훅·canUseTool 두 표면), 카드는 개인 결재 RPC로 들어간다', async () => {
  for (const surface of ['hook', 'canUseTool']) {
    const ws = await company();
    const ctx = ctxOf(ws, { own: true });
    // chat.mjs의 D28 게이트 목적지 — 예전에는 messengerOrigin 오류를 삼켜 {}가 됐다(목적지 없는 결재 → 실행 중 문맥으로 표 직접 넣기 → RLS → 카드 0)
    const gateMsgr = chatMod.shellGateMsgr(ctx);
    assert.equal(gateMsgr.channelId, PCH, `${surface}: 셸 결재 목적지 = 이 방`);
    assert.equal(gateMsgr.orgId, null); assert.equal(gateMsgr.ownCrewRoom, true);
    const gate = makePermissionGate(ws, 'alpha', paths(ws).root, null, 'ko', [], { msgr: gateMsgr });
    const decision = surface === 'hook'
      ? (await gateHooks(gate).PreToolUse[0].hooks[0]({ tool_name: 'Bash', tool_input: { command: 'rm -rf ./old-reports' } }, 'toolu_d28')).hookSpecificOutput?.permissionDecision
      : (await gate('Bash', { command: 'rm -rf ./old-reports' })).behavior;
    assert.equal(decision, 'deny', `${surface}: 실행 전 막힘`);
    const item = (await loadApprovals(ws)).find((a) => a.payload?.shell);
    assert.equal(item.msgr?.channelId, PCH, `${surface}: 결재 항목이 이 방을 안다`);
    M._activeCtxForTest.set(`${ws}:alpha`, ctx); // 턴이 도는 동안의 실행 중 문맥 — 이제는 항목의 목적지가 먼저다
    const db = cardDb();
    try { assert.equal(await pushApproval(ws, item, db), true, `${surface}: 카드가 들어간다`); } finally { M._activeCtxForTest.delete(`${ws}:alpha`); }
    assert.deepEqual(kinds(db), ['createPersonalApproval', 'insertMessage', 'updateApproval', 'canDecide'], `${surface}: 표 직접 넣기 없이 RPC`);
    assert.equal(db.calls[0][1].org_id, null);
    assert.equal(db.calls[0][1].risk, 'high');
    assert.deepEqual(db.calls[1][1].mentions, [{ kind: 'approval', id: 'ap-row-personal' }]);
  }
});

test('개인 crew 1:1 결재 카드 — RPC 인자는 PR-A가 받는 키만, 카드·카드 연결·결정권은 조직과 같은 길, 고위험 문구는 주인이 확정', async () => {
  const ws = await company();
  const ctx = ctxOf(ws, { own: true });
  await sdk(ws, ctx, 'request_approval')({ action: '거래처에 견적서 메일 발송', reason: '월말 마감', purpose: '마감', task: '발송', need: 'Gmail' });
  const item = await lastApproval(ws);
  assert.deepEqual([item.msgr.orgId, item.msgr.channelId, item.msgr.ownCrewRoom, item.msgr.channelKind], [null, PCH, true, 'dm']);
  const db = cardDb();
  assert.equal(await pushApproval(ws, item, db), true);
  const row = db.calls.find((c) => c[0] === 'createPersonalApproval')[1];
  const ACCEPTED = ['org_id', 'channel_id', 'crew_id', 'approval_id', 'action', 'reason', 'risk', 'kind', 'payload', 'source_msg_id']; // 20261008140000 msgr_create_personal_approval
  assert.deepEqual(Object.keys(row).filter((k) => !ACCEPTED.includes(k)), [], 'RPC가 거절하는 키를 보내지 않는다');
  assert.deepEqual([row.org_id, row.channel_id, row.crew_id, row.approval_id, row.risk, row.source_msg_id], [null, PCH, 'a', item.id, 'high', 10]);
  const card = db.calls.find((c) => c[0] === 'insertMessage')[1];
  assert.deepEqual([card.channel_id, card.kind, card.reply_to, card.client_msg_id], [PCH, 'approval_card', 10, `ap:a:${item.id}`]);
  assert.match(card.body, /결재 요청\(고위험\)/);
  assert.doesNotMatch(card.body, /조직 정책/, '개인 결재에는 조직 결재권자가 없다');
  assert.match(card.body, /소유자/);
  assert.equal(kinds(db).includes('insertApproval'), false);
  const saved = await lastApproval(ws);
  assert.deepEqual([saved.msgr.rowId, saved.msgr.orgId, saved.msgr.ownerMayDecide, saved.msgr.ownCrewRoom], ['ap-row-personal', null, true, true]);
});

test('개인 결재 — 옛 서버(RPC 없음)면 넣기를 시도하지 않은 것으로: 카드 0·표 직접 넣기 0, 결재는 로컬 결재함에 남는다(경우 16)', async () => {
  const ws = await company();
  await sdk(ws, ctxOf(ws, { own: true }), 'request_approval')({ action: '보고서 정리', reason: '필요' });
  const item = await lastApproval(ws);
  const db = cardDb({ personalRpc: 'old' });
  assert.equal(await pushApproval(ws, item, db), false);
  assert.deepEqual(kinds(db), ['createPersonalApproval'], '표 직접 넣기로 물러나지 않는다');
  const saved = await lastApproval(ws);
  assert.equal(saved.status, 'pending'); assert.equal(saved.msgr.rowId, undefined, '미러되지 않음');
});

test('실행 중 문맥으로 대신 찾은 개인 방이 crew 1:1이 아니면(친구 방 D28·판정 모름) 넣기를 시도하지 않는다', async () => {
  for (const own of [false, undefined]) {
    const ws = await company();
    const ctx = ctxOf(ws, { channelId: FCH, own });
    // 친구 방의 D28 게이트 목적지는 고치기 전·후 모두 {}(messengerOrigin 거절을 삼킨 값) — 결재는 로컬에, 실행은 막힌다
    const gate = makePermissionGate(ws, 'alpha', paths(ws).root, null, 'ko', [], { msgr: {} });
    assert.equal((await gate('Bash', { command: 'git push --force origin main' })).behavior, 'deny', '결재는 그대로 로컬에 — 실행은 막힌다');
    const item = (await loadApprovals(ws)).find((a) => a.payload?.shell);
    assert.equal(item.msgr, undefined);
    M._activeCtxForTest.set(`${ws}:alpha`, ctx);
    const db = cardDb();
    try { assert.equal(await pushApproval(ws, item, db), false); } finally { M._activeCtxForTest.delete(`${ws}:alpha`); }
    assert.deepEqual(kinds(db), [], `own=${own}: 넣기 시도 0(표·RPC 모두)`);
    assert.equal(chatMod.shellGateMsgr(ctx).channelId, undefined, '친구 방은 셸 결재 목적지를 만들지 않는다(종전처럼 {})');
  }
});

test('messengerOrigin — crew 1:1(서버 판정 true)·주인 턴·자기 자신만 연다. 거절은 이유별 문구(ko/en)', () => {
  const ws = 'w';
  const ok = H.messengerOrigin(ctxOf(ws, { own: true }));
  assert.deepEqual([ok.orgId, ok.channelId, ok.crewId, ok.ownCrewRoom, ok.channelKind, ok.guest], [null, PCH, 'a', true, 'dm', undefined]);
  assert.equal(H.messengerOrigin(ctxOf(ws, { own: true }), 'alpha').crewId, 'a', '대상이 자기 자신이면 연다(예약·긴 작업의 기본 담당)');
  const two = [peer(ws, 'a', 'alpha'), peer(ws, 'b', 'beta')];
  for (const [lang, re] of [
    ['ko', { room: /친구와의 방|1:1이 아니/, unknown: /개인 공간에서는 아직/, guest: /주인이 아닌 사람/, other: /다른 에이전트/ }],
    ['en', { room: /friend/i, unknown: /not available in this personal-space room yet/i, guest: /someone other than the owner/i, other: /another agent/i }],
  ]) {
    const L = lang === 'en' ? 'en' : undefined;
    assert.throws(() => H.messengerOrigin(ctxOf(ws, { channelId: FCH, own: false, lang: L })), re.room, `${lang}: 친구 방`);
    assert.throws(() => H.messengerOrigin(ctxOf(ws, { channelId: FCH, lang: L })), re.unknown, `${lang}: 판정 모름(옛 서버) = 지금 문구`);
    assert.throws(() => H.messengerOrigin(ctxOf(ws, { own: true, requester: FRIEND, lang: L })), re.guest, `${lang}: 손님`);
    assert.throws(() => H.messengerOrigin(ctxOf(ws, { own: true, peers: two, lang: L }), 'beta'), re.other, `${lang}: 다른 에이전트 대상`);
  }
  assert.throws(() => H.messengerOrigin({ ...ctxOf(ws, { own: true }), uid: null }), /메신저 실행 문맥이 없습니다/, '나머지 문맥 요건은 그대로');
});

test('개인 crew 1:1 — 예약(once·daily)·긴 작업이 이 방 기록(orgId null·ownCrewRoom)을 지니고, 예약 저장 때 다시 확인해도 통과한다', async () => {
  const ws = await company();
  const ctx = ctxOf(ws, { own: true });
  for (const [type, extra] of [['once', { date: '2026-12-01', time: '09:00' }], ['daily', { time: '09:00' }]]) {
    const r = await sdk(ws, ctx, 'schedule_task')({ title: `예약 ${type}`, prompt: '진행', type, ...extra });
    assert.match(textOf(r), /예약 완료/, type);
  }
  const rs = await loadRoutines(ws);
  assert.equal(rs.length, 2);
  for (const r of rs) assert.deepEqual([r.msgr.orgId, r.msgr.channelId, r.msgr.crewId, r.msgr.ownCrewRoom], [null, PCH, 'a', true]);
  assert.match(textOf(await sdk(ws, ctx, 'start_long_task')({ title: '작업', prompt: '진행' })), /걸어뒀다/);
  const [file] = await readdir(gateway.queueDir(ws, gateway.JOBS_QUEUE));
  const job = JSON.parse(await readFile(join(gateway.queueDir(ws, gateway.JOBS_QUEUE), file), 'utf8'));
  assert.deepEqual([job.msgr.orgId, job.msgr.channelId, job.msgr.ownCrewRoom], [null, PCH, true]);
});

test('CLI 지시 블록(SDK와 같은 원장) — crew 1:1의 결재는 이 방 기록, 다른 에이전트 예약·쪽지는 개인 문구로 거절', async () => {
  const ws = await company();
  const ctx = ctxOf(ws, { own: true });
  const notes = await runDirectives(ws, 'alpha', [{ action: 'approval', request: '보고서 발송' }, { action: 'schedule', crew: 'beta', prompt: '진행', time: '09:00' }, { action: 'mail', to: 'beta', message: '이어 할 일' }], { mirrorCtx: ctx });
  const ap = await lastApproval(ws);
  assert.deepEqual([ap.msgr.orgId, ap.msgr.channelId, ap.msgr.ownCrewRoom], [null, PCH, true]);
  const all = textOf(notes);
  assert.match(all, /다른 에이전트/, '다른 에이전트 예약 — 개인 문구');
  assert.match(all, /그 에이전트가 없어|넘길 다른 에이전트/, '쪽지(넘김) — 개인 문구');
  assert.equal((await loadRoutines(ws)).length, 0);
});

test('stageMessengerHandoff — 개인 방에 없는 에이전트로 넘기면 개인 문구(ko/en), 조직 문구는 그대로', () => {
  const ws = 'w';
  assert.throws(() => H.stageMessengerHandoff(ctxOf(ws, { own: true }), { to: 'beta', message: '이어 할 일' }), /개인 공간.*그 에이전트가 없어/);
  assert.throws(() => H.stageMessengerHandoff(ctxOf(ws, { own: true, lang: 'en' }), { to: 'beta', message: 'next' }), /not in this personal-space room/);
  assert.throws(() => H.stageMessengerHandoff(ctxOf(ws, { org: ORG }), { to: 'beta', message: '이어 할 일' }), /같은 메신저 조직에 파견된 동료만/, '조직 문구 그대로');
});

test('propose_org_doc — 개인 턴이면 결재를 만들지 않고 "개인 공간에는 조직 문서가 없다"를 먼저 돌려준다(경우 6)', async () => {
  for (const lang of ['ko', 'en']) {
    const ws = await company({ lang });
    const r = await sdk(ws, ctxOf(ws, { own: true }), 'propose_org_doc', { lang })({ scope: 'org', folder: 'rules', title: '규칙', body: '본문', reason: '공유' });
    assert.match(textOf(r), lang === 'en' ? /no organization docs/i : /개인 공간에는 조직 문서가 없/);
    assert.equal((await loadApprovals(ws)).length, 0, `${lang}: 결재 0`);
  }
});

test('run() — 개인 방 주인 턴만 판정 RPC 1회(실행권을 잡은 뒤)·결과를 문맥에, 손님 턴·조직 턴은 부르지 않는다', async () => {
  const ws = await company();
  for (const own of [true, false, null]) {
    const r = handlerRoom({ own });
    const ctx = await handlerTurn(ws, r);
    assert.deepEqual(r.db.calls.filter((c) => c[0] === 'ownCrewRoom'), [['ownCrewRoom', PCH, 'a']], `own=${own}: 턴당 1회, 이 방·이 에이전트`);
    assert.equal(ctx.ownCrewRoom, own, `own=${own}: 서버 판정 그대로`);
    assert.equal(ctx.ownerSolo, true, '#858 표지와 함께 선다');
  }
  const guest = handlerRoom({ channelId: FCH, author: FRIEND, members: [{ member_kind: 'user', member_id: OWNER }, { member_kind: 'user', member_id: FRIEND }, { member_kind: 'crew', member_id: 'a' }] });
  const gctx = await handlerTurn(ws, guest);
  assert.equal(guest.db.calls.filter((c) => c[0] === 'ownCrewRoom').length, 0, '손님 턴은 어차피 거절 — 판정 RPC 0');
  assert.equal(gctx.ownCrewRoom, undefined);
});

test('db 어댑터 — ownCrewRoom: true/false, 옛 서버·오류는 null(모름 → 거절). createPersonalApproval: {id}, 옛 서버 null, 그 밖 오류는 던진다', async () => {
  const rpcs = [];
  const client = (answer) => ({ rpc: async (name, args) => { rpcs.push([name, args]); return answer; } });
  const quiet = console.error; console.error = () => {};
  try {
    assert.equal(await M.makeDb(client({ data: true, error: null })).ownCrewRoom(PCH, 'a'), true);
    assert.deepEqual(rpcs.at(-1), ['msgr_is_own_crew_room', { p_channel: PCH, p_crew: 'a' }]);
    assert.equal(await M.makeDb(client({ data: false, error: null })).ownCrewRoom(PCH, 'a'), false);
    for (const code of ['PGRST202', '42883', '57014']) assert.equal(await M.makeDb(client({ data: null, error: { code, message: 'x' } })).ownCrewRoom(PCH, 'a'), null, code);
    assert.equal(await M.makeDb({ rpc: async () => { throw new Error('network'); } }).ownCrewRoom(PCH, 'a'), null, '네트워크 오류');
    const row = { org_id: null, channel_id: PCH, crew_id: 'a', approval_id: 'ap-1', action: '보내기', reason: null, risk: 'low', source_msg_id: 10 };
    assert.deepEqual(await M.makeDb(client({ data: { id: 'ap-row' }, error: null })).createPersonalApproval(row), { id: 'ap-row' });
    assert.deepEqual(rpcs.at(-1), ['msgr_create_personal_approval', { p_row: row }]);
    for (const code of ['PGRST202', '42883']) assert.equal(await M.makeDb(client({ data: null, error: { code, message: 'missing' } })).createPersonalApproval(row), null, code);
    await assert.rejects(M.makeDb(client({ data: null, error: { code: '42501', message: 'msgr_not_allowed' } })).createPersonalApproval(row), (e) => e.code === '42501' && /msgr_not_allowed/.test(e.message), '판정 거절은 던진다');
  } finally { console.error = quiet; }
});

test('커넥터 쓰기 결재(SDK use_connector·CLI tool) — crew 1:1이면 이 방 기록을 지닌다', async () => {
  const ws = await company();
  const { startOauthTestServer } = await import('./helpers/oauth-test-server.mjs');
  const { startConnect, closeConnectorPools } = await import('../src/connectors.mjs');
  const server = await startOauthTestServer();
  const stop = onNotify(() => {});
  try {
    const { authUrl, done } = await startConnect(ws, { id: 'test-connector', url: server.mcpUrl, scopes: ['spike.read', 'spike.write'] });
    const response = await fetch(authUrl, { redirect: 'manual' });
    await fetch(new URL(response.headers.get('location')));
    assert.equal((await done).ok, true);
    const ctx = ctxOf(ws, { own: true });
    for (const runner of ['SDK', 'CLI']) {
      if (runner === 'SDK') await sdk(ws, ctx, 'use_connector', { connectors: [{ id: 'test-connector', name: 'Test', status: 'connected', tools: [{ name: 'send_mail_demo' }] }] })({ server: 'test-connector', tool: 'send_mail_demo', args: { to: 'example@example.com', body: runner } });
      else await runDirectives(ws, 'alpha', [{ action: 'tool', server: 'test-connector', tool: 'send_mail_demo', args: { to: 'example@example.com', body: runner } }], { mirrorCtx: ctx });
      const ap = (await loadApprovals(ws)).filter((a) => a.kind === 'connector').at(-1);
      assert.deepEqual([ap.msgr?.orgId, ap.msgr?.channelId, ap.msgr?.ownCrewRoom], [null, PCH, true], runner);
    }
    assert.equal((await loadApprovals(ws)).filter((a) => a.kind === 'connector').length, 2);
    assert.equal(server.counters.toolCalls.send_mail_demo ?? 0, 0, '승인 전 실행 0');
  } finally { stop(); await closeConnectorPools(); await server.close(); }
});
