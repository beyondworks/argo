import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { createRealtimeScope } from '../apps/messenger/src/realtime-scope.mjs';

function deferred() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; }
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('actual SDK topic cache is retained during deferred removal; new setup waits and gets a new object', async () => {
  const require = createRequire(new URL('../apps/messenger/package.json', import.meta.url));
  const { RealtimeClient } = require('@supabase/realtime-js');
  const client = new RealtimeClient('https://isolated-realtime.example/realtime/v1', { params: { apikey: 'public-fixture' }, disconnectOnEmptyChannelsAfterMs: 0, timeout: 100 });
  const scope = createRealtimeScope(); const leaving = deferred(); const channels = []; let disposed;
  const firstStop = scope.run(async (isDisposed) => {
    disposed = isDisposed;
    const channel = client.channel('org:fixture'); channels.push(channel);
    // Delay only the transport acknowledgement; real removeChannel/cache/teardown remain installed SDK code.
    const unsubscribe = channel.unsubscribe.bind(channel);
    channel.unsubscribe = async () => { await leaving.promise; return unsubscribe(); };
    return () => client.removeChannel(channel);
  });
  await tick();
  const first = channels[0];
  const firstDone = firstStop();
  const secondStop = scope.run(async () => {
    const channel = client.channel('org:fixture'); channels.push(channel);
    return () => client.removeChannel(channel);
  });
  await tick();
  assert.equal(disposed(), true);
  assert.equal(client.channel('org:fixture'), first, 'SDK really returns cached old instance while unsubscribe waits');
  assert.equal(channels.length, 1, 'second setup cannot reach channel factory yet');
  leaving.resolve(); await firstDone; await tick();
  assert.equal(channels.length, 2);
  assert.notEqual(channels[1], first);
  await secondStop();
  assert.equal(client.getChannels().length, 0);
  await client.disconnect();
});

test('cleanup during pending auth/setup disposes its late resource before the next setup', async () => {
  const scope = createRealtimeScope(); const auth = deferred(); const events = [];
  const firstStop = scope.run(async (isDisposed) => {
    await auth.promise;
    assert.equal(isDisposed(), true);
    events.push('late-resource');
    return async () => { events.push('late-disposed'); };
  });
  await tick(); const done = firstStop();
  const secondStop = scope.run(async () => { events.push('next-setup'); return () => events.push('next-disposed'); });
  await tick(); assert.deepEqual(events, []);
  auth.resolve(); await done; await tick();
  assert.deepEqual(events, ['late-resource', 'late-disposed', 'next-setup']);
  await secondStop();
});

test('rapid cancelled queued setups never execute; repeated cleanup disposes once', async () => {
  const scope = createRealtimeScope(); const remove = deferred(); let disposals = 0; let nextCalls = 0;
  const firstStop = scope.run(() => async () => { disposals += 1; await remove.promise; });
  await tick(); const done = firstStop(); assert.equal(firstStop(), done);
  const cancelled = scope.run(() => assert.fail('cancelled queued setup must not allocate')); const skipped = cancelled();
  const last = scope.run(() => { nextCalls += 1; return () => {}; });
  await tick(); assert.equal(nextCalls, 0);
  remove.resolve(); await done; await skipped; await tick();
  assert.equal(nextCalls, 1); assert.equal(disposals, 1); await last();
});

test('failed setup reports failure but does not block a later authenticated setup', async () => {
  const errors = []; const scope = createRealtimeScope((e) => errors.push(e.message));
  const first = scope.run(async () => { throw new Error('auth unavailable'); }); await tick(); await first();
  let started = false; const second = scope.run(() => { started = true; return () => {}; }); await tick();
  assert.equal(started, true); assert.deepEqual(errors, ['auth unavailable']); await second();
});

test('failed disposal blocks later setup rather than reusing an uncertain cached channel', async () => {
  const errors = []; const scope = createRealtimeScope((e) => errors.push(e.message));
  const first = scope.run(() => async () => { throw new Error('remove failed'); }); await tick();
  await assert.rejects(first(), /remove failed/);
  const second = scope.run(() => assert.fail('must not allocate after failed disposal'));
  await assert.rejects(second(), /remove failed/);
  assert.ok(errors.every((e) => e === 'remove failed'));
});


test('partial allocation plus setup failure and failed removal blocks the next cached-topic setup', async () => {
  const errors = []; const scope = createRealtimeScope((e) => errors.push(e.message));
  const resource = { cached: false }; let isDisposed; let removalCalls = 0;
  const first = scope.run((check, registerDispose) => {
    isDisposed = check; resource.cached = true;
    registerDispose(async () => {
      removalCalls += 1;
      assert.equal(check(), true, 'failed setup stops late event callbacks before removing');
      throw new Error('partial remove failed');
    });
    throw new Error('subscribe failed');
  });
  await tick();
  await assert.rejects(first(), /partial remove failed/);
  const next = scope.run(() => assert.fail('must not touch the still-cached resource'));
  await assert.rejects(next(), /partial remove failed/);
  assert.equal(resource.cached, true); assert.equal(removalCalls, 1); assert.equal(isDisposed(), true);
  assert.ok(errors.includes('subscribe failed')); assert.ok(errors.includes('partial remove failed'));
});

test('successful async removal after partial setup failure permits retry only after cache eviction', async () => {
  const errors = []; const scope = createRealtimeScope((e) => errors.push(e.message)); const leaving = deferred();
  const resource = { cached: false }; let retried = false; let removalCalls = 0;
  const first = scope.run((_isDisposed, registerDispose) => {
    resource.cached = true;
    registerDispose(async () => { removalCalls += 1; await leaving.promise; resource.cached = false; });
    throw new Error('subscribe failed');
  });
  await tick(); const firstDone = first();
  const next = scope.run(() => { assert.equal(resource.cached, false); retried = true; return () => {}; });
  await tick(); assert.equal(retried, false); assert.equal(resource.cached, true);
  leaving.resolve(); await firstDone; await tick();
  assert.equal(retried, true); assert.equal(removalCalls, 1); assert.deepEqual(errors, ['subscribe failed']);
  await next();
});

test('registered and returned same disposer is invoked once on normal cleanup', async () => {
  const scope = createRealtimeScope(); let calls = 0;
  const stop = scope.run((_isDisposed, registerDispose) => {
    const remove = () => { calls += 1; }; registerDispose(remove); return remove;
  });
  await tick(); await stop(); await stop(); assert.equal(calls, 1);
});

// 조직 전환 중 이전 topic 송신 차단(분리 검수 P2). 송신 참조 rt.current는 비동기 제거를 기다리지 않고
// React cleanup에서 동기적으로 비워져야 한다. 소스 구간 핀 — App.jsx는 컴포넌트 전체 렌더 없이 실행할 수 없다.
test('App realtime cleanup clears the send ref before awaiting async removal', async () => {
  const src = await readFile(new URL('../apps/messenger/src/App.jsx', import.meta.url), 'utf8');
  const from = src.indexOf('const cleanup = realtimeScope.run(');
  assert.notEqual(from, -1, 'realtime effect not found');
  const at = src.indexOf('return () => {', from);
  const body = src.slice(at, src.indexOf('};', at));
  const cleared = body.indexOf('rt.current = null');
  const deferred = body.indexOf('cleanup()');
  assert.notEqual(cleared, -1, 'React cleanup must clear the send ref');
  assert.notEqual(deferred, -1, 'React cleanup must hand removal to the scope');
  assert.ok(cleared < deferred, 'send ref must be cleared before the async removal is queued');
});
