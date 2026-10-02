// 세션 메시지(Claude Code SendMessage와 같은 개념) — 크루 A의 대화방에서 크루 B가 이어 가던 세션으로 메시지를 넣고,
// B의 답을 A로 돌려준다. 실제 모델은 부르지 않는다: 턴 실행기를 가짜로 바꿔 끼워 "누가 몇 번 돌았는가"를 센다.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from './helpers/tmp.mjs';

let mod; let paths; let thread; let abort;
const WS = 'sess-a'; const WS2 = 'sess-b';
const calls = [];
let gate = null; // 설정되면 가짜 턴이 이 약속이 풀릴 때까지 기다린다(실행 중인 턴 흉내)
const fakeTurn = async (wsId, slug, prompt, sessionId, opts) => {
  calls.push({ wsId, slug, prompt, sessionId, opts });
  if (gate) await gate.promise;
  return { reply: `${slug}의 답 #${calls.length}`, sessionId: `sess-${slug}-${calls.length}` };
};
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

async function seedCrew(ws, slug, name, extra = '') {
  await mkdir(paths(ws).agents, { recursive: true });
  await writeFile(join(paths(ws).agents, `${slug}.md`), `---\nname: ${name}\nrole: 검증\n${extra}---\n${name} 페르소나\n`);
}
async function seedThread(ws, slug, sessionId) {
  await mkdir(paths(ws).chats, { recursive: true });
  await writeFile(join(paths(ws).chats, `${slug}.json`), JSON.stringify({ sessionId, messages: [] }));
}
const msgs = async (ws, slug) => (await thread.loadThread(ws, slug)).messages;

before(async () => {
  process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-sessmsg-'));
  process.env.ARGO_ENC_VAULT = '0';
  ({ paths } = await import('../src/workspace.mjs'));
  thread = await import('../src/thread.mjs');
  abort = await import('../src/turn-abort.mjs');
  mod = await import('../src/session-msg.mjs');
  for (const ws of [WS, WS2]) {
    await mkdir(paths(ws).root, { recursive: true });
    await writeFile(paths(ws).company, JSON.stringify({ id: ws, name: ws, lang: 'ko' }));
  }
  await seedCrew(WS, 'a', '알파'); await seedCrew(WS, 'b', '브라보'); await seedCrew(WS, 'c', '찰리');
  await seedCrew(WS, 'ext', '외부봇', 'runner: http\n');
  await seedCrew(WS2, 'z', '줄루');
  mod._setRunTurnForTest(fakeTurn);
});
after(async () => { await rm(process.env.ARGO_ROOT, { recursive: true, force: true }).catch(() => {}); });
beforeEach(async () => {
  calls.length = 0; gate = null;
  await mod._resetForTest();
  for (const s of ['a', 'b', 'c']) await seedThread(WS, s, `sess-${s}-0`);
  await seedThread(WS2, 'z', 'sess-z-0');
});

