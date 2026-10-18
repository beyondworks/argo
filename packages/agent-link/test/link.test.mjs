// agent-link 부품 시험 — 가짜 서버(약속 v1 판정 그대로)와 가짜 시계로 받기·진행·승인·효과·업로드·취소·리스·재시작·재시도·유휴 0을 본다.
// 루트 npm test는 test/agent-link.test.mjs가 이 파일을 불러 돌린다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLink, LEASE_RENEW_MS, RETRY } from '../link.mjs';
import { createFakeServer } from './fake-server.mjs';

const AGENT = '7a0e5c11-2b3d-4e5f-8a9b-0c1d2e3f4a02';
const DEV = 'c4d5e6f7-8091-4a2b-9c3d-4e5f6a7b8c03';
const DEV2 = 'd5e6f7a8-9102-4b3c-8d4e-5f6a7b8c9d04';

function fakeClock(start = Date.parse('2026-10-17T06:00:00Z')) {
  let t = start;
  const timers = new Set();
  const clock = {
    now: () => t,
    setTimeout: (fn, ms) => { const h = { at: t + ms, fn }; timers.add(h); return h; },
    clearTimeout: (h) => timers.delete(h),
    sleep: async (ms) => { t += ms; },
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        const due = [...timers].filter((h) => h.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers.delete(due); t = due.at; await due.fn(); await flush();
      }
      t = end;
    },
    pending: () => timers.size,
  };
  return clock;
}
const flush = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

function setup({ turn, canAccept = () => true, device = DEV, clock = fakeClock(), server } = {}) {
  server ??= createFakeServer({ now: clock.now, uid: 'u1' });
  const events = [];
  const calls = { turns: 0 };
  const host = {
    canAccept,
    runTurn: async (offer, ctx) => { calls.turns++; return turn ? turn(offer, ctx) : { text: '완료했습니다' }; },
    onEvent: (name, detail) => events.push({ name, ...detail }),
  };
  const link = createLink({ transport: server.transport, host, uid: 'u1', device, agentIds: new Set([AGENT]), clock });
  return { server, link, host, events, calls, clock };
}

test('offer → accept → 결과: 본체 요청 2번(accept·result), seq 1·2, 세대를 받아 둔다', async () => {
  const { server, link, calls } = setup();
  link.start(); await flush();
  assert.deepEqual([...server.subs.keys()], ['v2:w:u1']); // v2 토픽만 구독(옛 w:·u: 정책은 기기 확인이 없다)
  const o = server.offer({ agent: AGENT });
  server.push(o); await flush();
  assert.equal(calls.turns, 1);
  const mine = server.sent.filter((e) => e.work === o.work);
  assert.deepEqual(mine.map((e) => [e.type, e.seq]), [['work.accept', 1], ['work.result', 2]]);
  assert.equal(server.works.get(o.work).state, 'done');
  assert.equal(server.rpcCount('msgr2_link_send'), 2);
  assert.equal(link.active.length, 0);
});

test('일이 끝나면(결과·오류·취소) 그 일의 진행 방송 채널을 transport.release로 닫는다 — 일마다 연 채널이 쌓이지 않게', async () => {
  const { server, link } = setup({ turn: async (offer, ctx) => { ctx.progress('thinking'); return { text: '끝' }; } });
  const released = [];
  server.transport.release = (topic) => released.push(topic);
  link.start(); await flush();
  const o = server.offer({ agent: AGENT });
  server.push(o); await flush();
  assert.equal(server.works.get(o.work).state, 'done');
  assert.deepEqual(released, [`v2:wk:${o.work}`]);
  delete server.transport.release; // release가 없는 transport(옛 판)도 그대로 돈다
  const o2 = server.offer({ agent: AGENT });
  server.push(o2); await flush();
  assert.equal(server.works.get(o2.work).state, 'done');
});

test('받을 수 없는 본체·만료된 offer·다른 기기·모르는 에이전트 offer는 accept하지 않는다', async () => {
  const a = setup({ canAccept: () => false });
  a.link.start(); await flush();
  a.server.push(a.server.offer({ agent: AGENT })); await flush();
  assert.equal(a.server.rpcCount('msgr2_link_send'), 0);

  const b = setup();
  b.link.start(); await flush();
  b.server.push(b.server.offer({ agent: AGENT, expiresIn: -1000 }));
  b.server.push(b.server.offer({ agent: AGENT, device: DEV2 }));
  b.server.push(b.server.offer({ agent: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }));
  await flush();
  assert.equal(b.server.rpcCount('msgr2_link_send'), 0);
  assert.equal(b.calls.turns, 0);
});

