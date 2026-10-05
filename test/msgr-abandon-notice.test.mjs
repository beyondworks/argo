// H1(2026-10-05 분리 검수) ②: 큐가 '영구 오류'로 메신저 잡을 버릴 때 보낸 사람에게 아무 흔적이 없었다(.failed 파일만 남음).
// 잠그는 행동(실제 큐 워커 + 실제 makeMsgrHandler + 알림 함수를 그대로 이어서 본다):
//   ① 영구 오류로 버린 잡 → 그 채널에 실패 안내 한 줄(system 글, 멱등 client_msg_id = 잡 id 기반) + 활동 기록(events.jsonl)
//   ② 안내 쓰기가 실패해도(던져도) 큐는 멈추지 않는다 — 다음 잡도 처리된다
//   ③ 일시 오류·스키마 없음(PGRST202)은 버리지 않으므로 안내도 없다(재현: 검수자 msgr-job-skew.mjs)
//   ④ gateway.mjs가 메신저 큐 워커에만 이 알림을 연결한다(연결이 빠지면 안내가 조용히 사라진다)
//   ⑤ (2차 검수 LOW-3·4) 영구 오류 안내는 "다시 보내도 같은 결과일 수 있음"을 말하고, 24시간 상한 폐기는 "다시 보내 주세요" — 안내가 일시 실패하면 .failed에 미전송 표지를 남겨 다시 보낸다.
//      스키마 어긋남으로 10분 넘게 막히면 "업데이트 적용 중이라 늦어진다" 안내를 멱등 키 jobwait:<크루>:<잡 id>로 한 번 남긴다(kind system — targetsCrew가 걸러 되먹임 없음)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readdir, readFile } from 'node:fs/promises';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-qabandon-'));
process.env.ARGO_ENC_VAULT = '0';
const { paths } = await import('../src/workspace.mjs');
const { readEvents } = await import('../src/events.mjs');
const M = await import('../src/gateway/msgr.mjs');
const Q = await import('../src/gateway/queue.mjs');
const { makeMsgrAbandonNotifier, makeMsgrStallNotifier } = await import('../src/gateway/msgr-abandon.mjs');
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
  assert.equal(row.body, '이 글은 처리하지 못했어요. 다시 보내 보고, 같은 문제가 계속되면 이 에이전트의 주인에게 알려 주세요.', '영구 오류 — 다시 보내도 같은 결과일 수 있음을 반영(LOW-4)');
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
  assert.equal(calls.rows[0].body, "This message could not be processed. Try sending it again; if it keeps happening, let this agent's owner know.");
  assert.match((await readEvents(WS)).find((e) => e.ok === false).error, /could not be processed/);
});

test('안내 쓰기가 실패해도(던져도) 큐는 멈추지 않는다 — 활동 기록은 남고 다음 잡도 처리된다', async () => {
  const WS = 'qab-c'; await setup(WS);
  const { db, calls } = fakeDb(() => { throw err('22P02'); }, { failInsert: () => true });
  for (const id of [102, 103, 104]) await Q.enqueueJob(WS, 'msgr', `${id}-seoyun`, job(id));
  const stop = start(WS, db);
  // .failed가 먼저 쓰이고 안내는 그 뒤 — 안내 시도 수(rows)와 활동 기록까지 기다린 뒤 검사한다(2차 검수 LOW-1)
  assert.ok(await until(async () => calls.rows.length === 3 && (await readEvents(WS)).filter((e) => e.type === 'turn' && e.ok === false).length === 3
    && (await queued(WS)).filter((n) => n.endsWith('.failed')).length === 3), '세 잡 모두 큐에서 빠진다');
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
  assert.equal(typeof msgr.onStalled, 'function', '메신저 큐: 스키마 어긋남 지연 안내 연결(2차 검수 LOW-3)');
  assert.equal(msgr.maxInflight, Q.MSGR_MAX_INFLIGHT, '기존 동시 턴 상한은 그대로');
  const jobs = G.queueWorkerOptions('ws-x', Q.JOBS_QUEUE);
  assert.deepEqual(jobs, { maxInflight: Q.JOBS_MAX_INFLIGHT });
  assert.deepEqual(G.queueWorkerOptions('ws-x', 'telegram'), {});
});

