// 이어 실행 근거(continuation) — 본체 단위. 결재 후속·예약·긴 작업 턴(이어 실행)이 올리는 결재 카드는 출처(원래 글)의 실행이 이미 끝났으므로
// 카드 넣기 행의 payload에 근거를 싣는다: continuation = 호출자가 정한 종류, 결재 후속이 승인이면 followup_of = 부모 결재 행(봇 선례).
// 서버 출처 가드의 판정(위조·남의 방·묵은 글·대기 카드)과 실제 Postgres 왕복은 msgr-continuation-approval-pg.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from './helpers/tmp.mjs';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-msgr-continuation-evidence-'));
const { createCompany, paths } = await import('../src/workspace.mjs');
const { makeCrewServer } = await import('../src/chat.mjs');
const { runDirectives } = await import('../src/cli-directives.mjs');
const { addRoutine, runRoutine, loadRoutines } = await import('../src/routines.mjs');
const { loadApprovals } = await import('../src/approvals.mjs');
const approvals = await import('../src/approval-actions.mjs');
const gateway = await import('../src/gateway.mjs');
const { msgrPush, runMessengerContinuation } = await import('../src/gateway/msgr.mjs');
const { messengerOrigin } = await import('../src/gateway/msgr-handoff.mjs');

const PARENT_ROW = '6f1d1c6e-8a43-4c1e-9b7a-2b8f1f0c9d11';
let n = 0;
async function setup() {
  const ws = `cont-evidence-${++n}`;
  await createCompany(ws, '검수', 'alpha');
  await mkdir(paths(ws).agents, { recursive: true });
  const peers = [{ id: 'a', slug: 'alpha', display_name: '알파', owner_user_id: 'owner', ws_id: ws }, { id: 'b', slug: 'beta', display_name: '베타', owner_user_id: 'owner', ws_id: ws }];
  for (const p of peers) await writeFile(join(paths(ws).agents, `${p.slug}.md`), `---\nname: ${p.display_name}\nslug: ${p.slug}\n---\n`);
  const origin = { orgId: 'org', channelId: 'channel', crewId: 'a', threadRoot: 10, sourceMsgId: 10, uid: 'owner', wsId: ws, origin: 'owner', hop: 0 };
  const inserted = []; const seen = [];
  const db = {
    crewBySlug: async (uid, wsId, slug, orgId) => { const p = peers.find((x) => x.owner_user_id === uid && x.ws_id === wsId && x.slug === slug); return p && orgId === 'org' ? { ...p, org_id: orgId } : null; },
    channel: async (id) => (id === 'channel' ? { id, org_id: 'org', name: 'Crew', kind: 'private', crew_memory: false } : null),
    org: async () => ({ id: 'org', slug: 'team' }),
    orgCrews: async () => peers,
    channelCrewMembers: async () => new Set(peers.map((p) => p.id)),
    message: async (id) => (id === 10 ? { id, channel_id: 'channel', author_kind: 'user', author_user_id: 'owner', body: '원래 지시' } : null),
    contextOf: async () => [],
    instructCheck: async () => 'ok',
    insertMessage: async (row) => ({ id: 100 + inserted.length, ...row }),
    insertApproval: async (row) => { inserted.push(row); return { id: `row-${inserted.length}` }; },
    updateApproval: async (id) => [{ id }],
    canDecide: async () => true,
  };
  const session = async () => ({ uid: 'owner', db });
  return { ws, peers, origin, db, session, inserted, seen };
}
const sdk = (ws, slug, ctx, name) => { const sink = []; makeCrewServer(ws, slug, slug, [], 0, [], ctx, 'ko', [], '', sink); return sink.find((t) => t.name === name).handler; };
/** 이어 실행 턴 안에서 결재 하나 — SDK는 request_approval, CLI는 지시 블록 */
const raise = (f, runner, action, extra = async () => {}) => async (ws, slug, _msg, _sid, opts) => {
  f.seen.push(opts.mirrorCtx);
  if (runner === 'SDK') await sdk(ws, slug, opts.mirrorCtx, 'request_approval')({ action, reason: '필요' });
  else await runDirectives(ws, slug, [{ action: 'approval', request: action, reason: '필요' }], { mirrorCtx: opts.mirrorCtx });
  await extra(ws, slug, opts.mirrorCtx);
  return { reply: '결재를 올렸다', sessionId: null, handover: null };
};
async function pushedPayload(f, action) {
  const item = (await loadApprovals(f.ws)).find((a) => a.action === action);
  assert.ok(item, `결재 항목 ${action}`);
  const before = f.inserted.length;
  assert.equal(await msgrPush({ type: 'approval', wsId: f.ws, item }, { session: f.session }), true);
  assert.equal(f.inserted.length, before + 1, '넣기 1회');
  return { item, row: f.inserted.at(-1) };
}

