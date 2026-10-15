// 새 설치 첫 실행(.device-id 없음)에 큐 워커 시작과 첫 적재가 겹쳐도 그 잡은 실행된다(2026-10-15).
// 예전에는 워커와 적재가 서로 다른 기기 ID를 만들어 첫 메신저 잡이 '다른 기기의 잡 사본 — 실행 없이 제거'로 지워졌다(커서는 이미 넘어가 답이 영영 없었다).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from './helpers/tmp.mjs';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-q-firstboot-')); // 빈 루트 — .device-id 없음
const Q = await import('../src/gateway/queue.mjs');

test('첫 실행: 워커 시작과 적재가 같은 순간이어도 잡이 한 번 실행되고 지워지지 않는다', async () => {
  const ws = 'firstboot-q';
  const ran = [];
  const stop = Q.startQueueWorker(ws, 'msgr', async (job) => { ran.push(job.id); });
  try {
    await Q.enqueueJob(ws, 'msgr', '11-00-seoyun', { id: 11 }); // 워커의 첫 ID 읽기가 끝나기 전에 적재(같은 틱)
    const t0 = Date.now();
    while (!ran.length && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(ran, [11], '첫 잡이 실행된다(다른 기기 사본으로 지워지지 않는다)');
    assert.ok((await readFile(join(process.env.ARGO_ROOT, '.device-id'), 'utf8')).trim().length > 0, '신원 파일이 생겼다');
  } finally { stop(); }
});
