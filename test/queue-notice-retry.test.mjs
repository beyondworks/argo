// 2차 분리 검수 LOW-3·LOW-4(2026-10-05):
// LOW-3 스키마 어긋남 동안 보낸 사람은 최대 24시간 아무 표시도 못 받는다 → 같은 잡이 스키마 어긋남으로 10분 넘게 막히면 onStalled 훅이 한 번 불린다(24시간 상한은 그대로).
// LOW-4 버린 잡의 안내 insert가 일시 실패하면 잡 파일은 이미 지워져 로그만 남았다 → .failed에 '안내 미전송'(noticePending) 표지를 남기고,
//       워커 시작 때와 다음 성공 처리 때(60초에 한 번) 다시 보낸다(안내 키가 멱등이라 중복 없음). 기록당 시도는 NOTICE_RETRY_MAX까지 — DB 위생.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-qnotice-'));
const Q = await import('../src/gateway/queue.mjs');
const { enqueueJob, startQueueWorker, queueDir } = Q;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(pred, ms = 12_000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await pred()) return true; await sleep(100); } return false; }
// 기록 파일이 바뀔 때까지 기다린다 — 고정 대기(300·500ms)는 느린 Windows 러너에서 쓰기가 늦으면 실패했다(10/6). 읽는 순간 쓰는 중이면 다시 본다.
const settled = (pred, ms = 6000) => until(async () => { try { return await pred(); } catch { return false; } }, ms);
const err = (code, message = `x (${code})`) => Object.assign(new Error(message), { code });
const mk = async (WS) => { await mkdir(queueDir(WS, 'msgr'), { recursive: true }); };
const rec = async (WS, name) => JSON.parse(await readFile(join(queueDir(WS, 'msgr'), name), 'utf8'));
const quiet = async (fn) => { const o = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = o; } };

test('LOW-3: 스키마 어긋남으로 stalledAfterMs 넘게 막힌 잡은 onStalled가 정확히 한 번 불린다 — 일반 일시 오류·기준 전에는 부르지 않는다', async () => {
  const WS = 'qn-a'; await mk(WS);
  await enqueueJob(WS, 'msgr', '100-skew', { text: 'skew', createdAt: new Date().toISOString() });
  await enqueueJob(WS, 'msgr', '101-plain', { text: 'plain', createdAt: new Date().toISOString() });
  const stalled = []; const calls = { skew: 0, plain: 0 };
  const stop = startQueueWorker(WS, 'msgr', async (job) => { calls[job.text]++; throw job.text === 'skew' ? err('PGRST202') : new Error('fetch failed'); },
    { stalledAfterMs: 1500, onStalled: async (job, e, info) => { stalled.push([job.text, e.code, info.name]); } });
  await quiet(() => until(() => calls.skew >= 4, 20_000));
  stop();
  assert.ok(calls.skew >= 4 && calls.plain >= 3, `둘 다 여러 번 재시도됐다(${JSON.stringify(calls)})`);
  assert.deepEqual(stalled, [['skew', 'PGRST202', '100-skew.json']], '스키마 어긋남 잡만, 한 번만(이후 재시도에서 또 부르지 않는다)');
  const early = [];
  const WS2 = 'qn-b'; await mk(WS2);
  await enqueueJob(WS2, 'msgr', '102-skew', { text: 'skew', createdAt: new Date().toISOString() });
  let c2 = 0;
  const stop2 = startQueueWorker(WS2, 'msgr', async () => { c2++; throw err('42703'); }, { onStalled: async (job) => { early.push(job.text); } }); // 기본 10분 — 이 테스트 시간 안에는 부르지 않는다
  await quiet(() => until(() => c2 >= 3, 12_000));
  stop2();
  assert.deepEqual(early, [], '기준(10분) 전에는 부르지 않는다');
  assert.equal(Q.SCHEMA_SKEW_NOTICE_AFTER_MS, 10 * 60_000);
  assert.equal(Q.SCHEMA_SKEW_MAX_AGE_MS, 24 * 3_600_000, '24시간 상한은 그대로');
});