for (const runner of ['SDK', 'CLI']) {
  test(`${runner}: 결재 후속 — 승인이면 continuation=followup + followup_of=부모 행, 거절이면 followup_of 없이 continuation만`, async () => {
    const f = await setup();
    for (const [approve, label] of [[true, '승인'], [false, '거절']]) {
      await approvals._followUpForTest(f.ws, { id: `ap-parent-${label}`, slug: 'alpha', kind: 'action', action: '부모', status: approve ? 'approved' : 'rejected', msgr: { ...f.origin, rowId: PARENT_ROW } }, approve,
        { session: f.session, runChat: raise(f, runner, `${label} 후속 결재`) });
      const { item, row } = await pushedPayload(f, `${label} 후속 결재`);
      const want = approve ? { continuation: 'followup', followup_of: PARENT_ROW } : { continuation: 'followup' };
      assert.deepEqual(row.payload, want, `${label}: 넣기 행 payload`);
      assert.equal(row.source_msg_id, 10, '출처 = 원래 글(그대로)');
      assert.deepEqual(item.msgr.continuation, approve ? { kind: 'followup', followupOf: PARENT_ROW } : { kind: 'followup' });
    }
  });
  test(`${runner}: 예약·긴 작업 — 예약 턴은 continuation=routine, 작업 턴은 continuation=job`, async () => {
    const f = await setup();
    const r = await addRoutine(f.ws, { agentSlug: 'alpha', title: '아침', prompt: '정리', schedule: { type: 'daily', time: '09:00' }, msgr: f.origin });
    await runRoutine(f.ws, r.id, { session: f.session, chatFn: raise(f, runner, '예약 결재') });
    assert.deepEqual((await pushedPayload(f, '예약 결재')).row.payload, { continuation: 'routine' });
    await gateway._makeJobHandlerForTest(f.ws, { session: f.session, runChat: raise(f, runner, '작업 결재') })({ id: 'job-e', slug: 'alpha', title: '작업', prompt: '수집', msgr: f.origin });
    assert.deepEqual((await pushedPayload(f, '작업 결재')).row.payload, { continuation: 'job' });
  });
}

test('쉬운 문장(plain)·조직 문서 payload는 그대로 두고 근거만 더한다', async () => {
  const f = await setup();
  await approvals._followUpForTest(f.ws, { id: 'ap-plain', slug: 'alpha', kind: 'action', action: '부모', status: 'approved', msgr: { ...f.origin, rowId: PARENT_ROW } }, true, { session: f.session, runChat: async (ws, slug, _m, _s, opts) => {
    await sdk(ws, slug, opts.mirrorCtx, 'request_approval')({ action: '쉬운 문장 결재', reason: '필요', purpose: '목적', task: '할 일', need: '필요한 것' });
    await sdk(ws, slug, opts.mirrorCtx, 'propose_org_doc')({ scope: 'org', folder: 'rules', title: '규칙', body: '본문', reason: '공유', slug: 'rules-one' });
    return { reply: 'ok', sessionId: null, handover: null };
  } });
  const plain = (await pushedPayload(f, '쉬운 문장 결재')).row.payload;
  assert.deepEqual(plain, { plain: { purpose: '목적', task: '할 일', need: '필요한 것' }, continuation: 'followup', followup_of: PARENT_ROW });
  const doc = (await loadApprovals(f.ws)).find((a) => a.kind === 'org_doc');
  assert.equal(await msgrPush({ type: 'approval', wsId: f.ws, item: doc }, { session: f.session }), true);
  const row = f.inserted.at(-1);
  assert.equal(row.kind, 'org_doc');
  assert.deepEqual(row.payload, { ...doc.payload, continuation: 'followup', followup_of: PARENT_ROW }, '문서 제목·본문·경로는 그대로(서버 msgr_apply_org_doc이 읽는 키)');
});

test('핀: 보통 턴(이어 실행 아님)의 카드 넣기 행은 배포본과 같다 — 근거 키 없음, plain만 있으면 plain만', async () => {
  const f = await setup();
  const ctx = { ...f.origin, kind: 'msgr', peers: f.peers, handoffs: [] };
  await sdk(f.ws, 'alpha', ctx, 'request_approval')({ action: '보통 결재', reason: '필요' });
  await sdk(f.ws, 'alpha', ctx, 'request_approval')({ action: '보통 쉬운 결재', reason: '필요', purpose: '목적' });
  const a = await pushedPayload(f, '보통 결재');
  assert.equal('payload' in a.row, false, '근거도 plain도 없으면 payload 키를 보내지 않는다(종전 그대로)');
  assert.equal(a.item.msgr.continuation, undefined);
  assert.deepEqual((await pushedPayload(f, '보통 쉬운 결재')).row.payload, { plain: { purpose: '목적' } });
});

