import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from './helpers/tmp.mjs';
process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-routine-alerts-'));
const { createCompany, updateCompany, paths } = await import('../src/workspace.mjs');
const { updateConnection, updateAgentBot } = await import('../src/connections.mjs');
const { normalizeRoutineNotifications, routineNotificationOptions, messengerNotificationChannels } = await import('../src/routine-notifications.mjs');
const { addRoutine, updateRoutine, runRoutine, loadRoutines, recordRoutineNotificationDelivery } = await import('../src/routines.mjs');
const { sendRoutineNotification, _pushEventForTest } = await import('../src/gateway.mjs');
const { msgrPush } = await import('../src/gateway/msgr.mjs');
const ORG = '10000000-0000-4000-8000-000000000001';
const CH = '20000000-0000-4000-8000-000000000001';
const CREW = '30000000-0000-4000-8000-000000000001';
const selected = (channels = ['telegram', 'slack', 'msgr']) => ({ channels, msgr: { orgId: ORG, channelId: CH } });
let index = 0;
async function workspace() {
  const ws = `notification-test-${++index}`;
  await createCompany(ws, 'Notification test', 'pepper', 'fixture-owner'); // 소유자 = 세션 계정(소유자 미기록 회사는 배달하지 않는다 — 2026-09-17)
  await mkdir(join(paths(ws).root, 'agents'), { recursive: true });
  await writeFile(join(paths(ws).root, 'agents', 'pepper.md'), '---\nname: Pepper\n---\n');
  await updateCompany(ws, { msgr: { enabled: true } });
  await updateConnection(ws, 'telegram', { token: `test-token-${index}`, enabled: true });
  await updateConnection(ws, 'telegram', { chatId: 'fixture-chat' });
  await updateConnection(ws, 'slack', { token: 'fixture-slack', channel: 'fixture-channel', enabled: true });
  return ws;
}
function messenger({ expired = false, archived = false, scope = true, removed = false, deleted = false } = {}) {
  const sent = [];
  const membership = { org_id: ORG, expires_at: expired ? '2000-01-01T00:00:00Z' : null, msgr_orgs: { id: ORG, name: 'Fixture org', deleted_at: deleted ? '2020' : null } };
  const channel = { id: CH, org_id: ORG, kind: 'private', name: 'Alerts', archived_at: archived ? '2020' : null };
  const client = { from(table) {
    let data = table === 'msgr_org_members' ? [membership] : [channel];
    return { select() { return this; }, eq() { return this; }, in() { return this; },
      is(field) { if ((field === 'removed_at' && removed) || (field === 'archived_at' && archived)) data = []; return this; },
      then(ok) { return Promise.resolve({ data, error: null }).then(ok); } };
  } };
  const crew = { id: CREW, slug: 'pepper', org_id: ORG };
  const db = { myCrews: async () => [crew], crewScope: async () => new Set(scope ? [CH] : []),
    crewBySlug: async () => crew, insertMessage: async (row) => { sent.push(row); return { id: sent.length }; } };
  return { sent, session: async () => ({ client, db, uid: 'fixture-owner' }) };
}
async function capture(fn, response = () => new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }))) {
  const before = globalThis.fetch; const calls = [];
  globalThis.fetch = async (url, opts) => { calls.push({ url: String(url), body: JSON.parse(opts.body) }); return response(); };
  try { return { value: await fn(), calls }; } finally { globalThis.fetch = before; }
}
const event = (wsId, notifications = selected()) => ({ type: 'routine', wsId, routine: { id: 'r1', title: 'Morning', agentSlug: 'pepper', lastRun: '2026-09-13T00:00:00Z', notifications }, ok: true, reply: 'Today schedule' });

test('selection distinguishes legacy, explicit off, deduplicated kinds and rejects malformed destinations', () => {
  assert.equal(normalizeRoutineNotifications(undefined), undefined);
  assert.deepEqual(normalizeRoutineNotifications({ channels: [] }), { channels: [] });
  assert.deepEqual(normalizeRoutineNotifications({ channels: ['slack', 'telegram', 'slack'], token: 'ignored' }), { channels: ['telegram', 'slack'] });
  for (const input of [null, {}, { channels: ['email'] }, { channels: ['msgr'] }]) assert.throws(() => normalizeRoutineNotifications(input));
});

