// 위임 제한 스위치 — 크루 간 위임 제한(2회·2단계·회의실 3명/2라운드)을 대화방마다 풀고 다시 거는 계약.
// 켜짐 = 지금 제한 그대로, 꺼짐 = 안전 상한(위임 10·쪽지 10·단계 4·이어받기 6명·반응 4라운드)까지.
// 메신저(팀 메신저) 크루 턴은 이 스위치의 범위가 아니라 어떤 경로로도 풀리지 않는다.
// 모델은 부르지 않는다 — 위임 대상 턴은 월 예산 초과 안내(비용 0)로, 회의실은 chat 스텁(helpers/room-chat-stub.mjs)으로 격리.
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { register } from 'node:module';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-deleg-'));
delete process.env.NEXT_PUBLIC_SUPABASE_URL; delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
register(new URL('./helpers/room-chat-stub.mjs', import.meta.url));
register(new URL('./helpers/next-esm-resolve.mjs', import.meta.url)); // 라우트 직접 호출(app/auth.mjs의 next/headers) — room-fork.test.mjs와 같은 방식
const stub = await import('./helpers/room-chat-stub.mjs');
const { DELEGATION_LIMITS, limitsFor, newTree, getTree, spendTree } = await import('../src/delegation-limits.mjs');
const chatMod = await import('../src/chat.mjs');
const { makeCrewServer } = chatMod;
const { runRoomTurn, loadRoom, parseRoomDirectives, setRoomDelegationLimit, endMeeting, HOP_MAX } = await import('../src/room.mjs');
const thread = await import('../src/thread.mjs');
const { mailPrompt, listMail } = await import('../src/crewmail.mjs');
const { mergeThread } = await import('../src/sync.mjs');
const { appendUsage } = await import('../src/usage.mjs');
const { paths } = await import('../src/workspace.mjs');

const ON = limitsFor(false);
const OFF = limitsFor(true);
const CREW = [['alpha', '알파'], ['beta', '베타'], ['gamma', '감마'], ['delta', '델타'], ['eps', '엡실'], ['zeta', '제타'], ['eta', '에타']];
async function seed(ws, { budget = false } = {}) {
  const p = paths(ws);
  await mkdir(p.chats, { recursive: true }); await mkdir(join(p.root, 'agents'), { recursive: true });
  await writeFile(join(p.root, 'company.json'), JSON.stringify({ name: ws, lang: 'ko', ...(budget ? { budgetUsd: 1 } : {}) }));
  await writeFile(join(p.chats, 'room-main.json'), JSON.stringify({ messages: [], sid: 1 }));
  for (const [slug, name] of CREW) await writeFile(join(p.root, 'agents', `${slug}.md`), `---\nname: ${name}\nrole: 검증\nrunner: claude\n---\n검증용.\n`);
  if (budget) await appendUsage(ws, { kind: 'chat', slug: 'alpha', runner: 'claude', model: 'm', usage: {}, costUsd: 5, ms: 10, billed: true }); // 위임받은 턴이 모델 없이 안내만 돌려준다
  stub.state.calls.length = 0; stub.state.delayMs = 0; stub.state.holdUntil = 0; stub.state.inflight = 0; stub.state.maxInflight = 0; stub.state.reply = (slug) => `${slug} 답변`;
}
const colleagues = CREW.slice(1).map(([slug, name]) => ({ slug, name, role: '검증' }));
const toolsOf = (ws, lim, { hop = 0, chain = [], ctx = null, peers = colleagues, tree = undefined, counters = undefined } = {}) => {
  const sink = [];
  makeCrewServer(ws, 'alpha', '알파', peers, hop, chain, ctx, 'ko', [], '', sink, null, false, lim, tree, counters);
  return Object.fromEntries(sink.map((d) => [d.name, d.handler]));
};
const say = (r) => r.content[0].text;

// ── 표
test('제한 표 — 켜짐은 지금 값(2·2·2단계·3명·2라운드), 꺼짐은 안전 상한(10·10·4단계·6명·4라운드), 메신저 맥락은 어떤 값이 와도 켜짐', () => {
  assert.deepEqual({ ...ON }, { relaxed: false, delegate: 2, mail: 2, hop: 2, relay: 3, rounds: 2, tree: null });
  assert.deepEqual({ ...OFF }, { relaxed: true, delegate: 10, mail: 10, hop: 4, relay: 6, rounds: 4, tree: 30 });
  assert.equal(HOP_MAX, 2, '회의실 HOP_MAX(이어받기 3명)는 표의 켜짐 값에서 나온다');
  assert.equal(limitsFor(true, { kind: 'msgr' }), DELEGATION_LIMITS.on);
  assert.equal(limitsFor(true, { kind: 'msgr-rules' }), DELEGATION_LIMITS.on);
  assert.equal(limitsFor(true, { room: 'x' }), DELEGATION_LIMITS.off, '회의실 문맥은 풀린다');
  assert.equal(limitsFor('true'), DELEGATION_LIMITS.on, '엄격한 불리언만 — 문자열·1은 켜짐(fail-closed)');
});

// ── delegate / send_to_crew 카운터
test('delegate — 켜짐이면 3번째 위임을 거절한다(지금 동작 그대로 문구까지)', async () => {
  await seed('dl-on', { budget: true });
  const { delegate } = toolsOf('dl-on', ON);
  for (let i = 0; i < 2; i += 1) assert.match(say(await delegate({ to: 'beta', task: `일 ${i}` })), /작업 결과/);
  assert.equal(say(await delegate({ to: 'beta', task: '셋째' })), '위임 한도 초과 — 이번 턴은 남은 작업을 직접 마무리하라.');
});

test('delegate — 꺼짐이면 10번째까지 허용하고 11번째를 거절하며 "사용자에게 계속할지 묻기"를 안내한다', async () => {
  await seed('dl-off', { budget: true });
  const { delegate } = toolsOf('dl-off', OFF);
  for (let i = 0; i < 10; i += 1) assert.match(say(await delegate({ to: 'beta', task: `일 ${i}` })), /작업 결과/, `${i + 1}번째 위임이 허용돼야 한다`);
  const refused = say(await delegate({ to: 'beta', task: '열한째' }));
  assert.match(refused, /위임 상한\(10회\)/);
  assert.match(refused, /계속할까요/, '직접 마무리하라가 아니라 사용자에게 계속 여부를 묻게 한다');
  assert.doesNotMatch(refused, /직접 마무리하라/);
});

test('delegate 거절 안내는 회사 언어(en)도 따른다', async () => {
  await seed('dl-off-en', { budget: true });
  const sink = [];
  makeCrewServer('dl-off-en', 'alpha', 'Alpha', colleagues, 0, [], null, 'en', [], '', sink, null, false, OFF);
  const { handler } = sink.find((d) => d.name === 'delegate');
  for (let i = 0; i < 10; i += 1) await handler({ to: 'beta', task: `t${i}` });
  assert.match(say(await handler({ to: 'beta', task: 'eleventh' })), /limit \(10 per turn\)[\s\S]*continue/i);
});

