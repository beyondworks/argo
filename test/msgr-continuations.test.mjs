import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from './helpers/tmp.mjs';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-msgr-continuations-'));
const { createCompany, paths } = await import('../src/workspace.mjs');
const { makeCrewServer } = await import('../src/chat.mjs');
const { runDirectives } = await import('../src/cli-directives.mjs');
const { addRoutine, runRoutine, loadRoutines } = await import('../src/routines.mjs');
const { loadApprovals, addApproval } = await import('../src/approvals.mjs');
const approvals = await import('../src/approval-actions.mjs');
const gateway = await import('../src/gateway.mjs');
const { msgrPush, _activeCtxForTest } = await import('../src/gateway/msgr.mjs');
const { onNotify } = await import('../src/notify.mjs');
let n = 0;
// requester = 이 방에서 크루에게 지시한 사람. 기본은 주인이 아닌 'person'(종전 그대로). 손님 턴(PR-A)은 주인이 아닌 요청자의
// 도구·예약·커넥터를 막으므로, 그 도구의 동작을 보는 테스트는 requester: 'owner'(주인 턴)로 돈다 — 검사 대상은 주인 흐름의 동작이다.
async function setup({ requester = 'person' } = {}) {
  const ws = `continuation-${++n}`;
  await createCompany(ws, '검수', 'alpha');
  await mkdir(paths(ws).agents, { recursive: true });
  const peers = [
    { id: 'a', slug: 'alpha', display_name: '알파', owner_user_id: 'owner', ws_id: ws },
    { id: 'b', slug: 'beta', display_name: '베타', owner_user_id: 'owner', ws_id: ws },
  ];
  for (const p of peers) await writeFile(join(paths(ws).agents, `${p.slug}.md`), `---\nname: ${p.display_name}\nslug: ${p.slug}\n---\n`);
  const origin = { orgId: 'org', channelId: 'channel', crewId: 'a', threadRoot: 10, sourceMsgId: 10, uid: 'owner', wsId: ws, origin: requester, hop: 2 };
  const ctx = { ...origin, kind: 'msgr', peers, handoffs: [] };
  const rows = []; const seen = []; const events = [];
  const db = {
    crewBySlug: async (uid, wsId, slug, orgId) => {
      const p = peers.find((p) => p.owner_user_id === uid && p.ws_id === wsId && p.slug === slug);
      return p && orgId === 'org' ? { ...p, org_id: orgId } : null;
    },
    channel: async (id) => id === 'channel' ? { id, org_id: 'org', name: 'Crew', kind: 'private', crew_memory: false } : null,
    org: async () => ({ id: 'org', slug: 'team' }),
    orgCrews: async () => peers,
    channelCrewMembers: async () => new Set(peers.map((p) => p.id)), // 비공개 채널 — 동료 전원이 구성원(채널 범위 게이트, 2026-09-11)
    message: async (id) => id === 10 ? { id, channel_id: 'channel', author_kind: 'user', author_user_id: requester, body: '같은 방에서 계속' } : null,
    contextOf: async () => [{ id: 11, author_kind: 'crew', crew_id: 'b', body: '이전 결과' }],
    instructCheck: async () => 'ok',
    insertMessage: async (row) => { rows.push(row); return { id: 20 + rows.length }; },
  };
  const session = async () => ({ uid: 'owner', db });
  const stop = onNotify((e) => { if (e.wsId === ws) events.push(e); });
  const runChat = (runner) => async (_ws, slug, msg, _session, opts) => {
    seen.push(opts);
    assert.equal(opts.source, 'messenger');
    assert.equal(opts.mirrorCtx.channelId, origin.channelId);
    assert.equal(opts.mirrorCtx.crewId, peers.find((p) => p.slug === slug).id);
    assert.equal(opts.mirrorCtx.threadRoot, 10);
    assert.deepEqual(opts.journal, { off: true, tag: 'org-org-ch-channel' }); // 채널 단위 일지 태그(PR-B)
    assert.match(msg, /이전 결과/);
    assert.deepEqual(opts.mirrorCtx.handoffs, [], 'each continuation starts a fresh handoff collector');
    const to = slug === 'alpha' ? 'beta' : 'alpha';
    if (runner === 'SDK') await sdk(ws, slug, opts.mirrorCtx, 'send_to_crew')({ to, message: '이어 할 일' });
    else await runDirectives(ws, slug, [{ action: 'mail', to, message: '이어 할 일' }], { mirrorCtx: opts.mirrorCtx });
    return { reply: '결과', sessionId: null, handover: null };
  };
  return { ws, peers, origin, ctx, db, session, rows, seen, events, stop, runChat, requester };
}

test('verify retries rebuild the collector and blocked loops keep both the decision and result in the same thread', async () => {
  const f = await setup({ requester: 'owner' }); // 주인 턴 — 도구·예약·커넥터 동작 자체를 본다(손님 턴 거절은 msgr-guest-turn.test.mjs)
  try {
    const r = await addRoutine(f.ws, { agentSlug: 'alpha', title: '조건', prompt: '진행', schedule: { type: 'daily', time: '09:00' }, verify: { files: ['done.txt'], retries: 1 }, msgr: f.origin });
    const run = f.runChat('SDK'); let calls = 0;
    await runRoutine(f.ws, r.id, { session: f.session, chatFn: async (...args) => {
      const t = await run(...args);
      if (++calls === 2) await writeFile(join(paths(f.ws).vault, 'done.txt'), 'done');
      return t;
    } });
    assert.equal(calls, 2);
    assert.notEqual(f.seen[0].mirrorCtx, f.seen[1].mirrorCtx);
    await assertDelivered(f, 'routine');
    f.events.length = 0; f.rows.length = 0;
    const loop = await addRoutine(f.ws, { agentSlug: 'alpha', title: '루프', prompt: '진행', schedule: { type: 'interval', everyMinutes: 10 }, loop: {}, msgr: f.origin });
    const result = await runRoutine(f.ws, loop.id, { session: f.session, chatFn: async (...args) => ({ ...(await run(...args)), reply: '처리\nLOOP: blocked 결정 필요' }) });
    assert.equal(result.stopped, 'blocked', 'rendered handoff must not hide the LOOP verdict');
    const decision = (await loadApprovals(f.ws)).find((a) => a.kind === 'loop');
    assert.deepEqual(decision.msgr, f.origin);
    const reports = f.events.filter((e) => e.type === 'routine');
    assert.equal(reports.length, 2);
    for (const event of reports) await msgrPush(event, { session: f.session });
    assert.equal(new Set(f.rows.map((r) => r.client_msg_id)).size, 2, 'stop and result are distinct deliveries');
    assert.ok(f.rows.every((r) => r.channel_id === 'channel' && r.thread_root === 10));
  } finally { f.stop(); }
});

test('failures and interrupted jobs remain Messenger-only without executing a new handoff', async () => {
  const f = await setup();
  try {
    const runChat = async () => { throw new Error('시험 실패'); };
    await assert.rejects(approvals._followUpForTest(f.ws, { id: 'ap-fail', slug: 'alpha', action: '작업', msgr: f.origin }, true, { runChat, session: f.session }), /시험 실패/);
    const r = await addRoutine(f.ws, { agentSlug: 'alpha', title: '실패', prompt: '작업', schedule: { type: 'daily', time: '09:00' }, msgr: f.origin });
    await assert.rejects(runRoutine(f.ws, r.id, { chatFn: runChat, session: f.session }), /시험 실패/);
    const handler = gateway._makeJobHandlerForTest(f.ws, { runChat, session: f.session });
    await handler({ id: 'job-fail', slug: 'alpha', title: '실패', prompt: '작업', msgr: f.origin });
    await handler({ id: 'job-stop', slug: 'alpha', title: '중단', prompt: '작업', tries: 1, msgr: f.origin });
    await Promise.resolve();
    assert.equal(f.events.length, 4);
    for (const e of f.events) assert.equal(await msgrPush(e, { session: f.session }), true);
    assert.equal(f.rows.length, 4);
    assert.ok(f.rows.every((r) => r.channel_id === 'channel' && r.thread_root === 10 && r.mentions.length === 0));
  } finally { f.stop(); }
});

