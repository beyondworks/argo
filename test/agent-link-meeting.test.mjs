// 본체 연결부의 회의방·외부 봇 경로(A+) — 켜는 설정(ARGO_MSGR_MEETING), Free 경로 0, 참여자 대응, 결과 모양(약속 v1.1 확정 전 가정), 끝에서 끝까지(진짜 회의 실행기 + 진짜 봇 호출기 + 가짜 봇 서버).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir } from 'node:fs/promises';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-link-meeting-'));
delete process.env.NEXT_PUBLIC_SUPABASE_URL; delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const { msgrMeetingEnabled, meetingOf, runMeetingOffer, cachedPlanOf, PLAN_CACHE_MS } = await import('../src/agent-link-host.mjs');
const { runMeeting } = await import('../src/meeting-room.mjs');
const { saveBot, callBot } = await import('../src/ext-bots.mjs');
const { paths } = await import('../src/workspace.mjs');

const offerOf = (data = {}) => ({ work: 'work-1', agent: 'srv-a', data: { room: 'room-1', text: '@에이 @헤르메스 의견', memory: true, limits: { tier: 'owner', max_turn_s: 900 }, room_kind: 'meeting', participants: [{ kind: 'agent', agent: 'srv-a', name: '에이' }, { kind: 'agent', agent: 'srv-x', name: '다른 기기' }, { kind: 'bot', bot: 'hermes', name: '헤르메스' }], ...data } });
const ctxOf = (signal = new AbortController().signal) => ({ tier: 'owner', signal, progress: () => {} });
const AGENTS = new Map([['srv-a', { ws: 'lm-ws', slug: 'a1', name: '에이' }]]);

function spyDeps(plan = 'pro') {
  const st = { meetings: [], chats: [], bots: [], plans: 0 };
  return { st, deps: {
    uid: 'u1',
    planOf: async () => { st.plans += 1; return plan; },
    runMeeting: async (input, d) => { st.meetings.push({ input, d }); return { posts: [{ ref: 'srv-a', kind: 'agent', text: '답' }, { ref: 'hermes', kind: 'bot', text: '봇 답' }, { ref: 'srv-a', kind: 'agent', text: '반응', round: 2 }], notes: [{ code: 'round', text: 'x' }], stopped: null }; },
    chat: async (...a) => { st.chats.push(a); return { reply: 'r' }; },
    interruptTurn: async () => {},
    callBot: async (...a) => { st.bots.push(a); return { text: 'b' }; },
    resolveBot: async (ref) => (ref === 'hermes' ? { ws: 'lm-ws', id: 'hermes', name: 'Hermes' } : null),
  } };
}

test('켜는 설정 — ARGO_AGENT_LINK=1과 ARGO_MSGR_MEETING=1이 둘 다일 때만(기본 꺼짐)', () => {
  assert.equal(msgrMeetingEnabled({}), false);
  assert.equal(msgrMeetingEnabled({ ARGO_MSGR_MEETING: '1' }), false, '새 연결이 꺼져 있으면 꺼짐');
  assert.equal(msgrMeetingEnabled({ ARGO_AGENT_LINK: '1' }), false);
  assert.equal(msgrMeetingEnabled({ ARGO_AGENT_LINK: '1', ARGO_MSGR_MEETING: 'true' }), false, '정확히 1만');
  assert.equal(msgrMeetingEnabled({ ARGO_AGENT_LINK: '1', ARGO_MSGR_MEETING: ' 1 ' }), true);
});

test('회의방 일 판정 — room_kind meeting + participants 배열일 때만, 모양이 틀린 참여자는 버린다', () => {
  assert.equal(meetingOf({ data: { text: 'x' } }), null, '1:1 일');
  assert.equal(meetingOf({ data: { room_kind: 'meeting' } }), null);
  assert.deepEqual(meetingOf({ data: { room_kind: 'meeting', participants: [{ kind: 'agent', agent: 'a' }, { kind: 'bot' }, null, { kind: 'x', agent: 'b' }] } }).participants, [{ kind: 'agent', agent: 'a' }]);
});

test('Free 계정 — 회의 실행기·에이전트 턴·봇 호출 0, tier_denied', async () => {
  const { st, deps } = spyDeps('free');
  const offer = offerOf();
  await assert.rejects(runMeetingOffer(offer, ctxOf(), { agents: AGENTS, deps, meeting: meetingOf(offer) }), { code: 'tier_denied' });
  assert.equal(st.meetings.length + st.chats.length + st.bots.length, 0);
});

test('Pro·체험·조회 실패(null)는 진행한다 — 서버 판정이 권위, 일시 오류로 막지 않는다', async () => {
  for (const plan of ['pro', 'trial', null]) {
    const { st, deps } = spyDeps(plan);
    const offer = offerOf();
    await runMeetingOffer(offer, ctxOf(), { agents: AGENTS, deps, meeting: meetingOf(offer) });
    assert.equal(st.meetings.length, 1, String(plan));
  }
});