test('같은 offer가 방송과 따라잡기로 두 번 와도 한 번만 받는다', async () => {
  const { server, link, calls } = setup({ turn: () => new Promise(() => {}) });
  link.start(); await flush();
  const o = server.offer({ agent: AGENT });
  server.push(o); server.reconnect(); await flush();
  assert.equal(calls.turns, 1);
  assert.equal(server.sentOf('work.accept', o.work).length, 1);
});

test('사람이 멈춤: 진행 중 턴에 abort 신호, 결과·오류를 보내지 않는다(경우 9)', async () => {
  let seenSignal;
  const { server, link } = setup({ turn: (o, ctx) => new Promise((res, rej) => { seenSignal = ctx.signal; ctx.signal.addEventListener('abort', () => rej(new Error('aborted'))); }) });
  link.start(); await flush();
  const o = server.offer({ agent: AGENT });
  server.push(o); await flush();
  server.cancel(o.work); await flush();
  assert.equal(seenSignal.aborted, true);
  assert.equal(server.sentOf('work.result', o.work).length + server.sentOf('work.error', o.work).length, 0);
  assert.equal(server.works.get(o.work).state, 'cancelled');
});

test('승인: 요청 → 결정을 기다렸다 이어 한다. guest는 요청을 보내지 않고 tier_denied', async () => {
  let decision;
  const { server, link } = setup({ turn: async (o, ctx) => {
    decision = await ctx.requestApproval({ action: 'send_email', risk: 'high', summary: '메일 3통', effect_key: 'mail:1', expires_at: '2026-10-17T07:00:00Z' });
    return { text: `결정 ${decision}` };
  } });
  link.start(); await flush();
  const o = server.offer({ agent: AGENT });
  server.push(o); await flush();
  const req = server.sentOf('work.approval_request', o.work)[0];
  assert.ok(req);
  assert.equal(server.works.get(o.work).state, 'awaiting_approval');
  server.decide(o.work, req.data.approval_id, 'approve'); await flush();
  assert.equal(decision, 'approve');
  assert.equal(server.works.get(o.work).state, 'done');

  let err;
  const g = setup({ turn: async (o2, ctx) => { try { await ctx.requestApproval({ action: 'x', risk: 'low', summary: 's', expires_at: '2026-10-17T07:00:00Z' }); } catch (e) { err = e; } return { text: 'ok' }; } });
  g.link.start(); await flush();
  g.server.push(g.server.offer({ agent: AGENT, tier: 'guest' })); await flush();
  assert.equal(err?.code, 'tier_denied');
  assert.equal(g.server.log.filter((x) => x.args?.p_env?.type === 'work.approval_request').length, 0); // 보내지도 않는다(서버 거부에 기대지 않음)
});

test('효과: intent가 기록된 뒤에만 실행하고 done을 알린다. 이미 있는 키면 실행하지 않는다(D13)', async () => {
  const order = [];
  let runs = 0, blocked;
  const { server, link } = setup({ turn: async (o, ctx) => {
    await ctx.effect('mail:42', 'email', async () => { order.push(server.effects.get('mail:42')); runs++; });
    try { await ctx.effect('mail:42', 'email', async () => { runs++; }); } catch (e) { blocked = e.code; }
    return { text: 'sent' };
  } });
  link.start(); await flush();
  const o = server.offer({ agent: AGENT });
  server.push(o); await flush();
  assert.deepEqual(order, ['intent']); // 실행 순간 서버에는 이미 intent가 있다
  assert.equal(runs, 1);
  assert.equal(blocked, 'effect_exists');
  assert.equal(server.effects.get('mail:42'), 'done');
});

test('효과 실행이 실패하면 failed를 알리고 다시 실행하지 않는다', async () => {
  let runs = 0;
  const { server, link } = setup({ turn: async (o, ctx) => {
    await ctx.effect('pay:1', 'payment', async () => { runs++; throw Object.assign(new Error('boom'), { code: 'internal' }); });
  } });
  link.start(); await flush();
  const o = server.offer({ agent: AGENT });
  server.push(o); await flush();
  assert.equal(runs, 1);
  assert.equal(server.effects.get('pay:1'), 'failed');
  assert.equal(server.sentOf('work.error', o.work)[0].data.code, 'internal');
});

