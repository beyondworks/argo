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
process.env.ARGO_CACHE_DIR = await mkdtemp(join(tmpdir(), 'argo-native-os-cache-')); // 오버레이 디스크 캐시 격리 — 실 ~/.argo/cache 오염 금지(분리 검수 L-3)
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

test('OS1b. 원격 오버레이 alias가 원샷 모델을 돌려세운다 — 지정 id·온보딩 기본 상수 둘 다(2026-09-08 minimax-m3:free 404 실사고)', async () => {
  const { loadRemoteCatalog, _resetForTest } = await import('../src/runners/catalog-remote.mjs');
  const ws = 'os1b'; await createCompany(ws, '원샷b', '사장'); await saveRunnerCred(ws, 'openrouter', 'apikey', 'fake-or-key-1234567890');
  // 두 alias의 목적지를 다르게 — 같으면 '지정 id alias 누락 → 온보딩 폴백'이 우연히 같은 값을 내 변이가 green이 된다(분리 검수 H-2)
  const overlay = { schema: 1, runners: { openrouter: { add: [{ id: 'vendor/alive:free', label: 'alive' }, { id: 'vendor/alive-b:free', label: 'alive-b' }], retire: [OPENROUTER_ONBOARD_MODEL, 'x/dead:free'], alias: { [OPENROUTER_ONBOARD_MODEL]: 'vendor/alive:free', 'x/dead:free': 'vendor/alive-b:free' } } } };
  _resetForTest();
  await loadRemoteCatalog({ fetchImpl: async () => new Response(JSON.stringify(overlay), { status: 200, headers: { 'content-type': 'application/json' } }), now: Date.now(), url: 'http://127.0.0.1:9/never' });
  const srv = await fakeMessages([msg('a'), msg('b')]);
  process.env.OPENROUTER_BASE_URL = srv.base;
  try {
    await runOneShot(ws, 'x', { model: 'x/dead:free', timeoutMs: 20_000 }); // 카드에 적힌 폐기 id → alias
    await runOneShot(ws, 'y', { model: 'claude-haiku-4-5', timeoutMs: 20_000 }); // 카탈로그 밖 → 온보딩 기본 → 그 상수도 alias
    assert.equal(srv.bodies[0].model, 'vendor/alive-b:free', '지정 폐기 id는 alias 뒤 현행 id로 나간다');
    assert.equal(srv.bodies[1].model, 'vendor/alive:free', '온보딩 기본 상수가 죽어도 오버레이 alias로 첫 영입이 산다');
  } finally { await srv.close(); delete process.env.OPENROUTER_BASE_URL; _resetForTest(); }
});

test('OS1c. 원샷이 오버레이를 스스로 로드한다(await) — 원샷 전용 프로세스에서 alias 기구가 조용히 죽지 않게(분리 검수 H-2)', async () => {
  const { _resetForTest } = await import('../src/runners/catalog-remote.mjs');
  const ws = 'os1c'; await createCompany(ws, '원샷c', '사장'); await saveRunnerCred(ws, 'openrouter', 'apikey', 'fake-or-key-1234567890');
  const overlay = { schema: 1, runners: { openrouter: { add: [{ id: 'vendor/remote:free', label: 'remote' }], retire: ['x/dead:free'], alias: { 'x/dead:free': 'vendor/remote:free' } } } };
  const cat = createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(overlay)); });
  await new Promise((r) => cat.listen(0, '127.0.0.1', r));
  const srv = await fakeMessages([msg('a')]);
  process.env.OPENROUTER_BASE_URL = srv.base;
  const savedOff = process.env.ARGO_MODEL_CATALOG; delete process.env.ARGO_MODEL_CATALOG; // 이 테스트만 실제 로더 경로(로컬 서버)
  process.env.ARGO_MODEL_CATALOG_URL = `http://127.0.0.1:${cat.address().port}/model-catalog.json`;
  _resetForTest(); // 메모리 캐시 비움 — 원샷이 직접 로드해야만 alias가 보인다
  try {
    await runOneShot(ws, 'x', { model: 'x/dead:free', timeoutMs: 20_000 });
    assert.equal(srv.bodies[0].model, 'vendor/remote:free', '원샷이 loadRemoteCatalog를 기다리지 않으면(fire-and-forget·삭제) 첫 턴은 코드 목록만 보고 폴백한다');
  } finally { await srv.close(); await new Promise((r) => cat.close(r)); delete process.env.OPENROUTER_BASE_URL; delete process.env.ARGO_MODEL_CATALOG_URL; if (savedOff === undefined) delete process.env.ARGO_MODEL_CATALOG; else process.env.ARGO_MODEL_CATALOG = savedOff; _resetForTest(); }
});

