// 끝까지 도는 SDK 턴에서, 도구 호출 명령에 든 비밀이 활동 이벤트(events.jsonl — 기기 간 동기화)의 turn 이벤트 steps·상태 파일·반환 trace에 남지 않는다.
// 실제 SDK(claude-agent-sdk)를 로컬 가짜 Messages 엔드포인트(ARGO_CLAUDE_BASE_URL)로 돌린다 — 실자격·비용 0. 모델은 Bash 도구를 부르고, 명령에 가짜 비밀이 든다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from './helpers/tmp.mjs';

const root = await mkdtemp(join(tmpdir(), 'argo-stepmask-sdk-'));
const home = await mkdtemp(join(tmpdir(), 'argo-stepmask-sdk-home-'));
Object.assign(process.env, { ARGO_ROOT: root, HOME: home, USERPROFILE: home, ARGO_ENC_VAULT: '0', ARGO_MODEL_CATALOG: 'off', ARGO_NATIVE_RUNNERS: 'off' });
for (const key of ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']) delete process.env[key];

const F = 'FAKE0000'; // 명백한 가짜 본문 조각
// 모델이 부르는 Bash 명령 — 비밀이 앞 48자에 들어오고(--password) 48자 경계에 걸친다(토큰 40자). echo라 실행돼도 해가 없다.
const COMMANDS = [`echo ok --password ${F.repeat(5)} done`, `echo "Authorization: Bearer ${F.repeat(5)}"`];

let n = 0;
const sse = (res, evs) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); for (const [e, d] of evs) res.write(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`); res.end(); };
const start = () => ({ type: 'message_start', message: { id: `m${n}`, type: 'message', role: 'assistant', model: 'claude-x', content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } });
let toolCalls = 0;
const srv = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
    if (req.method === 'POST' && req.url.startsWith('/v1/messages')) {
      n += 1; const body = JSON.parse(b || '{}'); const last = (body.messages ?? []).at(-1);
      const gotResult = Array.isArray(last?.content) && last.content.some((c) => c.type === 'tool_result');
      const canCall = (body.tools ?? []).length > 0; // 제목 생성 같은 도구 없는 요청은 건너뛴다(OS마다 도구 목록이 달라 Bash 이름은 보지 않는다 — Windows CI)
      if (canCall && toolCalls < COMMANDS.length) { // 도구 결과가 돌아올 때마다 다음 명령을 부른다(명령 수만큼)
        const command = COMMANDS[toolCalls]; toolCalls += 1;
        return sse(res, [['message_start', start()],
          ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `tu${toolCalls}`, name: 'Bash', input: {} } }],
          ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ command, description: `Check the API with Authorization: Bearer ${F.repeat(5)}` }) } }],
          ['content_block_stop', { type: 'content_block_stop', index: 0 }], ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } }], ['message_stop', { type: 'message_stop' }]]);
      }
      const reply = () => sse(res, [['message_start', start()], ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } }], ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }], ['message_stop', { type: 'message_stop' }]]);
      return gotResult ? setTimeout(reply, 350) : reply(); // 도구 결과 뒤 답을 늦춰 턴 도중 상태 파일을 폴이 읽을 틈을 만든다
    }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}');
  });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
process.env.ARGO_CLAUDE_BASE_URL = `http://127.0.0.1:${srv.address().port}`;
after(() => srv.close());

const { createCompany, paths } = await import('../src/workspace.mjs');
const { saveRunnerCred } = await import('../src/runners/creds.mjs');
const turnStatus = await import('../src/turn-status.mjs');
const { chat } = await import('../src/chat.mjs');
const { readEvents } = await import('../src/events.mjs');
const ws = 'stepmask-sdk';
await createCompany(ws, '단계 요약 가림', 'owner', null, 'ko');
const p = paths(ws);
await mkdir(p.agents, { recursive: true });
await writeFile(join(p.agents, 'x.md'), '---\nname: 엑스\nrole: 검증\nrunner: claude\n---\n검증용.\n');
await saveRunnerCred(ws, 'claude', 'apikey', `sk-ant-api03-${'x'.repeat(80)}`); // 형식만 맞춘 가짜 — 요청은 로컬 가짜 엔드포인트로만 간다

test('끝까지 돈 SDK 턴: events.jsonl의 turn 이벤트 steps·상태 파일·trace 어디에도 도구 명령의 비밀이 없다', { timeout: 180_000 }, async () => {
  const seenStatus = []; // 턴 도중 상태 파일(detail·steps) — 데스크톱 화면이 폴링해 보여주는 값
  const poll = setInterval(async () => { const s = await turnStatus.getTurnStatus(ws, 'x').catch(() => null); if (s) seenStatus.push(JSON.stringify({ detail: s.detail, steps: s.steps })); }, 25);
  let r;
  try { r = await chat(ws, 'x', '명령을 실행해 줘', null, {}); } finally { clearInterval(poll); }
  assert.equal(toolCalls, COMMANDS.length, `모델이 Bash를 ${COMMANDS.length}번 불렀어야 한다(실제 ${toolCalls}) — 시험이 헛돈다`);

  // ① 활동 이벤트 — 기기 간 동기화되는 원천
  const ev = (await readEvents(ws, 50)).find((e) => e.type === 'turn' && e.slug === 'x' && e.ok === true);
  assert.ok(ev, '끝난 턴 이벤트가 있어야 한다');
  const shellSteps = (ev.steps ?? []).filter((s) => s.stage === 'shell');
  assert.equal(shellSteps.length, COMMANDS.length, `shell 단계가 명령 수만큼 남아야 한다: ${JSON.stringify(ev.steps)}`);
  assert.ok(shellSteps.every((s) => s.detail.length > 0 && s.detail.length <= 48), `요약은 비어 있지 않고 48자 이하: ${JSON.stringify(shellSteps)}`);
  const raw = await readFile(join(p.root, 'events.jsonl'), 'utf8'); // 이벤트 파일 전체(동기화 대상) — 어느 필드로도 새지 않는다
  assert.ok(!raw.includes(F), `events.jsonl에 비밀 조각이 남았다: ${raw.split('\n').filter((l) => l.includes(F)).join('\n').slice(0, 300)}`);

  // ② 반환 trace(메신저 답글에 붙는 궤적)
  assert.ok(!JSON.stringify(r.trace).includes(F), `trace에 비밀 조각이 남았다: ${JSON.stringify(r.trace).slice(0, 300)}`);

  // ③ 턴 도중 상태 파일 — 비밀 조각이 없고, 시험이 헛돌지 않게 shell 단계를 실제로 봤다
  assert.ok(seenStatus.some((s) => s.includes('"stage":"shell"')), `폴이 shell 단계를 한 번도 못 봤다(시험이 헛돈다): ${seenStatus.length}번 읽음`);
  for (const s of seenStatus) assert.ok(!s.includes(F), `상태 파일에 비밀 조각이 남았다: ${s.slice(0, 300)}`);
});
