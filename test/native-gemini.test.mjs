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

const { toGeminiRequest, fromGeminiResponse, cleanSchema, callGemini, GEMINI_DEFAULT_BASE, GEMINI_MIN_OUTPUT_TOKENS } = await import('../src/engine/gemini-wire.mjs');
const { authFromEnv, callMessages, stripForeignBlocks } = await import('../src/engine/messages-http.mjs');
const { extractErrorMessage } = await import('../src/engine/http-errors.mjs');
const { shellEnv } = await import('../src/engine/builtin-tools.mjs');
const { sessionFile } = await import('../src/engine/session.mjs');
const { scrubServerSecrets } = await import('../src/runners/shared.mjs');
const { nativeQuery, NATIVE_DEFAULT_RUNNERS, nativeRunnerEnabled } = await import('../src/engine/native-query.mjs');
const { isCliTurn, GEMINI_DEFAULT_MODEL, RUNNER_AUTH, isHiddenRunner, pickRunner, autoRunnerOf } = await import('../src/runners/catalog.mjs');
const { createCompany, paths } = await import('../src/workspace.mjs');
const { saveRunnerCred, runnerCredEnv, runnerCredType, verifyRunnerCred } = await import('../src/runners/creds.mjs');
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
  assert.equal(req.generationConfig.maxOutputTokens, GEMINI_MIN_OUTPUT_TOKENS, '사고 토큰이 상한에 포함되므로 하한을 둔다(H4)'); assert.equal(toGeminiRequest({ messages: [], max_tokens: 40_000 }).generationConfig.maxOutputTokens, 40_000, '더 큰 상한은 그대로');
  assert.deepEqual(req.contents.map((c) => c.role), ['user', 'model', 'user'], '같은 역할 연속은 한 항목으로');
  assert.deepEqual(req.contents[0].parts, [{ text: '첫 지시' }, { text: '이어서' }]);
  assert.deepEqual(req.contents[1].parts[1], { functionCall: { id: 'tu1', name: 'Read', args: { file_path: 'a.md' } } }, 'gem_ 접두가 아닌 id는 벤더 id로 보존(M3)');
  assert.deepEqual(req.contents[2].parts[0], { functionResponse: { id: 'tu1', name: 'Read', response: { result: 'A' }, parts: [{ inlineData: { mimeType: 'image/jpeg', data: 'QUJD' } }] } }, '도구 결과의 이미지는 FunctionResponse.parts(멀티모달 함수 응답 — M4)');
  assert.equal(req.contents[2].parts.length, 2, '형제 inlineData 파트 없음(함수 응답 파트 수 = 호출 수)');
  assert.deepEqual(req.contents[2].parts[1], { functionResponse: { id: 'nope', name: 'tool', response: { result: 'x', error: true } } }, '짝 없는 결과는 이름 폴백');
  const own = toGeminiRequest({ messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'gem_abc_1', name: 'Read', input: {} }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'gem_abc_1', content: 'r' }] }] });
  assert.equal('id' in own.contents[0].parts[0].functionCall, false, '우리가 만든 gem_ id는 벤더에 보내지 않는다'); assert.equal('id' in own.contents[1].parts[0].functionResponse, false);
  const decl = req.tools[0].functionDeclarations;
  assert.deepEqual(decl[0].parameters, { type: 'object', properties: { file_path: { type: 'string', default: '', pattern: '.*', nullable: true }, n: { type: 'integer', minimum: 1 } }, required: ['file_path'] }, '$schema·additionalProperties 제거, 공식 필드(default·pattern) 보존, null 타입은 nullable');
  assert.equal('parameters' in decl[1], false, '빈 properties는 parameters 생략(거절 방지)');
  assert.deepEqual(cleanSchema({ type: 'array', items: { type: 'object', properties: {}, title: 't' } }), { type: 'array', items: { type: 'object', title: 't' } }, 'title은 공식 필드, 빈 properties는 제거');
});