test('사용자 @B — B가 이어 가던 세션에 출처가 붙어 들어가고, A 턴은 0번, B 답은 A 방에 카드로 돌아온다', async () => {
  const r = await mod.sendSessionMessage(WS, { room: 'a', sender: 'captain', to: 'b', message: '이번 주 일정 정리해 줘' });
  assert.ok(r.id);
  assert.equal(r.line?.src?.dir, 'out', 'A 방에 사용자가 보낸 줄이 남는다(응답으로 화면에 바로 붙인다)');
  await mod._drainForTest();
  assert.equal(calls.length, 1, '턴은 B 한 번뿐');
  const [c] = calls;
  assert.equal(c.slug, 'b');
  assert.equal(c.sessionId, 'sess-b-0', 'B가 이어 가던 세션을 잇는다');
  assert.equal(c.opts.source, 'session');
  assert.match(c.prompt, /알파/, '어느 채팅방에서 왔는지');
  assert.match(c.prompt, /사장/, '누가 보냈는지');
  assert.match(c.prompt, /직접 한 지시가 아니다/, '사용자 본인의 직접 지시와 구분된다');
  assert.match(c.prompt, /이번 주 일정 정리해 줘/);
  const b = await msgs(WS, 'b');
  assert.equal(b.length, 2);
  assert.equal(b[0].via, 'session'); assert.equal(b[0].src.kind, 'session'); assert.equal(b[0].src.room, 'a'); assert.equal(b[0].src.from, 'captain');
  assert.ok(!b[0].awaiting, '답을 받은 줄은 대기 표시가 풀린다');
  assert.equal(b[1].who, 'crew'); assert.equal(b[1].text, 'b의 답 #1');
  assert.equal((await thread.loadThread(WS, 'b')).sessionId, 'sess-b-1', 'B의 세션이 이어진다(다음 턴도 같은 맥락)');
  const a = await msgs(WS, 'a');
  assert.equal(a.length, 2);
  assert.equal(a[0].who, 'user'); assert.equal(a[0].src.dir, 'out'); assert.equal(a[0].src.to, 'b');
  assert.equal(a[1].who, 'crew'); assert.equal(a[1].src.dir, 'reply'); assert.equal(a[1].src.from, 'b'); assert.equal(a[1].src.fromName, '브라보');
  assert.equal(a[1].text, 'b의 답 #1');
  assert.equal((await thread.loadThread(WS, 'a')).sessionId, 'sess-a-0', 'A의 세션은 건드리지 않는다');
});

test('크루끼리 — B 답이 도착하면 A가 자기 세션에서 한 번 깨어난다', async () => {
  await mod.sendSessionMessage(WS, { room: 'a', sender: { slug: 'a' }, to: 'b', message: '자료 찾아 줘', hop: 0, chain: [] });
  await mod._drainForTest();
  assert.deepEqual(calls.map((c) => c.slug), ['b', 'a'], 'B 한 번, 답이 온 뒤 A 한 번');
  const [bt, at] = calls;
  assert.match(bt.prompt, /동료 크루 알파/);
  assert.equal(bt.opts.hop, 1); assert.deepEqual(bt.opts.chain, ['a']); assert.equal(bt.opts.from, 'a');
  assert.equal(at.sessionId, 'sess-a-0', 'A가 이어 가던 세션으로 깨운다');
  assert.match(at.prompt, /b의 답 #1/, '알림에 B의 답이 실린다');
  assert.equal(at.opts.hop, 1, '깨운 턴은 B와 같은 단계 — 다시 보내면 한 단계 더 깊어진다');
  const a = await msgs(WS, 'a');
  assert.equal(a.length, 2);
  assert.equal(a[0].via, 'session'); assert.equal(a[0].src.dir, 'reply'); assert.equal(a[0].src.from, 'b');
  assert.equal(a[1].who, 'crew'); assert.equal(a[1].text, 'a의 답 #2');
});

test('상한 — 사슬 단계가 상한에 닿으면 보내지 않고 보낸 쪽 방에 안내를 남긴다', async () => {
  await assert.rejects(
    mod.sendSessionMessage(WS, { room: 'a', sender: { slug: 'a' }, to: 'b', message: '또 부탁', hop: mod.SESSION_HOP_CAP, chain: ['b', 'a'] }),
    (e) => e.code === 'CHAIN_CAP');
  await mod._drainForTest();
  assert.equal(calls.length, 0, '턴이 생기지 않는다');
  const a = await msgs(WS, 'a');
  assert.equal(a.length, 1); assert.equal(a[0].src.dir, 'notice'); assert.equal(a[0].src.code, 'cap');
  assert.match(a[0].text, /상한/);
  assert.equal((await msgs(WS, 'b')).length, 0);
});

test('경계 — 다른 회사 크루·해고된 크루·외부 봇·자기 자신에게는 보낼 수 없다', async () => {
  await assert.rejects(mod.sendSessionMessage(WS, { room: 'a', sender: 'captain', to: 'z', message: 'x' }), (e) => e.code === 'NOT_FOUND');
  await assert.rejects(mod.sendSessionMessage(WS, { room: 'a', sender: 'captain', to: 'gone', message: 'x' }), (e) => e.code === 'NOT_FOUND');
  await assert.rejects(mod.sendSessionMessage(WS, { room: 'a', sender: 'captain', to: 'ext', message: 'x' }), (e) => e.code === 'NOT_FOUND');
  await assert.rejects(mod.sendSessionMessage(WS, { room: 'a', sender: 'captain', to: 'a', message: 'x' }), (e) => e.code === 'SELF');
  await assert.rejects(mod.sendSessionMessage(WS2, { room: 'z', sender: 'captain', to: 'b', message: 'x' }), (e) => e.code === 'NOT_FOUND');
  await mod._drainForTest();
  assert.equal(calls.length, 0);
  assert.equal((await msgs(WS2, 'z')).length, 0, '다른 회사 스레드는 손대지 않는다');
});

test('중복 — 같은 상대의 답을 기다리는 동안 다시 보내면 거부, 답이 오면 다시 보낼 수 있다', async () => {
  gate = deferred();
  await mod.sendSessionMessage(WS, { room: 'a', sender: 'captain', to: 'b', message: '첫 번째' });
  await assert.rejects(mod.sendSessionMessage(WS, { room: 'a', sender: 'captain', to: 'b', message: '두 번째' }), (e) => e.code === 'DUP');
  await mod.sendSessionMessage(WS, { room: 'a', sender: 'captain', to: 'c', message: '다른 상대는 된다' });
  gate.resolve(); await mod._drainForTest();
  assert.equal(calls.length, 2);
  gate = null;
  await mod.sendSessionMessage(WS, { room: 'a', sender: 'captain', to: 'b', message: '세 번째' });
  await mod._drainForTest();
  assert.equal(calls.length, 3);
});

test('대기열 — B가 다른 턴을 실행 중이면 끝날 때까지 기다렸다 한 번만 돈다(동시 실행 없음, 폴링 없음)', async () => {
  const reg = abort.registerTurn(WS, 'b', () => {}, { source: 'chat' });
  await mod.sendSessionMessage(WS, { room: 'a', sender: 'captain', to: 'b', message: '끝나면 봐 줘' });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(calls.length, 0, 'B 턴이 도는 동안에는 시작하지 않는다');
  const b = await msgs(WS, 'b');
  assert.equal(b.length, 1); assert.ok(b[0].awaiting, 'B 방에는 대기 중인 줄로 보인다');
  reg.release();
  await mod._drainForTest();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].slug, 'b');
});

