// 본체 연결부의 회의방·외부 봇 경로 — 약속 v1.1(PR #1116: offer.kind meeting·bot, meeting{participants ≤5, rounds 1..2}, result.posts[] ≤10,
// agent.sync features·봇 에이전트, limits hop·max_hops·turns_left, work.error bot_unreachable·bot_limit, 거부 pro_required).
// 서버는 packages/agent-link/test/fake-server.mjs(계약 검사 포함)로, 회의 실행기·봇 호출기는 진짜(meeting-room.mjs·ext-bots.mjs)로 돌린다. 에이전트 턴(chat)만 가짜.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir } from 'node:fs/promises';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-link-meeting-'));
delete process.env.NEXT_PUBLIC_SUPABASE_URL; delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const { createAgentLinkHost, msgrMeetingEnabled, cachedPlanOf, PLAN_CACHE_MS, PLAN_FAIL_MS, botSyncEntry, BOT_SLUG_PREFIX, LINK_FEATURES } = await import('../src/agent-link-host.mjs');
const { runMeeting } = await import('../src/meeting-room.mjs');
const { saveBot, callBot, workErrorCodeFor, _resetBotGates } = await import('../src/ext-bots.mjs');
const { paths } = await import('../src/workspace.mjs');
const { createFakeServer } = await import('../packages/agent-link/test/fake-server.mjs');
const { LIMITS } = await import('../packages/agent-link/contract/v1.mjs');

const flush = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const until = async (cond, ms = 10_000) => { const end = Date.now() + ms; while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 10)); };
const DEVICE = 'c4d5e6f7-8091-4a2b-9c3d-4e5f6a7b8c03';
const BOT_KEY = 'sk-test-link-bot-0001';
const BOT_URL_MARK = '127.0.0.1:';

async function fakeBot(text = '헤르메스 의견') {
  const reqs = [];
  const srv = http.createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    reqs.push({ url: req.url, headers: req.headers, body: JSON.parse(raw) });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text }] }] }));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { reqs, url: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => srv.close(r)) };
}

let wsN = 0;
async function setup({ meeting = true, plan = 'pro', chatImpl = null, bots = [], extra = 0 } = {}) {
  _resetBotGates();
  const ws = `lm-${++wsN}`;
  await mkdir(paths(ws).root, { recursive: true });
  for (const b of bots) await saveBot(ws, { key: BOT_KEY, ...b });
  let t = Date.parse('2026-10-19T06:00:00Z');
  const timers = new Set();
  const clock = { now: () => t, setTimeout: (fn, ms) => { const h = { fn, at: t + ms }; timers.add(h); return h; }, clearTimeout: (h) => timers.delete(h), sleep: async (ms) => { t += ms; },
    advance(ms) { t += ms; } };
  const server = createFakeServer({ now: clock.now, uid: 'u1' });
  const rpc0 = server.transport.rpc;
  server.transport.rpc = async (name, args) => {
    if (name === 'msgr2_device_register') { server.log.push({ name, args }); return { data: { device_id: DEVICE }, error: null }; }
    return rpc0(name, args);
  };
  const calls = { chat: [], interrupt: [], plans: 0, logs: [] };
  const planRef = { plan };
  const agents = [{ ws, slug: 'pm', name: '에이', role: '기획' }, { ws, slug: 'dev', name: '비', role: '개발' }, ...Array.from({ length: extra }, (_, i) => ({ ws, slug: `x${i}`, name: `엑스${i}`, role: '' }))];
  const host = createAgentLinkHost({
    meetingEnabled: () => meeting,
    planOf: async () => { calls.plans += 1; return planRef.plan; },
    meeting: { runMeeting, callBot, workErrorCodeFor },
    getSession: async () => ({ client: {}, uid: 'u1' }),
    listOwnedAgents: async () => agents,
    async listOwnedBots() { const { listBots } = await import('../src/ext-bots.mjs'); return (await listBots(ws)).filter((b) => b.enabled).map((b) => ({ ws, id: b.id, name: b.name, kind: b.kind })); },
    chat: async (w, slug, text, sid, opts) => { calls.chat.push({ ws: w, slug, text, opts }); return chatImpl ? chatImpl(slug, opts) : { reply: `${slug} 의견`, handover: null, artifacts: [] }; },
    onNotify: () => () => {},
    resolveWithFollowUp: async () => {}, resolveApproval: async () => {},
    interruptTurn: async (w, slug, o) => { calls.interrupt.push({ ws: w, slug, ...o }); },
    planReplyFiles: async (w, reply) => ({ body: reply, files: [] }), readReplyFile: async () => new Uint8Array(),
    vaultDir: () => paths(ws).vault, appVersion: '0.1.114',
    transportFor: () => server.transport, clock, linkClock: clock,
    log: (...a) => calls.logs.push(a.join(' ')),
  });
  host.start(); await flush();
  const id = (slug) => server.agentIds.get(`${ws}/${slug}`);
  return { ws, server, host, calls, clock, planRef, id };
}
const meetingOffer = (server, id, { text = '@에이 @비 출시 점검', participants, rounds = 2 } = {}) => {
  const o = server.offer({ agent: id('pm'), text });
  o.data.kind = 'meeting';
  o.data.meeting = { participants: participants ?? [{ agent: id('pm'), name: '에이', role: '기획' }, { agent: id('dev'), name: '비', role: '개발' }], rounds };
  return o;
};

