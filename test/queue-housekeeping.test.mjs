// L4·L5(2026-10-05 분리 검수):
// L4-a `.failed` 보존 정리가 '다음 실패 때만' 돌아, 실패가 더 없으면 7일·50건 상한이 영영 안 지켜졌다 → 워커 시작 때 한 번 돈다.
// L4-b DEFER 경로의 실패 횟수 — 1차는 "DEFER면 지운다"로 맞췄으나 2차 검수 MEDIUM-1로 되돌렸다(지우지 않는다). 근거는 아래 테스트 주석.
// L5   재시도 간격 5분 상한 때문에, 8분 넘는 장애 뒤 복구돼도 대기 중인 잡이 최대 5분 더 늦었다 → 다른 잡이 하나 성공하면
//      대기 중인 잡의 간격 타이머를 풀어 다음 틱에 다시 시도한다(실패 횟수는 유지, 워커당 60초에 한 번만 — 계속 실패하는 잡이 성공하는 잡 옆에서 매 틱 재시도되지 않게).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, writeFile, utimes } from 'node:fs/promises';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-qhk-'));
const Q = await import('../src/gateway/queue.mjs');
const { enqueueJob, startQueueWorker, queueDir, DEFER } = Q;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(pred, ms = 14_000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await pred()) return true; await sleep(100); } return false; }
const DAY = 86_400_000;

test('워커 시작 때 .failed 보존 정리가 한 번 돈다 — 7일 넘은 것과 50건 초과분이 실패가 없어도 정리된다', async () => {
  const WS = 'qhk-a';
  const dir = queueDir(WS, 'msgr');
  await mkdir(dir, { recursive: true });
  const now = Date.now();
  for (let i = 0; i < 53; i++) { // 최신 53건 — 50건만 남아야 한다(가장 오래된 3건 정리)
    const f = join(dir, `${1000 + i}-n.failed`);
    await writeFile(f, '{}'); const t = new Date(now - (60 - i) * 60_000); await utimes(f, t, t);
  }
  for (const n of ['1-old.failed', '2-old.failed']) { const f = join(dir, n); await writeFile(f, '{}'); const t = new Date(now - 8 * DAY); await utimes(f, t, t); }
  const stop = startQueueWorker(WS, 'msgr', async () => {});
  assert.ok(await until(async () => (await readdir(dir)).filter((n) => n.endsWith('.failed')).length <= 50, 4000), '시작 직후 정리');
  stop();
  const left = (await readdir(dir)).filter((n) => n.endsWith('.failed'));
  assert.equal(left.length, 50);
  assert.ok(!left.some((n) => n.includes('old')), '7일 넘은 기록은 없다');
  assert.ok(left.includes('1052-n.failed') && !left.includes('1000-n.failed'), '가장 최신 것이 남고 가장 오래된 것이 정리된다');
});

test('DEFER는 연속 실패 횟수를 지우지 않는다 — 실패→DEFER→실패의 둘째 실패는 2회째(간격이 이어서 늘어난다)', async () => {
  // 2차 분리 검수 MEDIUM-1(2026-10-05): 1차 L4는 DEFER가 횟수를 지우게 했으나, msgr.mjs busyCrew DEFER는 DB 왕복 없이 돌아온다 —
  // 같은 크루의 막힌 잡끼리 서로 DEFER시키며 횟수를 지워 간격이 1초부터 다시 시작했다(잡 3개 180초 46회). DEFER는 연속 실패를 끊은 증거가 아니다.
  const WS = 'qhk-b';
  await mkdir(join(process.env.ARGO_ROOT, WS), { recursive: true });
  await enqueueJob(WS, 'msgr', '10-a', { text: 'x' });
  const logs = []; const orig = console.error;
  console.error = (...a) => { const s = a.map(String).join(' '); if (s.includes(`${WS}/msgr/10-a.json`)) logs.push(s); else orig(...a); };
  let calls = 0;
  const stop = startQueueWorker(WS, 'msgr', async () => {
    calls++;
    if (calls === 2) return DEFER;
    if (calls <= 3) throw new Error('fetch failed');
  });
  try { await until(() => calls >= 3); await sleep(200); } finally { console.error = orig; stop(); }
  assert.equal(calls, 3);
  assert.equal(logs.length, 2, logs.join('\n'));
  assert.match(logs[0], /1회째/);
  assert.match(logs[1], /2회째/, 'DEFER가 횟수를 지우지 않으니 이어서 2회째 — 지우면 1회째로 돌아가 간격이 1초부터 다시 시작한다');
});

test('다른 잡 하나가 성공하면 대기 중인 잡의 재시도 간격이 풀려 다음 틱에 다시 시도한다 — 복구 신호(L5)', async () => {
  const WS = 'qhk-c';
  await mkdir(join(process.env.ARGO_ROOT, WS), { recursive: true });
  await enqueueJob(WS, 'msgr', '20-a', { text: 'stuck' });
  const calls = { stuck: 0, ok: 0 };
  // retryBaseMs 20초 — 첫 실패 뒤 간격이 20초라 신호 없이는 이 테스트 시간 안에 두 번째 시도가 오지 않는다
  const stop = startQueueWorker(WS, 'msgr', async (job) => { calls[job.text === 'stuck' ? 'stuck' : 'ok']++; if (job.text === 'stuck') throw new Error('fetch failed'); }, { retryBaseMs: 20_000 });
  assert.ok(await until(() => calls.stuck >= 1, 6000), '첫 시도');
  await sleep(2500);
  assert.equal(calls.stuck, 1, '신호가 없으면 20초 간격을 지킨다 — 성공한 잡이 아직 없다');
  await enqueueJob(WS, 'msgr', '21-b', { text: 'fine' }); // 연결이 돌아와 다른 잡이 성공
  assert.ok(await until(() => calls.stuck >= 2, 6000), '성공 신호 뒤 대기 중이던 잡이 곧바로 다시 시도된다');
  const second = calls.stuck;
  // 성공이 계속 이어져도 계속 실패하는 잡은 60초에 한 번만 풀린다 — 매 틱 재시도 금지(DB 위생)
  for (const id of [22, 23, 24]) { await enqueueJob(WS, 'msgr', `${id}-c`, { text: 'fine' }); await sleep(1300); }
  stop();
  assert.equal(calls.stuck, second, `성공이 이어져도 60초 안에는 한 번 더 풀리지 않는다(${calls.stuck}회)`);
  assert.equal(calls.ok, 4);
});

test('재시도 간격 함수는 기준 간격을 받는다 — 기본은 1초·5분 상한 그대로', () => {
  assert.equal(Q.queueRetryDelayMs(1), 1000);
  assert.equal(Q.queueRetryDelayMs(3), 4000);
  assert.equal(Q.queueRetryDelayMs(50), 5 * 60_000);
  assert.equal(Q.queueRetryDelayMs(1, 20_000), 20_000);
  assert.equal(Q.queueRetryDelayMs(2, 20_000), 40_000);
});
