// 디스크 큐(queue) 단위 — 손상 잡 안전·픽업 순서. 기존 커버리지와 중복 없음:
// gateway.test.mjs = dev 태그 소유권·레거시 연령, long-job-queue.test.mjs = 적재 형식·대기 상한·동시 상한.
// 실행: npm test (node --test). 임시 ARGO_ROOT — 실데이터 미접촉.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-gwqueue-'));
const { enqueueJob, startQueueWorker, queueDir } = await import('../src/gateway/queue.mjs');

test('손상 잡 파일: 실행 없이 제거 — 1초 틱 무한 재시도를 만들지 않는다', async () => {
  const WS = 'qco-corrupt';
  await mkdir(join(process.env.ARGO_ROOT, WS), { recursive: true });
  const dir = queueDir(WS, 'telegram');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, '1.json'), '{"text": "부분 쓰기'); // 크래시로 잘린 JSON 재현
  await enqueueJob(WS, 'telegram', '2', { text: '정상 잡' });
  const ran = [];
  const stop = startQueueWorker(WS, 'telegram', async (job) => { ran.push(job.text); });
  const deadline = Date.now() + 8000;
  for (;;) {
    const left = (await readdir(dir).catch(() => [])).filter((n) => n.endsWith('.json'));
    if (left.length === 0 || Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  stop();
  assert.deepEqual(ran, ['정상 잡'], '손상 잡은 핸들러에 도달하지 않는다');
  const left = (await readdir(dir).catch(() => [])).filter((n) => n.endsWith('.json'));
  assert.equal(left.length, 0, '손상 잡도 큐에서 제거된다(잔류 = 무한 재시도)');
});

test('픽업 순서: update_id 숫자 오름차순(도착 순서 근사), 비숫자(앨범 등)는 사전순으로 앞', async () => {
  const WS = 'qco-order';
  await mkdir(join(process.env.ARGO_ROOT, WS), { recursive: true });
  const dir = queueDir(WS, 'telegram');
  // 일부러 어긋난 순서로 적재 — '10' < '2'가 되는 사전순 함정을 잠근다
  for (const id of ['10', '2', '9', 'alb-b', 'alb-a']) {
    await enqueueJob(WS, 'telegram', id, { text: id });
  }
  const ran = [];
  const stop = startQueueWorker(WS, 'telegram', async (job) => { ran.push(job.text); }, { maxInflight: 1 }); // 동시 1 = 픽업 순서가 곧 실행 순서
  const deadline = Date.now() + 12_000;
  for (;;) {
    const left = (await readdir(dir).catch(() => [])).filter((n) => n.endsWith('.json'));
    if ((left.length === 0 && ran.length >= 5) || Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  stop();
  assert.deepEqual(ran, ['alb-a', 'alb-b', '2', '9', '10'],
    'parseInt(NaN→0)인 앨범 잡이 먼저(사전순), 숫자 잡은 수치 오름차순 — 지시가 도착 순서로 실행된다');
});
