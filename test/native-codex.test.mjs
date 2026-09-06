// Codex 백엔드 직결(P-B, 옵트인 플래그) — Responses 와이어 변환(순수)·SSE 최종 응답·OAuth 리프레시/CLI 반입/한도 계급·자격 env·가짜 백엔드 실루프·원샷·분기. 실벤더 호출 0.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { mkdtemp } from './helpers/tmp.mjs';

process.env.HOME = await mkdtemp(join(tmpdir(), 'argo-codex-home-'));
process.env.USERPROFILE = process.env.HOME;
process.env.ARGO_ROOT = join(await mkdtemp(join(tmpdir(), 'argo-codex-')), 'workspaces'); await mkdir(process.env.ARGO_ROOT, { recursive: true });
process.env.ARGO_MODEL_CATALOG = 'off';
delete process.env.ARGO_NATIVE_RUNNERS;
const ROOT = fileURLToPath(new URL('..', import.meta.url));

const { toResponsesRequest, fromResponsesResponse, finalFromSse, callResponses, CODEX_BACKEND_BASE, OPENAI_API_BASE } = await import('../src/engine/responses-wire.mjs');
const { parseCodexAuth, jwtClaims, accessExpiring, accountIdOf, codexHeaders, refreshCodexTokens, mergeCodexAuth, CODEX_OAUTH_CLIENT_ID } = await import('../src/runners/codex-oauth.mjs');
const { authFromEnv, callMessages } = await import('../src/engine/messages-http.mjs');
const { nativeQuery, NATIVE_DEFAULT_RUNNERS } = await import('../src/engine/native-query.mjs');
const { isCliTurn, CODEX_DEFAULT_MODEL } = await import('../src/runners/catalog.mjs');
const { createCompany, paths } = await import('../src/workspace.mjs');
const { saveRunnerCred, loadRunnerCred, runnerCredEnv, ensureCodexAccess } = await import('../src/runners/creds.mjs');
const { makePermissionGate } = await import('../src/permission-gate.mjs');

const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (claims) => `${b64u({ alg: 'none' })}.${b64u(claims)}.sig`;
const authJson = ({ exp = Math.floor(Date.now() / 1000) + 3600, acct = 'acct_A', refresh = 'rt-1' } = {}) => JSON.stringify({ OPENAI_API_KEY: null, tokens: { id_token: 'id', access_token: jwt({ exp, 'https://api.openai.com/auth': { chatgpt_account_id: acct } }), refresh_token: refresh, account_id: acct }, last_refresh: '2026-09-01T00:00:00Z' });
const withFlag = async (fn) => { process.env.ARGO_NATIVE_RUNNERS = 'openrouter,glm,kimi,grok,gemini,codex'; try { return await fn(); } finally { delete process.env.ARGO_NATIVE_RUNNERS; } };

