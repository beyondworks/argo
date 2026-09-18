// SDK 경로의 읽기가 권한 게이트를 실제로 지나는가 — **실제 SDK(claude-agent-sdk)를 돌린다**. 모델만 로컬 가짜 Messages 엔드포인트다
// (ARGO_CLAUDE_BASE_URL — 실자격·비용 0). 1차 응답으로 도구 호출을 내고, **2차 요청에 담겨 온 tool_result**로 모델에 무엇이 전달됐는지 본다.
// 게이트 함수를 직접 부르는 테스트는 이 구멍을 못 봤다: SDK는 기본 권한 모드에서 작업 폴더 안의 읽기 전용 동작(Read, `cat` 같은
// 읽기 전용 셸)을 canUseTool에 묻지 않고 허용한다(0.3.258 실측 — 주인 턴의 금지 구역 토큰이 모델에 전달됐다). 처방 = PreToolUse 훅.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from './helpers/tmp.mjs';

const root = await mkdtemp(join(tmpdir(), 'argo-sdk-read-gate-'));
const home = await mkdtemp(join(tmpdir(), 'argo-sdk-read-gate-home-'));
Object.assign(process.env, { ARGO_ROOT: root, HOME: home, USERPROFILE: home, ARGO_ENC_VAULT: '0', ARGO_MODEL_CATALOG: 'off', ARGO_NATIVE_RUNNERS: 'off' });
for (const key of ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']) delete process.env[key];

// 가짜 Messages 엔드포인트 — 경우마다 reset(call)으로 다음 도구 호출을 정한다
let call = null; let n = 0; let results = [];
const reset = (next) => { call = next; n = 0; results = []; };
const sse = (res, evs) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); for (const [e, d] of evs) res.write(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`); res.end(); };
const start = () => ({ type: 'message_start', message: { id: `m${n}`, type: 'message', role: 'assistant', model: 'claude-x', content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } });
const srv = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
    if (req.method === 'POST' && req.url.startsWith('/v1/messages')) {
      n += 1; const last = (JSON.parse(b || '{}').messages ?? []).at(-1);
      const rs = Array.isArray(last?.content) ? last.content.filter((c) => c.type === 'tool_result') : [];
      results.push(...rs.map((r) => (typeof r.content === 'string' ? r.content : JSON.stringify(r.content))));
      if (!rs.length && !results.length && n < 5 && call) return sse(res, [['message_start', start()],
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu1', name: call.name, input: {} } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.input) } }],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }], ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } }], ['message_stop', { type: 'message_stop' }]]);
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
const { runOneShot } = await import('../src/oneshot.mjs');
const ws = 'sdk-read-gate';
await createCompany(ws, 'SDK 읽기 게이트', 'owner', null, 'ko');
const p = paths(ws);
await mkdir(p.agents, { recursive: true });
await writeFile(join(p.agents, 'x.md'), '---\nname: 엑스\nrole: 검증\nrunner: claude\n---\n검증용.\n');
await saveRunnerCred(ws, 'claude', 'apikey', `sk-ant-api03-${'x'.repeat(80)}`); // 형식만 맞춘 가짜 — 요청은 로컬 가짜 엔드포인트로만 간다
const note = join(p.root, 'owner-note.md'); await writeFile(note, 'NORMAL-NOTE-1111\n');
const secret = join(p.root, '.connector-secrets.json'); await writeFile(secret, '{"token":"CONNECTOR-TOKEN-9999"}'); // 게이트 금지 구역(회사 제어 파일)
const leaked = (marker) => results.some((r) => r.includes(marker));

async function chatTurn(toolCall) {
  reset(toolCall);
  await chat(ws, 'x', '파일을 읽어 줘', null, {});
  assert.ok(n >= 2, `실제 SDK가 가짜 엔드포인트와 두 번 이상 왕복했다(도구 호출 → 결과) — n=${n}`);
  assert.equal(results.length, 1, '도구 결과가 정확히 한 건 모델에 돌아왔다');
}

test('SDK 대화 턴: 작업 폴더 안 금지 구역 Read는 게이트가 막는다 — 모델에 토큰이 전달되지 않는다', async () => {
  await chatTurn({ name: 'Read', input: { file_path: secret } });
  assert.equal(leaked('CONNECTOR-TOKEN-9999'), false, `금지 구역 내용이 모델에 전달됐다: ${results[0]?.slice(0, 120)}`);
});

test('SDK 대화 턴: 작업 폴더 안 금지 구역 `cat`(읽기 전용 셸)도 막는다', async () => {
  await chatTurn({ name: 'Bash', input: { command: `cat ${JSON.stringify(secret)}`, description: 'read' } });
  assert.equal(leaked('CONNECTOR-TOKEN-9999'), false, `금지 구역 내용이 모델에 전달됐다: ${results[0]?.slice(0, 120)}`);
});

test('SDK 대화 턴: 일반 파일 Read는 그대로 읽힌다(회귀 없음)', async () => {
  await chatTurn({ name: 'Read', input: { file_path: note } });
  assert.equal(leaked('NORMAL-NOTE-1111'), true, `일반 파일이 읽히지 않았다: ${results[0]?.slice(0, 120)}`);
});

test('SDK 단발 호출(oneshot, 순수 생성): 도구를 전부 거부한다 — 외부 원문 요약 자리에서 회사 폴더를 읽지 않는다', async () => {
  reset({ name: 'Read', input: { file_path: secret } });
  await runOneShot(ws, '요약해 줘', { maxTurns: 3, readOnly: true }).catch(() => {}); // 답 모양은 무관 — 모델에 무엇이 전달됐는지만 본다
  assert.ok(n >= 2, `실제 SDK 왕복 — n=${n}`);
  assert.equal(leaked('CONNECTOR-TOKEN-9999'), false, '단발 호출이 금지 구역을 읽었다');
  assert.match(results[0] ?? '', /도구 없는 호출/, '도구 거부 사유가 모델에 전달된다');
});

test('gateHooks: 게이트 판정을 그대로 전달하고, 게이트가 던지면 거부한다(fail-closed — 훅 오류로 도구가 열리지 않게)', async () => {
  const { gateHooks } = await import('../src/permission-gate.mjs');
  const run = async (gate, tool = 'Read') => gateHooks(gate).PreToolUse[0].hooks[0]({ tool_name: tool, tool_input: { file_path: '/x' } });
  assert.deepEqual(await run(async () => ({ behavior: 'allow', updatedInput: {} })), {}, '허용은 빈 값 — 이후 SDK 흐름 그대로');
  assert.equal((await run(async () => ({ behavior: 'deny', message: '막힘' }))).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal((await run(async () => ({ behavior: 'deny', message: '막힘' }))).hookSpecificOutput.permissionDecisionReason, '막힘', '게이트 사유가 모델에 간다');
  assert.equal((await run(async () => { throw new Error('boom'); })).hookSpecificOutput.permissionDecision, 'deny', '게이트 예외 = 거부');
});
