// Opus 5.5(claude-opus-5-5) — 유건 요청 2026-09-23. 실턴: SDK 0.3.280(CLI 2.1.280)에서 5.5·5.5[1m]·Opus 5·Fable 5.1·Sonnet 5 모두 응답,
// SDK 0.3.258은 400 "2.1.280 이상 필요". Opus 5.5는 effort 기본이 medium(Opus 5는 high) — 크루에 effort가 없으면 high를 보내
// Opus 5와 같은 깊이를 유지한다(유건 결정). 크루가 고른 effort는 그대로. 실제 SDK를 로컬 가짜 Messages 엔드포인트로 돌려 요청 본문을 본다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from './helpers/tmp.mjs';

const root = await mkdtemp(join(tmpdir(), 'argo-opus55-'));
const home = await mkdtemp(join(tmpdir(), 'argo-opus55-home-'));
Object.assign(process.env, { ARGO_ROOT: root, HOME: home, USERPROFILE: home, ARGO_ENC_VAULT: '0', ARGO_MODEL_CATALOG: 'off', ARGO_NATIVE_RUNNERS: 'off' });
for (const key of ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']) delete process.env[key];

let seen = [];
const sse = (res, evs) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); for (const [e, d] of evs) res.write(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`); res.end(); };
const srv = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
    if (req.method === 'POST' && req.url.startsWith('/v1/messages')) {
      const body = JSON.parse(b || '{}');
      if ((body.tools ?? []).length) seen.push({ model: body.model, effort: body.output_config?.effort ?? null }); // 제목 생성 같은 도구 없는 곁요청은 뺀다
      return sse(res, [['message_start', { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } }],
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } }], ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }], ['message_stop', { type: 'message_stop' }]]);
    }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}');
  });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
process.env.ARGO_CLAUDE_BASE_URL = `http://127.0.0.1:${srv.address().port}`;
after(() => srv.close());

const { RUNNERS, defaultClaudeEffort } = await import('../src/runners/catalog.mjs');
const { createCompany, paths } = await import('../src/workspace.mjs');
const { saveRunnerCred } = await import('../src/runners/creds.mjs');
const { chat } = await import('../src/chat.mjs');
const ws = 'opus55';
await createCompany(ws, '오퍼스', 'owner', null, 'ko');
const p = paths(ws);
await mkdir(p.agents, { recursive: true });
const card = (slug, model, effort = '') => writeFile(join(p.agents, `${slug}.md`), `---\nname: ${slug}\nrole: 검증\nrunner: claude\nmodel: ${model}\n${effort ? `effort: ${effort}\n` : ''}---\n검증용.\n`);
await card('a', 'claude-opus-5-5');
await card('b', 'claude-opus-5-5', 'low');
await saveRunnerCred(ws, 'claude', 'apikey', `sk-ant-api03-${'x'.repeat(80)}`); // 형식만 맞춘 가짜 — 요청은 로컬 가짜 엔드포인트로만 간다

test('카탈로그: Opus 5.5·Opus 5.5 (1M)가 Opus 5 바로 위에 있고, Claude 기본(models[0])은 Fable 5.1 그대로', () => {
  const ids = RUNNERS.claude.models.map((m) => m.id);
  assert.equal(ids[0], 'claude-fable-5-1', '러너 전환 기본값이 바뀌었다');
  const i55 = ids.indexOf('claude-opus-5-5'); const i55m = ids.indexOf('claude-opus-5-5[1m]'); const i5 = ids.indexOf('claude-opus-5');
  assert.ok(i55 >= 0 && i55m >= 0, 'Opus 5.5가 목록에 없다 — 목록 밖 모델은 서버가 기본값으로 바꾼다');
  assert.ok(i55 < i5 && i55m < i5, 'Opus 5.5가 Opus 5 위에 있지 않다');
  assert.equal(RUNNERS.claude.models[i55].label, 'Opus 5.5');
});

test('effort 기본값 판정: Opus 5.5만 high, 다른 모델은 Argo가 끼워 넣지 않는다(빈 값 = SDK 기본, 이번 변경 전과 같음)', () => {
  assert.equal(defaultClaudeEffort('claude-opus-5-5'), 'high');
  assert.equal(defaultClaudeEffort('claude-opus-5-5[1m]'), 'high');
  for (const m of ['claude-opus-5', 'claude-opus-5[1m]', 'claude-fable-5-1', 'claude-sonnet-5', '', null]) assert.equal(defaultClaudeEffort(m), '', `${m}에 기본 effort를 끼워 넣었다`);
});

test('실제 SDK 요청: Opus 5.5 크루(effort 미지정) → output_config.effort=high, 크루가 low를 고르면 low 그대로', async () => {
  seen = []; await chat(ws, 'a', '안녕', null, {});
  assert.ok(seen.length, 'SDK 요청이 가짜 엔드포인트에 오지 않았다');
  assert.deepEqual([seen[0].model, seen[0].effort], ['claude-opus-5-5', 'high'], 'effort 미지정 Opus 5.5가 medium 기본으로 돌았다');
  seen = []; await chat(ws, 'b', '안녕', null, {});
  assert.deepEqual([seen[0].model, seen[0].effort], ['claude-opus-5-5', 'low'], '크루가 고른 effort를 덮어썼다');
});