test('저장된 기록의 근거는 믿지 않는다 — 종류는 호출자만 정하고, 모르는 종류·형식이 틀린 부모 id는 싣지 않는다', async () => {
  const f = await setup();
  const ran = [];
  const capture = async (_ws, _slug, _m, _s, opts) => { ran.push(opts.mirrorCtx.continuation); return { reply: 'ok', sessionId: null, handover: null }; };
  // 기록에 근거가 적혀 있어도(손으로 고친 예약 파일·옛 기록) 호출자가 종류를 안 밝히면 근거 없음
  await runMessengerContinuation(f.ws, 'alpha', { ...f.origin, continuation: { kind: 'job' } }, '진행', null, { session: f.session, runChat: capture });
  await runMessengerContinuation(f.ws, 'alpha', f.origin, '진행', null, { session: f.session, runChat: capture, continuation: { kind: 'manual' } });
  await runMessengerContinuation(f.ws, 'alpha', f.origin, '진행', null, { session: f.session, runChat: capture, continuation: { kind: 'followup', followupOf: "x' or 1=1" } });
  await runMessengerContinuation(f.ws, 'alpha', f.origin, '진행', null, { session: f.session, runChat: capture, continuation: { kind: 'routine', followupOf: PARENT_ROW } });
  assert.deepEqual(ran, [undefined, undefined, { kind: 'followup' }, { kind: 'routine' }]);
  // 예약 기록에 엉뚱한 근거가 있어도 예약 턴은 routine
  const r = await addRoutine(f.ws, { agentSlug: 'alpha', title: '기록', prompt: '정리', schedule: { type: 'daily', time: '09:00' }, msgr: f.origin });
  const routines = await loadRoutines(f.ws);
  routines.find((x) => x.id === r.id).msgr.continuation = { kind: 'followup', followupOf: PARENT_ROW };
  await writeFile(paths(f.ws).routines, JSON.stringify(routines)); // 손으로 고친 예약 파일
  ran.length = 0;
  await runRoutine(f.ws, r.id, { session: f.session, chatFn: capture });
  assert.deepEqual(ran, [{ kind: 'routine' }]);
});

for (const runner of ['SDK', 'CLI']) {
  test(`${runner}: 이어 실행 턴 안에서 건 예약·작업 기록에는 근거를 남기지 않는다(실행할 때 호출자가 다시 정한다)`, async () => {
    const f = await setup();
    await approvals._followUpForTest(f.ws, { id: 'ap-sched', slug: 'alpha', kind: 'action', action: '부모', status: 'approved', msgr: { ...f.origin, rowId: PARENT_ROW } }, true, { session: f.session, runChat: async (ws, slug, _m, _s, opts) => {
      assert.deepEqual(opts.mirrorCtx.continuation, { kind: 'followup', followupOf: PARENT_ROW });
      if (runner === 'SDK') {
        await sdk(ws, slug, opts.mirrorCtx, 'schedule_task')({ title: '후속 예약', prompt: '확인', type: 'daily', time: '09:00' });
        await sdk(ws, slug, opts.mirrorCtx, 'start_long_task')({ title: '후속 작업', prompt: '수집' });
      } else await runDirectives(ws, slug, [{ action: 'schedule', title: '후속 예약', prompt: '확인', time: '09:00' }], { mirrorCtx: opts.mirrorCtx });
      return { reply: 'ok', sessionId: null, handover: null };
    } });
    const [r] = (await loadRoutines(f.ws)).filter((x) => x.prompt === '확인');
    assert.ok(r, '예약이 걸렸다');
    assert.equal(r.msgr.continuation, undefined, '예약 기록에 근거 없음');
    assert.equal(r.msgr.channelId, 'channel');
    if (runner === 'SDK') {
      const dir = gateway.queueDir(f.ws, gateway.JOBS_QUEUE);
      const [file] = await readdir(dir);
      const job = JSON.parse(await readFile(join(dir, file), 'utf8'));
      assert.equal(job.msgr.continuation, undefined, '작업 기록에 근거 없음');
    }
    // 같은 턴의 기록 모양 — messengerOrigin(문맥)에는 근거가 실리고, 예약·작업용(targetSlug)에는 없다
    const ctx = { ...f.origin, kind: 'msgr', peers: f.peers, handoffs: [], continuation: { kind: 'job' } };
    assert.deepEqual(messengerOrigin(ctx).continuation, { kind: 'job' });
    assert.equal(messengerOrigin(ctx, 'alpha').continuation, undefined);
  });
}

test('셸 고위험 결재(D28)·커넥터 결재도 같은 길 — 이어 실행 턴의 게이트 목적지에 근거가 실린다(messengerOrigin 한 곳)', async () => {
  const { shellGateMsgr } = await import('../src/chat.mjs');
  const f = await setup();
  const ctx = { ...f.origin, kind: 'msgr', peers: f.peers, handoffs: [] };
  assert.equal(shellGateMsgr(ctx).continuation, undefined, '보통 턴은 근거 없음');
  assert.deepEqual(shellGateMsgr({ ...ctx, continuation: { kind: 'routine' } }).continuation, { kind: 'routine' }, '예약 턴의 셸 결재 목적지');
});