test('completed continuations cancel prepared handoffs and preserve the independent LOOP verdict', async () => {
  const f = await setup();
  try {
    const loop = await addRoutine(f.ws, { agentSlug: 'alpha', title: '종료', prompt: '완료하면 종료', schedule: { type: 'interval', everyMinutes: 10 }, loop: {}, msgr: f.origin });
    const result = await runRoutine(f.ws, loop.id, { session: f.session, chatFn: async (...args) => ({
      ...(await f.runChat('SDK')(...args)), reply: '완료. @베타 수고했어요.\nLOOP: done\nMSGR: done',
    }) });
    assert.equal(result.stopped, 'done');
    const event = f.events.find((e) => e.type === 'routine' && e.reply?.includes('수고했어요'));
    assert.ok(event);
    assert.equal(event.msgrReply.meta.disposition, 'done');
    assert.deepEqual(event.msgrReply.mentions, []);
    await msgrPush(event, { session: f.session });
    assert.equal(f.rows.length, 1);
    assert.deepEqual(f.rows[0].mentions, []);
    assert.equal(f.rows[0].meta.disposition, 'done');
    assert.doesNotMatch(f.rows[0].body, /MSGR:|이어 할 일/);
    assert.match(f.rows[0].body, /완료/);
  } finally { f.stop(); }
});

test('an unavailable or muted Messenger destination never falls back to Telegram for any continuation event', async () => {
  const f = await setup();
  const { updateConnection } = await import('../src/connections.mjs');
  await updateConnection(f.ws, 'telegram', { enabled: true, token: 'test-gateway' });
  await updateConnection(f.ws, 'telegram', { chatId: '123' });
  const realFetch = globalThis.fetch; const calls = [];
  globalThis.fetch = async (url) => { calls.push(String(url)); return new Response(JSON.stringify({ ok: true, result: {} })); };
  try {
    const events = [
      { type: 'approval', item: { id: 'ap', slug: 'alpha', action: '처리', msgr: f.origin } },
      { type: 'approval_followup', item: { id: 'ap', slug: 'alpha', msgr: f.origin, tg: { chatId: '123' } } },
      { type: 'approval_resolved', item: { id: 'ap', slug: 'alpha', msgr: f.origin, tg: { chatId: '123', messageId: 1 } } },
      { type: 'routine', routine: { id: 'r', agentSlug: 'alpha', title: '예약', msgr: f.origin } },
      { type: 'job', slug: 'alpha', title: '작업', msgr: f.origin },
    ];
    for (const pushMsgr of [async () => true, async () => false, async () => { throw new Error('offline'); }]) {
      for (const e of events) await gateway._pushEventForTest({ wsId: f.ws, reply: '보고', ok: true, ...e }, { pushMsgr });
    }
    assert.deepEqual(calls, []);
    await gateway._pushEventForTest({ wsId: f.ws, type: 'routine', routine: { id: 'plain', agentSlug: 'alpha', title: '일반' }, reply: '보고', ok: true }, { pushMsgr: async () => false });
    assert.equal(calls.filter((u) => u.includes('/sendMessage')).length, 1, 'origin-free routine keeps existing Telegram behavior');
  } finally { globalThis.fetch = realFetch; f.stop(); }
});

test('origin-free approvals and jobs keep their existing chat source and mail routing', async () => {
  const f = await setup();
  try {
    const seen = [];
    const runChat = async (_ws, slug, _msg, _sid, opts) => {
      seen.push(opts);
      assert.equal(opts.mirrorCtx, undefined);
      await sdk(f.ws, slug, null, 'send_to_crew')({ to: 'beta', message: `일반 ${seen.length}` });
      return { reply: '보고', handover: null, sessionId: null };
    };
    await approvals._followUpForTest(f.ws, { id: 'plain-ap', slug: 'alpha', action: '처리', tg: { chatId: '123' } }, true, { runChat });
    await gateway._makeJobHandlerForTest(f.ws, { runChat })({ id: 'plain-job', slug: 'alpha', title: '처리', prompt: '진행' });
    assert.deepEqual(seen.map((o) => o.source), ['messenger', 'job']);
    assert.equal((await readdir(join(paths(f.ws).root, 'mail', 'beta'))).length, 2);
  } finally { f.stop(); }
});

test('saved owner/workspace/crew/channel and instruction permission are checked before continuation execution', async () => {
  const f = await setup();
  const { runMessengerContinuation } = await import('../src/gateway/msgr.mjs');
  let runs = 0;
  try {
    const options = { session: f.session, runChat: async () => { runs++; return { reply: 'wrong' }; } };
    for (const change of [{ uid: 'other' }, { wsId: 'other' }, { crewId: 'b' }, { channelId: 'other' }, { threadRoot: 999 }, { origin: 'other' }]) {
      await assert.rejects(runMessengerContinuation(f.ws, 'alpha', { ...f.origin, ...change }, '진행', null, options));
    }
    const channel = f.db.channel; const message = f.db.message;
    f.db.channel = async (...args) => ({ ...(await channel(...args)), archived_at: '2026-09-09T00:00:00Z' });
    await assert.rejects(runMessengerContinuation(f.ws, 'alpha', f.origin, '진행', null, options), /보관된/);
    f.db.channel = channel;
    f.db.message = async (...args) => ({ ...(await message(...args)), deleted_at: '2026-09-09T00:00:00Z' });
    await assert.rejects(runMessengerContinuation(f.ws, 'alpha', f.origin, '진행', null, options), /삭제된/);
    f.db.message = message;
    f.db.instructCheck = async () => 'channel_policy';
    await assert.rejects(runMessengerContinuation(f.ws, 'alpha', f.origin, '진행', null, options));
    assert.equal(runs, 0);
  } finally { f.stop(); }
});

test('continuations preserve the actual source author even when the thread root was written by somebody else', async () => {
  const f = await setup();
  const { runMessengerContinuation } = await import('../src/gateway/msgr.mjs');
  const originalMessage = f.db.message;
  const checked = [];
  f.db.instructCheck = async (_crew, actor) => { checked.push(actor); return 'ok'; };
  f.db.crewOwner = async () => 'owner';
  try {
    for (const source of [
      { id: 12, channel_id: 'channel', thread_root: 10, author_kind: 'crew', crew_id: 'b', body: '이어서 예약' },
      { id: 12, channel_id: 'channel', thread_root: 10, author_kind: 'user', author_user_id: 'owner', body: '다른 사람이 같은 스레드에서 예약' },
    ]) {
      checked.length = 0;
      f.db.message = async (id) => id === 12 ? source : originalMessage(id);
      const turn = await runMessengerContinuation(f.ws, 'alpha', { ...f.origin, sourceMsgId: 12, origin: 'owner' }, '진행', null, { session: f.session, runChat: f.runChat('SDK') });
      assert.equal(turn.msgr.origin, 'owner');
      assert.equal(turn.msgr.sourceMsgId, 12);
      assert.deepEqual(checked, source.author_kind === 'crew' ? ['owner', 'person'] : ['owner']);
    }
  } finally { f.stop(); }
});

test('public channel turns and private continuations of the same crew run serially without leaking private progress', async () => {
  const f = await setup();
  const { makeMsgrHandler, runMessengerContinuation, _rtChannelsForTest } = await import('../src/gateway/msgr.mjs');
  const { setTurnStatus, clearTurnStatus } = await import('../src/turn-status.mjs');
  const broadcasts = [];
  const originalChannel = f.db.channel;
  Object.assign(f.db, {
    channel: async (id) => id === 'public' ? { id, org_id: 'org', name: 'Public', kind: 'public' } : originalChannel(id),
    settled: async () => false, memberName: async () => '사람', attachmentsOf: async () => [],
    claimExecution: async () => ({ acquired: true }), heartbeatExecution: async () => true,
    finishExecution: async (_key, row) => f.db.insertMessage(row),
  });
  _rtChannelsForTest.set(`${f.ws}:org`, { send: async (e) => { broadcasts.push(e); } });
  let releasePublic; const publicWait = new Promise((resolve) => { releasePublic = resolve; });
  let publicStarted; const began = new Promise((resolve) => { publicStarted = resolve; });
  let active = 0; let maxActive = 0; let privateStarted = false;
  const handler = makeMsgrHandler(f.ws, { session: f.session, runChat: async () => {
    maxActive = Math.max(maxActive, ++active);
    await setTurnStatus(f.ws, 'alpha', 'work', 'PUBLIC', 'PUBLIC', 'messenger', 'PUBLIC');
    publicStarted(); await publicWait;
    active--; return { reply: '공개 결과', handover: null, sessionId: null };
  } });
  const main = handler({ msgId: 30, slug: 'alpha', crewId: 'a', channelId: 'public', orgId: 'org', authorId: 'person', threadRoot: 30, text: '공개 작업', createdAt: new Date().toISOString() });
  try {
    await began;
    const continuation = runMessengerContinuation(f.ws, 'alpha', f.origin, '비공개 작업', null, { session: f.session, runChat: async () => {
      privateStarted = true; maxActive = Math.max(maxActive, ++active);
      await setTurnStatus(f.ws, 'alpha', 'work', 'PRIVATE', 'PRIVATE', 'messenger', 'PRIVATE');
      await new Promise((resolve) => setTimeout(resolve, 1600));
      active--; return { reply: '비공개 결과' };
    } });
    await new Promise((resolve) => setTimeout(resolve, 1600));
    assert.equal(privateStarted, false, 'private continuation must wait for the existing public turn');
    assert.ok(broadcasts.some((b) => b.event === 'progress'));
    releasePublic();
    await Promise.all([main, continuation]);
    assert.equal(maxActive, 1);
    assert.doesNotMatch(JSON.stringify(broadcasts), /PRIVATE/);
  } finally { releasePublic(); await main; await clearTurnStatus(f.ws, 'alpha'); _rtChannelsForTest.delete(`${f.ws}:org`); f.stop(); }
});

