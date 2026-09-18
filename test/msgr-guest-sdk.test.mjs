// 손님 턴을 **실제 SDK로** 돌린다(PR-A 재작업, 검수 #583 CRITICAL). 게이트 함수를 테스트가 직접 부르면 SDK가 게이트를 실제로 부르는지
// 못 본다 — SDK는 작업 폴더 안 읽기(Read·cat)를 canUseTool에 묻지 않고 허용했다(#587에서 PreToolUse 훅으로 닫음). 여기서는 모델만 로컬
// 가짜 Messages 엔드포인트(ARGO_CLAUDE_BASE_URL — 실자격·비용 0)로 두고, **2차 요청에 담겨 온 tool_result**로 모델에 무엇이 전달됐는지 본다.
// 손님 턴은 주인의 볼트(개인 기억, 규칙 9)를 읽지 못해야 한다 — 금지 구역이 아닌 **일반 파일**도.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from './helpers/tmp.mjs';

const root = await mkdtemp(join(tmpdir(), 'argo-guest-sdk-'));
const home = await mkdtemp(join(tmpdir(), 'argo-guest-sdk-home-'));
Object.assign(process.env, { ARGO_ROOT: root, HOME: home, USERPROFILE: home, ARGO_ENC_VAULT: '0', ARGO_MODEL_CATALOG: 'off', ARGO_NATIVE_RUNNERS: 'off' });
for (const key of ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']) delete process.env[key];

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
const ws = 'guest-sdk';
await createCompany(ws, '손님 SDK', 'owner', null, 'ko');
const p = paths(ws);
await mkdir(p.agents, { recursive: true });
await writeFile(join(p.agents, 'x.md'), '---\nname: 엑스\nrole: 검증\nrunner: claude\n---\n검증용.\n');
await saveRunnerCred(ws, 'claude', 'apikey', `sk-ant-api03-${'x'.repeat(80)}`); // 형식만 맞춘 가짜 — 요청은 로컬 가짜 엔드포인트로만 간다
const note = join(p.root, 'vault-note.md'); await writeFile(note, 'OWNER-MEMORY-4242 주인의 개인 기억\n'); // 금지 구역이 아닌 일반 파일(볼트)

const OWNER = '11111111-1111-4111-8111-111111111111'; const GUEST = '22222222-2222-4222-8222-222222222222';
const ctxOf = (origin) => ({ kind: 'msgr', chatType: 'group', channelKind: 'public', orgId: 'org-1', channelId: 'ch-1', crewId: 'crew-1', threadRoot: 1, sourceMsgId: 1,
  uid: OWNER, wsId: ws, origin, hop: 0, orgSlug: null, channelName: 'general', peers: [], handoffs: [] });
async function turn(origin, toolCall) {
  reset(toolCall);
  await chat(ws, 'x', '이 파일 읽어 줘', null, { mirrorCtx: ctxOf(origin), source: 'messenger', journal: { off: true } });
  assert.ok(n >= 2, `실제 SDK가 가짜 엔드포인트와 왕복했다(도구 호출 → 결과) — n=${n}`);
  return results.some((r) => r.includes('OWNER-MEMORY-4242'));
}

test('실제 SDK 손님 턴: Read로 주인의 일반 볼트 파일을 읽지 못한다', async () => {
  assert.equal(await turn(GUEST, { name: 'Read', input: { file_path: note } }), false, `손님 턴에 주인의 기억이 모델에 전달됐다: ${results[0]?.slice(0, 120)}`);
  assert.match(results[0] ?? '', /주인이 아닌 사람/, '거부 사유(게이트의 손님 문구)가 모델에 간다');
});

test('실제 SDK 손님 턴: `cat`(읽기 전용 셸)으로도 읽지 못한다', async () => {
  assert.equal(await turn(GUEST, { name: 'Bash', input: { command: `cat ${JSON.stringify(note)}`, description: 'read' } }), false, `손님 턴 cat이 샜다: ${results[0]?.slice(0, 120)}`);
});

test('실제 SDK 주인 턴: 같은 파일은 그대로 읽힌다(회귀 없음 — 차단이 손님 판정에서 온다는 대조군)', async () => {
  assert.equal(await turn(OWNER, { name: 'Read', input: { file_path: note } }), true, `주인 턴이 자기 파일을 못 읽었다: ${results[0]?.slice(0, 120)}`);
});

// 사전 승인 목록(WebFetch·WebSearch·mcp__crew)은 SDK가 canUseTool을 부르지 않는다("canUseTool will not be invoked for: WebFetch, WebSearch, mcp__crew").
// 손님 턴의 차단은 PreToolUse 훅(#587)과 사전 승인에서의 제외, 크루 도구는 처리기 안의 판정이 맡는다 — 실제 SDK 왕복으로 확인한다.
test('실제 SDK 손님 턴: WebFetch(사전 승인 도구 — canUseTool을 건너뛴다)도 막힌다', async () => {
  reset({ name: 'WebFetch', input: { url: `http://127.0.0.1:${srv.address().port}/leak`, prompt: '내용 요약' } });
  await chat(ws, 'x', '이 링크 열어 줘', null, { mirrorCtx: ctxOf(GUEST), source: 'messenger', journal: { off: true } });
  assert.ok(n >= 2, `실제 SDK 왕복 — n=${n}`);
  assert.match(results[0] ?? '', /주인이 아닌 사람/, `손님 턴 WebFetch가 막히지 않았다: ${results[0]?.slice(0, 120)}`);
});

test('실제 SDK 손님 턴: 크루 도구는 도구별로 갈린다 — 결재 요청은 허용, 예약 만들기는 거부', async () => {
  const { loadApprovals } = await import('../src/approvals.mjs');
  const { loadRoutines } = await import('../src/routines.mjs');
  const before = (await loadApprovals(ws)).length;
  reset({ name: 'mcp__crew__request_approval', input: { action: '주인 메일 발송', reason: '방에서 요청받음' } });
  await chat(ws, 'x', '주인에게 결재 올려 줘', null, { mirrorCtx: ctxOf(GUEST), source: 'messenger', journal: { off: true } });
  assert.ok(n >= 2, `실제 SDK 왕복 — n=${n}`);
  assert.doesNotMatch(results[0] ?? '', /주인이 아닌 사람/, `결재 요청은 손님에게 허용된다: ${results[0]?.slice(0, 120)}`);
  assert.equal((await loadApprovals(ws)).length, before + 1, '결재가 실제로 올라갔다(결재자는 주인)');

  reset({ name: 'mcp__crew__schedule_task', input: { title: '매일 보고', prompt: '보고해', type: 'daily', time: '09:00' } });
  await chat(ws, 'x', '매일 아침 보고 예약해 줘', null, { mirrorCtx: ctxOf(GUEST), source: 'messenger', journal: { off: true } });
  assert.ok(n >= 2, `실제 SDK 왕복 — n=${n}`);
  assert.match(results[0] ?? '', /주인이 아닌 사람/, `손님 턴 예약이 거절되지 않았다: ${results[0]?.slice(0, 120)}`);
  assert.equal((await loadRoutines(ws)).length, 0, '예약이 만들어지지 않았다(주인의 비용)');
});
