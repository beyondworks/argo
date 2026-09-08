// HTTP 텍스트 러너(부록 N) — 외부 에이전트 엔드포인트를 회사 크루의 두뇌로. 가짜 HTTP 서버로 계약을 잠근다:
// 요청 모양(Bearer·JSON 필드)·응답 3형(JSON text/reply, text/plain)·오류 계급(401 → API Error: 401 = 게이트 열쇠)·상한·중단·엔드포인트 부재.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { execHttpText, buildHttpTextRequest, parseHttpTextResponse, assertHttpTextEndpoint, HTTP_TEXT_NO_AUTH } from '../src/runners/http-text.mjs';
import { externalExec } from '../src/runners.mjs';
import { RUNNERS, RUNNER_AUTH, isCliRunner, isCliTurn, isHiddenRunner, isRetiredRunner, isCardOnlyRunner, pickRunner } from '../src/runners/catalog.mjs';

async function fake(handler) {
  const seen = [];
  const srv = createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { seen.push({ headers: req.headers, body: b ? JSON.parse(b) : null }); handler(req, res, seen.length); }); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}/turn`, seen, close: () => new Promise((r) => srv.close(r)) };
}
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

test('요청 모양 — POST JSON {prompt, model, cwd, kind, readOnly} + 회사 자격이 있으면 Bearer, 없으면 헤더 없음', async () => {
  const f = await fake((req, res) => json(res, 200, { text: ' 답변입니다 ' }));
  try {
    const out = await execHttpText({ endpoint: f.url, prompt: '안녕', model: 'm1', cwd: '/w', kind: 'chat', timeoutMs: 5000, cred: { env: { ARGO_HTTP_KEY: 'k-1' } } });
    assert.equal(out, '답변입니다');
    assert.equal(f.seen[0].headers.authorization, 'Bearer k-1'); assert.deepEqual(f.seen[0].body, { prompt: '안녕', model: 'm1', kind: 'chat', readOnly: false }, 'cwd 같은 로컬 경로는 보내지 않는다(최소 정보)');
    await execHttpText({ endpoint: f.url, prompt: 'x', timeoutMs: 5000, cred: null });
    assert.equal(f.seen[1].headers.authorization, undefined, '자격 없으면 Bearer를 만들지 않는다'); assert.equal(f.seen[1].body.model, undefined, '모델 미지정은 필드 생략');
    await execHttpText({ endpoint: f.url, prompt: 'x', timeoutMs: 5000, cred: { env: { ARGO_HTTP_KEY: HTTP_TEXT_NO_AUTH } } });
    assert.equal(f.seen[2].headers.authorization, undefined, "자격 값 'none' = 무인증 엔드포인트(로컬 헤르메스·오픈클로) — Bearer 없음(MEDIUM-2)");
  } finally { await f.close(); }
});

test('응답 3형 — {reply}·{content}·text/plain 전부 텍스트로', async () => {
  let n = 0; const f = await fake((req, res) => { n++; if (n === 1) json(res, 200, { reply: 'r' }); else if (n === 2) json(res, 200, { content: 'c' }); else { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('plain\n'); } });
  try {
    assert.equal(await execHttpText({ endpoint: f.url, prompt: 'x', timeoutMs: 5000 }), 'r');
    assert.equal(await execHttpText({ endpoint: f.url, prompt: 'x', timeoutMs: 5000 }), 'c');
    assert.equal(await execHttpText({ endpoint: f.url, prompt: 'x', timeoutMs: 5000 }), 'plain');
  } finally { await f.close(); }
});

test('오류 계급 — 401은 `API Error: 401 …`(불변식 A 게이트·자가치유 정규식이 문다), 5xx도 status 동봉, 연결 실패는 status 0', async () => {
  const f = await fake((req, res) => json(res, 401, { error: 'bad key' }));
  try { await assert.rejects(execHttpText({ endpoint: f.url, prompt: 'x', timeoutMs: 5000 }), (e) => /^API Error: 401 .*bad key/.test(e.message)); } finally { await f.close(); }
  const g = await fake((req, res) => json(res, 503, { error: 'busy' }));
  try { await assert.rejects(execHttpText({ endpoint: g.url, prompt: 'x', timeoutMs: 5000 }), (e) => /^API Error: 503 /.test(e.message)); } finally { await g.close(); }
  await assert.rejects(execHttpText({ endpoint: 'http://127.0.0.1:9/turn', prompt: 'x', timeoutMs: 3000 }), (e) => /^API Error: 0 /.test(e.message));
});

test('상한·중단·엔드포인트 부재 — 느린 서버는 timeoutMs에 끊기고, 외부 signal 중단은 aborted, endpoint 없으면 정직한 안내로 실패', async () => {
  const f = await fake((req, res) => setTimeout(() => json(res, 200, { text: 'late' }), 3000));
  try {
    const t0 = Date.now(); await assert.rejects(execHttpText({ endpoint: f.url, prompt: 'x', timeoutMs: 1000 }), (e) => e.timedOut === true && /시간 초과/.test(e.message) && /Timed out/.test(e.message)); assert.ok(Date.now() - t0 < 2500, '상한에서 끊긴다 — CLI 러너와 같은 timedOut 갈래(MEDIUM-5)');
    const ac = new AbortController(); setTimeout(() => ac.abort(), 200);
    await assert.rejects(execHttpText({ endpoint: f.url, prompt: 'x', timeoutMs: 5000, signal: ac.signal }), (e) => e.aborted === true);
  } finally { await f.close(); }
  await assert.rejects(execHttpText({ endpoint: '', prompt: 'x', timeoutMs: 1000 }), /endpoint/);
  await assert.rejects(execHttpText({ endpoint: 'ftp://x', prompt: 'x', timeoutMs: 1000 }), /endpoint/);
});

test('externalExec 배선 — runner http는 CLI를 띄우지 않고 어댑터로, 빈 응답은 empty-reply, API Error는 원문 그대로 통과', async () => {
  const f = await fake((req, res) => json(res, 200, { text: req.headers.authorization === 'Bearer k' ? 'ok' : '' }));
  try {
    assert.equal(await externalExec({ runner: 'http', model: '', cwd: '/w', prompt: 'p', timeoutMs: 5000, cred: { env: { ARGO_HTTP_KEY: 'k' } }, endpoint: f.url }), 'ok');
    await assert.rejects(externalExec({ runner: 'http', model: '', cwd: '/w', prompt: 'p', timeoutMs: 5000, cred: null, endpoint: f.url }), (e) => /빈 답/.test(e.message) && /empty reply/.test(e.message) && !/exit/.test(e.message), 'CLI 껍질(exit 코드) 없이 ko+en');
  } finally { await f.close(); }
  const g = await fake((req, res) => json(res, 401, { error: 'nope' }));
  try { await assert.rejects(externalExec({ runner: 'http', model: '', cwd: '/w', prompt: 'p', timeoutMs: 5000, cred: null, endpoint: g.url }), (e) => /^API Error: 401/.test(e.message)); } finally { await g.close(); }
});

test('카탈로그 핀 — http는 숨김·CLI 종류·자동 선택 제외·명시 지정은 존중, antigravity는 여전히 RUNNER_AUTH 맨 끝', () => {
  assert.equal(RUNNERS.http.name, 'HTTP', '표시명은 언어 중립 고유명사(2차 검수 M-4)');
  assert.equal(RUNNERS.http.kind, 'cli'); assert.equal(isHiddenRunner('http'), true); assert.equal(isCliRunner('http'), true); assert.equal(isCliTurn('http', 'apikey'), true);
  assert.deepEqual(RUNNER_AUTH.http.methods, ['apikey']); assert.equal(isRetiredRunner('http'), false); assert.equal(isCardOnlyRunner('http'), true);
  assert.ok(Object.keys(RUNNERS).every((id) => !isRetiredRunner(id) || (isHiddenRunner(id) && !isCardOnlyRunner(id))), 'retired = hidden이면서 cardOnly가 아닌 것(지금 카탈로그에는 제공 종료 러너가 없다 — gemini는 API 키로 복귀)');
  assert.equal(Object.keys(RUNNER_AUTH).at(-1), 'antigravity', '자동 선택 순서 — antigravity 맨 끝(분리 검수 H1a)');
  const st = { http: { company: { connected: true, type: 'apikey' } }, claude: { company: { connected: false } } };
  assert.equal(pickRunner(st, null).available, false, '자동 선택은 숨김 http를 잡지 않는다');
  assert.equal(pickRunner(st, 'http').runner, 'http', '카드가 명시하면 돈다');
});

test('배선 핀 — chat.mjs의 externalExec 두 호출이 카드 endpoint를 넘기고, creds가 http 자격을 Bearer env로 조립한다', async () => {
  const chat = await readFile(new URL('../src/chat.mjs', import.meta.url), 'utf8');
  assert.equal((chat.match(/externalExec\(\{ runner, [^\n]*endpoint: meta\.endpoint \?\? '', format: meta\.format \|\| 'argo'/g) ?? []).length, 2, 'CLI 턴 호출 2곳(본 턴·게이트 모델 강등 재시도)');
  // 2차 검수 HIGH-A·HIGH-B 소비자 핀 — 카드 전용 러너는 자가치유 폴백 금지, 설정 행·/api/runners·crew-edit은 retired(제공 종료) 기준
  assert.match(chat, /if \(!aborted && !isCardOnlyRunner\(runner\) && shouldSelfHeal\(e, \{ retried: __lockupRetry \}\)\)/, '카드 전용 러너 폴백 금지');
  assert.match(chat, /runner !== 'codex' && runner !== 'http' \? `\*\*your entire home folder\*\*/, 'http 지시문은 홈 폴더 전권을 광고하지 않는다');
  const rc = await readFile(new URL('../app/runner-connect.jsx', import.meta.url), 'utf8');
  assert.match(rc, /retired=\{!!runners\[id\]\?\.retired\}/, '설정 숨김 행의 retired prop은 제공 종료일 때만');
  const api = await readFile(new URL('../app/api/runners/route.js', import.meta.url), 'utf8');
  assert.match(api, /retired: isRetiredRunner\(id\)/, '/api/runners가 retired를 싣는다');
  const ce = await readFile(new URL('../app/c/[ws]/crew-edit.jsx', import.meta.url), 'utf8');
  assert.match(ce, /r\.retired \? ` — \$\{t\('runner\.retired'\)\}` : r\.hidden \? ''/, 'crew-edit 라벨은 제공 종료만');
  const creds = await readFile(new URL('../src/runners/creds.mjs', import.meta.url), 'utf8');
  assert.match(creds, /if \(runner === 'http'\) return \{ env: \{ ARGO_HTTP_KEY: v \}, authType: 'apikey' \};/);
  assert.match(creds, /if \(runner === 'http'\) return v \? \{ ok: true \} : \{ ok: false, reason: 'format' \};/);
});