test('delegated Messenger children return asynchronous work to their parent without registering another destination', async () => {
  const f = await setup(); const ctx = { kind: 'msgr-rules', orgSlug: 'team' };
  try {
    for (const [name, args] of [['schedule_task', { title: '예약', prompt: '처리', type: 'daily', time: '09:00' }], ['start_long_task', { title: '작업', prompt: '처리' }]]) {
      assert.match(JSON.stringify(await sdk(f.ws, 'alpha', ctx, name)(args)), /실패/);
    }
    await assert.rejects(sdk(f.ws, 'alpha', ctx, 'request_approval')({ action: '처리', reason: '필요' }), /동료에게 돌려/);
    await runDirectives(f.ws, 'alpha', [{ action: 'schedule', prompt: '처리', time: '09:00' }, { action: 'approval', request: '처리' }], { mirrorCtx: ctx });
    assert.deepEqual(await loadRoutines(f.ws), []);
    assert.deepEqual(await loadApprovals(f.ws), []);
  } finally { f.stop(); }
});

test('SDK and CLI connector write approvals retain channel origin; delegated writes return to the parent', async () => {
  const f = await setup({ requester: 'owner' }); // 주인 턴 — 도구·예약·커넥터 동작 자체를 본다(손님 턴 거절은 msgr-guest-turn.test.mjs)
  const { startOauthTestServer } = await import('./helpers/oauth-test-server.mjs');
  const { startConnect, closeConnectorPools } = await import('../src/connectors.mjs');
  const server = await startOauthTestServer();
  try {
    const { authUrl, done } = await startConnect(f.ws, { id: 'test-connector', url: server.mcpUrl, scopes: ['spike.read', 'spike.write'] });
    const response = await fetch(authUrl, { redirect: 'manual' });
    await fetch(new URL(response.headers.get('location')));
    assert.equal((await done).ok, true);
    for (const runner of ['SDK', 'CLI']) {
      const call = async (ctx) => runner === 'SDK'
        ? sdk(f.ws, 'alpha', ctx, 'use_connector')({ server: 'test-connector', tool: 'send_mail_demo', args: { to: 'example@example.com', body: runner } })
        : runDirectives(f.ws, 'alpha', [{ action: 'tool', server: 'test-connector', tool: 'send_mail_demo', args: { to: 'example@example.com', body: runner } }], { mirrorCtx: ctx });
      await call(f.ctx);
      const approvals = await loadApprovals(f.ws);
      assert.deepEqual(approvals[0].msgr, f.origin);
      if (runner === 'SDK') await assert.rejects(call({ kind: 'msgr-rules', orgSlug: 'team' }), /동료에게 돌려/);
      else assert.match(JSON.stringify(await call({ kind: 'msgr-rules', orgSlug: 'team' })), /실패/);
      assert.equal((await loadApprovals(f.ws)).length, approvals.length);
    }
    assert.equal(server.counters.toolCalls.send_mail_demo ?? 0, 0);
  } finally { await closeConnectorPools(); await server.close(); f.stop(); }
});
function sdk(ws, slug, ctx, name) {
  const sink = [];
  makeCrewServer(ws, slug, slug, [{ slug: slug === 'alpha' ? 'beta' : 'alpha', name: '동료' }], 0, [], ctx, 'ko', name === 'use_connector' ? [{ id: 'test-connector', name: 'Test', status: 'connected', tools: [{ name: 'send_mail_demo' }] }] : [], '', sink);
  return sink.find((t) => t.name === name).handler;
}
async function assertDelivered(f, type) {
  await Promise.resolve();
  const events = f.events.filter((e) => e.type === type);
  assert.equal(events.length, 1);
  assert.equal(await msgrPush(events[0], { session: f.session }), true);
  assert.equal(f.rows.length, 1);
  assert.equal(f.rows[0].channel_id, 'channel');
  assert.equal(f.rows[0].thread_root, 10);
  assert.equal(f.rows[0].crew_id, 'a');
  assert.match(f.rows[0].body, /이어 할 일/);
  assert.deepEqual(f.rows[0].mentions, [{ kind: 'crew', id: 'b' }]);
  assert.equal(f.rows[0].meta.origin, f.requester, '답글 메타의 origin = 이 방의 요청자');
  assert.equal(f.rows[0].meta.hop, 2);
  assert.deepEqual(await readdir(join(paths(f.ws).root, 'mail', 'beta')).catch(() => []), []);
}
for (const runner of ['SDK', 'CLI']) {
  test(`${runner}: approval follow-up executes and hands off in its original Messenger thread`, async () => {
    const f = await setup();
    try {
      await approvals._followUpForTest(f.ws, { id: 'approval', slug: 'alpha', kind: 'action', action: '처리', msgr: f.origin }, true, { runChat: f.runChat(runner), session: f.session });
      await assertDelivered(f, 'approval_followup');
    } finally { f.stop(); }
  });
  test(`${runner}: scheduled execution restores the channel and does not enqueue general mail`, async () => {
    const f = await setup();
    try {
      const r = await addRoutine(f.ws, { agentSlug: 'alpha', title: '예약', prompt: '이어하기', schedule: { type: 'daily', time: '09:00' }, msgr: f.origin });
      await runRoutine(f.ws, r.id, { chatFn: f.runChat(runner), session: f.session });
      await assertDelivered(f, 'routine');
    } finally { f.stop(); }
  });
  test(`${runner}: long job restores the channel and does not enqueue general mail`, async () => {
    const f = await setup();
    try {
      await gateway._makeJobHandlerForTest(f.ws, { runChat: f.runChat(runner), session: f.session })({ id: 'job', slug: 'alpha', title: '작업', prompt: '이어하기', msgr: f.origin });
      await assertDelivered(f, 'job');
    } finally { f.stop(); }
  });
  test(`${runner}: list_routines·cancel_routine — 예약을 보고 끄고 지운다(SDK 전용)`, async () => {
    if (runner !== 'SDK') return; // CLI 러너 지시문 패리티는 아직 없다
    const f = await setup({ requester: 'owner' }); // 주인 턴 — 도구·예약·커넥터 동작 자체를 본다(손님 턴 거절은 msgr-guest-turn.test.mjs)
    try {
      await sdk(f.ws, 'alpha', f.ctx, 'schedule_task')({ title: '아침 보고', prompt: '진행', type: 'daily', time: '09:00' });
      const [made] = await loadRoutines(f.ws);
      const listed = await sdk(f.ws, 'alpha', f.ctx, 'list_routines')({});
      assert.match(JSON.stringify(listed), /아침 보고/, '목록에 제목이 나온다');
      assert.match(JSON.stringify(listed), /매일 09:00/, '일정을 사람이 읽는 말로 보여준다');
      await sdk(f.ws, 'alpha', f.ctx, 'cancel_routine')({ id: made.id, action: 'off' });
      assert.equal((await loadRoutines(f.ws))[0].enabled, false, '끄면 남아 있되 비활성');
      await sdk(f.ws, 'alpha', f.ctx, 'cancel_routine')({ id: made.id, action: 'delete' });
      assert.equal((await loadRoutines(f.ws)).length, 0, '지우면 사라진다');
      const gone = await sdk(f.ws, 'alpha', f.ctx, 'cancel_routine')({ id: made.id, action: 'off' });
      assert.match(JSON.stringify(gone), /그런 예약이 없다/, '없는 id는 조용히 성공하지 않는다');
    } finally { f.stop(); }
  });
  test(`${runner}: schedule tools persist the selected crew identity and CLI approvals retain origin`, async () => {
    const f = await setup({ requester: 'owner' }); // 주인 턴 — 도구·예약·커넥터 동작 자체를 본다(손님 턴 거절은 msgr-guest-turn.test.mjs)
    try {
      if (runner === 'SDK') await sdk(f.ws, 'alpha', f.ctx, 'schedule_task')({ agentSlug: 'beta', title: '예약', prompt: '진행', type: 'daily', time: '09:00' });
      else await runDirectives(f.ws, 'alpha', [{ action: 'schedule', crew: 'beta', title: '예약', prompt: '진행', time: '09:00' }, { action: 'approval', request: '처리' }], { mirrorCtx: f.ctx });
      const [r] = await loadRoutines(f.ws);
      assert.equal(r.msgr.crewId, 'b');
      assert.equal(r.msgr.wsId, f.ws);
      assert.equal(r.msgr.threadRoot, 10);
      assert.equal(r.msgr.handoffs, undefined);
      if (runner === 'CLI') assert.deepEqual((await loadApprovals(f.ws))[0].msgr, f.origin);
      if (runner === 'SDK') {
        const result = await sdk(f.ws, 'alpha', { ...f.ctx, sourceMsgId: 12 }, 'start_long_task')({ agentSlug: 'beta', title: '작업', prompt: '진행' });
        assert.doesNotMatch(JSON.stringify(result), /실패/);
        const dir = gateway.queueDir(f.ws, gateway.JOBS_QUEUE);
        const files = await readdir(dir);
        assert.equal(files.length, 1);
        const job = JSON.parse(await readFile(join(dir, files[0]), 'utf8'));
        assert.equal(job.msgr.crewId, 'b');
        assert.equal(job.msgr.threadRoot, 10);
        assert.equal(job.msgr.sourceMsgId, 12, 'queue preserves source separately from thread root');
      }
    } finally { f.stop(); }
  });
}

