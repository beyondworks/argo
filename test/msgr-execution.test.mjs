import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beginMessengerExecution, finishMessengerExecution, executionHeartbeat } from '../src/gateway/msgr-execution.mjs';

const job = () => ({ crewId: 'crew', channelId: 'channel', msgId: 1 });
const reply = { body: '1', mentions: [{ kind: 'crew', id: 'next' }], meta: { hop: 0 } };
function db() {
  let claimed = false, result = null;
  return {
    async claimExecution() { const acquired = !claimed; claimed = true; return { acquired, state: result ? 'completed' : 'running', heartbeat_at: new Date().toISOString(), reply_id: result?.id }; },
    async finishExecution() { return result ??= { id: 2 }; },
    async heartbeatExecution() { return true; },
  };
}

test('separate hosts get only one execution right', async () => {
  const shared = db();
  const outcomes = await Promise.all([beginMessengerExecution('ws', shared, job()), beginMessengerExecution('ws', shared, job())]);
  assert.deepEqual(outcomes.map((r) => r.kind).sort(), ['pending', 'run']);
});

test('lost acquire response never grants the same attempt a second execution', async () => {
  const shared = db(), pending = job();
  const interrupted = { ...shared, claimExecution: async (...args) => { await shared.claimExecution(...args); throw new Error('response lost'); } };
  await assert.rejects(beginMessengerExecution('ws', interrupted, pending), /response lost/);
  assert.equal(pending.msgrExecution.phase, 'claiming');
  assert.equal((await beginMessengerExecution('ws', shared, pending)).kind, 'pending');
});

test('a stale heartbeat is an observation, never a new execution grant', async () => {
  const shared = { claimExecution: async () => ({ acquired: false, state: 'running', heartbeat_at: '2000-01-01T00:00:00Z' }) };
  assert.deepEqual(await beginMessengerExecution('ws', shared, job()), { kind: 'pending', stale: true });
});

test('finish failures retain the complete result and retry publication with zero extra runs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'msgr-execution-test-'));
  try {
    const meta = { path: join(dir, 'job.json.claimed') }, shared = db(), pending = job();
    let calls = 0, runs = 0;
    const unstable = { ...shared, finishExecution: async (...args) => { if (++calls < 3) throw new Error('offline'); return shared.finishExecution(...args); } };
    assert.equal((await beginMessengerExecution('ws', unstable, pending, meta)).kind, 'run'); runs++;
    await assert.rejects(finishMessengerExecution('ws', unstable, pending, reply, meta), /offline/);
    const recovered = JSON.parse(await readFile(meta.path, 'utf8'));
    assert.deepEqual(recovered.msgrExecution.replyRow, reply);
    await assert.rejects(beginMessengerExecution('ws', unstable, recovered, meta), /offline/);
    assert.deepEqual(await beginMessengerExecution('ws', unstable, recovered, meta), { kind: 'completed', row: { id: 2 } });
    assert.equal(runs, 1); assert.equal(calls, 3);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('lost finish response returns the original reply on replay', async () => {
  const shared = db(), pending = job();
  await beginMessengerExecution('ws', shared, pending);
  await assert.rejects(finishMessengerExecution('ws', { ...shared, finishExecution: async (...args) => { await shared.finishExecution(...args); throw new Error('response lost'); } }, pending, reply), /response lost/);
  assert.deepEqual(await beginMessengerExecution('ws', shared, pending), { kind: 'completed', row: { id: 2 } });
});

test('missing execution RPC fails closed before any paid work', async () => {
  await assert.rejects(beginMessengerExecution('ws', {}, job()), /claimExecution/);
  await assert.rejects(finishMessengerExecution('ws', db(), job(), reply), /실행권/);
});

test('heartbeat is bounded and stoppable without claiming again', async () => {
  const pending = job(); pending.msgrExecution = { attempt: 'attempt' };
  let count = 0;
  const stop = executionHeartbeat('ws', { heartbeatExecution: async () => { count++; } }, pending, { intervalMs: 5 });
  await new Promise((r) => setTimeout(r, 25)); stop();
  const atStop = count;
  await new Promise((r) => setTimeout(r, 15));
  assert.ok(atStop > 0); assert.equal(count, atStop);
});