test('persist notification selection without turning an ordinary routine into messenger continuation', async () => {
  const ws = await workspace();
  const routine = await addRoutine(ws, { title: 'Schedule', prompt: 'Check schedule', agentSlug: 'pepper', schedule: { type: 'daily', time: '09:00' }, notifications: { channels: ['telegram'] } });
  assert.equal(routine.msgr, undefined);
  let options;
  await runRoutine(ws, routine.id, { chatFn: async (_ws, _slug, _message, _id, opts) => { options = opts; return { reply: 'Ready' }; } });
  assert.equal(options.source, 'routine');
  await updateRoutine(ws, routine.id, { notifications: { channels: [] } });
  assert.deepEqual((await loadRoutines(ws))[0].notifications, { channels: [] });
  await updateConnection(ws, 'telegram', { mutedEvents: ['routine'] });
  await assert.rejects(updateRoutine(ws, routine.id, { notifications: { channels: ['telegram'] } }), /unavailable/);
});

test('available destinations enforce active membership, organization, channel and crew scope', async () => {
  const ws = await workspace();
  assert.equal((await messengerNotificationChannels(ws, 'pepper', messenger())).length, 1);
  for (const flags of [{ expired: true }, { archived: true }, { scope: false }, { removed: true }, { deleted: true }]) {
    assert.deepEqual(await messengerNotificationChannels(ws, 'pepper', messenger(flags)), []);
  }
  const options = await routineNotificationOptions(ws, 'pepper', messenger());
  assert.deepEqual(options.channels.map((r) => r.ready), [true, true, true]);
  assert.equal(JSON.stringify(options).includes('test-token'), false);
  assert.equal(options.messengerChannels[0].orgName, 'Fixture org');
});

test('three explicit destinations fan out once; an omitted destination receives nothing', async () => {
  const ws = await workspace(); let msgr = 0;
  const got = await capture(() => _pushEventForTest(event(ws), { pushMsgr: async () => { msgr++; return true; } }));
  assert.deepEqual(got.value.map((r) => r.status), ['sent', 'sent', 'sent']);
  assert.equal(got.calls.length, 2); assert.equal(msgr, 1);
  const none = await capture(() => _pushEventForTest(event(ws, { channels: [] }), { pushMsgr: async () => { throw new Error('must not send'); } }));
  assert.deepEqual(none.calls, []);
  assert.equal((await sendRoutineNotification(event(ws, { channels: ['slack'] }), 'telegram')).status, 'not_selected');
});

test('original messenger result remains with alerts off and same-channel selection is not duplicated', async () => {
  const ws = await workspace(); const calls = [];
  const pushMsgr = async (e) => { calls.push(e); return true; };
  const e = { ...event(ws), msgr: { orgId: ORG, channelId: CH } };
  const got = await capture(() => _pushEventForTest(e, { pushMsgr }));
  assert.equal(calls.length, 1); assert.equal(calls[0].routine.notifications, undefined);
  assert.equal(got.calls.length, 2);
  calls.length = 0;
  await _pushEventForTest({ ...e, routine: { ...e.routine, notifications: { channels: [] } } }, { pushMsgr });
  assert.equal(calls.length, 1);
});

test('selected messenger alert is final, mention-free and phase-idempotent; scope loss blocks it', async () => {
  const ws = await workspace(); const fixture = messenger();
  const e = event(ws, selected(['msgr']));
  assert.equal(await msgrPush(e, fixture), true);
  assert.equal(await msgrPush(e, fixture), true);
  await msgrPush({ ...e, phase: 'stop' }, fixture);
  const [first, again, stop] = fixture.sent;
  assert.deepEqual(first.mentions, []); assert.equal(first.meta.disposition, 'done');
  assert.equal(first.thread_root, null); assert.equal(first.reply_to, null);
  assert.equal(first.client_msg_id, again.client_msg_id); assert.notEqual(first.client_msg_id, stop.client_msg_id);
  await assert.rejects(msgrPush(e, messenger({ scope: false })), /unavailable/);
});