test('기한 — 답이 기한 안에 오지 않으면 기다림을 끝내고 A 방에 안내를 남긴다', async () => {
  mod._setTtlForTest(300);
  gate = deferred();
  await mod.sendSessionMessage(WS, { room: 'a', sender: { slug: 'a' }, to: 'b', message: '오래 걸리는 일', hop: 0, chain: [] });
  // 이 경우는 "B 턴이 도는 중에 기한이 지남"이다 — B 턴이 시작된 것을 먼저 본다(시작 전에 기한이 지나면 B는 아예 돌지 않는 다른 갈래)
  for (let i = 0; i < 100 && !calls.length; i += 1) await new Promise((r) => setTimeout(r, 5));
  assert.equal(calls.length, 1, 'B 턴이 기한 전에 시작됐다');
  // 기한 타이머 뒤 안내가 기록될 때까지 기다린다(테스트 쪽 대기 — 제품 경로는 타이머 1개)
  let notice = null;
  for (let i = 0; i < 100 && !notice; i += 1) { await new Promise((r) => setTimeout(r, 50)); notice = (await msgs(WS, 'a')).find((m) => m.src?.dir === 'notice'); }
  assert.ok(notice, 'A 방에 안내'); assert.equal(notice.src.code, 'expired');
  // 기다림이 끝났으니 같은 상대에게 다시 보낼 수 있다
  gate.resolve(); await mod._drainForTest();
  const woke = calls.filter((c) => c.slug === 'a');
  assert.equal(woke.length, 0, '기한이 지난 답으로는 A를 깨우지 않는다(비용)');
  const late = (await msgs(WS, 'a')).find((m) => m.src?.dir === 'reply');
  assert.ok(late?.src.late, '늦게 온 답은 카드로만 남는다');
  mod._setTtlForTest(null);
  await mod.sendSessionMessage(WS, { room: 'a', sender: 'captain', to: 'b', message: '다시' });
  await mod._drainForTest();
});

