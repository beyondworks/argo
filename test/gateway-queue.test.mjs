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

test('선점(2026-09-09 실사고): 같은 큐 폴더를 보는 워커 둘이 같은 잡을 두 번 돌리지 않는다 — rename 선점, 실패 시 선점 해제·재시도, 오래된 선점은 회수', async () => {
  const { CLAIM_MAX_AGE_MS } = await import('../src/gateway/queue.mjs');
  const { rename, utimes } = await import('node:fs/promises');
  const WS = 'qco-claim';
  await mkdir(join(process.env.ARGO_ROOT, WS), { recursive: true });
  const dir = queueDir(WS, 'msgr');
  await enqueueJob(WS, 'msgr', '44-pepper', { text: '멘션' });
  const ran = [];
  const slow = async (job) => { ran.push(job.text); await new Promise((r) => setTimeout(r, 2500)); };
  const stopA = startQueueWorker(WS, 'msgr', slow); const stopB = startQueueWorker(WS, 'msgr', slow);
  await new Promise((r) => setTimeout(r, 4500));
  stopA(); stopB();
  assert.deepEqual(ran, ['멘션'], '워커가 둘이어도 한 번만 실행');
  assert.equal((await readdir(dir).catch(() => [])).filter((n) => /\.json(\.claimed)?$/.test(n)).length, 0, '완료 뒤 파일·선점 흔적 없음');
  // 인프라 예외 → 선점 해제(.json 복귀) → 재시도
  await enqueueJob(WS, 'msgr', '45-pepper', { text: '재시도' });
  let calls = 0;
  const flaky = async () => { calls++; if (calls === 1) throw new Error('infra'); };
  const stopC = startQueueWorker(WS, 'msgr', flaky);
  await new Promise((r) => setTimeout(r, 3500));
  stopC();
  assert.equal(calls, 2, '첫 실패 뒤 다음 틱에 재시도(선점이 풀렸다)');
  // 죽은 워커의 오래된 선점은 회수된다
  await enqueueJob(WS, 'msgr', '46-pepper', { text: '고아' });
  await rename(join(dir, '46-pepper.json'), join(dir, '46-pepper.json.claimed'));
  const old = new Date(Date.now() - CLAIM_MAX_AGE_MS - 60_000); await utimes(join(dir, '46-pepper.json.claimed'), old, old);
  const ran2 = [];
  const stopD = startQueueWorker(WS, 'msgr', async (job) => { ran2.push(job.text); });
  await new Promise((r) => setTimeout(r, 3500));
  stopD();
  assert.deepEqual(ran2, ['고아'], '오래된 선점 회수 → 재실행');
});

test('DEFER(순서 대기)·선점 경로 전달: 핸들러가 DEFER를 반환하면 선점을 풀고 다음 틱에 다시 집는다(오류 로그 없음), 핸들러는 두 번째 인자로 선점된 실제 파일 경로를 받는다', async () => {
  const { DEFER } = await import('../src/gateway/queue.mjs');
  const WS = 'qco-defer';
  await mkdir(join(process.env.ARGO_ROOT, WS), { recursive: true });
  const dir = queueDir(WS, 'msgr');
  await enqueueJob(WS, 'msgr', '50-pepper', { text: '대기' });
  const seen = []; let n = 0; const errs = []; const origErr = console.error; console.error = (...a) => { errs.push(a.join(' ')); };
  const stop = startQueueWorker(WS, 'msgr', async (job, meta) => { seen.push(meta?.path); return ++n < 3 ? DEFER : undefined; });
  await new Promise((r) => setTimeout(r, 4500));
  stop(); console.error = origErr;
  assert.equal(n, 3, 'DEFER 두 번 뒤 세 번째 틱에 실행');
  assert.ok(seen.every((p) => p === join(dir, '50-pepper.json.claimed')), `선점 파일 경로 전달: ${seen[0]}`);
  assert.equal(errs.filter((e) => e.includes('큐 처리 실패')).length, 0, 'DEFER는 오류가 아니다');
  assert.equal((await readdir(dir).catch(() => [])).filter((x) => /\.json(\.claimed)?$/.test(x)).length, 0, '완료 뒤 흔적 없음');
});