test('켜는 설정 — ARGO_AGENT_LINK=1과 ARGO_MSGR_MEETING=1이 둘 다일 때만(기본 꺼짐)', () => {
  assert.equal(msgrMeetingEnabled({}), false);
  assert.equal(msgrMeetingEnabled({ ARGO_MSGR_MEETING: '1' }), false, '새 연결이 꺼져 있으면 꺼짐');
  assert.equal(msgrMeetingEnabled({ ARGO_AGENT_LINK: '1' }), false);
  assert.equal(msgrMeetingEnabled({ ARGO_AGENT_LINK: '1', ARGO_MSGR_MEETING: 'true' }), false, '정확히 1만');
  assert.equal(msgrMeetingEnabled({ ARGO_AGENT_LINK: '1', ARGO_MSGR_MEETING: ' 1 ' }), true);
});

test('agent.sync — 켜지면 features[meeting, bot]와 봇 에이전트(kind bot·bot.kind)를 싣고, 주소·키는 싣지 않는다. 꺼지면 둘 다 없다(v1.0 모양)', async () => {
  const bot = await fakeBot();
  try {
    const { server, host, ws } = await setup({ bots: [{ id: 'hermes', kind: 'hermes', name: '헤르메스', url: bot.url }] });
    const sync = server.sentOf('agent.sync')[0];
    assert.deepEqual(sync.data.features, LINK_FEATURES.slice());
    const b = sync.data.agents.find((a) => a.kind === 'bot');
    assert.deepEqual(b, { ws, slug: `${BOT_SLUG_PREFIX}hermes`, name: '헤르메스', role: '', face_hash: null, kind: 'bot', bot: { kind: 'hermes' } });
    const raw = JSON.stringify(sync);
    for (const secret of [BOT_KEY, BOT_URL_MARK, 'api_key', 'token', 'url', 'key"']) assert.ok(!raw.includes(secret), `agent.sync에 ${secret} 없음`);
    const botId = server.agentIds.get(`${ws}/${BOT_SLUG_PREFIX}hermes`);
    assert.deepEqual(host.agents.get(botId), { ws, slug: `${BOT_SLUG_PREFIX}hermes`, kind: 'bot', botId: 'hermes', name: '헤르메스' });
    const off = await setup({ meeting: false, bots: [{ id: 'hermes', kind: 'hermes', url: bot.url }] });
    const s0 = off.server.sentOf('agent.sync')[0];
    assert.equal(s0.data.features, undefined);
    assert.ok(s0.data.agents.every((a) => a.kind !== 'bot'), '꺼지면 봇을 알리지 않는다');
  } finally { await bot.close(); }
});

