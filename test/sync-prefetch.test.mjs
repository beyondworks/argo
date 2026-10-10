// 받기 미리 하기(src/sync-prefetch.mjs) 단위 시험 — 동시 개수·앞서 받기 개수·크기 합 상한, 같은 키 한 번만 받기, 오류는 그 키의 차례에 같은 객체로,
// 건너뛴 자리는 버리기, stop()은 새로 시작하지 않고 진행 중인 요청을 기다린다. 동기화 루프가 이 순서 계약 위에서 쓰기·판정을 종전 순서대로 한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPrefetch } from '../src/sync-prefetch.mjs';

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
let unhandled = 0;
process.on('unhandledRejection', () => { unhandled++; });

/** 손으로 끝내는 받기 — 시작한 키·동시 수를 기록하고, finish(key[, err])로 끝낸다. */
function manual() {
  const pending = new Map(), calls = new Map();
  const m = { inflight: 0, max: 0, calls, started: [] };
  m.fetch = (key) => {
    calls.set(key, (calls.get(key) ?? 0) + 1); m.started.push(key);
    m.inflight++; m.max = Math.max(m.max, m.inflight);
    return new Promise((resolve, reject) => pending.set(key, { resolve, reject }));
  };
  m.finish = async (key, err) => { const p = pending.get(key); pending.delete(key); m.inflight--; if (err) p.reject(err); else p.resolve(`v:${key}`); await tick(); };
  m.pending = () => [...pending.keys()];
  return m;
}

test('동시 개수 상한 — 처음에 concurrency개만 시작하고, 하나 끝날 때마다 다음 하나를 시작한다', async () => {
  const keys = Array.from({ length: 10 }, (_, i) => `k${i}`);
  const m = manual();
  const pf = createPrefetch(keys, m.fetch, { concurrency: 3, maxAhead: 100 });
  await tick();
  assert.deepEqual(m.started, ['k0', 'k1', 'k2']);
  await m.finish('k1');
  assert.deepEqual(m.started, ['k0', 'k1', 'k2', 'k3'], '순서대로 다음 하나');
  const v0 = pf.take('k0');
  await m.finish('k0');
  assert.equal(await v0, 'v:k0');
  assert.equal(await pf.take('k1'), 'v:k1', '먼저 끝난 결과를 보관했다가 차례에 준다');
  assert.ok(m.max <= 3);
});

test('앞서 받기 개수 상한 — 꺼내 가지 않으면 maxAhead개에서 멈춘다', async () => {
  const keys = Array.from({ length: 50 }, (_, i) => `k${i}`);
  let n = 0;
  const pf = createPrefetch(keys, async (k) => { n++; return k; }, { concurrency: 8, maxAhead: 5 });
  await tick(5);
  assert.equal(n, 5);
  assert.equal(await pf.take('k0'), 'k0');
  await tick(5);
  assert.equal(n, 6, '하나 꺼내 가면 하나 더');
  await pf.stop();
});

test('크기 합 상한 — 앞서 받아 둔 크기 합이 maxBytes를 넘지 않고, 그보다 큰 것은 혼자일 때만 받는다', async () => {
  const sizes = { a: 10, b: 10, c: 10, big: 100, d: 10 };
  const keys = Object.keys(sizes);
  const m = manual();
  const pf = createPrefetch(keys, m.fetch, { concurrency: 8, maxAhead: 100, maxBytes: 25, sizeOf: (k) => sizes[k] });
  await tick();
  assert.deepEqual(m.started, ['a', 'b'], '10+10까지 — 세 번째(30)는 상한을 넘는다');
  assert.equal(pf.stats.held, 20);
  await m.finish('a'); await m.finish('b');
  assert.deepEqual(m.started, ['a', 'b'], '끝나도 꺼내 가기 전에는 자리를 차지한다');
  await pf.take('a');
  assert.deepEqual(m.started, ['a', 'b', 'c']);
  await pf.take('b');
  await m.finish('c');
  assert.deepEqual(m.started, ['a', 'b', 'c'], '큰 파일은 앞서 받아 둔 것이 있으면 시작하지 않는다');
  await pf.take('c');
  assert.deepEqual(m.started, ['a', 'b', 'c', 'big'], '비면 큰 파일 하나는 혼자 받는다');
  assert.equal(pf.stats.held, 100);
  await m.finish('big');
  assert.deepEqual(m.started, ['a', 'b', 'c', 'big'], '큰 파일을 들고 있는 동안 다른 것을 더 받지 않는다');
  await pf.take('big');
  assert.deepEqual(m.started, ['a', 'b', 'c', 'big', 'd']);
  await m.finish('d'); await pf.take('d');
  assert.equal(pf.stats.held, 0);
});