test('업로드 슬롯: 슬롯을 받아 올리고 결과에 슬롯 id를 싣는다. guest는 슬롯을 받지 못한다', async () => {
  const { server, link } = setup({ turn: async (o, ctx) => ({ text: '첨부', files: [await ctx.upload('a.txt', new TextEncoder().encode('hi'), 'text/plain')] }) });
  link.start(); await flush();
  const o = server.offer({ agent: AGENT });
  server.push(o); await flush();
  const res = server.sentOf('work.result', o.work)[0];
  assert.equal(res.data.files.length, 1);
  assert.equal(server.slots.get(res.data.files[0]).put, true);

  let err;
  const g = setup({ turn: async (o2, ctx) => { try { await ctx.upload('a.txt', new Uint8Array(2)); } catch (e) { err = e.code; } return { text: 'x' }; } });
  g.link.start(); await flush();
  g.server.push(g.server.offer({ agent: AGENT, tier: 'guest' })); await flush();
  assert.equal(err, 'tier_denied');
  assert.equal(g.server.rpcCount('msgr2_link_upload_slot'), 0);
});

test('진행 표시: v2:wk:<일> 방송(저장 안 함), 같은 단계·2초 안은 보내지 않는다', async () => {
  const clock = fakeClock();
  const { server, link } = setup({ clock, turn: async (o, ctx) => {
    ctx.progress('thinking'); ctx.progress('thinking'); ctx.progress('tool', 'Write');
    await clock.sleep(2500); ctx.progress('tool', 'Write'); ctx.progress('writing');
    return { text: 'ok' };
  } });
  link.start(); await flush();
  const o = server.offer({ agent: AGENT });
  server.push(o); await flush();
  // thinking(보냄) → 같은 thinking(안 보냄) → 2초 안 tool(안 보냄) → 2.5초 뒤 tool(보냄) → 바로 writing(2초 안이라 안 보냄)
  assert.deepEqual(server.broadcasts.map((b) => [b.topic, b.env.data.stage, b.env.data.note]), [[`v2:wk:${o.work}`, 'thinking', undefined], [`v2:wk:${o.work}`, 'tool', 'Write']]);
  assert.equal(server.sentOf('work.progress').length, 0); // RPC로 가지 않는다
});

test('리스 연장: 일하는 동안 5분마다 accept{lease_gen}, 끝나면 타이머가 사라진다', async () => {
  const clock = fakeClock();
  let release;
  const { server, link } = setup({ clock, turn: () => new Promise((r) => { release = r; }) });
  link.start(); await flush();
  const o = server.offer({ agent: AGENT });
  server.push(o); await flush();
  await clock.advance(LEASE_RENEW_MS * 3 + 1000);
  const acc = server.sentOf('work.accept', o.work);
  assert.equal(acc.length, 4);
  assert.deepEqual(acc.slice(1).map((e) => e.data.lease_gen), [1, 1, 1]);
  assert.ok(server.works.get(o.work).lease.until > clock.now());
  release({ text: '끝' }); await flush();
  assert.equal(server.works.get(o.work).state, 'done');
  assert.equal(clock.pending(), 0);
});

test('리스를 잃으면(연장 거부) 턴을 멈추고 결과를 내지 않는다', async () => {
  const clock = fakeClock();
  let sig;
  const { server, link, events } = setup({ clock, turn: (o, ctx) => new Promise((res) => { sig = ctx.signal; ctx.signal.addEventListener('abort', () => res({ text: '늦은 답' })); }) });
  link.start(); await flush();
  const o = server.offer({ agent: AGENT });
  server.push(o); await flush();
  server.works.get(o.work).lease.gen = 99; // 다른 세대가 리스를 쥐었다
  await clock.advance(LEASE_RENEW_MS + 10); await flush();
  assert.equal(sig.aborted, true);
  assert.equal(server.sentOf('work.result', o.work).length, 0);
  assert.ok(events.some((e) => e.name === 'lease_lost' && e.code === 'lease_held'));
});

test('재시작한 본체는 옛 일을 다시 돌리지 않는다 — 살아 있는 리스·stalled 모두 거부, 턴 0(경우 8)', async () => {
  const clock = fakeClock();
  const server = createFakeServer({ now: clock.now, uid: 'u1' });
  const first = setup({ clock, server, turn: () => new Promise(() => {}) });
  first.link.start(); await flush();
  const o = server.offer({ agent: AGENT });
  server.push(o); await flush();
  first.link.stop(); // 강제 종료와 같다(세대는 메모리와 함께 사라진다)

  const again = setup({ clock, server }); // 같은 기기 id로 다시 켜짐
  again.link.start(); await flush(); // 따라잡기에 옛 offer가 있다
  assert.equal(again.calls.turns, 0, '살아 있는 리스');
  assert.equal(server.works.get(o.work).state, 'accepted');

  await clock.advance(11 * 60 * 1000); // 리스 만료 → stalled
  const third = setup({ clock, server });
  third.link.start(); await flush();
  assert.equal(third.calls.turns, 0, 'stalled');
  assert.equal(server.log.filter((x) => x.args?.p_env?.type === 'work.accept' && x.reply.data?.ok).length, 1); // 성공한 accept는 처음 한 번뿐
});

