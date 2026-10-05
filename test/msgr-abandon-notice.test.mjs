// H1(2026-10-05 분리 검수) ②: 큐가 '영구 오류'로 메신저 잡을 버릴 때 보낸 사람에게 아무 흔적이 없었다(.failed 파일만 남음).
// 잠그는 행동(실제 큐 워커 + 실제 makeMsgrHandler + 알림 함수를 그대로 이어서 본다):
//   ① 영구 오류로 버린 잡 → 그 채널에 실패 안내 한 줄(system 글, 멱등 client_msg_id = 잡 id 기반) + 활동 기록(events.jsonl)
//   ② 안내 쓰기가 실패해도(던져도) 큐는 멈추지 않는다 — 다음 잡도 처리된다
//   ③ 일시 오류·스키마 없음(PGRST202)은 버리지 않으므로 안내도 없다(재현: 검수자 msgr-job-skew.mjs)
//   ④ gateway.mjs가 메신저 큐 워커에만 이 알림을 연결한다(연결이 빠지면 안내가 조용히 사라진다)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readdir } from 'node:fs/promises';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-qabandon-'));
process.env.ARGO_ENC_VAULT = '0';
const { paths } = await import('../src/workspace.mjs');
const { readEvents } = await import('../src/events.mjs');
const M = await import('../src/gateway/msgr.mjs');
const Q = await import('../src/gateway/queue.mjs');
const { makeMsgrAbandonNotifier } = await import('../src/gateway/msgr-abandon.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(pred, ms = 12_000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await pred()) return true; await sleep(100); } return false; }
const err = (code, message = `msgr db: x (${code})`) => Object.assign(new Error(message), { code });

async function setup(WS, lang = 'ko') {
  const p = paths(WS);
  await mkdir(join(p.root, 'agents'), { recursive: true });
  await writeFile(p.company, JSON.stringify({ id: WS, name: 'x', lang, created: '2026-10-05' }));
  return p;
}
const job = (msgId, extra = {}) => ({ slug: 'seoyun', crewId: 'crew-1', msgId, channelId: 'ch-1', orgId: 'org-1', threadRoot: 77, createdAt: new Date().toISOString(), text: '보고서 써줘', ...extra });
const queued = async (WS) => (await readdir(Q.queueDir(WS, 'msgr')).catch(() => []));

function fakeDb(onContext, { failInsert = () => false } = {}) {
  const calls = { crewContext: 0, rows: [] };
  const db = {
    crewContext: async (...a) => { calls.crewContext++; return onContext(...a); },
    insertMessage: async (row) => { calls.rows.push(row); if (failInsert(row)) throw err('PGRST000', 'msgr db: connection refused'); return { id: 999 }; },
  };
  return { db, calls };
}
function start(WS, db, { runChat = async () => ({ reply: 'ok' }) } = {}) {
  const session = async () => ({ db, uid: 'u1' });
  const handler = M.makeMsgrHandler(WS, { session, runChat });
  return Q.startQueueWorker(WS, 'msgr', handler, { onAbandon: makeMsgrAbandonNotifier(WS, { session }) });
}

test('영구 오류(22P02)로 버린 메신저 잡 — 그 채널에 실패 안내 한 줄과 활동 기록이 남는다', async () => {
  const WS = 'qab-a'; await setup(WS);
  const { db, calls } = fakeDb(() => { throw err('22P02', 'msgr db: invalid input syntax for type uuid: "x"'); });
  await Q.enqueueJob(WS, 'msgr', '100-seoyun', job(100));
  const stop = start(WS, db);
  assert.ok(await until(async () => calls.rows.length >= 1), '안내 글이 들어간다');
  await sleep(1500); // 안내가 두 번 들어가지 않는다(재시도 없음)
  stop();
  assert.equal(calls.crewContext, 1, '영구 오류는 한 번만 실행');
  assert.equal(calls.rows.length, 1);
  const row = calls.rows[0];
  assert.equal(row.channel_id, 'ch-1');
  assert.equal(row.author_kind, 'crew');
  assert.equal(row.crew_id, 'crew-1');
  assert.equal(row.kind, 'system');
  assert.equal(row.reply_to, 100, '보낸 글에 이어서 보인다');
  assert.equal(row.thread_root, 77);
  assert.equal(row.client_msg_id, 'jobfail:crew-1:100-seoyun', '멱등 키 = 잡 id 기반 — 같은 잡이 두 번 버려져도 DB 유니크가 한 줄로 만든다');
  assert.equal(row.body, '이 글은 처리하지 못했어요. 다시 보내 주세요.');
  assert.ok((await queued(WS)).some((n) => n.endsWith('.failed')), '실패 기록(.failed)도 남는다');
  const ev = (await readEvents(WS)).find((e) => e.type === 'turn' && e.ok === false && e.slug === 'seoyun');
  assert.ok(ev, '활동 기록에 오류 한 줄');
  assert.equal(ev.source, 'messenger');
  assert.match(ev.error, /처리하지 못/);
  assert.match(ev.error, /22P02/, '원인 코드가 활동 기록에 남는다(제보용)');
  assert.equal(JSON.stringify(ev).includes('보고서 써줘'), false, '사용자 글 원문은 활동 기록에 싣지 않는다');
});

test('영어 회사는 영어 안내', async () => {
  const WS = 'qab-b'; await setup(WS, 'en');
  const { db, calls } = fakeDb(() => { throw err('23502'); });
  await Q.enqueueJob(WS, 'msgr', '101-seoyun', job(101));
  const stop = start(WS, db);
  assert.ok(await until(async () => calls.rows.length >= 1));
  stop();
  assert.equal(calls.rows[0].body, 'This message could not be processed. Please send it again.');
  assert.match((await readEvents(WS)).find((e) => e.ok === false).error, /could not be processed/);
});

test('안내 쓰기가 실패해도(던져도) 큐는 멈추지 않는다 — 활동 기록은 남고 다음 잡도 처리된다', async () => {
  const WS = 'qab-c'; await setup(WS);
  const { db, calls } = fakeDb(() => { throw err('22P02'); }, { failInsert: () => true });
  for (const id of [102, 103, 104]) await Q.enqueueJob(WS, 'msgr', `${id}-seoyun`, job(id));
  const stop = start(WS, db);
  assert.ok(await until(async () => (await queued(WS)).filter((n) => n.endsWith('.failed')).length === 3), '세 잡 모두 큐에서 빠진다');
  stop();
  assert.equal(calls.rows.length, 3, '잡마다 안내를 시도했다');
  assert.equal((await readEvents(WS)).filter((e) => e.type === 'turn' && e.ok === false).length, 3, '안내가 실패해도 활동 기록은 남는다');
  assert.equal((await queued(WS)).filter((n) => /\.json(\.claimed)?$/.test(n)).length, 0);
});

test('일시 오류·스키마 없음(PGRST202)은 잡을 버리지 않는다 — 안내도 없고 큐에 남는다(검수자 재현: crewContext PGRST202)', async () => {
  const WS = 'qab-d'; await setup(WS);
  const { db, calls } = fakeDb(() => { throw err('PGRST202', 'msgr db: Could not find the function public.msgr_crew_context(...) in the schema cache'); });
  await Q.enqueueJob(WS, 'msgr', '100-seoyun', job(100));
  const stop = start(WS, db);
  await sleep(4500);
  stop();
  assert.ok(calls.crewContext >= 1);
  assert.equal(calls.rows.length, 0, '안내 글 없음 — 아직 버린 것이 아니다');
  const names = await queued(WS);
  assert.equal(names.filter((n) => n.endsWith('.failed')).length, 0, '실패 기록 없음');
  assert.equal(names.filter((n) => n.startsWith('100-seoyun.json')).length, 1, '잡은 큐에 남아 마이그레이션을 기다린다');
  assert.equal((await readEvents(WS)).length, 0);
});

test('알림 함수 단독 — 같은 잡은 같은 키, 잘못된 잡·세션 없음은 던지지 않고 활동 기록만 남긴다', async () => {
  const WS = 'qab-e'; await setup(WS);
  const { db, calls } = fakeDb(() => null);
  const notify = makeMsgrAbandonNotifier(WS, { session: async () => ({ db, uid: 'u1' }) });
  await notify(job(200), err('22P02'), { name: '200-seoyun.json', reason: 'permanent' });
  await notify(job(200), err('22P02'), { name: '200-seoyun.json', reason: 'permanent' });
  assert.deepEqual(calls.rows.map((r) => r.client_msg_id), ['jobfail:crew-1:200-seoyun', 'jobfail:crew-1:200-seoyun']);
  await notify({ slug: 'seoyun', msgId: 201 }, err('22P02'), { name: '201-seoyun.json', reason: 'permanent' }); // 채널·크루 없는 손상 잡
  assert.equal(calls.rows.length, 2, '보낼 곳이 없으면 안내를 시도하지 않는다');
  const noSession = makeMsgrAbandonNotifier(WS, { session: async () => null });
  await noSession(job(202), err('22P02'), { name: '202-seoyun.json', reason: 'permanent' }); // 던지지 않는다
  const throwsSession = makeMsgrAbandonNotifier(WS, { session: async () => { throw new Error('keychain'); } });
  await throwsSession(job(203), err('22P02'), { name: '203-seoyun.json', reason: 'permanent' });
  assert.ok((await readEvents(WS)).filter((e) => e.ok === false).length >= 5, '못 보내도 활동 기록은 항상 남는다');
});

test('gateway.mjs는 메신저 큐 워커에만 이 알림을 연결한다 — 장시간 작업·텔레그램 큐는 그대로', async () => {
  const G = await import('../src/gateway.mjs');
  assert.equal(typeof G.queueWorkerOptions, 'function', '워커 옵션을 만드는 함수가 내보내져 연결을 검증할 수 있다');
  const msgr = G.queueWorkerOptions('ws-x', M.MSGR_KEY);
  assert.equal(typeof msgr.onAbandon, 'function', '메신저 큐: 안내 알림 연결');
  assert.equal(msgr.maxInflight, Q.MSGR_MAX_INFLIGHT, '기존 동시 턴 상한은 그대로');
  const jobs = G.queueWorkerOptions('ws-x', Q.JOBS_QUEUE);
  assert.deepEqual(jobs, { maxInflight: Q.JOBS_MAX_INFLIGHT });
  assert.deepEqual(G.queueWorkerOptions('ws-x', 'telegram'), {});
});