test('botSyncEntry는 종류·이름만 — 저장소 기록에 주소·키가 있어도 옮기지 않는다', () => {
  const e = botSyncEntry({ ws: 'w', id: 'claw', name: '클로', kind: 'openclaw', url: 'http://127.0.0.1:18789', key: BOT_KEY, hasKey: true });
  assert.deepEqual(Object.keys(e).sort(), ['bot', 'face_hash', 'kind', 'name', 'role', 'slug', 'ws']);
  assert.deepEqual(e.bot, { kind: 'openclaw' });
});

test('회의 offer — 참가자 2 × 라운드 2 = posts 4개(round 1·2), text는 요약, handoffs 빈 배열, 계약 검사 통과, 위임 0·일 표지', async () => {
  const { server, calls, id } = await setup();
  const o = meetingOffer(server, id);
  server.push(o); await flush();
  await until(() => server.sentOf('work.result', o.work).length > 0);
  const res = server.sentOf('work.result', o.work)[0].data;
  assert.equal(res.posts.length, 4);
  assert.deepEqual(res.posts.map((p) => p.round).sort(), [1, 1, 2, 2]);
  assert.deepEqual(new Set(res.posts.map((p) => p.agent)), new Set([id('pm'), id('dev')]));
  assert.deepEqual(res.handoffs, []);
  assert.ok(res.text.length <= LIMITS.postsResultText && /에이: /.test(res.text));
  assert.equal(server.works.get(o.work).state, 'done');
  assert.ok(calls.chat.every((c) => c.opts.hop === 2 && c.opts.abortTag === o.work && c.opts.mirrorCtx.scope.work === o.work));
});

// R5 결함 2(2026-10-20): A+ 앱은 회의방 글에 멘션을 붙이지 않는다. 서버는 멘션이 없으면 방의 에이전트 전원을 participants로 보낸다 —
// 본체도 전원을 발언시켜야 한다(종전: runRoomCore 폴백 = 첫 크루 1명·1라운드). 이름 멘션이 있으면 그 사람만, @전체는 전원. 데스크톱 회의실은 종전대로(room-speakers 핀).
const three = (id) => [{ agent: id('pm'), name: '에이', role: '기획' }, { agent: id('dev'), name: '비', role: '개발' }, { agent: id('x0'), name: '엑스0', role: '' }];
test('회의 offer 멘션 없음 — 서버가 보낸 참가자 3명 전원 × 2라운드 = posts 6', async () => {
  const { server, calls, id } = await setup({ extra: 1 });
  const o = meetingOffer(server, id, { text: '분기 계획을 정해 주세요', participants: three(id) });
  server.push(o); await flush();
  await until(() => server.sentOf('work.result', o.work).length > 0);
  const res = server.sentOf('work.result', o.work)[0].data;
  assert.equal(res.posts.length, 6);
  assert.deepEqual(res.posts.map((p) => p.round).sort(), [1, 1, 1, 2, 2, 2]);
  assert.deepEqual(new Set(res.posts.map((p) => p.agent)), new Set([id('pm'), id('dev'), id('x0')]));
  assert.equal(calls.chat.length, 6);
});
test('회의 offer 이름 멘션 1명 — 그 사람만(1라운드 1글), @전체 — 전원', async () => {
  const { server, calls, id } = await setup({ extra: 1 });
  const o = meetingOffer(server, id, { text: '@비 일정만 봐 주세요', participants: three(id) });
  server.push(o); await flush();
  await until(() => server.sentOf('work.result', o.work).length > 0);
  assert.deepEqual(server.sentOf('work.result', o.work)[0].data.posts.map((p) => [p.agent, p.round]), [[id('dev'), 1]]);
  assert.deepEqual(calls.chat.map((c) => c.slug), ['dev']);
  const o2 = meetingOffer(server, id, { text: '@전체 각자 의견', participants: three(id) });
  server.push(o2); await flush();
  await until(() => server.sentOf('work.result', o2.work).length > 0);
  assert.equal(server.sentOf('work.result', o2.work)[0].data.posts.length, 6);
});
test('데스크톱 경로(runMeeting 기본값) — 멘션 없음은 종전대로 첫 에이전트 1명', async () => {
  const st = [];
  const r = await runMeeting({ text: '그냥 질문', participants: [{ kind: 'agent', ref: 'a', ws: 'w', slug: 'a', name: '에이' }, { kind: 'agent', ref: 'b', ws: 'w', slug: 'b', name: '비' }], tag: 't' },
    { chat: async (ws, slug) => { st.push(slug); return { reply: `${slug} 답` }; }, interruptTurn: async () => {}, callBot: async () => ({ text: '' }), mirrorCtxFor: () => ({ kind: 'scope', scope: { kind: 'link', work: 't', room: 'r', owner: true } }) });
  assert.deepEqual(st, ['a']);
  assert.equal(r.posts.length, 1);
});

