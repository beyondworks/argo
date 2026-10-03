// 풀 오토는 사장이 직접 시킨 턴에만(유건 결정 2026-10-03, "위임도 막기") — 실제 SDK 턴(가짜 Messages 엔드포인트) + 실제 커넥터(OAuth 테스트 서버)로
// 커넥터 쓰기 게이트의 행동을 잠근다. 사장 직접 턴은 결재 없이 실행, 위임받은 동료 턴·쪽지 배달 턴은 결재로 간다.
// 장시간 작업·결재 후속 턴은 그 일을 시작한 턴이 사장 직접 턴이 아니면 그 크루를 from으로 이어받는다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, writeFile, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from './helpers/tmp.mjs';

const root = await mkdtemp(join(tmpdir(), 'argo-fa-owner-'));
const home = await mkdtemp(join(tmpdir(), 'argo-fa-owner-home-'));
Object.assign(process.env, { ARGO_ROOT: root, HOME: home, USERPROFILE: home, ARGO_ENC_VAULT: '0', ARGO_MODEL_CATALOG: 'off', ARGO_NATIVE_RUNNERS: 'off' });
for (const key of ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']) delete process.env[key];

// 가짜 모델 — 크루별(페르소나 마커) 첫 요청에 한 번 지정한 도구를 부르고, 그 뒤엔 'done'
let plan = {}; const firedBy = new Set(); const reqs = [];
const sse = (res, evs) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); for (const [e, d] of evs) res.write(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`); res.end(); };
const start = () => ({ type: 'message_start', message: { id: `m${reqs.length}`, type: 'message', role: 'assistant', model: 'claude-x', content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } });
const textReply = (res, text) => sse(res, [['message_start', start()], ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }], ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }], ['message_stop', { type: 'message_stop' }]]);
const srv = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
    if (req.method !== 'POST' || !req.url.startsWith('/v1/messages')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{}'); }
    const body = JSON.parse(b || '{}');
    const system = typeof body.system === 'string' ? body.system : JSON.stringify(body.system ?? '');
    if (!(body.tools ?? []).length) return textReply(res, 'title');
    const who = (/페르소나-([A-D])-마커/.exec(system)?.[1] ?? '?').toLowerCase();
    reqs.push({ who, sys: system, messages: JSON.stringify(body.messages ?? []) });
    const fire = plan[who] && !firedBy.has(who) ? plan[who] : null;
    if (fire) {
      firedBy.add(who);
      return sse(res, [['message_start', start()],
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `tu-${who}`, name: fire.name, input: {} } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(fire.input) } }],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }], ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } }], ['message_stop', { type: 'message_stop' }]]);
    }
    return textReply(res, 'done');
  });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
process.env.ARGO_CLAUDE_BASE_URL = `http://127.0.0.1:${srv.address().port}`;

const { createCompany, paths, updateCompany } = await import('../src/workspace.mjs');
const { saveRunnerCred } = await import('../src/runners/creds.mjs');
const { chat } = await import('../src/chat.mjs');
const { startConnect, closeConnectorPools } = await import('../src/connectors.mjs');
const { loadApprovals } = await import('../src/approvals.mjs');
const { crewmailTurn } = await import('../src/scheduler.mjs');
const { _makeJobHandlerForTest, queueDir, JOBS_QUEUE } = await import('../src/gateway.mjs');
const { _followUpForTest } = await import('../src/approval-actions.mjs');
const { startOauthTestServer } = await import('./helpers/oauth-test-server.mjs');

const ws = 'fa-owner';
await createCompany(ws, '풀 오토 검수', 'owner', null, 'ko');
const p = paths(ws);
await mkdir(p.agents, { recursive: true });
for (const [slug, name, mark] of [['a', '알파', 'A'], ['b', '브라보', 'B'], ['captain', '캡틴', 'C']]) await writeFile(join(p.agents, `${slug}.md`), `---\nname: ${name}\nrole: 검증\nrunner: claude\n---\n페르소나-${mark}-마커.\n`); // slug captain 크루 — 사장 표지와 이름이 같은 크루(재검수 최종 MEDIUM-1)
await saveRunnerCred(ws, 'claude', 'apikey', `sk-ant-api03-${'x'.repeat(80)}`); // 형식만 맞춘 가짜 — 요청은 로컬 가짜 엔드포인트로만 간다
await updateCompany(ws, { fullAuto: true });

const s = await startOauthTestServer();
after(async () => { await closeConnectorPools(); await s.close(); srv.close(); });
const ID = 'demo-fa';
const { authUrl, done } = await startConnect(ws, { id: ID, url: s.mcpUrl, scopes: ['spike.read', 'spike.write'] });
{ const r1 = await fetch(authUrl, { redirect: 'manual' }); await fetch(new URL(r1.headers.get('location'))); }
assert.equal((await done).ok, true, '사전 조건: 커넥터 연결');

const SEND = (to) => ({ name: 'mcp__crew__use_connector', input: { server: ID, tool: 'send_mail_demo', args: { to, body: 'hi' } } });
const sent = () => s.counters.toolCalls.send_mail_demo ?? 0;
const reset = (next) => { plan = next; firedBy.clear(); reqs.length = 0; };
// 새로 생긴 결재만 — addApproval은 목록 앞에 넣는다(unshift). 길이로 자르면 가장 오래된 결재를 본다(재검수 3차 MEDIUM-1)
const snap = async () => new Set((await loadApprovals(ws)).map((x) => x.id));
const newer = async (ids) => (await loadApprovals(ws)).filter((x) => !ids.has(x.id));

test('사장 직접 턴 — 풀 오토 회사에서 커넥터 쓰기가 결재 없이 실행된다(대조군)', async () => {
  reset({ a: SEND('owner@example.com') });
  const before = sent(); const apBefore = (await loadApprovals(ws)).length;
  await chat(ws, 'a', '메일 보내', null, {});
  assert.equal(sent(), before + 1, '사장 직접 턴은 바로 발송');
  assert.equal((await loadApprovals(ws)).length, apBefore, '결재 없음');
});

test('위임받은 동료 턴 — 커넥터 쓰기가 결재로 간다(발송은 서버에 닿지 않는다)', async () => {
  reset({ a: { name: 'mcp__crew__delegate', input: { to: 'b', task: '메일 보내 줘' } }, b: SEND('deleg@example.com') });
  const before = sent(); const ap0 = await snap();
  await chat(ws, 'a', '브라보에게 맡겨', null, {});
  assert.ok(reqs.some((r) => r.who === 'b'), '위임 턴이 돌았다');
  assert.equal(sent(), before, '위임 턴에서 결재 없이 발송됐다');
  const ap = await newer(ap0);
  assert.equal(ap.length, 1); assert.equal(ap[0].slug, 'b');
});

test('쪽지 배달 턴 — 커넥터 쓰기가 결재로 간다', async () => {
  reset({ b: SEND('mail@example.com') });
  const before = sent(); const apBefore = (await loadApprovals(ws)).length;
  await crewmailTurn(ws, 'b', { id: 'm1', from: 'a', fromName: '알파', kind: 'to', message: '메일 보내 줘', hop: 1, chain: ['a'] }, { from: 'a', hop: 1, chain: ['a'] });
  assert.equal(sent(), before, '쪽지 턴에서 결재 없이 발송됐다');
  assert.equal((await loadApprovals(ws)).length, apBefore + 1);
});

test('장시간 작업 — 위임 턴에서 건 작업은 시작한 크루를 from으로 이어받아 실행된다(사장 직접 턴에서 건 작업은 from 없음)', async () => {
  const jobs = async () => { try { return await Promise.all((await readdir(queueDir(ws, JOBS_QUEUE))).filter((n) => n.endsWith('.json')).map(async (n) => JSON.parse(await readFile(join(queueDir(ws, JOBS_QUEUE), n), 'utf8')))); } catch { return []; } };
  const LONG = { name: 'mcp__crew__start_long_task', input: { title: '긴 일', prompt: '오래 걸리는 일' } };
  reset({ a: { name: 'mcp__crew__delegate', input: { to: 'b', task: '긴 일 걸어 줘' } }, b: LONG });
  await chat(ws, 'a', '맡겨', null, {});
  const fromDeleg = (await jobs()).find((j) => j.slug === 'b');
  assert.equal(fromDeleg?.from, 'a', '위임 턴에서 건 작업은 위임한 크루를 기록한다');
  reset({ a: LONG });
  await chat(ws, 'a', '직접 걸어', null, {});
  const direct = (await jobs()).find((j) => j.slug === 'a');
  assert.ok(direct && !direct.from, '사장 직접 턴에서 건 작업은 from 없음');
  // 실행 — 기록한 from을 턴에 넘긴다
  const seen = [];
  const handler = _makeJobHandlerForTest(ws, { runChat: async (w, slug, prompt, sid, opts) => { seen.push(opts); return { reply: 'ok', sessionId: null }; } });
  await handler({ ...fromDeleg, tries: 0 }); await handler({ ...direct, tries: 0 });
  assert.equal(seen[0].notOwnerDirect, 'a'); assert.ok(!seen[0].from, '작업 턴의 출처(turnSource·프롬프트)는 그대로 — 풀 오토만 끈다(LOW-5)'); assert.ok(!seen[1].notOwnerDirect);
});

test('결재 후속 턴 — 사장 직접 턴이 아닌 턴에서 올린 결재의 후속은 그 크루를 from·chain으로 이어받는다', async () => {
  const seen = [];
  const runChat = async (w, slug, msg, sid, opts) => { seen.push(opts); return { reply: 'ok', sessionId: null }; };
  await _followUpForTest(ws, { id: 'ap1', slug: 'b', from: 'a', kind: 'action', action: '메일 발송', status: 'approved' }, true, { runChat });
  await _followUpForTest(ws, { id: 'ap2', slug: 'b', kind: 'action', action: '메일 발송', status: 'approved' }, true, { runChat });
  assert.equal(seen[0].notOwnerDirect, 'a'); assert.ok(!seen[0].from && !seen[0].chain, '후속 턴의 출처(turnSource·프롬프트)는 그대로 — 풀 오토만 끈다(LOW-5)');
  assert.ok(!seen[1].notOwnerDirect, '사장 직접 턴에서 올린 결재의 후속은 그대로');
});

// ── 루틴: 사장 직접 턴에서 만든 것만 풀 오토(유건 결정 2026-10-03) ──
const routinesMod = await import('../src/routines.mjs');
const { addRoutine, runRoutine, loadRoutines, updateRoutine } = routinesMod;

test('루틴 — 사장이 만든 루틴은 결재 없이, 출처(from)가 있는 루틴은 결재로, 출처 필드가 없는 옛 루틴은 종전대로 결재 없이', async () => {
  const owner = await addRoutine(ws, { agentSlug: 'a', title: '사장 루틴', prompt: '메일 보내', schedule: { type: 'daily', time: '09:00' } });
  const crewMade = await addRoutine(ws, { agentSlug: 'a', title: '크루 루틴', prompt: '메일 보내', schedule: { type: 'daily', time: '09:00' }, from: 'b' });
  assert.equal(crewMade.from, 'b', '출처를 기록한다');
  // 옛 루틴 — from 필드 자체가 없는 기록(이 변경 전 버전이 쓴 파일 그대로)
  const { writeFile: wf } = await import('node:fs/promises');
  const all = await loadRoutines(ws);
  const legacy = { ...all.find((r) => r.id === owner.id), id: 'rlegacy', title: '옛 루틴' };
  delete legacy.from;
  await wf(p.routines, JSON.stringify([...all, legacy], null, 2));
  for (const [id, expectSent] of [[owner.id, true], [crewMade.id, false], ['rlegacy', true]]) {
    reset({ a: SEND(`${id}@example.com`) });
    const before = sent(); const apBefore = (await loadApprovals(ws)).length;
    await runRoutine(ws, id);
    assert.equal(sent() - before, expectSent ? 1 : 0, `${id}: 발송 여부`);
    assert.equal((await loadApprovals(ws)).length - apBefore, expectSent ? 0 : 1, `${id}: 결재 여부`);
  }
});

test('루틴 — schedule_task: 위임 턴에서 만들면 위임한 크루를, 사장 직접 턴이면 출처 없음을 기록한다', async () => {
  const SCHED = (title) => ({ name: 'mcp__crew__schedule_task', input: { title, prompt: '나중에 메일', type: 'daily', time: '10:00' } });
  reset({ a: { name: 'mcp__crew__delegate', input: { to: 'b', task: '예약 걸어 줘' } }, b: SCHED('위임 예약') });
  await chat(ws, 'a', '맡겨', null, {});
  reset({ a: SCHED('직접 예약') });
  await chat(ws, 'a', '예약해', null, {});
  const rs = await loadRoutines(ws);
  assert.equal(rs.find((r) => r.title === '위임 예약')?.from, 'a');
  assert.ok(rs.find((r) => r.title === '직접 예약') && !rs.find((r) => r.title === '직접 예약').from);
});

test('루틴 — 고쳐 써도(사람 편집) 출처가 지워지지 않고, 사장 직접 턴이 아닌 턴이 다시 켜면 출처가 그 크루로 바뀐다', async () => {
  const r = await addRoutine(ws, { agentSlug: 'a', title: '편집 대상', prompt: 'x', schedule: { type: 'daily', time: '09:00' }, from: 'b' });
  const edited = await updateRoutine(ws, r.id, { title: '편집됨', from: null, enabled: false });
  assert.equal(edited.from, 'b', '편집(API·화면)으로 출처를 지울 수 없다');
  const o = await addRoutine(ws, { agentSlug: 'a', title: '사장 것', prompt: 'x', schedule: { type: 'daily', time: '09:00' }, enabled: false });
  reset({ b: { name: 'mcp__crew__cancel_routine', input: { id: o.id, action: 'on' } } });
  await crewmailTurn(ws, 'b', { id: 'm2', from: 'a', fromName: '알파', kind: 'to', message: '예약 켜 줘', hop: 1, chain: ['a'] }, { from: 'a', hop: 1, chain: ['a'] });
  const after = (await loadRoutines(ws)).find((x) => x.id === o.id);
  assert.equal(after.enabled, true);
  assert.equal(after.from, 'a', '쪽지 턴(위임 사슬 a)에서 켠 루틴은 출처가 a가 된다 — 풀 오토로 돌지 않는다');
});

// ── 통합본 재검수(rev3) ──
test('LOW-7 — 사장 직접 턴의 A가 B에게 장시간 작업·예약을 걸면 A의 위임(from=a), 자기 자신이면 사장 직접', async () => {
  const jobs = async () => { try { return await Promise.all((await readdir(queueDir(ws, JOBS_QUEUE))).filter((n) => n.endsWith('.json')).map(async (n) => JSON.parse(await readFile(join(queueDir(ws, JOBS_QUEUE), n), 'utf8')))); } catch { return []; } };
  reset({ a: { name: 'mcp__crew__start_long_task', input: { title: 'B에게 긴 일', prompt: '메일 보내', agentSlug: 'b' } } });
  await chat(ws, 'a', 'B에게 긴 일 걸어', null, {});
  assert.equal((await jobs()).find((j) => j.title === 'B에게 긴 일')?.from, 'a');
  reset({ a: { name: 'mcp__crew__schedule_task', input: { title: 'B에게 예약', prompt: 'x', type: 'daily', time: '11:00', agentSlug: 'b' } } });
  await chat(ws, 'a', 'B에게 예약 걸어', null, {});
  assert.equal((await loadRoutines(ws)).find((r) => r.title === 'B에게 예약')?.from, 'a');
});

test('MEDIUM-2 — CLI 지시 블록의 결재와 커넥터 결재도 출처(위임 사슬의 크루)를 남긴다', async () => {
  const { runDirectives } = await import('../src/cli-directives.mjs');
  const ap0 = await snap();
  await runDirectives(ws, 'b', [{ action: 'approval', request: '메일 발송', reason: '보고' }], { chain: ['a'], hop: 1 });
  const { callConnectorTool } = await import('../src/connectors.mjs');
  const r = await callConnectorTool(ws, ID, 'send_mail_demo', { to: 'x@example.com', body: 'x' }, { slug: 'b', fullAuto: false, from: 'a' });
  assert.equal(r.error, 'approval_pending');
  const added = await newer(ap0);
  assert.equal(added.length, 2);
  assert.deepEqual(added.map((x) => x.from), ['a', 'a'], 'CLI 지시 블록·커넥터 결재 모두 from=a');
});

test('LOW-5 — 풀 오토 표지는 모델에게 가는 글을 바꾸지 않는다(풀 오토 꺼진 회사에서 표지 있음/없음 비교: 결재 후속·장시간 작업·루틴)', async () => {
  const { resetThread } = await import('../src/thread.mjs');
  await updateCompany(ws, { fullAuto: false });
  try {
    // 시스템 프롬프트에는 턴 시작 시각(분 단위)이 들어간다 — 두 번 잡는 사이 분이 바뀌면 다르게 보인다(전체 실행 부하에서 실측). 그 한 줄만 가린다
    const clock = (t) => String(t).replace(/오늘은 \d{4}-\d{2}-\d{2}, 지금은 \([^)]*\) \d{2}:\d{2}/g, '오늘은 D, 지금은 T');
    const capture = async (fn) => { await resetThread(ws, 'b'); reset({}); await fn(); const b = reqs.filter((x) => x.who === 'b'); return b.map((x) => [clock(x.sys), clock(x.messages)]); };
    const pairs = [
      [() => _followUpForTest(ws, { id: 'cmp1', slug: 'b', from: 'a', kind: 'action', action: '메일 발송', status: 'approved' }, true), () => _followUpForTest(ws, { id: 'cmp1', slug: 'b', kind: 'action', action: '메일 발송', status: 'approved' }, true)],
      [() => _makeJobHandlerForTest(ws)({ id: 'cj', slug: 'b', title: '긴 일', prompt: '같은 지시', tries: 0, from: 'a' }), () => _makeJobHandlerForTest(ws)({ id: 'cj', slug: 'b', title: '긴 일', prompt: '같은 지시', tries: 0 })],
    ];
    const rt = await addRoutine(ws, { agentSlug: 'b', title: '비교 루틴', prompt: '같은 지시', schedule: { type: 'daily', time: '08:00' }, from: 'a' });
    const rt2 = await addRoutine(ws, { agentSlug: 'b', title: '비교 루틴', prompt: '같은 지시', schedule: { type: 'daily', time: '08:00' } });
    pairs.push([() => runRoutine(ws, rt.id), () => runRoutine(ws, rt2.id)]);
    for (const [withFlag, without] of pairs) {
      const x = await capture(withFlag); const y = await capture(without);
      assert.ok(x.length && y.length, '턴이 돌았다');
      assert.deepEqual(x, y, '표지가 있어도 시스템 프롬프트·메시지가 같다');
    }
  } finally { await updateCompany(ws, { fullAuto: true }); }
});