test('send_to_crew — 켜짐 3번째 거절, 꺼짐 10번째까지 허용·11번째 거절, 꺼짐 쪽지만 relaxed 표지를 달고 나간다', async () => {
  await seed('dl-mail');
  const on = toolsOf('dl-mail', ON);
  for (let i = 0; i < 2; i += 1) assert.match(say(await on.send_to_crew({ to: 'beta', message: `켜짐 ${i}` })), /쪽지를 보냈다/);
  assert.match(say(await on.send_to_crew({ to: 'beta', message: '켜짐 셋째' })), /쪽지 한도 초과/);
  const off = toolsOf('dl-mail', OFF);
  for (let i = 0; i < 10; i += 1) assert.match(say(await off.send_to_crew({ to: 'gamma', message: `꺼짐 ${i}` })), /쪽지를 보냈다/, `${i + 1}번째 쪽지`);
  assert.match(say(await off.send_to_crew({ to: 'gamma', message: '꺼짐 열한째' })), /쪽지 상한\(10회\)[\s\S]*계속할까요/);
  const pending = (await listMail('dl-mail')).pending;
  const body = async (to) => Promise.all(pending.filter((m) => m.to === to).map(async (m) => JSON.parse(await readFile(join(paths('dl-mail').root, 'mail', to, `${m.id}-${m.kind}.json`), 'utf8'))));
  assert.ok((await body('beta')).every((m) => m.relaxed === undefined && m.hop === 1), '켜짐 쪽지는 종전 모양 그대로(relaxed 필드 없음)');
  assert.ok((await body('gamma')).length === 10 && (await body('gamma')).every((m) => m.relaxed === true && m.hop === 1), '꺼짐 쪽지는 배달 턴에도 풀림을 잇는다');
});

// ── hop(단계)
test('단계 — 켜짐은 hop 2부터 도구 없음, 꺼짐은 hop 3까지 도구가 있고 hop 4에서 끝난다(경계 3/5)', async () => {
  await seed('dl-hop');
  const names = (hop, lim) => Object.keys(toolsOf('dl-hop', lim, { hop, peers: hop >= lim.hop ? [] : colleagues })).filter((n) => n === 'delegate' || n === 'send_to_crew');
  assert.deepEqual(names(1, ON), ['delegate', 'send_to_crew']);
  assert.deepEqual(names(2, ON), []);
  assert.deepEqual(names(3, OFF), ['delegate', 'send_to_crew']);
  assert.deepEqual(names(4, OFF), []);
  // 동료 명단 판정(turnColleagues) 자체의 경계 — 호출부가 위에서 빈 배열을 넘기는 것이 아니라 코어가 판정한다
  const tc = chatMod._turnColleaguesForTest;
  assert.equal((await tc('dl-hop', 'beta', 2, ['alpha'], null, ON)).length, 0, '켜짐 hop 2 → 명단 비움');
  assert.ok((await tc('dl-hop', 'beta', 3, ['alpha'], null, OFF)).length > 0, '꺼짐 hop 3 → 명단 있음');
  assert.equal((await tc('dl-hop', 'beta', 4, ['alpha'], null, OFF)).length, 0, '꺼짐 hop 4 → 명단 비움');
  assert.ok((await tc('dl-hop', 'beta', 1, ['alpha'], null)).length > 0 && (await tc('dl-hop', 'beta', 2, ['alpha'], null)).length === 0, '제한 인자 생략 = 켜짐(기존 호출부 회귀 0)');
});

test('순환 — 켜짐은 종전 그대로(직전 발신자 회신 허용), 꺼짐은 같은 둘의 핑퐁을 막는다(강화)', async () => {
  await seed('dl-cycle');
  const tc = chatMod._turnColleaguesForTest;
  const slugs = async (...a) => (await tc('dl-cycle', ...a)).map((x) => x.slug);
  // A→B(hop1, chain [alpha]) : B는 직전 발신자 alpha에게 회신할 수 있다 — 두 모드 모두
  assert.ok((await slugs('beta', 1, ['alpha'], null, OFF)).includes('alpha'));
  assert.ok((await slugs('beta', 1, ['alpha'], null, ON)).includes('alpha'));
  // A→B→A(hop2, chain [alpha, beta]) : 켜짐은 hop 상한 때문에 어차피 비었지만, 꺼짐은 beta를 되부르는 핑퐁을 명단에서 뺀다
  const back = await slugs('alpha', 2, ['alpha', 'beta'], null, OFF);
  assert.ok(!back.includes('beta'), '꺼짐 — A→B→A 뒤 A가 다시 B를 부를 수 없다');
  assert.ok(back.includes('gamma'), '새 동료는 부를 수 있다');
  assert.ok(!back.includes('alpha'), '자기 자신 제외');
});

// ── 프롬프트 문구
test('크루 프롬프트 안내 — 켜짐은 종전 문구 그대로, 꺼짐은 상한 숫자와 "닿으면 사용자에게 묻기"로 바뀐다(ko/en)', () => {
  const rp = chatMod._rosterPromptForTest;
  const koOn = rp(colleagues, 'ko', false, ON), enOn = rp(colleagues, 'en', false, ON);
  assert.match(koOn, /위임은 턴당 최대 2회, 연쇄\(위임받은 일을 다시 위임\)는 전체 2단계까지만 허용된다\./);
  assert.match(enOn, /At most 2 delegations per turn, and chains \(re-delegating delegated work\) are allowed only 2 levels deep in total\./);
  assert.equal(rp(colleagues, 'ko'), koOn, '제한 인자 생략 = 켜짐');
  const koOff = rp(colleagues, 'ko', false, OFF), enOff = rp(colleagues, 'en', false, OFF);
  assert.match(koOff, /위임은 턴당 최대 10회/); assert.match(koOff, /4단계/); assert.match(koOff, /계속할까요/);
  assert.match(enOff, /At most 10 delegations per turn/); assert.match(enOff, /4 levels/); assert.match(enOff, /continue/i);
  assert.doesNotMatch(koOff + enOff, /최대 2회|2단계|At most 2|2 levels/, '꺼짐인데 옛 숫자가 남으면 크루가 스스로 2회에서 멈춘다');
  // 메신저 채널 안내는 스위치와 무관(숫자 안내 자체가 없다)
  assert.equal(rp(colleagues, 'ko', true, OFF), rp(colleagues, 'ko', true, ON));
});