function unentitledFixture() { // messenger()의 db에 orgEntitled(false)만 얹는다 — sent는 같은 배열을 공유
  const base = messenger();
  return { sent: base.sent, session: async () => { const s = await base.session(); return { ...s, db: { ...s.db, orgEntitled: async () => false } }; } };
}

// M-2(델타 검수, 4차) — 이 파일에 쓰던 writeFileSync 기반 변이 테스트를 없앴다: node --test는 파일들을 병렬
// 프로세스로 돌리므로, 소스를 실제로 덮어썼다 복구하는 동안 다른 프로세스가 변이된 src/gateway/msgr.mjs를
// 읽거나 중간에 죽으면 변이된 채로 남을 위험이 있다. 여기서는 행동만 잠그고(자격 없으면 삽입을 시도하지
// 않는다), 변이 red 확인은 작업자가 로컬에서 그 줄을 지워 이 테스트가 실패하는 것을 수동으로 한 번 본다.
test('L-8: an unentitled org quietly skips the routine alert insert (no repeated blocked attempts) and never throws', async () => {
  const ws = await workspace(); const fixture = unentitledFixture();
  const e = event(ws, selected(['msgr']));
  assert.equal(await msgrPush(e, fixture), false);
  assert.deepEqual(fixture.sent, []);
});

test('delivery reports mute, unavailable, provider failure and uncertain network separately', async () => {
  const ws = await workspace(); const e = event(ws);
  await updateConnection(ws, 'telegram', { mutedEvents: ['routine'] });
  assert.equal((await sendRoutineNotification(e, 'telegram')).status, 'muted');
  await updateConnection(ws, 'slack', { enabled: false });
  assert.equal((await sendRoutineNotification(e, 'slack')).status, 'unavailable');
  await updateConnection(ws, 'slack', { enabled: true });
  const failure = await capture(() => sendRoutineNotification(e, 'slack'), () => new Response(JSON.stringify({ ok: false, error: 'bad-token-fixture' })));
  assert.deepEqual(failure.value, { status: 'failed', reason: 'delivery_failed' });
  const network = await capture(() => sendRoutineNotification(e, 'slack'), () => { throw new TypeError('fetch failed'); });
  assert.equal(network.value.status, 'uncertain');
});

test('telegram selected route retains paired crew-bot fallback and excludes unrelated bots', async () => {
  const ws = await workspace();
  await updateConnection(ws, 'telegram', { enabled: false });
  await updateAgentBot(ws, 'pepper', { token: `fixture-direct-${index}` });
  await updateAgentBot(ws, 'pepper', { ownerChat: 'direct-owner', ownerId: 42 });
  const got = await capture(() => sendRoutineNotification(event(ws), 'telegram'));
  assert.equal(got.value.status, 'sent'); assert.equal(got.calls[0].body.chat_id, 'direct-owner');
});

test('editing a title preserves an unchanged offline destination; changing a destination still validates', async () => {
  const ws = await workspace();
  const notifications = { channels: ['slack'] };
  const r = await addRoutine(ws, { title: 'Original', prompt: 'Check', agentSlug: 'pepper', schedule: { type: 'daily', time: '09:00' }, notifications });
  await updateConnection(ws, 'slack', { enabled: false });
  const updated = await updateRoutine(ws, r.id, { title: 'Renamed', agentSlug: 'pepper', notifications });
  assert.equal(updated.title, 'Renamed'); assert.deepEqual(updated.notifications, notifications);
  await assert.rejects(updateRoutine(ws, r.id, { notifications: { channels: ['telegram', 'slack'] } }), /unavailable/);
});