// ── 통합본 3차 재검수 ──
test('LOW-1 — 사장 직접 턴의 A가 B의 예약을 다시 켜면 A의 위임, 자기 예약이면 사장 직접', async () => {
  const forB = await addRoutine(ws, { agentSlug: 'b', title: 'B 예약', prompt: 'x', schedule: { type: 'daily', time: '07:00' }, enabled: false });
  const forA = await addRoutine(ws, { agentSlug: 'a', title: 'A 예약', prompt: 'x', schedule: { type: 'daily', time: '07:00' }, enabled: false });
  for (const id of [forB.id, forA.id]) { reset({ a: { name: 'mcp__crew__cancel_routine', input: { id, action: 'on' } } }); await chat(ws, 'a', '예약 다시 켜', null, {}); }
  const rs = await loadRoutines(ws);
  const b = rs.find((r) => r.id === forB.id); const a = rs.find((r) => r.id === forA.id);
  assert.equal(b.enabled, true); assert.equal(b.from, 'a', '다른 크루의 예약을 켜면 A의 위임');
  assert.equal(a.enabled, true); assert.ok(!a.from, '자기 예약은 사장 직접');
});

test('LOW-2 — 사장이 보낸 쪽지(쪽지 API·회의실 참조, from=captain)의 배달 턴은 사장 직접 턴: 커넥터 쓰기가 결재 없이', async () => {
  reset({ b: SEND('captain-mail@example.com') });
  const before = sent(); const ap0 = await snap();
  await crewmailTurn(ws, 'b', { id: 'mc', from: 'captain', fromName: '사장', fromRole: 'captain', kind: 'to', message: '메일 보내 줘', hop: 0, chain: [] }, { from: 'captain', hop: 0, chain: [] });
  assert.equal(sent(), before + 1, '사장 쪽지의 배달 턴은 풀 오토');
  assert.equal((await newer(ap0)).length, 0);
  // 결재 출처의 'captain'은 이제 크루 slug뿐이다 — 사장 쪽지 턴의 결재는 출처가 비고, 출처가 captain인 결재(그 이름의 크루)의 후속은 풀 오토가 아니다
  const seen = [];
  await _followUpForTest(ws, { id: 'capf', slug: 'b', from: 'captain', kind: 'action', action: '메일 발송', status: 'approved' }, true, { runChat: async (w, slug, msg, sid, opts) => { seen.push(opts); return { reply: 'ok', sessionId: null }; } });
  assert.equal(seen[0].notOwnerDirect, 'captain', '출처 문자열로 사장을 판정하지 않는다');
});

