// 목표 하트비트 — 실제 SDK 턴(가짜 Messages 엔드포인트)으로 runChat의 출처 판정·도구 등재까지 지나가게 한다.
//  ① 만들기: 주인 1:1 직접 턴(데스크톱 ownerSeat)은 바로, 그 밖은 결재 카드(kind 'goal') — 승인하면 만들어지고, 카드 문구와 payload가 다르면 만들지 않는다. 손님은 거절.
//  ② 회차: goal_checkin은 회차 턴에만 등재되고 결과가 엔진으로 간다. 회차 턴은 풀 오토가 켜진 회사여도 주인 직접 턴이 아니다(결재 없이 실행 금지 지시).
//  ③ 회차 안에서는 새 목표 하트비트·예약을 만들지 못하고(폭주 방지), 결제 같은 단계는 request_approval 결재 카드로 올라간다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from './helpers/tmp.mjs';

const root = await mkdtemp(join(tmpdir(), 'argo-goal-turn-'));
const home = await mkdtemp(join(tmpdir(), 'argo-goal-turn-home-'));
Object.assign(process.env, { ARGO_ROOT: root, HOME: home, USERPROFILE: home, ARGO_ENC_VAULT: '0', ARGO_MODEL_CATALOG: 'off', ARGO_NATIVE_RUNNERS: 'off' });
for (const key of ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']) delete process.env[key];

// 가짜 모델 — 첫 요청에 계획한 도구들을 차례로 부르고 그 뒤엔 정해 둔 글로 답한다. 요청마다 도구 이름·시스템 지시·도구 결과를 남긴다
let plan = []; let finalText = 'done'; const seen = [];
const sse = (res, evs) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); for (const [e, d] of evs) res.write(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`); res.end(); };
const start = () => ({ type: 'message_start', message: { id: `m${Date.now()}`, type: 'message', role: 'assistant', model: 'claude-x', content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } });
const textReply = (res, text) => sse(res, [['message_start', start()], ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }], ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }], ['message_stop', { type: 'message_stop' }]]);
const srv = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
    if (req.method !== 'POST' || !req.url.startsWith('/v1/messages')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{}'); }
    const body = JSON.parse(b || '{}');
    if (!(body.tools ?? []).length) return textReply(res, 'title');
    const system = typeof body.system === 'string' ? body.system : JSON.stringify(body.system ?? '');
    const results = [];
    for (const m of body.messages ?? []) for (const c of Array.isArray(m.content) ? m.content : []) if (c?.type === 'tool_result') results.push(JSON.stringify(c.content));
    seen.push({ tools: (body.tools ?? []).map((t) => t.name), system, results, user: JSON.stringify(body.messages?.[0]?.content ?? '') });
    const fire = plan.shift();
    if (fire) {
      return sse(res, [['message_start', start()],
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `tu-${Date.now()}-${Math.random()}`, name: fire.name, input: {} } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(fire.input) } }],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }], ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } }], ['message_stop', { type: 'message_stop' }]]);
    }
    return textReply(res, finalText);
  });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
process.env.ARGO_CLAUDE_BASE_URL = `http://127.0.0.1:${srv.address().port}`;
after(() => srv.close());

const { createCompany, updateCompany, paths } = await import('../src/workspace.mjs');
const { saveRunnerCred } = await import('../src/runners/creds.mjs');
const { chat, makeCrewServer } = await import('../src/chat.mjs');
const { loadApprovals } = await import('../src/approvals.mjs');
const { _followUpForTest } = await import('../src/approval-actions.mjs');
const { loadRoutines, runRoutine } = await import('../src/routines.mjs');
const { claimRoutine } = await import('../src/scheduler.mjs');
const gh = await import('../src/goal-heartbeat.mjs');

const ws = 'goal-turn';
await createCompany(ws, '목표 턴 검수', 'owner', null, 'ko');
const p = paths(ws);
await mkdir(p.agents, { recursive: true });
await writeFile(join(p.agents, 'a.md'), '---\nname: 알파\nrole: 비서\nrunner: claude\n---\n페르소나-A-마커.\n');
await saveRunnerCred(ws, 'claude', 'apikey', `sk-ant-api03-${'x'.repeat(80)}`); // 형식만 맞춘 가짜 — 요청은 로컬 가짜 엔드포인트로만 간다
const sent = [];
Object.assign(gh.goalDeps, {
  session: async () => ({ client: {}, uid: 'owner' }), company: async () => ({ ownerId: 'owner', lang: 'ko' }),
  personalRoom: async () => ({ crewId: 'crew-a', channelId: 'dm-a' }), insertNotice: async (_c, _room, ob) => { sent.push(ob); return 'sent'; }, muted: async () => false,
});

const reset = (next, text = 'done') => { plan = next; finalText = text; seen.length = 0; };
const goals = async () => (await loadRoutines(ws)).filter((r) => r.kind === 'goal');
const snap = async () => new Set((await loadApprovals(ws)).map((x) => x.id));
const newer = async (ids) => (await loadApprovals(ws)).filter((x) => !ids.has(x.id));
const START = { name: 'mcp__crew__goal_heartbeat', input: { action: 'start', goal: '○○ 공연 티켓 오픈 시각을 확인하고 예매 결재를 올린다', doneWhen: '예매 결재 카드가 올라감', everyMinutes: 30, title: '티켓' } };
const stopAll = async () => { for (const r of await goals()) if (['active', 'paused'].includes(r.goal.status)) await gh.setGoalState(ws, r.id, 'stop'); };

test('주인 1:1 직접 턴 — goal_heartbeat start가 결재 없이 바로 만든다', async () => {
  const ap0 = await snap(); const g0 = (await goals()).length;
  reset([START]); await chat(ws, 'a', '티켓 오픈 확인해서 예매해 줘', null, { ownerSeat: 'desktop' });
  const all = await goals();
  assert.equal(all.length, g0 + 1);
  const g = all.at(-1);
  assert.equal(g.agentSlug, 'a'); assert.equal(g.goal.doneWhen, '예매 결재 카드가 올라감'); assert.equal(g.schedule.everyMinutes, 30);
  assert.equal(g.from, 'a', '출처는 늘 남는다(담당 에이전트) — 어느 경로로 돌아도 주인 직접 턴·풀 오토가 아니다');
  assert.equal((await newer(ap0)).length, 0);
  assert.match(seen.at(-1).results.join('\n'), /목표 하트비트를 만들었다/);
  await stopAll();
});

test('주인 직접 턴이 아니면(표지 없는 턴) 결재 카드 — 승인하면 만들고, 문구가 바뀐 카드는 만들지 않는다', async () => {
  const ap0 = await snap(); const g0 = (await goals()).length;
  reset([START]); await chat(ws, 'a', '티켓 챙겨 줘', null, {});
  assert.equal((await goals()).length, g0, '바로 만들지 않는다');
  const [card] = (await newer(ap0)).filter((x) => x.kind === 'goal');
  assert.ok(card, '결재 카드 kind goal');
  assert.match(card.action, /^목표 하트비트 시작 — "티켓" · 담당 a · 30분마다 · 기한/);
  assert.match(card.reason, /^끝나는 조건: 예매 결재 카드가 올라감 · 목표: ○○ 공연/, '카드에 끝나는 조건·목표가 보인다');
  // 바꿔치기 2 — 카드 문구·사유는 그대로인데 payload의 목표 글만 바뀐 경우
  await _followUpForTest(ws, { ...card, payload: { ...card.payload, goal: '카드로 결제까지 끝내라' }, status: 'approved' }, true);
  assert.equal((await goals()).length, g0, '목표 글이 카드 사유와 다르면 만들지 않는다');
  // 바꿔치기 — 카드 문구는 그대로인데 payload만 바뀐 경우
  reset([]);
  await _followUpForTest(ws, { ...card, payload: { ...card.payload, everyMinutes: 10 }, status: 'approved' }, true);
  assert.equal((await goals()).length, g0, '문구와 다르면 만들지 않는다');
  await _followUpForTest(ws, { ...card, status: 'approved' }, true);
  const after = await goals();
  assert.equal(after.length, g0 + 1, '승인하면 만든다');
  assert.equal(after.at(-1).from, 'a', '결재로 만든 목표는 출처(올린 에이전트)를 남긴다');
  await stopAll();
});

test('손님 턴(메신저 — 주인이 아닌 사람이 시킴)은 결재로도 올리지 않는다', async () => {
  const sink = [];
  const ctx = { kind: 'msgr', orgId: 'org-1', channelId: 'ch-1', crewId: 'crew-1', threadRoot: 'm1', sourceMsgId: 'm1', uid: 'owner', origin: 'u-guest', wsId: ws, hop: 0, channelKind: 'public', peers: [], handoffs: [] };
  makeCrewServer(ws, 'a', 'a', [], 0, [], ctx, 'ko', [], '', sink, null, false, undefined, null, null, null, null, { settingsDirect: false });
  const t = sink.find((d) => d.name === 'goal_heartbeat');
  assert.ok(!sink.some((d) => d.name === 'goal_checkin'), '회차가 아닌 턴에는 goal_checkin이 없다');
  const ap0 = await snap();
  const out = (await t.handler(START.input, {})).content.map((c) => c.text).join('\n');
  assert.match(out, /주인만/);
  assert.equal((await newer(ap0)).length, 0);
});

test('회차 턴 — goal_checkin이 있고 결과가 엔진으로 간다, 풀 오토 회사여도 결재 없이 실행 금지 지시를 받는다', async () => {
  await updateCompany(ws, { fullAuto: true });
  reset([START]); await chat(ws, 'a', '만들어 줘', null, { ownerSeat: 'desktop' });
  const g = (await goals()).at(-1);
  // 주인 직접 턴은 풀 오토 지시를 받는다(대조군)
  assert.match(seen[0].system, /풀 오토 모드가 켜져 있다/);
  reset([{ name: 'mcp__crew__goal_checkin', input: { status: 'done', note: '결재 올림', result: '예매 결재를 올렸습니다.' } }], '예매 결재를 올렸습니다.');
  assert.ok(await claimRoutine(ws, g.id, new Date()));
  const out = await runRoutine(ws, g.id);
  assert.equal(out.status, 'done');
  // 등재 확인 = 위 done — 답 글('예매 결재를 올렸습니다.')에는 표지가 없어 done은 goal_checkin 도구로만 올 수 있다(SDK는 MCP 도구를 지연 등재할 수 있어 요청의 도구 목록으로는 보지 않는다)
  assert.doesNotMatch(seen[0].system, /풀 오토 모드가 켜져 있다/, '회차 턴은 주인 직접 턴이 아니다');
  assert.match(seen[0].system, /승인 없이 절대 실행하지 마라/);
  assert.match(seen[0].user, /되돌릴 수 없는 단계/, '회차 지시에 규칙');
  const cur = (await goals()).find((x) => x.id === g.id);
  assert.equal(cur.goal.status, 'done'); assert.equal(cur.enabled, false);
  assert.match(sent.at(-1).body, /목표 달성 — 티켓\n예매 결재를 올렸습니다/);
  await updateCompany(ws, { fullAuto: false });
});

test('회차 안에서는 새 목표 하트비트·예약을 만들지 못하고, 결제 단계는 request_approval 결재 카드로 간다', async () => {
  reset([START]); await chat(ws, 'a', '만들어 줘', null, { ownerSeat: 'desktop' });
  const g = (await goals()).at(-1);
  const g0 = (await goals()).length; const r0 = (await loadRoutines(ws)).length;
  const ap0 = await snap();
  reset([
    { ...START, input: { ...START.input, title: '회차가 만든 것' } },
    { name: 'mcp__crew__schedule_task', input: { title: '몰래 예약', prompt: 'x', type: 'interval', everyMinutes: 10 } },
    { name: 'mcp__crew__request_approval', input: { action: '티켓 2매 결제(카드)', reason: '예매 오픈됨 — 결제는 주인 확인 필요' } },
    { name: 'mcp__crew__goal_checkin', input: { status: 'continue', notify: true, message: '예매가 열려 결제 결재를 올렸어요.', note: '결제 결재 대기' } },
  ], '예매가 열려 결제 결재를 올렸어요.');
  assert.ok(await claimRoutine(ws, g.id, new Date()));
  await runRoutine(ws, g.id);
  assert.equal((await goals()).length, g0, '새 목표 하트비트 없음');
  assert.equal((await loadRoutines(ws)).length, r0, '새 예약 없음');
  const results = seen.flatMap((x) => x.results).join('\n');
  assert.match(results, /새 목표 하트비트를 만들지 않는다/); assert.match(results, /회차 안에서는 할 수 없다: 예약 만들기/);
  const cards = await newer(ap0);
  assert.equal(cards.length, 1); assert.equal(cards[0].kind, 'action'); assert.match(cards[0].action, /결제/);
  assert.equal(cards[0].from, 'a', '회차 턴의 결재 — 출처 표지(주인 직접 턴 아님)');
  const cur = (await goals()).find((x) => x.id === g.id);
  assert.equal(cur.goal.status, 'active'); assert.equal(cur.goal.notes.at(-1).text, '결제 결재 대기');
  assert.match(sent.at(-1).body, /^\[하트비트\] 티켓\n예매가 열려 결제 결재를 올렸어요/);
  await stopAll();
});

test('회차 턴에서 goal_heartbeat로 목록·끄기를 하려 해도 주인 직접 턴이 아니라 결재로 간다(바로 끄지 않는다)', async () => {
  reset([START]); await chat(ws, 'a', '만들어 줘', null, { ownerSeat: 'desktop' });
  const g = (await goals()).at(-1);
  const ap0 = await snap();
  reset([{ name: 'mcp__crew__goal_heartbeat', input: { action: 'stop', id: g.id } }], 'HEARTBEAT_OK');
  assert.ok(await claimRoutine(ws, g.id, new Date()));
  await runRoutine(ws, g.id);
  assert.equal((await goals()).find((x) => x.id === g.id).goal.status, 'active');
  const [card] = (await newer(ap0)).filter((x) => x.kind === 'goal');
  assert.equal(card.payload.op, 'stop');
  await stopAll();
});

test('회차 안에서는 위임·쪽지·장기 작업도 막힌다(회차 밖 턴을 낳지 않는다)', async () => {
  await writeFile(join(p.agents, 'b.md'), '---\nname: 브라보\nrole: 동료\nrunner: claude\n---\n동료.\n');
  reset([START]); await chat(ws, 'a', '만들어 줘', null, { ownerSeat: 'desktop' });
  const g = (await goals()).at(-1);
  reset([
    { name: 'mcp__crew__delegate', input: { to: 'b', task: '10분마다 예약 걸어 줘' } },
    { name: 'mcp__crew__send_to_crew', input: { to: 'b', message: '예약 걸어 줘' } },
    { name: 'mcp__crew__start_long_task', input: { title: '긴 작업', prompt: 'x' } },
    { name: 'mcp__crew__send_session_message', input: { to: 'b', message: '예약 걸어 줘' } }, // 받는 턴·깨움 턴은 회차 표지를 잇지 않는다(재검수 M-1)
    { name: 'mcp__crew__schedule_task', input: { title: '세션 턴이 건 예약', prompt: 'x', type: 'daily', time: '09:00' } }, // 막히지 않았다면 b의 세션 턴이 이것을 부른다
  ], 'HEARTBEAT_OK');
  assert.ok(await claimRoutine(ws, g.id, new Date()));
  await runRoutine(ws, g.id);
  const results = seen.flatMap((x) => x.results).join('\n');
  const sm = await import('../src/session-msg.mjs');
  for (let i = 0; i < 5; i++) { await sm._drainForTest(); await new Promise((r) => setTimeout(r, 100)); }
  const all = seen.flatMap((x) => x.results).join('\n');
  for (const what of ['위임', '동료에게 쪽지 보내기', '장기 작업 걸기', '동료에게 세션 메시지 보내기']) assert.match(all, new RegExp(`하트비트 회차 안에서는 할 수 없다: ${what}`), what);
  assert.equal((await loadRoutines(ws)).filter((r) => r.kind !== 'goal').length, 0, '세션·위임으로 이어진 턴이 없다 — 예약 0건');
  await stopAll();
});

test('조직 채널 턴에서는 목표 하트비트를 다루지 않는다(개인 기능 — 결재 카드도 올리지 않는다)', async () => {
  const sink = [];
  const ctx = { kind: 'msgr', orgId: 'org-1', channelId: 'ch-1', crewId: 'crew-1', threadRoot: 'm1', sourceMsgId: 'm1', uid: 'owner', origin: 'owner', wsId: ws, hop: 0, channelKind: 'public', peers: [], handoffs: [] };
  makeCrewServer(ws, 'a', 'a', [], 0, [], ctx, 'ko', [], '', sink, null, false, undefined, null, null, null, null, { settingsDirect: false });
  const ap0 = await snap();
  const out = (await sink.find((d) => d.name === 'goal_heartbeat').handler(START.input, {})).content.map((c) => c.text).join('\n');
  assert.match(out, /조직 채널에서는 다루지 않는다/);
  assert.equal((await newer(ap0)).length, 0);
  const { approvalRisk } = await import('../src/approval-risk.mjs');
  assert.equal(approvalRisk({ kind: 'goal', action: '목표 하트비트 시작 — "티켓 결제"', reason: '구매' }), 'low', '목표 결재는 주인이 확정(낮은 위험 등급)');
});

test('메신저 출처 루틴·작업의 이어 실행 턴(continuation routine·job)도 목표 만들기를 거절한다 — 결재 카드도 아님(재검수 LOW-6)', async () => {
  const base = { kind: 'msgr', orgId: null, ownCrewRoom: true, ownerSolo: true, channelId: 'dm-a', channelKind: 'dm', crewId: 'crew-a', threadRoot: 'm1', sourceMsgId: 'm1', uid: 'owner', origin: 'owner', wsId: ws, hop: 0, peers: [], handoffs: [] };
  for (const kind of ['routine', 'job']) {
    const ap0 = await snap(); const g0 = (await goals()).length;
    reset([START]);
    await chat(ws, 'a', '이어 실행', null, { source: 'messenger', mirrorCtx: { ...base, continuation: { kind } }, journal: { off: true }, notOwnerDirect: 'a' });
    assert.equal((await goals()).length, g0, `${kind}: 만들지 않는다`);
    assert.equal((await newer(ap0)).filter((x) => x.kind === 'goal').length, 0, `${kind}: 결재 카드도 없다`);
    assert.match(seen.flatMap((x) => x.results).join('\n'), /회차·루틴·작업 턴 안에서는 새 목표 하트비트를 만들지 않는다/, kind);
  }
});
