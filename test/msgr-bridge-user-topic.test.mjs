// 크루 브리지는 조직 토픽과 함께 u:<자기 uid>도 구독한다 — 서버(20260918184500)가 비공개 방 글·결재·크루 요청을 조직 토픽이 아니라 방 사람·크루 소유자의
// u: 토픽으로만 보내므로, 조직 토픽만 들으면 비공개 방 지시에 폴 주기(15초)만큼 늦게 깬다. 실제 startMsgrBridge를 격리 루트에서 돌린다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-msgr-user-topic-')); // 격리 루트 — 실데이터 미접촉
const { startMsgrBridge, _rtChannelsForTest: rt } = await import('../src/gateway/msgr.mjs');
const { createCompany } = await import('../src/workspace.mjs');

test('브리지: u:<자기 uid>를 구독하고, 그 토픽의 message·approval·crew_request 방송에 즉시 다시 깬다 — 멈추면 구독을 걷는다', async () => {
  const uid = 'owner-uid-1'; const ws = 'user-topic'; await createCompany(ws, '회사', 'x', uid);
  let drains = 0; const topics = []; const handlers = {}; let unsubscribed = 0;
  const db = new Proxy({}, { get: (_, k) => async () => { if (k === 'myCrews') drains += 1; return []; } });
  const client = {
    channel: (topic) => { topics.push(topic); const ch = { on(_t, { event }, fn) { (handlers[`${topic}|${event}`] = fn); return ch; }, subscribe() {}, unsubscribe() { unsubscribed += 1; } }; return ch; },
    rpc: async () => ({ data: [], error: null }),
    from: () => ({ select: () => ({ eq: () => ({ is: async () => ({ data: [], error: null }) }) }) }),
  };
  const stop = startMsgrBridge(ws, { session: async () => ({ uid, db, client }), pollMs: 60_000 });
  for (let i = 0; i < 40 && !topics.includes(`u:${uid}`); i++) await new Promise((r) => setTimeout(r, 25));
  assert.ok(topics.includes(`u:${uid}`), `u:<uid> 구독 (${topics})`);
  for (const ev of ['message', 'approval', 'crew_request']) assert.equal(typeof handlers[`u:${uid}|${ev}`], 'function', `u: ${ev} 처리기`);
  const before = drains;
  handlers[`u:${uid}|message`]();
  for (let i = 0; i < 40 && drains === before; i++) await new Promise((r) => setTimeout(r, 25));
  assert.ok(drains > before, 'u: 방송 한 건에 폴을 기다리지 않고 다시 drain한다');
  stop();
  assert.equal(rt.has(`${ws}:u`), false, '멈추면 u: 구독을 등록부에서 걷는다');
  assert.ok(unsubscribed >= 1, 'u: 채널을 해제한다');
});
