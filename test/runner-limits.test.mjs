// 러너 잔여 한도(K91, 유건 지시 2026-09-22) — 금액 대신 구독 계정의 사용 한도 창을 보인다. 정확히 얻을 수 있는 두 러너만:
// ① Claude 구독 OAuth — 실제 SDK를 로컬 가짜 Messages 엔드포인트로 돌려 anthropic-ratelimit-unified-* 헤더 → rate_limit_event → 저장.
// ② Codex ChatGPT 로그인 — 가짜 codex가 CODEX_HOME에 rollout을 쓰면, 턴 뒤(임시 홈 삭제 전) 마지막 token_count.rate_limits → 저장.
// 표시 쪽은 회사가 쓰는 자격의 계정 키로 찾는다(같은 계정을 여러 회사가 공유). API 키 자격은 보이지 않는다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from './helpers/tmp.mjs';

const base = await mkdtemp(join(tmpdir(), 'argo-runner-limits-'));
after(() => rm(base, { recursive: true, force: true }));
const home = join(base, 'home');
Object.assign(process.env, { ARGO_ROOT: join(base, 'root'), HOME: home, USERPROFILE: home, TMPDIR: join(base, 'tmp'),
  ARGO_ENC_VAULT: '0', ARGO_MODEL_CATALOG: 'off', ARGO_NATIVE_RUNNERS: 'off' });