test('LOW-3: onStalled가 던져도 큐는 계속 돌고 잡은 큐에 남는다 — 못 보냈으면 다음 실패에 다시 시도하고, 보낸 뒤에는 더 부르지 않는다', async () => {
  const WS = 'qn-c'; await mk(WS);
  await enqueueJob(WS, 'msgr', '103-skew', { text: 'skew', createdAt: new Date().toISOString() });
  let calls = 0; let hook = 0;
  const stop = startQueueWorker(WS, 'msgr', async () => { calls++; throw err('PGRST205'); }, { stalledAfterMs: 1000, onStalled: async () => { hook++; if (hook === 1) throw new Error('안내 쓰기 실패'); } });
  await quiet(() => until(() => calls >= 5, 30_000));
  stop();
  assert.ok(calls >= 5); assert.equal(hook, 2, '첫 시도는 던졌고 다음 실패에서 한 번 더 — 보낸 뒤에는 부르지 않는다');
  assert.equal((await readdir(queueDir(WS, 'msgr'))).filter((n) => n.startsWith('103-skew.json')).length, 1);
});

test('LOW-4: 안내가 실패하면(false 반환·던짐) .failed에 noticePending 표지가 남고, 성공하면 남지 않는다', async () => {
  const WS = 'qn-d'; await mk(WS);
  for (const [id, text] of [['200-ok', 'ok'], ['201-false', 'false'], ['202-throw', 'throw']]) await enqueueJob(WS, 'msgr', id, { text, createdAt: new Date().toISOString() });
  const seen = [];
  const stop = startQueueWorker(WS, 'msgr', async () => { throw err('22P02'); }, { onAbandon: async (job) => { seen.push(job.text); if (job.text === 'false') return false; if (job.text === 'throw') throw new Error('연결 끊김'); } });
  await quiet(() => until(async () => seen.length === 3 && (await readdir(queueDir(WS, 'msgr'))).filter((n) => n.endsWith('.failed')).length === 3));
  assert.ok(await settled(async () => (await rec(WS, '200-ok.json.failed')).noticePending === false && (await rec(WS, '201-false.json.failed')).noticeTries === 1 && (await rec(WS, '202-throw.json.failed')).noticePending === true));
  stop();
  assert.equal((await rec(WS, '200-ok.json.failed')).noticePending, false, '보냈으니 미전송 표지 없음');
  assert.equal((await rec(WS, '201-false.json.failed')).noticePending, true);
  assert.equal((await rec(WS, '202-throw.json.failed')).noticePending, true);
  assert.equal((await rec(WS, '201-false.json.failed')).noticeTries ?? 0, 1, '첫 시도가 기록된다');
});

test('LOW-4: 워커를 다시 시작하면 안내 미전송 기록을 다시 보낸다 — 성공하면 표지가 꺼지고, 실패하면 시도 수가 늘며, 상한을 넘기면 포기', async () => {
  const WS = 'qn-e'; await mk(WS);
  const dir = queueDir(WS, 'msgr');
  const job = { slug: 's', crewId: 'c1', msgId: 7, channelId: 'ch', text: 'x', createdAt: new Date().toISOString() };
  const base = { failedAt: new Date().toISOString(), code: '22P02', reason: 'permanent', error: 'invalid input', job };
  await writeFile(join(dir, '300-p.json.failed'), JSON.stringify({ ...base, noticePending: true, noticeTries: 1 }));
  await writeFile(join(dir, '301-q.json.failed'), JSON.stringify({ ...base, noticePending: true, noticeTries: 1 }));
  await writeFile(join(dir, '302-done.json.failed'), JSON.stringify({ ...base, noticePending: false }));
  await writeFile(join(dir, '303-cap.json.failed'), JSON.stringify({ ...base, noticePending: true, noticeTries: Q.NOTICE_RETRY_MAX }));
  const calls = [];
  const stop = startQueueWorker(WS, 'msgr', async () => {}, { onAbandon: async (j, e, info) => { calls.push({ name: info.name, reason: info.reason, retry: info.retry, code: e.code, msgId: j.msgId }); if (info.name === '301-q.json') return false; } });
  assert.ok(await until(() => calls.length >= 2, 6000));
  assert.ok(await settled(async () => (await rec(WS, '300-p.json.failed')).noticePending === false && (await rec(WS, '301-q.json.failed')).noticeTries === 2));
  await sleep(300); stop(); // 상한 초과분·보낸 것까지 부르지 않는지 볼 여유
  assert.deepEqual(calls.map((c) => c.name).sort(), ['300-p.json', '301-q.json'], '미전송 표지가 있고 상한 안인 기록만 — 보낸 것·상한 초과분은 건드리지 않는다');
  assert.deepEqual(calls[0], { name: calls[0].name, reason: 'permanent', retry: true, code: '22P02', msgId: 7 });
  assert.equal((await rec(WS, '300-p.json.failed')).noticePending, false, '재전송이 성공했으니 표지가 꺼진다');
  const q = await rec(WS, '301-q.json.failed');
  assert.equal(q.noticePending, true); assert.equal(q.noticeTries, 2, '실패하면 시도 수가 늘어난다');
});

