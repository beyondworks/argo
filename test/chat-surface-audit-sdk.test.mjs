// 검수 K50·K56 — 실제 SDK(claude-agent-sdk)를 로컬 가짜 Messages 엔드포인트로 돌린다(ARGO_CLAUDE_BASE_URL — 실자격·비용 0).
// K50: 이미지 첨부 읽기 같은 준비 단계가 모델 호출 try 밖에서 던지면 ① 원문(ENOENT + 절대 경로)이 사용자에게 가고 ② 실패 이벤트가 없고
//      ③ 이 턴이 소비한 cc 공유 노트가 복원되지 않아 영구 소실됐다.
// K56: 크루 도구(hire_crew)의 미연결 러너 안내가 실제 설정 탭 이름("AI 연결", app/i18n.jsx settings.tab.ai)과 달랐다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from './helpers/tmp.mjs';

const root = await mkdtemp(join(tmpdir(), 'argo-surface-sdk-'));
const home = await mkdtemp(join(tmpdir(), 'argo-surface-sdk-home-'));
Object.assign(process.env, { ARGO_ROOT: root, HOME: home, USERPROFILE: home, ARGO_ENC_VAULT: '0', ARGO_MODEL_CATALOG: 'off', ARGO_NATIVE_RUNNERS: 'off' });
for (const key of ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']) delete process.env[key];

// 가짜 Messages 엔드포인트 — call이 있으면 첫 도구 가능 요청에 그 도구 호출을 내고, 2차 요청의 tool_result를 모은다
let call = null; let n = 0; let results = [];
const reset = (next) => { call = next; n = 0; results = []; };
const sse = (res, evs) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); for (const [e, d] of evs) res.write(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`); res.end(); };
const start = () => ({ type: 'message_start', message: { id: `m${n}`, type: 'message', role: 'assistant', model: 'claude-x', content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } });
const srv = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
    if (req.method === 'POST' && req.url.startsWith('/v1/messages')) {
      n += 1; const body = JSON.parse(b || '{}'); const last = (body.messages ?? []).at(-1);
      const rs = Array.isArray(last?.content) ? last.content.filter((c) => c.type === 'tool_result') : [];
      results.push(...rs.map((r) => (typeof r.content === 'string' ? r.content : JSON.stringify(r.content))));
      const canCall = !!call && (body.tools ?? []).length > 0; // 제목 생성 같은 도구 없는 요청은 건너뛴다(크루 MCP 도구는 지연 로드라 목록에 이름이 없다)
      if (!rs.length && !results.length && n < 5 && canCall) return sse(res, [['message_start', start()],
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
const { appendSharedNote } = await import('../src/thread.mjs');
const { readEvents } = await import('../src/events.mjs');
const ws = 'surface-sdk';
await createCompany(ws, '표면 검수', 'owner', null, 'ko');
const p = paths(ws);
await mkdir(p.agents, { recursive: true });
await writeFile(join(p.agents, 'x.md'), '---\nname: 엑스\nrole: 검증\nrunner: claude\n---\n검증용.\n');
await saveRunnerCred(ws, 'claude', 'apikey', `sk-ant-api03-${'x'.repeat(80)}`); // 형식만 맞춘 가짜 — 요청은 로컬 가짜 엔드포인트로만 간다

const NOTE = 'CC-NOTE-5050 동료에게 준 지시와 결과';
const pending = async () => JSON.parse(await readFile(join(p.chats, 'x.json'), 'utf8')).messages.filter((m) => m.shared && m.pending).length;

test('K50 이미지 첨부가 사라진 턴: 알아들을 문구로 실패하고, 실패 이벤트를 남기고, 소비한 cc 공유 노트를 되살린다', async () => {
  await writeFile(join(p.chats, 'x.json'), JSON.stringify({ messages: [] }));
  await appendSharedNote(ws, 'x', NOTE);
  reset(null);
  const att = { rel: 'files/gone-5050.png', name: 'gone-5050.png', mime: 'image/png', isImage: true }; // 저장 뒤 지워진 첨부
  let err = null;
  await chat(ws, 'x', '이 사진 봐 줘', null, { attachments: [att] }).catch((e) => { err = e; });
  assert.ok(err, '턴이 실패해야 한다');
  assert.doesNotMatch(String(err.message), /ENOENT|no such file/i, `원문 오류가 사용자에게 갔다: ${err.message}`);
  assert.equal(String(err.message).includes(root), false, '주인 컴퓨터의 절대 경로가 사용자 문구에 실렸다');
  assert.match(String(err.message), /gone-5050\.png/, '어떤 첨부가 문제인지 알려야 한다');
  assert.equal(await pending(), 1, '실패한 턴이 cc 공유 노트를 되살리지 않았다(영구 소실)');
  const ev = (await readEvents(ws, 20)).find((e) => e.type === 'turn' && e.slug === 'x');
  assert.ok(ev && ev.ok === false, '실패 턴 이벤트가 활동 로그에 없다');
});

test('K56 hire_crew로 미연결 러너를 고르면 실제 설정 탭 이름("설정 → AI 연결")으로 안내한다', async () => {
  reset({ name: 'mcp__crew__hire_crew', input: { brief: '뉴스레터 에디터', runner: 'gemini', why: '검수' } });
  await chat(ws, 'x', '에디터 한 명 영입해 줘', null, {});
  assert.equal(results.length, 1, `도구 결과가 모델에 한 건 돌아와야 한다(n=${n})`);
  assert.match(results[0], /설정 → AI 연결/, `탭 이름이 실제 화면과 다르다: ${results[0]}`);
  assert.doesNotMatch(results[0], /러너 연결에서/);
});
