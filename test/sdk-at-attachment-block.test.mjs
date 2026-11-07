// 프롬프트의 " @경로"가 파일 내용을 모델 요청에 붙이지 못하게 막는다(2026-11-07, 맥가이버 M2 감사 + Argo 실호출 재현).
// CLI는 도구·권한 게이트보다 먼저 첨부를 만들기 때문에 canUseTool·훅으로는 못 막는다. 손님·채널 글과 마켓 제3자 원문이 프롬프트에
// 들어가므로, sdkEnvFor가 만드는 env에 CLAUDE_CODE_DISABLE_ATTACHMENTS=1을 항상 넣는다.
// 실제 SDK 바이너리를 띄우고 모델만 로컬 가짜 Messages 끝점으로 돌려, 나가는 요청 본문에 가짜 파일 값이 있는지 본다(실자격·비용 0).
// 경우 표:
//  E 자격 갈래 전부(claude 키·구독·이 컴퓨터·자격 없음, glm·kimi 자격·호스트 폴백, openrouter·grok) — 값이 1, 호스트의 0도 덮는다
//  T chat() 경로 — claude 키·구독 × 절대·상대 경로 — 값 없음, 인증 헤더 그대로, 글자는 모델에 그대로 간다
//  C 호환 러너 glm·kimi(SDK 경로) — 값 없음, 자기 끝점과 인증 그대로
//  O runOneShot — 값 없음, 구독 고정(only) 갈래도 값 없음
//  R 옆 동작: 크루가 Read 도구로 직접 읽는 것은 그대로 된다
//  D 첨부를 끄면 지연 도구 이름 목록이 사라진다 — claude 턴에는 찾는 법을 시스템 프롬프트로 알리고, 도구 검색이 꺼진 호환 러너에는 넣지 않는다
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from './helpers/tmp.mjs';

