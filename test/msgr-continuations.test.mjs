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
const { loadApprovals } = await import('../src/approvals.mjs');
const approvals = await import('../src/approval-actions.mjs');
const gateway = await import('../src/gateway.mjs');
const { msgrPush } = await import('../src/gateway/msgr.mjs');
const { onNotify } = await import('../src/notify.mjs');
let n = 0;
async function setup() {
  const ws = `continuation-${++n}`;
  await createCompany(ws, '검수', 'alpha');
  await mkdir(paths(ws).agents, { recursive: true });
  const peers = [
    { id: 'a', slug: 'alpha', display_name: '알파', owner_user_id: 'owner', ws_id: ws },
    { id: 'b', slug: 'beta', display_name: '베타', owner_user_id: 'owner', ws_id: ws },
  ];
  for (const p of peers) await writeFile(join(paths(ws).agents, `${p.slug}.md`), `---\nname: ${p.display_name}\nslug: ${p.slug}\n---\n`);
  const origin = { orgId: 'org', channelId: 'channel', crewId: 'a', threadRoot: 10, sourceMsgId: 10, uid: 'owner', wsId: ws, origin: 'person', hop: 2 };
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
    message: async (id) => id === 10 ? { id, channel_id: 'channel', author_kind: 'user', author_user_id: 'person', body: '같은 방에서 계속' } : null,
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
    assert.deepEqual(opts.journal, { off: true, tag: 'org-org' });
    assert.match(msg, /이전 결과/);
    assert.deepEqual(opts.mirrorCtx.handoffs, [], 'each continuation starts a fresh handoff collector');
    const to = slug === 'alpha' ? 'beta' : 'alpha';
    if (runner === 'SDK') await sdk(ws, slug, opts.mirrorCtx, 'send_to_crew')({ to, message: '이어 할 일' });
    else await runDirectives(ws, slug, [{ action: 'mail', to, message: '이어 할 일' }], { mirrorCtx: opts.mirrorCtx });
    return { reply: '결과', sessionId: null, handover: null };
  };
  return { ws, peers, origin, ctx, db, session, rows, seen, events, stop, runChat };
}

test('verify retries rebuild the collector and blocked loops keep both the decision and result in the same thread', async () => {
  const f = await setup();
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
  const f = await setup();
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
  assert.equal(f.rows[0].meta.origin, 'person');
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
  test(`${runner}: schedule tools persist the selected crew identity and CLI approvals retain origin`, async () => {
    const f = await setup();
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
