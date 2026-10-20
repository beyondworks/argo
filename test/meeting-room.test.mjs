// 메신저 v2 회의방 실행기(src/meeting-room.mjs) — 데스크톱과 같은 회의 실행기(runRoomCore)에 메모리 저장소·방 참여자를 넣어 돌린다.
// 경우 표(PR 본문)의 회의방 칸: 정상·상한 초과(S≤5, 글≤10, 라운드 2 고정)·취소·시간 상한·위임 0·cc/loop 없음·봇 규칙.
// chat·interruptTurn·callBot은 가짜(deps)라 러너·네트워크를 부르지 않는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readdir } from 'node:fs/promises';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-meeting-'));
delete process.env.NEXT_PUBLIC_SUPABASE_URL; delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const { runMeeting, MEETING_MAX_TURN_S } = await import('../src/meeting-room.mjs');
const { MEETING_LIMITS } = await import('../src/room.mjs');
const { DELEGATION_LIMITS } = await import('../src/delegation-limits.mjs');
const { _turnColleaguesForTest } = await import('../src/chat.mjs');
const { paths } = await import('../src/workspace.mjs');

const NAMES = ['에이', '비', '씨', '디', '이', '에프', '지'];
const agents = (k, ws = 'm-ws') => NAMES.slice(0, k).map((name, i) => ({ kind: 'agent', ref: `ag-${i}`, ws, slug: `s${i}`, name }));
const bot = (id, name) => ({ kind: 'bot', ref: `bot-${id}`, ws: 'm-ws', id, name });

function fakes({ reply = (slug) => `${slug} 답`, gate = null, botReply = (id) => `${id} 봇 답` } = {}) {
  const st = { chats: [], interrupts: [], bots: [] };
  const deps = {
    async chat(ws, slug, prompt, sid, opts) {
      st.chats.push({ ws, slug, prompt, opts });
      if (gate) await gate(slug, opts);
      return { reply: reply(slug, prompt), handover: null, artifacts: [] };
    },
    async interruptTurn(ws, slug, o) { st.interrupts.push({ ws, slug, ...o }); },
    async callBot(b, o) { st.bots.push({ ...b, ...o }); return { text: botReply(b.id, o) }; },
    mirrorCtxFor: (p) => ({ kind: 'scope', scope: { kind: 'link', work: 'w1', room: 'r1', owner: true } }),
  };
  return { st, deps };
}

test('정상 — 3명 멘션: 1라운드 3 + 반응 라운드 3 = 글 6, 발언 옵션은 위임 0(hop=위임 상한)·메신저 출처·중단 표지·link 범위', async () => {
  const { st, deps } = fakes();
  const r = await runMeeting({ text: '@에이 @비 @씨 출시 점검', participants: agents(4), tag: 'w1' }, deps);
  assert.equal(r.stopped, null);
  assert.equal(r.posts.length, 6);
  assert.deepEqual(r.posts.map((p) => p.round ?? 1), [1, 1, 1, 2, 2, 2]);
  assert.deepEqual(new Set(r.posts.map((p) => p.ref)), new Set(['ag-0', 'ag-1', 'ag-2']));
  assert.ok(r.posts.every((p) => p.kind === 'agent'));
  assert.deepEqual(r.notes.map((n) => n.code), ['speakers', 'round']);
  for (const c of st.chats) {
    assert.equal(c.opts.hop, DELEGATION_LIMITS.on.hop);
    assert.equal(c.opts.source, 'messenger');
    assert.equal(c.opts.abortTag, 'w1');
    assert.equal(c.opts.mirrorCtx.scope.kind, 'link');
    assert.equal(c.opts.delegationRelaxed, undefined, '풀림 옵션을 넘기지 않는다');
  }
});

test('위임 0 — 회의방 발언의 hop에서는 동료 목록이 비어 위임·쪽지 도구가 붙지 않는다(실제 chat.mjs 판정)', async () => {
  const ws = 'm-deleg';
  const p = paths(ws);
  await mkdir(join(p.root, 'agents'), { recursive: true });
  await writeFile(join(p.root, 'company.json'), JSON.stringify({ name: ws }));
  for (const s of ['x1', 'x2']) await writeFile(join(p.root, 'agents', `${s}.md`), `---\nname: ${s}\nrole: r\nrunner: claude\n---\n`);
  assert.equal((await _turnColleaguesForTest(ws, 'x1', 0, [], null)).length, 1, '대조: hop 0이면 동료가 보인다');
  assert.deepEqual(await _turnColleaguesForTest(ws, 'x1', DELEGATION_LIMITS.on.hop, [], null), []);
});

test('상한 — @전체 7명은 5명만 발언(제외 안내), 글은 5×2=10을 넘지 않는다, 라운드 2 고정', async () => {
  const { st, deps } = fakes();
  const r = await runMeeting({ text: '@전체 의견', participants: agents(7), tag: 'w2' }, deps);
  assert.equal(new Set(st.chats.map((c) => c.slug)).size, MEETING_LIMITS.speakers);
  assert.equal(r.posts.length, MEETING_LIMITS.posts);
  assert.ok(r.posts.every((p) => (p.round ?? 1) <= 2));
  const cap = r.notes.find((n) => n.code === 'cap');
  assert.match(cap.text, /5명까지 발언합니다 — 제외: 에프, 지/);
  assert.equal(st.chats.length, 10, 'S×R = 10');
});