test('delivery records cannot replace a newer run, revive deletion or downgrade a final result', async () => {
  const ws = await workspace();
  const r = await addRoutine(ws, { title: 'Record', prompt: 'Check', agentSlug: 'pepper', schedule: { type: 'daily', time: '09:00' }, notifications: { channels: [] } });
  await runRoutine(ws, r.id, { chatFn: async () => ({ reply: 'Ready' }), startAt: new Date('2026-09-13T00:00:00Z') });
  const runAt = (await loadRoutines(ws))[0].lastRun;
  assert.equal(await recordRoutineNotificationDelivery(ws, r.id, runAt, [{ kind: 'slack', status: 'failed', reason: 'delivery_failed', secret: 'omit' }]), true);
  assert.equal(await recordRoutineNotificationDelivery(ws, r.id, '2000-01-01', [{ kind: 'slack', status: 'sent' }]), false);
  assert.equal(await recordRoutineNotificationDelivery(ws, r.id, runAt, [{ kind: 'slack', status: 'sent' }], 'stop'), false);
  assert.equal(await recordRoutineNotificationDelivery(ws, 'deleted', runAt, []), false);
  assert.deepEqual((await loadRoutines(ws))[0].lastNotificationDelivery.results, [{ kind: 'slack', status: 'failed', reason: 'delivery_failed' }]);
});

test('messenger destinations reject another account and bind one session through validation and insert', async () => {
  const ws = await workspace(); const fixture = messenger();
  await updateCompany(ws, { ownerId: 'different-owner' });
  assert.deepEqual(await messengerNotificationChannels(ws, 'pepper', fixture), []);
  await assert.rejects(msgrPush(event(ws, selected(['msgr'])), fixture), /owner mismatch/);
  await updateCompany(ws, { ownerId: 'fixture-owner' });
  let reads = 0;
  const session = async () => { reads++; return reads === 1 ? fixture.session() : { uid: 'switched-account' }; };
  assert.equal(await msgrPush(event(ws, selected(['msgr'])), { session }), true);
  assert.equal(reads, 1); assert.equal(fixture.sent.length, 1);
});

test('in-flight edits take effect next run: success, failure, loop stop and legacy events retain starting destinations', async () => {
  const { onNotify } = await import('../src/notify.mjs');
  for (const mode of ['success', 'failure', 'loop', 'legacy']) {
    const ws = await workspace();
    const initial = mode === 'legacy' ? undefined : { channels: ['telegram'] };
    const routine = await addRoutine(ws, { title: 'Starting title', prompt: 'Check', agentSlug: 'pepper',
      schedule: mode === 'loop' ? { type: 'interval', everyMinutes: 10 } : { type: 'daily', time: '09:00' },
      ...(mode === 'loop' ? { loop: { maxRuns: 1 } } : {}), ...(initial ? { notifications: initial } : {}) });
    const events = [];
    const unsubscribe = onNotify((e) => { if (e.wsId === ws && e.type === 'routine') events.push(e); });
    try {
      const running = runRoutine(ws, routine.id, { chatFn: async () => {
        await updateRoutine(ws, routine.id, { title: 'Next title', agentSlug: 'next-crew', notifications: { channels: ['slack'] } });
        if (mode === 'failure') throw new Error('fixture execution failed');
        return { reply: mode === 'loop' ? 'Ready\nLOOP: done finished' : 'Ready' };
      } });
      if (mode === 'failure') await assert.rejects(running, /fixture execution failed/);
      else await running;
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(events.length, mode === 'loop' ? 2 : 1);
      for (const e of events) {
        assert.deepEqual(e.routine.notifications, initial, `${mode}: original selection, including undefined legacy`);
        assert.equal(e.routine.title, 'Starting title');
        assert.equal(e.routine.agentSlug, 'pepper');
      }
      const saved = (await loadRoutines(ws))[0];
      assert.deepEqual(saved.notifications, { channels: ['slack'] });
      assert.equal(saved.title, 'Next title'); assert.equal(saved.agentSlug, 'next-crew');
    } finally { unsubscribe(); }
  }
});

