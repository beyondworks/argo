// Gemini API 키 러너 → Argo 엔진(네이티브) — 와이어 변환(순수)·가짜 Gemini 서버 실루프·오류 승격·자격 축 분기·원샷·숨김 해제. 실벤더 호출 0.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { mkdtemp } from './helpers/tmp.mjs';

process.env.HOME = await mkdtemp(join(tmpdir(), 'argo-gem-home-'));
process.env.USERPROFILE = process.env.HOME;
process.env.ARGO_ROOT = join(await mkdtemp(join(tmpdir(), 'argo-gem-')), 'workspaces'); await mkdir(process.env.ARGO_ROOT, { recursive: true });
process.env.ARGO_MODEL_CATALOG = 'off';
delete process.env.ARGO_NATIVE_RUNNERS;
const ROOT = fileURLToPath(new URL('..', import.meta.url));

const { toGeminiRequest, fromGeminiResponse, cleanSchema, callGemini, GEMINI_DEFAULT_BASE } = await import('../src/engine/gemini-wire.mjs');
const { authFromEnv, callMessages } = await import('../src/engine/messages-http.mjs');
const { nativeQuery, NATIVE_DEFAULT_RUNNERS, nativeRunnerEnabled } = await import('../src/engine/native-query.mjs');
const { isCliTurn, GEMINI_DEFAULT_MODEL, RUNNER_AUTH, isHiddenRunner } = await import('../src/runners/catalog.mjs');
const { createCompany, paths } = await import('../src/workspace.mjs');
const { saveRunnerCred, runnerCredEnv, runnerCredType } = await import('../src/runners/creds.mjs');
const { makePermissionGate } = await import('../src/permission-gate.mjs');