test('재시작 정리 — 이전 프로세스가 남긴 대기 기록은 부팅 정리에서 A 방 안내와 함께 지운다', async () => {
  const file = join(paths(WS).root, 'sessmsg', 'pending.json');
  await mkdir(join(paths(WS).root, 'sessmsg'), { recursive: true });
  await writeFile(file, JSON.stringify({ old1: { id: 'old1', room: 'a', roomName: '알파', from: 'a', fromName: '알파', to: 'b', toName: '브라보', owner: 'dead-proc', createdAt: Date.now() - 3600_000, deadline: Date.now() + 3600_000 } }));
  const n = await mod.sweepSessionMessages();
  assert.equal(n, 1);
  const notice = (await msgs(WS, 'a')).find((m) => m.src?.dir === 'notice');
  assert.equal(notice?.src.code, 'restart');
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), {});
  // 정리 뒤에는 같은 상대에게 다시 보낼 수 있다
  await mod.sendSessionMessage(WS, { room: 'a', sender: 'captain', to: 'b', message: '다시' });
  await mod._drainForTest();
  assert.equal(calls.length, 1);
  assert.equal(await mod.sweepSessionMessages(), 0, '정리할 것이 없으면 쓰지 않는다');
});

test('B 턴 실패 — A 방에 실패 안내, 대기는 풀린다', async () => {
  mod._setRunTurnForTest(async () => { throw new Error('러너 없음'); });
  try {
    await mod.sendSessionMessage(WS, { room: 'a', sender: 'captain', to: 'b', message: '부탁' });
    await mod._drainForTest();
    const notice = (await msgs(WS, 'a')).find((m) => m.src?.dir === 'notice');
    assert.equal(notice?.src.code, 'failed');
    const b = await msgs(WS, 'b');
    assert.ok(b[0].failed, 'B 방의 줄은 실패로 남는다');
  } finally { mod._setRunTurnForTest(fakeTurn); }
  await mod.sendSessionMessage(WS, { room: 'a', sender: 'captain', to: 'b', message: '다시' });
  await mod._drainForTest();
  assert.equal(calls.length, 1);
});

test('맥락 줄 — 세션 메시지 줄은 화자를 바르게 적는다(B의 답을 A 자신의 말로 읽지 않게)', async () => {
  const { threadCtxLine } = await import('../src/chat.mjs');
  const out = threadCtxLine({ who: 'user', text: '@브라보 일정', src: { kind: 'session', dir: 'out', to: 'b', toName: '브라보' } }, 'ko', '알파');
  assert.match(out, /브라보/); assert.match(out, /세션 메시지/);
  const reply = threadCtxLine({ who: 'crew', text: '정리했습니다', src: { kind: 'session', dir: 'reply', from: 'b', fromName: '브라보' } }, 'ko', '알파');
  assert.match(reply, /^브라보/); assert.doesNotMatch(reply, /^알파/);
});

test('화면 파서 — @이름 내용만 세션 메시지로, 모르는 이름·자기 자신·내용 없음은 일반 전송', async () => {
  const { parseSessionTarget } = await import('../app/c/[ws]/crew/[slug]/session-msg-parse.mjs');
  const crew = [{ slug: 'a', name: '알파' }, { slug: 'b', name: '브라보' }, { slug: 'c-1', name: 'Charlie Kim' }];
  assert.deepEqual(parseSessionTarget('@브라보 일정 봐 줘', crew, 'a'), { to: 'b', toName: '브라보', message: '일정 봐 줘' });
  assert.deepEqual(parseSessionTarget('@b\n여러 줄\n내용', crew, 'a'), { to: 'b', toName: '브라보', message: '여러 줄\n내용' });
  assert.deepEqual(parseSessionTarget('@c-1 hi', crew, 'a'), { to: 'c-1', toName: 'Charlie Kim', message: 'hi' });
  assert.equal(parseSessionTarget('@알파 나 자신', crew, 'a'), null);
  assert.equal(parseSessionTarget('@없는사람 hi', crew, 'a'), null);
  assert.equal(parseSessionTarget('@브라보', crew, 'a'), null);
  assert.equal(parseSessionTarget('안녕 @브라보 hi', crew, 'a'), null);
});

