// 네이티브 엔진 턴 안 예산(제보 2026-10-08 Grok 구독 사용자 "50만·60만 컨텍스트 넘음") — 한 턴 안 도구 반복이 매 호출 전사 전체를 다시 보내
// 큰 Read를 반복하면 창을 넘었고, 거절 뒤 저장 꼬리(tool_result)를 재개 정리가 연쇄로 걷어내 그 턴 진행분이 사라져 같은 실패를 반복했다.
// 엄격 가짜 벤더(test/helpers/strict-vendor.mjs)에 '본문이 한도를 넘으면 벤더별 400' 규칙을 두고, 러너 축(grok·glm·kimi·openrouter·claude·gemini·codex)마다 본다. 실벤더 호출 0.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from './helpers/tmp.mjs';
import { startStrictVendor, vendorTokens } from './helpers/strict-vendor.mjs';

process.env.HOME = await mkdtemp(join(tmpdir(), 'argo-tb-home-'));
process.env.USERPROFILE = process.env.HOME;
process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-tb-'));
process.env.ARGO_MODEL_CATALOG = 'off';

const { nativeQuery } = await import('../src/engine/native-query.mjs');
const { sessionFile, loadNativeSession, saveNativeSession } = await import('../src/engine/session.mjs');
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

/** 지시만 있으면(끝난 도구 결과 0) 한 단계에서 par개를 한꺼번에 Read하고(병렬 도구 호출), 결과가 있으면 답하는 가짜 모델(와이어별). */
function parallelReader(wire, par) {
  return (body, n) => {
    const k = doneReads(wire, body);
    const files = k ? [] : Array.from({ length: par }, (_, i) => `big${i}.txt`);
    if (wire === 'gemini') {
      const parts = files.length ? files.map((f) => ({ functionCall: { name: 'Read', args: { file_path: f } } })) : [{ text: `답 ${k}` }];
      return { status: 200, type: 'application/json', body: JSON.stringify({ candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 }, responseId: `g${n}` }) };
    }
    if (wire === 'responses') {
      const output = files.length ? files.map((f, i) => ({ type: 'function_call', call_id: `call_${n}_${i}`, name: 'Read', arguments: JSON.stringify({ file_path: f }) })) : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `답 ${k}` }] }];
      const ev = { type: 'response.completed', response: { id: `resp_${n}`, model: body.model, status: 'completed', output, usage: { input_tokens: 10, output_tokens: 5 } } };
      return { status: 200, type: 'text/event-stream', body: `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n` };
    }
    const content = files.length ? files.map((f, i) => ({ type: 'tool_use', id: `tu${n}_${i}`, name: 'Read', input: { file_path: f } })) : [{ type: 'text', text: `답 ${k}` }];
    return { id: `m${n}`, type: 'message', role: 'assistant', model: body.model, content, stop_reason: files.length ? 'tool_use' : 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } };
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
/** 이어 오던 대화(앞 턴 하나가 끝난 세션) — 스레드가 이 세션 id를 쥐고 있어 다음 턴이 이어받는 경우를 흉내 낸다. */
const PRIOR = (id) => ({ id, messages: [{ role: 'user', content: '앞 대화 지시' }, { role: 'assistant', content: [{ type: 'text', text: '앞 대화 답' }] }] });
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
      // 줄일 때 넉넉히(창의 50%까지) 줄여 매 단계 다시 줄이지 않는다 — 줄인 블록 수가 바뀐 호출 = 프롬프트 캐시 앞부분이 바뀐 호출(TURN_SQUEEZE_TO를 기준선 가까이 올리면 거의 매 호출이 된다)
      const nSq = srv.calls.map((c) => (JSON.stringify(c.body).match(new RegExp(SQUEEZED.source, 'g')) ?? []).length);
      const changes = nSq.filter((v, i) => i > 0 && v !== nSq[i - 1]).length;
      assert.ok(changes >= 1 && changes <= 3, `${name}: 앞부분이 바뀐 호출은 3번 이하(${changes}번 — 줄인 수 ${nSq.join(',')})`);
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
      if (r.wire === 'messages') { // 재전송은 평소(앞 1,000자)보다 세게 — 줄인 결과마다 앞 200자만 남긴다(HARD_HEAD_CHARS)
        const heads = srv.calls[rej[0] + 1].body.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : []))
          .filter((b) => b.type === 'tool_result' && SQUEEZED.test(String(b.content))).map((b) => String(b.content).split('\n…(')[0].length);
        assert.ok(heads.length && heads.every((h) => h <= 200), `${name}: 재전송에서 줄인 결과는 앞 200자까지만(${heads.join(',')})`);
      }
    } finally { await srv.close(); }
  }
});