for (const key of ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']) delete process.env[key];
for (const d of [process.env.ARGO_ROOT, home, process.env.TMPDIR]) await mkdir(d, { recursive: true });

const NOW = Math.floor(Date.now() / 1000);
let limitHeaders = {};
const sse = (res, evs) => { res.writeHead(200, { 'content-type': 'text/event-stream', ...limitHeaders }); for (const [e, d] of evs) res.write(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`); res.end(); };
const srv = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
    if (req.method === 'POST' && req.url.startsWith('/v1/messages')) {
      return sse(res, [['message_start', { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'claude-x', content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } }],
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } }], ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }], ['message_stop', { type: 'message_stop' }]]);
    }
    if (req.url === '/api/monitor/usage/quota/limit') { // 가짜 Z.ai 모니터 — opencode-glm-quota가 읽는 모양 그대로
      glmHits.push(req.headers.authorization);
      const body = glmReplies[req.headers.authorization];
      res.writeHead(body ? 200 : 401, { 'content-type': 'application/json' }); return res.end(JSON.stringify(body ?? { code: 401 }));
    }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}');
  });
});
const glmHits = [];
const glmReplies = {};
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
process.env.ARGO_CLAUDE_BASE_URL = `http://127.0.0.1:${srv.address().port}`;
after(() => srv.close());

const { createCompany, paths } = await import('../src/workspace.mjs');
const { saveRunnerCred } = await import('../src/runners/creds.mjs');
const { chat } = await import('../src/chat.mjs');
const { externalExec } = await import('../src/runners.mjs');
const { readRunnerLimits } = await import('../src/runner-limits.mjs');

const crew = async (ws, runner) => {
  await createCompany(ws, ws, 'owner', null, 'ko');
  await mkdir(paths(ws).agents, { recursive: true });
  await writeFile(join(paths(ws).agents, 'x.md'), `---\nname: 엑스\nrole: 검증\nrunner: ${runner}\n---\n검증용.\n`);
};
const TOKEN_A = `sk-ant-oat01-${'a'.repeat(90)}`; // 형식만 맞춘 가짜 — 요청은 로컬 가짜 엔드포인트로만 간다
const HOUR = 3_600_000;

test('Claude 구독 OAuth 턴 — rate-limit 헤더의 5시간·7일 사용률(비율 → %)·리셋이 계정 단위로 저장되고, 같은 토큰의 다른 회사에서도 읽힌다', async () => {
  limitHeaders = {
    'anthropic-ratelimit-unified-status': 'allowed',
    'anthropic-ratelimit-unified-5h-utilization': '0.42', 'anthropic-ratelimit-unified-5h-reset': String(NOW + 3600),
    'anthropic-ratelimit-unified-7d-utilization': '0.26', 'anthropic-ratelimit-unified-7d-reset': String(NOW + 86400 * 6),
    'anthropic-ratelimit-unified-reset': String(NOW + 3600), 'anthropic-ratelimit-unified-representative-claim': 'five_hour',
  };
  await crew('lim-a', 'claude');
  await saveRunnerCred('lim-a', 'claude', 'oauth', TOKEN_A);
  await chat('lim-a', 'x', '안녕', null, {});
  const [got, ...rest] = await readRunnerLimits('lim-a');
  assert.equal(rest.length, 0);
  assert.equal(got?.runner, 'claude', '구독 OAuth 턴의 한도가 저장되지 않았다');
  assert.deepEqual(got.windows.map((w) => [w.mins, w.pct]), [[300, 42], [10080, 26]]);
  assert.ok(got.windows[0].resetsInMs > 0 && got.windows[0].resetsInMs <= HOUR + 5000, '5시간 창 리셋까지 남은 시간');
  assert.ok(got.ageMs >= 0 && got.ageMs < 60_000);
  // 같은 계정(토큰)을 쓰는 다른 회사 — 턴 없이도 같은 값
  await crew('lim-b', 'claude');
  await saveRunnerCred('lim-b', 'claude', 'oauth', TOKEN_A);
  assert.deepEqual((await readRunnerLimits('lim-b')).map((l) => l.windows.map((w) => w.pct)), [[42, 26]]);
  // 다른 계정 — 남의 값이 보이지 않는다
  await crew('lim-c', 'claude');
  await saveRunnerCred('lim-c', 'claude', 'oauth', `sk-ant-oat01-${'c'.repeat(90)}`);
  assert.deepEqual(await readRunnerLimits('lim-c'), []);
});

test('Claude API 키 자격 — 한도를 표시하지 않는다', async () => {
  await crew('lim-key', 'claude');
  await saveRunnerCred('lim-key', 'claude', 'apikey', `sk-ant-api03-${'k'.repeat(80)}`);
  await chat('lim-key', 'x', '안녕', null, {});
  assert.deepEqual(await readRunnerLimits('lim-key'), []);
});

test('Codex ChatGPT 로그인 턴 — 임시 CODEX_HOME rollout의 마지막 token_count.rate_limits가 저장된다', { skip: process.platform === 'win32' }, async () => {
  // 호스트 로그인(~/.codex/auth.json) — ChatGPT 계정 id가 계정 키
  await mkdir(join(home, '.codex'), { recursive: true });
  await writeFile(join(home, '.codex', 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'a.b.c', refresh_token: 'r', account_id: 'acct-1' } }));
  const bin = join(base, 'bin');
  await mkdir(bin, { recursive: true });
  const tc = (primary, secondary) => JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'token_count', info: null, rate_limits: { limit_id: 'codex', primary, secondary } } });
  const lines = [
    tc({ used_percent: 1, window_minutes: 300, resets_at: NOW + 100 }, null), // 옛 값 — 마지막 것이 이긴다
    tc({ used_percent: 12, window_minutes: 300, resets_at: NOW + 7200 }, { used_percent: 55.4, window_minutes: 10080, resets_at: NOW + 86400 * 3 + 7200 }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'hi' } }),
  ].join('\n');
  await writeFile(join(bin, 'codex'), `#!/usr/bin/env node
const fs = require('fs'); const path = require('path');
const a = process.argv.slice(2);
if (a[0] === '--version') { console.log('fake-codex'); process.exit(0); }
process.stdin.resume(); process.stdin.on('end', () => {
  const d = path.join(process.env.CODEX_HOME, 'sessions', '2026', '09', '22');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'rollout-2026-09-22T00-00-00-x.jsonl'), ${JSON.stringify(lines)} + '\\n');
  fs.writeFileSync(a[a.indexOf('--output-last-message') + 1], 'ok');
});
`);
  await chmod(join(bin, 'codex'), 0o755);
  process.env.PATH = `${bin}:${process.env.PATH}`;
  process.env.ARGO_CODEX_PREFER_PATH = '1';
  assert.equal(execFileSync('codex', ['--version'], { env: process.env }).toString().trim(), 'fake-codex', 'codex는 가짜여야 한다');
  const cwd = join(base, 'cwd'); await mkdir(cwd, { recursive: true });
  assert.equal(await externalExec({ runner: 'codex', cwd, prompt: 'hi', timeoutMs: 60_000 }), 'ok');
  await crew('lim-cx', 'codex');
  // host 마커 — saveRunnerCred는 codex CLI 조달(~100MB 다운로드)을 띄우므로 저장 파일을 직접 쓴다(같은 모양)
  await writeFile(join(paths('lim-cx').root, '.secrets.json'), JSON.stringify({ runners: { codex: { type: 'host', value: 'host' } } }));
  const [got] = await readRunnerLimits('lim-cx');
  assert.equal(got?.runner, 'codex', '턴 뒤 rollout의 한도가 저장되지 않았다');
  assert.deepEqual(got.windows.map((w) => [w.mins, w.pct]), [[300, 12], [10080, 55]]);
  assert.ok(got.windows[1].resetsInMs > 3 * 86400_000 && got.windows[1].resetsInMs <= 3 * 86400_000 + 2 * HOUR + 5000);
});

