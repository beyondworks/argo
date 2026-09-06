// 원샷(루틴·크루 카드 생성·기억 정리·브리핑) 경로의 네이티브 엔진 분기(P-A') — 같은 러너의 두 경로(대화·원샷)가 같은 엔진을 쓴다.
// 실벤더 호출 0: OPENROUTER_BASE_URL을 가짜 Messages 서버로 돌린다(runnerCredEnv가 ANTHROPIC_BASE_URL로 삼는다).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { mkdtemp } from './helpers/tmp.mjs';

process.env.HOME = await mkdtemp(join(tmpdir(), 'argo-native-os-home-'));
process.env.USERPROFILE = process.env.HOME;
process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-native-os-'));
process.env.ARGO_MODEL_CATALOG = 'off';
delete process.env.ARGO_NATIVE_RUNNERS; // 기본 on 경로
const ROOT = fileURLToPath(new URL('..', import.meta.url));

async function fakeMessages(script) {
  const bodies = [];
  const srv = createServer((req, res) => {
    let d = ''; req.on('data', (c) => { d += c; });
    req.on('end', () => {
      bodies.push(JSON.parse(d || '{}'));
      const step = script[Math.min(bodies.length - 1, script.length - 1)];
      const out = typeof step === 'function' ? step(bodies.at(-1), bodies.length) : step;
      if (out.hang) return; // 응답 없음(hang 상한 검증)
      res.writeHead(out.status ?? 200, { 'content-type': 'application/json' }); res.end(JSON.stringify(out.json ?? out));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${srv.address().port}`, bodies, close: () => new Promise((r) => srv.close(r)) };
}
const msg = (text) => ({ id: 'm', type: 'message', role: 'assistant', model: 'fake/model', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 7, output_tokens: 3 } });

const { createCompany } = await import('../src/workspace.mjs');
const { saveRunnerCred } = await import('../src/runners/creds.mjs');
const { runOneShot } = await import('../src/oneshot.mjs');
const { OPENROUTER_ONBOARD_MODEL } = await import('../src/runners.mjs');

test('OS1. 기본 on 러너(openrouter)의 원샷이 네이티브 엔진으로 돈다 — 도구 없음·모델 강등 동일·usage 기록·costUsd null', async () => {
  const ws = 'os1'; await createCompany(ws, '원샷', '사장'); await saveRunnerCred(ws, 'openrouter', 'apikey', 'fake-or-key-1234567890');
  const srv = await fakeMessages([msg('직함: QA 리드')]);
  process.env.OPENROUTER_BASE_URL = srv.base;
  try {
    const r = await runOneShot(ws, '직함을 추천해', { model: 'claude-haiku-4-5', timeoutMs: 20_000 });
    assert.equal(r.runner, 'openrouter'); assert.equal(r.text, '직함: QA 리드'); assert.equal(r.costUsd, null); assert.equal(r.usage.input_tokens, 7);
    const b = srv.bodies[0];
    assert.equal(b.model, OPENROUTER_ONBOARD_MODEL, '카탈로그 밖 모델(claude-haiku)은 온보딩 모델로 강등 — SDK 경로와 같은 규칙');
    assert.equal(b.tools, undefined, '원샷은 도구 없음'); assert.equal(b.messages.length, 1); assert.equal(b.messages[0].content, '직함을 추천해');
  } finally { await srv.close(); delete process.env.OPENROUTER_BASE_URL; }
});

test('OS2. 벤더 401은 러너별 원인 대장으로 정직하게 실패한다(자가치유 대상 러너가 없을 때) + hang 상한은 sdk-timeout 문구', async () => {
  const ws = 'os2'; await createCompany(ws, '원샷2', '사장'); await saveRunnerCred(ws, 'openrouter', 'apikey', 'fake-or-key-1234567890');
  const srv = await fakeMessages([{ status: 401, json: { error: { message: 'invalid api key' } } }]);
  process.env.OPENROUTER_BASE_URL = srv.base;
  try {
    await assert.rejects(runOneShot(ws, 'x', { timeoutMs: 20_000 }), (e) => { assert.match(e.message, /러너별 원인: OpenRouter: .*401/); return true; });
    assert.equal(srv.bodies.length, 1, '401은 재시도하지 않는다');
  } finally { await srv.close(); }
  const hang = await fakeMessages([{ hang: true }]);
  process.env.OPENROUTER_BASE_URL = hang.base;
  try {
    await assert.rejects(runOneShot(ws, 'x', { timeoutMs: 1500 }), (e) => { assert.match(e.message, /sdk-timeout|응답이 끝나지 않아/); return true; });
  } finally { await hang.close(); delete process.env.OPENROUTER_BASE_URL; }
});

test('OS3. 배선 핀 — oneshot.mjs가 플래그 러너를 nativeOneShot로 가르고 모델 선택은 두 엔진 공용(osModel)', async () => {
  const src = await readFile(join(ROOT, 'src', 'oneshot.mjs'), 'utf8');
  assert.match(src, /if \(nativeRunnerEnabled\(runner\)\) \{\n[\s\S]*?try \{ r = await nativeOneShot\(\{ env: sdkEnv, model: osModel, prompt, signal: ac\.signal, lang \}\); \}/);
  // 네이티브 실패도 openrouter-credit/limit 접두로 승격(분리 검수 3R HIGH-2 — 승격 없이는 429가 말없이 타 벤더로 갈아탄다)
  assert.match(src, /if \(runner === 'openrouter' && isOpenRouterLimitError\(t\)\) throw Object\.assign\(new Error\(`openrouter-limit: \$\{t\.slice\(0, 140\)\}`\), \{ cause: e \}\);/);
  assert.match(src, /\} else for await \(const msg of query\(\{/, '구 경로(SDK) 폴백 유지');
  assert.equal((src.match(/osModel/g) ?? []).length >= 3, true, '모델 선택 한 곳 정의·두 엔진 사용');
  assert.match(src, /\.\.\.\(osModel \? \{ model: osModel \} : \{\}\),/);
});

test('OS4. 네이티브 원샷의 OpenRouter 429는 요청 한도 안내로 정직하게 실패한다 — 타 벤더 자가치유로 갈아타지 않는다(3R HIGH-2)', async () => {
  const ws = 'os4'; await createCompany(ws, '원샷4', '사장'); await saveRunnerCred(ws, 'openrouter', 'apikey', 'fake-or-key-1234567890');
  const srv = await fakeMessages([{ status: 429, json: { error: { message: 'Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day', code: 429 } } }]);
  process.env.OPENROUTER_BASE_URL = srv.base;
  try {
    await assert.rejects(runOneShot(ws, '직함을 추천해', { timeoutMs: 20_000 }), (e) => { assert.match(e.message, /요청 한도|rate limit/i, `429 안내: ${e.message}`); return true; });
    assert.equal(srv.bodies.length, 1, '재시도 폭주 없음(429는 기다리면 풀린다)');
  } finally { await srv.close(); delete process.env.OPENROUTER_BASE_URL; }
});