test('오류는 그 키의 차례에 같은 객체로 던지고, 다른 키는 계속 받는다 — 꺼내 가기 전 거부가 처리 안 된 거부로 새지 않는다', async () => {
  const boom = Object.assign(new Error('Bucket not found'), { notFound: false });
  const gone = Object.assign(new Error('Object not found'), { notFound: true });
  const pf = createPrefetch(['a', 'b', 'c'], async (k) => { if (k === 'a') throw boom; if (k === 'b') throw gone; return k; }, { concurrency: 3 });
  await tick(10); // 셋 다 끝났고 아직 아무도 꺼내 가지 않았다
  await assert.rejects(pf.take('a'), (e) => e === boom);
  await assert.rejects(pf.take('b'), (e) => e === gone && e.notFound === true);
  assert.equal(await pf.take('c'), 'c');
  await tick(10);
  assert.equal(unhandled, 0);
});

test('같은 키를 두 번 받지 않는다 — 대상 아닌 키는 바로 받고, 건너뛴 자리는 버리며 다시 받지 않는다', async () => {
  const calls = new Map();
  const fetch = async (k) => { calls.set(k, (calls.get(k) ?? 0) + 1); await tick(1); return k; };
  const keys = Array.from({ length: 30 }, (_, i) => `k${i}`);
  const pf = createPrefetch(keys, fetch, { concurrency: 4, maxAhead: 8 });
  assert.equal(await pf.take('other'), 'other', '미리 받기 대상이 아니면 종전처럼 바로 받는다');
  assert.equal(await pf.take('k0'), 'k0');
  assert.equal(await pf.take('k5'), 'k5', 'k1~k4를 건너뛰었다');
  for (let i = 6; i < 30; i++) assert.equal(await pf.take(`k${i}`), `k${i}`);
  await pf.stop();
  for (const [k, c] of calls) assert.equal(c, 1, `${k}를 ${c}번 받았다`);
  for (let i = 1; i < 5; i++) assert.ok((calls.get(`k${i}`) ?? 0) <= 1);
});

test('stop() — 받아 둔 결과를 버리고 새로 시작하지 않으며, 진행 중인 요청이 끝날 때까지 기다린다', async () => {
  const keys = Array.from({ length: 20 }, (_, i) => `k${i}`);
  const m = manual();
  const pf = createPrefetch(keys, m.fetch, { concurrency: 3, maxAhead: 10 });
  await tick();
  await m.finish('k0');
  let stopped = false;
  const s = pf.stop().then(() => { stopped = true; });
  await tick();
  assert.equal(stopped, false, 'k1·k2·k3가 아직 진행 중');
  assert.equal(pf.stats.held, 0, '받아 둔 결과는 버렸다');
  await m.finish('k1', new Error('late failure')); await m.finish('k2'); await m.finish('k3');
  await s;
  assert.equal(stopped, true);
  assert.deepEqual(m.started, ['k0', 'k1', 'k2', 'k3'], 'stop 뒤에는 새로 시작하지 않는다');
  assert.equal(unhandled, 0, '버린 실패가 처리 안 된 거부로 새지 않는다');
});

test('무작위 — 순서대로 모두 꺼내 가면(동기화 루프의 사용법) 결과·오류가 키마다 맞고, 동시 상한·앞서 받기 상한·크기 상한을 넘지 않으며, 키마다 한 번만 받는다', async () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  for (let round = 0; round < 40; round++) {
    const n = 1 + Math.floor(rnd() * 60);
    const keys = Array.from({ length: n }, (_, i) => `r${round}-${i}`);
    const size = new Map(keys.map((k) => [k, Math.floor(rnd() * 40)]));
    const failing = new Set(keys.filter(() => rnd() < 0.15));
    const conc = 1 + Math.floor(rnd() * 8), ahead = conc + Math.floor(rnd() * 8), maxBytes = 30 + Math.floor(rnd() * 60);
    const calls = new Map();
    let inflight = 0, maxIn = 0, pf;
    const fetch = async (k) => {
      calls.set(k, (calls.get(k) ?? 0) + 1);
      inflight++; maxIn = Math.max(maxIn, inflight);
      assert.ok(pf === undefined || pf.stats.ahead <= ahead, '앞서 받기 상한');
      await tick(Math.floor(rnd() * 3));
      inflight--;
      if (failing.has(k)) throw new Error(`fail ${k}`);
      return `v${k}`;
    };
    pf = createPrefetch(keys, fetch, { concurrency: conc, maxAhead: ahead, maxBytes, sizeOf: (k) => size.get(k) });
    for (const k of keys) {
      const { held } = pf.stats;
      assert.ok(held <= Math.max(maxBytes, ...keys.map((x) => size.get(x))), '크기 상한(큰 것 하나는 혼자)');
      if (failing.has(k)) await assert.rejects(pf.take(k), new RegExp(`fail ${k}$`));
      else assert.equal(await pf.take(k), `v${k}`);
      if (rnd() < 0.2) await tick(Math.floor(rnd() * 3)); // 소비 쪽이 느린 순간(쓰기·올리기)
    }
    await pf.stop();
    assert.ok(maxIn <= conc, `동시 ${maxIn} > 상한 ${conc}`);
    assert.equal(calls.size, n);
    for (const [k, c] of calls) assert.equal(c, 1, k);
  }
  assert.equal(unhandled, 0);
});

