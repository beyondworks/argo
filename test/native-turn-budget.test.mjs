// 네이티브 엔진 턴 안 예산(제보 2026-10-08 Grok 구독 사용자 "50만·60만 컨텍스트 넘음") — 한 턴 안 도구 반복이 매 호출 전사 전체를 다시 보내
// 큰 Read를 반복하면 창을 넘었고, 거절 뒤 저장 꼬리(tool_result)를 재개 정리가 연쇄로 걷어내 그 턴 진행분이 사라져 같은 실패를 반복했다.
// 엄격 가짜 벤더(test/helpers/strict-vendor.mjs)에 '본문이 한도를 넘으면 벤더별 400' 규칙을 두고, 러너 축(grok·glm·kimi·openrouter·claude·gemini·codex)마다 본다. 실벤더 호출 0.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from './helpers/tmp.mjs';
import { startStrictVendor, vendorTokens } from './helpers/strict-vendor.mjs';

process.env.HOME = await mkdtemp(join(tmpdir(), 'argo-tb-home-'));
process.env.USERPROFILE = process.env.HOME;
process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-tb-'));
process.env.ARGO_MODEL_CATALOG = 'off';

const { nativeQuery } = await import('../src/engine/native-query.mjs');
const { sessionFile, loadNativeSession } = await import('../src/engine/session.mjs');
const { createCompany, paths } = await import('../src/workspace.mjs');
const { classifyRunnerError } = await import('../src/runners/error-class.mjs');

// 러너 → 가짜 벤더·자격 env·응답 모양. 앞 다섯은 Anthropic Messages 와이어(벤더별 엄격 규칙·거절 문구), gemini·codex는 각자 와이어.
const MSG_ENV = (base) => ({ ANTHROPIC_BASE_URL: base, ANTHROPIC_AUTH_TOKEN: 'tok-fake-1234567890', ANTHROPIC_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: '' });
const RUNNERS = {
  grok: { vendor: 'xai', env: MSG_ENV, wire: 'messages' },
  glm: { vendor: 'zai', env: MSG_ENV, wire: 'messages' },
  kimi: { vendor: 'moonshot', env: MSG_ENV, wire: 'messages' },
  openrouter: { vendor: 'openrouter', env: MSG_ENV, wire: 'messages' },
  claude: { vendor: 'anthropic', env: (base) => ({ ANTHROPIC_BASE_URL: base, ANTHROPIC_API_KEY: 'key-fake-1234567890', ANTHROPIC_AUTH_TOKEN: '', CLAUDE_CODE_OAUTH_TOKEN: '' }), wire: 'messages' },
  gemini: { vendor: 'gemini', env: (base) => ({ ARGO_WIRE: 'gemini', GEMINI_BASE_URL: base, GEMINI_API_KEY: 'k-fake-1234567890' }), wire: 'gemini' },
  codex: { vendor: 'responses', env: (base) => ({ ARGO_WIRE: 'responses', RESPONSES_BASE_URL: base, RESPONSES_TOKEN: 'tok-fake-1234567890' }), wire: 'responses' },
};

/** 요청 본문에서 끝난 도구 결과 수(와이어별) — 벤더(모델)는 이 수만큼 읽었으면 다음 파일을 읽는다. 줄인 결과도 결과로 센다(짝이 남아 있어야 한다). */
const doneReads = (wire, body) => (wire === 'gemini' ? (body.contents ?? []).flatMap((c) => c.parts ?? []).filter((p) => p.functionResponse).length
  : wire === 'responses' ? (body.input ?? []).filter((x) => x.type === 'function_call_output').length
    : (body.messages ?? []).flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b.type === 'tool_result').length);