test('오래된 값 — ageMs로 "N시간 전 기준"을 붙일 수 있고, 리셋이 지난 창은 뺀다', async () => {
  const later = Date.now() + 2 * HOUR; // 5시간 창(1시간 뒤 리셋)은 지났고 7일 창은 남았다
  const [got] = await readRunnerLimits('lim-a', later);
  assert.deepEqual(got.windows.map((w) => w.mins), [10080]);
  assert.ok(got.ageMs >= 2 * HOUR);
});

test('GLM 코딩 플랜 키 — 턴 없이 모니터 엔드포인트를 읽어 5시간·주간 창을 싣고, 키는 턴과 같은 origin에 원문 그대로 간다', async () => {
  process.env.GLM_BASE_URL = `http://127.0.0.1:${srv.address().port}/api/anthropic`;
  await crew('lim-glm', 'glm');
  const KEY = 'glm-plan-key-1';
  const reset = Date.now() + 2 * HOUR;
  glmReplies[KEY] = { code: 200, data: { limits: [
    { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 37.6, nextResetTime: reset },
    { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 81, nextResetTime: reset + 3 * 86400_000 },
    { type: 'TIME_LIMIT', unit: 5, number: 1, percentage: 10, currentValue: 3, usage: 100 }, // MCP 월간 횟수 — 싣지 않는다
  ] } };
  await saveRunnerCred('lim-glm', 'glm', 'apikey', KEY);
  const got = (await readRunnerLimits('lim-glm')).find((l) => l.runner === 'glm');
  assert.deepEqual(got?.windows.map((w) => [w.mins, w.pct]), [[300, 38], [10080, 81]]);
  assert.ok(got.windows[0].resetsInMs > HOUR && got.windows[0].resetsInMs <= 2 * HOUR);
  assert.equal(glmHits.at(-1), KEY, 'Authorization이 키 원문이 아니다(Bearer 접두 등)');
  const n = glmHits.length;
  await readRunnerLimits('lim-glm');
  assert.equal(glmHits.length, n, '60초 캐시 안에서 다시 조회했다');
});

test('GLM 종량제 키(모니터가 거절) — 조회는 하되 게이지를 만들지 않는다', async () => {
  await crew('lim-glm-paygo', 'glm');
  await saveRunnerCred('lim-glm-paygo', 'glm', 'apikey', 'glm-paygo-key');
  assert.deepEqual(await readRunnerLimits('lim-glm-paygo'), []);
  assert.ok(glmHits.includes('glm-paygo-key'), '조회 자체를 하지 않았다 — 거절 경로가 검증되지 않음');
});