// 루프 표지(LOOP: …)는 루틴이 emitNotify에 넘기기 전에 한 번만 뺀다 — 텔레그램·슬랙·메신저 알림(선택한 목적지)과
// 옛 텔레그램·슬랙 브리핑(목적지 미선택)이 모두 같은 event.reply를 쓰므로 출구마다 따로 처리하지 않는다. 실제 전송은 가짜(fetch·DB).
test('loop verdict marker never reaches any routine alert exit; the verdict still comes from the raw reply', async () => {
  const ws = await workspace();
  const { onNotify } = await import('../src/notify.mjs');
  const r = await addRoutine(ws, { agentSlug: 'pepper', title: 'Loop', prompt: 'check', schedule: { type: 'interval', everyMinutes: 10 }, loop: {}, notifications: { channels: ['telegram', 'slack'] } }); // 메신저 목적지 검증은 실세션이 필요해 이벤트에서 덧붙인다
  const got = []; const off = onNotify((e) => { if (e.wsId === ws && e.type === 'routine') got.push(e); });
  let out;
  try { out = await runRoutine(ws, r.id, { chatFn: async () => ({ reply: 'All green\n\n`LOOP: done goal reached`', handover: null, sessionId: null }) }); } finally { off(); }
  assert.equal(out.stopped, 'done');
  const emitted = got.find((e) => e.phase !== 'stop');
  const result = { ...emitted, routine: { ...emitted.routine, notifications: selected() } };
  const fixture = messenger();
  const pushMsgr = (e) => msgrPush(e, { session: fixture.session });
  const chosen = await capture(() => _pushEventForTest(result, { pushMsgr }));
  const legacy = await capture(() => _pushEventForTest({ ...result, routine: { ...result.routine, notifications: undefined } }, { pushMsgr: async () => false }));
  const bodies = [...chosen.calls, ...legacy.calls].map((c) => JSON.stringify(c.body));
  assert.ok(chosen.calls.length >= 2 && legacy.calls.length >= 1, 'telegram·slack both called');
  assert.equal(fixture.sent.length, 1);
  for (const b of [...bodies, fixture.sent[0].body]) { assert.doesNotMatch(b, /LOOP/); assert.match(b, /All green/); }
});

// 놓친 회차 알림(phase 'skipped', ok:false)은 모든 출구에서 머리가 (건너뜀)이다 — 본문은 '건너뛰었습니다'인데 머리가 '(실패)'면 앞뒤가 안 맞는다(검수 LOW).
// 실패 알림은 종전대로 (실패). 출구: 선택한 목적지(텔레그램·슬랙·메신저 채널 글)와 옛 브리핑(텔레그램·슬랙).
test('skipped routine notices are headed "(건너뜀)" on every exit while failures keep "(실패)"', async () => {
  const ws = await workspace();
  for (const [phase, want, not] of [['skipped', /\(건너뜀\)/, /\(실패\)/], [undefined, /\(실패\)/, /\(건너뜀\)/]]) {
    const e = { ...event(ws), ok: false, ...(phase ? { phase } : {}), reply: '10월 8일 09:00 회차는 건너뛰었습니다', runAt: `2026-10-08T00:00:0${phase ? 1 : 2}Z` };
    const fixture = messenger();
    const chosen = await capture(() => _pushEventForTest(e, { pushMsgr: (x) => msgrPush(x, { session: fixture.session }) }));
    const legacy = await capture(() => _pushEventForTest({ ...e, routine: { ...e.routine, notifications: undefined } }, { pushMsgr: async () => false }));
    const bodies = [...chosen.calls, ...legacy.calls].map((c) => JSON.stringify(c.body)).concat(fixture.sent.map((row) => row.body));
    assert.ok(chosen.calls.length >= 2 && legacy.calls.length >= 2 && fixture.sent.length === 1, `텔레그램·슬랙(선택·옛)·메신저 모두 나갔다: ${chosen.calls.length}/${legacy.calls.length}/${fixture.sent.length}`);
    for (const b of bodies) { assert.match(b, want, `${phase ?? 'failed'}: ${b}`); assert.doesNotMatch(b, not, `${phase ?? 'failed'}: ${b}`); }
  }
});