test('team work continuation from an older authorized round cannot restart after resume', async()=>{
  const f=await setup();
  try {
    const read=f.db.message;
    f.db.message=async(id)=>{const m=await read(id); return m?{...m,meta:{work_run_id:'work'}}:m;};
    f.db.workRun=async()=>({id:'work',status:'running',last_resume_message_id:15});
    const {runMessengerContinuation}=await import('../src/gateway/msgr.mjs');
    let ran=false;
    await assert.rejects(runMessengerContinuation(f.ws,'alpha',f.origin,'old follow-up',null,{session:f.session,runChat:async()=>{ran=true;return{reply:'must not run'};}}),/후속 실행을 멈춥니다/);
    assert.equal(ran,false);
  } finally {f.stop();}
});

test('scoped continuation audit survives approval, routine and job persistence without changing the normal session', async () => {
  const f = await setup();
  const { appendTurn, loadThread } = await import('../src/thread.mjs');
  const contextScope = { kind: 'msgr-dm', channelId: f.origin.channelId, threadRoot: f.origin.threadRoot };
  await appendTurn(f.ws, 'alpha', {userMsg:'normal',reply:'normal reply',sessionId:'normal-session'});
  const runChat = async () => ({reply:'private continuation',sessionId:'private-session',handover:null,contextScope});
  try {
    await approvals._followUpForTest(f.ws, {id:'scoped-ap',slug:'alpha',action:'action',msgr:f.origin},true,{runChat,session:f.session});
    const routine=await addRoutine(f.ws,{agentSlug:'alpha',title:'scoped',prompt:'continue',schedule:{type:'daily',time:'09:00'},msgr:f.origin});
    await runRoutine(f.ws,routine.id,{chatFn:runChat,session:f.session});
    await gateway._makeJobHandlerForTest(f.ws,{runChat,session:f.session})({id:'scoped-job',slug:'alpha',title:'scoped',prompt:'continue',msgr:f.origin});
    const t=await loadThread(f.ws,'alpha');
    assert.equal(t.sessionId,'normal-session');
    assert.equal(t.messages.length,8);
    assert.ok(t.messages.slice(2).every(m=>JSON.stringify(m.contextScope)===JSON.stringify(contextScope)),'all three continuation consumers preserve both sides of the audit scope');
    await assert.rejects(approvals._followUpForTest(f.ws,{id:'failed-scoped-ap',slug:'alpha',action:'private action',msgr:f.origin},true,{runChat:async()=>{throw new Error('fixture failure');},session:f.session}),/fixture failure/);
    const failed=await loadThread(f.ws,'alpha');
    assert.equal(failed.sessionId,'normal-session');
    assert.ok(failed.messages.slice(-2).every(m=>m.contextScope?.channelId===f.origin.channelId),'a failed continuation cannot leak unscoped audit text');
  } finally { f.stop(); }
});

// 2026-09-27 2차 검수(N3) — 결재 후속(runMessengerContinuation)·큐 잡 핸들러(makeMsgrHandler run())의 자격 재확인은
// 여태 어떤 테스트도 잠그지 않았다(제거해도 실패 0). 여기서 잠근다.
test('runMessengerContinuation stops before the expensive turn when the org has lost entitlement', async () => {
  const f = await setup();
  const { runMessengerContinuation } = await import('../src/gateway/msgr.mjs');
  f.db.orgEntitled = async () => false;
  let ran = false;
  try {
    await assert.rejects(runMessengerContinuation(f.ws, 'alpha', f.origin, '진행', null, { session: f.session, runChat: async () => { ran = true; return { reply: 'must not run' }; } }), /msgr_org_unentitled/);
    assert.equal(ran, false, 'entitlement is rechecked before the paid turn runs, not after');
  } finally { f.stop(); }
});

test('makeMsgrHandler run(): a queued job rechecks entitlement before running and only leaves a channel notice', async () => {
  const f = await setup();
  const { makeMsgrHandler } = await import('../src/gateway/msgr.mjs');
  f.db.orgEntitled = async () => false;
  f.db.settled = async () => false;
  const inserted = [];
  f.db.insertMessage = async (row) => { inserted.push(row); return { id: 99 }; };
  let ran = false;
  const handler = makeMsgrHandler(f.ws, { session: f.session, runChat: async () => { ran = true; return { reply: 'must not run' }; } });
  await handler({ msgId: 40, slug: 'alpha', crewId: 'a', channelId: 'channel', orgId: 'org', authorId: 'owner', threadRoot: 40, text: '작업', createdAt: new Date().toISOString() });
  assert.equal(ran, false, 'a job already sitting in the queue is not run once the org has lost entitlement');
  assert.equal(inserted.length, 1);
  assert.match(inserted[0].client_msg_id, /^unentitled:a:channel/);
  f.stop();
});

// 2026-09-27 N5(유건 결정) — 결재 승인 시 커넥터 payload 실행은 미자격 조직이면 실행하지 않고 카드에 안내만 남긴다.
// applyRoutineEdits(본체 로컬 기능 설정)는 이 게이트 대상이 아니다 — drain()의 housekeeping에서 별도로 부른다(건드리지 않음).
test('approval follow-up: an unentitled org does not run a connector payload, it leaves a note instead', async () => {
  const f = await setup();
  const approvals = await import('../src/approval-actions.mjs');
  // applyPayload's own check (the first call) sees unentitled; later calls (runMessengerContinuation's
  // separate, pre-existing re-check) see entitled so the follow-up turn still runs and we can observe
  // the outcome text — this isolates the connector-specific gate from the unrelated continuation gate,
  // which would otherwise also reject the whole follow-up turn and hide what applyPayload actually did.
  let call = 0;
  f.db.orgEntitled = async () => { call += 1; return call > 1; };
  const item = { id: 'ap-connector-1', kind: 'connector', action: 'gmail · send_mail', slug: 'alpha', payload: { serverId: 'gmail', tool: 'send_mail', args: {} }, msgr: f.origin };
  let seenText = null;
  await approvals._followUpForTest(f.ws, item, true, { session: f.session, runChat: async (_ws, _slug, text) => { seenText = text; return { reply: 'ok' }; } });
  assert.match(seenText, /무료 기간이 끝나 실행하지 않았습니다/, 'the outcome note reaches the crew turn instead of the connector actually running');
  f.stop();
});