async function fakeServer(handler) {
  const calls = [];
  const srv = createServer((req, res) => { let d = ''; req.on('data', (c) => { d += c; }); req.on('end', () => { calls.push({ url: req.url, headers: req.headers, body: d }); handler(calls.at(-1), calls.length, res); }); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${srv.address().port}`, calls, close: () => new Promise((r) => srv.close(r)) };
}
const sse = (events) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
const completed = (output, extra = {}) => ({ type: 'response.completed', response: { id: 'resp_1', model: 'gpt-5.6-sol', status: 'completed', output, usage: { input_tokens: 12, output_tokens: 4, input_tokens_details: { cached_tokens: 3 } }, ...extra } });
const respond = (res, status, body, ct = 'text/event-stream') => { res.writeHead(status, { 'content-type': ct }); res.end(body); };

test('C1. Responses 변환(순수) — instructions·input 항목(input_text/output_text·function_call·function_call_output·input_image)·도구 정의·store:false·stream·reasoning', () => {
  const req = toResponsesRequest({ system: 'SYS', model: 'gpt-5.6-sol', effort: 'high',
    tools: [{ name: 'Read', description: 'r', input_schema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } }],
    messages: [
      { role: 'user', content: '지시' },
      { role: 'assistant', content: [{ type: 'text', text: '읽을게' }, { type: 'tool_use', id: 'call_1', name: 'Read', input: { file_path: 'a.md' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: [{ type: 'text', text: 'A' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } }] }, { type: 'text', text: '다음' }] },
    ] });
  assert.equal(req.instructions, 'SYS'); assert.equal(req.store, false); assert.equal(req.stream, true); assert.deepEqual(req.reasoning, { effort: 'high' }); assert.equal('max_output_tokens' in req, false);
  assert.deepEqual(req.input[0], { type: 'message', role: 'user', content: [{ type: 'input_text', text: '지시' }] });
  assert.deepEqual(req.input[1], { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '읽을게' }] });
  assert.deepEqual(req.input[2], { type: 'function_call', call_id: 'call_1', name: 'Read', arguments: '{"file_path":"a.md"}' });
  assert.deepEqual(req.input[3], { type: 'function_call_output', call_id: 'call_1', output: 'A' });
  assert.deepEqual(req.input[4], { type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,QUJD', detail: 'auto' }, { type: 'input_text', text: '다음' }] }, '도구 결과 이미지는 이어지는 사용자 메시지로');
  assert.deepEqual(req.tools[0], { type: 'function', name: 'Read', description: 'r', parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] }, strict: false });
  assert.equal(req.tool_choice, 'auto');
  assert.equal('tools' in toResponsesRequest({ model: 'm', messages: [{ role: 'user', content: 'x' }] }), false);
});

test('C2. 응답 변환·SSE(순수) — message/refusal→text, function_call→tool_use(id=call_id, arguments 파싱), reasoning 제거, incomplete→max_tokens, usage 캐시, completed/failed/JSON', () => {
  const r = fromResponsesResponse({ id: 'r', model: 'gpt-5.6-sol', status: 'completed', output: [{ type: 'reasoning', summary: [] }, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'a' }, { type: 'refusal', refusal: 'no' }] }, { type: 'function_call', call_id: 'call_9', name: 'Read', arguments: '{"file_path":"x"}' }], usage: { input_tokens: 5, output_tokens: 2, input_tokens_details: { cached_tokens: 1 } } }, 'm');
  assert.deepEqual(r.content.map((b) => b.type), ['text', 'text', 'tool_use']); assert.equal(r.content[1].text, 'no');
  assert.deepEqual(r.content[2], { type: 'tool_use', id: 'call_9', name: 'Read', input: { file_path: 'x' } }); assert.equal(r.stop_reason, 'tool_use');
  assert.deepEqual(r.usage, { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 1 });
  assert.equal(fromResponsesResponse({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [{ type: 'message', content: [{ type: 'output_text', text: 'cut' }] }] }, 'm').stop_reason, 'max_tokens');
  assert.equal(fromResponsesResponse({ output: [{ type: 'function_call', call_id: 'c', name: 'f', arguments: 'not json' }] }, 'm').content[0].input._raw, 'not json', '깨진 인자는 원문 보존');
  const fin = finalFromSse(sse([{ type: 'response.created', response: { id: 'x' } }, { type: 'response.output_item.done', item: {} }, completed([{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }])]));
  assert.equal(fin.output[0].content[0].text, 'ok');
  assert.throws(() => finalFromSse(sse([{ type: 'response.failed', response: { error: { message: 'boom' } } }])), /API Error: 400 boom/);
  assert.throws(() => finalFromSse(sse([{ type: 'response.created', response: {} }])), /without response\.completed/);
  assert.equal(finalFromSse(JSON.stringify({ id: 'j', output: [] })).id, 'j', 'JSON 본문도 수용');
  assert.throws(() => finalFromSse(JSON.stringify({ error: { message: 'bad' } })), /API Error: 400 bad/);
});

test('C3. codex-oauth 순수 — auth.json 파싱·JWT 만료 스큐·계정 id(클레임 우선)·헤더(제3자 표기)·병합 저장 형식', () => {
  const t = parseCodexAuth(authJson({ acct: 'acct_claim' }));
  assert.ok(t && t.refresh_token === 'rt-1' && t.account_id === 'acct_claim');
  assert.equal(parseCodexAuth('{"OPENAI_API_KEY":"sk","tokens":null}'), null); assert.equal(parseCodexAuth('nope'), null);
  assert.equal(accessExpiring(jwt({ exp: Math.floor(Date.now() / 1000) + 60 })), true, '120초 스큐 안이면 만료 임박');
  assert.equal(accessExpiring(jwt({ exp: Math.floor(Date.now() / 1000) + 600 })), false); assert.equal(accessExpiring('garbage'), false, 'exp 없으면 판정 불가=미만료');
  assert.equal(accountIdOf({ access_token: jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'from-jwt' } }), account_id: 'from-file' }), 'from-jwt');
  assert.equal(accountIdOf({ access_token: 'x', account_id: 'from-file' }), 'from-file');
  const h = codexHeaders(t);
  assert.equal(h.originator, 'argo'); assert.match(h['user-agent'], /^Argo\/\d/); assert.equal(h['ChatGPT-Account-ID'], 'acct_claim'); assert.match(h.authorization, /^Bearer /); assert.ok(!/codex_cli/i.test(JSON.stringify(h)), 'CLI 위장 금지');
  const merged = JSON.parse(mergeCodexAuth(t.raw, { access_token: 'new', refresh_token: 'rt-2' }));
  assert.equal(merged.tokens.access_token, 'new'); assert.equal(merged.tokens.refresh_token, 'rt-2'); assert.equal(merged.tokens.id_token, 'id'); assert.ok(merged.last_refresh);
});

test('C4. 리프레시 HTTP — form 본문(grant_type·refresh_token·client_id), 200 회전, 429=한도(재로그인 아님), invalid_grant=재로그인', async () => {
  const srv = await fakeServer((c, n, res) => {
    if (n === 1) respond(res, 200, JSON.stringify({ access_token: 'acc-2', refresh_token: 'rt-2', id_token: 'id-2' }), 'application/json');
    else if (n === 2) { res.writeHead(429, { 'retry-after': '30' }); res.end('{"error":"quota"}'); }
    else respond(res, 400, JSON.stringify({ error: 'invalid_grant', error_description: 'reused' }), 'application/json');
  });
  try {
    const ok = await refreshCodexTokens('rt-1', { tokenUrl: `${srv.base}/oauth/token` });
    assert.deepEqual(ok, { access_token: 'acc-2', refresh_token: 'rt-2', id_token: 'id-2' });
    const form = new URLSearchParams(srv.calls[0].body);
    assert.equal(form.get('grant_type'), 'refresh_token'); assert.equal(form.get('refresh_token'), 'rt-1'); assert.equal(form.get('client_id'), CODEX_OAUTH_CLIENT_ID);
    assert.equal(srv.calls[0].headers['content-type'], 'application/x-www-form-urlencoded');
    await assert.rejects(refreshCodexTokens('rt-1', { tokenUrl: `${srv.base}/oauth/token` }), (e) => e.quota === true && e.status === 429 && !e.authExpired && e.retryAfter === 30);
    await assert.rejects(refreshCodexTokens('rt-1', { tokenUrl: `${srv.base}/oauth/token` }), (e) => e.authExpired === 'codex');
    await assert.rejects(refreshCodexTokens('', { tokenUrl: `${srv.base}/oauth/token` }), (e) => e.authExpired === 'codex');
  } finally { await srv.close(); }
});

test('C5. ensureCodexAccess — 미만료면 무호출, 만료 임박이면 리프레시 뒤 회사 자격에 저장(홈 리셋 없음), 재로그인 계급이면 CLI 파일의 더 새 토큰을 1회 반입, 그래도 실패면 authExpired', async () => {
  const ws = 'cx1'; await createCompany(ws, '코덱스', '사장');
  const srv = await fakeServer((c, n, res) => {
    const rt = new URLSearchParams(c.body).get('refresh_token');
    if (rt === 'rt-fresh') respond(res, 200, JSON.stringify({ access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600, 'https://api.openai.com/auth': { chatgpt_account_id: 'acct_A' } }), refresh_token: 'rt-fresh-2' }), 'application/json');
    else if (rt === 'rt-cli') respond(res, 200, JSON.stringify({ access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600 }), refresh_token: 'rt-cli-2' }), 'application/json');
    else respond(res, 400, JSON.stringify({ error: 'invalid_grant' }), 'application/json');
  });
  process.env.CODEX_OAUTH_TOKEN_URL = `${srv.base}/oauth/token`;
  try {
    await saveRunnerCred(ws, 'codex', 'oauth', authJson({ exp: Math.floor(Date.now() / 1000) + 3600 }));
    const t0 = await ensureCodexAccess(ws, await loadRunnerCred(ws, 'codex')); assert.equal(srv.calls.length, 0, '미만료 — 무호출'); assert.equal(t0.refresh_token, 'rt-1');
    await saveRunnerCred(ws, 'codex', 'oauth', authJson({ exp: Math.floor(Date.now() / 1000) + 30, refresh: 'rt-fresh' }));
    const t1 = await ensureCodexAccess(ws, await loadRunnerCred(ws, 'codex'));
    assert.equal(t1.refresh_token, 'rt-fresh-2'); assert.equal(accessExpiring(t1.access_token), false);
    const saved = parseCodexAuth((await loadRunnerCred(ws, 'codex')).value); assert.equal(saved.refresh_token, 'rt-fresh-2', '회사 자격에 회전 결과 저장'); assert.equal(saved.account_id, 'acct_A');
    // 재로그인 계급 + CLI 파일에 더 새 토큰 → 반입
    await saveRunnerCred(ws, 'codex', 'oauth', authJson({ exp: Math.floor(Date.now() / 1000) + 30, refresh: 'rt-dead' }));
    await mkdir(join(process.env.HOME, '.codex'), { recursive: true }); await writeFile(join(process.env.HOME, '.codex', 'auth.json'), authJson({ exp: Math.floor(Date.now() / 1000) + 3600, refresh: 'rt-cli' }));
    const t2 = await ensureCodexAccess(ws, await loadRunnerCred(ws, 'codex')); assert.equal(t2.refresh_token, 'rt-cli-2', 'CLI 반입 뒤 리프레시');
    // CLI도 죽은 토큰 → authExpired
    await saveRunnerCred(ws, 'codex', 'oauth', authJson({ exp: Math.floor(Date.now() / 1000) + 30, refresh: 'rt-dead' }));
    await writeFile(join(process.env.HOME, '.codex', 'auth.json'), authJson({ exp: Math.floor(Date.now() / 1000) + 3600, refresh: 'rt-dead' }));
    await assert.rejects(ensureCodexAccess(ws, await loadRunnerCred(ws, 'codex')), (e) => e.authExpired === 'codex');
  } finally { await srv.close(); delete process.env.CODEX_OAUTH_TOKEN_URL; }
});

test('C6. 자격 env·분기 — 플래그 없으면 CLI(종전), 플래그면 apikey=api.openai.com·oauth=ChatGPT 백엔드(헤더 JSON), host는 항상 CLI; 기본 목록에 codex 없음', async () => {
  assert.equal(NATIVE_DEFAULT_RUNNERS.includes('codex'), false, '옵트인 전용');
  assert.equal(isCliTurn('codex', 'oauth'), true); assert.equal(isCliTurn('codex', 'apikey'), true);
  const ws = 'cx2'; await createCompany(ws, '코덱스2', '사장');
  await saveRunnerCred(ws, 'codex', 'apikey', 'fake-openai-key-000000');
  const cli = await runnerCredEnv(ws, 'codex'); assert.equal(cli.env.ARGO_WIRE, undefined); assert.ok(cli.home, '플래그 없음 = 격리 CODEX_HOME(CLI)');
  await withFlag(async () => {
    assert.equal(isCliTurn('codex', 'oauth'), false); assert.equal(isCliTurn('codex', 'apikey'), false); assert.equal(isCliTurn('codex', 'host'), true);
    const a = await runnerCredEnv(ws, 'codex'); assert.equal(a.env.ARGO_WIRE, 'responses'); assert.equal(a.env.RESPONSES_BASE_URL, OPENAI_API_BASE); assert.equal(a.env.RESPONSES_TOKEN, 'fake-openai-key-000000'); assert.equal(a.authType, 'apikey');
    await saveRunnerCred(ws, 'codex', 'oauth', authJson({ acct: 'acct_Z' }));
    const o = await runnerCredEnv(ws, 'codex'); assert.equal(o.env.RESPONSES_BASE_URL, CODEX_BACKEND_BASE); const h = JSON.parse(o.env.RESPONSES_HEADERS); assert.equal(h.originator, 'argo'); assert.equal(h['ChatGPT-Account-ID'], 'acct_Z'); assert.equal(o.authType, 'oauth');
    const auth = authFromEnv(o.env); assert.equal(auth.wire, 'responses'); assert.equal(auth.base, CODEX_BACKEND_BASE); assert.equal(auth.headers['ChatGPT-Account-ID'], 'acct_Z'); assert.match(auth.headers.authorization, /^Bearer /);
  });
  assert.throws(() => authFromEnv({ ARGO_WIRE: 'responses', RESPONSES_BASE_URL: 'http://x' }), (e) => e.code === 'no_credential');
});

test('C7. 실루프 — 가짜 Responses 백엔드(SSE): 도구 광고·function_call→내장 Read(게이트)→function_call_output→최종 텍스트, 헤더·URL·store·usage', async () => {
  const ws = 'cx3'; await createCompany(ws, '코덱스3', '사장'); const root = paths(ws).root;
  await mkdir(join(root, 'vault'), { recursive: true }); await writeFile(join(root, 'vault', 'facts.md'), 'CODEX-CANARY line\n');
  const srv = await fakeServer((c, n, res) => {
    if (n === 1) respond(res, 200, sse([{ type: 'response.created', response: { id: 'r1' } }, completed([{ type: 'reasoning', summary: [] }, { type: 'function_call', call_id: 'call_A', name: 'Read', arguments: JSON.stringify({ file_path: 'vault/facts.md' }) }])]));
    else respond(res, 200, sse([completed([{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'facts에 CODEX-CANARY가 있습니다' }] }])]));
  });
  try {
    const out = [];
    for await (const ev of nativeQuery({ wsId: ws, slug: 's', prompt: 'facts 읽어', cwd: root, systemPrompt: 'SYS', model: 'gpt-5.6-sol', saveSession: false, effort: 'high',
      env: { ARGO_WIRE: 'responses', RESPONSES_BASE_URL: srv.base, RESPONSES_TOKEN: 'acc', RESPONSES_HEADERS: JSON.stringify({ originator: 'argo', 'ChatGPT-Account-ID': 'acct_A' }) }, canUseTool: makePermissionGate(ws, 's', root, null, 'ko', []) })) out.push(ev);
    const result = out.at(-1); assert.equal(result.subtype, 'success'); assert.match(result.result, /CODEX-CANARY/);
    assert.equal(srv.calls.length, 2); assert.equal(srv.calls[0].url, '/responses');
    assert.equal(srv.calls[0].headers.authorization, 'Bearer acc'); assert.equal(srv.calls[0].headers.originator, 'argo'); assert.equal(srv.calls[0].headers['chatgpt-account-id'], 'acct_A'); assert.match(srv.calls[0].headers.accept, /event-stream/);
    const b1 = JSON.parse(srv.calls[0].body); assert.equal(b1.store, false); assert.equal(b1.stream, true); assert.equal(b1.instructions.startsWith('SYS'), true); assert.deepEqual(b1.reasoning, { effort: 'high' });
    assert.ok(b1.tools.some((t) => t.type === 'function' && t.name === 'Read') && !b1.tools.some((t) => t.name.startsWith('computer_')));
    const b2 = JSON.parse(srv.calls[1].body); const fo = b2.input.find((i) => i.type === 'function_call_output'); assert.equal(fo.call_id, 'call_A'); assert.match(fo.output, /CODEX-CANARY/);
    assert.ok(b2.input.some((i) => i.type === 'function_call' && i.call_id === 'call_A'), '이전 모델 턴의 function_call이 전사에 남는다'); assert.ok(!b2.input.some((i) => i.type === 'reasoning'), 'reasoning 항목은 보내지 않는다');
    assert.deepEqual(result.usage, { input_tokens: 24, output_tokens: 8, cache_creation_input_tokens: 0, cache_read_input_tokens: 6 });
  } finally { await srv.close(); }
});

test('C8. 오류 계급 — 401은 status 동봉(자격 게이트가 문다), 429 원문, 5xx 1회 재시도, response.failed', async () => {
  const srv = await fakeServer((c, n, res) => { if (n === 1) respond(res, 401, JSON.stringify({ error: { message: 'Missing bearer' } }), 'application/json'); else if (n === 2) { res.writeHead(429, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'usage limit reached', type: 'usage_limit_reached' } })); } else if (n === 3) respond(res, 503, 'overloaded', 'text/plain'); else respond(res, 200, sse([completed([{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }])])); });
  try {
    const body = { model: 'm', messages: [{ role: 'user', content: 'x' }] };
    await assert.rejects(callResponses({ base: srv.base, headers: {}, body }), (e) => e.status === 401 && /API Error: 401 Missing bearer/.test(e.message));
    await assert.rejects(callMessages({ wire: 'responses', base: srv.base, headers: {}, body }), /API Error: 429 usage limit reached/);
    const r = await callMessages({ wire: 'responses', base: srv.base, headers: {}, body, retry: 1 }); assert.equal(r.content[0].text, 'ok'); assert.equal(srv.calls.length, 4);
  } finally { await srv.close(); }
});

test('C9. 원샷 — 플래그 on + codex API 키 회사의 runOneShot이 가짜 Responses 서버로(도구 없음) 텍스트를 돌려준다; 배선 핀', async () => {
  const { runOneShot } = await import('../src/oneshot.mjs');
  const ws = 'cx4'; await createCompany(ws, '코덱스4', '사장'); await saveRunnerCred(ws, 'codex', 'apikey', 'fake-openai-key-111111');
  const srv = await fakeServer((c, n, res) => respond(res, 200, sse([completed([{ type: 'message', content: [{ type: 'output_text', text: '직함: 키잡이' }] }])])));
  process.env.OPENAI_BASE_URL = srv.base;
  try {
    const r = await withFlag(() => runOneShot(ws, '직함을 추천해', { timeoutMs: 20_000 }));
    assert.equal(r.runner, 'codex'); assert.match(r.text, /키잡이/); assert.equal(srv.calls.length, 1);
    const b = JSON.parse(srv.calls[0].body); assert.equal('tools' in b, false); assert.equal(b.model, CODEX_DEFAULT_MODEL); assert.equal(srv.calls[0].headers.authorization, 'Bearer fake-openai-key-111111');
  } finally { await srv.close(); delete process.env.OPENAI_BASE_URL; }
  const chat = await readFile(join(ROOT, 'src', 'chat.mjs'), 'utf8');
  assert.match(chat, /runner === 'codex' \? \(effModel \|\| CODEX_DEFAULT_MODEL\)/); assert.match(chat, /runner === 'codex' && CODEX_EFFORTS\.includes\(String\(meta\.effort \?\? ''\)\) \? \{ effort: meta\.effort \} : \{\}/);
  const creds = await readFile(join(ROOT, 'src', 'runners', 'creds.mjs'), 'utf8');
  assert.match(creds, /if \(runner === 'codex' && cred\.type !== 'host' && nativeRunnerEnabled\('codex'\)\) \{/);
});
