// HTTP 텍스트 러너(runner: http)를 걷어낸 뒤 — 카드에 그 값이 남은 크루는 다른 러너로 대신 돌지 않고 정직하게 멈춘다.
// 외부 에이전트는 크루의 두뇌가 아니라 메신저에 봇으로 접속한다(2026-09-08 방향, 2026-09-18 제거).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from './helpers/tmp.mjs';

process.env.HOME = await mkdtemp(join(tmpdir(), 'argo-httprt-home-'));
process.env.ARGO_ROOT = join(await mkdtemp(join(tmpdir(), 'argo-httprt-')), 'workspaces'); await mkdir(process.env.ARGO_ROOT, { recursive: true });

// 가짜 Claude 엔드포인트 — 요청 수를 센다. 거절이 없으면 runner: http 크루가 이 러너로 대신 돈다(Messages SSE 한 턴).
let hits = 0;
const fake = createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { hits++;
  if (!req.url.includes('/v1/messages')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{}'); }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const ev = (t, d) => res.write(`event: ${t}\ndata: ${JSON.stringify({ type: t, ...d })}\n\n`);
  ev('message_start', { message: { id: 'm1', type: 'message', role: 'assistant', model: 'claude-x', content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } });
  ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
  ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'CLAUDE가 대신 답함' } });
  ev('content_block_stop', { index: 0 }); ev('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }); ev('message_stop', {}); res.end(); }); });
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
process.env.ARGO_CLAUDE_BASE_URL = `http://127.0.0.1:${fake.address().port}`;
test.after(() => fake.close());

const { createCompany, updateCompany, paths } = await import('../src/workspace.mjs');
const { saveRunnerCred } = await import('../src/runners/creds.mjs');
const { chat } = await import('../src/chat.mjs');
const { RUNNERS, RUNNER_AUTH, pickRunner, isRetiredRunner } = await import('../src/runners/catalog.mjs');

test('카탈로그에서 http 러너가 사라졌다 — 목록·자격·제공 종료 판정 어디에도 없다', () => {
  assert.equal(RUNNERS.http, undefined);
  assert.equal(RUNNER_AUTH.http, undefined);
  assert.equal(isRetiredRunner('http'), false);
});

test('거절이 필요한 이유 — 카탈로그에 없는 러너를 지정하면 pickRunner는 가용한 다른 러너로 넘긴다', () => {
  // 이것이 "외부 에이전트 크루가 다른 두뇌로 답하는" 경로다. 그래서 chat()이 해석 전에 멈춰야 한다.
  const st = { claude: { company: { connected: true } } };
  const r = pickRunner(st, 'http');
  assert.equal(r.runner, 'claude');
  assert.equal(r.fellBack, true);
});

async function crewOn(ws, lang) {
  await createCompany(ws, '회사', '사장');
  if (lang) await updateCompany(ws, { lang });
  await writeFile(join(paths(ws).agents, 'ext.md'), '---\nname: 외부\nrunner: http\nendpoint: http://127.0.0.1:9/v1\n---\n외부 에이전트 크루\n');
}

test('runner: http 크루의 턴은 러너를 해석하기 전에 정직하게 멈춘다(ko)', async () => {
  await crewOn('rt-ko');
  await assert.rejects(chat('rt-ko', 'ext', '안녕'), (e) => {
    assert.match(e.message, /외부 에이전트\(HTTP\)로 실행하도록 설정돼 있는데, 이 방식은 더 이상 지원하지 않습니다/);
    assert.match(e.message, /봇으로 연결/);
    return true;
  });
});

test('runner: http 크루의 턴은 러너를 해석하기 전에 정직하게 멈춘다(en)', async () => {
  await crewOn('rt-en', 'en');
  await assert.rejects(chat('rt-en', 'ext', 'hi'), (e) => {
    assert.match(e.message, /external agent over HTTP, which is no longer supported/);
    assert.match(e.message, /as a bot/);
    return true;
  });
});

test('가용 러너(claude)가 연결돼 있어도 runner: http 크루는 대신 돌지 않는다 — 엔드포인트 요청 0건', async () => {
  // 핵심 주장. 러너가 하나도 없는 회사에서는 거절 줄이 없어도 "러너 연결 필요"로 실패하므로 이 주장을 증명하지 못한다.
  await crewOn('rt-claude');
  await saveRunnerCred('rt-claude', 'claude', 'apikey', 'sk-ant-api03-' + 'x'.repeat(40)); // 가짜 키 — 가짜 엔드포인트로만 간다
  const before = hits;
  await assert.rejects(chat('rt-claude', 'ext', '안녕'), /더 이상 지원하지 않습니다/);
  assert.equal(hits - before, 0, '거절 전에 다른 러너로 요청이 나가면 안 된다');
});