async function fakeGemini(script) {
  const calls = [];
  const srv = createServer((req, res) => {
    let d = ''; req.on('data', (c) => { d += c; });
    req.on('end', () => {
      calls.push({ url: req.url, headers: req.headers, body: JSON.parse(d || '{}') });
      const step = script[Math.min(calls.length - 1, script.length - 1)];
      const out = typeof step === 'function' ? step(calls.at(-1), calls.length) : step;
      res.writeHead(out.status ?? 200, { 'content-type': 'application/json' }); res.end(JSON.stringify(out.json ?? out));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${srv.address().port}`, calls, close: () => new Promise((r) => srv.close(r)) };
}
const gemText = (text, extra = {}) => ({ candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 3 }, ...extra });
const gemCall = (name, args) => ({ candidates: [{ content: { role: 'model', parts: [{ text: '읽어볼게요' }, { functionCall: { name, args } }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 4 } });

test('G1. 요청 변환(순수) — system→systemInstruction, 역할·연속 병합, tool_use→functionCall, tool_result→functionResponse(이름 역추적)+이미지 파트, 스키마 정리', () => {
  const req = toGeminiRequest({
    system: 'SYS', max_tokens: 123,
    tools: [{ name: 'Read', description: 'read', input_schema: { $schema: 'x', type: 'object', additionalProperties: false, properties: { file_path: { type: ['string', 'null'], default: '', pattern: '.*' }, n: { type: 'integer', minimum: 1 } }, required: ['file_path'] } },
      { name: 'browser_snapshot', description: 'snap', input_schema: { type: 'object', properties: {} } }],
    messages: [
      { role: 'user', content: '첫 지시' }, { role: 'user', content: [{ type: 'text', text: '이어서' }] },
      { role: 'assistant', content: [{ type: 'text', text: '읽을게' }, { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: 'a.md' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'text', text: 'A' }, { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' } }] }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'nope', content: 'x', is_error: true }] },
    ],
  });
  assert.deepEqual(req.systemInstruction, { parts: [{ text: 'SYS' }] });
  assert.equal(req.generationConfig.maxOutputTokens, 123);
  assert.deepEqual(req.contents.map((c) => c.role), ['user', 'model', 'user'], '같은 역할 연속은 한 항목으로');
  assert.deepEqual(req.contents[0].parts, [{ text: '첫 지시' }, { text: '이어서' }]);
  assert.deepEqual(req.contents[1].parts[1], { functionCall: { name: 'Read', args: { file_path: 'a.md' } } });
  assert.deepEqual(req.contents[2].parts[0], { functionResponse: { name: 'Read', response: { result: 'A' } } });
  assert.deepEqual(req.contents[2].parts[1], { inlineData: { mimeType: 'image/jpeg', data: 'QUJD' } }, '도구 결과의 이미지는 옆 파트로');
  assert.deepEqual(req.contents[2].parts[2], { functionResponse: { name: 'tool', response: { result: 'x', error: true } } }, '짝 없는 결과는 이름 폴백');
  const decl = req.tools[0].functionDeclarations;
  assert.deepEqual(decl[0].parameters, { type: 'object', properties: { file_path: { type: 'string', nullable: true }, n: { type: 'integer', minimum: 1 } }, required: ['file_path'] }, '$schema·additionalProperties·default·pattern 제거, null 타입은 nullable');
  assert.equal('parameters' in decl[1], false, '빈 properties는 parameters 생략(거절 방지)');
  assert.deepEqual(cleanSchema({ type: 'array', items: { type: 'object', properties: {}, title: 't' } }), { type: 'array', items: { type: 'object' } });
});

test('G2. 응답 변환(순수) — text+functionCall→tool_use(id 생성)·stop_reason, MAX_TOKENS, thought 파트 제거, usage, 후보 없음은 400 오류', () => {
  const r = fromGeminiResponse({ candidates: [{ content: { parts: [{ text: 'a' }, { thought: true, text: '생각' }, { functionCall: { name: 'Read', args: { file_path: 'x' } } }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 }, modelVersion: 'gemini-2.5-pro-001' }, 'gemini-2.5-pro');
  assert.equal(r.role, 'assistant'); assert.equal(r.stop_reason, 'tool_use'); assert.equal(r.model, 'gemini-2.5-pro-001');
  assert.deepEqual(r.content.map((b) => b.type), ['text', 'tool_use'], 'thought 파트는 버린다');
  assert.ok(r.content[1].id.startsWith('gem_') && r.content[1].name === 'Read'); assert.deepEqual(r.content[1].input, { file_path: 'x' });
  assert.deepEqual(r.usage, { input_tokens: 5, output_tokens: 2 });
  assert.equal(fromGeminiResponse({ candidates: [{ content: { parts: [{ text: 'cut' }] }, finishReason: 'MAX_TOKENS' }] }, 'm').stop_reason, 'max_tokens');
  assert.throws(() => fromGeminiResponse({ promptFeedback: { blockReason: 'SAFETY' } }, 'm'), /API Error: 400 .*SAFETY/);
});

test('G3. authFromEnv — ARGO_WIRE=gemini면 wire·기본 base·x-goog-api-key, 키 없으면 no_credential; Messages env는 wire=messages', () => {
  const a = authFromEnv({ ARGO_WIRE: 'gemini', GEMINI_API_KEY: 'k1' });
  assert.deepEqual(a, { wire: 'gemini', base: GEMINI_DEFAULT_BASE, headers: { 'x-goog-api-key': 'k1' } });
  assert.equal(authFromEnv({ ARGO_WIRE: 'gemini', GEMINI_API_KEY: 'k', GEMINI_BASE_URL: 'http://x/v1beta/' }).base, 'http://x/v1beta');
  assert.throws(() => authFromEnv({ ARGO_WIRE: 'gemini' }), (e) => e.code === 'no_credential');
  assert.equal(authFromEnv({ ANTHROPIC_BASE_URL: 'http://a', ANTHROPIC_API_KEY: 'k' }).wire, 'messages');
});

test('G4. 실루프 — 가짜 Gemini 서버: 도구 광고(functionDeclarations)·functionCall→내장 Read 실행(게이트 통과)→functionResponse 회신→최종 텍스트, URL·헤더·usage', async () => {
  const ws = 'gem1'; await createCompany(ws, '제미니', '사장'); const root = paths(ws).root;
  await mkdir(join(root, 'vault'), { recursive: true }); await writeFile(join(root, 'vault', 'facts.md'), 'GEMINI-CANARY line\n');
  const srv = await fakeGemini([gemCall('Read', { file_path: 'vault/facts.md' }), gemText('facts에 GEMINI-CANARY가 있습니다')]);
  try {
    const out = []; let init = null;
    for await (const ev of nativeQuery({ wsId: ws, slug: 's', prompt: 'facts 읽어', cwd: root, systemPrompt: 'SYS', model: 'gemini-2.5-pro', saveSession: false,
      env: { ARGO_WIRE: 'gemini', GEMINI_API_KEY: 'test-key', GEMINI_BASE_URL: srv.base }, canUseTool: makePermissionGate(ws, 's', root, null, 'ko', []) })) { out.push(ev); if (ev.type === 'system') init = ev; }
    const result = out.at(-1);
    assert.equal(result.type, 'result'); assert.equal(result.subtype, 'success'); assert.match(result.result, /GEMINI-CANARY/);
    assert.equal(srv.calls.length, 2);
    assert.equal(srv.calls[0].url, '/models/gemini-2.5-pro:generateContent'); assert.equal(srv.calls[0].headers['x-goog-api-key'], 'test-key');
    assert.equal(srv.calls[0].body.systemInstruction.parts[0].text.startsWith('SYS'), true);
    const names = srv.calls[0].body.tools[0].functionDeclarations.map((d) => d.name);
    assert.ok(names.includes('Read') && names.includes('browser_navigate') && !names.some((n) => n.startsWith('computer_')), `도구 광고: ${names.length}개, 컴퓨터 유즈는 옵트인`);
    assert.ok(init.tools.includes('Read'));
    const fr = srv.calls[1].body.contents.at(-1).parts.find((p) => p.functionResponse);
    assert.equal(fr.functionResponse.name, 'Read'); assert.match(fr.functionResponse.response.result, /GEMINI-CANARY/);
    assert.equal(srv.calls[1].body.contents.at(-2).role, 'model', '직전 모델 턴(functionCall)이 전사에 남는다');
    assert.deepEqual(result.usage, { input_tokens: 20, output_tokens: 7, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });
  } finally { await srv.close(); }
});

test('G5. 오류 — 400 API_KEY_INVALID는 401로 승격(인증 분류기가 문다), 429는 원문 그대로, 5xx는 1회 재시도 뒤 성공', async () => {
  const srv = await fakeGemini([{ status: 400, json: { error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] } } }]);
  try { await assert.rejects(callGemini({ base: srv.base, headers: {}, body: { model: 'm', max_tokens: 10, messages: [{ role: 'user', content: 'x' }] } }), (e) => e.status === 401 && /API Error: 401 API key not valid/.test(e.message)); } finally { await srv.close(); }
  const srv2 = await fakeGemini([{ status: 429, json: { error: { code: 429, message: 'Resource has been exhausted (e.g. check quota).', status: 'RESOURCE_EXHAUSTED' } } }]);
  try { await assert.rejects(callMessages({ wire: 'gemini', base: srv2.base, headers: {}, body: { model: 'm', max_tokens: 10, messages: [{ role: 'user', content: 'x' }] } }), /API Error: 429 Resource has been exhausted/); } finally { await srv2.close(); }
  const srv3 = await fakeGemini([{ status: 503, json: { error: { message: 'overloaded' } } }, gemText('ok')]);
  try { const r = await callMessages({ wire: 'gemini', base: srv3.base, headers: {}, body: { model: 'm', max_tokens: 10, messages: [{ role: 'user', content: 'x' }] }, retry: 1 }); assert.equal(r.content[0].text, 'ok'); assert.equal(srv3.calls.length, 2); } finally { await srv3.close(); }
});

test('G6. 자격 축 분기 — gemini API 키는 네이티브(ARGO_WIRE env, CLI 아님), 구독·host는 CLI, ARGO_NATIVE_RUNNERS=none이면 API 키도 CLI 폴백', async () => {
  assert.ok(NATIVE_DEFAULT_RUNNERS.includes('gemini')); assert.equal(nativeRunnerEnabled('gemini', {}), true);
  assert.equal(isCliTurn('gemini', 'apikey'), false); assert.equal(isCliTurn('gemini', 'oauth'), true); assert.equal(isCliTurn('gemini', 'host'), true);
  assert.equal(isCliTurn('codex', 'apikey'), true); assert.equal(isCliTurn('openrouter', 'apikey'), false);
  const ws = 'gem2'; await createCompany(ws, '제미니2', '사장'); await saveRunnerCred(ws, 'gemini', 'apikey', 'fake-gemini-key-000000');
  assert.equal(await runnerCredType(ws, 'gemini'), 'apikey');
  const env = await runnerCredEnv(ws, 'gemini');
  assert.equal(env.env.ARGO_WIRE, 'gemini'); assert.equal(env.env.GEMINI_API_KEY, 'fake-gemini-key-000000'); assert.equal(env.env.GEMINI_BASE_URL, GEMINI_DEFAULT_BASE); assert.equal(env.authType, 'apikey');
  process.env.ARGO_NATIVE_RUNNERS = 'none';
  try { assert.equal(isCliTurn('gemini', 'apikey'), true, '옵트아웃이면 종전 CLI'); const e2 = await runnerCredEnv(ws, 'gemini'); assert.equal(e2.env.ARGO_WIRE, undefined, 'CLI env(격리 HOME)로'); assert.ok(e2.home, 'geminiTurnHome'); }
  finally { delete process.env.ARGO_NATIVE_RUNNERS; }
  assert.equal(isHiddenRunner('gemini'), false); assert.deepEqual(RUNNER_AUTH.gemini.methods, ['apikey']); assert.equal(GEMINI_DEFAULT_MODEL, 'gemini-2.5-pro');
});

test('G7. 원샷 — gemini API 키 회사의 runOneShot이 가짜 Gemini 서버로 나가고(도구 없음) 텍스트를 돌려준다', async () => {
  const { runOneShot } = await import('../src/oneshot.mjs');
  const ws = 'gem3'; await createCompany(ws, '제미니3', '사장'); await saveRunnerCred(ws, 'gemini', 'apikey', 'fake-gemini-key-111111');
  const srv = await fakeGemini([gemText('직함: 항해사')]);
  process.env.GEMINI_BASE_URL = srv.base;
  try {
    const r = await runOneShot(ws, '직함을 추천해', { timeoutMs: 20_000 });
    assert.equal(r.runner, 'gemini'); assert.match(r.text, /항해사/); assert.equal(srv.calls.length, 1);
    assert.equal('tools' in srv.calls[0].body, false, '원샷은 도구 없음'); assert.equal(srv.calls[0].url, `/models/${GEMINI_DEFAULT_MODEL}:generateContent`);
  } finally { await srv.close(); delete process.env.GEMINI_BASE_URL; }
});

test('G8. 배선 핀 — chat·oneshot·스케줄러·카드 정보가 자격 축 판정(isCliTurn)을 쓴다', async () => {
  const chat = await readFile(join(ROOT, 'src', 'chat.mjs'), 'utf8');
  assert.match(chat, /const cliTurn = isCliTurn\(runner, await runnerCredType\(wsId, runner\)\);\n\s*if \(cliTurn\) \{/);
  assert.match(chat, /runner === 'gemini' \? \(effModel \|\| GEMINI_DEFAULT_MODEL\)/);
  const one = await readFile(join(ROOT, 'src', 'oneshot.mjs'), 'utf8');
  assert.match(one, /if \(isCliTurn\(runner, await runnerCredType\(wsId, runner\)\)\) \{/); assert.match(one, /runner === 'gemini' \? \(effectiveModels\('gemini'\)/);
  const sch = await readFile(join(ROOT, 'src', 'scheduler.mjs'), 'utf8');
  assert.match(sch, /hasTools = !isCliTurn\(resolved\.runner, await runnerCredType\(cid, resolved\.runner\)\);/);
  const fac = await readFile(join(ROOT, 'src', 'runners.mjs'), 'utf8');
  assert.match(fac, /cli: isCliTurn\(id, cred\?\.type \?\? meta\.methods\?\.\[0\]\),/, '미연결 카드는 첫 연결 방식 기준(gemini=apikey → 네이티브)');
  assert.equal((chat.match(/isCliRunner\(runner\)/g) ?? []).length >= 1, true, 'commonDirectives의 CLI 문구 분기는 runner 미전달 경로(네이티브)에선 false');
});
