// msgr-bot 롱폴 깨움(2026-10-25 쉬는 VPS 봇 호출 줄이기) — wake.js(채널 나눠 쓰기·토픽) + v2.js handleV2 깨움 갈래 + 쉬는 봇 60분 측정(전·후).
// DB 쪽(트리거가 방송·받기 정책·토픽 식이 JS와 같은지)은 test/msgr2-bot-wake-pg.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { handleV2, V2_POLL_MS } from '../supabase/functions/msgr-bot/v2.js';
import { createWakeHub, wakeTopic } from '../supabase/functions/msgr-bot/wake.js';

const V2 = `argo_bot_v2${'cd'.repeat(24)}`;
const W = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';
const up = (id) => ({ update_id: id, message: { message_id: id, execution_attempt: W, chat: { id: ROOM, kind: 'dm' }, text: 'hi' } });
const sha = (s) => createHash('sha256').update(s).digest('hex');

// 가상 시계 하나로 sleep·깨움 기다림을 함께 돌린다. wakes = 방송이 오는 시각(ms) 목록.
function sim({ wakes = [], work = () => [], listenOk = true } = {}) {
  let t = 0; const calls = []; const opened = []; let closed = 0;
  const rpc = async (fn, args) => { calls.push({ fn, at: t }); return work(t, args); };
  const listen = async (topic) => {
    opened.push(topic);
    if (!listenOk) return null;
    return {
      wait: async (ms) => { const next = wakes.find((w) => w > t && w <= t + ms); if (next != null) { t = next; return true; } t += ms; return false; },
      close: () => { closed += 1; },
    };
  };
  return { calls, opened, closed: () => closed, now: () => t, set: (v) => { t = v; }, opts: { now: () => t, sleep: async (ms) => { t += ms; }, listen, topicOf: wakeTopic } };
}

test('토픽: JS wakeTopic = DB _msgr2_bot_wake_topic(_msgr2_hash(토큰)) 식(sha256 hex 두 번)', async () => {
  assert.equal(await wakeTopic(V2), `botw:${sha(`wake:${sha(V2)}`)}`);
  assert.match(await wakeTopic(V2), /^botw:[0-9a-f]{64}$/, '받기 정책 모양(msgr2_bot_wake_recv)');
});

test('깨움: 쉬는 동안 롱폴 1번에 RPC 1회(대기 끝에 RPC 없이 빈 응답), 방송이 오면 그때 RPC → 바로 돌려줌, 채널은 닫는다', async () => {
  const idle = sim();
  const r = await handleV2({ token: V2, method: 'getUpdates', params: { timeout: '50', offset: '0' } }, async (fn, a) => (idle.calls.push({ fn }), []), idle.opts);
  assert.deepEqual(r.body, { ok: true, result: [] });
  assert.equal(idle.calls.length, 1, '쉬는 58초 롱폴에 RPC 1회(종전 13회)'); assert.equal(idle.now(), 58_000);
  assert.deepEqual(idle.opened, [await wakeTopic(V2)]); assert.equal(idle.closed(), 1);

  const s = sim({ wakes: [20_000], work: (t) => (t >= 20_000 ? [up(7)] : []) });
  const got = await handleV2({ token: V2, method: 'getUpdates', params: { timeout: '50', offset: '0' } }, async (fn, a) => { s.calls.push({ fn, at: s.now() }); return s.now() >= 20_000 ? [up(7)] : []; }, s.opts);
  assert.deepEqual(got.body.result, [up(7)]);
  assert.deepEqual(s.calls.map((c) => c.at), [0, 20_000], '방송 시각에 바로 RPC — 받는 지연이 늘지 않는다(종전은 다음 5초 칸)');
  assert.equal(s.now(), 20_000); assert.equal(s.closed(), 1);

  const busy = sim({ wakes: [10_000, 30_000] });
  let n = 0;
  const g2 = await handleV2({ token: V2, method: 'getUpdates', params: { timeout: '50' } }, async () => { n += 1; return n === 3 ? [up(9)] : []; }, busy.opts);
  assert.deepEqual(g2.body.result, [up(9)], '방송 뒤 일이 없으면(다른 기기가 가져감) 다시 기다린다');
  assert.equal(n, 3);
});

test('깨움을 들을 수 없으면(채널 실패·토픽 계산 오류·listen 없음) 종전 5초 폴링 — 받기는 늘 된다', async () => {
  for (const opts of [{ listenOk: false }, {}]) {
    const s = sim(opts);
    const o = opts.listenOk === false ? s.opts : { ...s.opts, listen: null };
    let n = 0;
    await handleV2({ token: V2, method: 'getUpdates', params: { timeout: '50' } }, async () => { n += 1; return []; }, o);
    assert.equal(n, 13, '58초 ÷ 5초 + 1'); assert.equal(s.now(), 58_000);
  }
  const s = sim();
  let n = 0;
  await handleV2({ token: V2, method: 'getUpdates', params: { timeout: '50' } }, async () => { n += 1; return []; }, { ...s.opts, topicOf: async () => { throw new Error('digest'); } });
  assert.equal(n, 13, '토픽 계산이 실패해도 폴링');
  const z = sim(); let m = 0;
  await handleV2({ token: V2, method: 'getUpdates', params: { timeout: '0' } }, async () => { m += 1; return []; }, z.opts);
  assert.equal(m, 1); assert.deepEqual(z.opened, [], 'timeout 0은 채널에 들어가지 않는다');
});

