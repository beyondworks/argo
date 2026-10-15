// 바쁜 크루 보류(F2, 2026-10-15) — 같은 계정 기기 A가 크루 턴 중에 받은 뒤 글을 로컬 큐에 넣고 서버 커서를 넘긴 채 꺼지면
// 다른 기기 B가 그 글을 영영 보지 못하던 결함. 경우 표: PR 본문. 게이트 B(배포본 대비 수치): test/msgr-busy-hold.gate.mjs.
// 실제 drain·makeMsgrHandler·큐 워커, 가짜 서버(커서·실행권·답글을 기기들이 나눠 쓴다). 임시 ARGO_ROOT — 네트워크·러너·실 Supabase 0.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from './helpers/tmp.mjs';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-busy-hold-'));
process.env.ARGO_ENC_VAULT = '0';
const M = await import('../src/gateway/msgr.mjs');
const Q = await import('../src/gateway/queue.mjs');
const { paths } = await import('../src/workspace.mjs');
const H = await import('./helpers/msgr-busy-harness.mjs');

afterEach(() => H.killAll()); // 실패한 시험이 큐 워커·폴을 남겨 프로세스가 끝나지 않던 것(변이 실험 M1)
const POLL = 10_000; // 보류 재조회 주기를 길게 — 턴 끝 깨우기(crewFreed) 없이는 다음 글이 이만큼 늦는다
async function setup(ws) { await H.seedCompany(paths, ws); return H.makeServer(); }

test('C4 바쁜 동안 온 글은 커서를 넘기지 않는다 → A가 꺼지면 B가 그 글을 집어 한 번 답한다', async () => {
  const ws = 'hold-c4'; const server = await setup(ws);
  const A = await H.startDevice({ M, Q, server, who: 'A', ws, turnMs: 3000, pollMs: POLL });
  server.send(); await A.drainOnce();
  assert.ok(await H.waitStarted(A), `첫 글의 턴이 20초 안에 시작한다(drain ${A.stats().drains}회)`);
  const m12 = server.send(); await A.drainOnce();
  assert.equal(server.row.cursor_msg_id, 11, '바쁜 크루의 뒤 글(12) 앞에서 커서가 멈춘다');
  A.kill(); // A의 큐 워커·폴·깨우기를 멈춘다. 이미 실행권을 잡은 m11 턴은 끝까지 돈다(실행 중 꺼짐 F3는 이 시험 밖)
  // 두 기기가 한 프로세스라 '크루 바쁨' 표지(모듈 메모리)를 함께 쓴다 — 실제로는 기기마다 따로다. A의 m11 턴이 끝나 표지가 풀린 뒤 B가 집게 한다.
  assert.ok(await H.waitPosted(server, 1, 8000));
  const B = await H.startDevice({ M, Q, server, who: 'B', ws, turnMs: 200, pollMs: POLL, queue: false });
  await B.drainOnce(); B.kill();
  assert.ok(await H.waitPosted(server, 2, 8000));
  assert.deepEqual(server.posted.map((p) => [p.msgId, p.who]), [[11, 'A'], [m12, 'B']], '11은 A(실행권), 12는 B');
  assert.equal(server.row.cursor_msg_id, m12);
});

test('C2·C8 한 기기: 바쁜 동안 뒤 글 3개 — 순서·각 1회, 보류 중 다시 읽어도 커서 쓰기 0, 턴 끝 깨우기로 바로 이어 집는다', async () => {
  const ws = 'hold-c2'; const server = await setup(ws);
  const A = await H.startDevice({ M, Q, server, who: 'A', ws, turnMs: 1200, pollMs: POLL });
  server.send(); await A.drainOnce();
  assert.ok(await H.waitStarted(A), `첫 글의 턴이 20초 안에 시작한다(drain ${A.stats().drains}회)`);
  for (let i = 0; i < 3; i++) { server.send(); await A.drainOnce(); }
  const writesHeld = server.counts.A.setCursor ?? 0;
  await A.drainOnce(); await A.drainOnce(); // 같은 글을 다시 읽기만
  assert.equal(server.counts.A.setCursor ?? 0, writesHeld, '보류 중 다시 읽기는 쓰기 0');
  assert.equal(server.row.cursor_msg_id, 11);
  assert.ok(await H.waitPosted(server, 4, 20_000), '폴(10초)을 기다리지 않고 4개 모두 답한다');
  A.kill();
  assert.deepEqual(server.posted.map((p) => p.msgId), [11, 12, 13, 14], '답 순서 보존');
  assert.deepEqual(A.starts.map((s) => s.id), [11, 12, 13, 14]);
  const gaps = server.posted.slice(0, -1).map((p, i) => A.starts[i + 1].at - p.at);
  assert.ok(gaps.every((g) => g < 3000), `앞 답 → 다음 턴 시작이 폴 주기(${POLL}ms)를 기다리지 않는다: ${gaps}`);
});