test('회의 offer rounds 1 — 반응 라운드 없이 참가자당 1개', async () => {
  const { server, id } = await setup();
  const o = meetingOffer(server, id, { rounds: 1 });
  server.push(o); await flush();
  await until(() => server.sentOf('work.result', o.work).length > 0);
  assert.deepEqual(server.sentOf('work.result', o.work)[0].data.posts.map((p) => p.round), [1, 1]);
});

test('회의방 참가자인 봇 — 이름으로 부르면 1라운드에만 글 1개(봇의 서버 에이전트 id로), 가짜 봇 HTTP 1번', async () => {
  const bot = await fakeBot('봇 생각');
  try {
    const { server, id, ws } = await setup({ bots: [{ id: 'hermes', kind: 'hermes', name: '헤르메스', url: bot.url }] });
    const botId = server.agentIds.get(`${ws}/${BOT_SLUG_PREFIX}hermes`);
    const o = meetingOffer(server, id, { text: '@에이 @헤르메스 의견', participants: [{ agent: id('pm'), name: '에이', role: '' }, { agent: botId, name: '헤르메스', role: '' }] });
    server.push(o); await flush();
    await until(() => server.sentOf('work.result', o.work).length > 0);
    const posts = server.sentOf('work.result', o.work)[0].data.posts;
    assert.deepEqual(posts.filter((p) => p.agent === botId).map((p) => [p.round, p.text]), [[1, '봇 생각']]);
    assert.equal(bot.reqs.length, 1);
  } finally { await bot.close(); }
});

test('128KB — 제어 문자 3000자 × 10개 회의 결과도 봉투 상한 안으로 줄여 보낸다(통째로 too_large 거부되어 결과를 모두 잃지 않게)', async () => {
  const ctl = '\u0001'.repeat(3000); // JSON에서 한 글자 = \u0001 6바이트 → 글 10개 ≈ 180KB
  const { server, id, calls } = await setup({ extra: 3, chatImpl: () => ({ reply: ctl, handover: null, artifacts: [] }) });
  const agentsAll = ['pm', 'dev', 'x0', 'x1', 'x2'];
  const o = meetingOffer(server, id, { text: '@전체 의견', participants: agentsAll.map((s) => ({ agent: id(s), name: s, role: '' })) });
  server.push(o); await flush();
  await until(() => calls.chat.length >= 10 && (server.sentOf('work.result', o.work).length > 0 || calls.logs.some((l) => /report_failed/.test(l))));
  await flush();
  assert.ok(!calls.logs.some((l) => /report_failed/.test(l)), `보고 실패 없음: ${calls.logs.join(' | ')}`);
  const sent = server.sentOf('work.result', o.work)[0];
  assert.ok(sent, '결과가 서버에 받아들여졌다(too_large 거부 없음)');
  const bytes = new TextEncoder().encode(JSON.stringify(sent)).length;
  assert.ok(bytes <= LIMITS.envelopeBytes, `${bytes} ≤ 128KB`);
  assert.equal(sent.data.posts.length, agentsAll.length * 2);
  assert.ok(sent.data.posts.every((p) => p.text.length >= 1));
});