// ── 최종 재검수 MEDIUM-1: 사장 판정을 from 문자열('captain')로 하지 않는다 ──
test('MEDIUM-1 — slug가 captain인 크루의 위임·쪽지는 사장 직접 턴이 아니다(커넥터 쓰기가 결재로)', async () => {
  reset({ c: { name: 'mcp__crew__delegate', input: { to: 'b', task: '메일 보내 줘' } }, b: SEND('deleg-captain@example.com') });
  let before = sent(); let ap0 = await snap();
  await chat(ws, 'captain', '브라보에게 맡겨', null, {});
  assert.ok(reqs.some((r) => r.who === 'b'), '위임 턴이 돌았다');
  assert.equal(sent(), before, 'captain 크루의 위임 턴이 결재 없이 발송했다');
  assert.equal((await newer(ap0)).length, 1);
  reset({ b: SEND('mail-captain@example.com') });
  before = sent(); ap0 = await snap();
  await crewmailTurn(ws, 'b', { id: 'mcx', from: 'captain', fromName: '캡틴', kind: 'to', message: '메일 보내 줘', hop: 1, chain: ['captain'] }, { from: 'captain', hop: 1, chain: ['captain'] });
  assert.equal(sent(), before, 'captain 크루의 쪽지 배달 턴이 결재 없이 발송했다');
  assert.equal((await newer(ap0)).length, 1);
});