test('TB3. 다시 보내도 넘치면 사실대로 끝내고 진행분은 남긴다 — 다음 턴이 끝난 도구 결과를 이어받는다(러너 7종)', async () => {
  for (const [name, r] of Object.entries(RUNNERS)) {
    const ws = `tb3-${name}`; const root = await company(ws);
    // 이어 오던 대화(스레드가 세션 id를 쥐고 있다 — '이어서 해 줘'가 사실인 경우). 3번째 호출부터 무조건 거절(한도 1토큰) — 2개를 읽은 뒤 3번째 호출과 그 재시도가 거절된다
    await saveNativeSession(ws, 'crew', PRIOR('tb3-prev'));
    const srv = await startStrictVendor({ vendor: r.vendor, reply: reader(r.wire, 14), contextLimit: (n) => (n >= 3 ? 1 : null) });
    let sid;
    try {
      const out = await run(ws, root, r, srv.base, { contextTokens: 1_000_000, resume: 'tb3-prev' });
      sid = out[0].session_id; assert.equal(sid, 'tb3-prev', `${name}: 이어 온 세션`);
      const last = out.at(-1);
      assert.equal(last.type, 'result', `${name}: 실패 result(던지지 않음 — 이미 토큰을 썼다)`); assert.equal(last.subtype, 'error_during_execution');
      assert.match(last.errors[0], /^컨텍스트 한도 초과 — /, `${name}: 사실대로 된 머리 문구`);
      assert.match(last.errors[0], /이어서 해 줘/, `${name}: 진행분을 저장했고 다음 턴이 잇는다고 알린다`);
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

test('TB7. 세션을 남기지 않는 턴(saveSession:false)은 줄여도·길이 초과로 실패해도 세션 파일을 쓰지 않고, 실패 원문에 저장·이어받기를 약속하지 않는다', async () => {
  const ws = 'tb7'; const root = await company(ws);
  const srv = await startStrictVendor({ vendor: 'xai', reply: reader('messages', 10), contextLimit: 160_000 });
  try {
    const out = await run(ws, root, RUNNERS.grok, srv.base, { contextTokens: 200_000, saveSession: false });
    assert.equal(out.at(-1).subtype, 'success');
    assert.ok(srv.calls.some((c) => SQUEEZED.test(JSON.stringify(c.body))), '이 턴에서 줄이기가 일어났다');
    await assert.rejects(stat(sessionFile(ws, 'crew')), { code: 'ENOENT' });
  } finally { await srv.close(); }
  // 같은 턴이 길이 초과로 실패해도 세션 파일을 바꾸지 않고, 실패 원문에 '저장됨 — 이어서 해 줘'를 쓰지 않는다(이어 온 세션이어도 — 2차 검수 LOW)
  const ws2 = 'tb7b'; const root2 = await company(ws2);
  await saveNativeSession(ws2, 'crew', PRIOR('tb7-prev'));
  const before = await readFile(sessionFile(ws2, 'crew'), 'utf8');
  const srv2 = await startStrictVendor({ vendor: 'xai', reply: reader('messages', 14), contextLimit: (n) => (n >= 3 ? 1 : null) });
  try {
    const out = await run(ws2, root2, RUNNERS.grok, srv2.base, { contextTokens: 1_000_000, saveSession: false, resume: 'tb7-prev' });
    const last = out.at(-1);
    assert.equal(last.subtype, 'error_during_execution');
    assert.match(last.errors[0], /^컨텍스트 한도 초과 — /);
    assert.doesNotMatch(last.errors[0], /저장됨|이어서 해 줘|saved|continue/, `세션을 남기지 않는 턴은 저장·이어받기를 약속하지 않는다 — ${last.errors[0].slice(0, 160)}`);
    assert.equal(await readFile(sessionFile(ws2, 'crew'), 'utf8'), before, '세션 파일은 그대로');
  } finally { await srv2.close(); }
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
  assert.deepEqual(overflowNumbers('input length and `max_tokens` exceed context limit: 188240 + 21333 > 200000, decrease input length or `max_tokens` and try again'), { requested: 188240, limit: 178667 }, 'Anthropic 입력 + 출력 > 한도 — 입력 몫(한도 − 출력)을 한도로');
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
    'API Error: 400 input length and `max_tokens` exceed context limit: 188240 + 21333 > 200000, decrease input length or `max_tokens` and try again',
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

test('TB11. 한 단계의 결과만으로 실제 한도를 넘으면(병렬 Read·작은 실제 창) 그 턴은 사실대로 끝나고 다음 턴들이 막히지 않는다 — 원문에 숫자가 있으면 줄인 결과를 이어받고, 없으면 main처럼 걷어낸다(러너 7종)', async () => {
  for (const [name, r] of Object.entries(RUNNERS)) {
    const ws = `tb11-${name}`; const root = await company(ws);
    // 카탈로그 창 200,000(엔진 추정) — 큰 Read 6개 병렬 결과 한 메시지(엔진 추정 약 12만, 벤더 셈 약 9.5만)는 사전 줄이기 기준(75%) 아래라 그대로 나가고,
    // 실제 한도 80,000에 거절된다. 최근 결과 메시지는 재시도에서 보호돼 줄일 것이 없다 → 재전송 없이 실패(1차 검수 HIGH 재현 모양).
    // 숫자 없는 문구(z.ai·Responses — glm·codex)는 이 턴에 받아 준 요청이 지시 하나뿐이라 확실히 들어간다고 말할 값이 없다 → 잇지 않는다(3차 검수 HIGH, main과 같다).
    const numeric = !['zai', 'responses'].includes(r.vendor);
    let mode = 'parallel';
    const par = parallelReader(r.wire, 6); const txt = parallelReader(r.wire, 0);
    const srv = await startStrictVendor({ vendor: r.vendor, reply: (b, n) => (mode === 'parallel' ? par(b, n) : txt(b, n)), contextLimit: 80_000 });
    try {
      const out = await run(ws, root, r, srv.base, { contextTokens: 200_000, prompt: '보고서 6개를 한 번에 읽어 줘' });
      const sid = out[0].session_id; const last = out.at(-1);
      assert.equal(last.subtype, 'error_during_execution', `${name}: 1턴은 사실대로 실패`);
      assert.match(last.errors[0], /^컨텍스트 한도 초과 — 요청이 모델 한도를 넘었다\. 더 줄일 도구 결과가 없어 다시 보내지 않았다/, `${name}: 다시 보내지 않았으면 그렇게 적는다 — ${last.errors[0].slice(0, 120)}`);
      // 새 대화의 첫 턴 — 실패 턴은 스레드에 세션 id가 남지 않아 앱에서는 다음 턴이 이어받지 못한다. '이어서 해 줘'를 약속하지 않는다(2차 검수 LOW)
      assert.doesNotMatch(last.errors[0], /이어서 해 줘|저장됨/, `${name}: 새 대화의 첫 턴은 이어받기를 약속하지 않는다`);
      assert.equal(srv.calls.length, 2, `${name}: 재전송 없음(병렬 호출 1 + 거절 1)`);
      const saved = JSON.parse(await readFile(sessionFile(ws, 'crew'), 'utf8'));
      if (numeric) {
        assertWellFormed(saved.messages, `${name} 1턴 저장 전사`);
        assert.match(saved.messages.at(-1).content[0].text, /^\[작업 중단 — /, `${name}: 꼬리는 중단 기록`);
        const results = saved.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b.type === 'tool_result');
        assert.equal(results.length, 6, `${name}: 끝난 결과 6개(짝 유지)`);
        for (const b of results) {
          assert.match(String(b.content), SQUEEZED, `${name}: 저장 전에 이번 단계 결과까지 줄였다(그대로 저장하면 다음 턴마다 넘친다)`);
          assert.ok(String(b.content).split('\n…(')[0].length <= 200, `${name}: 저장 전 줄이기는 앞 200자까지만 남긴다(HARD_HEAD_CHARS — ${String(b.content).split('\n…(')[0].length}자)`);
        }
      } else {
        assert.equal(saved.messages.at(-1).role, 'user', `${name}: 숫자 없는 문구 — 중단 기록을 붙이지 않는다(다음 턴 재개 정리가 이 턴을 걷어낸다)`);
        assert.match(last.errors[0], /이번 진행분은 다음 턴에 싣지 않는다/, `${name}: 잇지 않는다고 적는다`);
      }
      mode = 'text';
      for (const p of ['그건 됐고 오늘 날짜만 알려 줘', '인사만 해 줘']) {
        const n0 = srv.calls.length;
        const o = await run(ws, root, r, srv.base, { contextTokens: 200_000, resume: sid, prompt: p });
        assert.equal(o.at(-1).subtype, 'success', `${name}: '${p}' 턴 성공 — ${JSON.stringify(o.at(-1).errors ?? o.at(-1).error?.message ?? '').slice(0, 200)}`);
        assert.equal(srv.calls.slice(n0).filter((c) => c.rejected).length, 0, `${name}: '${p}' 턴은 거절 0`);
        assert.equal(doneReads(r.wire, srv.calls[n0].body), numeric ? 6 : 0, numeric ? `${name}: 끝난 결과 6개를 이어받는다(재개 정리가 걷어내지 않는다)` : `${name}: 실패한 턴은 싣지 않는다(main과 같다)`);
      }
    } finally { await srv.close(); }
  }
});

test('TB11b. 이미 넘친 결과를 그대로 저장한 세션도 풀린다 — 재시도 줄이기는 이번 턴 지시 뒤의 결과만 최근으로 보호한다', async () => {
  const ws = 'tb11b'; const root = await company(ws);
  const big = await readFile(join(root, 'big0.txt'), 'utf8');
  const body = big.split('\n').map((l, i) => `${i + 1}\t${l}`).join('\n').slice(0, 60_000);
  const ids = Array.from({ length: 6 }, (_, i) => `old${i}`);
  // 수정 전(PR 5786a8a2)이 남긴 모양: 지시 → 병렬 Read 6개 → 줄이지 않은 결과 6개(한 메시지) → 중단 기록
  await saveNativeSession(ws, 'crew', { id: 'stale-1', messages: [
    { role: 'user', content: '보고서 6개를 한 번에 읽어 줘' },
    { role: 'assistant', content: ids.map((id, i) => ({ type: 'tool_use', id, name: 'Read', input: { file_path: `big${i}.txt` } })) },
    { role: 'user', content: ids.map((id) => ({ type: 'tool_result', tool_use_id: id, content: body })) },
    { role: 'assistant', content: [{ type: 'text', text: '[작업 중단 — 요청이 모델의 컨텍스트 한도를 넘어 이 단계에서 멈췄다.]' }] },
  ] });
  const srv = await startStrictVendor({ vendor: 'xai', reply: parallelReader('messages', 0), contextLimit: 80_000 });
  try {
    const o2 = await run(ws, root, RUNNERS.grok, srv.base, { contextTokens: 200_000, resume: 'stale-1', prompt: '그건 됐고 오늘 날짜만 알려 줘' });
    assert.equal(o2.at(-1).subtype, 'success', `막히지 않는다 — ${JSON.stringify(o2.at(-1).errors ?? o2.at(-1).error?.message ?? '').slice(0, 200)}`);
    assert.equal(srv.calls.filter((c) => c.rejected).length, 1, '앞 턴의 큰 결과로 한 번 거절된 뒤');
    assert.ok(srv.calls[1].tokens < srv.calls[0].tokens * 0.2, '앞 턴의 결과를 줄여 다시 보냈다');
    const n0 = srv.calls.length;
    const o3 = await run(ws, root, RUNNERS.grok, srv.base, { contextTokens: 200_000, resume: 'stale-1', prompt: '인사만 해 줘' });
    assert.equal(o3.at(-1).subtype, 'success');
    assert.equal(srv.calls.slice(n0).filter((c) => c.rejected).length, 0, '줄인 전사가 저장돼 다음 턴은 거절 0');
  } finally { await srv.close(); }
});

test('TB12. 줄이는 순서·자리표시 — 읽기 도구 결과를 먼저 "다시 실행해 읽어라"로, 위임·셸·쓰기·MCP 결과는 그 뒤에만 "다시 하지 마라"로 줄인다', async () => {
  const { squeezeToolResults, RERUNNABLE_TOOLS } = await import('../src/engine/turn-budget.mjs');
  const { estimateTokens } = await import('../src/engine/compact.mjs');
  const big = (c) => c.repeat(30_000);
  const step = (id, name, text) => [{ role: 'assistant', content: [{ type: 'tool_use', id, name, input: {} }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] }];
  const msgs = [{ role: 'user', content: '동료에게 맡기고 자료도 읽어 줘' },
    ...step('d1', 'mcp__crew__delegate', big('동')), ...step('b1', 'Bash', big('b')), ...step('r1', 'Read', big('r')), ...step('w1', 'WebFetch', big('w')),
    ...step('m1', 'mcp__mail__send', big('m')), ...step('last', 'Read', big('z'))];
  const text = (r, id) => String(r.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).find((b) => b.tool_use_id === id).content);
  const RERUN = /필요하면 도구를 다시 실행해 읽어라\)$/; const NORERUN = /이 도구는 이미 실행됐다 — 같은 호출을 다시 하지 마라\)$/;
  // 읽기 결과 둘(r1·w1)만 줄이면 목표에 닿는다 — 더 오래된 위임(d1)·셸(b1)은 그대로
  const two = squeezeToolResults(msgs, { target: estimateTokens(msgs) - 15_000, keepRecent: 1 }); // 읽기 결과 하나 ≈ 1만 토큰
  assert.equal(two.squeezed, 2, '읽기 결과 둘');
  assert.match(text(two, 'r1'), RERUN); assert.match(text(two, 'w1'), RERUN);
  for (const id of ['d1', 'b1', 'm1', 'last']) assert.equal(text(two, id).length, 30_000, `${id}는 그대로(읽기 결과를 먼저 줄인다)`);
  // 목표가 빠듯하면 나머지도 줄이되 다시 실행하지 말라고 적는다(delegate를 다시 부르면 동료 턴이 또 돈다)
  const all = squeezeToolResults(msgs, { target: 1, keepRecent: 1 });
  assert.equal(all.squeezed, 5);
  for (const id of ['d1', 'b1', 'm1']) { assert.match(text(all, id), NORERUN, `${id}: 다시 하지 마라`); assert.doesNotMatch(text(all, id), /다시 실행해 읽어라/); }
  assert.match(text(all, 'r1'), RERUN);
  assert.equal(text(all, 'last').length, 30_000, '최근 1개는 그대로');
  assert.match(text(all, 'd1'), /^동{1000}\n/, '앞부분은 남긴다');
  // en·다시 줄이기 — 원래 길이·문구 유지
  const en = squeezeToolResults(all.messages, { target: 1, keepRecent: 1, head: 0, lang: 'en' });
  assert.match(text(en, 'd1'), /^…\(This tool result was shortened because the conversation grew long — originally 30000 chars\. The tool already ran — do not call it again\.\)$/);
  assert.match(text(en, 'r1'), /originally 30000 chars\. Run the tool again if you need it\.\)$/);
  // 이름을 모르는 결과(짝 tool_use 없음)는 다시 실행하라고 하지 않는다
  const orphan = squeezeToolResults([{ role: 'user', content: 'x' }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'gone', content: big('o') }] }], { target: 1, keepRecent: 0 });
  assert.match(text(orphan, 'gone'), NORERUN);
  for (const t of ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'browser_snapshot', 'browser_screenshot', 'computer_screenshot']) assert.ok(RERUNNABLE_TOOLS.has(t), t);
  for (const t of ['Write', 'Edit', 'Bash', 'browser_click', 'browser_type', 'browser_navigate', 'browser_eval', 'computer_click', 'mcp__crew__delegate']) assert.ok(!RERUNNABLE_TOOLS.has(t), t);
});