test('상한 — 반응 라운드에서 보탤 말이 남아도 3라운드로 가지 않는다(데스크톱 풀림 4와 다름)', async () => {
  const { st, deps } = fakes({ reply: (slug) => `${slug} 새 의견` });
  await runMeeting({ text: '@에이 @비 토론', participants: agents(2), tag: 'w3' }, deps);
  assert.equal(st.chats.length, 4);
});

test('취소 — 바깥 신호가 서면 발언 중인 에이전트를 interruptTurn으로 끊고, 반응 라운드를 시작하지 않는다(stopped cancelled)', async () => {
  const ac = new AbortController();
  let release;
  const held = new Promise((r) => { release = r; });
  const { st, deps } = fakes({
    gate: async (slug) => { if (slug === 's1') { ac.abort(); await held; throw Object.assign(new Error('중단됨'), { aborted: true }); } },
  });
  const run = runMeeting({ text: '@에이 @비 검토', participants: agents(2), tag: 'w4', signal: ac.signal }, deps);
  await new Promise((r) => setTimeout(r, 20));
  release();
  const r = await run;
  assert.equal(r.stopped, 'cancelled');
  assert.ok(st.interrupts.some((i) => i.slug === 's1'), '발언 중이던 s1을 끊는다');
  assert.ok(st.interrupts.every((i) => i.ws === 'm-ws' && i.source === 'messenger' && i.tag === 'w4'), '이 일의 표지로만 끊는다(같은 에이전트의 다른 턴은 건드리지 않는다)');
  assert.equal(st.chats.length, 2, '반응 라운드 없음');
  assert.ok(r.posts.length <= 1, '취소 뒤 끝난 발언은 남기지 않는다');
});

test('이미 취소된 신호 — 발언 0', async () => {
  const ac = new AbortController(); ac.abort();
  const { st, deps } = fakes();
  const r = await runMeeting({ text: '@에이 @비', participants: agents(2), tag: 'w5', signal: ac.signal }, deps);
  assert.equal(st.chats.length, 0);
  assert.equal(r.stopped, 'cancelled');
});

test('시간 상한 — max_turn_s에 닿으면 발언 중인 턴을 끊고, 끝난 글은 남기며 안내를 붙인다. 서버 값이 900초보다 커도 900초', async () => {
  const timers = [];
  const clock = { setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout: () => {} };
  let release;
  const held = new Promise((r) => { release = r; });
  const { st, deps } = fakes({
    gate: async (slug) => { if (slug === 's1') { timers[0].fn(); await held; throw Object.assign(new Error('중단됨'), { aborted: true }); } },
  });
  const run = runMeeting({ text: '@에이 > @비 이어서', participants: agents(2), tag: 'w6', maxTurnS: 5000 }, { ...deps, clock });
  await new Promise((r) => setTimeout(r, 20));
  release();
  const r = await run;
  assert.equal(timers[0].ms, MEETING_MAX_TURN_S * 1000, '상한 900초');
  assert.equal(r.stopped, 'timeout');
  assert.deepEqual(r.posts.map((p) => p.ref), ['ag-0'], '앞사람 글은 남는다');
  assert.equal(r.notes.at(-1).code, 'timeout');
  assert.match(r.notes.at(-1).text, /900초/);
  assert.deepEqual(st.interrupts.map((i) => i.slug), ['s1']);
});

test('cc·loop 없음 — 회의방에서는 안내만 남기고 쪽지·루틴을 만들지 않는다', async () => {
  const { st, deps } = fakes();
  const r1 = await runMeeting({ text: '반복 30분 @에이 점검', participants: agents(2), tag: 'w7' }, deps);
  assert.equal(st.chats.length, 0);
  assert.deepEqual(r1.notes.map((n) => n.code), ['unsupported']);
  const r2 = await runMeeting({ text: '@에이 확인 cc @비', participants: agents(2), tag: 'w8' }, deps);
  assert.deepEqual(st.chats.map((c) => c.slug), ['s0'], '참조 대상은 발언하지 않고, 쪽지도 없다');
  assert.equal(r2.notes[0].code, 'unsupported');
  const mail = await readdir(join(paths('m-ws').root)).catch(() => []);
  assert.ok(!mail.includes('mail'), '쪽지 폴더 없음');
});