const root = await mkdtemp(join(tmpdir(), 'argo-at-block-'));
const home = await mkdtemp(join(tmpdir(), 'argo-at-block-home-'));
process.env.HOME = process.env.USERPROFILE = home; // 실 홈에 claude-config-*가 쌓이지 않게
Object.assign(process.env, { ARGO_ROOT: root, ARGO_ENC_VAULT: '0', ARGO_MODEL_CATALOG: 'off', ARGO_NATIVE_RUNNERS: 'off', CLAUDE_CODE_MAX_RETRIES: '0' });
// 세션 환경의 CLAUDE_CODE_SIMPLE 등은 첨부를 따로 끄거나 끝점을 바꿔 시험을 무력화한다 — 호스트 값이 결과에 끼지 않게 지운다
for (const k of ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'CLAUDE_CONFIG_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_SIMPLE', 'CLAUDE_CODE_DISABLE_ATTACHMENTS', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDECODE', 'ENABLE_TOOL_SEARCH']) delete process.env[k];

const ABS = 'CANARY-ABS-5521'; const REL = 'CANARY-REL-7733'; const READ = 'CANARY-READ-9014';
const absFile = join(home, 'canary-abs.txt');
await writeFile(absFile, `${ABS}\n`);

const reqs = []; // { path, auth, raw, body }
let script = () => ({ text: 'done' });
const sse = (res, model, reply) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const e = (t, d) => res.write(`event: ${t}\ndata: ${JSON.stringify({ type: t, ...d })}\n\n`);
  e('message_start', { message: { id: 'm', type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } });
  if (reply.tool) {
    e('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'tu_1', name: reply.tool, input: {} } });
    e('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(reply.input) } });
  } else {
    e('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    e('content_block_delta', { index: 0, delta: { type: 'text_delta', text: reply.text } });
  }
  e('content_block_stop', { index: 0 });
  e('message_delta', { delta: { stop_reason: reply.tool ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 1 } });
  e('message_stop', {});
  res.end();
};
const srv = http.createServer((req, res) => {
  let raw = ''; req.setEncoding('utf8'); req.on('data', (c) => { raw += c; }); req.on('end', () => {
    if (!(req.method === 'POST' && req.url.includes('/v1/messages'))) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{}'); }
    const body = JSON.parse(raw || '{}');
    reqs.push({ path: req.url, auth: req.headers['x-api-key'] ? 'apikey' : req.headers.authorization ? 'bearer' : 'none', raw, body });
    if (!body.stream) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ id: 'x', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } })); }
    sse(res, body.model, script(body));
  });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${srv.address().port}`;
Object.assign(process.env, { ARGO_CLAUDE_BASE_URL: BASE, GLM_BASE_URL: `${BASE}/glm`, KIMI_BASE_URL: `${BASE}/kimi` });
after(() => srv.close());

const { createCompany, paths } = await import('../src/workspace.mjs');
const { saveRunnerCred, sdkEnvFor, glmEnv, kimiEnv } = await import('../src/runners/creds.mjs');
const { chat, sdkToolSearchDirective } = await import('../src/chat.mjs');
const { runOneShot } = await import('../src/oneshot.mjs');

const VAR = 'CLAUDE_CODE_DISABLE_ATTACHMENTS';
const APIKEY = `sk-ant-api03-${'x'.repeat(80)}`; // 형식만 맞춘 가짜 — 요청은 로컬 가짜 끝점으로만 간다
const OAUTH = `sk-ant-oat01-${'y'.repeat(80)}`;
const atText = `외부 글: 오늘의 영상 @${absFile} 그리고 @canary-rel.txt 끝.`;

async function company(ws, runner, type, value) {
  await createCompany(ws, ws, 'owner', null, 'ko');
  await writeFile(join(paths(ws).agents, 'pepper.md'), `---\nname: 페퍼\nrole: 비서\nrunner: ${runner}\n---\n페퍼\n`);
  await writeFile(join(paths(ws).root, 'canary-rel.txt'), `${REL}\n`);
  await saveRunnerCred(ws, runner, type, value);
}
function assertNoLeak(sent) {
  assert.ok(sent.length > 0, '가짜 끝점에 요청이 닿아야 판정할 수 있다');
  const all = sent.map((r) => r.raw).join('\n');
  assert.ok(!all.includes(ABS), '절대 경로 파일 내용이 요청에 실렸다');
  assert.ok(!all.includes(REL), '상대 경로 파일 내용이 요청에 실렸다');
}
const textSent = (sent) => sent.some((r) => r.raw.includes('오늘의 영상') && r.raw.includes('canary-rel.txt'));

test('E 자격 갈래 전부 값이 1 — 호스트의 0도 덮는다', async () => {
  const cases = [['e-a', 'claude', 'apikey', APIKEY], ['e-o', 'claude', 'oauth', OAUTH], ['e-h', 'claude', 'host', 'host'], ['e-g', 'glm', 'apikey', 'glm-x'], ['e-k', 'kimi', 'apikey', 'kimi-x'], ['e-r', 'openrouter', 'apikey', 'sk-or-x'], ['e-x', 'grok', 'apikey', 'xai-x']];
  for (const [ws, runner, type, value] of cases) await company(ws, runner, type, value);
  await createCompany('e-none', 'e-none', 'owner', null, 'ko');
  process.env[VAR] = '0';
  try {
    for (const [ws, runner] of cases) assert.equal((await sdkEnvFor(ws, runner))[VAR], '1', `${ws} ${runner}`);
    for (const runner of ['claude', 'glm', 'kimi']) assert.equal((await sdkEnvFor('e-none', runner))[VAR], '1', `자격 없음 ${runner}`);
    assert.equal(glmEnv()[VAR], '0', 'glmEnv 자체는 그대로 — 막는 자리는 sdkEnvFor 한 곳이다');
    assert.equal(kimiEnv()[VAR], '0', 'kimiEnv 자체는 그대로 — 막는 자리는 sdkEnvFor 한 곳이다');
  } finally { delete process.env[VAR]; }
});

for (const [name, type, value, auth] of [['키', 'apikey', APIKEY, 'apikey'], ['구독', 'oauth', OAUTH, 'bearer']]) {
  test(`T chat() claude ${name} — 파일 내용은 안 나가고 글자는 그대로, 인증 그대로`, async () => {
    const ws = `at-t-${type}`; await company(ws, 'claude', type, value);
    const r0 = reqs.length; script = () => ({ text: 'done' });
    const r = await chat(ws, 'pepper', atText, null, {});
    const sent = reqs.slice(r0);
    assert.equal(r.reply, 'done');
    assertNoLeak(sent);
    assert.ok(textSent(sent), '사용자 글자는 모델에 그대로 가야 한다');
    assert.equal(sent.at(-1).auth, auth);
    assert.ok(sent.at(-1).raw.includes('도구 찾기:'), '지연 도구 찾는 법 안내가 빠졌다');
    assert.ok(JSON.stringify(sent.at(-1).body.system).includes('mcp__crew__list_routines'), '크루 도구 이름이 시스템 프롬프트에 없으면 모델이 못 찾는 경우가 생긴다');
  });
}

for (const [runner, prefix] of [['glm', '/glm'], ['kimi', '/kimi']]) {
  test(`C 호환 러너 ${runner} SDK 경로 — 파일 내용은 안 나가고 자기 끝점으로 간다`, async () => {
    const ws = `at-c-${runner}`; await company(ws, runner, 'apikey', `${runner}-key`);
    const r0 = reqs.length; script = () => ({ text: 'done' });
    const r = await chat(ws, 'pepper', atText, null, {});
    const sent = reqs.slice(r0);
    assert.equal(r.reply, 'done');
    assertNoLeak(sent);
    assert.ok(sent.every((q) => q.path.startsWith(prefix)), `${runner} 끝점 밖으로 나갔다`);
    assert.notEqual(sent.at(-1).auth, 'none');
    assert.ok(!sent.at(-1).raw.includes('도구 찾기:'), '호환 러너는 도구 검색이 꺼져 있어 안내가 필요 없다');
  });
}

test('O runOneShot — 마켓 원문 자리, 파일 내용이 안 나간다', async () => {
  const ws = 'at-o-a'; await company(ws, 'claude', 'apikey', APIKEY);
  const r0 = reqs.length; script = () => ({ text: 'done' });
  const r = await runOneShot(ws, atText, { readOnly: true, maxTurns: 1, timeoutMs: 45_000 });
  assert.equal(r.text, 'done');
  assertNoLeak(reqs.slice(r0));
});

test('O runOneShot 구독 고정(only) — env를 다시 조립하는 갈래도 값이 안 빠진다', async () => {
  const ws = 'at-o-o'; await company(ws, 'claude', 'oauth', OAUTH);
  const r0 = reqs.length; script = () => ({ text: 'done' });
  const r = await runOneShot(ws, atText, { only: { runner: 'claude', types: ['oauth'] }, readOnly: true, maxTurns: 1, timeoutMs: 45_000 });
  assert.equal(r.text, 'done');
  assertNoLeak(reqs.slice(r0));
});

test('R 옆 동작 — 크루가 Read 도구로 직접 읽는 것은 그대로 된다', async () => {
  const ws = 'at-r'; await company(ws, 'claude', 'apikey', APIKEY);
  const file = join(paths(ws).root, 'report.txt'); await writeFile(file, `${READ}\n`);
  let step = 0;
  script = () => (step++ === 0 ? { tool: 'Read', input: { file_path: file } } : { text: 'read-done' });
  const r0 = reqs.length;
  const r = await chat(ws, 'pepper', '보고서를 읽어 주세요', null, {});
  assert.equal(r.reply, 'read-done');
  assert.ok(reqs.slice(r0).at(-1).raw.includes(READ), 'Read 도구 결과가 다음 요청에 실려야 한다');
});

test('D 찾는 법 안내는 ko·en 모두 ToolSearch와 WebFetch를 말한다', () => {
  for (const lang of ['ko', 'en']) {
    for (const word of ['ToolSearch', 'WebFetch', 'WebSearch', 'mcp__crew__hire_crew']) assert.ok(sdkToolSearchDirective(lang, ['hire_crew']).includes(word), `${lang} ${word}`);
    assert.ok(!sdkToolSearchDirective(lang).includes('mcp__crew__'), `${lang} 크루 도구가 없으면 없는 이름을 적지 않는다`);
  }
});