test('MEDIUM-1 — 크루 slug에 captain을 주지 않는다(영입 문은 -n을 붙인다)', async () => {
  const { createAgentCard } = await import('../src/persona.mjs');
  await createCompany('slug-co', '슬러그', 'owner', null, 'en');
  const r = await createAgentCard('slug-co', { name: 'Captain', role: 'x', prompt: 'y' });
  assert.notEqual(r.slug, 'captain');
  assert.match(r.slug, /^captain-\d+$/);
  const { isAssignableSlug } = await import('../src/slug.mjs');
  assert.equal(isAssignableSlug('captain'), false); assert.equal(isAssignableSlug('room-main'), false); assert.equal(isAssignableSlug('captain-2'), true);
});

// ── 마지막 확인 검수 LOW-1·LOW-2 ──
test('LOW-1 — 사장 쪽지의 배달 턴은 1:1 공유 노트를 모델에 싣지도 가져가지도 않는다', async () => {
  const { appendSharedNote, takeSharedNotes } = await import('../src/thread.mjs');
  await appendSharedNote(ws, 'b', 'SHARED-NOTE-MARKER');
  reset({});
  await crewmailTurn(ws, 'b', { id: 'mn', from: 'captain', fromName: '사장', fromRole: 'captain', kind: 'to', message: '확인해 줘', hop: 0, chain: [] }, { from: 'captain', hop: 0, chain: [] });
  assert.ok(reqs.some((r) => r.who === 'b'), '배달 턴이 돌았다');
  assert.ok(!reqs.some((r) => r.messages.includes('SHARED-NOTE-MARKER')), '공유 노트가 모델 요청에 실리지 않았다');
  assert.equal((await takeSharedNotes(ws, 'b')).length, 1, '공유 노트는 다음 1:1 턴을 위해 남아 있다');
});

