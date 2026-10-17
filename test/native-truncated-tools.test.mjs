// 네이티브 러너 — 출력 한도로 잘린 응답의 tool_use(argo-pi-assessment 3번, pi report 2.1·2.6).
// 플래그 ARGO_NATIVE_TRUNCATED_TOOLS=reject(옵트인, 기본 꺼짐)를 켜면 잘린 응답의 tool_use를 실행하지 않고 is_error tool_result로 짝을 맞춘다.
// 꺼져 있으면 지금 동작(실행) 그대로 — 아래 "핀" 시험이 와이어 셋(Messages·Responses·Gemini) 모두 잠근다(Messages는 native-engine-review H2도 같은 동작을 잠근다).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from './helpers/tmp.mjs';
import { useFakeAccountKey } from './helpers/fake-account-key.mjs';

process.env.HOME = await mkdtemp(join(tmpdir(), 'argo-native-trunc-home-'));
process.env.USERPROFILE = process.env.HOME;
process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-native-trunc-'));
process.env.ARGO_MODEL_CATALOG = 'off';
await useFakeAccountKey();
const { nativeQuery } = await import('../src/engine/native-query.mjs');
const { fromResponsesResponse } = await import('../src/engine/responses-wire.mjs');
const { fromGeminiResponse } = await import('../src/engine/gemini-wire.mjs');
const flags = await import('../src/engine/native-flags.mjs');
const { createCompany, paths } = await import('../src/workspace.mjs');
const { makePermissionGate } = await import('../src/permission-gate.mjs');

const FLAG = 'ARGO_NATIVE_TRUNCATED_TOOLS';
const withFlag = async (value, fn) => {
  const prev = process.env[FLAG];
  if (value == null) delete process.env[FLAG]; else process.env[FLAG] = value;
  try { return await fn(); } finally { if (prev === undefined) delete process.env[FLAG]; else process.env[FLAG] = prev; }
};

