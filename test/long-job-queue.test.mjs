// 장시간 작업 큐(S1) 회귀 — 적재·대기상한·재실행 차단 계약을 잠근다.
// 설계: docs/long-job-queue-design.md. 실제 크루 턴(chat)은 러너 호출이라 여기선 큐 계약만 검증하고,
// 실행·배달은 격리 서버 E2E로 확인한다(커밋 메시지에 근거 기재).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = await mkdtemp(join(tmpdir(), 'argo-jobs-'));
process.env.ARGO_ROOT = ROOT;

const { enqueueLongJob, queueDir, JOBS_QUEUE, JOBS_MAX_PENDING, JOBS_MAX_INFLIGHT, startQueueWorker } = await import('../src/gateway.mjs');

const ws = 'jobco';
await mkdir(join(ROOT, ws), { recursive: true });

test('적재: 큐 파일에 slug·title·prompt·tries=0이 기록된다', async () => {
  const r = await enqueueLongJob(ws, { slug: 'pepper', title: '대량 수집', prompt: '25개 이상 수집하라' });
  assert.ok(r.id);
  const names = (await readdir(queueDir(ws, JOBS_QUEUE))).filter((n) => n.endsWith('.json'));
  assert.equal(names.length, 1);
  const job = JSON.parse(await readFile(join(queueDir(ws, JOBS_QUEUE), names[0]), 'utf8'));
  assert.equal(job.slug, 'pepper');
  assert.equal(job.title, '대량 수집');
  assert.equal(job.tries, 0);
  assert.ok(job.dev, '적재 기기 태그 — 그 기기의 워커만 실행한다');
});

test('대기 상한: 넘으면 거절한다(비용 폭주·큐 폭발 방지)', async () => {
  const ws2 = 'jobco2';
  await mkdir(join(ROOT, ws2), { recursive: true });
  for (let i = 0; i < JOBS_MAX_PENDING; i++) {
    await enqueueLongJob(ws2, { slug: 'a', title: `t${i}`, prompt: 'p' });
  }
  await assert.rejects(() => enqueueLongJob(ws2, { slug: 'a', title: 'over', prompt: 'p' }), /대기 중인 장시간 작업/);
});

test('동시 상한은 1 — 긴 작업이 메신저 응답 슬롯을 다 먹지 않는다', () => {
  assert.equal(JOBS_MAX_INFLIGHT, 1);
});

test('워커 동시 상한 인자가 실제로 적용된다(큐별 분리의 근거)', async () => {
  const ws3 = 'jobco3';
  await mkdir(join(ROOT, ws3), { recursive: true });
  const dir = queueDir(ws3, 'probe');
  await mkdir(dir, { recursive: true });
  for (const n of ['1.json', '2.json', '3.json']) {
    await writeFile(join(dir, n), JSON.stringify({ id: n }));
  }
  let peak = 0, live = 0;
  const stop = startQueueWorker(ws3, 'probe', async () => {
    live += 1; peak = Math.max(peak, live);
    await new Promise((r) => setTimeout(r, 300));
    live -= 1;
  }, { maxInflight: 1 });
  await new Promise((r) => setTimeout(r, 1600));
  stop();
  assert.equal(peak, 1, `동시 실행이 1을 넘었다(peak=${peak})`);
});