test('참여자 대응·결과 모양 — 이 기기 에이전트와 봇만, posts는 agent|bot 표지, 넘김은 막는다(R9), 일 표지·세션 키·시간 상한 전달', async () => {
  const { st, deps } = spyDeps();
  const offer = offerOf();
  const out = await runMeetingOffer(offer, ctxOf(), { agents: AGENTS, deps, meeting: meetingOf(offer) });
  const { input, d } = st.meetings[0];
  assert.deepEqual(input.participants, [
    { kind: 'agent', ref: 'srv-a', ws: 'lm-ws', slug: 'a1', name: '에이' },
    { kind: 'bot', ref: 'hermes', ws: 'lm-ws', id: 'hermes', name: '헤르메스' },
  ], '다른 기기 에이전트(srv-x)는 빠진다');
  assert.equal(input.tag, 'work-1'); assert.equal(input.sessionKey, 'argo:room-1'); assert.equal(input.maxTurnS, 900);
  assert.deepEqual(d.mirrorCtxFor(), { kind: 'scope', scope: { kind: 'link', work: 'work-1', room: 'room-1', owner: true } });
  assert.deepEqual(d.chatExtra(), {});
  assert.deepEqual(out, { text: '', posts: [{ agent: 'srv-a', text: '답' }, { bot: 'hermes', text: '봇 답' }, { agent: 'srv-a', text: '반응', round: 2 }], notes: [{ code: 'round', text: 'x' }], handoffs: [] });
});

test('기억 안 남김 방 — 발언 턴에 일지 끄기·memoryOff, 손님 등급은 주인 도구 아님', async () => {
  const { st, deps } = spyDeps();
  const offer = offerOf({ memory: false });
  await runMeetingOffer(offer, { ...ctxOf(), tier: 'guest' }, { agents: AGENTS, deps, meeting: meetingOf(offer) });
  const { d } = st.meetings[0];
  assert.deepEqual(d.chatExtra(), { journal: { off: true } });
  assert.deepEqual(d.mirrorCtxFor().scope, { kind: 'link', work: 'work-1', room: 'room-1', owner: false, memoryOff: true });
});

test('이 기기에 참여자가 없으면 no_runner, 취소로 끝나면 결과 없음(null)', async () => {
  const { deps } = spyDeps();
  const offer = offerOf({ participants: [{ kind: 'agent', agent: 'srv-x' }] });
  await assert.rejects(runMeetingOffer(offer, ctxOf(), { agents: AGENTS, deps, meeting: meetingOf(offer) }), { code: 'no_runner' });
  const ac = new AbortController(); ac.abort();
  const d2 = spyDeps().deps; d2.runMeeting = async () => ({ posts: [], notes: [], stopped: 'cancelled' });
  const offer2 = offerOf();
  assert.equal(await runMeetingOffer(offer2, ctxOf(ac.signal), { agents: AGENTS, deps: d2, meeting: meetingOf(offer2) }), null);
});

test('요금제 캐시 — 1시간 안 같은 계정은 조회 1번, 조회 실패(null)는 캐시하지 않는다', async () => {
  let t = 0; let n = 0; let ret = null;
  const planOf = cachedPlanOf(async () => { n += 1; return ret; }, () => t);
  await planOf('u1'); await planOf('u1');
  assert.equal(n, 2, 'null은 다시 본다');
  ret = 'pro'; await planOf('u1'); await planOf('u1'); t += PLAN_CACHE_MS - 1; await planOf('u1');
  assert.equal(n, 3);
  t += 2; await planOf('u1');
  assert.equal(n, 4, '1시간 지나면 다시');
});

test('끝에서 끝까지 — 진짜 회의 실행기 + 진짜 봇 호출기 + 가짜 헤르메스 서버(127.0.0.1): 사람 글 1개 → 에이전트 2라운드 + 봇 1번', async () => {
  const reqs = [];
  const srv = http.createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    reqs.push({ url: req.url, headers: req.headers, body: JSON.parse(raw) });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: '헤르메스 의견' }] }] }));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    await mkdir(paths('lm-ws').root, { recursive: true });
    await saveBot('lm-ws', { id: 'hermes', kind: 'hermes', name: '헤르메스', url: `http://127.0.0.1:${srv.address().port}`, key: 'sk-test-e2e-0001' });
    const { deps } = spyDeps();
    deps.runMeeting = runMeeting; deps.callBot = callBot;
    const chats = [];
    deps.chat = async (ws, slug, prompt, sid, opts) => { chats.push({ ws, slug, opts }); return { reply: `${slug} 의견`, handover: null, artifacts: [] }; };
    const offer = offerOf();
    const out = await runMeetingOffer(offer, ctxOf(), { agents: AGENTS, deps, meeting: meetingOf(offer) });
    assert.deepEqual(out.posts.map((p) => [p.agent ?? p.bot, p.round ?? 1]).sort(), [['a1', 1], ['a1', 2], ['hermes', 1]].map(([r, n]) => [r === 'a1' ? 'srv-a' : r, n]).sort());
    assert.equal(reqs.length, 1, '봇 HTTP 1번');
    assert.equal(reqs[0].headers['x-hermes-session-id'], 'argo:room-1:hermes');
    assert.equal(chats.length, 2);
    assert.ok(chats.every((c) => c.opts.hop === 2 && c.opts.abortTag === 'work-1'));
  } finally { await new Promise((r) => srv.close(r)); }
});