test('128KB(최대 크기) — fitResult: 제어 문자 3000자 × 10 + 요약 2000자를 상한 안으로, 보통 글은 건드리지 않는다', async () => {
  const { fitResult } = await import('../packages/agent-link/link.mjs');
  const env = { v: 1, id: crypto.randomUUID(), work: crypto.randomUUID(), seq: 3, type: 'work.result', agent: crypto.randomUUID(), device: DEVICE, at: new Date().toISOString() };
  const ag = crypto.randomUUID();
  const big = { text: '\u0002'.repeat(2000), files: [], handoffs: [], posts: Array.from({ length: 10 }, (_, i) => ({ agent: ag, round: (i % 2) + 1, text: '\u0001'.repeat(3000) })) };
  const out = fitResult(big, (d) => ({ ...env, data: d }));
  assert.ok(new TextEncoder().encode(JSON.stringify({ ...env, data: out })).length <= LIMITS.envelopeBytes);
  assert.equal(out.posts.length, 10, '글 수는 그대로');
  assert.equal(big.posts[0].text.length, 3000, '입력은 바꾸지 않는다');
  const small = { text: '요약', files: [], handoffs: [], posts: [{ agent: ag, round: 1, text: '한글 '.repeat(900) }] };
  assert.deepEqual(fitResult(small, (d) => ({ ...env, data: d })), small);
});

test('봇 offer — kind bot이면 봇 로컬 HTTP 1번, 결과 text = 봇 답(넘김 없음), 세션 키 = 방:봇', async () => {
  const bot = await fakeBot('봇 답');
  try {
    const { server, ws, calls } = await setup({ bots: [{ id: 'hermes', kind: 'hermes', url: bot.url }] });
    const botId = server.agentIds.get(`${ws}/${BOT_SLUG_PREFIX}hermes`);
    const o = server.offer({ agent: botId, text: '요약해 줘' });
    o.data.kind = 'bot'; Object.assign(o.data.limits, { hop: 0, max_hops: 2, turns_left: 4 });
    server.push(o); await flush();
    await until(() => server.sentOf('work.result', o.work).length > 0);
    const res = server.sentOf('work.result', o.work)[0].data;
    assert.equal(res.text, '봇 답'); assert.deepEqual(res.handoffs, []);
    assert.equal(bot.reqs.length, 1);
    assert.equal(bot.reqs[0].headers['x-hermes-session-id'], `argo:${o.data.room}:hermes`);
    assert.equal(calls.chat.length, 0, '에이전트 턴 없음');
  } finally { await bot.close(); }
});

test('봇 offer 한도 — hop > max_hops·turns_left 0이면 부르지 않고 work.error bot_limit, 봇 꺼짐이면 bot_unreachable', async () => {
  const bot = await fakeBot();
  try {
    const { server, ws } = await setup({ bots: [{ id: 'hermes', kind: 'hermes', url: bot.url }, { id: 'gone', kind: 'openclaw', url: 'http://127.0.0.1:9' }] });
    const botId = server.agentIds.get(`${ws}/${BOT_SLUG_PREFIX}hermes`);
    const cases = [{ hop: 2, max_hops: 1, turns_left: 2 }, { hop: 0, max_hops: 2, turns_left: 0 }];
    for (const lim of cases) {
      const o = server.offer({ agent: botId, text: 'x' }); o.data.kind = 'bot'; Object.assign(o.data.limits, lim);
      if (lim.hop > lim.max_hops) { o.data.limits.hop = lim.max_hops; o.data.limits.max_hops = lim.max_hops; o.data.limits.turns_left = 0; } // 계약이 hop>max_hops 봉투를 막으므로 turns_left 0으로 같은 갈래를 본다
      server.push(o); await flush();
      await until(() => server.sentOf('work.error', o.work).length > 0);
      assert.equal(server.sentOf('work.error', o.work)[0].data.code, 'bot_limit');
    }
    assert.equal(bot.reqs.length, 0);
    const goneId = server.agentIds.get(`${ws}/${BOT_SLUG_PREFIX}gone`);
    const o = server.offer({ agent: goneId, text: 'x' }); o.data.kind = 'bot';
    server.push(o); await flush();
    await until(() => server.sentOf('work.error', o.work).length > 0);
    assert.equal(server.sentOf('work.error', o.work)[0].data.code, 'bot_unreachable');
  } finally { await bot.close(); }
});

