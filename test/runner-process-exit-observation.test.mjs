import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

// Execute the production functions; only process inspection, signals and time are fake.
// No host processes, credentials, files or vendor commands are used by this fixture.
const source = (await readFile(new URL('../src/runners/process-tree.mjs', import.meta.url), 'utf8'))
  .replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
const root = '200 100 S root-birth';
const descendant = '201 200 S child-birth';
const unrelated = '900 100 S unrelated-birth';
const table = (...rows) => rows.join('\n') + '\n';

function fixture(observe) {
  let now = 0, observations = 0, settled = false;
  const signals = [], budgets = [];
  const child = {
    pid: 200, exitCode: null, signalCode: null, stdin: { end() {} },
    kill(signal) { signals.push([200, signal]); },
  };
  const inspect = async (_command, _args, options) => {
    if (!signals.some(([pid, signal]) => pid === 200 && signal === 'SIGKILL')) {
      return { stdout: table(root, descendant, unrelated) };
    }
    budgets.push({ timeout: options.timeout, remaining: 2000 - now });
    const stdout = await observe(++observations, {
      get settled() { return settled; },
      advance(ms) { now += ms; },
      child,
    });
    return { stdout };
  };
  const { execTurnFile } = runInNewContext(`${source}\n({ execTurnFile })`, {
    execFile: () => child, promisify: () => inspect,
    process: { pid: 100, platform: 'darwin', kill: (pid, signal) => signals.push([pid, signal]) },
    performance: { now: () => now },
    setTimeout(fn, ms) {
      const timer = { cancelled: false, unref() {} };
      queueMicrotask(() => { if (!timer.cancelled) { now += ms; fn(); } });
      return timer;
    },
    clearTimeout(timer) { if (timer) timer.cancelled = true; },
    setInterval: () => ({ unref() {} }), clearInterval() {},
  });
  const controller = new AbortController();
  const run = execTurnFile('fixture-only', [], { signal: controller.signal });
  const result = run.then(
    () => { settled = true; throw new Error('Cancellation must reject'); },
    error => { settled = true; return error; },
  );
  controller.abort();
  return { result, signals, budgets, get observations() { return observations; }, get now() { return now; } };
}

// The initial ownership snapshot already knows the descendant; the verified root is inserted last.
const expectedSignals = [[201, 'SIGSTOP'], [200, 'SIGSTOP'], [200, 'SIGKILL'], [201, 'SIGKILL']];

for (const survivor of [root, descendant]) {
  test(`cancellation waits for delayed exit of ${survivor === root ? 'root' : 'descendant'}`, async () => {
    const f = fixture((n, state) => {
      assert.equal(state.settled, false, 'turn stays pending during exit observation');
      return n < 4 ? table(survivor, unrelated) : table(unrelated);
    });
    const error = await f.result;
    assert.equal(error.aborted, true);
    assert.equal(error.cancellationIncomplete, undefined);
    assert.equal(f.observations, 4, 'must observe delayed identity disappearance, not just signal delivery');
    assert.deepEqual(f.signals, expectedSignals, 'unrelated process is not signalled');
  });
}

test('root exit metadata does not conceal a live descendant', async () => {
  const f = fixture((n, { child }) => {
    child.signalCode = 'SIGKILL';
    return n < 3 ? table(descendant, unrelated) : table(unrelated);
  });
  assert.equal((await f.result).cancellationIncomplete, undefined);
  assert.equal(f.observations, 3);
});

test('a still-running identity exhausts one bounded budget and reports incomplete without more signals', async () => {
  const f = fixture(() => table(root, descendant, unrelated));
  const error = await f.result;
  assert.equal(error.aborted, true);
  assert.equal(error.cancellationIncomplete, true);
  assert.equal(error.cause?.ownershipUnverified, true, 'no unverified fallback PID kill');
  assert.ok(f.now >= 2000 && f.now <= 2050, `bounded virtual elapsed time: ${f.now}`);
  assert.ok(f.observations > 1);
  assert.ok(f.budgets.every(({ timeout, remaining }) => timeout > 0 && timeout <= remaining));
  assert.ok(f.budgets.at(-1).timeout < f.budgets[0].timeout, 'each ps receives remaining budget');
  assert.deepEqual(f.signals, expectedSignals);
});