test('LOW-4: 다음 성공 처리 때도 한 번 다시 보낸다(시작 때 세션이 없었던 경우) — 성공 직후 연달아 재전송하지 않는다', async () => {
  const WS = 'qn-f'; await mk(WS);
  const dir = queueDir(WS, 'msgr');
  await writeFile(join(dir, '400-p.json.failed'), JSON.stringify({ failedAt: new Date().toISOString(), code: '22P02', reason: 'permanent', error: 'x', job: { slug: 's', crewId: 'c1', msgId: 9, channelId: 'ch' }, noticePending: true, noticeTries: 0 }));
  let tries = 0;
  const stop = startQueueWorker(WS, 'msgr', async () => {}, { onAbandon: async () => { tries++; if (tries === 1) return false; } }); // 시작 때는 실패(세션 없음 같은 일시 실패), 이후는 성공
  assert.ok(await until(() => tries >= 1, 5000));
  assert.equal((await rec(WS, '400-p.json.failed')).noticePending, true, '시작 때 실패 — 표지 유지');
  await enqueueJob(WS, 'msgr', '401-ok', { t: 1, createdAt: new Date().toISOString() }); // 다른 잡의 정상 처리 = 연결이 살아 있다는 신호
  assert.ok(await until(async () => (await rec(WS, '400-p.json.failed')).noticePending === false, 8000), '성공 처리 뒤 재전송되어 표지가 꺼진다');
  assert.equal(tries, 2);
  await enqueueJob(WS, 'msgr', '402-ok', { t: 1, createdAt: new Date().toISOString() }); await sleep(2500); stop();
  assert.equal(tries, 2, '보낸 뒤에는 더 부르지 않는다');
});

// ─── 3차 검수 F3·F5(2026-10-05) ───
test('F3: 훅이 NOTICE_NO_SESSION(세션 없어 호출 못 함)을 돌려주면 시도로 세지 않는다 — 몇 번을 다시 시작해도 표지·시도 수가 그대로고, 성공하면 꺼진다', async () => {
  const WS = 'qn-g'; await mk(WS);
  const dir = queueDir(WS, 'msgr');
  const file = join(dir, '500-p.json.failed');
  await writeFile(file, JSON.stringify({ failedAt: new Date().toISOString(), code: '22P02', reason: 'permanent', error: 'x', job: { slug: 's', crewId: 'c1', msgId: 9, channelId: 'ch' }, noticePending: true, noticeTries: 1 }));
  let calls = 0;
  for (let i = 0; i < Q.NOTICE_RETRY_MAX + 2; i++) {
    const stop = startQueueWorker(WS, 'msgr', async () => {}, { onAbandon: async () => { calls++; return Q.NOTICE_NO_SESSION; } });
    assert.ok(await until(() => calls >= i + 1, 5000));
    await sleep(150); stop();
  }
  const r = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(r.noticePending, true); assert.equal(r.noticeTries, 1, '세션이 없는 동안 시도 수가 늘지 않는다'); assert.ok(!r.noticeGaveUp);
  const stop = startQueueWorker(WS, 'msgr', async () => {}, { onAbandon: async () => true }); // 세션이 생겼다
  assert.ok(await until(async () => (JSON.parse(await readFile(file, 'utf8'))).noticePending === false, 5000));
  stop();
});