// ── 채널 나눠 쓰기(wake.js createWakeHub) ── 가짜 supabase-js: channel(topic).on(...).subscribe(cb), removeChannel(ch)
function fakeClient({ status = 'SUBSCRIBED' } = {}) {
  const chans = []; const removed = [];
  return {
    chans, removed,
    channel(topic, cfg) { const ch = { topic, cfg, h: null, on(type, filter, h) { this.h = { type, filter, h }; return this; }, subscribe(cb) { if (status) queueMicrotask(() => cb(status)); return this; }, fire() { this.h?.h({}); } }; chans.push(ch); return ch; },
    removeChannel(ch) { removed.push(ch); },
  };
}
function fakeTimers() {
  let id = 0; const live = new Map();
  return { live, setTimer: (fn, ms) => { id += 1; live.set(id, { fn, ms }); return id; }, clearTimer: (i) => { live.delete(i); }, run(ms) { for (const [i, x] of [...live]) if (x.ms <= ms) { live.delete(i); x.fn(); } } };
}

test('채널: 같은 토픽의 겹친 롱폴은 채널 하나(비공개)를 나눠 쓰고, 방송은 둘 다 깨우고, 마지막이 끝나면 잠시 뒤 닫는다', async () => {
  const c = fakeClient(); const tm = fakeTimers();
  const listen = createWakeHub(c, { setTimer: tm.setTimer, clearTimer: tm.clearTimer, lingerMs: 20_000 });
  const a = await listen('botw:x'); const b = await listen('botw:x');
  assert.equal(c.chans.length, 1, '채널 하나'); assert.deepEqual(c.chans[0].cfg, { config: { private: true } });
  assert.deepEqual(c.chans[0].h.filter, { event: 'wake' });
  const wa = a.wait(50_000); const wb = b.wait(50_000);
  c.chans[0].fire();
  assert.deepEqual(await Promise.all([wa, wb]), [true, true]);
  const late = a.wait(1_000); tm.run(1_000); assert.equal(await late, false, '시간이 지나면 false');
  a.close(); assert.equal(c.removed.length, 0, '아직 하나가 듣는다');
  b.close(); b.close(); assert.equal(c.removed.length, 0, '마지막이 끝나도 잠시 열어 둔다(곧 다시 오는 롱폴의 join을 아낀다)');
  const again = await listen('botw:x'); assert.equal(c.chans.length, 1, '열어 둔 채널을 다시 쓴다');
  again.close(); tm.run(20_000); assert.equal(c.removed.length, 1, '잠시 뒤 닫는다');
  await listen('botw:x'); assert.equal(c.chans.length, 2, '닫힌 뒤에는 새로 들어간다');
});

test('채널: 들어가기 실패·응답 없음이면 null(채널 정리) — 처리기는 폴링으로', async () => {
  for (const status of ['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED']) {
    const c = fakeClient({ status }); const tm = fakeTimers();
    assert.equal(await createWakeHub(c, { setTimer: tm.setTimer, clearTimer: tm.clearTimer })('botw:y'), null, status);
    assert.equal(c.removed.length, 1);
  }
  const c = fakeClient({ status: null }); const tm = fakeTimers();
  const p = createWakeHub(c, { setTimer: tm.setTimer, clearTimer: tm.clearTimer, readyMs: 2_500 })('botw:z');
  tm.run(2_500);
  assert.equal(await p, null, '2.5초 안에 들어가지 못하면 포기'); assert.equal(c.removed.length, 1);
});

// ── 쉬는 봇 60분 측정(가짜 서버) — 어댑터는 빈 응답을 받으면 쉬지 않고 바로 다시 부른다(adapter.py _poll_loop·openclaw pollLoop) ──
async function idleHour({ timeoutS, maxWaitMs, wake }) {
  let t = 0; let edge = 0; let rpc = 0;
  const opts = { now: () => t, sleep: async (ms) => { t += ms; }, maxWaitMs, topicOf: wakeTopic,
    listen: wake ? async () => ({ wait: async (ms) => { t += ms; return false; }, close() {} }) : null };
  while (t < 3_600_000) { edge += 1; await handleV2({ token: V2, method: 'getUpdates', params: { timeout: String(timeoutS) } }, async () => { rpc += 1; return []; }, opts); }
  return { edgePerMin: +(edge / 60).toFixed(2), rpcPerMin: +(rpc / 60).toFixed(2) };
}

test('측정: 쉬는 봇 1개 60분 — 종전 엣지 1.2·RPC 13.2/분 → 옛 어댑터 1.05·1.05/분, 새 어댑터(timeout 140) 0.43·0.43/분', async () => {
  const before = await idleHour({ timeoutS: 50, maxWaitMs: 50_000, wake: false }); // 종전 서버(상한 50초, 깨움 없음)를 같은 처리기로 재현
  const oldAdapter = await idleHour({ timeoutS: 50, wake: true });
  const newAdapter = await idleHour({ timeoutS: 140, wake: true });
  assert.deepEqual(before, { edgePerMin: 1.2, rpcPerMin: 13.2 });
  assert.deepEqual(oldAdapter, { edgePerMin: 1.05, rpcPerMin: 1.05 }); // 60분에 63회(이론 60/58 = 1.03 — 마지막 롱폴이 60분을 넘겨 끝나는 몫)
  assert.deepEqual(newAdapter, { edgePerMin: 0.43, rpcPerMin: 0.43 });
  const total = (x) => x.edgePerMin + x.rpcPerMin;
  assert.ok(total(oldAdapter) / total(before) < 0.16, '이미 깔린 어댑터(서버만 바꿈): 요청 합 1/7');
  assert.ok(total(newAdapter) / total(before) < 0.1, '새 어댑터: 1/10 이하');
  assert.equal(V2_POLL_MS, 5_000, '폴링 갈래 간격은 그대로');
});
