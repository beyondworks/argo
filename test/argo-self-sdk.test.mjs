// 아르고 자기 인식 — 실제 SDK 턴(claude-agent-sdk)을 로컬 가짜 Messages 엔드포인트로 돌려 runChat → makeCrewServer 연결을 행동으로 잠근다
// (ARGO_CLAUDE_BASE_URL — 실자격·비용 0). 출처 판정 표(argo-self.test.mjs)는 순수 함수만 본다 — 여기서는 runChat이 그 판정을 실제 도구까지 싣는지 본다:
// 데스크톱 표지(ownerSeat)가 있는 턴의 argo_settings는 바로 바뀌고, 같은 말을 표지 없이(결재 후속·CLI 모양)·루틴 출처·메신저 채널로 하면 결재 카드가 된다.
// 가짜 엔드포인트는 지정한 도구 호출을 처음 한 번만 내고, 도구 결과가 오면 그 글을 그대로 답으로 돌려준다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from './helpers/tmp.mjs';

const root = await mkdtemp(join(tmpdir(), 'argo-self-sdk-'));
const home = await mkdtemp(join(tmpdir(), 'argo-self-sdk-home-'));
Object.assign(process.env, { ARGO_ROOT: root, HOME: home, USERPROFILE: home, ARGO_ENC_VAULT: '0', ARGO_MODEL_CATALOG: 'off', ARGO_NATIVE_RUNNERS: 'off' });
for (const key of ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']) delete process.env[key];

let call = null; let fired = false; let toolResult = null;
const reset = (next) => { call = next; fired = false; toolResult = null; };
const sse = (res, evs) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); for (const [e, d] of evs) res.write(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`); res.end(); };
const start = () => ({ type: 'message_start', message: { id: 'm1', type: 'message', role: 'assistant', model: 'claude-x', content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } });
const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => (b.type === 'text' ? b.text : '')).join('\n') : '');
const srv = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
    if (req.method === 'POST' && req.url.startsWith('/v1/messages')) {
      const body = JSON.parse(b || '{}');
      const last = body.messages?.[body.messages.length - 1];
      const tr = Array.isArray(last?.content) ? last.content.find((x) => x.type === 'tool_result') : null;
      if (tr) toolResult = textOf(tr.content);
      if (call && !fired && (body.tools ?? []).some((t) => t.name === call.name)) {
        fired = true;
        return sse(res, [['message_start', start()],
          ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu1', name: call.name, input: {} } }],
          ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.input) } }],
          ['content_block_stop', { type: 'content_block_stop', index: 0 }], ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } }], ['message_stop', { type: 'message_stop' }]]);
      }
      return sse(res, [['message_start', start()], ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: toolResult ?? 'done' } }], ['content_block_stop', { type: 'content_block_stop', index: 0 }],
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
const { assistantSettingsView } = await import('../src/assistant/settings.mjs');
const { loadApprovals } = await import('../src/approvals.mjs');

async function company(ws) {
  await createCompany(ws, ws, 'owner', null, 'ko');
  for (const [slug, name] of [['pepper', '페퍼'], ['mina', '미나']]) await writeFile(join(paths(ws).agents, `${slug}.md`), `---\nname: ${name}\nrole: 비서\nrunner: claude\n---\n${name}\n`);
  await saveRunnerCred(ws, 'claude', 'apikey', `sk-ant-api03-${'x'.repeat(80)}`); // 형식만 맞춘 가짜 — 요청은 로컬 가짜 엔드포인트로만 간다
  return ws;
}
const morning = async (ws) => (await assistantSettingsView(ws)).config.quiet.to;
const settingCards = async (ws) => (await loadApprovals(ws)).filter((a) => a.kind === 'setting');
const SET = { name: 'mcp__crew__argo_settings', input: { action: 'set', key: 'assistant.morning', value: '07:00' } };

test('SDK 턴 — 데스크톱 대화 표지가 있는 턴의 "아침 정리 7시로"는 바로 바뀌고 답에 이전 값 → 새 값이 실린다', async () => {
  const ws = await company('self-sdk-desk');
  reset(SET);
  const r = await chat(ws, 'pepper', '아침 정리 7시로 바꿔줘', null, { ownerSeat: 'desktop' });
  assert.equal(await morning(ws), '07:00');
  assert.match(r.reply, /08:00 → 07:00/);
  assert.equal((await settingCards(ws)).length, 0);
});

test('SDK 턴 — 같은 말을 표지 없이(결재 후속·argo CLI 모양)·에이전트가 건 루틴 출처로 하면 결재 카드가 되고 값은 그대로', async () => {
  for (const [ws, opts, label] of [['self-sdk-noseat', {}, '표지 없음'], ['self-sdk-routine', { ownerSeat: 'desktop', source: 'routine', notOwnerDirect: 'mina' }, '루틴(에이전트가 건 예약)'], ['self-sdk-telegram', { source: 'messenger' }, '텔레그램 1:1 모양']]) {
    await company(ws);
    reset(SET);
    const r = await chat(ws, 'pepper', '아침 정리 7시로 바꿔줘', null, opts);
    assert.equal(await morning(ws), '08:00', label);
    assert.match(r.reply, /주인 결재로 올렸다/, label);
    assert.equal((await settingCards(ws)).length, 1, label);
  }
});

test('SDK 턴 — "지금 연결 밀도가 몇%지?"에 argo_status가 데크 셈 결과를 돌려준다', async () => {
  const ws = await company('self-sdk-deck');
  await writeFile(join(paths(ws).notes, 'a.md'), '# A\n[[B]]\n');
  await writeFile(join(paths(ws).notes, 'b.md'), '# B\n');
  reset({ name: 'mcp__crew__argo_status', input: { section: 'deck' } });
  const r = await chat(ws, 'pepper', '지금 연결 밀도가 몇%지?', null, { ownerSeat: 'desktop' });
  assert.match(r.reply, /연결된 기억 100% \(다이얼 표시\)/);
  assert.match(r.reply, /연결된 기억 2 \+ 고립된 기억 0/);
});