test('F3: 버리는 순간 훅이 NOTICE_NO_SESSION이어도 미전송 표지만 남고 시도 수는 0 — onStalled가 NOTICE_NO_SESSION이면 보낸 것으로 치지 않아 다음 실패에 다시 부른다', async () => {
  const WS = 'qn-h'; await mk(WS);
  await enqueueJob(WS, 'msgr', '600-perm', { text: 'perm', createdAt: new Date().toISOString() });
  const stop = startQueueWorker(WS, 'msgr', async () => { throw err('22P02'); }, { onAbandon: async () => Q.NOTICE_NO_SESSION });
  assert.ok(await until(async () => (await readdir(queueDir(WS, 'msgr'))).some((n) => n.endsWith('.failed'))));
  await sleep(300); stop();
  const r = await rec(WS, '600-perm.json.failed');
  assert.equal(r.noticePending, true); assert.equal(r.noticeTries ?? 0, 0);
  const WS2 = 'qn-i'; await mk(WS2);
  await enqueueJob(WS2, 'msgr', '601-skew', { text: 'skew', createdAt: new Date().toISOString() });
  let hook = 0;
  const stop2 = startQueueWorker(WS2, 'msgr', async () => { throw err('PGRST202'); }, { stalledAfterMs: 500, onStalled: async () => { hook++; return hook < 3 ? Q.NOTICE_NO_SESSION : true; } });
  await quiet(() => until(() => hook >= 4, 40_000));
  stop2();
  assert.equal(hook, 3, '세션 없음 두 번은 보낸 것으로 치지 않아 다시 부르고, 세 번째 성공 뒤에는 부르지 않는다');
});

test('F5: 안내가 계속 실패해도 정상 처리 뒤 재전송은 60초에 한 번이다 — 시작 때 1회 + 첫 성공 처리 때 1회, 그 뒤 연속 성공은 부르지 않는다', async () => {
  const WS = 'qn-j'; await mk(WS);
  const dir = queueDir(WS, 'msgr');
  await writeFile(join(dir, '700-p.json.failed'), JSON.stringify({ failedAt: new Date().toISOString(), code: '22P02', reason: 'permanent', error: 'x', job: { slug: 's', crewId: 'c1', msgId: 9, channelId: 'ch' }, noticePending: true, noticeTries: 0 }));
  let tries = 0; let handled = 0;
  const stop = startQueueWorker(WS, 'msgr', async () => { handled++; }, { onAbandon: async () => { tries++; return false; } }); // 계속 실패
  assert.ok(await until(() => tries >= 1, 5000), '시작 때 1회');
  for (let i = 0; i < 4; i++) { await enqueueJob(WS, 'msgr', `70${i + 1}-ok`, { t: 1, createdAt: new Date().toISOString() }); assert.ok(await until(() => handled >= i + 1, 8000)); }
  await sleep(1500); stop();
  assert.equal(tries, 2, '시작 1회 + 첫 성공 처리 1회 — 60초 제한이 없으면 성공마다 불려 5회 상한이 몇 초 만에 소진된다');
  assert.equal((await rec(WS, '700-p.json.failed')).noticeTries, 2);
});

test('F5: 상한(NOTICE_RETRY_MAX)번째 실패에 noticeGaveUp·noticePending:false가 기록되고, 다시 시작해도 더 부르지 않는다', async () => {
  const WS = 'qn-k'; await mk(WS);
  const dir = queueDir(WS, 'msgr');
  await writeFile(join(dir, '800-p.json.failed'), JSON.stringify({ failedAt: new Date().toISOString(), code: '22P02', reason: 'permanent', error: 'x', job: { slug: 's', crewId: 'c1', msgId: 9, channelId: 'ch' }, noticePending: true, noticeTries: Q.NOTICE_RETRY_MAX - 1 }));
  let tries = 0;
  const stop = startQueueWorker(WS, 'msgr', async () => {}, { onAbandon: async () => { tries++; return false; } });
  assert.ok(await until(async () => (await rec(WS, '800-p.json.failed')).noticeGaveUp === true, 5000));
  stop();
  const r = await rec(WS, '800-p.json.failed');
  assert.equal(r.noticeTries, Q.NOTICE_RETRY_MAX); assert.equal(r.noticePending, false); assert.equal(tries, 1);
  const stop2 = startQueueWorker(WS, 'msgr', async () => {}, { onAbandon: async () => { tries++; return false; } });
  await sleep(1500); stop2();
  assert.equal(tries, 1, '포기한 기록은 다시 부르지 않는다');
});