test('format openai-chat — 헤르메스 API 서버(/v1/chat/completions) 모양으로 보내고 choices[0].message.content를 읽는다(헤르메스 쪽 변경 0)', async () => {
  assert.deepEqual(buildHttpTextRequest({ format: 'openai-chat', prompt: 'p', model: '' }), { model: 'default', messages: [{ role: 'user', content: 'p' }], stream: false });
  assert.equal(parseHttpTextResponse('openai-chat', JSON.stringify({ choices: [{ message: { role: 'assistant', content: '답' } }] })), '답');
  assert.equal(parseHttpTextResponse('openai-chat', JSON.stringify({ choices: [{ message: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } }] })), 'ab', '배열 content');
  assert.equal(parseHttpTextResponse('argo', '{"text":"t"}'), 't');
  const f = await fake((req, res) => json(res, 200, { id: 'x', choices: [{ index: 0, message: { role: 'assistant', content: `echo:${JSON.parse('{}') && ''}${req.headers.authorization}` } }] }));
  try {
    const out = await execHttpText({ endpoint: f.url, format: 'openai-chat', prompt: '안녕', model: 'hermes', timeoutMs: 5000, cred: { env: { ARGO_HTTP_KEY: 'k' } } });
    assert.equal(out, 'echo:Bearer k'); assert.deepEqual(f.seen[0].body, { model: 'hermes', messages: [{ role: 'user', content: '안녕' }], stream: false });
  } finally { await f.close(); }
  await assert.rejects(execHttpText({ endpoint: 'http://127.0.0.1:9/x', format: 'nope', prompt: 'x', timeoutMs: 1000 }), /format/);
});