test('OS1d. 온보딩 폴백의 alias 목적지가 카탈로그에 없으면(add 누락) 카탈로그 첫 무료 모델로 — 없는 id가 벤더로 나가지 않는다(분리 검수 M-1)', async () => {
  const { loadRemoteCatalog, _resetForTest } = await import('../src/runners/catalog-remote.mjs');
  const { RUNNERS } = await import('../src/runners/catalog.mjs');
  const ws = 'os1d'; await createCompany(ws, '원샷d', '사장'); await saveRunnerCred(ws, 'openrouter', 'apikey', 'fake-or-key-1234567890');
  const overlay = { schema: 1, runners: { openrouter: { add: [], retire: [OPENROUTER_ONBOARD_MODEL], alias: { [OPENROUTER_ONBOARD_MODEL]: 'vendor/never-added:free' } } } };
  _resetForTest();
  await loadRemoteCatalog({ fetchImpl: async () => new Response(JSON.stringify(overlay), { status: 200, headers: { 'content-type': 'application/json' } }), now: Date.now(), url: 'http://127.0.0.1:9/never' });
  const srv = await fakeMessages([msg('a')]);
  process.env.OPENROUTER_BASE_URL = srv.base;
  try {
    await runOneShot(ws, 'x', { model: 'claude-haiku-4-5', timeoutMs: 20_000 });
    const firstFree = RUNNERS.openrouter.models.find((m) => m.free && m.id !== OPENROUTER_ONBOARD_MODEL)?.id; assert.ok(firstFree, '코드 카탈로그 무료 2종 이상 전제');
    assert.equal(srv.bodies[0].model, firstFree, '폴백은 유효 목록 안의 첫 무료 모델');
  } finally { await srv.close(); delete process.env.OPENROUTER_BASE_URL; _resetForTest(); }
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
  assert.match(src, /\} else for await \(const msg of __query\(\{/, '구 경로(SDK) 폴백 유지');
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

// 오피스 번역(유건 9/27: api는 안 쓴다, 본인 구독으로) — 러너를 고정하면 다른 러너·다른 자격 방식으로 넘어가지 않는다
test('OS5. only 고정 — 허용 방식의 자격이 없으면 no_subscription, 실패해도 다른 러너로 자가치유하지 않는다', { timeout: 30_000 }, async () => {
  const ws = 'os5'; await createCompany(ws, '원샷5', '사장');
  await saveRunnerCred(ws, 'claude', 'apikey', 'sk-ant-api03-fake-key-1234567890');
  await saveRunnerCred(ws, 'openrouter', 'apikey', 'fake-or-key-1234567890');
  await saveRunnerCred(ws, 'glm', 'apikey', 'fake-glm-key-1234567890');
  const or = await fakeMessages([{ status: 500, json: { type: 'error', error: { type: 'api_error', message: 'boom' } } }]);
  const glm = await fakeMessages([msg('자가치유로 온 답')]);
  process.env.OPENROUTER_BASE_URL = or.base; process.env.GLM_BASE_URL = glm.base;
  try {
    await assert.rejects(runOneShot(ws, 'x', { only: { runner: 'claude', types: ['oauth', 'host'] }, timeoutMs: 20_000 }), (e) => e.code === 'no_subscription');
    assert.equal(or.bodies.length + glm.bodies.length, 0, 'Claude API 키가 있어도, 다른 러너가 있어도 쓰지 않는다');
    const ws2 = 'os5b'; await createCompany(ws2, '원샷5b', '사장'); // Claude 자격 없이 — 자가치유가 가짜 키로 실제 Anthropic에 나가지 않게
    await saveRunnerCred(ws2, 'openrouter', 'apikey', 'fake-or-key-1234567890'); await saveRunnerCred(ws2, 'glm', 'apikey', 'fake-glm-key-1234567890');
    await assert.rejects(runOneShot(ws2, 'x', { only: { runner: 'openrouter', types: ['apikey'] }, timeoutMs: 20_000 }));
    assert.ok(or.bodies.length >= 1); assert.equal(glm.bodies.length, 0, '고정한 러너가 실패해도 GLM으로 넘어가지 않는다');
  } finally { await or.close(); await glm.close(); delete process.env.OPENROUTER_BASE_URL; delete process.env.GLM_BASE_URL; }
});

// 오피스 번역의 호스트 로그인 경로(재검수 LOW): 프로세스 env에 API 키가 있으면 SDK가 구독 대신 키로 과금할 수 있다 — API 키 방식을 허용하지 않는 고정이면 비운다.
// 러너가 다시 시작하면(크래시 재시도) 흘려받기 호출자에게 null로 알려 모은 글자를 비우게 한다.
test('OS6. only(API 키 불허)면 SDK env의 ANTHROPIC_API_KEY를 비운다, 시도마다 onText(null)', { timeout: 30_000 }, async () => {
  const ws = 'os6'; await createCompany(ws, '원샷6', '사장'); await saveRunnerCred(ws, 'claude', 'host', 'host');
  const prev = process.env.ANTHROPIC_API_KEY; process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-not-a-real-key';
  const seen = []; const texts = []; let n = 0;
  const fakeQuery = ({ options }) => (async function* () {
    seen.push(options);
    if (++n === 1) throw new Error('Claude Code process exited with code 139');
    yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '["번역"]' } } };
    yield { type: 'result', subtype: 'success', result: '["번역"]', usage: {}, total_cost_usd: 0 };
  })();
  try {
    const r = await runOneShot(ws, 'x', { only: { runner: 'claude', types: ['oauth', 'host'] }, onText: (d) => texts.push(d), __query: fakeQuery, timeoutMs: 20_000 });
    assert.equal(r.text, '["번역"]');
    assert.equal(seen.length, 2, '크래시는 같은 러너로 1회 재시도');
    for (const o of seen) assert.equal(o.env?.ANTHROPIC_API_KEY, '', 'API 키로 과금되지 않게');
    assert.deepEqual(texts, [null, null, '["번역"]'], '시도마다 새로 시작을 알린다');
    n = 1; seen.length = 0;
    await runOneShot(ws, 'x', { only: { runner: 'claude', types: ['host', 'apikey'] }, __query: fakeQuery, timeoutMs: 20_000 });
    assert.notEqual(seen[0].env?.ANTHROPIC_API_KEY, '', 'API 키를 허용하는 고정은 그대로');
  } finally { if (prev === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prev; }
});