test('TB13. 사전 줄이기 기준선(창의 75%) — 벤더가 우리 추정(바이트/3)보다 26% 많이 세는 내용(해시·압축 JSON)도 실제 한도 = 카탈로그 창이면 거절 없이 끝난다', async () => {
  const ws = 'tb13'; const root = await company(ws);
  for (let f = 0; f < 14; f++) await writeFile(join(root, `big${f}.txt`), Array.from({ length: 2000 }, (_, i) => `${String(i).padStart(4, '0')} ${createHash('sha256').update(`${f}:${i}`).digest('hex')}`).join('\n'));
  // 벤더 셈 = 글자당 0.42토큰(엔진 추정 0.333의 1.26배). 75%에서 줄이면 보내는 요청이 한도의 75% × 1.26 ≈ 95%를 넘지 않는다 — 기준선을 95%로 올리면 넘는다.
  const srv = await startStrictVendor({ vendor: 'xai', reply: reader('messages', 14), contextLimit: 200_000, countTokens: (raw) => Math.ceil(raw.length * 0.42) });
  try {
    const out = await run(ws, root, RUNNERS.grok, srv.base, { contextTokens: 200_000 });
    assert.equal(out.at(-1).subtype, 'success', JSON.stringify(out.at(-1).errors ?? '').slice(0, 200));
    assert.equal(srv.calls.filter((c) => c.rejected).length, 0, `거절 0 — 최대 ${Math.max(...srv.calls.map((c) => c.tokens))}토큰`);
    assert.ok(srv.calls.some((c) => SQUEEZED.test(JSON.stringify(c.body))), '줄이기가 일어났다');
  } finally { await srv.close(); }
});

