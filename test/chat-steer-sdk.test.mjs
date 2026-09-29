// 끼워 넣기 — SDK(claude) 경로를 **실제 SDK**로 잠근다. 모델만 로컬 가짜 Messages 엔드포인트(ARGO_CLAUDE_BASE_URL).
// 실측(2026-09-29 격리 서버): 첫 구현은 메시지를 SDK 입력 큐에 바로 넣고 "도구 결과가 보이면 실렸다"고 추정해 입력을 닫았는데,
// 턴 시작 직후 넣은 메시지는 SDK가 쥔 채 입력이 닫혀 모델에 한 번도 가지 않았다(크루 답 "끼워 넣기 없음").
// 지금은 Argo가 메시지를 쥐고 ① 도구가 끝날 때 PostToolUse 훅으로 ② 도구 없이 답이 끝나면 새 입력으로 싣는다 — 세 시점을 각각 본다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from './helpers/tmp.mjs';

const root = await mkdtemp(join(tmpdir(), 'argo-steer-sdk-'));
const home = await mkdtemp(join(tmpdir(), 'argo-steer-sdk-home-'));
Object.assign(process.env, { ARGO_ROOT: root, HOME: home, USERPROFILE: home, ARGO_ENC_VAULT: '0', ARGO_MODEL_CATALOG: 'off', ARGO_NATIVE_RUNNERS: 'off', CLAUDE_CODE_MAX_RETRIES: '0' });
for (const key of ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']) delete process.env[key];

const ws = 'steer-sdk';
const bodies = {}; // 시나리오 → 스트리밍 요청 본문 목록(JSON 문자열)
let onRequest = async () => ({ text: 'x' });
const srv = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => (b += c)); req.on('end', async () => {
    if (!(req.method === 'POST' && req.url.startsWith('/v1/messages'))) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{}'); }
    const body = JSON.parse(b || '{}');
    if (!body.stream) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ id: 'x', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: 't' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } })); }
    const raw = JSON.stringify(body.messages);
    const scene = raw.match(/\[(MID|LATE|BOOT)\]/)?.[1] ?? '?';
    (bodies[scene] ??= []).push(raw);
    const step = await onRequest(scene, bodies[scene].length, raw);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const ev = (t, d) => res.write(`event: ${t}\ndata: ${JSON.stringify({ type: t, ...d })}\n\n`);
    ev('message_start', { message: { id: 'm', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } });
    if (step.bash) {
      ev('content_block_start', { index: 0, content_block: { type: 'tool_use', id: `tu${Date.now()}`, name: 'Bash', input: {} } });
      ev('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ command: step.bash, description: 'fixture' }) } });
      ev('content_block_stop', { index: 0 }); ev('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } });
    } else {
      ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
      ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: step.text } });
      ev('content_block_stop', { index: 0 }); ev('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } });
    }
    ev('message_stop', {}); res.end();
  });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
process.env.ARGO_CLAUDE_BASE_URL = `http://127.0.0.1:${srv.address().port}`;
after(() => srv.close());

const { createCompany, paths } = await import('../src/workspace.mjs');
const { saveRunnerCred } = await import('../src/runners/creds.mjs');
const { chat } = await import('../src/chat.mjs');
const { steerTurn } = await import('../src/turn-abort.mjs');
await createCompany(ws, '끼워 넣기 SDK', 'owner', null, 'ko');
await mkdir(paths(ws).agents, { recursive: true });
for (const slug of ['mid', 'late', 'boot']) await writeFile(join(paths(ws).agents, `${slug}.md`), `---\nname: ${slug}\nrole: 검증\nrunner: claude\n---\n검증용.\n`);
await saveRunnerCred(ws, 'claude', 'apikey', `sk-ant-api03-${'x'.repeat(80)}`); // 형식만 맞춘 가짜 — 요청은 로컬 가짜 엔드포인트로만 간다

test('SDK: 도구가 도는 사이 넣은 메시지는 멈추지 않고 도구 결과와 같은 다음 요청에 실린다(result 1회)', { timeout: 120_000 }, async () => {
  onRequest = async (scene, n) => {
    if (n === 1) { assert.equal(await steerTurn(ws, 'mid', { text: '중간 끼워 넣기' }), true); return { bash: 'sleep 1' }; }
    return { text: '반영한 답' };
  };
  const r = await chat(ws, 'mid', '[MID] 작업해', null, { journal: { off: true } });
  assert.equal(bodies.MID.length, 2, '추가 실행 없이 한 번에');
  assert.match(bodies.MID[1], /tool_result/);
  assert.match(bodies.MID[1], /사장이 작업 중에 새 메시지를 보냈다:\\n중간 끼워 넣기/, '도구 결과 뒤 요청에 실렸다');
  assert.equal(r.reply, '반영한 답');
  assert.equal(await steerTurn(ws, 'mid', { text: '늦음' }), false, '끝난 턴은 받지 않는다');
});

test('SDK: 마지막 답을 쓰는 사이 넣은 메시지는 같은 실행에서 이어 답하고, 답을 합친다', { timeout: 120_000 }, async () => {
  onRequest = async (scene, n) => {
    if (n === 1) { assert.equal(await steerTurn(ws, 'late', { text: '늦은 끼워 넣기' }), true); return { text: '첫 답' }; }
    return { text: '이어진 답' };
  };
  const r = await chat(ws, 'late', '[LATE] 답해', null, { journal: { off: true } });
  assert.equal(bodies.LATE.length, 2);
  assert.match(bodies.LATE[1], /늦은 끼워 넣기/);
  assert.equal(r.reply, '첫 답\n\n이어진 답');
  // 비용은 이어진 몫만 — SDK total_cost_usd는 실행 누적값이라 그대로 적으면 둘째 행이 첫 행을 한 번 더 센다(검수 2 실측 0.00003 + 0.00006)
  const { readFile } = await import('node:fs/promises');
  const rows = (await readFile(paths(ws).usage, 'utf8')).trim().split('\n').map((l) => JSON.parse(l)).filter((u) => u.slug === 'late');
  assert.equal(rows.length, 2);
  const cost = (u) => u.costUsd ?? u.cost ?? 0;
  assert.ok(cost(rows[0]) > 0, `첫 행 비용 ${JSON.stringify(rows[0])}`);
  assert.ok(Math.abs(cost(rows[1]) - cost(rows[0])) < 1e-12, `같은 크기의 두 실행 — 둘째 행이 누적값이면 두 배가 된다: ${cost(rows[0])} / ${cost(rows[1])}`);
});

test('SDK: 턴 시작 직후(엔진 준비 중) 넣은 메시지도 사라지지 않는다 — 격리 서버 실측 결함', { timeout: 120_000 }, async () => {
  onRequest = async (scene, n) => ({ text: n === 1 ? '준비 뒤 첫 답' : '받은 답' });
  const turn = chat(ws, 'boot', '[BOOT] 시작', null, { journal: { off: true } });
  // 기다리지 않는다 — chat()은 첫 await 전에 withTurnControl 등록까지 동기로 마친다(SDK는 아직 안 떴다). 30ms만 기다려도 통로가 달려 이 경우를 못 본다.
  assert.equal(await steerTurn(ws, 'boot', { text: '부팅 중 끼워 넣기' }), true, '준비 중이면 받아 둔다');
  const r = await turn;
  const all = bodies.BOOT.join('\n');
  assert.match(all, /부팅 중 끼워 넣기/, '모델에 한 번은 실려야 한다');
  assert.match(r.reply, /받은 답/);
});
