// 위임 제한 스위치 — 실제 SDK 턴(claude-agent-sdk)을 로컬 가짜 Messages 엔드포인트로 돌려 **프롬프트·도구 연결**을 행동으로 잠근다
// (ARGO_CLAUDE_BASE_URL — 실자격·비용 0). 소스 문자열 핀은 `null && lim.relaxed` 같은 변이를 통과시킨다(검수 2026-10-01 MEDIUM-3).
// 가짜 엔드포인트는 요청마다 시스템 프롬프트를 기록하고(페르소나 마커로 어느 크루의 요청인지 구분), 지정한 크루 도구 호출을 **처음 한 번만** 낸다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from './helpers/tmp.mjs';

const root = await mkdtemp(join(tmpdir(), 'argo-deleg-sdk-'));
const home = await mkdtemp(join(tmpdir(), 'argo-deleg-sdk-home-'));
Object.assign(process.env, { ARGO_ROOT: root, HOME: home, USERPROFILE: home, ARGO_ENC_VAULT: '0', ARGO_MODEL_CATALOG: 'off', ARGO_NATIVE_RUNNERS: 'off' });
for (const key of ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']) delete process.env[key];

let call = null; let fired = false; let reqs = [];
const reset = (next) => { call = next; fired = false; reqs = []; };
const sse = (res, evs) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); for (const [e, d] of evs) res.write(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`); res.end(); };
const start = () => ({ type: 'message_start', message: { id: `m${reqs.length}`, type: 'message', role: 'assistant', model: 'claude-x', content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } });
const srv = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
    if (req.method === 'POST' && req.url.startsWith('/v1/messages')) {
      const body = JSON.parse(b || '{}');
      const system = typeof body.system === 'string' ? body.system : JSON.stringify(body.system ?? '');
      if ((body.tools ?? []).length > 0) reqs.push({ system, tools: body.tools.length }); // 제목 생성 같은 도구 없는 요청은 기록하지 않는다
      if (call && !fired && (body.tools ?? []).length > 0) {
        fired = true;
        return sse(res, [['message_start', start()],
          ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu1', name: call.name, input: {} } }],
          ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.input) } }],
          ['content_block_stop', { type: 'content_block_stop', index: 0 }], ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } }], ['message_stop', { type: 'message_stop' }]]);
      }
      return sse(res, [['message_start', start()], ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } }], ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }], ['message_stop', { type: 'message_stop' }]]);
    }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}');
  });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
process.env.ARGO_CLAUDE_BASE_URL = `http://127.0.0.1:${srv.address().port}`;
after(() => srv.close());

const { createCompany, paths } = await import('../src/workspace.mjs');
const { saveRunnerCred } = await import('../src/runners/creds.mjs');
const { chat } = await import('../src/chat.mjs');
const { newTree, getTree } = await import('../src/delegation-limits.mjs');
const { listMail } = await import('../src/crewmail.mjs');
const ws = 'deleg-sdk';
await createCompany(ws, '위임 검수', 'owner', null, 'ko');
const p = paths(ws);
await mkdir(p.agents, { recursive: true });
for (const [slug, name] of [['x', '엑스'], ['y', '와이'], ['z', '제트']]) await writeFile(join(p.agents, `${slug}.md`), `---\nname: ${name}\nrole: 검증\nrunner: claude\n---\n페르소나-${slug.toUpperCase()}-마커.\n`);
await saveRunnerCred(ws, 'claude', 'apikey', `sk-ant-api03-${'x'.repeat(80)}`); // 형식만 맞춘 가짜 — 요청은 로컬 가짜 엔드포인트로만 간다
const sysOf = (marker) => reqs.filter((r) => r.system.includes(marker)).map((r) => r.system);
const RELAXED_ROSTER = /위임은 턴당 최대 10회\(쪽지는 최대 10회\)/;
const ON_ROSTER = /위임은 턴당 최대 2회, 연쇄\(위임받은 일을 다시 위임\)는 전체 2단계까지만 허용된다/;

test('SDK 턴 시스템 프롬프트 — 풀림은 상한 숫자로, 켜짐은 종전 문구로(rosterPrompt에 표가 연결돼 있다)', async () => {
  reset(null);
  await chat(ws, 'x', '안녕', null, { delegationRelaxed: true });
  const [relaxed] = sysOf('페르소나-X-마커');
  assert.match(relaxed, RELAXED_ROSTER); assert.doesNotMatch(relaxed, ON_ROSTER);
  reset(null);
  await chat(ws, 'x', '안녕', null, {});
  const [on] = sysOf('페르소나-X-마커');
  assert.match(on, ON_ROSTER); assert.doesNotMatch(on, /최대 10회/);
});

test('SDK 위임받은 동료 턴 — 풀림이 부른 크루의 프롬프트까지 전달된다(켜짐은 켜짐)', async () => {
  reset({ name: 'mcp__crew__delegate', input: { to: 'y', task: '검수해 줘' } });
  await chat(ws, 'x', '구현하고 검수까지', null, { delegationRelaxed: true });
  const child = sysOf('페르소나-Y-마커');
  assert.equal(child.length, 1, '와이의 위임 턴 요청이 한 번 있다');
  assert.match(child[0], RELAXED_ROSTER, '풀린 대화방에서 위임받은 크루도 풀린 상한 안내를 받는다');
  reset({ name: 'mcp__crew__delegate', input: { to: 'y', task: '검수해 줘' } });
  await chat(ws, 'x', '구현하고 검수까지', null, {});
  const childOn = sysOf('페르소나-Y-마커');
  assert.equal(childOn.length, 1); assert.match(childOn[0], ON_ROSTER); assert.doesNotMatch(childOn[0], /최대 10회/);
});

test('SDK 단계 — 풀림은 hop 3에서도 동료 안내가 있고 hop 4에서는 "위임 단계의 끝" 안내만, 합계 예산을 모르면 켜짐(fail-closed)', async () => {
  const chain3 = ['a', 'b', 'x'];
  reset(null);
  await chat(ws, 'y', '이어서', null, { from: 'x', hop: 3, chain: chain3, delegationRelaxed: true, delegationTree: newTree({ kind: 'chat', slug: 'x' }) });
  assert.match(sysOf('페르소나-Y-마커')[0], RELAXED_ROSTER, '풀림 hop 3 — 아직 위임 가능');
  reset(null);
  await chat(ws, 'y', '이어서', null, { from: 'x', hop: 3, chain: chain3 });
  assert.doesNotMatch(sysOf('페르소나-Y-마커')[0], /동료 에이전트 — 위임 규칙/, '켜짐 hop 3 — 동료 명단 없음(종전)');
  reset(null);
  await chat(ws, 'y', '이어서', null, { from: 'x', hop: 3, chain: chain3, delegationRelaxed: true });
  assert.doesNotMatch(sysOf('페르소나-Y-마커')[0], /동료 에이전트 — 위임 규칙/, '풀림이라고 주장하지만 예산 객체가 없으면 켜짐으로 — 예산 없는 무제한이 되지 않는다');
  reset(null);
  await chat(ws, 'y', '이어서', null, { from: 'x', hop: 4, chain: [...chain3, 'z'], delegationRelaxed: true, delegationTree: newTree({ kind: 'chat', slug: 'x' }) });
  const last = sysOf('페르소나-Y-마커')[0];
  assert.match(last, /허용된 위임 단계\(4단계\)의 끝/); assert.doesNotMatch(last, /동료 에이전트 — 위임 규칙/);
});

test('SDK 크루 도구 — 풀린 대화방의 send_to_crew는 relaxed 표지와 합계 예산 id를 달고 나가며 예산이 차감된다(켜짐은 종전 모양)', async () => {
  reset({ name: 'mcp__crew__send_to_crew', input: { to: 'y', cc: ['z'], message: '검수 부탁' } });
  await chat(ws, 'x', '검수 맡겨', null, { delegationRelaxed: true });
  const pending = (await listMail(ws)).pending;
  const file = async (to, id, kind) => JSON.parse(await readFile(join(p.root, 'mail', to, `${id}-${kind}.json`), 'utf8'));
  const y = pending.find((m) => m.to === 'y');
  const body = await file('y', y.id, 'to');
  assert.equal(body.relaxed, true); assert.match(body.tree, /^[a-z0-9]{8,}$/);
  assert.equal((await file('z', y.id, 'cc')).tree, body.tree, 'cc 사본도 같은 예산');
  const tree = getTree(body.tree);
  assert.ok(tree, 'runChat이 만든 예산 객체가 등록돼 있다'); assert.equal(tree.left, 28, '받는 사람 2명(to + cc)만큼 차감'); assert.deepEqual({ ...tree.origin }, { kind: 'chat', slug: 'x' });
  reset({ name: 'mcp__crew__send_to_crew', input: { to: 'z', message: '켜짐 쪽지' } });
  await chat(ws, 'x', '켜짐', null, {});
  const z = (await listMail(ws)).pending.find((m) => m.to === 'z' && m.kind === 'to');
  const on = await file('z', z.id, 'to');
  assert.equal(on.relaxed, undefined); assert.equal(on.tree, undefined);
});