test('TB14. 다시 보낸 요청도 거절되면 그 거절로 창을 한 번 더 낮춰 저장 전 줄이기의 목표로 쓴다 — 다음 턴은 거절 없이 시작한다(숫자 없는 z.ai 문구)', async () => {
  const ws = 'tb14'; const root = await company(ws);
  // 3번째 호출까지 통과(큰 Read 3개) → 4번째 거절(줄여 재전송) → 재전송도 한도 10,000에 거절 → 실패·저장. 다음 턴도 한도 10,000.
  // 첫 거절만으로 낮춘 창(≈ 첫 요청 크기)의 절반은 재전송 크기보다 커서 저장 전 줄이기가 아무것도 줄이지 않는다 — 최근 결과가 그대로 저장돼 다음 턴 첫 호출이 또 거절된다.
  const srv = await startStrictVendor({ vendor: 'zai', reply: reader('messages', 3), contextLimit: (n) => (n <= 3 ? null : n === 4 ? 1 : 10_000) });
  try {
    const out = await run(ws, root, RUNNERS.glm, srv.base, { contextTokens: 1_000_000 });
    const sid = out[0].session_id; const last = out.at(-1);
    assert.equal(last.subtype, 'error_during_execution');
    assert.match(last.errors[0], /^컨텍스트 한도 초과 — 오래된 도구 결과를 줄여 한 번 다시 보냈지만/, '다시 보냈으면 그렇게 적는다');
    assert.equal(srv.calls.length, 5, '통과 3 + 거절 + 재전송 거절');
    const n0 = srv.calls.length;
    const o2 = await run(ws, root, RUNNERS.glm, srv.base, { contextTokens: 1_000_000, resume: sid, prompt: '이어서 해 줘' });
    assert.equal(o2.at(-1).subtype, 'success', JSON.stringify(o2.at(-1).errors ?? o2.at(-1).error?.message ?? '').slice(0, 200));
    assert.equal(srv.calls.slice(n0).filter((c) => c.rejected).length, 0, `다음 턴은 거절 0 — 첫 요청 ${srv.calls[n0].tokens}토큰`);
    assert.equal(doneReads('messages', srv.calls[n0].body), 3, '끝난 결과 3개를 이어받는다');
  } finally { await srv.close(); }
});

/** 단계마다 큰 Write를 부르는 가짜 모델(와이어별) — 도구 '입력'이 크고 결과('Wrote N bytes …')는 짧은 턴. 줄일 도구 결과가 없다. */
function writer(wire, content) {
  return (body, n) => {
    const file = `out${n}.md`;
    if (wire === 'gemini') {
      return { status: 200, type: 'application/json', body: JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'Write', args: { file_path: file, content } } }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 }, responseId: `g${n}` }) };
    }
    if (wire === 'responses') {
      const ev = { type: 'response.completed', response: { id: `resp_${n}`, model: body.model, status: 'completed', output: [{ type: 'function_call', call_id: `call_${n}`, name: 'Write', arguments: JSON.stringify({ file_path: file, content }) }], usage: { input_tokens: 10, output_tokens: 5 } } };
      return { status: 200, type: 'text/event-stream', body: `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n` };
    }
    return { id: `m${n}`, type: 'message', role: 'assistant', model: body.model, content: [{ type: 'tool_use', id: `tu${n}`, name: 'Write', input: { file_path: file, content } }], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 5 } };
  };
}