async function fakeServer(handler) {
  const calls = [];
  const srv = createServer((req, res) => {
    let d = ''; req.setEncoding('utf8'); req.on('data', (c) => { d += c; });
    req.on('end', () => { calls.push({ url: req.url, body: d ? JSON.parse(d) : {} }); handler(calls.length, res); });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${srv.address().port}`, calls, close: () => new Promise((r) => { srv.close(r); srv.closeAllConnections(); }) };
}
const json = (res, body) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const sse = (res, events) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('')); };

let seq = 0;
async function company() {
  const ws = `trunc-${++seq}`;
  await createCompany(ws, ws, '사장');
  const root = paths(ws).root;
  await mkdir(join(root, 'vault'), { recursive: true });
  await writeFile(join(root, 'vault', 'doc.md'), 'ORIGINAL FULL CONTENT\n'); // 잘린 Write가 덮어쓰면 안 되는 기존 파일
  return { ws, root };
}
const WRITE = { file_path: 'vault/doc.md', content: 'HALF' }; // 잘린 입력(반쪽)이라고 치자

/* ── 와이어별 가짜 서버: 1번째 응답 = 잘린 응답(도구 호출 포함), 2번째 = 끝 답 ── */
const WIRES = {
  messages: {
    env: (base) => ({ ANTHROPIC_BASE_URL: base, ANTHROPIC_AUTH_TOKEN: 'tok-fake-1234567890', ANTHROPIC_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: '' }),
    reply: (n, res, { truncated }) => json(res, n === 1
      ? { id: 'm1', type: 'message', role: 'assistant', model: 'fake', content: [{ type: 'text', text: '쓸게' }, { type: 'tool_use', id: 'w1', name: 'Write', input: WRITE }], stop_reason: truncated ? 'max_tokens' : 'tool_use', usage: { input_tokens: 10, output_tokens: 5 } }
      : { id: 'm2', type: 'message', role: 'assistant', model: 'fake', content: [{ type: 'text', text: '끝' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } }),
    // 다음 요청에 붙어 나간 tool_result
    resultOf: (call) => { const last = call.body.messages.at(-1); const r = last.content.find((b) => b.type === 'tool_result'); return r && { id: r.tool_use_id, isError: r.is_error === true, text: typeof r.content === 'string' ? r.content : JSON.stringify(r.content) }; },
  },
  responses: {
    env: (base) => ({ ARGO_WIRE: 'responses', RESPONSES_BASE_URL: base, RESPONSES_TOKEN: 'acc' }),
    reply: (n, res, { truncated }) => sse(res, [n === 1
      ? { type: truncated ? 'response.incomplete' : 'response.completed', response: { id: 'r1', model: 'gpt', status: truncated ? 'incomplete' : 'completed', ...(truncated ? { incomplete_details: { reason: 'max_output_tokens' } } : {}), output: [{ type: 'function_call', call_id: 'call_W', name: 'Write', arguments: JSON.stringify(WRITE) }], usage: { input_tokens: 10, output_tokens: 5 } } }
      : { type: 'response.completed', response: { id: 'r2', model: 'gpt', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '끝' }] }], usage: { input_tokens: 10, output_tokens: 5 } } }]),
    resultOf: (call) => { const o = call.body.input.find((i) => i.type === 'function_call_output'); return o && { id: o.call_id, isError: String(o.output).startsWith('[error] '), text: String(o.output) }; },
  },
  gemini: {
    env: (base) => ({ ARGO_WIRE: 'gemini', GEMINI_API_KEY: 'test-key', GEMINI_BASE_URL: base }),
    reply: (n, res, { truncated }) => json(res, n === 1
      ? { candidates: [{ content: { role: 'model', parts: [{ text: '쓸게' }, { functionCall: { id: 'g1', name: 'Write', args: WRITE } }] }, finishReason: truncated ? 'MAX_TOKENS' : 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } }
      : { candidates: [{ content: { role: 'model', parts: [{ text: '끝' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } }),
    resultOf: (call) => { for (const c of call.body.contents ?? []) for (const p of c.parts ?? []) if (p.functionResponse) { const r = p.functionResponse.response ?? {}; const text = JSON.stringify(r); return { id: p.functionResponse.id ?? p.functionResponse.name, isError: r.error === true, text }; } return null; },
  },
};

async function runTurn(wire, { truncated }) {
  const { ws, root } = await company();
  const w = WIRES[wire];
  const srv = await fakeServer((n, res) => w.reply(n, res, { truncated }));
  try {
    const out = [];
    for await (const ev of nativeQuery({ wsId: ws, slug: 's', prompt: '문서 써', cwd: root, systemPrompt: 'SYS', model: wire === 'gemini' ? 'gemini-2.5-pro' : 'm', saveSession: false,
      env: w.env(srv.base), canUseTool: makePermissionGate(ws, 's', root, null, 'ko', []) })) out.push(ev);
    return { out, root, calls: srv.calls, result: srv.calls[1] ? w.resultOf(srv.calls[1]) : null, file: await readFile(join(root, 'vault', 'doc.md'), 'utf8') };
  } finally { await srv.close(); }
}

/* ── 핀: 플래그 꺼짐(기본) — 잘린 응답의 tool_use도 지금처럼 실행한다 ── */
for (const wire of Object.keys(WIRES)) {
  test(`핀(플래그 꺼짐) ${wire} — 잘린 응답의 Write도 실행하고 다음 턴이 정상으로 끝난다(지금 동작)`, async () => {
    await withFlag(null, async () => {
      const r = await runTurn(wire, { truncated: true });
      assert.equal(r.out.at(-1).subtype, 'success'); assert.equal(r.out.at(-1).result, '끝');
      assert.equal(r.file, 'HALF', '꺼짐이면 잘린 입력 그대로 실행된다(지금 동작 — 플래그가 막으려는 위험)');
      assert.ok(r.result, '다음 요청에 짝 tool_result가 붙는다'); assert.equal(r.result.isError, false);
    });
  });
}

/* ── 플래그 켬(reject) — 잘린 응답의 tool_use는 실행하지 않고 is_error tool_result로 짝을 맞춘다, 다음 턴은 정상 ── */
for (const wire of Object.keys(WIRES)) {
  test(`켬 ${wire} — 잘린 응답의 Write는 실행하지 않고(기존 파일 그대로) 오류 결과를 짝으로 보내며, 다음 턴은 정상으로 끝난다`, async () => {
    await withFlag('reject', async () => {
      const r = await runTurn(wire, { truncated: true });
      assert.equal(r.out.at(-1).subtype, 'success'); assert.equal(r.out.at(-1).result, '끝', '다음 모델 호출이 정상으로 이어진다(짝 없는 tool_use 없음)');
      assert.equal(r.file, 'ORIGINAL FULL CONTENT\n', '반쪽 입력으로 덮어쓰지 않는다');
      assert.equal(r.calls.length, 2);
      assert.ok(r.result, '다음 요청에 짝 tool_result가 붙는다'); assert.equal(r.result.isError, true, '오류 결과');
      assert.match(r.result.text, /Not executed: your previous response hit the output token limit/);
      assert.match(r.result.text, /smaller/);
    });
  });
  test(`켬 ${wire} — 잘리지 않은 응답은 지금과 똑같이 실행한다`, async () => {
    await withFlag('reject', async () => {
      const r = await runTurn(wire, { truncated: false });
      assert.equal(r.out.at(-1).result, '끝'); assert.equal(r.file, 'HALF', '잘리지 않았으면 실행'); assert.equal(r.result.isError, false);
    });
  });
}

test('와이어 절단 표지 — Responses incomplete·Gemini MAX_TOKENS는 도구 호출이 있어도 truncated를 싣고, stop_reason은 종전 그대로', () => {
  const fc = { type: 'function_call', call_id: 'c', name: 'Write', arguments: '{"file_path":"a"' }; // 잘린 인자(깨진 JSON)
  const r1 = fromResponsesResponse({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [fc] }, 'm');
  assert.equal(r1.stop_reason, 'tool_use', 'stop_reason은 종전 그대로(엔진 분기 불변)'); assert.equal(r1.truncated, true);
  assert.deepEqual(r1.content[0].input, { _raw: '{"file_path":"a"' }, '깨진 인자는 종전처럼 _raw');
  assert.equal(fromResponsesResponse({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [{ type: 'message', content: [{ type: 'output_text', text: 'cut' }] }] }, 'm').stop_reason, 'max_tokens');
  assert.equal(fromResponsesResponse({ status: 'completed', output: [fc] }, 'm').truncated, undefined, '안 잘리면 표지 없음');
  assert.equal(fromResponsesResponse({ status: 'incomplete', incomplete_details: { reason: 'content_filter' }, output: [fc] }, 'm').truncated, undefined, '출력 한도가 아닌 incomplete는 절단 아님');
  const g = (finishReason) => fromGeminiResponse({ candidates: [{ content: { parts: [{ functionCall: { name: 'Write', args: {} } }] }, finishReason }] }, 'm');
  assert.equal(g('MAX_TOKENS').stop_reason, 'tool_use'); assert.equal(g('MAX_TOKENS').truncated, true);
  assert.equal(g('STOP').truncated, undefined);
});

test('플래그 해석 — reject만 켬, 미설정·빈 값·그 밖의 값은 꺼짐(지금 동작)', () => {
  assert.equal(flags.truncatedToolsRejected({}), false);
  for (const v of ['', 'run', 'off', '0', 'true', 'yes']) assert.equal(flags.truncatedToolsRejected({ ARGO_NATIVE_TRUNCATED_TOOLS: v }), false, v);
  for (const v of ['reject', 'REJECT', ' reject ']) assert.equal(flags.truncatedToolsRejected({ ARGO_NATIVE_TRUNCATED_TOOLS: v }), true, v);
  assert.match(flags.TRUNCATED_TOOL_ERROR, /^Not executed: /); assert.ok(!/[가-힣]/.test(flags.TRUNCATED_TOOL_ERROR), '모델이 읽는 문장은 영어');
});