test('모르는 kind·꺼진 기능은 work.error unsupported(실행 0)', async () => {
  const { server, calls, id } = await setup({ meeting: false });
  const o = meetingOffer(server, id);
  server.push(o); await flush();
  await until(() => server.sentOf('work.error', o.work).length > 0);
  assert.equal(server.sentOf('work.error', o.work)[0].data.code, 'unsupported');
  const on = await setup();
  const o2 = on.server.offer({ agent: on.id('pm'), text: 'x' }); o2.data.kind = 'poll';
  on.server.push(o2); await flush();
  await until(() => on.server.sentOf('work.error', o2.work).length > 0);
  assert.equal(on.server.sentOf('work.error', o2.work)[0].data.code, 'unsupported');
  assert.equal(calls.chat.length + on.calls.chat.length, 0);
});

test('Free 계정 — 회의·봇 offer에 실행 0, work.error tier_denied. 조회 실패(null)는 진행', async () => {
  const { server, calls, id } = await setup({ plan: 'free' });
  const o = meetingOffer(server, id);
  server.push(o); await flush();
  await until(() => server.sentOf('work.error', o.work).length > 0);
  assert.equal(server.sentOf('work.error', o.work)[0].data.code, 'tier_denied');
  assert.equal(calls.chat.length, 0);
  const n = await setup({ plan: null });
  const o2 = meetingOffer(n.server, n.id);
  n.server.push(o2); await flush();
  await until(() => n.server.sentOf('work.result', o2.work).length > 0);
  assert.equal(n.server.sentOf('work.result', o2.work).length, 1);
});

test('pro_required — 링크를 멈추고, 다음 플랜 확인 전에는 기기 등록·agent.sync·따라잡기·구독 갱신 요청 0. 10분 뒤 free면 계속 쉼, 실패는 1분 뒤 다시, Pro면 다시 연다', async () => {
  const { server, host, calls, clock, planRef } = await setup({ plan: 'free' });
  let refresh = 0;
  server.transport.refresh = async () => { refresh += 1; };
  // 서버가 이 계정을 무료로 판정 — 다음 봉투(agent.sync)를 pro_required로 거부
  const rpc1 = server.transport.rpc;
  let reject = true;
  server.transport.rpc = async (name, args) => (reject && name === 'msgr2_link_send' ? { data: { ok: false, code: 'pro_required' } } : rpc1(name, args));
  host.agents.clear();
  await host.link.syncAgents([{ ws: 'x', slug: 'new', name: 'n', role: '', face_hash: null }]).catch((e) => assert.equal(e.code, 'pro_required'));
  await flush();
  assert.equal(host.proBlocked, true);
  assert.equal(host.link, null);
  const before = server.log.length; const plans0 = calls.plans;
  for (let i = 0; i < 59; i++) { clock.advance(10_000); await host.resync(); } // 게이트웨이 확인 10초 × 59 = 9분 50초
  assert.equal(server.log.length, before, '쉬는 동안 서버 요청 0');
  assert.equal(refresh, 0, '구독 갱신도 0');
  assert.equal(calls.plans, plans0, '플랜 확인도 10분 전에는 0');
  server.reconnect(); await flush();
  assert.equal(server.log.length, before, '재접속 신호가 와도 따라잡기 0(링크가 멈췄다)');
  clock.advance(10_000); await host.resync();
  assert.equal(calls.plans, plans0 + 1, '10분째 플랜 1번'); assert.equal(server.log.length, before, 'free면 계속 쉼');
  planRef.plan = null; clock.advance(PLAN_CACHE_MS); await host.resync();
  assert.equal(calls.plans, plans0 + 2);
  clock.advance(PLAN_FAIL_MS - 1000); await host.resync();
  assert.equal(calls.plans, plans0 + 2, '실패 뒤 1분 전에는 다시 안 본다');
  reject = false; planRef.plan = 'pro'; clock.advance(1000); await host.resync(); await flush();
  assert.equal(host.proBlocked, false);
  assert.ok(host.link, '다시 열었다');
  assert.ok(server.log.slice(before).some((x) => x.name === 'msgr2_device_register'), '기기 등록부터 다시');
});