test('일시 오류(503·429·네트워크)는 같은 id·seq로 다시 보내 결과가 한 번만 남는다(경우 21)', async () => {
  const { server, link } = setup({ turn: async () => { server.failNext({ status: 503 }, { status: 429, code: 'rate_limited' }); return { text: 'ok' }; } });
  link.start(); await flush();
  const o = server.offer({ agent: AGENT });
  server.push(o); await flush();
  const tries = server.log.filter((x) => x.name === 'msgr2_link_send' && x.args.p_env.type === 'work.result');
  assert.equal(tries.length, 3);
  assert.equal(new Set(tries.map((x) => `${x.args.p_env.id}|${x.args.p_env.seq}`)).size, 1);
  assert.equal(server.sentOf('work.result', o.work).length, 1);
});

test('재시도에는 상한이 있다(같은 봉투 최대 RETRY.attempts번)', async () => {
  const { server, link, events } = setup({ turn: async () => { server.failNext(...Array.from({ length: 20 }, () => ({ status: 503 }))); return { text: 'ok' }; } });
  link.start(); await flush();
  server.push(server.offer({ agent: AGENT })); await flush();
  assert.equal(server.log.filter((x) => x.args?.p_env?.type === 'work.result').length, RETRY.attempts);
  assert.ok(events.some((e) => e.name === 'report_failed'));
});

test('기기 폐기·버전 범위 밖은 링크를 멈추고 다시 보내지 않는다, 중단 스위치는 새 offer를 받지 않는다', async () => {
  const a = setup();
  a.server.opts.revoked = true;
  a.link.start(); await flush();
  assert.equal(a.link.stopped, true);
  assert.ok(a.events.some((e) => e.name === 'device_invalid'));

  const b = setup();
  b.server.opts.maxV = 0; // 서버가 v1을 받지 않음
  b.link.start(); await flush();
  b.server.push(b.server.offer({ agent: AGENT })); await flush();
  assert.ok(b.events.some((e) => e.name === 'update_required'));
  assert.equal(b.link.stopped, true);
  assert.equal(b.server.log.filter((x) => x.name === 'msgr2_link_send').length, 1);

  const c = setup();
  c.link.start(); await flush();
  c.server.opts.paused = true;
  c.server.push(c.server.offer({ agent: AGENT })); await flush();
  assert.equal(c.link.paused, true);
  assert.equal(c.calls.turns, 0);
  assert.ok(c.events.some((e) => e.name === 'paused'));
});

// #1074 결함 2: 중단 스위치를 한 번 켰다 끄면 본체를 재시작하기 전까지 offer를 버렸다. 풀리는 신호 두 가지(새 offer 방송·재연결 따라잡기)를 각각 본다.
async function pausedLink() {
  const p = setup();
  p.link.start(); await flush();
  p.server.opts.paused = true;
  const first = p.server.offer({ agent: AGENT });
  p.server.push(first); await flush(); // accept가 service_paused를 받아 멈춘다
  assert.equal(p.link.paused, true);
  assert.equal(p.calls.turns, 0);
  return { ...p, first };
}

test('중단 → 해제 → 새 offer 방송: 다시 받고, 중단 때 거절된 offer도 따라잡기로 한 번 가져온다', async () => {
  const p = await pausedLink();
  const pend0 = p.server.rpcCount('msgr2_link_pending');
  p.server.opts.paused = false;
  const next = p.server.offer({ agent: AGENT });
  p.server.push(next); await flush();
  assert.equal(p.link.paused, false);
  assert.ok(p.events.some((e) => e.name === 'resumed' && e.via === 'offer'));
  assert.equal(p.server.works.get(next.work).state, 'done');
  assert.equal(p.server.works.get(p.first.work).state, 'done'); // 중단 순간에 온 사람 글도 답을 받는다
  assert.equal(p.calls.turns, 2);
  assert.equal(p.server.rpcCount('msgr2_link_pending') - pend0, 1); // 풀릴 때 따라잡기 1번뿐
});