test('TB15. 줄일 수 없는 내용(도구 입력)만으로 한도를 넘기면 중단 기록을 붙이지 않는다 — 다음 턴은 main처럼 그 턴을 걷어내고 성공한다(러너 7종, 2차 검수 HIGH)', async () => {
  // 큰 Write(입력 약 1.2만 자)를 단계마다 부르는 턴 — 결과는 짧아 줄일 것이 없다. 벤더 한도 20,000에 6번째 무렵 호출이 거절된다.
  // 88048be1은 줄이지 못한 전사에 중단 기록을 붙여 저장해, 다음 턴부터 1단계에서 매번 거절되고 저장 없이 던져 대화가 영구히 막혔다.
  const big = Array.from({ length: 240 }, (_, i) => `${String(i).padStart(4, '0')} quarterly revenue line with region totals`).join('\n');
  for (const [name, r] of Object.entries(RUNNERS)) {
    const ws = `tb15-${name}`; const root = await company(ws);
    await saveNativeSession(ws, 'crew', PRIOR('tb15-prev')); // 이어 오던 대화 — 앞 대화는 그대로 남아야 한다
    let mode = 'write';
    const w = writer(r.wire, big); const txt = parallelReader(r.wire, 0);
    const srv = await startStrictVendor({ vendor: r.vendor, reply: (b, n) => (mode === 'write' ? w(b, n) : txt(b, n)), contextLimit: 20_000 });
    try {
      const out = await run(ws, root, r, srv.base, { contextTokens: 128_000, resume: 'tb15-prev', prompt: '보고서 파일을 여러 개 써 줘' });
      const last = out.at(-1);
      assert.equal(last.subtype, 'error_during_execution', `${name}: 1턴은 사실대로 실패 — ${JSON.stringify(last.errors ?? last.error?.message ?? '').slice(0, 200)}`);
      assert.equal(srv.calls.filter((c) => c.rejected).length, 1, `${name}: 거절 1번(줄일 결과가 없어 재전송 없음)`);
      assert.doesNotMatch(last.errors[0], /이어서 해 줘/, `${name}: 이어받지 못하는 진행분을 이어 간다고 약속하지 않는다`);
      assert.match(last.errors[0], /도구 결과를 줄여도 한도 안에 들어가지 않아 이번 진행분은 다음 턴에 싣지 않는다/, `${name}: 사실을 적는다 — ${last.errors[0].slice(0, 160)}`);
      const saved = JSON.parse(await readFile(sessionFile(ws, 'crew'), 'utf8'));
      assert.equal(saved.messages.at(-1).role, 'user', `${name}: 중단 기록을 붙이지 않는다(꼬리는 도구 결과 — 다음 턴 재개 정리가 이 턴을 걷어낸다)`);
      assert.ok(!saved.messages.some((m) => m.role === 'assistant' && /^\[작업 중단 — /.test(m.content?.[0]?.text ?? '')), `${name}: 중단 기록 없음`);
      mode = 'text';
      for (const p of ['그건 됐고 오늘 날짜만 알려 줘', '인사만 해 줘']) {
        const n0 = srv.calls.length;
        const o = await run(ws, root, r, srv.base, { contextTokens: 128_000, resume: 'tb15-prev', prompt: p });
        assert.equal(o.at(-1).subtype, 'success', `${name}: '${p}' 턴 성공 — ${JSON.stringify(o.at(-1).errors ?? o.at(-1).error?.message ?? '').slice(0, 200)}`);
        assert.equal(srv.calls.slice(n0).filter((c) => c.rejected).length, 0, `${name}: '${p}' 턴은 거절 0(첫 요청 ${srv.calls[n0].tokens}토큰)`);
        assert.equal(doneReads(r.wire, srv.calls[n0].body), 0, `${name}: 실패한 턴의 쓰기 단계는 싣지 않는다(main과 같다)`);
        assert.match(JSON.stringify(srv.calls[n0].body), /앞 대화 답/, `${name}: 앞 대화는 그대로 이어받는다`);
      }
    } finally { await srv.close(); }
  }
});

test('TB16. en 회사 — 중단 기록·실패 원문은 영어다(이어 온 세션이면 "continue"로 이어 간다고, 잇지 않으면 그 사실을 적는다)', async () => {
  const ws = 'tb16'; const root = await company(ws);
  await saveNativeSession(ws, 'crew', PRIOR('tb16-prev'));
  const srv = await startStrictVendor({ vendor: 'xai', reply: reader('messages', 14), contextLimit: (n) => (n >= 3 ? 1 : null) });
  try {
    const out = await run(ws, root, RUNNERS.grok, srv.base, { contextTokens: 1_000_000, resume: 'tb16-prev', lang: 'en', prompt: 'Read the report files one by one' });
    const last = out.at(-1);
    assert.equal(last.subtype, 'error_during_execution');
    assert.match(last.errors[0], /^Context limit exceeded — resent once after shortening old tool results/);
    assert.match(last.errors[0], /\(completed steps are saved — send "continue" to resume\)/);
    assert.doesNotMatch(last.errors[0], /[가-힣]/, '한국어가 섞이지 않는다');
    const saved = JSON.parse(await readFile(sessionFile(ws, 'crew'), 'utf8'));
    assert.match(saved.messages.at(-1).content[0].text, /^\[Stopped — /, '저장 꼬리는 영어 중단 기록');
    assert.match(String(saved.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).find((b) => b.type === 'tool_result').content), /This tool result was shortened/, '자리표시도 영어');
  } finally { await srv.close(); }
  // 잇지 않는 갈래(TB15·TB18의 en)와 덧붙임 없는 갈래 — 문구만(순수)
  const { overflowErrorText } = await import('../src/engine/turn-budget.mjs');
  const dropped = overflowErrorText('raw', 'en', { dropped: true });
  assert.match(dropped, /^Context limit exceeded — the request exceeded the model limit; there were no more tool results to shorten, so it was not resent \(even with tool results shortened it does not fit the limit, so this progress is not carried into the next turn\): raw$/);
  assert.equal(overflowErrorText('raw', 'en', {}), 'Context limit exceeded — the request exceeded the model limit; there were no more tool results to shorten, so it was not resent: raw');
});

test('TB17. 사용량(usage)을 주지 않는 벤더에서 2단계 이후 길이 초과 — 던지지 않고 실패 result로 끝내 진행분과 중단 기록을 저장한다', async () => {
  const ws = 'tb17'; const root = await company(ws);
  await saveNativeSession(ws, 'crew', PRIOR('tb17-prev'));
  const read = reader('messages', 14);
  const srv = await startStrictVendor({ vendor: 'xai', reply: (b, n) => { const r = read(b, n); delete r.usage; return r; }, contextLimit: (n) => (n >= 3 ? 1 : null) });
  try {
    const out = await run(ws, root, RUNNERS.grok, srv.base, { contextTokens: 1_000_000, resume: 'tb17-prev' });
    const last = out.at(-1);
    assert.equal(last.type, 'result', `던지지 않는다(1단계가 아니다 — 사용량이 0이어도) — ${last.error?.message?.slice(0, 120) ?? ''}`);
    assert.equal(last.subtype, 'error_during_execution');
    assert.equal(last.num_turns, 3);
    const saved = JSON.parse(await readFile(sessionFile(ws, 'crew'), 'utf8'));
    assert.match(saved.messages.at(-1).content[0].text, /^\[작업 중단 — /, '중단 기록으로 꼬리를 닫아 저장');
    assert.equal(saved.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b.type === 'tool_result').length, 2, '끝난 결과 2개');
  } finally { await srv.close(); }
});

test('TB18. 줄인 전사가 이 턴에 받아 준 가장 큰 요청의 75%를 넘으면(다음 지시가 붙을 자리가 없으면) 잇지 않는다 — 넘치지 않는 쪽(main과 같은 걷어내기)을 고른다', async () => {
  // 큰 Write(입력 약 24만 자 — 줄일 수 없다) → Read → Read. 3번째 호출(Write + Read 하나)까지 통과, 4번째부터 무조건 거절(한도 1토큰).
  // 저장 전 줄이기로 읽기 결과 둘을 줄여도 전사는 Write 입력이 대부분이라 받아 준 가장 큰 요청의 약 80% — 중단 기록을 붙여 이으면 다음 지시를 더할 자리가
  // 25%보다 적다(이어받은 다음 턴의 첫 호출이 한도에 걸리면 줄일 것이 없어 저장 없이 던지고, 그 뒤 턴들도 같은 자리에서 막힌다).
  const ws = 'tb18'; const root = await company(ws);
  await saveNativeSession(ws, 'crew', PRIOR('tb18-prev'));
  const huge = Array.from({ length: 4800 }, (_, i) => `${String(i).padStart(4, '0')} quarterly revenue line with region totals`).join('\n');
  const reply = (body, n) => {
    const k = doneReads('messages', body); // 끝난 도구 결과 수(Write 결과 포함)
    const use = k === 0 ? { type: 'tool_use', id: `tu${n}`, name: 'Write', input: { file_path: 'out.md', content: huge } }
      : k <= 2 ? { type: 'tool_use', id: `tu${n}`, name: 'Read', input: { file_path: `big${k}.txt` } } : null;
    return { id: `m${n}`, type: 'message', role: 'assistant', model: body.model, content: use ? [use] : [{ type: 'text', text: '끝' }], stop_reason: use ? 'tool_use' : 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } };
  };
  const srv = await startStrictVendor({ vendor: 'xai', reply, contextLimit: (n) => (n >= 4 ? 1 : null) });
  try {
    const out = await run(ws, root, RUNNERS.grok, srv.base, { contextTokens: 1_000_000, resume: 'tb18-prev', prompt: '보고서를 쓰고 자료 두 개를 읽어 줘' });
    const last = out.at(-1);
    assert.equal(last.subtype, 'error_during_execution');
    assert.equal(srv.calls.length, 5, '통과 3 + 거절 + 재전송 거절');
    assert.match(last.errors[0], /이번 진행분은 다음 턴에 싣지 않는다/, last.errors[0].slice(0, 200));
    const saved = JSON.parse(await readFile(sessionFile(ws, 'crew'), 'utf8'));
    assert.equal(saved.messages.at(-1).role, 'user', '중단 기록을 붙이지 않는다(다음 턴 재개 정리가 이 턴을 걷어낸다)');
    const loaded = await loadNativeSession(ws, 'crew', 'tb18-prev');
    assert.equal(loaded.messages.length, 2, '다음 턴은 앞 대화부터 잇는다(main과 같다)');
  } finally { await srv.close(); }
});

