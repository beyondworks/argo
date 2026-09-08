// HTTP 텍스트 러너(부록 N) — 외부 에이전트 엔드포인트를 회사 크루의 두뇌로. 가짜 HTTP 서버로 계약을 잠근다:
// 요청 모양(Bearer·JSON 필드)·응답 3형(JSON text/reply, text/plain)·오류 계급(401 → API Error: 401 = 게이트 열쇠)·상한·중단·엔드포인트 부재.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { execHttpText } from '../src/runners/http-text.mjs';
import { externalExec } from '../src/runners.mjs';
import { RUNNERS, RUNNER_AUTH, isCliRunner, isCliTurn, isHiddenRunner, pickRunner } from '../src/runners/catalog.mjs';

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
    assert.equal(f.seen[0].headers.authorization, 'Bearer k-1'); assert.deepEqual(f.seen[0].body, { prompt: '안녕', model: 'm1', cwd: '/w', kind: 'chat', readOnly: false });
    await execHttpText({ endpoint: f.url, prompt: 'x', timeoutMs: 5000, cred: null });
    assert.equal(f.seen[1].headers.authorization, undefined, '자격 없으면 Bearer를 만들지 않는다'); assert.equal(f.seen[1].body.model, undefined, '모델 미지정은 필드 생략');
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
    const t0 = Date.now(); await assert.rejects(execHttpText({ endpoint: f.url, prompt: 'x', timeoutMs: 1000 }), (e) => /API Error: 0 (TimeoutError|AbortError)/.test(e.message)); assert.ok(Date.now() - t0 < 2500);
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
    await assert.rejects(externalExec({ runner: 'http', model: '', cwd: '/w', prompt: 'p', timeoutMs: 5000, cred: null, endpoint: f.url }), /empty-reply|응답/);
  } finally { await f.close(); }
  const g = await fake((req, res) => json(res, 401, { error: 'nope' }));
  try { await assert.rejects(externalExec({ runner: 'http', model: '', cwd: '/w', prompt: 'p', timeoutMs: 5000, cred: null, endpoint: g.url }), (e) => /^API Error: 401/.test(e.message)); } finally { await g.close(); }
});

test('카탈로그 핀 — http는 숨김·CLI 종류·자동 선택 제외·명시 지정은 존중, antigravity는 여전히 RUNNER_AUTH 맨 끝', () => {
  assert.equal(RUNNERS.http.kind, 'cli'); assert.equal(isHiddenRunner('http'), true); assert.equal(isCliRunner('http'), true); assert.equal(isCliTurn('http', 'apikey'), true);
  assert.deepEqual(RUNNER_AUTH.http.methods, ['apikey']);
  assert.equal(Object.keys(RUNNER_AUTH).at(-1), 'antigravity', '자동 선택 순서 — antigravity 맨 끝(분리 검수 H1a)');
  const st = { http: { company: { connected: true, type: 'apikey' } }, claude: { company: { connected: false } } };
  assert.equal(pickRunner(st, null).available, false, '자동 선택은 숨김 http를 잡지 않는다');
  assert.equal(pickRunner(st, 'http').runner, 'http', '카드가 명시하면 돈다');
});

test('배선 핀 — chat.mjs의 externalExec 두 호출이 카드 endpoint를 넘기고, creds가 http 자격을 Bearer env로 조립한다', async () => {
  const chat = await readFile(new URL('../src/chat.mjs', import.meta.url), 'utf8');
  assert.equal((chat.match(/externalExec\(\{ runner, [^\n]*endpoint: meta\.endpoint \?\? ''/g) ?? []).length, 2, 'CLI 턴 호출 2곳(본 턴·게이트 모델 강등 재시도)');
  const creds = await readFile(new URL('../src/runners/creds.mjs', import.meta.url), 'utf8');
  assert.match(creds, /if \(runner === 'http'\) return \{ env: \{ ARGO_HTTP_KEY: v \}, authType: 'apikey' \};/);
  assert.match(creds, /if \(runner === 'http'\) return v \? \{ ok: true \} : \{ ok: false, reason: 'format' \};/);
});