test('봇 — 이름으로 부를 때만, 1라운드에만 답한다(반응 라운드 제외). @전체·멘션 없음에는 끼지 않는다', async () => {
  const { st, deps } = fakes();
  const parts = [...agents(2), bot('hermes', '헤르메스')];
  const r = await runMeeting({ text: '@헤르메스 @에이 의견', participants: parts, tag: 'w9', sessionKey: 'room-9' }, deps);
  assert.equal(st.bots.length, 1, '봇 1번');
  assert.equal(st.bots[0].sessionId, 'room-9:hermes');
  assert.equal(st.bots[0].hop, 1);
  assert.ok(!st.bots[0].text.includes('delegate'), '봇에게 Argo 전용 지시를 보내지 않는다');
  assert.deepEqual(r.posts.filter((p) => p.kind === 'bot').map((p) => [p.ref, p.round ?? 1]), [['bot-hermes', 1]]);
  assert.equal(st.chats.length, 2, '에이전트는 1라운드 + 반응 라운드');
  const f2 = fakes();
  await runMeeting({ text: '@전체 의견', participants: parts, tag: 'w10' }, f2.deps);
  await runMeeting({ text: '그냥 질문', participants: parts, tag: 'w11' }, f2.deps);
  assert.equal(f2.st.bots.length, 0, '@전체·폴백에 봇 없음');
});

test('봇끼리 깨움 방지 — 에이전트·봇 글에 다른 봇 이름이 있어도 그 봇을 부르지 않는다', async () => {
  const { st, deps } = fakes({ reply: () => '@오픈클로 이거 봐 줘', botReply: () => '@오픈클로 너도' });
  const parts = [...agents(1), bot('hermes', '헤르메스'), bot('claw', '오픈클로')];
  await runMeeting({ text: '@헤르메스 @에이 의견', participants: parts, tag: 'w12' }, deps);
  assert.deepEqual(st.bots.map((b) => b.id), ['hermes']);
});

test('봇 실패는 그 봇의 안내 글로 남고 회의는 이어진다(봇 꺼짐·429 등 code만, 원문 키 없음)', async () => {
  const { deps } = fakes();
  deps.callBot = async () => { throw Object.assign(new Error('bot_unreachable'), { code: 'bot_unreachable' }); };
  const r = await runMeeting({ text: '@헤르메스 @에이 의견', participants: [...agents(1), bot('hermes', '헤르메스')], tag: 'w13' }, deps);
  assert.ok(r.posts.some((p) => p.kind === 'agent'));
  assert.match(r.notes.find((n) => n.code === 'error').text, /헤르메스 발언 실패: bot_unreachable/);
});

test('봇만 부른 회의(에이전트 없음)도 돈다 — 봇 1번, 반응 라운드 없음', async () => {
  const { st, deps } = fakes();
  const r = await runMeeting({ text: '@헤르메스 안녕', participants: [bot('hermes', '헤르메스')], tag: 'w14' }, deps);
  assert.equal(st.bots.length, 1);
  assert.deepEqual(r.posts.map((p) => p.kind), ['bot']);
});

test('상한 — 회의방 릴레이는 켜짐 값(3명)까지: 4명 릴레이는 3명만 발언하고 제외 안내(풀림 6명이 새지 않는다)', async () => {
  const { st, deps } = fakes();
  const r = await runMeeting({ text: '@에이 > @비 > @씨 > @디 이어서', participants: agents(4), tag: 'w15' }, deps);
  assert.deepEqual(st.chats.map((c) => c.slug), ['s0', 's1', 's2']);
  assert.match(r.notes.find((n) => n.code === 'relay').text, /이어받기는 3명까지 — 제외: 디/);
});

test('글 상한(방어선) — 위임 미러가 켜진 회의방 바깥이라도 질문 1번당 글은 10개를 넘지 않는다', async () => {
  const { runRoomCore } = await import('../src/room.mjs');
  const { emitNotify } = await import('../src/notify.mjs');
  const room = { messages: [] };
  const core = NAMES.slice(0, 5).map((name, i) => ({ slug: `p${i}`, name, kind: 'agent' }));
  const env = {
    wsId: 'cap-ws', participants: async () => core, folder: async () => ({ pin: '', stale: '' }), company: async () => ({ lang: 'ko' }),
    begin: async (m) => { room.messages.push(m); return { sid: 0, relaxed: false }; },
    push: async (m) => { room.messages.push(m); return true; }, load: async () => room,
    async speak(a, prompt, opts) { // 발언마다 위임 결과 1건을 미러로 흘린다 — 미러 글까지 세면 5×2×2 = 20개가 될 자리
      emitNotify({ type: 'delegate', wsId: 'cap-ws', ctx: opts.mirrorCtx, from: a.slug, to: a.slug, reply: '위임 결과', task: 't' });
      await new Promise((r) => setTimeout(r, 0));
      return { reply: `${a.slug} 답`, handover: null, artifacts: [] };
    },
    record: async () => {}, overBudget: async () => false, directives: false, mirrorDelegations: true, meeting: { signal: null },
  };
  await runRoomCore(env, '@전체 의견', [], {}, async () => {}, { rounds: 2 });
  const agentPosts = room.messages.filter((m) => m.who !== 'user' && m.who !== 'system');
  assert.equal(agentPosts.length, 10, '미러 글까지 합쳐 10개(상한값이 바뀌면 여기서 드러난다)');
  assert.deepEqual({ ...MEETING_LIMITS }, { speakers: 5, rounds: 2, posts: 10 }, '유건 승인 상한표(2026-10-19)');
});
