// F1(2026-10-05 분리 검증): 큐 워커가 영구 오류(형식·권한·uuid 형변환)도 1초마다 끝없이 재시도했다.
// 잠그는 행동: ① 영구 오류 = 실패 기록(.failed) 남기고 큐에서 뺀다 ② 일시 오류 = 지수 간격으로 늦춰 재시도(첫 재시도는 다음 틱)
// ③ msgr DB 층(unwrap)이 Supabase error.code를 실어 던진다 — 코드가 없으면 ①의 판정이 불가능하다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-qperm-'));
const Q = await import('../src/gateway/queue.mjs');
const { enqueueJob, startQueueWorker, queueDir } = Q;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('영구 오류(uuid 형변환 22P02·권한 42501)는 한 번만 실행하고 실패 기록을 남긴 채 큐에서 뺀다', async () => {
  const WS = 'qperm-a';
  await mkdir(join(process.env.ARGO_ROOT, WS), { recursive: true });
  await enqueueJob(WS, 'msgr', '10-a', { text: '형식 오류' });
  await enqueueJob(WS, 'msgr', '11-b', { text: '권한 오류' });
  const calls = { '형식 오류': 0, '권한 오류': 0 };
  const stop = startQueueWorker(WS, 'msgr', async (job) => {
    calls[job.text]++;
    const code = job.text === '형식 오류' ? '22P02' : '42501';
    throw Object.assign(new Error(`msgr db: invalid (${code})`), { code });
  });
  await sleep(4300);
  stop();
  assert.deepEqual(calls, { '형식 오류': 1, '권한 오류': 1 }, '영구 오류는 재시도하지 않는다');
  const names = await readdir(queueDir(WS, 'msgr'));
  assert.equal(names.filter((n) => /\.json(\.claimed)?$/.test(n)).length, 0, '큐(.json·선점)에서 빠진다');
  const failed = names.filter((n) => n.endsWith('.failed'));
  assert.equal(failed.length, 2, '실패 기록이 남는다');
  const rec = JSON.parse(await readFile(join(queueDir(WS, 'msgr'), failed.sort()[0]), 'utf8'));
  assert.equal(rec.code, '22P02');
  assert.equal(rec.job.text, '형식 오류', '무엇이 실패했는지 기록으로 찾을 수 있다');
});

test('일시 오류(코드 없음·네트워크)는 지우지 않고 지수 간격으로 재시도한다 — 첫 재시도는 다음 틱', async () => {
  const WS = 'qperm-b';
  await mkdir(join(process.env.ARGO_ROOT, WS), { recursive: true });
  await enqueueJob(WS, 'msgr', '20-a', { text: '계속 실패' });
  let calls = 0;
  const stop = startQueueWorker(WS, 'msgr', async () => { calls++; throw new Error('fetch failed'); });
  await sleep(6600);
  stop();
  assert.ok(calls >= 2, `첫 재시도는 곧바로(다음 틱) — ${calls}회`);
  assert.ok(calls <= 4, `1초마다가 아니라 간격이 늘어난다(6.6초에 ${calls}회 — 고정 1초면 6회)`);
  const names = await readdir(queueDir(WS, 'msgr'));
  assert.equal(names.filter((n) => n.endsWith('.json')).length, 1, '일시 오류 잡은 큐에 남는다(유실 금지)');
  assert.equal(names.filter((n) => n.endsWith('.failed')).length, 0);
});

test('영구 오류 판정 표 — DB 데이터·제약·권한·문법 계열과 PostgREST 요청 오류만 영구, 연결·JWT·코드 없음은 일시', () => {
  for (const code of ['22P02', '22001', '23502', '23503', '23514', '42501', '42703', '42P01', 'PGRST100', 'PGRST116', 'PGRST204']) {
    assert.equal(Q.isPermanentQueueError(Object.assign(new Error('x'), { code })), true, code);
  }
  for (const code of [undefined, '', 'PGRST000', 'PGRST001', 'PGRST301', 'PGRST303', '40001', '40P01', '57014', '53300', '08006', 'ECONNRESET', 'ETIMEDOUT']) {
    assert.equal(Q.isPermanentQueueError(Object.assign(new Error('x'), { code })), false, String(code));
  }
  assert.equal(Q.isPermanentQueueError(Object.assign(new Error('x'), { permanent: true })), true, '명시 표지');
  assert.equal(Q.isPermanentQueueError(null), false);
  // 지수 간격 — 1초(다음 틱)에서 시작해 두 배씩, 5분 상한
  assert.equal(Q.queueRetryDelayMs(1), 1000);
  assert.equal(Q.queueRetryDelayMs(2), 2000);
  assert.equal(Q.queueRetryDelayMs(3), 4000);
  assert.equal(Q.queueRetryDelayMs(50), 5 * 60_000);
});

test('msgr DB 층은 Supabase 오류 코드를 버리지 않고 실어 던진다(영구 판정의 전제)', async () => {
  const { makeDb } = await import('../src/gateway/msgr.mjs');
  const chain = { select() { return chain; }, eq() { return chain; }, is() { return chain; },
    then(res) { return Promise.resolve({ data: null, error: { code: '22P02', message: 'invalid input syntax for type uuid: "x"' } }).then(res); } };
  const db = makeDb({ from: () => chain, rpc: async () => ({ data: null, error: null }) });
  await assert.rejects(() => db.myCrews('u', 'ws'), (e) => e.code === '22P02' && /msgr db: invalid input syntax/.test(e.message));
});