/** reads개를 차례로 Read한 뒤 답하는 가짜 모델(와이어별 응답 모양). */
function reader(wire, reads) {
  return (body, n) => {
    const k = doneReads(wire, body);
    const file = k < reads ? `big${k}.txt` : null;
    if (wire === 'gemini') {
      const parts = file ? [{ functionCall: { name: 'Read', args: { file_path: file } } }] : [{ text: `다 읽었다 ${k}` }];
      return { status: 200, type: 'application/json', body: JSON.stringify({ candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 }, responseId: `g${n}` }) };
    }
    if (wire === 'responses') {
      const output = file ? [{ type: 'function_call', call_id: `call_${n}`, name: 'Read', arguments: JSON.stringify({ file_path: file }) }] : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `다 읽었다 ${k}` }] }];
      const ev = { type: 'response.completed', response: { id: `resp_${n}`, model: body.model, status: 'completed', output, usage: { input_tokens: 10, output_tokens: 5 } } };
      return { status: 200, type: 'text/event-stream', body: `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n` };
    }
    const content = file ? [{ type: 'tool_use', id: `tu${n}`, name: 'Read', input: { file_path: file } }] : [{ type: 'text', text: `다 읽었다 ${k}` }];
    return { id: `m${n}`, type: 'message', role: 'assistant', model: body.model, content, stop_reason: file ? 'tool_use' : 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } };
  };
}

// 큰 파일 — 2,000줄 × 약 50자(영문) → Read 결과는 도구 결과 상한 60,000자로 잘린다(엔진 추정 ≈ 20,000토큰, 가짜 벤더 셈 ≈ 15,600토큰)
const LINE = (i) => `${String(i).padStart(4, '0')} quarterly revenue line with region totals and notes`;
async function company(ws) {
  await createCompany(ws, ws, '사장');
  const root = paths(ws).root;
  for (let f = 0; f < 16; f++) await writeFile(join(root, `big${f}.txt`), Array.from({ length: 2000 }, (_, i) => LINE(i)).join('\n'));
  return root;
}
async function collect(q) { const out = []; try { for await (const m of q) out.push(m); } catch (e) { out.push({ type: 'thrown', error: e }); } return out; }
const run = (ws, root, r, base, opts = {}) => collect(nativeQuery({ wsId: ws, slug: 'crew', prompt: opts.prompt ?? '보고서 파일을 차례로 읽어 줘', cwd: root, systemPrompt: 'SYS', env: r.env(base),
  model: 'm-fake', browser: false, resume: opts.resume ?? null, contextTokens: opts.contextTokens, lang: opts.lang ?? 'ko', ...(opts.saveSession === false ? { saveSession: false } : {}) }));
const SQUEEZED = /대화가 길어져 이 도구 결과를 줄였다|This tool result was shortened/;
/** 전사 모양 불변식 — 역할 교대, 모든 tool_use가 바로 다음 user의 tool_result로 짝지어짐, 첫 메시지는 user. */
function assertWellFormed(messages, label) {
  assert.equal(messages[0].role, 'user', `${label}: 첫 메시지는 user`);
  for (let i = 1; i < messages.length; i++) assert.notEqual(messages[i].role, messages[i - 1].role, `${label}: 역할 교대(${i})`);
  messages.forEach((m, i) => {
    if (m.role !== 'assistant' || !Array.isArray(m.content)) return;
    const ids = m.content.filter((b) => b.type === 'tool_use').map((b) => b.id);
    const got = (messages[i + 1]?.content ?? []).filter?.((b) => b.type === 'tool_result').map((b) => b.tool_use_id) ?? [];
    for (const id of ids) assert.ok(got.includes(id), `${label}: tool_use ${id}의 짝이 바로 다음에 있다`);
  });
}