test('받는 중 크기 상한·큰 파일 혼자 — 받는 중인 크기 합이 maxInflightBytes를 넘지 않고, soloBytes보다 큰 것은 다른 받기가 없을 때만 시작해 혼자 받는다', async () => {
  const sizes = { a: 300, b: 300, c: 300, big: 900, d: 100 };
  const m = manual();
  const pf = createPrefetch(Object.keys(sizes), m.fetch, { concurrency: 8, maxAhead: 100, maxBytes: 1e9, maxInflightBytes: 700, soloBytes: 500, sizeOf: (k) => sizes[k] });
  await tick();
  assert.deepEqual(m.started, ['a', 'b'], '300+300 — 셋째(900)는 받는 중 상한 700을 넘는다');
  await m.finish('a');
  assert.deepEqual(m.started, ['a', 'b', 'c'], '끝나면(꺼내 가기 전이어도) 받는 중 크기에서 빠진다');
  await m.finish('b'); await m.finish('c');
  assert.deepEqual(m.started, ['a', 'b', 'c', 'big'], '받는 것이 없어야 큰 파일을 시작한다');
  assert.equal(pf.stats.inflightBytes, 900);
  await tick();
  assert.deepEqual(m.started, ['a', 'b', 'c', 'big'], '큰 파일을 받는 동안 작은 것도 시작하지 않는다');
  await m.finish('big');
  assert.deepEqual(m.started, ['a', 'b', 'c', 'big', 'd']);
  await m.finish('d');
  for (const k of Object.keys(sizes)) assert.equal(await pf.take(k), `v:${k}`);
});

test('느린 회선 — 함께 받다 시간 초과가 나면 하나씩으로 바꾸고, 함께 받던 요청은 멈춘 뒤 차례에 하나씩, 실패한 키는 차례에 혼자 한 번 더 받는다', async () => {
  const slow = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  const calls = new Map(); let inflight = 0, maxIn = 0, aborted = 0, phase = 'together';
  const fetch = (k, signal) => new Promise((resolve, reject) => {
    calls.set(k, (calls.get(k) ?? 0) + 1); inflight++; maxIn = Math.max(maxIn, inflight);
    const done = (fn) => { inflight--; fn(); };
    if (phase === 'together') { // 처음 함께 받는 것: k0만 시간 초과, 나머지는 회선이 막혀 끝나지 않는다(멈추기 신호로만 끝)
      if (k === 'k0') setTimeout(() => { phase = 'alone'; done(() => reject(slow)); }, 5); // 시간 초과 뒤에는 회선이 비어 하나씩이면 받힌다
      signal?.addEventListener('abort', () => { aborted++; done(() => reject(new Error('aborted'))); }, { once: true });
      return;
    }
    setTimeout(() => done(() => resolve(`v:${k}`)), 2);
  });
  const keys = ['k0', 'k1', 'k2', 'k3', 'k4', 'k5'];
  const pf = createPrefetch(keys, fetch, { concurrency: 4, maxAhead: 10, isSlow: (e) => e?.name === 'TimeoutError' });
  await tick(1);
  assert.equal(inflight, 4);
  for (const k of keys) assert.equal(await pf.take(k), `v:${k}`);
  assert.equal(pf.degraded, true); assert.equal(pf.stats.concurrency, 1);
  assert.equal(aborted, 3, '함께 받던 k1~k3은 멈춘다');
  assert.equal(calls.get('k0'), 2, '시간 초과 키는 혼자 한 번 더');
  for (const k of ['k1', 'k2', 'k3']) assert.equal(calls.get(k), 2, `${k}: 멈춘 뒤 차례에 한 번`);
  for (const k of ['k4', 'k5']) assert.equal(calls.get(k), 1, `${k}: 하나씩으로 바뀐 뒤 시작 — 한 번`);
  await pf.stop();
  assert.equal(unhandled, 0);
});

test('느린 회선 — 이미 하나씩 받는 중(동시 1)의 시간 초과는 다시 받지 않는다(종전과 같은 실패)', async () => {
  const slow = Object.assign(new Error('timeout'), { name: 'TimeoutError' });
  let n = 0;
  const pf = createPrefetch(['a', 'b'], async (k) => { n++; if (k === 'a') throw slow; return k; }, { concurrency: 1, isSlow: (e) => e?.name === 'TimeoutError' });
  await assert.rejects(pf.take('a'), (e) => e === slow);
  assert.equal(await pf.take('b'), 'b');
  assert.equal(n, 2, '다시 받기 없음');
});

test('stop()은 진행 중인 요청을 멈춘다(abort) — 기다림이 요청 시간 초과(30초)만큼 늘지 않는다', async () => {
  let aborted = 0;
  const fetch = (k, signal) => new Promise((_, reject) => { signal?.addEventListener('abort', () => { aborted++; reject(new Error('aborted')); }, { once: true }); }); // 멈추기 전에는 끝나지 않는 요청
  const pf = createPrefetch(['a', 'b', 'c'], fetch, { concurrency: 3 });
  await tick();
  const t0 = Date.now();
  await pf.stop();
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(aborted, 3);
  assert.equal(unhandled, 0);
});
