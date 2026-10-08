// H1(2026-10-05 분리 검수): 앱이 라이브 마이그레이션보다 먼저 나간 동안(스키마 어긋남) 들어온 메신저 글이
// PGRST202·PGRST204·PGRST205·42883·42703·42P01(함수·열·표 없음)을 '영구 오류'로 분류당해 `.failed`로 빠지고,
// 마이그레이션이 적용된 뒤에도 끝내 답이 오지 않았다. 저장소의 다른 곳(msgr.mjs·msgr-routines.mjs·msgr-work.mjs)은 같은 코드를 '옛 서버'로 본다.
// 잠그는 행동: ① 스키마 없음 계열은 일시 오류 — 큐에 남아 지수 간격으로 기다린다 ② 마이그레이션이 들어오면 그 잡이 처리된다
// ③ 무한 대기 금지 — 잡 나이가 24시간을 넘으면 버린다(버릴 때 onAbandon 안내) ④ 진짜 영구 오류(22P02·42501·PGRST100…)는 그대로 영구.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir } from 'node:fs/promises';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-qskew-'));
const Q = await import('../src/gateway/queue.mjs');
const { enqueueJob, startQueueWorker, queueDir } = Q;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const err = (code, message = `x (${code})`) => Object.assign(new Error(message), { code });
async function until(pred, ms = 12_000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await pred()) return true; await sleep(100); } return false; }
const files = async (WS) => (await readdir(queueDir(WS, 'msgr')).catch(() => []));

test('스키마·함수·열·표 없음 코드는 영구 오류가 아니다 — 진짜 영구 오류는 그대로 영구', () => {
  for (const code of ['PGRST202', 'PGRST204', 'PGRST205', '42883', '42703', '42P01']) {
    assert.equal(Q.isPermanentQueueError(err(code)), false, `${code} — 마이그레이션이 늦은 것이지 같은 결과가 영원히 나오는 오류가 아니다`);
    assert.equal(Q.isSchemaSkewError(err(code)), true, code);
  }
  for (const code of ['22P02', '22001', '23502', '23503', '42501', '42601', 'PGRST100', 'PGRST116', 'PGRST203']) {
    assert.equal(Q.isPermanentQueueError(err(code)), true, `${code} 는 영구`);
    assert.equal(Q.isSchemaSkewError(err(code)), false, code);
  }
  assert.equal(Q.isPermanentQueueError(Object.assign(err('PGRST202'), { permanent: true })), true, '명시 표지는 코드보다 우선');
});

test('스키마 없음 오류는 잡을 .failed로 버리지 않고 큐에 둔다 — 마이그레이션이 적용되면 그 잡이 처리된다', async () => {
  const WS = 'qskew-a';
  await mkdir(join(process.env.ARGO_ROOT, WS), { recursive: true });
  await enqueueJob(WS, 'msgr', '100-seoyun', { text: '보고서 써줘', createdAt: new Date().toISOString() });
  let calls = 0; let migrated = false; let handled = 0; const abandoned = [];
  const handler = async () => { calls++; if (!migrated) throw err('PGRST202', 'Could not find the function public.msgr_crew_context(...) in the schema cache'); handled++; };
  const onAbandon = async (job, e) => { abandoned.push([job, e.code]); };
  const stop = startQueueWorker(WS, 'msgr', handler, { onAbandon });
  await until(() => calls >= 2); // 첫 시도 + 다음 틱 재시도 — 이 사이에 영구로 분류됐다면 둘째 호출은 오지 않는다
  assert.ok(calls >= 2, `스키마 없음은 계속 기다리며 재시도한다(${calls}회)`);
  let names = await files(WS);
  assert.equal(names.filter((n) => n.endsWith('.failed')).length, 0, '실패 기록으로 빠지지 않는다');
  // 재시도 중이면 워커가 잡을 .json.claimed로 쥐고 있다 — 두 상태 모두 '큐에 남음'이다(윈도우 CI에서 이 순간을 읽어 0 !== 1로 흔들림, 10/8)
  assert.equal(names.filter((n) => /\.json(\.claimed)?$/.test(n)).length, 1, '잡은 큐에 남는다');
  assert.deepEqual(abandoned, [], '버리지 않았으니 실패 안내도 없다');
  migrated = true; // 라이브 마이그레이션 적용
  assert.ok(await until(async () => handled === 1 && !(await files(WS)).some((n) => /\.json(\.claimed)?$/.test(n))), '마이그레이션 뒤 잡이 처리되고 큐에서 빠진다');
  stop();
  names = await files(WS);
  assert.equal(names.filter((n) => n.endsWith('.failed')).length, 0);
});