test('요금제 캐시 — 10분 안 같은 계정은 조회 1번, 조회 실패(null)는 캐시하지 않는다', async () => {
  let t = 0; let n = 0; let ret = null;
  const planOf = cachedPlanOf(async () => { n += 1; return ret; }, () => t);
  await planOf('u1'); await planOf('u1');
  assert.equal(n, 2, 'null은 다시 본다');
  ret = 'pro'; await planOf('u1'); await planOf('u1'); t += PLAN_CACHE_MS - 1; await planOf('u1');
  assert.equal(n, 3);
  t += 2; await planOf('u1');
  assert.equal(n, 4, '10분 지나면 다시');
  assert.equal(PLAN_CACHE_MS, 600_000); assert.equal(PLAN_FAIL_MS, 60_000);
});

test('link.mjs — 회의 결과(posts)가 있으면 host가 넘김을 실어도 비우고, 요약은 2000자로 자른다(서버 post_denied 방지)', async () => {
  const { createLink } = await import('../packages/agent-link/link.mjs');
  let t = Date.parse('2026-10-19T06:00:00Z');
  const clock = { now: () => t, setTimeout: (fn, ms) => ({ fn, ms }), clearTimeout: () => {}, sleep: async (ms) => { t += ms; } };
  const server = createFakeServer({ now: clock.now, uid: 'u1' });
  const agent = crypto.randomUUID(); const peer = crypto.randomUUID();
  const link = createLink({ transport: server.transport, uid: 'u1', device: DEVICE, clock, host: {
    canAccept: () => true,
    runTurn: async () => ({ text: '요'.repeat(5000), files: [], handoffs: [{ agent: peer, text: '넘김' }], posts: [{ agent, round: 1, text: '글' }] }),
  } });
  link.start();
  const o = server.offer({ agent }); server.push(o); await flush();
  await until(() => server.sentOf('work.result', o.work).length > 0);
  const d = server.sentOf('work.result', o.work)[0].data;
  assert.deepEqual(d.handoffs, []);
  assert.equal(d.text.length, LIMITS.postsResultText);
  assert.deepEqual(d.posts, [{ agent, round: 1, text: '글' }]);
  link.stop();
});

test('pro_required가 기기 등록에서 와도 같은 쉼 — 다시 등록하지 않고 다음 플랜 확인 전 요청 0', async () => {
  const { server, host, calls, clock, planRef } = await setup({ plan: 'free' });
  host.stop();
  const rpc1 = server.transport.rpc;
  let reject = true;
  server.transport.rpc = async (name, args) => {
    if (reject && name === 'msgr2_device_register') { server.log.push({ name, args }); return { data: { ok: false, code: 'pro_required' }, error: null }; }
    return rpc1(name, args);
  };
  host.start(); await flush();
  assert.equal(host.proBlocked, true);
  const before = server.log.length;
  for (let i = 0; i < 59; i++) { clock.advance(10_000); await host.resync(); }
  assert.equal(server.log.length, before, '쉬는 동안 기기 등록 재시도 0');
  reject = false; planRef.plan = 'pro'; clock.advance(10_000); await host.resync(); await flush();
  assert.ok(host.link && calls.plans >= 1, 'Pro 확인 뒤 다시 연다');
});