// 숫자 없는 길이 초과 문구(z.ai 'Prompt too long'·Responses 'exceeds the context window') — 3차 검수 HIGH. 거절 지점은 한도의 위쪽 끝일 뿐이다.
const NN_LINE = (i) => `${i}: 매출 보고서 항목 — quarterly revenue line ${i} 지역별 합계와 비고를 적는다 notes`;
const NN_RUNNERS = { glm: RUNNERS.glm, codex: RUNNERS.codex };
/** 큰 Write를 단계마다 부르다가 요청이 thresh(벤더 셈)를 넘은 다음 단계에서 [Write, 큰 Read]를 한 번에 부르는 가짜 모델(messages·responses 와이어). mode()가 'text'면 답한다. */
function writeThenRead(wire, { content, thresh, srv, mode }) {
  let crossed = false;
  return (body, n) => {
    const tokens = srv().calls.at(-1).tokens;
    let uses = [];
    if (mode() === 'write' && !crossed) {
      uses = [{ name: 'Write', input: { file_path: `out${n}.md`, content } }];
      if (tokens >= thresh) { crossed = true; uses.push({ name: 'Read', input: { file_path: 'nn-big.txt' } }); }
    }
    if (wire === 'responses') {
      const output = uses.length ? uses.map((u, i) => ({ type: 'function_call', call_id: `call_${n}_${i}`, name: u.name, arguments: JSON.stringify(u.input) })) : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '답' }] }];
      const ev = { type: 'response.completed', response: { id: `resp_${n}`, model: body.model, status: 'completed', output, usage: { input_tokens: 10, output_tokens: 5 } } };
      return { status: 200, type: 'text/event-stream', body: `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n` };
    }
    const c = uses.length ? uses.map((u, i) => ({ type: 'tool_use', id: `tu${n}_${i}`, ...u })) : [{ type: 'text', text: '답' }];
    return { id: `m${n}`, type: 'message', role: 'assistant', model: body.model, content: c, stop_reason: uses.length ? 'tool_use' : 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } };
  };
}