test('중단 → 해제 → 재연결 따라잡기: 따라잡기가 성공하면 풀고 남은 offer를 받는다, 중단 중 재연결은 그대로 멈춰 있다', async () => {
  const p = await pausedLink();
  p.server.reconnect(); await flush(); // 아직 중단 중: 따라잡기도 service_paused
  assert.equal(p.link.paused, true);
  assert.equal(p.server.sentOf('work.accept', p.first.work).length, 0);
  p.server.opts.paused = false;
  p.server.reconnect(); await flush();
  assert.equal(p.link.paused, false);
  assert.ok(p.events.some((e) => e.name === 'resumed' && e.via === 'catch_up'));
  assert.equal(p.server.works.get(p.first.work).state, 'done');
  assert.equal(p.calls.turns, 1);
});

test('중단 중 늦게 온 옛 offer는 accept 1번으로 도로 멈추고, 중단 중 유휴 요청은 0이다', async () => {
  const p = await pausedLink();
  const n0 = p.server.log.length;
  await p.clock.advance(60 * 60 * 1000); // 한 시간 유휴: 풀렸는지 묻는 예비 조회·폴링이 없다(D7)
  assert.equal(p.server.log.length, n0);
  const late = p.server.offer({ agent: AGENT });
  p.server.push(late); await flush(); // 서버는 아직 중단 중
  assert.equal(p.link.paused, true);
  assert.equal(p.calls.turns, 0);
  assert.equal(p.server.rpcCount('msgr2_link_send'), 2); // 처음 offer accept 1 + 늦은 offer accept 1
  assert.equal(p.server.rpcCount('msgr2_link_pending'), 2); // 시작 때 1 + 풀린 줄 알고 1
});

test('모르는 type: 진행 중인 일이면 무시(일이 죽지 않음), 아니면 work.error{unsupported}로 답한다', async () => {
  const { server, link } = setup({ turn: () => new Promise(() => {}) });
  link.start(); await flush();
  const o = server.offer({ agent: AGENT });
  server.push(o); await flush();
  server.push({ ...server.serverEnvelope(o.work, 'work.offer', {}), type: 'work.nudge' }); await flush();
  assert.equal(server.sentOf('work.error', o.work).length, 0);
  assert.equal(server.works.get(o.work).state, 'accepted');

  const other = server.offer({ agent: AGENT });
  server.push({ ...server.serverEnvelope(other.work, 'work.offer', {}), type: 'work.nudge' }); await flush();
  assert.equal(server.sentOf('work.error', other.work)[0]?.data.code, 'unsupported');
});

test('agent.sync는 목록이 바뀔 때만 보낸다(같은 목록이면 요청 0)', async () => {
  const { server, link } = setup();
  const agents = [{ ws: 'acme', slug: 'pm', name: 'PM', role: '', face_hash: null }];
  assert.equal((await link.syncAgents(agents)).sent, true);
  assert.deepEqual(await link.syncAgents(agents), { sent: false });
  assert.equal((await link.syncAgents([...agents, { ...agents[0], slug: 'dev' }])).sent, true);
  assert.equal(server.sentOf('agent.sync').length, 2);
});

test('유휴: 일이 없으면 시간이 지나도 요청 0 — 접속할 때 따라잡기 1번뿐(D7)', async () => {
  const clock = fakeClock();
  const { server, link } = setup({ clock });
  link.start(); await flush();
  await clock.advance(60 * 60 * 1000); await flush();
  assert.equal(server.log.length, 1);
  assert.equal(server.log[0].name, 'msgr2_link_pending');
  server.reconnect(); await flush();
  assert.equal(server.rpcCount('msgr2_link_pending'), 2); // 다시 접속하면 한 번 더
  assert.equal(clock.pending(), 0);
});

test('턴이 코드 있는 오류로 끝나면 work.error(코드·러너만, 원문 없음)', async () => {
  const { server, link } = setup({ turn: async () => { throw Object.assign(new Error('Codex login expired at /Users/x/.codex'), { code: 'login', runner: 'codex' }); } });
  link.start(); await flush();
  const o = server.offer({ agent: AGENT });
  server.push(o); await flush();
  const e = server.sentOf('work.error', o.work)[0];
  assert.deepEqual(e.data, { code: 'login', runner: 'codex' });
  assert.equal(server.works.get(o.work).state, 'failed');
  const { server: s2, link: l2 } = setup({ turn: async () => { throw new Error('ENOENT /secret/path'); } });
  l2.start(); await flush();
  const o2 = s2.offer({ agent: AGENT });
  s2.push(o2); await flush();
  assert.equal(s2.sentOf('work.error', o2.work)[0].data.code, 'internal');
});