test('쪽지 회신 안내 — 켜짐은 hop<2, 꺼짐 쪽지는 hop<4까지 회신 지시가 붙는다', () => {
  const m = (hop, relaxed) => mailPrompt({ kind: 'to', from: 'a', fromName: '알파', message: '확인', hop, ...(relaxed ? { relaxed: true } : {}) }, 'ko');
  assert.match(m(1, false), /회신이 필요하면/); assert.doesNotMatch(m(2, false), /회신이 필요하면/);
  assert.match(m(3, true), /회신이 필요하면/); assert.doesNotMatch(m(4, true), /회신이 필요하면/);
});

// ── 메신저 턴은 그대로
test('메신저 턴 — 스위치가 꺼져 있어도 위임·쪽지는 기존 2회, hop 2 이후는 도구 없음', async () => {
  await seed('dl-msgr');
  const peers = CREW.slice(1, 5).map(([slug, name], i) => ({ id: `id-${slug}`, slug, display_name: name, owner_user_id: 'u1', ws_id: 'dl-msgr', role: '검증', i }));
  const ctx = () => ({ kind: 'msgr', channelId: 'ch1', crewId: 'id-alpha', uid: 'u1', origin: 'u1', wsId: 'dl-msgr', orgId: 'o1', handoffs: [], peers });
  const c = ctx();
  const t = toolsOf('dl-msgr', OFF, { ctx: c, peers: [] }); // 꺼짐 표를 억지로 넘겨도 메신저 맥락이 켜짐으로 되돌린다
  assert.match(say(await t.delegate({ to: 'id-beta', task: '1' })), /넘김을 준비했다/);
  assert.match(say(await t.delegate({ to: 'id-gamma', task: '2' })), /넘김을 준비했다/);
  assert.equal(say(await t.delegate({ to: 'id-delta', task: '3' })), '위임 한도 초과 — 이번 턴은 남은 작업을 직접 마무리하라.');
  assert.equal(c.handoffs.length, 2);
  const c2 = ctx();
  const t2 = toolsOf('dl-msgr', OFF, { ctx: c2, peers: [] });
  for (const k of ['a', 'b']) assert.match(say(await t2.send_to_crew({ to: 'id-beta', message: k })), /예약했다/);
  assert.match(say(await t2.send_to_crew({ to: 'id-gamma', message: 'c' })), /쪽지 한도 초과/);
  // hop: 메신저 동료 판정은 표를 받지 않는다 — 꺼짐이어도 hop 2에서 비고, 3·4에서도 빈다
  for (const hop of [2, 3, 4]) assert.deepEqual(chatMod._messengerColleaguesForTest(ctx(), hop), [], `메신저 hop ${hop}`);
  assert.ok(chatMod._messengerColleaguesForTest(ctx(), 1).length > 0);
  // 위 도구 생성에서 hop 2의 메신저 턴은 꺼짐 표와 무관하게 도구를 광고하지 않는다
  const sink = [];
  makeCrewServer('dl-msgr', 'alpha', '알파', [], 2, [], ctx(), 'ko', [], '', sink, null, false, OFF);
  assert.deepEqual(sink.map((d) => d.name).filter((n) => n === 'delegate' || n === 'send_to_crew'), []);
});

// ── 회의실
test('회의실 파서 — 이어받기는 켜짐 3명(+초과분 안내용 dropped), relayMax 6이면 6명', () => {
  const agents = CREW.map(([slug, name]) => ({ slug, name }));
  const text = '@알파 > @베타 > @감마 > @델타 > @엡실 > @제타 > @에타 진행';
  const on = parseRoomDirectives(text, agents);
  assert.equal(on.relay.length, 3); assert.equal(on.relayDropped.length, 4);
  const off = parseRoomDirectives(text, agents, { relayMax: OFF.relay });
  assert.equal(off.relay.length, 6); assert.deepEqual(off.relayDropped.map((a) => a.slug), ['eta']);
  assert.equal(parseRoomDirectives('@알파 > @베타 > @감마 > @델타', agents).relay.length, 3, '인자 생략 = 켜짐');
});

test('회의실 턴 — 켜짐 방은 chat에 풀림을 넘기지 않고 3명 이어받기·2라운드, 꺼짐 방은 6명 이어받기·풀림 전파', async () => {
  await seed('dl-room');
  const relay7 = '@알파 > @베타 > @감마 > @델타 > @엡실 > @제타 > @에타 진행';
  await runRoomTurn('dl-room', relay7);
  assert.equal(stub.state.calls.length, 3, '켜짐 — 3명까지');
  assert.ok(stub.state.calls.every((c) => !c.opts.delegationRelaxed), '켜짐 방은 풀림 표지 없음');
  assert.match((await loadRoom('dl-room')).messages.find((m) => m.kind === 'relay').text, /이어받기는 3명까지 — 제외: 델타, 엡실, 제타, 에타/);
  stub.state.calls.length = 0;
  await setRoomDelegationLimit('dl-room', false);
  assert.equal((await loadRoom('dl-room')).delegationLimit, false);
  await runRoomTurn('dl-room', relay7);
  assert.equal(stub.state.calls.length, 6, '꺼짐 — 6명까지');
  assert.ok(stub.state.calls.every((c) => c.opts.delegationRelaxed === true), '발언 크루의 chat에 풀림이 전달된다(위임 도구·프롬프트가 따른다)');
  const note = (await loadRoom('dl-room')).messages.filter((m) => m.kind === 'relay').at(-1).text;
  assert.match(note, /이어받기는 6명까지 — 제외: 에타/);
  assert.match(note, /이어서/, '꺼짐은 상한에 닿으면 이어서 지시하라고 안내한다');
});