test('화면 본문 — 받은 줄·깨움 알림은 모델용 머리말을 떼고 보낸 내용·답만 보인다', async () => {
  const { sessionBody } = await import('../app/c/[ws]/crew/[slug]/session-msg-parse.mjs');
  await mod.sendSessionMessage(WS, { room: 'a', sender: { slug: 'a' }, to: 'b', message: '첫 줄\n\n둘째 단락', hop: 0, chain: [] });
  await mod._drainForTest();
  const inLine = (await msgs(WS, 'b'))[0];
  assert.equal(sessionBody(inLine), '첫 줄\n\n둘째 단락');
  const wake = (await msgs(WS, 'a'))[0];
  assert.equal(sessionBody(wake), 'b의 답 #1');
});


test('위임 제한 스위치 — 사장이 보낸 사슬은 보낸 방의 스위치를 읽어 B 턴과 A 깨움 턴에 그대로 싣는다', async () => {
  await mod.sendSessionMessage(WS, { room: 'a', sender: 'captain', to: 'b', message: '켜짐 방에서' });
  await mod._drainForTest();
  assert.equal(calls[0].opts.sessionRelaxed, false, '켜짐(기본) 방에서 시작한 사슬');
  calls.length = 0;
  await thread.setDelegationLimit(WS, 'a', false); // A 방 위임 제한 풀기
  await mod.sendSessionMessage(WS, { room: 'a', sender: 'captain', to: 'b', message: '풀린 방에서' });
  await mod._drainForTest();
  assert.equal(calls[0].opts.sessionRelaxed, true, '풀린 방에서 시작한 사슬');
  calls.length = 0;
  // 크루가 보낸 사슬 — 넘겨받은 값을 B 턴과 깨움 턴 모두에 잇는다(B·A 방 스위치와 무관)
  await mod.sendSessionMessage(WS, { room: 'c', sender: { slug: 'c' }, to: 'b', message: '이어서', hop: 1, chain: ['a'], relaxed: true });
  await mod._drainForTest();
  assert.deepEqual(calls.map((c) => [c.slug, c.opts.sessionRelaxed]), [['b', true], ['c', true]]);
});

test('사슬 상한 — 켜짐은 2단계, 풀림은 4단계에서 멈추고 안내에 그 숫자를 적는다', async () => {
  // 켜짐: hop 2에서 거부
  await assert.rejects(mod.sendSessionMessage(WS, { room: 'a', sender: { slug: 'a' }, to: 'b', message: 'x', hop: 2, chain: ['c', 'a'], relaxed: false }), (e) => e.code === 'CHAIN_CAP');
  // 풀림: hop 2·3은 보내지고 hop 4에서 거부
  await mod.sendSessionMessage(WS, { room: 'a', sender: { slug: 'a' }, to: 'b', message: 'hop2', hop: 2, chain: ['c', 'a'], relaxed: true });
  await mod._drainForTest();
  await mod.sendSessionMessage(WS, { room: 'a', sender: { slug: 'a' }, to: 'c', message: 'hop3', hop: 3, chain: ['c', 'a', 'b'], relaxed: true });
  await mod._drainForTest();
  assert.deepEqual(calls.filter((c) => c.slug !== 'a').map((c) => c.opts.hop), [3, 4], '풀린 사슬의 B 턴은 hop 3·4까지 돈다');
  await assert.rejects(mod.sendSessionMessage(WS, { room: 'a', sender: { slug: 'a' }, to: 'b', message: 'hop4', hop: 4, chain: [], relaxed: true }), (e) => e.code === 'CHAIN_CAP');
  const caps = (await msgs(WS, 'a')).filter((m) => m.src?.code === 'cap').map((m) => m.text);
  assert.equal(caps.length, 2);
  assert.match(caps[0], /2단계/); assert.match(caps[1], /4단계/);
});