test('LOW-2 — 사장 쪽지의 배달 턴 활동 기록은 fromRole로 사장을 남긴다(from 문자열이 아니라)', async () => {
  const { readEvents } = await import('../src/events.mjs');
  reset({});
  await crewmailTurn(ws, 'b', { id: 'me', from: 'captain', fromName: '사장', fromRole: 'captain', kind: 'to', message: '활동 기록 확인', hop: 0, chain: [] }, { from: 'captain', hop: 0, chain: [] });
  const ev = (await readEvents(ws)).filter((e) => e.type === 'turn' && e.slug === 'b' && e.source === 'crewmail')[0]; // readEvents는 최신순
  assert.equal(ev?.fromRole, 'captain'); assert.ok(!ev.from);
  reset({});
  await crewmailTurn(ws, 'b', { id: 'mf', from: 'captain', fromName: '캡틴', kind: 'to', message: '크루 captain', hop: 1, chain: ['captain'] }, { from: 'captain', hop: 1, chain: ['captain'] });
  const ev2 = (await readEvents(ws)).filter((e) => e.type === 'turn' && e.slug === 'b' && e.source === 'crewmail')[0]; // readEvents는 최신순
  assert.equal(ev2?.from, 'captain', 'slug captain 크루의 쪽지는 크루 출처'); assert.ok(!ev2.fromRole);
});