test('process inspection time consumes the same exit budget', async () => {
  const f = fixture((_n, { advance }) => { advance(650); return table(descendant, unrelated); });
  assert.equal((await f.result).cancellationIncomplete, true);
  assert.equal(f.observations, 3);
  assert.ok(f.budgets.every(({ timeout, remaining }) => timeout <= remaining));
});

test('post-kill inspection failure propagates incomplete without signalling the root again', async () => {
  const failure = new Error('fixture inspection unavailable');
  const f = fixture(() => { throw failure; });
  const error = await f.result;
  assert.equal(error.cancellationIncomplete, true);
  assert.equal(error.cause, failure);
  assert.equal(error.cause.ownershipUnverified, true);
  assert.deepEqual(f.signals, expectedSignals);
});

for (const invalid of ['', 'unparseable process row\n']) {
  test(`invalid post-kill inspection (${invalid ? 'malformed' : 'empty'}) cannot claim exit`, async () => {
    const f = fixture(() => invalid);
    const error = await f.result;
    assert.equal(error.cancellationIncomplete, true);
    assert.equal(error.cause.ownershipUnverified, true);
    assert.deepEqual(f.signals, expectedSignals);
  });
}

test('reused PID is not signalled while the remaining original descendant is observed', async () => {
  const f = fixture(n => n < 3
    ? table('200 100 S replacement-birth', descendant, unrelated)
    : table('200 100 S replacement-birth', unrelated));
  assert.equal((await f.result).cancellationIncomplete, undefined);
  assert.equal(f.observations, 3);
  assert.deepEqual(f.signals, expectedSignals, 'only original pre-reuse identities received signals');
});

test('descendant timeout does not send a fallback signal to a reused root PID', async () => {
  const f = fixture(() => table('200 100 S replacement-birth', descendant, unrelated));
  const error = await f.result;
  assert.equal(error.cancellationIncomplete, true);
  assert.equal(error.cause.ownershipUnverified, true);
  assert.deepEqual(f.signals, expectedSignals);
});

test('zombies with matching birth are terminal, without waiting for an unrelated parent to reap them', async () => {
  const f = fixture(() => table('200 100 Z root-birth', '201 1 Z+ child-birth', unrelated));
  assert.equal((await f.result).cancellationIncomplete, undefined);
  assert.equal(f.observations, 1);
  assert.equal(f.now, 0);
  assert.deepEqual(f.signals, expectedSignals);
});

test('stopped identities are not confused with exited identities', async () => {
  const f = fixture(() => table('200 100 T root-birth', '201 200 T child-birth', unrelated));
  assert.equal((await f.result).cancellationIncomplete, true);
  assert.ok(f.observations > 1);
  assert.deepEqual(f.signals, expectedSignals);
});

test('Windows still delegates to taskkill, without Unix process inspection', async () => {
  const calls = [];
  const { terminateOwnedProcessTree } = runInNewContext(`${source}\n({ terminateOwnedProcessTree })`, {
    execFile() {}, promisify: () => async (...args) => { calls.push(args); },
    process: { platform: 'win32' },
  });
  await terminateOwnedProcessTree({ pid: 200, exitCode: null, signalCode: null });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'taskkill');
  assert.deepEqual(Array.from(calls[0][1]), ['/PID', '200', '/T', '/F']);
  assert.equal(calls[0][2].timeout, 5000);
  await assert.rejects(terminateOwnedProcessTree({ pid: 200, exitCode: 0, signalCode: null }), e => e.ownershipUnverified === true);
  assert.equal(calls.length, 1, 'departed root must not be signalled');
});
