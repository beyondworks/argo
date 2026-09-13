import test from 'node:test';
import assert from 'node:assert/strict';
import { deliverMessengerNotifications, notificationRoutes } from '../src/gateway/msgr-notifications.mjs';

const connections = {
  telegram: { enabled: true, token: 'fixture', chatId: 'fixture-chat', ownerId: 'tg-owner' },
  slack: { enabled: true, token: 'fixture', channel: 'fixture-channel', defaultCrew: 'local-default' },
};
function fixture({ rows = [], uid = 'creator', ownerId = 'creator', sendResult = { status: 'sent' }, rpcError, receipt = true } = {}) {
  const calls = []; const sent = [];
  const client = { rpc: async (name, args) => {
    calls.push({ name, args });
    if (rpcError) return { error: rpcError };
    return { data: name === 'msgr_notification_claim' ? rows : name === 'msgr_notification_finish' ? receipt : name === 'msgr_notification_authorize' ? true : [] };
  } };
  return { calls, sent, deps: {
    session: async () => ({ uid, client }), readCompany: async () => ({ name: 'My company', ownerId }),
    readConnections: async () => connections, readAgents: async () => [], readDeviceId: async () => 'my-device', attempt: 'attempt',
    send: async (event, kind) => { sent.push({ event, kind }); return sendResult; },
  } };
}
const row = { delivery_id: 'delivery', run_id: 'run', route_id: 'route', kind: 'slack', ws_id: 'mine', title: 'Today', body: 'Summary', status: 'completed' };

test('route advertisement has no credentials and respects routine mute', () => {
  const routes = notificationRoutes({ name: 'Mine' }, connections);
  assert.deepEqual(routes, [{ kind: 'telegram', label: 'Mine', ready: true }, { kind: 'slack', label: 'Mine', ready: true }]);
  const muted = notificationRoutes({ name: 'Mine' }, { telegram: { ...connections.telegram, mutedEvents: ['routine'] }, slack: { ...connections.slack, mutedEvents: ['routine'] } });
  assert.deepEqual(muted.map((r) => r.ready), [false, false]);
  assert.ok(!JSON.stringify(routes).includes('fixture'));
});
test('another signed-in account or unowned workspace never advertises or claims', async () => {
  for (const ownerId of ['someone-else', null]) {
    const f = fixture({ ownerId });
    assert.equal((await deliverMessengerNotifications('mine', f.deps)).reason, 'owner');
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.sent, []);
  }
});
test('creator node sends a trusted result through creator company, not executing crew', async () => {
  const f = fixture({ rows: [row] });
  const result = await deliverMessengerNotifications('mine', f.deps);
  assert.deepEqual(result.deliveries, [{ id: 'delivery', status: 'sent' }]);
  assert.equal(f.sent.length, 1);
  assert.equal(f.calls.find((c) => c.name === 'msgr_notification_routes_sync').args.p_device, 'my-device');
  assert.equal(f.calls.find((c) => c.name === 'msgr_notification_claim').args.p_device, 'my-device');
  assert.deepEqual(f.sent[0], { kind: 'slack', event: {
    type: 'routine', wsId: 'mine', ok: true, reply: 'Summary',
    routine: { id: 'run', title: 'Today', agentSlug: 'local-default', lastRun: 'run', notifications: { channels: ['slack'] } },
  } });
  assert.deepEqual(f.calls.at(-1).args, { p_delivery: 'delivery', p_attempt: 'attempt', p_status: 'sent', p_error: null });
});
test('foreign workspace and non-external route cannot choose another destination', async () => {
  const f = fixture({ rows: [{ ...row, ws_id: 'foreign' }, { ...row, delivery_id: 'other', kind: 'msgr' }] });
  const result = await deliverMessengerNotifications('mine', f.deps);
  assert.deepEqual(f.sent, []);
  assert.ok(result.deliveries.every((d) => d.status === 'skipped'));
});
test('logout after claim suppresses the outbound send', async () => {
  const f = fixture({ rows: [row] }); const session = f.deps.session; let count = 0;
  f.deps.session = async () => ++count === 1 ? session() : null;
  assert.equal((await deliverMessengerNotifications('mine', f.deps)).deliveries[0].reason, 'owner_changed');
  assert.deepEqual(f.sent, []);
});
test('channel access revoked after claim is checked before the external request', async () => {
  const f = fixture({ rows: [row] }); const session = await f.deps.session(); const rpc = session.client.rpc;
  session.client.rpc = async (name, args) => name === 'msgr_notification_authorize' ? { data: false } : rpc(name, args);
  assert.equal((await deliverMessengerNotifications('mine', f.deps)).deliveries[0].status, 'skipped');
  assert.deepEqual(f.sent, []);
});
test('an ambiguous send is recorded once without resending', async () => {
  const f = fixture({ rows: [row] });
  f.deps.send = async () => { f.sent.push('attempt'); throw new Error('private provider details'); };
  const result = await deliverMessengerNotifications('mine', f.deps);
  assert.deepEqual(f.sent, ['attempt']);
  assert.equal(result.deliveries[0].status, 'uncertain');
  assert.equal(f.calls.at(-1).args.p_error, 'delivery_interrupted');
});
test('receipt loss after successful send does not resend or claim success', async () => {
  const f = fixture({ rows: [row], receipt: false });
  assert.deepEqual((await deliverMessengerNotifications('mine', f.deps)).deliveries, [{ id: 'delivery', status: 'uncertain', reason: 'receipt_not_saved' }]);
  assert.equal(f.sent.length, 1);
});
test('old databases degrade without interrupting Messenger or claiming sends', async () => {
  const f = fixture({ rpcError: { code: 'PGRST202' } });
  assert.equal((await deliverMessengerNotifications('mine', f.deps)).reason, 'upgrade');
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.sent, []);
});
test('failed, muted and disconnected notifications have visible distinct delivery outcomes', async () => {
  for (const [status, expected] of [['failed', 'failed'], ['muted', 'skipped'], ['unavailable', 'skipped']]) {
    const f = fixture({ rows: [{ ...row, status: 'failed' }], sendResult: { status, reason: status } });
    assert.equal((await deliverMessengerNotifications('mine', f.deps)).deliveries[0].status, expected);
    assert.equal(f.sent[0].event.ok, false);
  }
});