test('스키마 없음 오류의 재시도 간격은 늘어난다 — 1초 고정이 아니다(DB 위생)', async () => {
  const WS = 'qskew-b';
  await mkdir(join(process.env.ARGO_ROOT, WS), { recursive: true });
  await enqueueJob(WS, 'msgr', '101-seoyun', { text: '계속 어긋남', createdAt: new Date().toISOString() });
  let calls = 0;
  const stop = startQueueWorker(WS, 'msgr', async () => { calls++; throw err('42703', 'column msgr_x does not exist'); });
  await sleep(6600);
  stop();
  assert.ok(calls >= 2 && calls <= 4, `6.6초에 ${calls}회 — 고정 1초면 6회`);
  assert.equal((await files(WS)).filter((n) => n.endsWith('.json')).length, 1, '여전히 큐에 있다');
});

test('스키마 어긋남이 24시간을 넘기면 무한 대기하지 않고 버린다 — 버릴 때 onAbandon(안내)이 한 번 불린다', async () => {
  const WS = 'qskew-c';
  await mkdir(join(process.env.ARGO_ROOT, WS), { recursive: true });
  const old = new Date(Date.now() - 25 * 3_600_000).toISOString();
  const fresh = new Date(Date.now() - 1 * 3_600_000).toISOString();
  await enqueueJob(WS, 'msgr', '200-old', { text: '25시간 전', createdAt: old });
  await enqueueJob(WS, 'msgr', '201-fresh', { text: '1시간 전', createdAt: fresh });
  const seen = { '25시간 전': 0, '1시간 전': 0 }; const abandoned = [];
  const handler = async (job) => { seen[job.text]++; throw err('PGRST205', "Could not find the table 'public.msgr_x' in the schema cache"); };
  const onAbandon = async (job, e, info) => { abandoned.push({ text: job.text, code: e.code, name: info?.name, reason: info?.reason }); };
  const stop = startQueueWorker(WS, 'msgr', handler, { onAbandon });
  assert.ok(await until(async () => (await files(WS)).some((n) => n.endsWith('.failed'))), '24시간 넘은 잡은 실패 기록으로 빠진다');
  await sleep(300);
  stop();
  const names = await files(WS);
  assert.equal(seen['25시간 전'], 1, '넘긴 잡은 한 번 더 시도하지 않는다');
  assert.equal(names.filter((n) => n.endsWith('.failed')).length, 1);
  assert.equal(names.filter((n) => n.startsWith('201-fresh.json')).length, 1, '1시간 된 잡은 계속 기다린다');
  assert.deepEqual(abandoned.map((a) => [a.text, a.code, a.name]), [['25시간 전', 'PGRST205', '200-old.json']]);
  assert.equal(abandoned[0].reason, 'schema-age', '버린 이유가 나이 상한임을 알린다');
});

test('진짜 영구 오류로 버릴 때도 onAbandon이 한 번 불린다 — 던지는 안내가 큐를 멈추지 않는다', async () => {
  const WS = 'qskew-d';
  await mkdir(join(process.env.ARGO_ROOT, WS), { recursive: true });
  for (const [id, text] of [['300-a', 'a'], ['301-b', 'b'], ['302-c', 'c']]) await enqueueJob(WS, 'msgr', id, { text, createdAt: new Date().toISOString() });
  const order = [];
  const handler = async (job) => { throw err('22P02', `invalid input syntax for type uuid (${job.text})`); };
  const onAbandon = async (job, e, info) => { order.push([job.text, info.reason]); if (job.text === 'b') throw new Error('안내 쓰기 실패'); };
  const stop = startQueueWorker(WS, 'msgr', handler, { onAbandon });
  // 큐는 .failed를 먼저 쓰고 안내 훅을 부른다 — .failed 개수만 보고 안내 횟수를 검사하면 마지막 안내가 끝나기 전에 검사한다(2차 검수 LOW-1). 안내 호출 수도 기다린다
  assert.ok(await until(async () => order.length === 3 && (await files(WS)).filter((n) => n.endsWith('.failed')).length === 3), '안내가 던져도 세 잡 모두 처리된다');
  stop();
  assert.deepEqual(order.map((o) => o[0]).sort(), ['a', 'b', 'c']);
  assert.ok(order.every((o) => o[1] === 'permanent'));
  assert.equal((await files(WS)).filter((n) => /\.json(\.claimed)?$/.test(n)).length, 0);
});