test('안내 본문 — 영구 오류와 24시간 상한 폐기(schema-age)는 다른 문장, 영어도 같은 구분', async () => {
  const WS = 'qab-g'; await setup(WS); await setup('qab-g-en', 'en');
  const { db, calls } = fakeDb(() => null);
  const ko = makeMsgrAbandonNotifier(WS, { session: async () => ({ db, uid: 'u1' }) });
  const en = makeMsgrAbandonNotifier('qab-g-en', { session: async () => ({ db, uid: 'u1' }) });
  await ko(job(500), err('22P02'), { name: '500-s.json', reason: 'permanent' });
  await ko(job(501), err('PGRST202'), { name: '501-s.json', reason: 'schema-age' });
  await en(job(502), err('22P02'), { name: '502-s.json', reason: 'permanent' });
  await en(job(503), err('PGRST202'), { name: '503-s.json', reason: 'schema-age' });
  assert.deepEqual(calls.rows.map((r) => r.body), [
    '이 글은 처리하지 못했어요. 다시 보내 보고, 같은 문제가 계속되면 이 에이전트의 주인에게 알려 주세요.',
    '이 글은 처리하지 못했어요. 다시 보내 주세요.',
    "This message could not be processed. Try sending it again; if it keeps happening, let this agent's owner know.",
    'This message could not be processed. Please send it again.',
  ]);
});

test('LOW-4: 알림 함수의 반환 — 보냈거나 보낼 곳이 없거나 영구 거부(권한)면 true, 일시 실패면 false, 세션 없음이면 NOTICE_NO_SESSION(모두 다시 보낼 대상)', async () => {
  const WS = 'qab-h'; await setup(WS);
  const mkNotify = (db) => makeMsgrAbandonNotifier(WS, { session: async () => (db ? { db, uid: 'u1' } : null) });
  const okDb = fakeDb(() => null).db;
  assert.equal(await mkNotify(okDb)(job(600), err('22P02'), { name: '600-s.json', reason: 'permanent' }), true);
  assert.equal(await mkNotify(okDb)({ slug: 's', msgId: 1 }, err('22P02'), { name: 'x', reason: 'permanent' }), true, '보낼 곳이 없는 손상 잡 — 다시 보낼 이유가 없다');
  const transient = { insertMessage: async () => { throw err('PGRST000', 'msgr db: connection refused'); } };
  assert.equal(await mkNotify(transient)(job(601), err('22P02'), { name: '601-s.json', reason: 'permanent' }), false);
  const denied = { insertMessage: async () => { throw err('42501', 'msgr db: RLS'); } };
  assert.equal(await mkNotify(denied)(job(602), err('22P02'), { name: '602-s.json', reason: 'permanent' }), true, '권한이 없으면 다시 보내도 같다 — 영구 거부는 재시도 대상이 아니다');
  assert.equal(await mkNotify(null)(job(603), err('22P02'), { name: '603-s.json', reason: 'permanent' }), Q.NOTICE_NO_SESSION, '기기 세션이 아직 없을 수 있다 — 다시 보낼 대상이되 DB 호출이 0건이라 시도로 세지 않는다(3차 F3)');
});

test('LOW-4: 안내가 일시 실패해도 .failed에 미전송 표지가 남고, 워커를 다시 시작하면 같은 멱등 키로 다시 들어간다', async () => {
  const WS = 'qab-i'; await setup(WS);
  let flaky = true; const rows = [];
  const db = { crewContext: async () => { throw err('22P02'); }, insertMessage: async (row) => { if (flaky) throw err('PGRST000', 'msgr db: connection refused'); rows.push(row); return { id: 9 }; } };
  await Q.enqueueJob(WS, 'msgr', '100-seoyun', job(100));
  const stop1 = start(WS, db);
  assert.ok(await until(async () => (await queued(WS)).some((n) => n.endsWith('.failed'))));
  await sleep(500); stop1();
  const rec1 = JSON.parse(await readFile(join(Q.queueDir(WS, 'msgr'), '100-seoyun.json.failed'), 'utf8'));
  assert.equal(rec1.noticePending, true, '안내를 못 보냈다 — 표지');
  assert.deepEqual(rows, []);
  flaky = false; // 연결 복구 + 앱 재시작
  const stop2 = start(WS, db);
  assert.ok(await until(async () => rows.length === 1), '시작 때 다시 보낸다');
  stop2();
  assert.equal(rows[0].client_msg_id, 'jobfail:crew-1:100-seoyun', '같은 멱등 키 — DB 유니크가 중복을 거른다');
  assert.equal((await readEvents(WS)).filter((e) => e.reason === 'queue-abandoned').length, 1, '재전송은 활동 기록을 다시 쓰지 않는다 — 활동 화면에 같은 오류 줄이 쌓이지 않는다(3차 F5)');
  assert.equal(rows[0].body, '이 글은 처리하지 못했어요. 다시 보내 보고, 같은 문제가 계속되면 이 에이전트의 주인에게 알려 주세요.');
});

