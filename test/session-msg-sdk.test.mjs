// 세션 메시지 크루 도구 — 실제 SDK 턴(claude-agent-sdk)을 로컬 가짜 Messages 엔드포인트로 돌려 도구 배선을 행동으로 잠근다
// (ARGO_CLAUDE_BASE_URL — 실자격·비용 0). 크루 A가 send_session_message로 B에게 보내면 B 턴 1번, B 답이 오면 A 턴 1번.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from './helpers/tmp.mjs';

const root = await mkdtemp(join(tmpdir(), 'argo-sessmsg-sdk-'));
const home = await mkdtemp(join(tmpdir(), 'argo-sessmsg-sdk-home-'));
Object.assign(process.env, { ARGO_ROOT: root, HOME: home, USERPROFILE: home, ARGO_ENC_VAULT: '0', ARGO_MODEL_CATALOG: 'off', ARGO_NATIVE_RUNNERS: 'off' });
for (const key of ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']) delete process.env[key];

let call = null; let fired = false; const reqs = [];
let plan = {}; const firedBy = new Set(); // 크루별 첫 요청에 한 번씩 낼 도구 호출(사슬 테스트)
const sse = (res, evs) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); for (const [e, d] of evs) res.write(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`); res.end(); };
const start = () => ({ type: 'message_start', message: { id: `m${reqs.length}`, type: 'message', role: 'assistant', model: 'claude-x', content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } });
const textReply = (res, text) => sse(res, [['message_start', start()], ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }], ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }], ['message_stop', { type: 'message_stop' }]]);
const srv = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
    if (req.method === 'POST' && req.url.startsWith('/v1/messages')) {
      const body = JSON.parse(b || '{}');
      const system = typeof body.system === 'string' ? body.system : JSON.stringify(body.system ?? '');
      if (!(body.tools ?? []).length) return textReply(res, 'title'); // 제목 생성 같은 도구 없는 요청
      const who = (/페르소나-([A-D])-마커/.exec(system)?.[1] ?? '?').toLowerCase();
      reqs.push({ who, sys: system, hasTool: b.includes('send_session_message'), messages: JSON.stringify(body.messages ?? []) }); // MCP 도구는 ToolSearch 뒤로 미뤄져 tools 배열에 없을 수 있다 — 요청 전체에서 이름을 찾는다
      const planned = plan[who] && !firedBy.has(who) ? plan[who] : null;
      if (planned) firedBy.add(who);
      const fire = planned ?? (call && !fired && who === 'a' ? call : null);
      if (fire) {
        if (!planned) fired = true;
        return sse(res, [['message_start', start()],
          ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu1', name: fire.name, input: {} } }],
          ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(fire.input) } }],
          ['content_block_stop', { type: 'content_block_stop', index: 0 }], ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } }], ['message_stop', { type: 'message_stop' }]]);
      }
      return textReply(res, who === 'b' ? 'B-답-토큰' : 'A-끝');
    }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}');
  });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
process.env.ARGO_CLAUDE_BASE_URL = `http://127.0.0.1:${srv.address().port}`;
after(() => srv.close());

const { createCompany, paths, updateCompany } = await import('../src/workspace.mjs');
const { saveRunnerCred } = await import('../src/runners/creds.mjs');
const { chat } = await import('../src/chat.mjs');
const { loadThread, setDelegationLimit, resetThread } = await import('../src/thread.mjs');
const sess = await import('../src/session-msg.mjs');
const ws = 'sessmsg-sdk';
await createCompany(ws, '세션 메시지 검수', 'owner', null, 'ko');
const p = paths(ws);
await mkdir(p.agents, { recursive: true });
for (const [slug, name] of [['a', '알파'], ['b', '브라보'], ['c', '찰리'], ['d', '델타']]) await writeFile(join(p.agents, `${slug}.md`), `---\nname: ${name}\nrole: 검증\nrunner: claude\n---\n페르소나-${slug.toUpperCase()}-마커.\n`);
await saveRunnerCred(ws, 'claude', 'apikey', `sk-ant-api03-${'x'.repeat(80)}`); // 형식만 맞춘 가짜 — 요청은 로컬 가짜 엔드포인트로만 간다
const TOOL = 'mcp__crew__send_session_message';

test('크루 도구 — A가 B에게 세션 메시지를 보내면 B 턴 1번, B 답이 오면 A가 한 번 깨어난다', async () => {
  call = { name: TOOL, input: { to: 'b', message: '자료 찾아 줘' } }; fired = false; reqs.length = 0;
  await chat(ws, 'a', '브라보에게 물어보고 정리해', null, {});
  assert.ok(reqs.find((r) => r.who === 'a')?.hasTool, '사장 직접 턴에는 도구가 광고된다');
  await sess._drainForTest();
  const bReqs = reqs.filter((r) => r.who === 'b');
  assert.equal(bReqs.length, 1, 'B 턴 1번');
  assert.match(bReqs[0].messages, /세션 메시지/); assert.match(bReqs[0].messages, /자료 찾아 줘/);
  const wake = reqs.filter((r) => r.who === 'a' && r.messages.includes('B-답-토큰'));
  assert.equal(wake.length, 1, 'B 답이 실린 A 턴 1번');
  const a = (await loadThread(ws, 'a')).messages;
  assert.ok(a.some((m) => m.via === 'session' && m.src?.dir === 'reply' && m.src.from === 'b'), 'A 방에 알림 줄');
  const b = (await loadThread(ws, 'b')).messages;
  assert.equal(b.at(-1).text, 'B-답-토큰', 'B 방에 B의 답');
});

test('경계 — 회의실처럼 다른 사람이 보는 턴에는 도구를 싣지 않는다(불러도 B 턴이 생기지 않는다)', async () => {
  call = { name: TOOL, input: { to: 'b', message: '회의실에서 몰래' } }; fired = false; reqs.length = 0;
  const bBefore = (await loadThread(ws, 'b')).messages.length;
  await chat(ws, 'a', '안녕', null, { source: 'room', mirrorCtx: { room: 'r1:a:0:0' } });
  await sess._drainForTest();
  const first = reqs.find((r) => r.who === 'a');
  assert.ok(first, 'A 요청이 있다');
  assert.ok(!first.hasTool, '회의실 턴에는 광고되지 않는다');
  assert.equal(reqs.filter((r) => r.who === 'b').length, 0, 'B 턴 없음');
  assert.equal((await loadThread(ws, 'b')).messages.length, bBefore, 'B 방에 아무것도 들어가지 않는다');
});

// 사슬 A(사장 직접 턴) → B → C → D. C가 보내는 순간 hop 2 — 켜짐이면 상한(2)에 걸리고 풀림이면(4) D가 돈다.
// 중간 크루(B·C) 방의 스위치는 일부러 반대로 둔다 — 사슬은 시작한 방(A)의 스위치만 따른다.
async function runChain({ aRelaxed, middleRelaxed }) {
  await sess._resetForTest();
  for (const s of ['a', 'b', 'c', 'd']) await resetThread(ws, s); // 새 대화 = 빈 스레드·위임 제한 켜짐(앞 테스트의 안내 줄이 섞이지 않게)
  if (aRelaxed) await setDelegationLimit(ws, 'a', false);
  if (middleRelaxed) { await setDelegationLimit(ws, 'b', false); await setDelegationLimit(ws, 'c', false); }
  call = null; reqs.length = 0; firedBy.clear();
  plan = { a: { name: TOOL, input: { to: 'b', message: '1단계' } }, b: { name: TOOL, input: { to: 'c', message: '2단계' } }, c: { name: TOOL, input: { to: 'd', message: '3단계' } } };
  await chat(ws, 'a', '사슬 시작', null, aRelaxed ? { delegationRelaxed: true } : {}); // chat 라우트가 A 방 스위치를 읽어 넘기는 것과 같은 모양
  await sess._drainForTest();
  plan = {};
  return { dTurns: reqs.filter((r) => r.who === 'd' && !r.messages.includes('세션 메시지 답')).length, cNotices: (await loadThread(ws, 'c')).messages.filter((m) => m.src?.code === 'capReached') }; // 상한 단계(C, hop 2)의 턴에는 도구가 없고(L1) 사슬 끝 안내가 그 방에 한 번 남는다
}

test('사슬 상한 — 시작한 방이 풀림이면 4단계: C의 세 번째 전송이 D까지 간다(중간 방이 켜짐이어도)', async () => {
  const r = await runChain({ aRelaxed: true, middleRelaxed: false });
  assert.equal(r.dTurns, 1, 'D 턴 1번');
  assert.equal(r.cNotices.length, 0);
});

test('사슬 상한 — 시작한 방이 켜짐이면 2단계: C(상한 단계)는 더 보내지 못하고 C 방에 사슬 끝 안내(중간 방이 풀림이어도)', async () => {
  const r = await runChain({ aRelaxed: false, middleRelaxed: true });
  assert.equal(r.dTurns, 0, 'D 턴 없음');
  assert.equal(r.cNotices.length, 1);
  assert.match(r.cNotices[0].text, /2단계/);
});

// ── 0.1.94 분리 검수 지적(2026-10-03) ──
async function fresh() {
  await sess._resetForTest();
  for (const s of ['a', 'b', 'c', 'd']) await resetThread(ws, s);
  call = null; reqs.length = 0; firedBy.clear(); plan = {};
}

test('CLI 한 번 실행(MEDIUM-3) — 세션 메시지를 막은 턴에는 도구가 없고, 불러도 B 턴이 생기지 않는다', async () => {
  await fresh();
  plan = { a: { name: TOOL, input: { to: 'b', message: 'CLI에서' } } };
  await chat(ws, 'a', '지시', null, { sessionChain: { blocked: true } });
  await sess._drainForTest();
  assert.ok(!reqs.find((r) => r.who === 'a')?.hasTool, '광고 안 됨');
  assert.equal(reqs.filter((r) => r.who === 'b').length, 0);
  const { readFile } = await import('node:fs/promises');
  const cli = await readFile(new URL('../bin/argo.mjs', import.meta.url), 'utf8');
  assert.match(cli, /await chat\(ws, crew\.slug, message, sessionId, \{[^\n]*sessionChain: \{ blocked: true \}/, 'argo CLI 턴이 막음 표지를 넘긴다(턴 직후 프로세스가 끝나 답을 받을 수 없다)');
});

test('상한 단계(L1) — 사슬 상한에 닿은 단계의 턴에는 도구를 싣지 않는다', async () => {
  await fresh();
  await chat(ws, 'a', '지시', null, { hop: 2, chain: ['c', 'd'] });
  assert.ok(!reqs.find((r) => r.who === 'a')?.hasTool, '켜짐 사슬 hop 2 = 상한');
});

test('회의실 위임(L8) — 회의실 발언자가 위임한 동료 턴에도 도구가 없다', async () => {
  await fresh();
  plan = { a: { name: 'mcp__crew__delegate', input: { to: 'b', task: '맡아 줘' } }, b: { name: TOOL, input: { to: 'c', message: '몰래' } } };
  await chat(ws, 'a', '회의 발언', null, { source: 'room', mirrorCtx: { room: 'r2:a:0:0' } });
  await sess._drainForTest();
  assert.ok(reqs.some((r) => r.who === 'b'), '위임 턴은 돌았다');
  assert.ok(!reqs.find((r) => r.who === 'b')?.hasTool, '위임받은 동료 턴에 광고 안 됨');
  assert.equal(reqs.filter((r) => r.who === 'c').length, 0, 'C 턴 없음');
});

test('풀 오토(MEDIUM-4) — 크루가 보낸 세션 메시지의 B 턴·깨움 턴은 풀 오토가 아니다(사장이 보낸 B 턴은 그대로)', async () => {
  // 시스템 프롬프트는 새 세션에서 잰다 — SDK는 세션을 이어받을 때 첫 턴의 시스템 프롬프트를 그대로 쓴다(실측). 그래서 받는 턴의 글에도 안내를 싣고,
  // 실제 강제는 커넥터 게이트(connector-fullauto-live.test.mjs의 fullAuto:false 경우)가 잠근다.
  const FA = /풀 오토 모드가 켜져 있다/; const NOT = /풀 오토 모드가 켜져 있어도 이 턴에는 적용되지 않는다/;
  await fresh();
  await updateCompany(ws, { fullAuto: true });
  try {
    plan = { a: { name: TOOL, input: { to: 'b', message: '크루가 보냄' } } };
    await chat(ws, 'a', '사장 직접', null, {});
    await sess._drainForTest();
    const aReqs = reqs.filter((r) => r.who === 'a');
    assert.match(aReqs[0].sys, FA, '사장 직접 턴은 풀 오토');
    const b = reqs.find((r) => r.who === 'b');
    assert.doesNotMatch(b.sys, FA, '크루가 보낸 B 턴(새 세션)은 풀 오토가 아니다');
    assert.match(b.messages, NOT, 'B 턴 글에 풀 오토가 아니라는 안내');
    const wake = aReqs.find((r) => r.messages.includes('B-답-토큰'));
    assert.ok(wake); assert.match(wake.messages, NOT, '깨움 턴 글에도 안내');
    await fresh();
    await sess.sendSessionMessage(ws, { room: 'a', sender: 'captain', to: 'b', message: '사장이 보냄' });
    await sess._drainForTest();
    const bc = reqs.find((r) => r.who === 'b');
    assert.match(bc.sys, FA, '사장이 보낸 B 턴(새 세션)은 풀 오토 그대로');
    assert.doesNotMatch(bc.messages, NOT);
  } finally { await updateCompany(ws, { fullAuto: false }); }
});

test('새 세션 머리말(L3) — 다른 기기 세션을 새로 열 때 세션 메시지를 "사용자의 새 메시지" 아래에 싣지 않는다', async () => {
  await fresh();
  const { writeFile: wf } = await import('node:fs/promises');
  await wf(join(p.chats, 'b.json'), JSON.stringify({ sessionId: 'old-sess', sessionDevice: 'other-device', messages: [
    { who: 'user', text: '예전 지시', ts: Date.now() - 1000 }, { who: 'crew', text: '예전 답', ts: Date.now() - 900 }] }));
  await sess.sendSessionMessage(ws, { room: 'a', sender: 'captain', to: 'b', message: '새 기기에서' });
  await sess._drainForTest();
  const b = reqs.find((r) => r.who === 'b');
  assert.ok(b?.messages.includes('예전 지시'), '최근 대화를 붙여 새 세션으로 이어 간다');
  assert.ok(!b.messages.includes('사용자의 새 메시지'), '사용자의 직접 지시처럼 머리를 달지 않는다');
});