test('TB1. 턴 안 예산 — 큰 Read 14회 턴이 창을 넘지 않고 끝난다: 오래된 결과만 자리표시로, 최근 3개·짝·역할 교대 유지, 저장 전사에도 반영(러너 7종)', async () => {
  for (const [name, r] of Object.entries(RUNNERS)) {
    const ws = `tb1-${name}`; const root = await company(ws);
    // 창 200,000(엔진 추정 단위) — 가짜 벤더는 자기 셈으로 160,000토큰을 넘으면 거절. 줄이지 않으면 11번째 무렵 호출에서 넘는다(main 재현).
    const srv = await startStrictVendor({ vendor: r.vendor, reply: reader(r.wire, 14), contextLimit: 160_000 });
    try {
      const out = await run(ws, root, r, srv.base, { contextTokens: 200_000 });
      const last = out.at(-1);
      assert.equal(last.subtype, 'success', `${name}: 턴 성공 — ${JSON.stringify(last.errors ?? last.error?.message ?? '').slice(0, 200)}`);
      assert.match(last.result, /다 읽었다 14/, `${name}: 14개를 다 읽고 답했다`);
      assert.equal(srv.calls.filter((c) => c.rejected).length, 0, `${name}: 벤더 길이 초과 거절 0회`);
      const saved = JSON.parse(await readFile(sessionFile(ws, 'crew'), 'utf8'));
      assertWellFormed(saved.messages, `${name} 저장 전사`);
      const results = saved.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b.type === 'tool_result');
      assert.equal(results.length, 14, `${name}: 도구 결과 14개(짝 유지)`);
      const squeezed = results.filter((b) => SQUEEZED.test(String(b.content)));
      assert.ok(squeezed.length >= 5, `${name}: 오래된 결과를 줄였다(${squeezed.length}개)`);
      for (const b of results.slice(-3)) assert.ok(!SQUEEZED.test(String(b.content)) && String(b.content).length > 50_000, `${name}: 최근 3개는 그대로`);
      for (const b of squeezed) assert.match(String(b.content), /^1\t0000 quarterly revenue line/, `${name}: 줄인 결과는 앞부분을 남긴다(Read 줄번호 포함)`);
      assert.match(String(squeezed[0].content), /원래 \d+자/, `${name}: 원래 길이를 적는다`);
    } finally { await srv.close(); }
  }
});

test('TB1b. 창이 빠듯하면 오래된 결과는 전부 줄이되 최근 3개는 끝까지 그대로 둔다', async () => {
  const ws = 'tb1b'; const root = await company(ws);
  const srv = await startStrictVendor({ vendor: 'xai', reply: reader('messages', 8), contextLimit: 100_000 });
  try {
    const out = await run(ws, root, RUNNERS.grok, srv.base, { contextTokens: 90_000 });
    assert.equal(out.at(-1).subtype, 'success', JSON.stringify(out.at(-1).errors ?? '').slice(0, 200));
    assert.equal(srv.calls.filter((c) => c.rejected).length, 0);
    const saved = JSON.parse(await readFile(sessionFile(ws, 'crew'), 'utf8'));
    const results = saved.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b.type === 'tool_result');
    assert.equal(results.length, 8);
    results.slice(0, -3).forEach((b, i) => assert.match(String(b.content), SQUEEZED, `오래된 결과 ${i}는 줄였다`));
    results.slice(-3).forEach((b, i) => assert.ok(String(b.content).length > 50_000, `최근 결과 ${i}는 그대로`));
  } finally { await srv.close(); }
});

test('TB2. 길이 초과 400 복구 — 카탈로그 창(1M)보다 실제 한도가 작은 벤더가 거절하면, 벤더별 문구로 알아보고 더 줄여 같은 단계를 1번만 다시 보내 턴이 끝난다(러너 7종)', async () => {
  for (const [name, r] of Object.entries(RUNNERS)) {
    const ws = `tb2-${name}`; const root = await company(ws);
    const srv = await startStrictVendor({ vendor: r.vendor, reply: reader(r.wire, 14), contextLimit: 120_000 });
    try {
      const out = await run(ws, root, r, srv.base, { contextTokens: 1_000_000 });
      const last = out.at(-1);
      assert.equal(last.subtype, 'success', `${name}: 턴 성공 — ${JSON.stringify(last.errors ?? last.error?.message ?? '').slice(0, 300)}`);
      assert.match(last.result, /다 읽었다 14/);
      const rej = srv.calls.map((c, i) => (c.rejected ? i : -1)).filter((i) => i >= 0);
      assert.equal(rej.length, 1, `${name}: 길이 초과 거절은 1번 — 그 뒤로는 낮춘 창으로 미리 줄인다(거절 ${rej.length}회)`);
      assert.ok(srv.calls[rej[0] + 1].tokens < srv.calls[rej[0]].tokens * 0.8, `${name}: 다시 보낸 요청은 줄었다`);
      assert.equal(doneReads(r.wire, srv.calls[rej[0] + 1].body), doneReads(r.wire, srv.calls[rej[0]].body), `${name}: 같은 단계를 다시 보냈다(도구 재실행 없음)`);
    } finally { await srv.close(); }
  }
});