test('G2. 응답 변환(순수) — text+functionCall→tool_use(id 생성)·stop_reason, MAX_TOKENS, thought 파트 보존(gem_thought), usage(+사고 토큰), 후보 없음은 400 오류', () => {
  const r = fromGeminiResponse({ candidates: [{ content: { parts: [{ text: 'a' }, { thought: true, text: '생각' }, { functionCall: { name: 'Read', args: { file_path: 'x' } } }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 }, modelVersion: 'gemini-2.5-pro-001' }, 'gemini-2.5-pro');
  assert.equal(r.role, 'assistant'); assert.equal(r.stop_reason, 'tool_use'); assert.equal(r.model, 'gemini-2.5-pro-001');
  assert.deepEqual(r.content.map((b) => b.type), ['text', 'gem_thought', 'tool_use'], 'thought 파트는 gem_thought 블록으로 보존(표시·도구 실행은 type으로 거른다)');
  assert.ok(r.content[2].id.startsWith('gem_') && r.content[2].name === 'Read'); assert.deepEqual(r.content[2].input, { file_path: 'x' });
  assert.deepEqual(r.usage, { input_tokens: 5, output_tokens: 2 });
  assert.deepEqual(fromGeminiResponse({ candidates: [{ content: { parts: [{ text: 'a' }] } }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 9, thoughtsTokenCount: 1500 } }, 'm').usage, { input_tokens: 5, output_tokens: 1509 }, '사고 토큰도 출력 과금(M5)');
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
  assert.match(one, /if \(isCliTurn\(runner, await runnerCredType\(wsId, runner\)\)\) \{/); assert.match(one, /runner === 'gemini' \? \(known\(want\) \? want : GEMINI_DEFAULT_MODEL\)/); assert.match(one, /const known = \(id\) => !!id && effectiveModels\(runner\)\.some/, '오버레이 반영 목록(effectiveModels)으로 판정'); assert.match(one, /\n\s*await loadRemoteCatalog\(\{ timeoutMs: 2000 \}\)\.catch\(\(\) => null\);/, '네이티브/SDK 원샷은 러너 축으로 거르지 않고 오버레이를 로드한다(gemini API 키·codex 직결 포함)');
  const sch = await readFile(join(ROOT, 'src', 'scheduler.mjs'), 'utf8');
  assert.match(sch, /hasTools = !isCliTurn\(resolved\.runner, await runnerCredType\(cid, resolved\.runner\)\);/);
  const fac = await readFile(join(ROOT, 'src', 'runners.mjs'), 'utf8');
  assert.match(fac, /cli: isCliTurn\(id, credType\(cred\?\.type \?\? meta\.methods\?\.\[0\]\)\),/, '미연결 카드는 첫 연결 방식 기준(gemini=apikey → 네이티브), 저장 자격은 정규화 종류로(L2)');
  assert.equal((chat.match(/isCliRunner\(runner\)/g) ?? []).length >= 1, true, 'commonDirectives의 CLI 문구 분기는 runner 미전달 경로(네이티브)에선 false');
});

const gemSafety = (finishReason, parts = []) => ({ candidates: [{ content: { role: 'model', parts }, finishReason }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 0 } });
const st = (o) => Object.fromEntries(Object.entries(o).map(([id, type]) => [id, { company: type ? { connected: true, type } : { connected: false } }]));

test('G9. 자동 선택의 자격 축(H1)·제공되지 않는 방식은 무효 표시(2R MEDIUM-1) — gemini oauth·host만 연결된 회사의 자동 크루는 gemini로 가지 않는다(죽은 CLI 경로), API 키면 간다; host 가능 러너(claude)는 종전대로', async () => {
  assert.equal(pickRunner(st({ gemini: 'oauth', glm: 'apikey' }), null).runner, 'glm', 'oauth gemini는 자동 대상이 아니다(Google이 구독의 외부 앱 사용을 막았다)');
  assert.equal(pickRunner(st({ gemini: 'host', glm: 'apikey' }), null).runner, 'glm');
  assert.equal(pickRunner(st({ gemini: 'apikey', glm: 'apikey' }), null).runner, 'gemini', 'API 키 gemini는 네이티브 — 자동 대상');
  assert.equal(autoRunnerOf(st({ gemini: 'oauth' })), null, 'oauth gemini뿐이면 자동 러너 없음');
  assert.deepEqual(pickRunner(st({ gemini: 'oauth' }), 'gemini'), { runner: 'gemini', fellBack: false, available: true }, 'pickRunner 수준에서 명시 지정은 자격 종류를 묻지 않는다(무효 표지는 runnerStatus가 단다 — available까지 단언, 2R MEDIUM-2)');
  // 실 상태(runnerStatus)에서는 제공되지 않는 방식(oauth)이 무효로 표시돼 배너·명판·자동 선택·턴이 한목소리(2R MEDIUM-1)
  const { runnerStatus } = await import('../src/runners.mjs'); const { anyRunnerUsable, usableRunnerNames, runnerNeedsReconnect } = await import('../app/runner-usable.mjs');
  const wsO = 'gem-oauth'; await createCompany(wsO, '구독', '사장');
  await writeFile(join(paths(wsO).root, '.secrets.json'), JSON.stringify({ runners: { gemini: { type: 'oauth', value: JSON.stringify({ access_token: 'fake-oauth-json' }) } } })); // saveRunnerCred는 oauth 저장 시 CLI 조달(npm)을 켠다 — 테스트는 파일 직접 기록(3R L-3)
  const stO = await runnerStatus(wsO);
  assert.equal(stO.gemini.company.invalid, true); assert.equal(stO.gemini.company.unsupportedMethod, true);
  assert.equal(anyRunnerUsable(stO), false, '온보딩 게이트·배너: 가용 없음'); assert.deepEqual(usableRunnerNames(stO), [], '명판에 Gemini 없음'); assert.equal(runnerNeedsReconnect(stO), true, '"끊김" 안내 분기'); assert.equal(autoRunnerOf(stO), null);
  // 턴 문구(3R M-2): "하나도 연결돼 있지 않습니다"는 거짓 — chat·oneshot 두 갈래 모두 API 키 재연결 안내
  const { unsupportedMethodStatus, unsupportedMethodNotice } = await import('../src/runners/catalog.mjs'); assert.deepEqual(unsupportedMethodStatus(stO), [{ id: 'gemini', type: 'oauth' }]); assert.deepEqual(unsupportedMethodStatus({ ...stO, glm: { company: { connected: true, type: 'apikey' } } }), [], '가용 러너가 있으면 해당 없음');
  const en = unsupportedMethodNotice('en', [{ id: 'gemini', type: 'oauth' }]);
  assert.match(en, /stored Gemini connection method \(subscription login\) is no longer offered — reconnect Gemini with API key/); assert.ok(!/[가-힣]/.test(en), '영어 갈래에 한국어 없음(4R LOW-3)'); assert.ok(!/another runner \([^)]*Gemini/.test(en), '"다른 러너" 목록에 자기 자신 없음');
  assert.match(unsupportedMethodNotice('ko', [{ id: 'gemini', type: 'host' }]), /Gemini 연결 방식\(이 컴퓨터 로그인\)은 더 이상 제공되지 않습니다 — 설정 → AI 연결에서 Gemini를 API 키로 다시 연결하세요/);
  assert.match(unsupportedMethodNotice('ko', [{ id: 'antigravity', type: 'apikey' }]), /Antigravity 연결 방식\(API 키\)은 더 이상 제공되지 않습니다 — 설정 → AI 연결에서 Antigravity를 구독 로그인·이 컴퓨터 로그인으로 다시 연결하세요/, '저장 방식·제공 방식은 러너별 파생(4R LOW-1 — 하드코딩은 antigravity에서 정반대)');
  assert.ok(!/다른 러너\([^)]*Gemini/.test(unsupportedMethodNotice('ko', [{ id: 'gemini', type: 'oauth' }])));
  const rootO = paths(wsO).root; for (const d of [['agents'], ['chats'], ['vault', 'journal'], ['vault', 'projects'], ['vault', 'files'], ['vault', 'notes']]) await mkdir(join(rootO, ...d), { recursive: true });
  await writeFile(join(rootO, 'agents', 'auto.md'), '---\nname: 자동\n---\n\n전문가.\n'); await writeFile(join(rootO, 'agents', 'gem.md'), '---\nname: 지정\nrunner: gemini\n---\n\n전문가.\n');
  const { chat } = await import('../src/chat.mjs'); const { runOneShot } = await import('../src/oneshot.mjs');
  for (const slug of ['auto', 'gem']) await assert.rejects(chat(wsO, slug, '안녕'), (e) => /Gemini 연결 방식\(구독 로그인\)은 더 이상 제공되지 않습니다/.test(e.message) && /API 키로 다시 연결/.test(e.message) && !/하나도 연결돼/.test(e.message), `chat(${slug})`);
  await assert.rejects(runOneShot(wsO, '직함'), (e) => /더 이상 제공되지 않습니다/.test(e.message) && !/하나도 연결돼/.test(e.message), 'oneshot');
  // host 축(4R MEDIUM-1): gemini host 마커만 있는 회사도 같은 정직 문구 — hostUsable:false는 "제공되지 않는 방식"(환경 제한 hostOptInAllowed는 invalid만)
  const wsH = 'gem-host'; await createCompany(wsH, '호스트', '사장'); const rootH = paths(wsH).root;
  await writeFile(join(rootH, '.secrets.json'), JSON.stringify({ runners: { gemini: { type: 'host', value: 'host-marker' } } }));
  for (const d of [['agents'], ['chats'], ['vault', 'journal'], ['vault', 'projects'], ['vault', 'files'], ['vault', 'notes']]) await mkdir(join(rootH, ...d), { recursive: true });
  await writeFile(join(rootH, 'agents', 'auto.md'), '---\nname: 자동\n---\n\n전문가.\n');
  const stH = await runnerStatus(wsH); assert.equal(stH.gemini.company.invalid, true); assert.equal(stH.gemini.company.unsupportedMethod, true); assert.deepEqual(unsupportedMethodStatus(stH), [{ id: 'gemini', type: 'host' }]);
  await assert.rejects(chat(wsH, 'auto', '안녕'), (e) => /Gemini 연결 방식\(이 컴퓨터 로그인\)은 더 이상 제공되지 않습니다/.test(e.message) && !/하나도 연결돼/.test(e.message), 'chat(host)');
  // 환경 제한(hostOptInAllowed: standalone claude·테넌트)은 invalid만 — "제공되지 않는 방식"으로 오표기하면 막힌 방식을 다시 권하게 된다(5R LOW-2 게이트: !meta.hostUsable → !hostOptInAllowed 변이 red)
  const wsE = 'claude-host-env'; await createCompany(wsE, '환경', '사장');
  await writeFile(join(paths(wsE).root, '.secrets.json'), JSON.stringify({ runners: { claude: { type: 'host', value: 'host-marker' }, codex: { type: 'host', value: 'host-marker' } } }));
  const prevStandalone = process.env.ARGO_STANDALONE; const prevTenant = process.env.ARGO_TENANT_OWNER;
  process.env.ARGO_STANDALONE = '1'; process.env.ARGO_TENANT_OWNER = 'tenant-owner-x';
  try {
    const stE = await runnerStatus(wsE);
    for (const id of ['claude', 'codex']) { assert.equal(stE[id].company.invalid, true, `${id} host는 환경 제한으로 무효`); assert.equal(stE[id].company.unsupportedMethod, undefined, `${id} host는 제공되는 방식 — unsupportedMethod 없음`); }
    assert.deepEqual(unsupportedMethodStatus(stE), [], '환경 제한 회사는 "제공 종료" 안내가 아니라 재연결 안내');
  } finally { if (prevStandalone === undefined) delete process.env.ARGO_STANDALONE; else process.env.ARGO_STANDALONE = prevStandalone; if (prevTenant === undefined) delete process.env.ARGO_TENANT_OWNER; else process.env.ARGO_TENANT_OWNER = prevTenant; }
  const { invalidChipKey } = await import('../app/runner-usable.mjs');
  assert.equal(invalidChipKey(stH.gemini.company), 'settings.runners.companyUnsupported'); assert.equal(invalidChipKey({ connected: true, invalid: true }), 'settings.runners.companyInvalid');
  assert.match(await readFile(join(ROOT, 'app', 'runner-connect.jsx'), 'utf8'), /<span className="dot" \/>\{t\(invalidChipKey\(company\)\)\}/, '카드 칩이 순수 키 선택을 쓴다(4R LOW-2)');
  await saveRunnerCred(wsO, 'gemini', 'apikey', 'fake-gemini-key-ok');
  const stK = await runnerStatus(wsO); assert.equal(stK.gemini.company.invalid, undefined); assert.deepEqual(usableRunnerNames(stK), ['Gemini']); assert.equal(autoRunnerOf(stK), 'gemini');
  assert.equal(pickRunner(st({ claude: 'host', glm: 'apikey' }), null).runner, 'claude', 'host 옵트인 러너는 종전대로 자동 대상(회귀 0)');
  assert.equal(pickRunner(st({ codex: 'oauth' }), null).runner, 'codex');
  assert.equal(pickRunner(st({ gemini: 'oauth', glm: 'apikey' }), null, null, { defaultRunner: 'gemini' }).runner, 'glm', '회사 기본 러너도 자격 축을 지킨다');
});

test('G10. 스키마 정리(H2) — MCP형 $ref/$defs·anyOf null·oneOf·const·정수 enum·type 없음이 전부 type 또는 anyOf를 가진 노드로 정리된다(불변식 워커)', () => {
  const mcp = { type: 'object', $defs: { Mode: { type: 'string', enum: ['fast', 'slow'], description: '모드' }, Box: { type: 'object', properties: { w: { type: 'integer' } }, required: ['w'] } },
    properties: {
      mode: { $ref: '#/$defs/Mode' }, limit: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }], default: 10, description: '상한' },
      kind: { oneOf: [{ type: 'string' }, { type: 'number' }] }, fixed: { const: 'v1' }, level: { type: 'integer', enum: [1, 2, 3], description: '레벨' }, flag: { type: 'boolean', enum: [true, false] }, seven: { const: 7 }, any: {}, nul: { type: 'null' },
      body: { allOf: [{ $ref: '#/components/schemas/OrderInput' }] }, body2: { type: 'object', allOf: [null, 'x', { $ref: '#/nope' }] },
      box: { $ref: '#/$defs/Box' }, list: { type: 'array', items: { $ref: '#/$defs/Box' } }, both: { allOf: [{ $ref: '#/$defs/Box' }, { properties: { h: { type: 'integer' } }, required: ['h'] }] },
      tuple: { type: 'array', items: [{ type: 'string' }] },
    }, required: ['mode', 'ghost'], additionalProperties: false, $schema: 'http://json-schema.org/draft-07/schema#' };
  const out = cleanSchema(mcp);
  const bad = []; const walk = (n, path) => { if (!n || typeof n !== 'object') return; if (!n.type && !Array.isArray(n.anyOf)) bad.push(path); for (const [k, v] of Object.entries(n.properties ?? {})) walk(v, `${path}.${k}`); if (n.items) walk(n.items, `${path}[]`); for (const [i, a] of (n.anyOf ?? []).entries()) walk(a, `${path}|${i}`); if ('$ref' in n || '$defs' in n || 'oneOf' in n || 'allOf' in n || 'const' in n || '__null' in n) bad.push(`${path}:foreign`); };
  walk(out, '$');
  assert.deepEqual(bad, [], 'type 없는 노드·JSON Schema 전용 키가 남지 않는다');
  assert.deepEqual(out.properties.mode, { type: 'string', enum: ['fast', 'slow'], description: '모드' }, '$ref 인라인');
  assert.deepEqual(out.properties.limit, { type: 'integer', minimum: 1, default: 10, description: '상한', nullable: true }, 'anyOf [X, null] → X + nullable, 부모 description 보존');
  assert.deepEqual(out.properties.kind, { anyOf: [{ type: 'string' }, { type: 'number' }] }, 'oneOf → anyOf');
  assert.deepEqual(out.properties.fixed, { type: 'string', enum: ['v1'] }, 'const → enum');
  assert.deepEqual(out.properties.level, { type: 'integer', description: '레벨 (allowed values: 1, 2, 3)' }, '비문자 enum은 원 타입 유지 + 설명 힌트(2R LOW-1 — 문자열 강등은 도구 인자 타입을 깬다)');
  assert.deepEqual(out.properties.flag, { type: 'boolean', description: '(allowed values: true, false)' }); assert.deepEqual(out.properties.seven, { type: 'integer', description: '(allowed values: 7)' });
  assert.deepEqual(out.properties.body, { type: 'string' }, '해석 불가 allOf($ref 외부)는 죽지 않고 문자열로(2R HIGH-1 — TypeError로 턴 전멸하던 자리)'); assert.deepEqual(out.properties.body2, { type: 'object' });
  assert.doesNotThrow(() => cleanSchema({ allOf: [null] })); assert.doesNotThrow(() => cleanSchema({ allOf: ['x'] })); assert.doesNotThrow(() => cleanSchema({ allOf: [{ $ref: '#/components/schemas/X' }] }));
  assert.doesNotThrow(() => cleanSchema({ type: 'object', properties: { body: { allOf: [{ $ref: '#/$defs/Box' }], required: true } }, $defs: { Box: { type: 'object', properties: { w: { type: 'integer' } } } } }), 'Swagger 2.0 관례 required:true + allOf(3R M-1)');
  assert.doesNotThrow(() => cleanSchema({ required: { a: 1 }, allOf: [{}] })); assert.deepEqual(cleanSchema({ type: 'object', allOf: [{ required: { x: 1 }, properties: 'nope' }] }), { type: 'object' }, '비객체 properties는 문자 스프레드로 가짜 속성을 만들지 않는다');
  assert.deepEqual(cleanSchema({ type: 'object', properties: [{ type: 'string' }] }), { type: 'object' }, 'properties 배열은 속성이 아니다(4R INFO-2)');
  assert.deepEqual(cleanSchema({ type: 'string', description: { x: 1 }, format: 3, title: null, pattern: ['a'] }), { type: 'string' }, '문자열 필드는 문자열만(4R INFO-1)');
  // 임의 입력 무예외 — 시드 고정 퍼즈(모양 3개를 더하는 식으로는 이 계열이 잠기지 않는다 — 3R M-1)
  let seed = 20260906; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
  const junk = () => pick([null, undefined, 3, 'str', true, [], [1, 'a', null], {}, { a: 1 }, { $ref: '#/$defs/A' }, { $ref: '#/components/x' }]);
  const gen = (d = 0) => { if (d > 3 || rnd() < 0.15) return junk(); const o = {};
    for (const k of ['type', 'properties', 'required', 'items', 'allOf', 'anyOf', 'oneOf', 'enum', 'const', '$ref', 'default', 'nullable', 'description']) if (rnd() < 0.35) o[k] = k === 'type' ? pick(['object', 'array', 'string', 'integer', ['string', 'null'], 'null', 7, null]) : k === 'properties' ? (rnd() < 0.7 ? { p: gen(d + 1), q: gen(d + 1) } : junk()) : k === 'items' ? (rnd() < 0.7 ? gen(d + 1) : junk()) : /Of$/.test(k) ? (rnd() < 0.7 ? [gen(d + 1), junk(), gen(d + 1)] : junk()) : k === 'enum' ? pick([['a', 'b'], [1, 2], [null, 'x'], 'bad', []]) : k === '$ref' ? pick(['#/$defs/A', '#/$defs/B', '#/nope', 3]) : junk();
    if (rnd() < 0.3) o.$defs = { A: gen(d + 1), B: { type: 'object', properties: { z: gen(d + 1) } } }; return o; };
  const check = (n, path) => { if (!n || typeof n !== 'object') return `${path}: not object`; if (!n.type && !Array.isArray(n.anyOf)) return `${path}: no type`; for (const [k, v] of Object.entries(n.properties ?? {})) { const r = check(v, `${path}.${k}`); if (r) return r; } if (n.items) { const r = check(n.items, `${path}[]`); if (r) return r; } for (const [i, a] of (n.anyOf ?? []).entries()) { const r = check(a, `${path}|${i}`); if (r) return r; } return null; };
  for (let i = 0; i < 400; i++) { const input = gen(); const show = String(JSON.stringify(input)).slice(0, 200); let out; assert.doesNotThrow(() => { out = cleanSchema(input); }, `퍼즈 #${i}: ${show}`); const bad = check(out, '$'); assert.equal(bad, null, `퍼즈 #${i} 불변식: ${bad} ← ${show}`); }
  assert.deepEqual(out.properties.any, { type: 'string' }); assert.deepEqual(out.properties.nul, { type: 'string', nullable: true });
  assert.deepEqual(out.properties.box, { type: 'object', properties: { w: { type: 'integer' } }, required: ['w'] });
  assert.deepEqual(out.properties.list.items, { type: 'object', properties: { w: { type: 'integer' } }, required: ['w'] });
  assert.deepEqual(out.properties.both, { type: 'object', properties: { w: { type: 'integer' }, h: { type: 'integer' } }, required: ['w', 'h'] }, 'allOf 병합');
  assert.deepEqual(out.properties.tuple, { type: 'array', items: { type: 'string' } });
  assert.deepEqual(out.required, ['mode'], '없는 속성은 required에서 제거');
  assert.equal(JSON.stringify(cleanSchema({ $defs: { A: { $ref: '#/$defs/A' } }, type: 'object', properties: { a: { $ref: '#/$defs/A' } } })).includes('nested too deep'), true, '순환 $ref는 깊이 상한에서 끊는다');
});

test('G11. thoughtSignature 왕복(H3)·벤더 functionCall.id 보존(M3) — 응답의 서명·사고 파트가 블록에 남고 다음 요청의 같은 파트에 그대로 되붙는다(가짜 서버 2회차 실측), Anthropic 와이어에는 안 나간다', async () => {
  const r = fromGeminiResponse({ candidates: [{ content: { parts: [{ thought: true, text: '계획', thoughtSignature: 'SIG-T' }, { text: '둘 다 읽을게요', thoughtSignature: 'SIG-TEXT' }, { functionCall: { id: 'fc-1', name: 'Read', args: { file_path: 'a.md' } }, thoughtSignature: 'SIG-A' }, { functionCall: { id: 'fc-2', name: 'Read', args: { file_path: 'b.md' } } }] }, finishReason: 'STOP' }] }, 'm');
  assert.deepEqual(r.content.map((b) => [b.type, b._gemSig ?? null]), [['gem_thought', 'SIG-T'], ['text', 'SIG-TEXT'], ['tool_use', 'SIG-A'], ['tool_use', null]]);
  assert.deepEqual(r.content.slice(2).map((b) => b.id), ['fc-1', 'fc-2'], '벤더 id 보존');
  const req = toGeminiRequest({ messages: [{ role: 'user', content: '읽어' }, { role: 'assistant', content: r.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'fc-1', content: 'A' }, { type: 'tool_result', tool_use_id: 'fc-2', content: 'B' }] }] });
  assert.deepEqual(req.contents[1].parts, [{ thought: true, text: '계획', thoughtSignature: 'SIG-T' }, { text: '둘 다 읽을게요', thoughtSignature: 'SIG-TEXT' }, { functionCall: { id: 'fc-1', name: 'Read', args: { file_path: 'a.md' } }, thoughtSignature: 'SIG-A' }, { functionCall: { id: 'fc-2', name: 'Read', args: { file_path: 'b.md' } } }], '받은 그대로 되돌린다');
  assert.deepEqual(req.contents[2].parts.map((p) => p.functionResponse.id), ['fc-1', 'fc-2'], 'functionResponse.id로 짝 맞춤(같은 이름 병렬 호출 구분)');
  const anth = stripForeignBlocks([{ role: 'assistant', content: r.content }]);
  assert.deepEqual(anth[0].content.map((b) => b.type), ['text', 'tool_use', 'tool_use']); assert.ok(anth[0].content.every((b) => !('_gemSig' in b)), 'Anthropic 와이어엔 사이드채널 없음');
  const anthSrv = await fakeGemini([{ json: { id: 'm1', type: 'message', role: 'assistant', model: 'm', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } } }]);
  try {
    const res = await callMessages({ wire: 'messages', base: anthSrv.base, headers: {}, body: { model: 'm', max_tokens: 5, messages: [{ role: 'user', content: 'x' }, { role: 'assistant', content: r.content }, { role: 'user', content: 'y' }] } });
    assert.equal(res.content[0].text, 'ok'); const sent = JSON.stringify(anthSrv.calls[0].body);
    assert.ok(!sent.includes('gem_thought') && !sent.includes('_gemSig') && sent.includes('"fc-1"'), 'Messages 와이어 실호출에도 사이드채널이 안 나간다(블록 자체는 유지)');
  } finally { await anthSrv.close(); }
  // 실루프 — 2회차 요청에 서명이 붙어 나간다
  const ws = 'gem-sig'; await createCompany(ws, '서명', '사장'); const root = paths(ws).root; await mkdir(join(root, 'vault'), { recursive: true }); await writeFile(join(root, 'vault', 'a.md'), 'A\n');
  const srv = await fakeGemini([{ candidates: [{ content: { role: 'model', parts: [{ text: '읽을게요', thoughtSignature: 'SIG-1' }, { functionCall: { id: 'fc-9', name: 'Read', args: { file_path: 'vault/a.md' } }, thoughtSignature: 'SIG-2' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } }, gemText('끝')]);
  try {
    let last; for await (const ev of nativeQuery({ wsId: ws, slug: 's', prompt: '읽어', cwd: root, systemPrompt: 'SYS', model: 'gemini-2.5-pro', saveSession: false, env: { ARGO_WIRE: 'gemini', GEMINI_API_KEY: 'test-key', GEMINI_BASE_URL: srv.base }, canUseTool: makePermissionGate(ws, 's', root, null, 'ko', []) })) last = ev;
    assert.equal(last.subtype, 'success'); assert.equal(last.result, '끝');
    const model = srv.calls[1].body.contents.find((c) => c.role === 'model');
    assert.deepEqual(model.parts.map((p) => p.thoughtSignature ?? null), ['SIG-1', 'SIG-2']); assert.equal(model.parts[1].functionCall.id, 'fc-9');
    assert.equal(srv.calls[1].body.contents.at(-1).parts[0].functionResponse.id, 'fc-9');
  } finally { await srv.close(); }
});

test('G12. 빈 응답은 오류(H4) — SAFETY 파트 0·사고만 남은 MAX_TOKENS·빈 텍스트는 finishReason을 실은 오류로 던지고, 네이티브 턴은 조용한 성공("")이 아니라 실패한다', async () => {
  assert.throws(() => fromGeminiResponse(gemSafety('SAFETY'), 'm'), (e) => e.status === 400 && e.finishReason === 'SAFETY' && /finishReason=SAFETY/.test(e.message));
  assert.throws(() => fromGeminiResponse(gemSafety('MAX_TOKENS', [{ thought: true, text: '…' }]), 'm'), /finishReason=MAX_TOKENS — thinking consumed the output budget/);
  assert.throws(() => fromGeminiResponse(gemSafety('STOP', [{ text: '   ' }]), 'm'), /finishReason=STOP/);
  assert.throws(() => fromGeminiResponse({ candidates: [{ finishReason: 'PROHIBITED_CONTENT', finishMessage: 'blocked' }] }, 'm'), /PROHIBITED_CONTENT — blocked/);
  assert.equal(fromGeminiResponse(gemSafety('MAX_TOKENS', [{ text: 'cut' }]), 'm').stop_reason, 'max_tokens', '가시 텍스트가 있으면 절단으로 정상 반환');
  const ws = 'gem-empty'; await createCompany(ws, '빈답', '사장'); const root = paths(ws).root;
  const srv = await fakeGemini([gemSafety('SAFETY')]);
  try {
    let last; for await (const ev of nativeQuery({ wsId: ws, slug: 's', prompt: 'x', cwd: root, systemPrompt: 'SYS', model: 'gemini-2.5-pro', saveSession: false, env: { ARGO_WIRE: 'gemini', GEMINI_API_KEY: 'test-key', GEMINI_BASE_URL: srv.base }, canUseTool: makePermissionGate(ws, 's', root, null, 'ko', []) })) last = ev;
    assert.equal(last.type, 'result'); assert.equal(last.subtype, 'error_during_execution'); assert.equal(last.is_error, true); assert.match(String(last.errors?.[0]), /finishReason=SAFETY/, '조용한 성공이 아니라 실패 result');
    assert.equal(last.usage.input_tokens, 3, '차단 응답의 프롬프트 토큰도 집계(2R LOW-3)');
  } finally { await srv.close(); }
  assert.equal(fromGeminiResponse.length, 2); try { fromGeminiResponse(gemSafety('SAFETY'), 'm'); } catch (e) { assert.deepEqual(e.usage, { input_tokens: 3, output_tokens: 0 }, '오류에 usage 동봉'); }
});

test('G13. 오류 문구에 Google 계급 보존(M1) — 404 NOT_FOUND·403 PERMISSION_DENIED가 게이트 모델 강등 정규식에 걸리고, API_KEY_INVALID reason도 남는다; chat 네이티브 경로 강등 분기 배선 핀', async () => {
  const { GATED_MODEL_ERR_RE } = await import('../src/chat.mjs');
  const nf = extractErrorMessage(JSON.stringify({ error: { code: 404, message: 'models/gemini-3.1-pro-preview is not found for API version v1beta, or is not supported for generateContent.', status: 'NOT_FOUND' } }));
  assert.match(nf, /\(NOT_FOUND\)$/); assert.equal(GATED_MODEL_ERR_RE.test(`API Error: 404 ${nf}`), true);
  assert.equal(GATED_MODEL_ERR_RE.test(`API Error: 403 ${extractErrorMessage(JSON.stringify({ error: { code: 403, message: 'You do not have permission', status: 'PERMISSION_DENIED' } }))}`), true);
  assert.match(extractErrorMessage(JSON.stringify({ error: { code: 400, message: 'API key not valid.', status: 'INVALID_ARGUMENT', details: [{ '@type': 'x', reason: 'API_KEY_INVALID' }] } })), /\(INVALID_ARGUMENT, API_KEY_INVALID\)$/);
  assert.equal(extractErrorMessage(JSON.stringify({ error: { message: 'usage limit (RESOURCE_EXHAUSTED)', status: 'RESOURCE_EXHAUSTED' } })), 'usage limit (RESOURCE_EXHAUSTED)', '문구에 이미 있으면 중복 안 붙임');
  assert.equal(extractErrorMessage(JSON.stringify({ code: 'personal-team-blocked' })), '(personal-team-blocked)', 'xAI code 보존은 그대로');
  const src = await readFile(join(ROOT, 'src', 'chat.mjs'), 'utf8');
  const i = src.indexOf("!__downgradedFrom && nativeOn && effModel && effectiveModels(runner).find((m) => m.id === effModel)?.gated && GATED_MODEL_ERR_RE.test(String(e?.message || e))");
  assert.ok(i > 0, '네이티브 경로 강등 분기(게이트 모델·정규식·1회 제한)');
  const block = src.slice(i, i + 900);
  assert.match(block, /modelOverride: baseModel/); assert.match(block, /__downgradedFrom: effModel/); assert.match(block, /catch \(e2\) \{ e = e2; retriedDown = true;/);
  assert.match(src, /if \(__downgradedFrom && reply\) \{/); assert.match(src, /\.\.\.\(__downgradedFrom \? \{ downgradedFrom: __downgradedFrom \} : \{\}\),/);
  const recursions = src.split('\n').filter((l) => l.includes('await chat(wsId, agentSlug, userMsg,'));
  const switching = recursions.filter((l) => l.includes('const healed = await chat(')); const same = recursions.filter((l) => !l.includes('const healed = await chat('));
  assert.ok(same.length >= 5 && same.every((l) => l.includes('__downgradedFrom,') || l.includes('__downgradedFrom: effModel')), `같은 러너 재귀(${same.length})는 강등 표식을 전달한다 — 크래시·잠김 재시도 뒤 고지·이벤트가 사라지지 않게(2R LOW-2)`);
  assert.ok(switching.length === 2 && switching.every((l) => l.includes('__downgradedFrom: null')), '러너를 갈아타는 자가치유 재귀 2줄은 표식을 떨군다 — 다른 러너 답변에 오귀속 고지 금지(3R L-2)');
  assert.equal(stripForeignBlocks([{ role: 'assistant', content: [{ type: 'gem_thought', text: 't' }] }, { role: 'user', content: 'x' }]).length, 1, '사고 파트만 든 메시지는 통째로 제외(빈 content는 400)');
  assert.match(src, /if \(s && s\.company\.connected && s\.company\.invalid\) \{/, '러너 변경 크루 도구 게이트가 무효 자격을 본다(3R L-1)');
});

test('G14. 자격 유출 차단(검수 HIGH-1) — 크루 Bash 자식이 GEMINI_API_KEY·ARGO_WIRE·RESPONSES_*를 상속하지 않는다(가짜 서버가 printenv를 요청 — 전사·세션 파일에 키 없음), 다른 러너 env에도 ARGO_WIRE 미상속(L1)', async () => {
  const stripped = shellEnv({ PATH: '/bin', GEMINI_API_KEY: 'k', GOOGLE_API_KEY: 'k', GEMINI_BASE_URL: 'u', ARGO_WIRE: 'gemini', RESPONSES_TOKEN: 't', RESPONSES_HEADERS: '{}', RESPONSES_BASE_URL: 'u', ANTHROPIC_API_KEY: 'a', HOME: '/h' });
  assert.deepEqual(Object.keys(stripped).sort(), ['HOME', 'PATH']);
  const ws = 'gem-leak'; await createCompany(ws, '유출', '사장'); const root = paths(ws).root;
  const CANARY = 'ZZGEMINICANARYZZ';
  const srv = await fakeGemini([gemCall('Bash', { command: 'printenv GEMINI_API_KEY; printenv ARGO_WIRE; echo done' }), gemText('끝')]);
  try {
    const out = []; for await (const ev of nativeQuery({ wsId: ws, slug: 's', prompt: 'env', cwd: root, systemPrompt: 'SYS', model: 'gemini-2.5-pro', saveSession: true, env: { PATH: process.env.PATH, ARGO_WIRE: 'gemini', GEMINI_API_KEY: CANARY, GEMINI_BASE_URL: srv.base }, canUseTool: makePermissionGate(ws, 's', root, null, 'ko', []) })) out.push(ev);
    assert.equal(out.at(-1).subtype, 'success');
    assert.equal(JSON.stringify(out).includes(CANARY), false, '전사(도구 결과)에 키 평문 금지'); assert.equal(JSON.stringify(srv.calls[1].body).includes(CANARY), false, '벤더 재전송에도 없음');
    assert.equal((await readFile(sessionFile(ws, 's'), 'utf8')).includes(CANARY), false, '세션 파일에 키 평문 금지');
    assert.equal(srv.calls[0].headers['x-goog-api-key'], CANARY, '벤더 호출 자체는 키를 쓴다(대조군)');
  } finally { await srv.close(); }
  const other = scrubServerSecrets({ ARGO_WIRE: 'gemini', GEMINI_API_KEY: 'k', GEMINI_BASE_URL: 'u', RESPONSES_TOKEN: 't', PATH: '/bin' }, 'openrouter');
  assert.deepEqual(Object.keys(other), ['PATH'], '호스트 셸의 와이어 env는 다른 러너에 상속되지 않는다');
  assert.deepEqual(Object.keys(scrubServerSecrets({ ARGO_WIRE: 'gemini', GEMINI_API_KEY: 'k', PATH: '/bin' }, 'gemini')).sort(), ['ARGO_WIRE', 'GEMINI_API_KEY', 'PATH']);
});

test('G15. 검진 목적지(L3)·카드 표기(M2 핀) — verifyRunnerCred(gemini)가 GEMINI_BASE_URL을 따르고, 설정 카드는 제공되지 않는 연결 방식(oauth)을 첫 제공 방식으로 보인다', async () => {
  const srv = await fakeGemini([{ status: 200, json: { models: [] } }]);
  const prev = process.env.GEMINI_BASE_URL; process.env.GEMINI_BASE_URL = srv.base;
  try { const r = await verifyRunnerCred('gemini', 'apikey', 'fake-gemini-key-000'); assert.deepEqual(r, { ok: true }); assert.equal(srv.calls.length, 1); assert.match(srv.calls[0].url, /^\/models\?key=fake-gemini-key-000&pageSize=1$/); }
  finally { await srv.close(); if (prev === undefined) delete process.env.GEMINI_BASE_URL; else process.env.GEMINI_BASE_URL = prev; }
  const jsx = await readFile(join(ROOT, 'app', 'runner-connect.jsx'), 'utf8');
  assert.match(jsx, /const shownMethod = \(type\) => \(methods\.includes\(type\) \? type : \(methods\[0\] \?\? 'apikey'\)\);/);
  assert.match(jsx, /useState\(company\.connected \? shownMethod\(company\.type\) : 'apikey'\)/); assert.match(jsx, /if \(company\.connected\) setMethod\(shownMethod\(company\.type\)\);/);
  const creds = await readFile(join(ROOT, 'src', 'runners', 'creds.mjs'), 'utf8');
  assert.match(creds, /if \(runner === 'gemini' && credType\(type\) !== 'apikey'\) provisionGeminiCli\(\)/, 'API 키 저장은 CLI 조달 생략(L4)');
});

test('G16. 게이트 모델 강등(M1, 행동) — gemini API 키 크루가 gated 모델(3.1 Pro)로 404 NOT_FOUND를 받으면 chat()이 기본 모델로 1회 재시도하고 답 머리에 고지·이벤트에 downgradedFrom을 남긴다', async () => {
  const { chat } = await import('../src/chat.mjs');
  const ws = 'gem-down'; await createCompany(ws, '강등', '사장'); const root = paths(ws).root;
  for (const d of [['agents'], ['chats'], ['vault', 'journal'], ['vault', 'projects'], ['vault', 'files'], ['vault', 'notes']]) await mkdir(join(root, ...d), { recursive: true });
  await writeFile(join(root, 'agents', 'crew-g.md'), '---\nname: 크루G\nrunner: gemini\nmodel: gemini-3.1-pro-preview\n---\n\n전문가.\n');
  await saveRunnerCred(ws, 'gemini', 'apikey', 'fake-gemini-key-down');
  const srv = await fakeGemini([(call) => (call.url.includes('gemini-3.1-pro-preview')
    ? { status: 404, json: { error: { code: 404, message: 'models/gemini-3.1-pro-preview is not found for API version v1beta, or is not supported for generateContent.', status: 'NOT_FOUND' } } }
    : gemText('기본 모델 답'))]);
  const prev = process.env.GEMINI_BASE_URL; process.env.GEMINI_BASE_URL = srv.base;
  try {
    const r = await chat(ws, 'crew-g', '안녕');
    assert.match(r.reply, /^\(이 계정에는 gemini-3.1-pro-preview 접근 권한이 없어/, '강등 고지가 답 머리에');
    assert.match(r.reply, /기본 모델 답/);
    assert.deepEqual(srv.calls.map((c) => c.url), ['/models/gemini-3.1-pro-preview:generateContent', '/models/gemini-2.5-pro:generateContent'], '게이트 모델 1회 → 기본 모델 1회');
    const events = (await readFile(join(root, 'events.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    const turn = events.filter((e) => e.type === 'turn' && e.ok).at(-1);
    assert.equal(turn?.downgradedFrom, 'gemini-3.1-pro-preview', '이벤트 필드는 CLI 경로와 같다');
  } finally { await srv.close(); if (prev === undefined) delete process.env.GEMINI_BASE_URL; else process.env.GEMINI_BASE_URL = prev; }
});