test('approval follow-up: an entitled org still attempts the connector payload (control)', async () => {
  const f = await setup();
  const approvals = await import('../src/approval-actions.mjs');
  f.db.orgEntitled = async () => true;
  const item = { id: 'ap-connector-2', kind: 'connector', action: 'gmail · send_mail', slug: 'alpha', payload: { serverId: 'gmail', tool: 'send_mail', args: {} }, msgr: f.origin };
  let seenText = null;
  await approvals._followUpForTest(f.ws, item, true, { session: f.session, runChat: async (_ws, _slug, text) => { seenText = text; return { reply: 'ok' }; } });
  assert.doesNotMatch(seenText, /무료 기간이 끝나 실행하지 않았습니다/, 'an entitled org is not frozen by this gate (it fails later for an unrelated reason — no real gmail connector is configured in this fixture)');
  f.stop();
});

// 2026-09-27 저녁(2차 재검수, M-2) — 결재 후속(runMessengerContinuation)·큐 잡 핸들러(makeMsgrHandler run())도
// 원문 작성자의 동의 상태를 실행 직전에 다시 본다(자격 재확인 N3와 같은 두 자리).
test('runMessengerContinuation stops before the expensive turn when the source author has declined/withdrawn consent', async () => {
  const f = await setup();
  const { runMessengerContinuation } = await import('../src/gateway/msgr.mjs');
  f.db.orgConsentOk = async () => false;
  let ran = false;
  try {
    await assert.rejects(runMessengerContinuation(f.ws, 'alpha', f.origin, '진행', null, { session: f.session, runChat: async () => { ran = true; return { reply: 'must not run' }; } }), /msgr_ai_consent_declined/);
    assert.equal(ran, false, 'consent is rechecked before the paid turn runs, not after');
  } finally { f.stop(); }
});

test('makeMsgrHandler run(): a queued job rechecks the thread root author consent before running and only leaves a channel notice', async () => {
  const f = await setup();
  const { makeMsgrHandler } = await import('../src/gateway/msgr.mjs');
  f.db.crewContext = async () => ({
    delivery_role: 'to',
    channel: { id: 'channel', org_id: 'org', kind: 'private', crew_memory: false },
    source: { id: 41, channel_id: 'channel', author_kind: 'user', author_user_id: 'person', body: 'hi', reply_to: null, thread_root: null, meta: {} },
    root: { id: 41, author_kind: 'user', author_user_id: 'person' },
    peers: [], settled_source: false, settled_predecessors: [],
  });
  f.db.orgConsentOk = async () => false;
  f.db.settled = async () => false;
  const inserted = [];
  f.db.insertMessage = async (row) => { inserted.push(row); return { id: 99 }; };
  let ran = false;
  const handler = makeMsgrHandler(f.ws, { session: f.session, runChat: async () => { ran = true; return { reply: 'must not run' }; } });
  await handler({ msgId: 41, slug: 'alpha', crewId: 'a', channelId: 'channel', orgId: 'org', authorId: 'person', threadRoot: 41, text: '작업', createdAt: new Date().toISOString() });
  assert.equal(ran, false, 'a job whose thread root author has declined consent is not run');
  assert.equal(inserted.length, 1);
  assert.match(inserted[0].client_msg_id, /^aiconsent:a:channel/);
  f.stop();
});

// 2026-09-27 밤(3차 검수 M-1) — the thread root and the message actually being answered (source) can be two
// different people. A consenting root author must not mask a source author who has since declined/withdrawn.
test('makeMsgrHandler run(): a queued job also rechecks the source author consent when it differs from the thread root', async () => {
  const f = await setup();
  const { makeMsgrHandler } = await import('../src/gateway/msgr.mjs');
  f.db.crewContext = async () => ({
    delivery_role: 'to',
    channel: { id: 'channel', org_id: 'org', kind: 'private', crew_memory: false },
    source: { id: 42, channel_id: 'channel', author_kind: 'user', author_user_id: 'other-person', body: 'hi again', reply_to: 41, thread_root: 41, meta: {} },
    root: { id: 41, author_kind: 'user', author_user_id: 'person' },
    peers: [], settled_source: false, settled_predecessors: [],
  });
  f.db.orgConsentOk = async (_orgId, userId) => userId !== 'other-person'; // only the source author has declined, not the root author
  f.db.settled = async () => false;
  const inserted = [];
  f.db.insertMessage = async (row) => { inserted.push(row); return { id: 99 }; };
  let ran = false;
  const handler = makeMsgrHandler(f.ws, { session: f.session, runChat: async () => { ran = true; return { reply: 'must not run' }; } });
  await handler({ msgId: 42, slug: 'alpha', crewId: 'a', channelId: 'channel', orgId: 'org', authorId: 'other-person', threadRoot: 41, text: '작업', createdAt: new Date().toISOString() });
  assert.equal(ran, false, 'a consenting thread root author must not mask a declined source author');
  assert.equal(inserted.length, 1);
  assert.match(inserted[0].client_msg_id, /^aiconsent:a:channel/);
  f.stop();
});

