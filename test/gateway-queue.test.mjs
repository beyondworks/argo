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

test('선점(2026-09-09 실사고): 같은 큐 폴더를 보는 워커 둘이 같은 잡을 두 번 돌리지 않는다 — 배타 선점, 실패 시 선점 해제·재시도, 오래된 선점은 회수', async () => {
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

test('진행 중 동일 ID 재적재: 다른 워커가 활성 선점을 덮지 않고 재적재분은 첫 처리 뒤 실행한다', async () => {
  const WS = 'qco-reenqueue';
  const key = 'msgr';
  const id = '47-shuri';
  await enqueueJob(WS, key, id, { text: '첫 지시' });
  const seen = [];
  let release;
  const firstTurn = new Promise((resolve) => { release = resolve; });
  const handler = async (job) => {
    seen.push(job.text);
    if (job.text === '첫 지시') await firstTurn;
  };
  const stopA = startQueueWorker(WS, key, handler);
  const stopB = startQueueWorker(WS, key, handler);
  try {
    const deadline = Date.now() + 8000;
    while (!seen.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(seen, ['첫 지시'], '첫 실행이 선점을 가진 상태');
    await enqueueJob(WS, key, id, { text: '동일 ID 재적재' });
    await new Promise((r) => setTimeout(r, 2200)); // 두 worker가 재적재분을 스캔할 수 있도록 두 틱 대기
    assert.deepEqual(seen, ['첫 지시'], '재적재가 활성 선점을 덮어 동시 실행해서는 안 된다');
    const { readFile } = await import('node:fs/promises');
    assert.equal(JSON.parse(await readFile(join(queueDir(WS, key), `${id}.json.claimed`), 'utf8')).text, '첫 지시');
    assert.equal(JSON.parse(await readFile(join(queueDir(WS, key), `${id}.json`), 'utf8')).text, '동일 ID 재적재');
    release();
    const completed = Date.now() + 8000;
    while ((await readdir(queueDir(WS, key))).some((n) => /\.json(\.claimed)?$/.test(n)) && Date.now() < completed) await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(seen, ['첫 지시', '동일 ID 재적재'], '성공한 첫 실행 뒤 남은 재적재분을 처리한다');
    assert.equal((await readdir(queueDir(WS, key))).filter((n) => /\.json(\.claimed)?$/.test(n)).length, 0);
  } finally {
    release(); stopA(); stopB();
    await new Promise((r) => setTimeout(r, 100));
  }
});

test('재적재와 실패·DEFER 경합: 실행 중 저장한 체크포인트로 복귀하고 새 선점을 덮지 않는다', async (t) => {
  const { DEFER } = await import('../src/gateway/queue.mjs');
  const { writeJsonAtomic } = await import('../src/jsonstore.mjs');
  for (const outcome of ['failure', 'defer']) await t.test(outcome, async () => {
    const WS = `qco-checkpoint-${outcome}`;
    const key = 'msgr'; const id = '48-shuri';
    await enqueueJob(WS, key, id, { text: '지시' });
    const seen = [];
    const handler = async (job, { path }) => {
      seen.push(job.checkpoint ?? null);
      if (seen.length === 1) {
        await writeJsonAtomic(path, { ...job, checkpoint: '완료된 답변' });
        await enqueueJob(WS, key, id, { text: '지시' });
        if (outcome === 'defer') return DEFER;
        throw new Error('회신 저장 순단');
      }
    };
    const stopA = startQueueWorker(WS, key, handler);
    const stopB = startQueueWorker(WS, key, handler);
    try {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        if (seen.length >= 2 && !(await readdir(queueDir(WS, key))).some((n) => /\.json(\.claimed)?$/.test(n))) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.deepEqual(seen, [null, '완료된 답변'], '재적재본 대신 처리 중 저장한 답변으로 이어서 처리');
      assert.equal((await readdir(queueDir(WS, key))).filter((n) => /\.json(\.claimed)?$/.test(n)).length, 0);
    } finally { stopA(); stopB(); }
  });
});

test('DEFER(순서 대기)·선점 경로 전달: 핸들러가 DEFER를 반환하면 선점을 풀고 다음 틱에 다시 집는다(오류 로그 없음), 핸들러는 두 번째 인자로 선점된 실제 파일 경로를 받는다', async () => {
  const { DEFER } = await import('../src/gateway/queue.mjs');
  const WS = 'qco-defer';
  await mkdir(join(process.env.ARGO_ROOT, WS), { recursive: true });
  const dir = queueDir(WS, 'msgr');
  await enqueueJob(WS, 'msgr', '50-pepper', { text: '대기' });
  const seen = []; let n = 0; const errs = []; const origErr = console.error; console.error = (...a) => { errs.push(a.join(' ')); };
  await enqueueJob(WS, 'msgr', '51-zed', { text: '뒤 잡' }); const later = [];
  const stop = startQueueWorker(WS, 'msgr', async (job, meta) => { if (job.text === '뒤 잡') { later.push(Date.now()); return; } seen.push(meta?.path); return ++n < 3 ? DEFER : undefined; }, { maxInflight: 1 });
  for (let i = 0; i < 40 && n < 3; i++) await new Promise((r) => setTimeout(r, 500)); // 3초 백오프 × 2 + 틱 — 부하에서도 20초 안
  await new Promise((r) => setTimeout(r, 1500));
  stop(); console.error = origErr;
  assert.equal(n, 3, 'DEFER 두 번(3초 백오프) 뒤 세 번째 검사에서 실행');
  assert.equal(later.length, 1, 'DEFER 잡이 앞에 있어도 뒤 잡은 굶지 않는다(백오프 중 스캔 제외·검사 차례는 맨 뒤)');
  assert.ok(seen.every((p) => p === join(dir, '50-pepper.json.claimed')), `선점 파일 경로 전달: ${seen[0]}`);
  assert.equal(errs.filter((e) => e.includes('큐 처리 실패')).length, 0, 'DEFER는 오류가 아니다');
  assert.equal((await readdir(dir).catch(() => [])).filter((x) => /\.json(\.claimed)?$/.test(x)).length, 0, '완료 뒤 흔적 없음');
});

test('선점 mtime(4R C-1): 35분 넘게 큐에 있던 잡을 선점해도 죽은 선점으로 오인·회수되지 않는다 — 한 번만 실행되고 파일이 남지 않는다', async () => {
  const { CLAIM_MAX_AGE_MS } = await import('../src/gateway/queue.mjs');
  const { utimes } = await import('node:fs/promises');
  const WS = 'qco-oldjob';
  await mkdir(join(process.env.ARGO_ROOT, WS), { recursive: true });
  const dir = queueDir(WS, 'msgr');
  await enqueueJob(WS, 'msgr', '77-p', { text: '오래 기다림' });
  const old = new Date(Date.now() - CLAIM_MAX_AGE_MS - 120_000); await utimes(join(dir, '77-p.json'), old, old);
  let n = 0;
  const handler = async () => { n++; await new Promise((r) => setTimeout(r, 2500)); };
  const stop = startQueueWorker(WS, 'msgr', handler);
  const stopOther = startQueueWorker(WS, 'msgr', handler);
  await new Promise((r) => setTimeout(r, 6500));
  stop(); stopOther();
  assert.equal(n, 1, '오래된 잡도 한 번만');
  assert.equal((await readdir(dir).catch(() => [])).filter((x) => /\.json(\.claimed)?$/.test(x)).length, 0, '완료 뒤 파일·선점 흔적 없음');
});


test('장시간 작업 적재: 메신저 발신 경로는 허용 필드만 저장하고 일반 작업 형식은 유지한다', async () => {
  const { enqueueLongJob, JOBS_QUEUE } = await import('../src/gateway/queue.mjs');
  const { readFile } = await import('node:fs/promises');
  const WS = 'qco-long-msgr';
  const origin = { orgId: 'org-a', channelId: 'channel-a', crewId: 'crew-a', threadRoot: 123, uid: 'owner-a', wsId: WS, origin: 'author-a', hop: 2 };
  const { id } = await enqueueLongJob(WS, { slug: 'shuri', title: '분석', prompt: '결과를 같은 채널로 돌려줘', msgr: { ...origin, kind: 'msgr', peers: [{ id: 'peer-a' }], handoffs: [], unrelated: '제외' } });
  const stored = JSON.parse(await readFile(join(queueDir(WS, JOBS_QUEUE), `${id}.json`), 'utf8'));
  assert.deepEqual(stored.msgr, origin, '재기동 뒤에도 발신 채널과 권한 주체를 복원할 최소 필드만 보존');
  const plain = await enqueueLongJob(WS, { slug: 'shuri', title: '일반 작업', prompt: '분석해줘' });
  const plainStored = JSON.parse(await readFile(join(queueDir(WS, JOBS_QUEUE), `${plain.id}.json`), 'utf8'));
  assert.equal(Object.hasOwn(plainStored, 'msgr'), false, '기존 일반 작업에는 메신저 경로를 생성하지 않는다');
  for (const invalid of [{ ...origin, channelId: null }, { ...origin, wsId: 'other-ws' }]) {
    await assert.rejects(() => enqueueLongJob(WS, { slug: 'shuri', title: '잘못된 발신 경로', prompt: '분석해줘', msgr: invalid }), /메신저 작업의 발신 경로/);
  }
  assert.equal((await readdir(queueDir(WS, JOBS_QUEUE))).filter((n) => n.endsWith('.json')).length, 2, '불완전한 메신저 경로를 일반 작업으로 적재하지 않는다');
});