test('목적지 가드(HIGH-3) — userinfo 금지·공인 호스트 https 강제·루프백/사설망 http 허용·호스팅 런타임 차단·리다이렉트 거절', async () => {
  assert.equal(assertHttpTextEndpoint('http://127.0.0.1:8642/v1/chat/completions'), 'http://127.0.0.1:8642/v1/chat/completions');
  for (const ok of ['http://localhost:8642/x', 'http://10.0.0.5/x', 'http://192.168.1.2/x', 'http://172.16.0.9/x', 'http://[::1]:1/x', 'http://hermes.local/x', 'https://agent.example.com/v1']) assert.doesNotThrow(() => assertHttpTextEndpoint(ok), ok);
  await assert.rejects(async () => assertHttpTextEndpoint('http://agent.example.com/v1'), /https/);
  await assert.rejects(async () => assertHttpTextEndpoint('http://8.8.8.8/v1'), /https/);
  await assert.rejects(async () => assertHttpTextEndpoint('http://user:s3cr3t@127.0.0.1/x'), (e) => /사용자명/.test(e.message) && !/s3cr3t/.test(e.message), 'userinfo 거절 + 비밀번호 미노출');
  await assert.rejects(async () => assertHttpTextEndpoint('ftp://127.0.0.1/x'), /http:\/\/ 또는 https:\/\//);
  await assert.rejects(async () => assertHttpTextEndpoint('https://agent.example.com/v1', { hosted: true }), /호스팅|hosted/);
  // 리다이렉트: 302가 POST를 GET으로 바꿔 프롬프트 없이 200을 답으로 채택하던 경로 — **도달 가능한** 목적지로 거절을 실증(2차 검수 M-1: 닿지 않는 목적지는 follow여도 status 0)
  const target = await fake((req, res) => json(res, 200, { text: 'REDIRECTED-ANSWER' }));
  const f = await fake((req, res) => { res.writeHead(302, { location: target.url }); res.end(); });
  try {
    await assert.rejects(execHttpText({ endpoint: f.url, prompt: 'x', timeoutMs: 3000 }), (e) => /^API Error: 0 /.test(e.message) && /redirect/i.test(e.message));
    assert.equal(target.seen.length, 0, '리다이렉트 목적지에 닿지 않는다');
  } finally { await f.close(); await target.close(); }
  await assert.rejects(async () => assertHttpTextEndpoint('http://169.254.169.254/latest/meta-data'), /허용되지 않는 목적지|not an allowed/, '링크로컬 메타데이터 차단(HIGH-C)');
  await assert.rejects(async () => assertHttpTextEndpoint('http://0.0.0.0/x'), /허용되지 않는/);
});

test('응답 상한(MEDIUM-1) — 바이트로 세며 읽다가 넘기면 끊는다(전량 버퍼링 없음), content-length 선차단, 배열 content 병합', async () => {
  const big = 'x'.repeat(50_000);
  let sent = 0; let closed = false;
  const f = await fake((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); req.on('close', () => { closed = true; }); const pump = () => { while (!closed && sent < 400) { sent++; if (!res.write(big)) { res.once('drain', pump); return; } } if (!closed) res.end(); }; pump(); });
  try {
    await assert.rejects(execHttpText({ endpoint: f.url, prompt: 'x', timeoutMs: 20_000, maxBody: 120_000 }), (e) => e.timedOut !== true && e.httpStatus === undefined && /상한/.test(e.message) && /cap/.test(e.message), '캡 오류(시간 초과 아님 — 2차 검수 M-1: 시간 초과 문구도 "상한"을 포함해 술어를 통과시켰다)');
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(closed && sent < 400, `상한에서 연결을 끊는다 — 서버가 400건(20MB)을 다 보내기 전에 닫힘(sent=${sent}, closed=${closed})`);
  } finally { await f.close(); }
  const g = await fake((req, res) => { res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '999999' }); res.end('short'); });
  try { await assert.rejects(execHttpText({ endpoint: g.url, prompt: 'x', timeoutMs: 5000, maxBody: 1000 }), /상한/); } finally { await g.close(); }
  assert.equal(parseHttpTextResponse('argo', JSON.stringify({ content: [{ type: 'text', text: 'a' }, 'b'] })), 'ab');
  assert.equal(parseHttpTextResponse('argo', JSON.stringify(['x', { text: 'y' }])), 'xy', '최상위 배열도 텍스트로');
});

test('호스팅 판정은 market.mjs arbitraryMcpBlocked와 같은 술어(HIGH-C) — env 행렬에서 일치', async () => {
  const { httpRunnerBlockedHere } = await import('../src/runners/http-text.mjs');
  const { arbitraryMcpBlocked } = await import('../src/market.mjs');
  const saved = { ...process.env };
  try {
    for (const env of [{ ARGO_TENANT_OWNER: 'svc' }, { ARGO_STANDALONE: '1' }, { ARGO_ALLOW_CUSTOM_MCP: '1' }, {}]) {
      for (const k of ['ARGO_TENANT_OWNER', 'ARGO_STANDALONE', 'ARGO_ALLOW_CUSTOM_MCP']) delete process.env[k];
      Object.assign(process.env, env);
      assert.equal(await httpRunnerBlockedHere(), arbitraryMcpBlocked(), JSON.stringify(env));
    }
  } finally { for (const k of ['ARGO_TENANT_OWNER', 'ARGO_STANDALONE', 'ARGO_ALLOW_CUSTOM_MCP']) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
});
