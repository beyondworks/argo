// 위임 제한 스위치 — 크루 간 위임 제한(2회·2단계·회의실 3명/2라운드)을 대화방마다 풀고 다시 거는 계약.
// 켜짐 = 지금 제한 그대로, 꺼짐 = 안전 상한(위임 10·쪽지 10·단계 4·이어받기 6명·반응 4라운드)까지.
// 메신저(팀 메신저) 크루 턴은 이 스위치의 범위가 아니라 어떤 경로로도 풀리지 않는다.
// 모델은 부르지 않는다 — 위임 대상 턴은 월 예산 초과 안내(비용 0)로, 회의실은 chat 스텁(helpers/room-chat-stub.mjs)으로 격리.
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
const { DELEGATION_LIMITS, limitsFor } = await import('../src/delegation-limits.mjs');
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
const toolsOf = (ws, lim, { hop = 0, chain = [], ctx = null, peers = colleagues } = {}) => {
  const sink = [];
  makeCrewServer(ws, 'alpha', '알파', peers, hop, chain, ctx, 'ko', [], '', sink, null, false, lim);
  return Object.fromEntries(sink.map((d) => [d.name, d.handler]));
};
const say = (r) => r.content[0].text;

// ── 표
test('제한 표 — 켜짐은 지금 값(2·2·2단계·3명·2라운드), 꺼짐은 안전 상한(10·10·4단계·6명·4라운드), 메신저 맥락은 어떤 값이 와도 켜짐', () => {
  assert.deepEqual({ ...ON }, { relaxed: false, delegate: 2, mail: 2, hop: 2, relay: 3, rounds: 2 });
  assert.deepEqual({ ...OFF }, { relaxed: true, delegate: 10, mail: 10, hop: 4, relay: 6, rounds: 4 });
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
  assert.notEqual((await loadRoom('dl-roomsave')).delegationLimit, false, '새 회의 기본값 = 켜짐');
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

// ── 배선 핀(소비자 전수) — 새 호출 경로가 풀림 전파를 빠뜨리지 않게
test('배선 — chat() 재귀 재시도 호출은 전부 delegationRelaxed를 넘긴다(한 곳이 빠지면 재시도 턴만 2회로 돌아간다)', async () => {
  const src = await readFile(new URL('../src/chat.mjs', import.meta.url), 'utf8');
  const calls = src.split('\n').filter((l) => /await chat\(wsId, (agentSlug|target\.slug),/.test(l));
  assert.ok(calls.length >= 7);
  for (const l of calls) assert.match(l, /\bdelegationRelaxed\b|\blim\.relaxed\b/, `풀림 미전달: ${l.trim().slice(0, 90)}`);
  assert.match(src, /chatOpts: \{[^\n]*delegationRelaxed/, '커넥터 후속 턴(runToolFollowUp)도');
});

// ── 쪽지 배달·지시 블록 경로(러너 패리티)
test('쪽지 배달 — 풀린 쪽지만 배달 턴에 relaxed가 실리고, 켜짐 쪽지와 메신저발 쪽지는 실리지 않는다', async () => {
  await seed('dl-deliver');
  const { sendCrewMail, deliverCrewMail } = await import('../src/crewmail.mjs');
  await sendCrewMail('dl-deliver', { from: 'alpha', fromName: '알파', to: 'beta', message: '켜짐 쪽지', hop: 1, chain: ['alpha'] });
  await sendCrewMail('dl-deliver', { from: 'alpha', fromName: '알파', to: 'gamma', message: '풀린 쪽지', hop: 3, chain: ['alpha', 'x', 'y'], relaxed: true });
  await sendCrewMail('dl-deliver', { from: 'alpha', fromName: '알파', to: 'delta', message: '메신저발', hop: 1, chain: ['alpha'], relaxed: true, msgr: { channelId: 'c', orgId: 'o' } });
  const seen = {};
  await deliverCrewMail('dl-deliver', async (slug, msg, opts) => { seen[slug] = { opts, field: msg.relaxed }; });
  assert.equal(seen.beta.opts.relaxed, false); assert.equal(seen.beta.field, undefined);
  assert.deepEqual({ hop: seen.gamma.opts.hop, relaxed: seen.gamma.opts.relaxed }, { hop: 3, relaxed: true }, '풀린 쪽지의 hop 3 배달 턴이 위임 도구를 가질 수 있다');
  assert.equal(seen.delta.field, undefined, '메신저발 쪽지는 필드 자체를 쓰지 않는다');
  const sched = await readFile(new URL('../src/scheduler.mjs', import.meta.url), 'utf8');
  assert.match(sched, /opts\.relaxed === true && !msg\.msgr \? \{ delegationRelaxed: true \}/, '스케줄러가 배달 턴 chat()에 풀림을 잇는다(메신저발 제외)');
});

test('CLI 지시 블록 쪽지 — 단계 상한이 표를 따른다(켜짐 hop 2 거절, 풀림 hop 3 허용·hop 4 거절)이고 풀림이 쪽지에 실린다', async () => {
  await seed('dl-cli');
  const { runDirectives } = await import('../src/cli-directives.mjs');
  const mail = [{ action: 'mail', to: 'beta', message: '이어서 확인' }];
  const run = (opts) => runDirectives('dl-cli', 'alpha', mail, { lang: 'ko', ...opts });
  assert.match((await run({ hop: 2 })).join('\n'), /연쇄 상한\(2단계\)/);
  assert.match((await run({ hop: 3, delegationRelaxed: true })).join('\n'), /쪽지 보냄/);
  assert.match((await run({ hop: 4, delegationRelaxed: true })).join('\n'), /연쇄 상한\(4단계\)/);
  assert.match((await run({ hop: 3, delegationRelaxed: true, mirrorCtx: { kind: 'msgr', channelId: 'c', uid: 'u', wsId: 'dl-cli', crewId: 'self', handoffs: [], peers: [] } })).join('\n'), /같은 메신저 조직에 파견된 동료만/, '메신저 맥락은 우편 큐가 아니라 채널 넘김 경로 — 풀림이 우편으로 새지 않는다');
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