test('TB3. 다시 보내도 넘치면 사실대로 끝내고 진행분은 남긴다 — 다음 턴이 끝난 도구 결과를 이어받는다(러너 7종)', async () => {
  for (const [name, r] of Object.entries(RUNNERS)) {
    const ws = `tb3-${name}`; const root = await company(ws);
    // 3번째 호출부터 무조건 거절(한도 1토큰) — 2개를 읽은 뒤 3번째 호출과 그 재시도가 거절된다
    const srv = await startStrictVendor({ vendor: r.vendor, reply: reader(r.wire, 14), contextLimit: (n) => (n >= 3 ? 1 : null) });
    let sid;
    try {
      const out = await run(ws, root, r, srv.base, { contextTokens: 1_000_000 });
      sid = out[0].session_id;
      const last = out.at(-1);
      assert.equal(last.type, 'result', `${name}: 실패 result(던지지 않음 — 이미 토큰을 썼다)`); assert.equal(last.subtype, 'error_during_execution');
      assert.match(last.errors[0], /^컨텍스트 한도 초과 — /, `${name}: 사실대로 된 머리 문구`);
      assert.match(last.errors[0], /이어서 해 줘/, `${name}: 진행분을 저장했다고 알린다`);
      assert.equal(classifyRunnerError(`턴 실패: error_during_execution — ${last.errors[0]}`).code, 'context_exceeded', `${name}: 실패 코드 표가 문다`);
      assert.equal(srv.calls.length, 4, `${name}: 거절 뒤 재시도는 1번(2 성공 + 거절 + 재시도 거절)`);
    } finally { await srv.close(); }
    const saved = JSON.parse(await readFile(sessionFile(ws, 'crew'), 'utf8'));
    assert.equal(saved.messages.at(-1).role, 'assistant', `${name}: 저장 꼬리는 크루 글(중단 기록)`);
    assert.match(saved.messages.at(-1).content[0].text, /^\[작업 중단 — /);
    const loaded = await loadNativeSession(ws, 'crew', sid);
    assert.equal(loaded.messages.length, saved.messages.length, `${name}: 재개 정리가 진행분을 걷어내지 않는다`);
    // 다음 턴 — 진행분(끝난 도구 결과 2개)을 이어받는다(main: 메시지 1개로 새로 시작)
    const srv2 = await startStrictVendor({ vendor: r.vendor, reply: reader(r.wire, 3) });
    try {
      const out2 = await run(ws, root, r, srv2.base, { contextTokens: 1_000_000, resume: sid, prompt: '이어서 해 줘' });
      assert.equal(out2.at(-1).subtype, 'success', `${name}: 다음 턴 성공`);
      assert.equal(doneReads(r.wire, srv2.calls[0].body), 2, `${name}: 다음 턴 첫 요청에 끝난 도구 결과 2개가 실린다`);
      assert.equal(srv2.calls.length, 2, `${name}: 남은 1개만 읽고 끝난다(처음부터 반복하지 않는다)`);
    } finally { await srv2.close(); }
    const saved2 = JSON.parse(await readFile(sessionFile(ws, 'crew'), 'utf8'));
    assertWellFormed(saved2.messages, `${name} 다음 턴 저장 전사`);
  }
});

test('TB4. 줄일 것이 없는 첫 호출 거절은 재시도 없이 사실대로 던진다(진행분 없음) — 실패 코드는 context_exceeded', async () => {
  const ws = 'tb4'; const root = await company(ws);
  const srv = await startStrictVendor({ vendor: 'xai', reply: reader('messages', 1), contextLimit: 1 });
  try {
    const out = await run(ws, root, RUNNERS.grok, srv.base, { contextTokens: 500_000, lang: 'en' });
    const t = out.at(-1); assert.equal(t.type, 'thrown');
    assert.match(t.error.message, /^Context limit exceeded — /);
    assert.match(t.error.message, /maximum prompt length is 1 but the request contains/, '벤더 원문을 남긴다');
    assert.equal(classifyRunnerError(t.error.message).code, 'context_exceeded');
    assert.equal(srv.calls.length, 1, '줄일 도구 결과가 없으면 같은 요청을 다시 보내지 않는다');
  } finally { await srv.close(); }
});

test('TB5. (핀) 길이 초과가 아닌 400은 재시도·자리표시 없이 종전 그대로 — 원문 errors[0], 꼬리 정리 규칙도 그대로', async () => {
  const ws = 'tb5'; const root = await company(ws);
  // 3번째 호출만 길이와 무관한 400(xAI 스키마 거절 문구)
  const read = reader('messages', 9); const calls = [];
  const srv = createServer((req, res) => {
    let d = ''; req.on('data', (c) => { d += c; });
    req.on('end', () => {
      const body = JSON.parse(d); calls.push(body);
      const bad = calls.length === 3;
      res.writeHead(bad ? 400 : 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(bad ? { type: 'error', error: { type: 'invalid_request_error', message: 'Invalid request content: Schema validation failed: [standard_violation] /required: null is not of type "array"' } } : read(body, calls.length)));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const out = await run(ws, root, RUNNERS.grok, `http://127.0.0.1:${srv.address().port}`, { contextTokens: 500_000 });
    const last = out.at(-1);
    assert.equal(last.subtype, 'error_during_execution');
    assert.match(last.errors[0], /^API Error: 400 Invalid request content: Schema validation failed/, '원문 그대로');
    assert.equal(calls.length, 3, '재시도 없음');
    const saved = JSON.parse(await readFile(sessionFile(ws, 'crew'), 'utf8'));
    assert.equal(saved.messages.at(-1).role, 'user', '꼬리는 종전처럼 도구 결과(중단 기록을 붙이지 않는다 — 원인 모를 거절은 다음 턴 재개 정리가 그 턴을 걷어낸다)');
  } finally { await new Promise((r) => srv.close(r)); }
});

test('TB6. (핀) 창 안의 턴은 한 글자도 바뀌지 않는다 — 자리표시 0, 보낸 전사 = 저장 전사', async () => {
  const ws = 'tb6'; const root = await company(ws);
  const srv = await startStrictVendor({ vendor: 'xai', reply: reader('messages', 4), contextLimit: 10_000_000 });
  try {
    const out = await run(ws, root, RUNNERS.grok, srv.base, { contextTokens: 1_000_000 });
    assert.equal(out.at(-1).subtype, 'success');
    for (const c of srv.calls) assert.doesNotMatch(JSON.stringify(c.body), SQUEEZED);
    const saved = JSON.parse(await readFile(sessionFile(ws, 'crew'), 'utf8'));
    assert.deepEqual(saved.messages.slice(0, -1), srv.calls.at(-1).body.messages, '마지막 요청의 전사 = 저장 전사(답 제외)');
  } finally { await srv.close(); }
});

test('TB7. 세션을 남기지 않는 턴(saveSession:false)은 줄여도 세션 파일을 쓰지 않는다', async () => {
  const ws = 'tb7'; const root = await company(ws);
  const srv = await startStrictVendor({ vendor: 'xai', reply: reader('messages', 10), contextLimit: 160_000 });
  try {
    const out = await run(ws, root, RUNNERS.grok, srv.base, { contextTokens: 200_000, saveSession: false });
    assert.equal(out.at(-1).subtype, 'success');
    assert.ok(srv.calls.some((c) => SQUEEZED.test(JSON.stringify(c.body))), '이 턴에서 줄이기가 일어났다');
    await assert.rejects(stat(sessionFile(ws, 'crew')), { code: 'ENOENT' });
  } finally { await srv.close(); }
});

test('TB8. 가짜 벤더 셈(정비사 실측 비율) — 한글 0.74·영문 0.26 토큰/글자', () => {
  assert.equal(vendorTokens('가'.repeat(100)), 74);
  assert.equal(vendorTokens('a'.repeat(100)), 26);
});

test('TB9. 줄이기(순수) — 오래된 것부터·목표 도달 시 멈춤·최근 keepRecent개·끼워 넣기 글·지시·크루 글·요약 블록은 그대로, 이미지는 글로, 다시 줄여도 원래 길이 유지', async () => {
  const { squeezeToolResults, squeezeResultBlock, overflowNumbers, windowAfterOverflow } = await import('../src/engine/turn-budget.mjs');
  const big = (c) => c.repeat(30_000);
  const msgs = [
    { role: 'user', content: [{ type: 'text', text: '[참고 요약 — x]' }, { type: 'text', text: '지시 '.repeat(500) }] },
    { role: 'assistant', content: [{ type: 'text', text: '읽을게' }, { type: 'tool_use', id: 'a', name: 'Read', input: { file_path: 'a' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: big('a') }, { type: 'text', text: '사용자가 작업 중에 새 메시지를 보냈다:\n끼워 넣기' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'b', name: 'browser_screenshot', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b', is_error: true, content: [{ type: 'text', text: 'shot' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } }] }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'c', name: 'Read', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c', content: big('c') }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'd', name: 'Read', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'd', content: big('d') }] },
  ];
  const frozen = JSON.stringify(msgs);
  const r = squeezeToolResults(msgs, { target: 1, keepRecent: 1, head: 100, lang: 'ko' });
  assert.equal(JSON.stringify(msgs), frozen, '입력 비파괴');
  assert.equal(r.squeezed, 3, 'a·b·c를 줄이고 최근 d는 그대로');
  assert.equal(r.messages[8], msgs[8]);
  for (const i of [0, 1, 3, 5, 7]) assert.equal(r.messages[i], msgs[i], `지시·크루 글·tool_use는 그대로(${i})`);
  assert.deepEqual(r.messages[2].content[1], msgs[2].content[1], '끼워 넣기 글은 그대로');
  assert.equal(r.messages[2].content[0].tool_use_id, 'a');
  assert.match(r.messages[2].content[0].content, /^a{100}\n…\(대화가 길어져 이 도구 결과를 줄였다 — 원래 30000자/);
  assert.equal(r.messages[4].content[0].is_error, true, 'is_error 유지');
  assert.match(r.messages[4].content[0].content, /^shot\n\[이미지 생략\]/, '이미지는 글 자리표시로(짧아도 이미지가 있으면 줄인다)');
  // 기본값 — 최근 도구 결과 메시지 3개는 그대로(목표에 못 닿아도)
  const five = Array.from({ length: 5 }, (_, i) => [{ role: 'assistant', content: [{ type: 'tool_use', id: `k${i}`, name: 'Read', input: {} }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: `k${i}`, content: big('k') }] }]).flat();
  const d5 = squeezeToolResults([{ role: 'user', content: 'go' }, ...five], { target: 1 });
  assert.equal(d5.squeezed, 2, '기본은 최근 3개를 남긴다'); assert.deepEqual(d5.messages.slice(-6), five.slice(-6));
  // 목표에 닿으면 멈춘다 — 넉넉한 목표면 가장 오래된 하나만
  const { estimateTokens } = await import('../src/engine/compact.mjs');
  const total = (m) => estimateTokens(m); // 엔진과 같은 셈(이미지는 장당 고정값)
  const one = squeezeToolResults(msgs, { target: total(msgs) - 5_000, keepRecent: 1, head: 100 });
  assert.equal(one.squeezed, 1); assert.equal(one.messages[4], msgs[4], '목표에 닿은 뒤로는 손대지 않는다');
  assert.equal(squeezeToolResults(msgs, { target: total(msgs) + 10 }).squeezed, 0, '목표 아래면 그대로');
  assert.equal(squeezeToolResults(msgs, { target: total(msgs) + 10 }).messages, msgs);
  // 다시 줄이기 — 원래 길이를 이어받고, 더 짧은 앞부분으로
  const once = squeezeResultBlock({ type: 'tool_result', tool_use_id: 'z', content: big('z') }, 1000, 'en');
  assert.match(once.content, /originally 30000 chars/);
  assert.equal(squeezeResultBlock(once, 1000, 'en'), once, '같은 길이로는 다시 줄이지 않는다(멱등)');
  const twice = squeezeResultBlock(once, 0, 'en');
  assert.match(twice.content, /^…\(This tool result was shortened because the conversation grew long — originally 30000 chars/);
  const short = { type: 'tool_result', tool_use_id: 's', content: 'short' }; assert.equal(squeezeResultBlock(short, 100), short, '짧은 결과는 그대로');
  // 거절 원문의 숫자(벤더별) → 이 턴의 창
  assert.deepEqual(overflowNumbers("This model's maximum prompt length is 500000 but the request contains 503958 tokens."), { requested: 503958, limit: 500000 });
  assert.deepEqual(overflowNumbers('prompt is too long: 213456 tokens > 200000 maximum'), { requested: 213456, limit: 200000 });
  assert.deepEqual(overflowNumbers('The input token count (1200000) exceeds the maximum number of tokens allowed (1048576).'), { requested: 1200000, limit: 1048576 });
  assert.deepEqual(overflowNumbers('Your request exceeded model token limit: 262144 (requested: 300000)'), { requested: 300000, limit: 262144 });
  assert.deepEqual(overflowNumbers("This endpoint's maximum context length is 131072 tokens. However, you requested about 150000 tokens (141808 of text input, 8192 in the output)."), { requested: 150000, limit: 131072 }, '출력 몫 숫자에 속지 않는다');
  assert.equal(overflowNumbers('Prompt too long'), null);
  assert.equal(windowAfterOverflow(1_000_000, 200_000, 'prompt is too long: 150000 tokens > 100000 maximum'), 133_333, '벤더 셈과 우리 추정의 비로 환산');
  assert.equal(windowAfterOverflow(1_000_000, 200_000, 'Prompt too long'), 200_000, '숫자가 없으면 거절 지점');
  assert.equal(windowAfterOverflow(150_000, 200_000, 'Prompt too long'), 150_000, '원래 창보다 키우지 않는다');
});

test('TB10. 실패 코드 표 — 벤더별 길이 초과 문구는 context_exceeded, 분당 한도·잔액·출력 상한·스키마 거절은 아니다', () => {
  const pos = [
    "API Error: 400 This model's maximum prompt length is 500000 but the request contains 503958 tokens. (Client specified an invalid argument)",
    'API Error: 400 prompt is too long: 213456 tokens > 200000 maximum', 'API Error: 413 request_too_large',
    "API Error: 400 This endpoint's maximum context length is 131072 tokens. However, you requested about 150000 tokens",
    'API Error: 400 Prompt too long (1261)', 'API Error: 400 Invalid request: Your request exceeded model token limit: 262144 (requested: 300000)',
    'API Error: 400 The input token count (1200000) exceeds the maximum number of tokens allowed (1048576). (INVALID_ARGUMENT)',
    'API Error: 400 Your input exceeds the context window of this model. Please adjust your input and try again. (context_length_exceeded)',
    'API Error: 429 Your input exceeds the context window (context_length_exceeded)',
    '턴 실패: error_during_execution — 컨텍스트 한도 초과 — 이번 턴의 작업 내용이', 'Turn failed: error_during_execution — Context limit exceeded — the work',
  ];
  for (const s of pos) assert.equal(classifyRunnerError(s).code, 'context_exceeded', s);
  const neg = [
    ['API Error: 429 Rate limit reached: too many tokens per minute', 'quota'],
    ['API Error: 400 max_tokens: 64000 > 32000, which is the maximum allowed number of output tokens for claude-x', 'unknown'],
    ['API Error: 402 This request requires more credits, or fewer max_tokens. You requested up to 8192 tokens, but can only afford 2000.', 'quota'],
    ['API Error: 400 Invalid request content: Schema validation failed', 'unknown'],
    ['API Error: 401 invalid x-api-key', 'auth_expired'],
  ];
  for (const [s, code] of neg) assert.equal(classifyRunnerError(s).code, code, s);
});