test('C9 다른 기기가 이 크루 턴을 돌고 있으면(심박 신선) 기다리고, 그 기기 심박이 끊기면 가져간다', async () => {
  const ws = 'hold-c9'; const server = await setup(ws);
  server.send();
  server.executions.set(`${H.CREW}:11`, { attempt: 'other-device', who: 'X', beat: Date.now() }); // 다른 기기 X가 m11 턴 중(실행권·심박)
  server.row.cursor_msg_id = 11; // X가 m11을 적재하며 커서를 넘겼다
  const m12 = server.send();
  const B = await H.startDevice({ M, Q, server, who: 'B', ws, turnMs: 100, pollMs: POLL, queue: false });
  await B.drainOnce();
  assert.equal(server.posted.length, 0, 'X가 살아 있으면 B는 m12를 집지 않는다(앞 턴 결과 없이 동시에 답하지 않게)');
  assert.equal(server.row.cursor_msg_id, 11);
  server.executions.get(`${H.CREW}:11`).beat = Date.now() - M.RUNNING_FRESH_MS - 1000; // X가 꺼졌다 — 심박이 끊김
  await B.drainOnce();
  assert.deepEqual(server.posted.map((p) => [p.msgId, p.who]), [[m12, 'B']]);
});

test('C7 두 기기가 같은 글을 함께 집어도 실행권으로 한 번만 답한다', async () => {
  const ws = 'hold-c7'; const server = await setup(ws);
  const A = await H.startDevice({ M, Q, server, who: 'A', ws, turnMs: 200, pollMs: POLL, queue: false });
  const B = await H.startDevice({ M, Q, server, who: 'B', ws, turnMs: 200, pollMs: POLL, queue: false });
  server.send(); await Promise.all([A.drainOnce(), B.drainOnce()]);
  await H.sleep(500); A.kill(); B.kill();
  assert.equal(server.posted.length, 1);
  assert.equal((server.counts.A.finishExecution ?? 0) + (server.counts.B.finishExecution ?? 0), 1);
});

test('C12 바쁜 크루라도 대상이 아닌 글은 지나간다(커서 전진), 대상 글에서만 멈춘다', async () => {
  const ws = 'hold-c12'; const server = await setup(ws);
  const A = await H.startDevice({ M, Q, server, who: 'A', ws, turnMs: 1500, pollMs: POLL });
  server.send(); await A.drainOnce();
  assert.ok(await H.waitStarted(A), `첫 글의 턴이 20초 안에 시작한다(drain ${A.stats().drains}회)`);
  const chat = server.send(); server.messages.at(-1).mentions = []; // 잡담
  const target = server.send();
  await A.drainOnce();
  assert.equal(server.row.cursor_msg_id, chat, '잡담까지는 전진, 대상 글 앞에서 멈춤');
  assert.ok(await H.waitPosted(server, 2, 10_000)); A.kill();
  assert.deepEqual(server.posted.map((p) => p.msgId), [11, target]);
});

test('C6 새 프로세스(업데이트 재시작)에는 보류 표지가 없다 — 커서부터 다시 읽어 바로 적재한다', async () => {
  const ws = 'hold-c6'; const server = await setup(ws);
  server.row.cursor_msg_id = 10; server.send();
  const A2 = await H.startDevice({ M, Q, server, who: 'A2', ws, turnMs: 100, pollMs: POLL, queue: false });
  await A2.drainOnce(); A2.kill();
  assert.deepEqual(server.posted.map((p) => p.msgId), [11]);
});

test('C17 보류 상한(BUSY_HOLD_MAX_MS)을 넘은 글은 바빠도 배포본처럼 바로 적재한다 — 러너 없는 옛 앱이 양보 기한 뒤 집어 실패 답을 올리기 전에', async () => {
  const ws = 'hold-c17'; const server = await setup(ws);
  const A = await H.startDevice({ M, Q, server, who: 'A', ws, turnMs: 1500, pollMs: POLL });
  server.send(); await A.drainOnce();
  assert.ok(await H.waitStarted(A), `첫 글의 턴이 20초 안에 시작한다(drain ${A.stats().drains}회)`);
  const old = server.send(); server.messages.at(-1).created_at = new Date(Date.now() - M.BUSY_HOLD_MAX_MS - 1000).toISOString();
  await A.drainOnce();
  assert.equal(server.row.cursor_msg_id, old, '상한을 넘은 글은 보류하지 않고 커서를 넘긴다');
  assert.ok(await H.waitPosted(server, 2, 10_000)); A.kill();
  assert.deepEqual(server.posted.map((p) => p.msgId), [11, old]);
});