test('회의실 반응 라운드 — 꺼짐이면 보탤 말이 있는 한 최대 4라운드, 전원 "추가 의견 없음"이면 일찍 끝나고, 켜짐은 2라운드', async () => {
  await seed('dl-rounds');
  await runRoomTurn('dl-rounds', '@알파 @베타 @감마 검토');
  assert.equal(stub.state.calls.length, 6, '켜짐 — 발언 3 + 반응 3');
  await seed('dl-rounds2');
  await setRoomDelegationLimit('dl-rounds2', false);
  await runRoomTurn('dl-rounds2', '@알파 @베타 @감마 검토');
  assert.equal(stub.state.calls.length, 12, '꺼짐 — 3명 × 4라운드');
  const msgs = (await loadRoom('dl-rounds2')).messages;
  assert.deepEqual([...new Set(msgs.filter((m) => m.who !== 'user' && m.who !== 'system').map((m) => m.round ?? 1))], [1, 2, 3, 4], '라운드 표시 1~4');
  assert.match(stub.state.calls[9].prompt, /## 지시 — 반응 라운드/, '3라운드 이후도 반응 프롬프트');
  assert.match(msgs.filter((m) => m.kind === 'round').at(-1).text, /상한|계속/, '상한에 닿으면 방에 안내');
  await seed('dl-rounds3');
  await setRoomDelegationLimit('dl-rounds3', false);
  stub.state.reply = (slug) => (stub.state.calls.length > 3 ? '추가 의견 없음' : `${slug} 의견`);
  await runRoomTurn('dl-rounds3', '@알파 @베타 @감마 검토');
  assert.equal(stub.state.calls.length, 6, '2라운드가 전원 추가 의견 없음이면 거기서 끝 — 쓸데없는 호출 0');
  await seed('dl-rounds4');
  await setRoomDelegationLimit('dl-rounds4', false);
  await runRoomTurn('dl-rounds4', '@알파 @베타 @감마 검토', [], { rounds: 1 });
  assert.equal(stub.state.calls.length, 3, '"1라운드만" 토글은 꺼짐 방에서도 그대로 존중');
});

// ── 저장: 대화방마다
test('1:1 스레드 — 크루마다 따로 저장되고, 새 대화는 켜짐으로 돌아오며, 보관 대화를 이어가면 그 대화의 값이 돌아온다', async () => {
  await seed('dl-thread');
  assert.equal(await thread.getDelegationLimit('dl-thread', 'alpha'), true, '새 대화 기본값 = 켜짐');
  await thread.setDelegationLimit('dl-thread', 'alpha', false);
  assert.equal(await thread.getDelegationLimit('dl-thread', 'alpha'), false);
  assert.equal(await thread.getDelegationLimit('dl-thread', 'beta'), true, '다른 크루 스레드는 그대로');
  await thread.appendTurn('dl-thread', 'beta', { userMsg: '기본값 대화', reply: '네', sessionId: null });
  await thread.resetThread('dl-thread', 'beta');
  assert.equal((await thread.loadThread('dl-thread', 'beta')).delegationLimit, true, '값이 기본이어도 새 대화는 항상 명시적 true — 동기화 경합에서 새 대화가 풀림으로 되돌아오지 않게');
  await thread.appendTurn('dl-thread', 'alpha', { userMsg: '안녕', reply: '네', sessionId: null });
  assert.equal(await thread.getDelegationLimit('dl-thread', 'alpha'), false, '턴을 저장해도 값이 유지된다(스레드 전체를 다시 쓰는 경로)');
  assert.equal((await thread.loadThread('dl-thread', 'alpha')).delegationLimit, false, 'GET 응답(loadThread)에 실려 화면이 읽는다');
  await thread.resetThread('dl-thread', 'alpha');
  assert.equal(await thread.getDelegationLimit('dl-thread', 'alpha'), true, '새 대화는 켜짐');
  assert.equal((await thread.loadThread('dl-thread', 'alpha')).delegationLimit, true, '명시적 켜짐으로 기록 — 동기화 병합에서 옛 꺼짐이 되살아나지 않게');
  const [arch] = await thread.listArchivedSessions('dl-thread', 'alpha');
  await thread.resumeSession('dl-thread', 'alpha', arch.id);
  assert.equal(await thread.getDelegationLimit('dl-thread', 'alpha'), false, '이어가기 = 그 대화가 가졌던 값');
});

test('회의실 — 마치면 켜짐으로, 새 회의(보관)도 켜짐으로, 보관 회의를 열면 그 회의의 값', async () => {
  await seed('dl-roomsave');
  await setRoomDelegationLimit('dl-roomsave', false);
  await runRoomTurn('dl-roomsave', '@알파 의견');
  assert.equal((await loadRoom('dl-roomsave')).delegationLimit, false, '발언을 저장해도 값이 유지');
  await endMeeting('dl-roomsave');
  assert.equal((await loadRoom('dl-roomsave')).delegationLimit, true, '새 회의 기본값 = 켜짐(명시적 true)');
  const { listArchivedMeetings, reopenMeeting } = await import('../src/room.mjs');
  const [m] = await listArchivedMeetings('dl-roomsave');
  await reopenMeeting('dl-roomsave', m.id);
  assert.equal((await loadRoom('dl-roomsave')).delegationLimit, false, '보관 회의를 열면 그 회의가 가졌던 값');
});

test('동기화 병합 — 최근에 바꾼 쪽 값이 이긴다(다시 켠 것도 꺼짐에 지지 않는다)', () => {
  const t = (limit, ts) => Buffer.from(JSON.stringify({ messages: [{ ts, who: 'user', text: 'x' }], delegationLimit: limit }));
  assert.equal(JSON.parse(mergeThread(t(true, 1), t(false, 1), 'local')).delegationLimit, true);
  assert.equal(JSON.parse(mergeThread(t(true, 1), t(false, 1), 'remote')).delegationLimit, false);
});

// ── 배선 핀 — chat() 재귀 재시도 호출(행동으로 만들기 어려운 크래시·잠김 복구 경로)만. 위임받은 동료 턴·프롬프트·CLI 다리는 아래 행동 테스트가 잠근다.
test('배선 — chat() 재귀 재시도 호출은 전부 풀림과 합계 예산 객체를 넘긴다(빠지면 재시도 턴이 2회로 돌아가거나 예산이 새로 생긴다)', async () => {
  const src = await readFile(new URL('../src/chat.mjs', import.meta.url), 'utf8');
  const calls = src.split('\n').filter((l) => /await chat\(wsId, agentSlug,/.test(l));
  assert.ok(calls.length >= 7);
  for (const l of calls) { assert.match(l, /\bdelegationRelaxed\b/, `풀림 미전달: ${l.trim().slice(0, 90)}`); assert.match(l, /\bdelegationTree: tree\b/, `합계 예산 미전달: ${l.trim().slice(0, 90)}`); }
  assert.match(src, /chatOpts: \{[^\n]*delegationRelaxed[^\n]*delegationTree/, '커넥터 후속 턴(runToolFollowUp)도');
});

// ── 쪽지 배달·지시 블록 경로(러너 패리티)
test('쪽지 배달 — 풀린 쪽지만 배달 턴에 relaxed가 실리고, 켜짐 쪽지와 메신저발 쪽지는 실리지 않는다', async () => {
  await seed('dl-deliver');
  const { sendCrewMail, deliverCrewMail } = await import('../src/crewmail.mjs');
  await sendCrewMail('dl-deliver', { from: 'alpha', fromName: '알파', to: 'beta', message: '켜짐 쪽지', hop: 1, chain: ['alpha'] });
  const dtree = newTree({ kind: 'chat', slug: 'alpha' });
  await sendCrewMail('dl-deliver', { from: 'alpha', fromName: '알파', to: 'gamma', message: '풀린 쪽지', hop: 3, chain: ['alpha', 'x', 'y'], relaxed: true, tree: dtree.id });
  await sendCrewMail('dl-deliver', { from: 'alpha', fromName: '알파', to: 'delta', message: '메신저발', hop: 1, chain: ['alpha'], relaxed: true, msgr: { channelId: 'c', orgId: 'o' } });
  const seen = {};
  await deliverCrewMail('dl-deliver', async (slug, msg, opts) => { seen[slug] = { opts, field: msg.relaxed }; });
  assert.equal(seen.beta.opts.relaxed, false); assert.equal(seen.beta.field, undefined);
  assert.deepEqual({ hop: seen.gamma.opts.hop, relaxed: seen.gamma.opts.relaxed, tree: seen.gamma.opts.tree }, { hop: 3, relaxed: true, tree: dtree.id }, '풀린 쪽지의 hop 3 배달 턴이 위임 도구를 가질 수 있고, 합계 예산 id가 함께 간다');
  assert.equal(seen.delta.field, undefined, '메신저발 쪽지는 필드 자체를 쓰지 않는다');
  const sched = await readFile(new URL('../src/scheduler.mjs', import.meta.url), 'utf8');
  assert.match(sched, /\.\.\.\(relaxed \? \{ delegationRelaxed: true, delegationTree: tree \} : \{\}\)/, '스케줄러가 배달 턴 chat()에 풀림과 합계 예산을 잇는다');
});

test('CLI 지시 블록 쪽지 — 단계 상한이 표를 따른다(켜짐 hop 2 거절, 풀림 hop 3 허용·hop 4 거절)이고 풀림이 쪽지에 실린다', async () => {
  await seed('dl-cli');
  const { runDirectives } = await import('../src/cli-directives.mjs');
  const mail = [{ action: 'mail', to: 'beta', message: '이어서 확인' }];
  const run = (opts) => runDirectives('dl-cli', 'alpha', mail, { lang: 'ko', ...opts });
  assert.match((await run({ hop: 2 })).join('\n'), /연쇄 상한\(2단계\)/);
  const tree = newTree({ kind: 'chat', slug: 'alpha' });
  assert.match((await run({ hop: 3, delegationRelaxed: true })).join('\n'), /연쇄 상한\(2단계\)/, '풀림이라 주장해도 합계 예산 객체가 없으면 켜짐(fail-closed)');
  assert.match((await run({ hop: 3, delegationRelaxed: true, delegationTree: tree })).join('\n'), /쪽지 보냄/);
  assert.match((await run({ hop: 4, delegationRelaxed: true, delegationTree: tree })).join('\n'), /연쇄 상한\(4단계\)/);
  assert.match((await run({ hop: 3, delegationRelaxed: true, delegationTree: tree, mirrorCtx: { kind: 'msgr', channelId: 'c', uid: 'u', wsId: 'dl-cli', crewId: 'self', handoffs: [], peers: [] } })).join('\n'), /같은 메신저 조직에 파견된 동료만/, '메신저 맥락은 우편 큐가 아니라 채널 넘김 경로 — 풀림이 우편으로 새지 않는다');
  const { listMail } = await import('../src/crewmail.mjs');
  const sent = (await listMail('dl-cli')).pending.filter((m) => m.to === 'beta');
  assert.equal(sent.length, 1, '허용된 풀림 쪽지 1건만 적재');
});

// ── 라우트(화면이 부르는 경계)
test('라우트 — 스위치 저장 POST(1:1·회의실)와 검증(400·404), 저장값이 GET 응답으로 돌아온다', async () => {
  await seed('dl-route');
  const chatDeleg = await import('../app/api/companies/[ws]/chat/delegation/route.js');
  const roomDeleg = await import('../app/api/companies/[ws]/room/delegation/route.js');
  const chatRoute = await import('../app/api/companies/[ws]/chat/route.js');
  const roomRoute = await import('../app/api/companies/[ws]/room/route.js');
  const P = { params: Promise.resolve({ ws: 'dl-route' }) };
  const post = (mod, body) => mod.POST(new Request('http://127.0.0.1/x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), P);
  const call = async (res) => ({ status: res.status, body: await res.json() });
  assert.deepEqual(await call(await post(chatDeleg, { slug: 'alpha', limit: false })), { status: 200, body: { limit: false } });
  assert.equal((await call(await chatRoute.GET(new Request('http://127.0.0.1/c?slug=alpha'), P))).body.delegationLimit, false, '1:1 GET 응답이 값을 싣는다');
  assert.equal((await call(await chatRoute.GET(new Request('http://127.0.0.1/c?slug=beta'), P))).body.delegationLimit, undefined, '다른 크루는 기본값(필드 없음 = 켜짐)');
  assert.equal((await call(await post(chatDeleg, { slug: 'nobody', limit: false }))).status, 404, '없는 크루 — 빈 스레드 파일이 생기지 않는다');
  assert.equal((await call(await post(chatDeleg, { slug: 'alpha', limit: 'false' }))).status, 400, '불리언만');
  assert.equal((await call(await post(chatDeleg, { limit: true }))).status, 400);
  assert.deepEqual(await call(await post(roomDeleg, { limit: false })), { status: 200, body: { limit: false } });
  assert.equal((await call(await roomRoute.GET(new Request('http://127.0.0.1/r'), P))).body.delegationLimit, false, '회의실 GET 응답이 값을 싣는다');
  assert.equal((await call(await post(roomDeleg, { limit: 1 }))).status, 400);
  assert.deepEqual(await call(await post(roomDeleg, { limit: true })), { status: 200, body: { limit: true } }, '다시 켜기');
  const { readdir } = await import('node:fs/promises');
  assert.ok(!(await readdir(paths('dl-route').chats)).includes('nobody.json'));
});

test('라우트 — 1:1 턴은 저장된 값을 읽어 chat()에 푼 상태만 넘긴다(화면이 보내는 값은 믿지 않는다)', async () => {
  const vm = await import('node:vm');
  const { parse } = await import('espree');
  const src = await readFile(new URL('../app/api/companies/[ws]/chat/route.js', import.meta.url), 'utf8');
  const ast = parse(src, { ecmaVersion: 'latest', sourceType: 'module', range: true });
  let fn; (function visit(n) { if (!n || typeof n !== 'object') return; if (n.type === 'FunctionDeclaration' && n.id.name === 'POST') fn = src.slice(...n.range); for (const v of Object.values(n)) { if (Array.isArray(v)) v.forEach(visit); else if (v && typeof v === 'object') visit(v); } })(ast);
  assert.ok(fn);
  const run = async (stored, body = {}) => {
    const seen = [];
    const ctx = vm.createContext({ Response, console, isStopCommand: () => false, guardCompany: async () => null, beginTurn: async () => 'tid', nudgeSync: () => {}, loadCompany: async () => ({ lang: 'ko' }),
      getDelegationLimit: async () => stored, appendTurn: async () => ({}), paths: () => ({ vault: '/v' }), relative: () => '', import: undefined,
      chat: async (...a) => { seen.push(a[4]); return { reply: 'ok', sessionId: null }; } });
    vm.runInContext(fn, ctx);
    const res = await ctx.POST({ json: async () => ({ slug: 'alpha', message: '구현→검수', delegationRelaxed: true, ...body }) }, { params: Promise.resolve({ ws: 'w' }) });
    assert.equal(res.status, 200);
    return seen[0];
  };
  assert.equal((await run(true)).delegationRelaxed, undefined, '켜짐 저장값 — 요청 본문이 풀림을 주장해도 넘기지 않는다');
  assert.equal((await run(false)).delegationRelaxed, true, '푼 저장값 — chat()에 풀림을 넘긴다');
});

// ── 결함 1: cc 수신자도 쪽지 횟수에 센다
test('쪽지 — 풀림은 cc 수신자도 쪽지 횟수에 센다(1+cc), 켜짐은 종전처럼 세지 않는다', async () => {
  await seed('dl-cc');
  const { listMail } = await import('../src/crewmail.mjs');
  const off = toolsOf('dl-cc', OFF);
  const cc4 = (message) => ({ to: 'beta', cc: ['gamma', 'delta', 'eps', 'zeta'], message });
  assert.match(say(await off.send_to_crew(cc4('첫째'))), /쪽지를 보냈다/);
  assert.match(say(await off.send_to_crew(cc4('둘째'))), /쪽지를 보냈다/, '5 + 5 = 10까지는 허용');
  assert.match(say(await off.send_to_crew({ to: 'beta', message: '셋째' })), /쪽지 상한\(10회\)/, '수신 10명이 차서 한 통도 더 못 보낸다');
  assert.equal((await listMail('dl-cc')).pending.length, 10, '배달 턴 10건(쪽지 2통 × 수신 5명) — 쪽지 10통이면 50건이던 구멍');
  await seed('dl-cc2');
  const off2 = toolsOf('dl-cc2', OFF);
  for (let i = 0; i < 7; i += 1) await off2.send_to_crew({ to: 'beta', message: `단독 ${i}` });
  assert.match(say(await off2.send_to_crew(cc4('넘침'))), /쪽지 상한/, '7건 뒤 5명짜리는 10을 넘으므로 거절');
  assert.equal((await listMail('dl-cc2')).pending.length, 7, '거절된 쪽지는 한 통도 적재되지 않는다');
  await seed('dl-cc3');
  const on = toolsOf('dl-cc3', ON);
  for (const k of ['a', 'b']) assert.match(say(await on.send_to_crew(cc4(k))), /쪽지를 보냈다/);
  assert.match(say(await on.send_to_crew({ to: 'beta', message: 'c' })), /쪽지 한도 초과/, '켜짐은 종전 그대로 쪽지 통수(2)만 센다');
});

// ── 합계 상한(유건 2026-10-01: 풀림일 때 사용자 메시지 하나에서 이어지는 크루 턴 30회)
test('합계 상한 — 표는 30, 트리 객체는 id·남은 수·시작점을 갖고 만료되면 사라진다', () => {
  const t = newTree({ kind: 'chat', slug: 'alpha' });
  assert.equal(t.left, 30); assert.match(t.id, /^[a-z0-9]{8,}$/); assert.deepEqual({ ...t.origin }, { kind: 'chat', slug: 'alpha' });
  assert.equal(getTree(t.id), t);
  assert.equal(spendTree(t, 29), true); assert.equal(spendTree(t, 2), false, '모자라면 한 푼도 차감하지 않는다'); assert.equal(t.left, 1);
  assert.equal(spendTree(t, 1), true); assert.equal(spendTree(t, 1), false);
  const old = newTree({ kind: 'room' }); old.exp = Date.now() - 1;
  assert.equal(getTree(old.id), null, '만료(24시간)된 것은 모르는 id와 같다');
  assert.equal(getTree('nope'), null); assert.equal(getTree(undefined), null);
});

test('합계 상한 — 풀림의 위임·쪽지(cc 포함)가 같은 예산을 차감하고, 바닥나면 "계속할까요?"를 안내한다', async () => {
  await seed('dl-tree', { budget: true });
  const tree = newTree({ kind: 'chat', slug: 'alpha' }); tree.left = 5;
  const a = toolsOf('dl-tree', OFF, { tree });
  const b = toolsOf('dl-tree', OFF, { tree }); // 위임받은 동료 턴 = 다른 서버 인스턴스가 같은 객체를 쓴다
  assert.match(say(await a.delegate({ to: 'beta', task: '1' })), /작업 결과/); assert.equal(tree.left, 4);
  assert.match(say(await b.delegate({ to: 'gamma', task: '2' })), /작업 결과/); assert.equal(tree.left, 3);
  assert.match(say(await a.send_to_crew({ to: 'beta', cc: ['gamma', 'delta'], message: '수신 3명' })), /쪽지를 보냈다/); assert.equal(tree.left, 0, '받는 사람 + cc 수만큼');
  for (const refused of [say(await b.delegate({ to: 'beta', task: '3' })), say(await a.send_to_crew({ to: 'beta', message: '더' }))]) {
    assert.match(refused, /합계 상한\(30회\)/); assert.match(refused, /계속할까요/);
  }
  assert.equal(tree.left, 0);
  // 켜짐은 합계 예산과 무관(종전 동작)
  const on = toolsOf('dl-tree', ON, { tree });
  assert.match(say(await on.delegate({ to: 'beta', task: '켜짐' })), /작업 결과/);
  // 풀림인데 예산 객체를 못 받은 직접 호출도 예산 없는 무제한이 되지 않는다(턴 단위 임시 예산)
  const lone = toolsOf('dl-tree', OFF);
  assert.match(say(await lone.delegate({ to: 'beta', task: '혼자' })), /작업 결과/);
});

test('쪽지 파일 — tree 예산은 받는 사람 수만큼 차감되고, 모르는·만료된 tree와 tree 없는 풀림은 제한 쪽지로 나간다(fail-closed)', async () => {
  await seed('dl-treemail');
  const { sendCrewMail, listMail } = await import('../src/crewmail.mjs');
  const read = async (to, id, kind = 'to') => JSON.parse(await readFile(join(paths('dl-treemail').root, 'mail', to, `${id}-${kind}.json`), 'utf8'));
  const tree = newTree({ kind: 'chat', slug: 'alpha' }); tree.left = 3;
  const base = { from: 'alpha', fromName: '알파', hop: 1, chain: ['alpha'], relaxed: true };
  const id1 = await sendCrewMail('dl-treemail', { ...base, to: 'beta', cc: ['gamma'], message: '둘에게', tree: tree.id });
  assert.equal(tree.left, 1);
  assert.deepEqual([(await read('beta', id1)).relaxed, (await read('beta', id1)).tree], [true, tree.id]);
  assert.equal((await read('gamma', id1, 'cc')).relaxed, true, 'cc 사본도 풀림 + 같은 예산 id');
  await assert.rejects(() => sendCrewMail('dl-treemail', { ...base, to: 'beta', cc: ['gamma'], message: '모자람', tree: tree.id }), { code: 'TREE_CAP' });
  assert.equal(tree.left, 1, '거절된 쪽지는 예산을 건드리지 않는다');
  assert.equal((await listMail('dl-treemail')).pending.length, 2, '적재도 없다');
  const unknown = await sendCrewMail('dl-treemail', { ...base, to: 'delta', message: '모르는 id', tree: 'nope' });
  const exp = newTree({ kind: 'room' }); exp.exp = Date.now() - 1;
  const expired = await sendCrewMail('dl-treemail', { ...base, to: 'eps', message: '만료', tree: exp.id });
  const none = await sendCrewMail('dl-treemail', { ...base, to: 'zeta', message: 'tree 없음' });
  for (const [to, id] of [['delta', unknown], ['eps', expired], ['zeta', none]]) { const m = await read(to, id); assert.equal(m.relaxed, undefined, `${to}: 제한 쪽지`); assert.equal(m.tree, undefined); }
});

test('쪽지 배달 직전 — 시작 대화의 스위치를 다시 읽어 다시 걸었으면 제한 상태로 배달한다(이미 쌓인 풀린 쪽지 포함)', async () => {
  await seed('dl-relock', { budget: true });
  const { crewmailTurn } = await import('../src/scheduler.mjs');
  const lastUser = async () => (await thread.loadThread('dl-relock', 'beta')).messages.filter((m) => m.who === 'user').at(-1).text;
  const deliver = async (treeId, hop = 3, relaxedField = true) => {
    const chain = ['alpha', 'x', 'y'].slice(0, hop);
    const msg = { id: 'm1', kind: 'to', from: 'y', fromName: '와이', message: '검수해 줘', hop, chain, ...(relaxedField ? { relaxed: true, tree: treeId } : {}) };
    await crewmailTurn('dl-relock', 'beta', msg, { from: 'y', hop, chain, relaxed: relaxedField, tree: relaxedField ? treeId : null });
    return lastUser();
  };
  const tree = newTree({ kind: 'chat', slug: 'alpha' });
  await thread.setDelegationLimit('dl-relock', 'alpha', false);
  assert.match(await deliver(tree.id), /회신이 필요하면/, '풀림 유지 — hop 3에서도 회신 안내');
  await thread.setDelegationLimit('dl-relock', 'alpha', true);
  assert.doesNotMatch(await deliver(tree.id), /회신이 필요하면/, '다시 걸었으면 풀린 쪽지도 제한 상태(hop 3은 도구 없음)로 배달');
  await thread.setDelegationLimit('dl-relock', 'alpha', false);
  assert.doesNotMatch(await deliver('unknown-id'), /회신이 필요하면/, '예산을 모르는 쪽지(재시작·다른 프로세스)는 제한 상태로');
  // 회의실에서 시작된 쪽지는 방 파일의 값을 본다
  const rtree = newTree({ kind: 'room' });
  await setRoomDelegationLimit('dl-relock', false);
  assert.match(await deliver(rtree.id), /회신이 필요하면/);
  await setRoomDelegationLimit('dl-relock', true);
  assert.doesNotMatch(await deliver(rtree.id), /회신이 필요하면/);
  // 재검수 LOW-1: 제한으로 떨어진 hop 1·2 쪽지는 켜짐 규칙(hop 2 미만이면 도구·회신 안내가 남는다)으로 돌면 합계 예산 밖에서 턴을 더 만든다
  // → 켜짐 단계 상한까지 hop을 올려 배달한다(도구도 회신 안내도 없다). 풀림 유지·애초에 켜짐인 쪽지는 그대로.
  await thread.setDelegationLimit('dl-relock', 'alpha', false);
  const t1 = newTree({ kind: 'chat', slug: 'alpha' });
  assert.match(await deliver(t1.id, 1), /회신이 필요하면/, '풀림 유지 — hop 1 그대로');
  await thread.setDelegationLimit('dl-relock', 'alpha', true);
  assert.doesNotMatch(await deliver(t1.id, 1), /회신이 필요하면/, '다시 걸었다 — hop 1 쪽지가 hop 2로 올라 더 퍼지지 않는다');
  await thread.setDelegationLimit('dl-relock', 'alpha', false);
  assert.doesNotMatch(await deliver('unknown-id', 2), /회신이 필요하면/, '예산 id를 모르는 hop 2 쪽지도 제한 + 더 퍼지지 않음');
  assert.match(await deliver(null, 1, false), /회신이 필요하면/, '애초에 켜짐인 hop 1 쪽지는 종전 그대로(회신 가능)');
});

test('회의실 — 한 회의 턴의 모든 발언자·모든 라운드가 같은 합계 예산 객체를 받는다(켜짐은 없음)', async () => {
  await seed('dl-roomtree');
  await runRoomTurn('dl-roomtree', '@알파 @베타 검토');
  assert.ok(stub.state.calls.every((c) => !c.opts.delegationTree), '켜짐 — 예산 객체 없음');
  await seed('dl-roomtree2');
  await setRoomDelegationLimit('dl-roomtree2', false);
  await runRoomTurn('dl-roomtree2', '@알파 @베타 검토');
  const trees = new Set(stub.state.calls.map((c) => c.opts.delegationTree));
  assert.equal(stub.state.calls.length, 8); assert.equal(trees.size, 1, '2명 × 4라운드가 한 객체를 공유');
  const [tree] = trees; assert.equal(getTree(tree.id), tree); assert.deepEqual({ ...tree.origin }, { kind: 'room' });
  await runRoomTurn('dl-roomtree2', '@알파 @베타 다음 안건');
  const second = new Set(stub.state.calls.slice(8).map((c) => c.opts.delegationTree));
  assert.equal(second.size, 1); assert.notEqual([...second][0], tree, '회의 턴마다(사용자 메시지마다) 새 예산');
});

// ── 결함 3: CLI 지시 블록 쪽지의 턴당 상한
test('CLI 지시 블록 쪽지 — 턴당 횟수(켜짐 2·풀림 10, cc 포함)와 합계 예산을 한 카운터로 막는다', async () => {
  await seed('dl-blocks');
  const { runDirectives } = await import('../src/cli-directives.mjs');
  const { listMail } = await import('../src/crewmail.mjs');
  const blocks = (n, extra = {}) => Array.from({ length: n }, (_, i) => ({ action: 'mail', to: 'beta', message: `블록 ${i}`, ...extra }));
  const sent = async () => (await listMail('dl-blocks')).pending.length;
  const notes = await runDirectives('dl-blocks', 'alpha', blocks(25), { lang: 'ko' });
  assert.equal(await sent(), 2, '켜짐 — 블록 25개여도 쪽지 2건');
  assert.equal(notes.filter((n) => /쪽지 한도 초과/.test(n)).length, 23);
  await seed('dl-blocks2');
  const tree = newTree({ kind: 'chat', slug: 'alpha' }); const counters = { delegate: 0, mail: 0 };
  const sent2 = async () => (await listMail('dl-blocks2')).pending.length;
  await runDirectives('dl-blocks2', 'alpha', blocks(6), { delegationRelaxed: true, delegationTree: tree, counters });
  await runDirectives('dl-blocks2', 'alpha', blocks(6), { delegationRelaxed: true, delegationTree: tree, counters }); // steer 구간 + 마지막 블록 처리가 같은 카운터
  assert.equal(await sent2(), 10, '풀림 — 두 번에 걸쳐도 합쳐 10건'); assert.equal(tree.left, 20); assert.equal(counters.mail, 10);
  await seed('dl-blocks3');
  const c3 = { delegate: 0, mail: 0 }; const t3 = newTree({ kind: 'chat', slug: 'alpha' });
  const withCc = blocks(3, { cc: ['gamma', 'delta', 'eps', 'zeta'] });
  const n3 = await runDirectives('dl-blocks3', 'alpha', withCc, { delegationRelaxed: true, delegationTree: t3, counters: c3 });
  assert.equal((await listMail('dl-blocks3')).pending.length, 10, 'cc 4명 쪽지 2통(수신 10) 뒤 세 번째는 거절'); assert.match(n3.at(-1), /쪽지 한도 초과/);
  await seed('dl-blocks4');
  const t4 = newTree({ kind: 'chat', slug: 'alpha' }); t4.left = 2;
  const n4 = await runDirectives('dl-blocks4', 'alpha', blocks(4), { delegationRelaxed: true, delegationTree: t4, counters: { delegate: 0, mail: 0 } });
  assert.equal((await listMail('dl-blocks4')).pending.length, 2); assert.ok(n4.some((n) => /합계 상한/.test(n)), '합계 예산이 바닥나면 안내');
});

// ── 결함 4: 쪽지 파일 위조 차단
test('금고 — 크루는 mail/ 쪽지 파일을 읽지도 쓰지도 못한다(relaxed·hop·tree 위조 차단)', async () => {
  await seed('dl-gate');
  const { makeIsForbidden, makePermissionGate } = await import('../src/permission-gate.mjs');
  const root = paths('dl-gate').root;
  assert.equal(await makeIsForbidden(root)(join(root, 'mail', 'beta', 'm1-to.json')), true);
  const gate = makePermissionGate('dl-gate', 'alpha', root);
  assert.equal((await gate('Write', { file_path: join(root, 'mail', 'beta', 'm1-to.json'), content: '{"relaxed":true,"hop":0}' })).behavior, 'deny');
  assert.equal((await gate('Bash', { command: `echo '{"relaxed":true}' > mail/beta/m1-to.json` })).behavior, 'deny');
  assert.equal((await gate('Bash', { command: 'cat ./mail/beta/m1-to.json' })).behavior, 'deny');
  assert.equal((await gate('Bash', { command: 'curl -s https://api.example.com/v1/mail/123' })).behavior, 'allow', 'URL 경로는 오차단 금지');
  assert.equal((await gate('Bash', { command: 'ls vault/mail/' })).behavior, 'allow', '책상 하위 데이터');
});

// ── 결함 6: 접근성
test('스위치 접근성 — 이름은 고정, 상태는 aria-checked, 설명은 aria-describedby로 이어진 텍스트(title에만 두지 않는다)', async () => {
  const { loadComponent } = await import('./helpers/load-component.mjs');
  const { mount } = await import('./helpers/mini-react.mjs');
  const stubs = { '../../ui': 'export const ConfirmModal = () => null;', '../../i18n': "export const useLang = () => ({ t: (k, v) => k + (v && v.n ? ':' + v.n : '') });" };
  const { DelegationToggle } = await loadComponent(fileURLToPath(new URL('../app/c/[ws]/delegation-toggle.jsx', import.meta.url)), { stubs, real: [fileURLToPath(new URL('../src/delegation-limits.mjs', import.meta.url))] }); // .pathname은 Windows에서 'D:\\D:\\…'가 된다(CI 실측)
  const find = (node, pred, out = []) => { if (!node || typeof node !== 'object') return out; if (Array.isArray(node)) { node.forEach((n) => find(n, pred, out)); return out; } if (node.props && pred(node)) out.push(node); if (node.props) find(node.props.children, pred, out); return out; };
  const render = async (limited, scope) => { const m = mount(DelegationToggle, { limited, onChange: async () => {}, scope }); const st = await m.flush(); return st.out; };
  const info = async (limited, scope = 'chat') => {
    const out = await render(limited, scope);
    const [btn] = find(out, (n) => n.props['data-testid'] === 'deleg-toggle');
    const desc = find(out, (n) => n.props.id && n.props.id === btn.props['aria-describedby'])[0];
    return { btn: btn.props, desc };
  };
  const on = await info(true), off = await info(false);
  assert.equal(on.btn['aria-label'], off.btn['aria-label'], '이름은 상태와 무관하게 고정 — 상태까지 이름에 넣으면 스위치 상태가 두 번 읽힌다');
  assert.equal(on.btn.role, 'switch'); assert.equal(on.btn['aria-checked'], true); assert.equal(off.btn['aria-checked'], false);
  assert.equal(on.btn['aria-pressed'], undefined);
  assert.ok(on.desc && off.desc, 'aria-describedby가 가리키는 요소가 있다');
  assert.match(String(on.desc.props.children), /deleg\.hintOn\.chat/); assert.match(String(off.desc.props.children), /deleg\.hintOff\.chat/);
  assert.notEqual(on.btn['aria-describedby'], (await info(true, 'chat')).btn['aria-describedby'], '같은 scope의 칩 둘(메인 대화 + 분할 창)도 설명 id가 겹치지 않는다 — useId');
  assert.notEqual(on.btn['aria-describedby'], (await info(true, 'room')).btn['aria-describedby']);
  assert.equal(await render(null, 'chat'), null, '읽는 중에는 그리지 않는다');
});

// ── 결함 7: 회의실 반응 라운드 힌트
test('반응 라운드 힌트 — 풀린 방은 최대 라운드 수와 늘어나는 비용을 말한다(ko/en)', async () => {
  const i18n = await readFile(new URL('../app/i18n.jsx', import.meta.url), 'utf8');
  const m = i18n.match(/'room\.roundsHintOff': \['([^']+)', '([^']+)'\]/);
  assert.ok(m, 'room.roundsHintOff ko/en');
  for (const t of [m[1], m[2]]) assert.match(t, /\{n\}/, '라운드 수는 표에서(문장에 박지 않는다)');
  assert.match(m[1], /최대/); assert.match(m[2], /up to/i);
  const page = await readFile(new URL('../app/c/[ws]/room/page.jsx', import.meta.url), 'utf8');
  assert.match(page, /title=\{delegLimited === false \? t\('room\.roundsHintOff', \{ n: DELEGATION_LIMITS\.off\.rounds \}\) : t\('room\.roundsHint'\)\}/);
});