// M-1(2026-09-27 저녁, 크루 쪽) — db.workRun is a raw select with no server-side filter; workPrompt must not
// leak the goal/completion criteria of a team work started by someone who has declined or withdrawn consent.
test('workPrompt hides the goal/completion criteria when the person who started the team work has declined consent', async () => {
  const f = await setup();
  const { runMessengerContinuation } = await import('../src/gateway/msgr.mjs');
  const originalMessage = f.db.message;
  f.db.message = async (id) => id === 10 ? { ...(await originalMessage(id)), meta: { work_run_id: 'work-1' } } : originalMessage(id);
  f.db.workRun = async () => ({ id: 'work-1', status: 'running', created_by: 'work-creator', org_id: 'org', lead_crew_id: 'a', goal: '민감한 목표 텍스트', completion_criteria: '완료 기준' });
  // Isolate M-1 from M-2: the continuation's own source author ('person', f.origin's default) stays
  // consented so the unrelated M-2 gate does not fire first — only the work's creator has declined.
  f.db.orgConsentOk = async (_orgId, userId) => userId !== 'work-creator';
  let seenText = null;
  const turn = await runMessengerContinuation(f.ws, 'alpha', f.origin, '진행', null, { session: f.session, runChat: async (_ws, _slug, text) => { seenText = text; return { reply: 'ok' }; } });
  assert.ok(turn);
  assert.doesNotMatch(seenText, /민감한 목표 텍스트/, 'the goal text must not reach the crew prompt when its author has declined consent');
  assert.match(seenText, /\(원문 비공개/, 'a placeholder replaces the hidden goal');
  f.stop();
});

// 메신저에서 시작된 루프 — 채널 글은 넘김 줄을 붙이기 **전** 본문에서 표지를 뺀다(뒤에 넘김 줄이 붙으면 표지가 마지막 줄이 아니게 된다).
// 판정은 원문(replyForChecks)으로 — 표지를 뺀 글로 판정하면 매 회차 '표지 누락'이 쌓여 3회째 멈춘다.
test('a Messenger-started loop posts its result without the LOOP marker even with handoff lines, while the verdict still counts', async () => {
  const f = await setup();
  try {
    const loop = await addRoutine(f.ws, { agentSlug: 'alpha', title: '계속', prompt: '이어서', schedule: { type: 'interval', everyMinutes: 10 }, loop: {}, msgr: f.origin });
    const out = await runRoutine(f.ws, loop.id, { session: f.session, chatFn: async (...args) => ({
      ...(await f.runChat('SDK')(...args)), reply: '1단계 정리 끝\nLOOP: continue',
    }) });
    assert.equal(out.stopped, null);
    const cur = (await loadRoutines(f.ws)).find((r) => r.id === loop.id);
    assert.equal(cur.loop.lastVerdict, 'continue');
    assert.equal(cur.loop.missingVerdicts, 0);
    const event = f.events.find((e) => e.type === 'routine' && e.reply?.includes('1단계 정리 끝'));
    assert.ok(event);
    assert.ok(event.msgrReply.mentions.some((m) => m.id === 'b'), 'handoff line is still attached');
    assert.doesNotMatch(event.reply, /LOOP/);
    await msgrPush(event, { session: f.session });
    const row = f.rows.find((x) => x.body?.includes('1단계 정리 끝'));
    assert.ok(row);
    assert.doesNotMatch(row.body, /LOOP/);
  } finally { f.stop(); }
});

// 5차 검수 LOW-3 — 메신저 결재를 주인이 아닌 조직 관리자가 확정해도 후속 줄이 actor 없이 '(사장 결재)'로 남아 스레드 맥락·요약에 사용자 결정(captain)으로 실렸다.
// 확정한 사람(resolvedBy — syncApprovals가 msgr 행의 decided_by로 남긴다)을 후속 줄 actor로 싣고, 주인이 아니면 '(관리자 결재)' 머리말로 → member.
test('approval follow-up: 메신저에서 확정한 사람이 주인이 아니면 후속 줄은 member(관리자 결재), 주인이면 captain(사용자 결재 — 옛 "사장 결재"), 메신저 밖 확정은 종전대로', async () => {
  const f = await setup({ requester: 'owner' });
  const { updateCompany } = await import('../src/workspace.mjs');
  const { loadThread } = await import('../src/thread.mjs');
  const { threadCtxLine } = await import('../src/chat.mjs');
  await updateCompany(f.ws, { ownerId: 'owner' });
  const runChat = async () => ({ reply: 'ok', sessionId: null, handover: null });
  const last = async () => (await loadThread(f.ws, 'alpha')).messages.filter((m) => m.who === 'user').at(-1);
  try {
    for (const [by, tag, who] of [['admin-uid', '(관리자 결재)', 'member'], ['owner', '(사용자 결재)', 'captain']]) {
      await approvals._followUpForTest(f.ws, { id: `ap-${by}`, slug: 'alpha', kind: 'action', action: '거래처 송금', msgr: f.origin, resolvedBy: { uid: by, via: 'msgr', at: '2026-10-05T00:00:00Z' } }, true, { runChat, session: f.session });
      const m = await last();
      assert.ok(m.text.startsWith(`${tag} `), `${by}: 머리말 ${tag}`);
      assert.deepEqual(m.actor, { uid: by, relay: false }, `${by}: 확정한 사람이 후속 줄에 남는다`);
      assert.equal(JSON.parse(threadCtxLine(m, 'ko', '알파', { ownerId: 'owner' }))[0], who, `${by}: 맥락 항목 ${who}`);
    }
    await approvals._followUpForTest(f.ws, { id: 'ap-web', slug: 'alpha', kind: 'action', action: '보고서 발송' }, true, { runChat });
    const m = await last();
    assert.ok(m.text.startsWith('(사용자 결재) ') && !m.actor, '메신저 밖(웹·텔레그램 — 주인만 확정) 확정은 종전대로');
    assert.equal(JSON.parse(threadCtxLine(m, 'ko', '알파', { ownerId: 'owner' }))[0], 'captain');
  } finally { f.stop(); }
});

// 6차 검수 LOW-B(M21) — 후속 턴이 실패해 남기는 '(후속 실행 실패: …)' 줄도 확정한 사람을 actor로 싣는다. 빠지면 관리자 확정이 실패 줄에서 captain으로 실린다.
test('approval follow-up: 후속 실행이 실패해도 실패 줄에 확정한 사람(actor)이 남는다 — 관리자 확정은 member, 주인 확정은 captain', async () => {
  const f = await setup({ requester: 'owner' });
  const { updateCompany } = await import('../src/workspace.mjs');
  const { loadThread } = await import('../src/thread.mjs');
  const { threadCtxLine } = await import('../src/chat.mjs');
  await updateCompany(f.ws, { ownerId: 'owner' });
  const runChat = async () => { throw new Error('모델 장애'); };
  try {
    for (const [by, who] of [['admin-uid', 'member'], ['owner', 'captain']]) {
      await assert.rejects(approvals._followUpForTest(f.ws, { id: `ap-fail-${by}`, slug: 'alpha', kind: 'action', action: '거래처 송금', msgr: f.origin, resolvedBy: { uid: by, via: 'msgr', at: '2026-10-05T00:00:00Z' } }, true, { runChat, session: f.session }), /모델 장애/);
      const turn = (await loadThread(f.ws, 'alpha')).messages.slice(-2);
      assert.match(turn[1]?.text ?? '', /후속 실행 실패: 모델 장애/, `${by}: 실패 줄이 남는다 — 재현 조건`);
      assert.deepEqual(turn[0].actor, { uid: by, relay: false }, `${by}: 실패 줄에도 확정한 사람`);
      assert.equal(JSON.parse(threadCtxLine(turn[0], 'ko', '알파', { ownerId: 'owner' }))[0], who, `${by}: 맥락 항목 ${who}`);
    }
  } finally { f.stop(); }
});

// 루틴 표시(fix/routine-failure-visible) — 메신저발 루틴도 데스크톱 루틴과 같은 규칙: 보고할 것이 없으면(NO_REPORT) 채널 글 0,
// 실패는 대화 기록에 그 채널 범위(contextScope)로 남아 주인 1:1 맥락에 섞이지 않는다.
test('messenger routine: NO_REPORT 답이면 채널 글(알림 이벤트)을 만들지 않고 성공으로 기록한다', async () => {
  const f = await setup({ requester: 'owner' });
  try {
    const r = await addRoutine(f.ws, { agentSlug: 'alpha', title: '메일 보고', prompt: '새 메일을 보고하라', schedule: { type: 'daily', time: '09:00' }, msgr: f.origin });
    const seen = [];
    const out = await runRoutine(f.ws, r.id, { session: f.session, chatFn: async (_ws, _slug, msg, _sid, opts) => { seen.push({ msg, note: opts?.runnerNote ?? '' }); return { reply: 'NO_REPORT', sessionId: null, handover: null }; } });
    await new Promise((res) => setTimeout(res, 20));
    assert.equal(out.ok, true);
    assert.match(seen[0].note, /\[보고 규칙\]/, '메신저 후속 실행에도 보고 규칙이 러너 프롬프트로 간다');
    assert.doesNotMatch(seen[0].msg, /보고 규칙|NO_REPORT/, '채널 후속 실행 글(턴 이벤트 원문)에는 규칙을 섞지 않는다');
    assert.equal(f.events.filter((e) => e.type === 'routine').length, 0, '보고할 것이 없으면 채널에 글을 올리지 않는다');
    const saved = (await loadRoutines(f.ws)).find((x) => x.id === r.id);
    assert.equal(saved.lastOk, true); assert.equal(saved.lastResult, '보고할 내용 없음');
  } finally { f.stop(); }
});

test('messenger routine: 실패는 대화 기록에 그 채널 범위로 남는다(채널 실패 글 1건은 종전대로)', async () => {
  const f = await setup({ requester: 'owner' });
  const { loadThread, inContextScope } = await import('../src/thread.mjs');
  try {
    const r = await addRoutine(f.ws, { agentSlug: 'alpha', title: '메일 보고', prompt: '새 메일을 보고하라', schedule: { type: 'daily', time: '09:00' }, msgr: f.origin });
    await assert.rejects(runRoutine(f.ws, r.id, { session: f.session, chatFn: async () => { throw new Error('모델 장애'); } }), /모델 장애/);
    await new Promise((res) => setTimeout(res, 20));
    const msgs = (await loadThread(f.ws, 'alpha')).messages.slice(-2);
    assert.equal(msgs[0].text, '[루틴: 메일 보고] 새 메일을 보고하라');
    assert.match(msgs[1].text, /루틴 실행에 실패했습니다 — 모델 장애/);
    for (const m of msgs) {
      assert.deepEqual(m.contextScope, { kind: 'msgr', channelId: 'channel', threadRoot: 10 }, '그 채널 범위');
      assert.equal(inContextScope(m, null), false, '주인 1:1(범위 없음) 맥락에는 실리지 않는다');
    }
    assert.equal(f.events.filter((e) => e.type === 'routine' && e.ok === false).length, 1);
  } finally { f.stop(); }
});

test('messenger routine: 실행 없이 여러 날 놓친 회차는 날마다 다른 채널 글로 간다(중복 방지 키가 놓친 날을 담는다)', async () => {
  const f = await setup({ requester: 'owner' });
  const { recordMissedSlots } = await import('../src/routines.mjs');
  const { writeJsonAtomic } = await import('../src/jsonstore.mjs');
  try {
    const r = await addRoutine(f.ws, { agentSlug: 'alpha', title: '아침 보고', prompt: '보고하라', schedule: { type: 'daily', times: ['09:00'], tz: 'Asia/Seoul' }, msgr: f.origin });
    const raw = await loadRoutines(f.ws);
    Object.assign(raw.find((x) => x.id === r.id), { lastRun: '2026-10-06T00:00:00.000Z', created: '2026-09-01T00:00:00.000Z', editedAt: '2026-09-01T00:00:00.000Z' });
    await writeJsonAtomic(paths(f.ws).routines, raw);
    await recordMissedSlots(f.ws, await loadRoutines(f.ws), new Date('2026-10-07T06:00:00Z')); // 10/7 09:00 KST 놓침
    await recordMissedSlots(f.ws, await loadRoutines(f.ws), new Date('2026-10-08T06:00:00Z')); // 10/8 09:00 KST 놓침(그 사이 실행 없음)
    await new Promise((res) => setTimeout(res, 20));
    const skips = f.events.filter((e) => e.type === 'routine' && e.phase === 'skipped');
    assert.equal(skips.length, 2, '놓친 날마다 한 번');
    for (const e of skips) assert.equal(await msgrPush(e, { session: f.session }), true);
    assert.equal(f.rows.length, 2);
    assert.equal(new Set(f.rows.map((row) => row.client_msg_id)).size, 2, '두 번째 건너뜀 글이 첫 글과 같은 키로 버려지지 않는다');
    assert.match(f.rows[0].body, /10월 7일 09:00/); assert.match(f.rows[1].body, /10월 8일 09:00/);
    // 시작 채널(origin) 글은 머리 없이 본문만 — '(실패)' 꼬리가 붙지 않는다. 알림 채널 글의 머리 '(건너뜀)'은 routine-notifications.test.mjs가 잠근다.
    for (const row of f.rows) assert.doesNotMatch(row.body, /\(실패\)|실패했습니다/);
  } finally { f.stop(); }
});

// 검수 LOW(b) — 메신저발 루프 회차 답이 판정 줄뿐이면 채널 글 본문(reply)은 비지만 판정 원문(replyForChecks)이 있다. 빈 답 실패로 세지 않는다.
test('messenger loop: 답이 LOOP 판정 줄뿐이면 빈 답 실패가 아니다 — 알림 0, 판정 continue', async () => {
  const f = await setup({ requester: 'owner' });
  try {
    const loop = await addRoutine(f.ws, { agentSlug: 'alpha', title: '계속', prompt: '이어서', schedule: { type: 'interval', everyMinutes: 10 }, loop: {}, msgr: f.origin });
    const out = await runRoutine(f.ws, loop.id, { session: f.session, chatFn: async () => ({ reply: 'LOOP: continue', sessionId: null, handover: null }) });
    await new Promise((res) => setTimeout(res, 20));
    assert.equal(out.ok, true);
    const cur = (await loadRoutines(f.ws)).find((r) => r.id === loop.id);
    assert.equal(cur.lastOk, true);
    assert.equal(cur.loop.lastVerdict, 'continue');
    assert.equal(cur.loop.missingVerdicts, 0);
    assert.equal(f.events.filter((e) => e.type === 'routine').length, 0, '판정 줄뿐인 회차는 채널에 제목만 있는 글을 올리지 않는다');
  } finally { f.stop(); }
});

// ── 개인 공간 crew 1:1 이어 실행(2026-10-08 PR-C, 계획 rc-0195 personal-crew-room-features-plan.md 5-3 #4·#5) ──
// 결재 후속·예약·긴 작업이 같은 이어 실행(restoreMessengerContext)을 지난다. 개인 기록(orgId null + ownCrewRoom 표지)은 서버 봉투가 있고, 방이 조직 없는 방이며,
// 서버가 지금도 주인과 이 에이전트만 있는 crew 1:1이라고 판정할 때만 잇는다(저장된 표지는 믿지 않는다). 동의는 drain과 같은 방 기준으로 다시 본다.
async function setupPersonal() {
  const ws = `continuation-p-${++n}`;
  await createCompany(ws, '검수', 'alpha');
  await mkdir(paths(ws).agents, { recursive: true });
  for (const [slug, name] of [['alpha', '알파'], ['beta', '베타']]) await writeFile(join(paths(ws).agents, `${slug}.md`), `---\nname: ${name}\nslug: ${slug}\n---\n`);
  const self = { id: 'a', slug: 'alpha', display_name: '알파', owner_user_id: 'owner', ws_id: ws };
  const origin = { orgId: null, ownCrewRoom: true, channelId: 'pch', channelKind: 'dm', crewId: 'a', threadRoot: 10, sourceMsgId: 10, uid: 'owner', wsId: ws, origin: 'owner', hop: 0 };
  const state = { own: true, consent: true, archived: false, crewGone: false };
  const source = { id: 10, channel_id: 'pch', author_kind: 'user', author_user_id: 'owner', body: '개인 방에서 계속', reply_to: null, thread_root: null, meta: {} };
  const rows = []; const seen = []; const events = []; const calls = [];
  const db = {
    crewBySlug: async (uid, wsId, slug, orgId) => { calls.push(['crewBySlug', orgId]); return !state.crewGone && uid === 'owner' && wsId === ws && slug === 'alpha' && orgId === null ? { ...self, org_id: null } : null; },
    crewContext: async (_ws, _crew, sourceId, channelId) => { calls.push(['crewContext', sourceId, channelId]); return { delivery_role: 'to', actor: 'owner', org: null, peers: [self], root: source, source, attachments: [],
      channel: { id: channelId, org_id: null, kind: 'dm', name: 'dm', crew_memory: true, archived_at: state.archived ? '2026-10-08T00:00:00Z' : null, excluded_crew_ids: [] },
      context: [{ id: 9, author_kind: 'crew', crew_id: 'a', body: '이전 결과' }], settled_source: true, settled_predecessors: [] }; },
    ownCrewRoom: async (ch, crew) => { calls.push(['ownCrewRoom', ch, crew]); return state.own; },
    personalConsentOk: async (ch, u) => { calls.push(['personalConsentOk', ch, u]); return state.consent; },
    orgConsentOk: async () => { calls.push(['orgConsentOk']); return true; },
    orgEntitled: async () => { calls.push(['orgEntitled']); return true; },
    insertMessage: async (row) => { rows.push(row); return { id: 20 + rows.length }; },
  };
  const session = async () => ({ uid: 'owner', db });
  const stop = onNotify((e) => { if (e.wsId === ws) events.push(e); });
  // 이어 실행 턴 안에서도 개인 기능이 열려 있는지 — SDK는 schedule_task, CLI는 지시 블록으로 자기 예약을 건다(기록이 같은 방이어야 한다)
  const runChat = (runner) => async (_ws, slug, msg, _sid, opts) => {
    seen.push(opts);
    assert.equal(opts.mirrorCtx.orgId, null); assert.equal(opts.mirrorCtx.ownCrewRoom, true); assert.equal(opts.mirrorCtx.channelId, 'pch');
    assert.match(msg, /이전 결과/);
    if (runner === 'SDK') assert.match(JSON.stringify(await sdk(ws, slug, opts.mirrorCtx, 'schedule_task')({ title: '후속 예약', prompt: '확인', type: 'daily', time: '09:00' })), /예약 완료/);
    else await runDirectives(ws, slug, [{ action: 'schedule', prompt: '확인', time: '09:00' }], { mirrorCtx: opts.mirrorCtx });
    return { reply: '개인 결과', sessionId: null, handover: null };
  };
  return { ws, origin, state, db, session, rows, seen, events, calls, stop, runChat };
}
const count = (f, k) => f.calls.filter((c) => c[0] === k).length;
async function assertPersonalDelivered(f, type) {
  await Promise.resolve();
  const event = f.events.find((e) => e.type === type);
  assert.ok(event, `${type} 이벤트`);
  assert.equal(await msgrPush(event, { session: f.session }), true);
  assert.equal(f.rows.length, 1);
  assert.deepEqual([f.rows[0].channel_id, f.rows[0].crew_id, f.rows[0].reply_to, f.rows[0].thread_root], ['pch', 'a', 10, 10], '결과는 같은 개인 1:1의 원래 글에');
  assert.equal(f.rows[0].meta.origin, 'owner');
  assert.match(f.rows[0].body, /개인 결과/);
  assert.equal(count(f, 'ownCrewRoom'), 2, '서버 판정은 이어 실행 1 + 결과 게시 1(저장된 표지를 믿지 않는다)');
  assert.equal(count(f, 'personalConsentOk'), 1, '동의 재확인은 이어 실행 직전 1회');
  assert.equal(count(f, 'orgConsentOk') + count(f, 'orgEntitled'), 0, '개인 방에 조직 판정을 부르지 않는다');
  const [r] = (await loadRoutines(f.ws)).filter((x) => x.title === '후속 예약' || x.prompt === '확인');
  assert.deepEqual([r.msgr.orgId, r.msgr.channelId, r.msgr.ownCrewRoom], [null, 'pch', true], '이어 실행 턴 안의 예약도 같은 개인 방 기록');
}
for (const runner of ['SDK', 'CLI']) {
  test(`${runner}: 개인 crew 1:1 결재 후속이 같은 방에서 이어 실행되고 결과가 같은 방에 올라간다`, async () => {
    const f = await setupPersonal();
    try {
      await approvals._followUpForTest(f.ws, { id: 'ap-p', slug: 'alpha', kind: 'action', action: '보고서 발송', msgr: f.origin }, true, { runChat: f.runChat(runner), session: f.session });
      await assertPersonalDelivered(f, 'approval_followup');
    } finally { f.stop(); }
  });
  test(`${runner}: 개인 crew 1:1 예약 실행(daily) — 같은 방에서 이어 실행, 결과도 같은 방`, async () => {
    const f = await setupPersonal();
    try {
      const r = await addRoutine(f.ws, { agentSlug: 'alpha', title: '개인 예약', prompt: '이어하기', schedule: { type: 'daily', time: '09:00' }, msgr: f.origin });
      assert.deepEqual([r.msgr.orgId, r.msgr.ownCrewRoom], [null, true], '저장 때 messengerOrigin 재확인을 통과');
      await runRoutine(f.ws, r.id, { chatFn: f.runChat(runner), session: f.session });
      await assertPersonalDelivered(f, 'routine');
    } finally { f.stop(); }
  });
  test(`${runner}: 개인 crew 1:1 긴 작업 — 같은 방에서 이어 실행, 결과도 같은 방`, async () => {
    const f = await setupPersonal();
    try {
      await gateway._makeJobHandlerForTest(f.ws, { runChat: f.runChat(runner), session: f.session })({ id: 'job-p', slug: 'alpha', title: '개인 작업', prompt: '이어하기', msgr: f.origin });
      await assertPersonalDelivered(f, 'job');
    } finally { f.stop(); }
  });
}

// 1차 검수 MEDIUM(PR #864) — 메신저 밖 턴(데스크톱·텔레그램·회의실·msgr 없는 루틴)이 같은 에이전트의 crew 1:1 턴과 동시에 돌다 결재를 올리면, 항목에 msgr가 없어
// 실행 중 문맥(activeCtx)으로 목적지를 찾는다. 카드는 개인 결재 RPC로 들어가는데 저장되는 기록에 개인 표지가 빠지면 승인 뒤 이어 실행이 '소유자·회사 불일치'로 멈춘다(배포본은 RLS로 미러 실패 → 데스크톱 후속).
for (const runner of ['SDK', 'CLI']) {
  test(`${runner}: 메신저 밖 턴의 결재 · crew 1:1 턴 실행 중(activeCtx) — 저장 기록에 개인 표지가 남고, 승인하면 같은 방에서 이어 실행된다`, async () => {
    const f = await setupPersonal();
    const key = `${f.ws}:alpha`;
    Object.assign(f.db, {
      createPersonalApproval: async (row) => { f.calls.push(['createPersonalApproval', row]); return { id: 'ap-row' }; },
      insertApproval: async () => { f.calls.push(['insertApproval']); throw new Error('rls'); },
      updateApproval: async (id) => [{ id }],
      canDecide: async () => true,
    });
    try {
      const item = await addApproval(f.ws, { slug: 'alpha', action: '보고서 발송', reason: '마감' }); // 메신저 밖 턴 — 항목에 msgr 없음
      assert.equal(item.msgr, undefined);
      _activeCtxForTest.set(key, { ...f.origin, kind: 'msgr', peers: [], handoffs: [], lang: 'ko' }); // crew 1:1 메신저 턴(run()이 서버 판정 true를 문맥에 남김)
      try { assert.equal(await msgrPush({ type: 'approval', wsId: f.ws, item }, { session: f.session }), true); } finally { _activeCtxForTest.delete(key); }
      assert.equal(count(f, 'createPersonalApproval'), 1); assert.equal(count(f, 'insertApproval'), 0);
      const saved = (await loadApprovals(f.ws)).find((a) => a.id === item.id);
      assert.deepEqual([saved.msgr.rowId, saved.msgr.orgId, saved.msgr.channelId, saved.msgr.ownCrewRoom], ['ap-row', null, 'pch', true], '개인 표지가 저장 기록에 남는다(운반용 — 이어 실행이 서버 판정을 다시 한다)');
      f.rows.length = 0; f.calls.length = 0;
      await approvals._followUpForTest(f.ws, { ...saved, status: 'approved' }, true, { runChat: f.runChat(runner), session: f.session });
      assert.equal(f.seen.length, 1, '승인한 일이 같은 방에서 한 번 실행된다');
      assert.equal(count(f, 'ownCrewRoom'), 1, '이어 실행은 저장된 표지를 믿지 않고 서버 판정을 다시 한다');
      await assertPersonalDelivered(f, 'approval_followup');
    } finally { f.stop(); }
  });
}

test('개인 이어 실행 — 방이 바뀌었거나(서버 판정 false)·판정을 모르거나(옛 서버·옛 어댑터)·봉투가 없거나·보관·에이전트 삭제·동의 철회면 실행하지 않는다(경우 15·16)', async () => {
  const { runMessengerContinuation } = await import('../src/gateway/msgr.mjs');
  const cases = [
    ['서버 판정 false(친구가 들어옴·다른 에이전트가 들어옴)', (f) => { f.state.own = false; }, /개인 1:1로 확인되지 않아/],
    ['판정 모름(옛 서버 PGRST202 → null)', (f) => { f.state.own = null; }, /개인 1:1로 확인되지 않아/],
    ['옛 db 어댑터(판정 함수 없음)', (f) => { delete f.db.ownCrewRoom; }, /개인 1:1로 확인되지 않아/],
    ['봉투 없음(옛 서버 경로)', (f) => { delete f.db.crewContext; }, /실행 권한이 없습니다/],
    ['방 보관', (f) => { f.state.archived = true; }, /보관된/],
    ['에이전트 삭제', (f) => { f.state.crewGone = true; }, /실행 권한이 없습니다/], // 행이 없으면 봉투를 묻지 않는다 — 조직 경로와 같은 문구
    ['동의 철회', (f) => { f.state.consent = false; }, /msgr_ai_consent_declined/],
    ['표지 없는 개인 기록', (f) => { delete f.origin.ownCrewRoom; }, /소유자·회사 불일치/],
    // 이어 실행의 조직 일치 검사(계획 5-3 #4 'ch.org_id가 NULL이어야') — 서버 판정이 true여도 봉투의 채널·에이전트 행이 조직 것이면 잇지 않는다(PR-C 2차 검수 LOW)
    ['봉투 채널이 조직 채널(서버 판정 true)', (f) => { const orig = f.db.crewContext; f.db.crewContext = async (...a) => { const e = await orig(...a); return { ...e, channel: { ...e.channel, org_id: 'org-x' } }; }; }, /확인할 수 없습니다/],
    ['에이전트 행이 조직 행(서버 판정 true)', (f) => { const orig = f.db.crewBySlug; f.db.crewBySlug = async (...a) => { const c = await orig(...a); return c && { ...c, org_id: 'org-x' }; }; }, /확인할 수 없습니다/],
  ];
  for (const [label, change, re] of cases) {
    const f = await setupPersonal();
    let ran = false;
    try {
      change(f);
      await assert.rejects(runMessengerContinuation(f.ws, 'alpha', f.origin, '진행', null, { session: f.session, runChat: async () => { ran = true; return { reply: 'must not run' }; } }), re, label);
      assert.equal(ran, false, `${label}: 유료 턴 0(LLM 호출 없음)`);
      assert.equal(f.rows.length, 0, `${label}: 방에 글 0`);
    } finally { f.stop(); }
  }
});

test('핀: 조직 이어 실행(결재 후속)은 개인 판정 RPC·개인 동의 함수를 부르지 않는다', async () => {
  const f = await setup({ requester: 'owner' });
  const spied = [];
  f.db.ownCrewRoom = async () => { spied.push('ownCrewRoom'); return true; };
  f.db.personalConsentOk = async () => { spied.push('personalConsentOk'); return true; };
  try {
    await approvals._followUpForTest(f.ws, { id: 'ap-org-pin', slug: 'alpha', kind: 'action', action: '처리', msgr: f.origin }, true, { runChat: async () => ({ reply: '조직 결과', sessionId: null, handover: null }), session: f.session });
    const event = f.events.find((e) => e.type === 'approval_followup');
    assert.equal(await msgrPush(event, { session: f.session }), true);
    assert.equal(f.rows[0].channel_id, 'channel');
    assert.deepEqual(spied, []);
  } finally { f.stop(); }
});