test('LOW-3: 스키마 어긋남으로 오래 막힌 잡은 "업데이트 적용 중" 안내가 한 번 들어간다(jobwait 키, system) — 잡은 큐에 남아 계속 재시도', async () => {
  const WS = 'qab-j'; await setup(WS); await setup('qab-j-en', 'en');
  for (const [ws, lang] of [[WS, 'ko'], ['qab-j-en', 'en']]) {
    const { db, calls } = fakeDb(() => { throw err('PGRST202', 'msgr db: Could not find the function public.msgr_crew_context'); });
    await Q.enqueueJob(ws, 'msgr', '100-seoyun', job(100));
    const session = async () => ({ db, uid: 'u1' });
    const stop = Q.startQueueWorker(ws, 'msgr', M.makeMsgrHandler(ws, { session }), { stalledAfterMs: 1500, onStalled: makeMsgrStallNotifier(ws, { session }) });
    assert.ok(await until(async () => calls.rows.length >= 1, 20_000), `${lang}: 안내가 들어간다`);
    assert.ok(await until(() => calls.crewContext >= 4, 20_000));
    stop();
    assert.equal(calls.rows.length, 1, `${lang}: 한 번만`);
    const row = calls.rows[0];
    assert.equal(row.client_msg_id, 'jobwait:crew-1:100-seoyun');
    assert.equal(row.kind, 'system', 'system 글 — targetsCrew가 걸러 크루 턴을 다시 만들지 않는다');
    assert.equal(row.channel_id, 'ch-1'); assert.equal(row.reply_to, 100); assert.equal(row.crew_id, 'crew-1');
    assert.equal(row.body, lang === 'ko' ? '업데이트를 적용하는 중이라 답이 늦어지고 있어요. 자동으로 다시 시도합니다.' : 'An update is being applied, so the reply is delayed. It will retry automatically.');
    assert.equal(M.targetsCrew({ ...row, author_kind: 'crew', mentions: [], meta: {} }, { id: 'crew-1' }, new Set(['ch-1'])), false, '되먹임 없음 — 이 안내는 어떤 크루도 겨냥하지 않는다');
    assert.ok((await queued(ws)).some((n) => n.startsWith('100-seoyun.json') && !n.endsWith('.failed')), '잡은 큐에 남아 마이그레이션을 기다린다');
    assert.equal((await readEvents(ws)).length, 0, '버린 것이 아니므로 활동 기록 오류 줄은 없다');
  }
});

test('3차 F3: 기기 세션이 없어 DB 호출을 못 한 채 앱을 여러 번 다시 켜도 시도 상한이 소진되지 않고, 세션이 생기면 안내가 나간다 — 실제 큐 워커 + 실제 알림 함수', async () => {
  const WS = 'qab-k'; await setup(WS);
  const rows = [];
  const db = { crewContext: async () => { throw err('22P02'); }, insertMessage: async (row) => { rows.push(row); return { id: 9 }; } };
  await Q.enqueueJob(WS, 'msgr', '100-seoyun', job(100));
  const noSession = async () => null;
  const run = (session) => Q.startQueueWorker(WS, 'msgr', M.makeMsgrHandler(WS, { session: async () => ({ db, uid: 'u1' }), runChat: async () => ({ reply: 'ok' }) }), { onAbandon: makeMsgrAbandonNotifier(WS, { session }) });
  const file = join(Q.queueDir(WS, 'msgr'), '100-seoyun.json.failed');
  const stop0 = run(noSession); // 버려지는 순간부터 세션이 없다
  assert.ok(await until(async () => (await queued(WS)).some((n) => n.endsWith('.failed'))));
  await sleep(500); stop0();
  for (let i = 0; i < Q.NOTICE_RETRY_MAX + 2; i++) { // 앱을 상한(5)보다 많이 다시 켠다
    const stop = run(noSession); await sleep(300); stop();
  }
  const rec = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(rec.noticePending, true, '아직 보내야 할 안내로 남아 있다');
  assert.equal(rec.noticeTries ?? 0, 0, '세션이 없어 DB 호출이 0건이었다 — 시도로 세지 않는다');
  assert.ok(!rec.noticeGaveUp, '포기 표지가 붙지 않는다');
  assert.deepEqual(rows, []);
  const stop = run(async () => ({ db, uid: 'u1' })); // 세션이 생겼다
  assert.ok(await until(() => rows.length === 1), '세션이 생긴 뒤 시작 때 안내가 나간다');
  await sleep(300); stop();
  assert.equal(rows[0].client_msg_id, 'jobfail:crew-1:100-seoyun');
  assert.equal(JSON.parse(await readFile(file, 'utf8')).noticePending, false);
});