test('TB19. 숫자 없는 거절 문구 — 확실한 값(받아 준 요청)으로만 들어가는지 재서, 쓰기 위주 턴은 잇지 않고 다음 턴이 거절 없이 성공한다(glm·codex, 카탈로그 창 > 실제 한도, 3차 검수 HIGH)', async () => {
  // 큰 Write 반복(입력 약 9천 자) → 요청이 16,000(벤더 셈)을 넘은 다음 단계에서 [Write, 큰 Read] → 실제 한도 20,000에 거절. 카탈로그 창은 128,000.
  // 57b66a57은 숫자가 없으면 거절된 요청 크기를 창으로 보고 그 75%를 '들어간다'의 기준으로 써서, 실제 한도를 넘는 전사에 중단 기록을 붙였다 → 다음 턴마다 1단계 거절.
  const content = Array.from({ length: 150 }, (_, i) => NN_LINE(i)).join('\n');
  for (const [name, r] of Object.entries(NN_RUNNERS)) {
    const ws = `tb19-${name}`; const root = await company(ws);
    await writeFile(join(root, 'nn-big.txt'), Array.from({ length: 600 }, (_, i) => NN_LINE(i)).join('\n'));
    await saveNativeSession(ws, 'crew', PRIOR('tb19-prev'));
    let mode = 'write'; let srv;
    const reply = writeThenRead(r.wire, { content, thresh: 16_000, srv: () => srv, mode: () => mode });
    srv = await startStrictVendor({ vendor: r.vendor, reply, contextLimit: 20_000 });
    try {
      const out = await run(ws, root, r, srv.base, { contextTokens: 128_000, resume: 'tb19-prev', prompt: '보고서 파일을 여러 개 쓰고 nn-big.txt도 읽어 줘' });
      const last = out.at(-1);
      assert.equal(last.subtype, 'error_during_execution', `${name}: 1턴은 사실대로 실패 — ${JSON.stringify(last.errors ?? last.error?.message ?? '').slice(0, 200)}`);
      const saved = JSON.parse(await readFile(sessionFile(ws, 'crew'), 'utf8'));
      assert.equal(saved.messages.at(-1).role, 'user', `${name}: 실제 한도를 넘는 전사에 중단 기록을 붙이지 않는다(받아 준 요청의 75%를 넘는다)`);
      assert.match(last.errors[0], /이번 진행분은 다음 턴에 싣지 않는다/, `${name}: ${last.errors[0].slice(0, 160)}`);
      assert.doesNotMatch(last.errors[0], /이어서 해 줘/);
      mode = 'text';
      for (const p of ['이어서 해 줘', '그건 됐고 인사만 해 줘']) {
        const n0 = srv.calls.length;
        const o = await run(ws, root, r, srv.base, { contextTokens: 128_000, resume: 'tb19-prev', prompt: p });
        assert.equal(o.at(-1).subtype, 'success', `${name}: '${p}' 턴 성공 — ${JSON.stringify(o.at(-1).errors ?? o.at(-1).error?.message ?? '').slice(0, 200)}`);
        assert.equal(srv.calls.slice(n0).filter((c) => c.rejected).length, 0, `${name}: '${p}' 턴은 거절 0(안전망에 기대지 않는다 — 첫 요청 ${srv.calls[n0].tokens}토큰)`);
        assert.equal(doneReads(r.wire, srv.calls[n0].body), 0, `${name}: 실패한 턴은 싣지 않는다(main과 같다)`);
      }
    } finally { await srv.close(); }
  }
});

test('TB20. 안전망 — 다음 턴 1단계가 길이 초과로 거절되고 줄일 것이 없는데 앞 턴이 중단 기록으로 끝났으면, 그 턴을 걷어내고(main의 꼬리 정리와 같은 결과) 1번만 다시 보낸다', async () => {
  // 어떤 추정이 틀려도(벤더 셈·창 환산) 중단 기록을 붙여 저장한 전사가 다음 턴을 영구히 막지 않게 하는 마지막 방어. 저장 전사를 직접 만든다:
  // 앞 대화 → 큰 Write(입력 약 9천 자 — 줄일 수 없다) 4번 → 중단 기록. 한도 6,000(벤더 셈)이면 이 전사만으로 넘친다.
  const content = Array.from({ length: 150 }, (_, i) => NN_LINE(i)).join('\n');
  const { overflowStopNote } = await import('../src/engine/turn-budget.mjs');
  const stale = (id, lang = 'ko') => ({ id, messages: [...PRIOR(id).messages, { role: 'user', content: '보고서 4개를 써 줘' },
    ...[0, 1, 2, 3].flatMap((i) => [{ role: 'assistant', content: [{ type: 'tool_use', id: `w${i}`, name: 'Write', input: { file_path: `out${i}.md`, content } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: `w${i}`, content: `Wrote ${content.length} bytes` }] }]),
    { role: 'assistant', content: [{ type: 'text', text: overflowStopNote(lang) }] }] });
  for (const [name, r] of Object.entries({ grok: RUNNERS.grok, glm: RUNNERS.glm })) {
    const ws = `tb20-${name}`; const root = await company(ws);
    await saveNativeSession(ws, 'crew', stale('tb20-prev'));
    const srv = await startStrictVendor({ vendor: r.vendor, reply: parallelReader(r.wire, 0), contextLimit: 6_000 });
    try {
      const o = await run(ws, root, r, srv.base, { contextTokens: 128_000, resume: 'tb20-prev', prompt: '이어서 해 줘' });
      assert.equal(o.at(-1).subtype, 'success', `${name}: 막히지 않는다 — ${JSON.stringify(o.at(-1).errors ?? o.at(-1).error?.message ?? '').slice(0, 200)}`);
      assert.equal(srv.calls.length, 2, `${name}: 거절 1 + 걷어내고 다시 보냄 1(줄일 도구 결과가 없어 줄여 다시 보내기는 없다)`);
      assert.equal(srv.calls[0].rejected, 'context');
      const resentMsgs = JSON.stringify(srv.calls[1].body.messages ?? srv.calls[1].body.contents);
      assert.doesNotMatch(resentMsgs, /"Write"|작업 중단|보고서 4개를 써 줘/, `${name}: 다시 보낸 요청에는 멈춘 턴(지시·쓰기·중단 기록)이 없다`);
      assert.match(resentMsgs, /앞 대화 답/, `${name}: 앞 대화는 그대로`);
      const saved = JSON.parse(await readFile(sessionFile(ws, 'crew'), 'utf8'));
      assert.equal(saved.messages.length, 4, `${name}: 저장 전사 = 앞 대화 2 + 이번 지시·답 2(멈춘 턴은 걷어냈다)`);
      const n0 = srv.calls.length;
      const o2 = await run(ws, root, r, srv.base, { contextTokens: 128_000, resume: 'tb20-prev', prompt: '인사만 해 줘' });
      assert.equal(o2.at(-1).subtype, 'success');
      assert.equal(srv.calls.slice(n0).filter((c) => c.rejected).length, 0, `${name}: 그다음 턴은 거절 0`);
    } finally { await srv.close(); }
  }
  // 걷어내고 다시 보내도 넘치면(앞 대화만으로도 넘침) 사실대로 알린다 — 다시 보내기는 1번뿐, 세션 파일은 그대로
  const ws = 'tb20-fail'; const root = await company(ws);
  await saveNativeSession(ws, 'crew', stale('tb20-fail', 'en'));
  const before = await readFile(sessionFile(ws, 'crew'), 'utf8');
  const srv = await startStrictVendor({ vendor: 'zai', reply: parallelReader('messages', 0), contextLimit: 1 });
  try {
    const o = await run(ws, root, RUNNERS.glm, srv.base, { contextTokens: 128_000, resume: 'tb20-fail', prompt: 'continue' });
    const t = o.at(-1);
    assert.equal(t.type, 'thrown');
    assert.match(t.error.message, /^컨텍스트 한도 초과 — 앞 턴의 멈춘 진행분을 빼고 한 번 다시 보냈지만 모델 한도를 넘었다: /, t.error.message.slice(0, 160));
    assert.equal(classifyRunnerError(t.error.message).code, 'context_exceeded');
    assert.equal(srv.calls.length, 2, '거절 + 걷어내고 다시 보냄 1번(더 보내지 않는다)');
    assert.equal(await readFile(sessionFile(ws, 'crew'), 'utf8'), before, '1단계 실패는 저장하지 않는다(종전 그대로)');
  } finally { await srv.close(); }
});

test('TB18b. 들어가는지 잴 때 system 프롬프트·도구 정의와 중단 기록까지 센다 — 큰 system 프롬프트가 있으면 같은 진행분도 여유(25%) 밖이면 잇지 않는다(3차 검수 LOW)', async () => {
  // 큰 Read 2번 뒤 3번째 호출부터 무조건 거절(한도 1토큰) — 원문 숫자로 환산한 창은 거의 0이라 기준은 '받아 준 가장 큰 요청(2번째 호출)'의 75%다.
  // 1회차: system 프롬프트 3만 토큰 — 줄인 전사가 들어간다(중단 기록으로 이음). 저장 전사로 엔진과 같은 추정을 다시 해 남은 여유(margin)와 중단 기록 크기(note)를 잰다.
  // 2회차: system 프롬프트를 Δ = 4 × (margin + note/2)토큰 늘린다 — 받아 준 요청과 저장 전사가 같이 Δ씩 커져 여유가 −note/2가 된다:
  // system·도구 정의를 빼고 재거나(V15) 중단 기록을 빼고 재면(V14) 들어간다고 잘못 판정해 중단 기록을 붙인다.
  const { estimateTokens } = await import('../src/engine/compact.mjs');
  const turn = async (ws, sys) => {
    const root = await company(ws);
    const srv = await startStrictVendor({ vendor: 'xai', reply: reader('messages', 14), contextLimit: (n) => (n >= 3 ? 1 : null) });
    try {
      const out = await collect(nativeQuery({ wsId: ws, slug: 'crew', prompt: '보고서 파일을 차례로 읽어 줘', cwd: root, systemPrompt: sys, env: RUNNERS.grok.env(srv.base), model: 'm-fake', browser: false, contextTokens: 1_000_000 }));
      assert.equal(out.at(-1).subtype, 'error_during_execution');
      assert.equal(srv.calls.length, 4, '통과 2 + 거절 + 재전송 거절');
      const b = srv.calls[1].body; // 받아 준 가장 큰 요청
      const fixed = estimateTokens(b.system) + estimateTokens(b.tools);
      return { out, ok: fixed + estimateTokens(b.messages), fixed, saved: JSON.parse(await readFile(sessionFile(ws, 'crew'), 'utf8')) };
    } finally { await srv.close(); }
  };
  const sys1 = `SYS${'x'.repeat(90_000)}`; // 3의 배수 — 추정(바이트/3)이 정확히 3만 1토큰
  const r1 = await turn('tb18b-1', sys1);
  assert.match(r1.saved.messages.at(-1).content[0].text, /^\[작업 중단 — /, '1회차는 들어간다(중단 기록으로 잇는다)');
  const closed = r1.fixed + estimateTokens(r1.saved.messages);
  const note = estimateTokens(r1.saved.messages) - estimateTokens(r1.saved.messages.slice(0, -1));
  const margin = 0.75 * r1.ok - closed;
  assert.ok(margin >= 0 && note > 50, `여유 ${margin}·중단 기록 ${note}토큰`);
  const delta = Math.ceil(4 * (margin + note / 2));
  const r2 = await turn('tb18b-2', `${sys1}${'x'.repeat(3 * delta)}`);
  assert.equal(r2.saved.messages.at(-1).role, 'user', `2회차는 잇지 않는다 — 여유 ${0.75 * r2.ok - (r2.fixed + estimateTokens(r2.saved.messages) + note)}토큰(중단 기록 포함 추정)`);
  assert.match(r2.out.at(-1).errors[0], /이번 진행분은 다음 턴에 싣지 않는다/);
});
