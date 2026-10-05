// 프롬프트 캐시(B1) — Anthropic Messages 와이어로 Anthropic API(ARGO_CLAUDE_BASE_URL)·OpenRouter의 anthropic/* 모델에 보낼 때만
// system·tools·대화 경계에 cache_control {type:'ephemeral'}을 최대 4곳 넣는다. xAI·GLM·Kimi·OpenRouter 비 Anthropic 모델에는 넣지 않는다
// (모르는 필드에 엄격한 벤더가 400을 낸 전례 — CLAUDE.md "벤더 축" 절). 엄격 가짜 벤더 서버(test/helpers/strict-vendor.mjs)로 벤더별로 잠근다.
// 실벤더 호출 0. ARGO_ROOT·HOME은 임시.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from './helpers/tmp.mjs';

process.env.HOME = await mkdtemp(join(tmpdir(), 'argo-pcache-home-'));
process.env.USERPROFILE = process.env.HOME;
process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-pcache-'));
process.env.ARGO_MODEL_CATALOG = 'off';
delete process.env.ARGO_CLAUDE_BASE_URL; delete process.env.OPENROUTER_BASE_URL;

const { nativeQuery } = await import('../src/engine/native-query.mjs');
const { authFromEnv } = await import('../src/engine/messages-http.mjs');
const { sessionFile } = await import('../src/engine/session.mjs');
const { createCompany, paths } = await import('../src/workspace.mjs');
const { startStrictVendor } = await import('./helpers/strict-vendor.mjs');

const env = (base) => ({ ANTHROPIC_BASE_URL: base, ANTHROPIC_AUTH_TOKEN: 'tok-fake-1234567890', ANTHROPIC_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: '' });
async function collect(q) { const out = []; for await (const m of q) out.push(m); return out; }
/** 본문 안 모든 cache_control 자리 */
const marks = (body) => { const out = []; const walk = (x, path) => { if (!x || typeof x !== 'object') return; if (Array.isArray(x)) return x.forEach((v, i) => walk(v, `${path}[${i}]`)); for (const [k, v] of Object.entries(x)) { if (k === 'cache_control') out.push({ path, v }); else walk(v, `${path}.${k}`); } }; walk(body, ''); return out; };

async function turn(ws, base, model, prompt = '안녕', resume = null) {
  const out = await collect(nativeQuery({ wsId: ws, slug: 'crew', prompt, cwd: paths(ws).root, systemPrompt: '페르소나 SYS', env: env(base), model, resume, browser: false }));
  return out;
}

test('PC1. Anthropic API(ARGO_CLAUDE_BASE_URL) — system·tools·대화 경계에 ephemeral 표지, 4곳 이하, 엄격 서버 통과', async () => {
  const ws = 'pc1'; await createCompany(ws, '캐시', '사장');
  const strict = await startStrictVendor({ vendor: 'anthropic' });
  process.env.ARGO_CLAUDE_BASE_URL = strict.base;
  try {
    const out1 = await turn(ws, strict.base, 'claude-sonnet-5', '첫 지시');
    assert.equal(out1.at(-1).subtype, 'success', '엄격 Anthropic 서버가 받아 준다');
    const b1 = strict.calls[0].body;
    const m1 = marks(b1);
    assert.ok(m1.length >= 3 && m1.length <= 4, `표지는 3~4곳(${m1.map((m) => m.path).join(' ')})`);
    for (const m of m1) assert.deepEqual(m.v, { type: 'ephemeral' });
    assert.ok(Array.isArray(b1.system) && b1.system.at(-1).cache_control, 'system 마지막 블록');
    assert.equal(b1.system.map((s) => s.text).join(''), '페르소나 SYS', 'system 내용은 그대로');
    assert.ok(b1.tools.at(-1).cache_control, 'tools 마지막 도구');
    assert.ok(b1.tools.slice(0, -1).every((t) => !t.cache_control), '도구 표지는 하나');
    const last = b1.messages.at(-1); assert.ok(Array.isArray(last.content) && last.content.at(-1).cache_control, '마지막 대화 경계');
    assert.equal(last.content.at(-1).text, '첫 지시', '지시 내용은 그대로');
    // 둘째 턴 — 이전 지시(사장 메시지)에도 경계 표지가 붙어 앞 턴까지의 전사가 캐시로 읽힌다(4곳 상한 안)
    const out2 = await turn(ws, strict.base, 'claude-sonnet-5', '둘째 지시', out1[0].session_id);
    assert.equal(out2.at(-1).subtype, 'success');
    const m2 = marks(strict.calls[1].body);
    assert.equal(m2.length, 4, `둘째 턴은 4곳(${m2.map((m) => m.path).join(' ')})`);
    assert.ok(m2.some((m) => m.path.startsWith('.messages[0]')), '앞 지시 경계');
    // 세션 파일에는 표지를 저장하지 않는다 — 크루가 러너를 xAI 등으로 바꿔 같은 세션을 이어도 400이 나지 않게
    const saved = await readFile(sessionFile(ws, 'crew'), 'utf8');
    assert.ok(!saved.includes('cache_control'), '저장 전사에 cache_control 없음');
  } finally { delete process.env.ARGO_CLAUDE_BASE_URL; await strict.close(); }
});

test('PC2. OpenRouter — anthropic/* 모델에만 표지, 그 밖 모델(z-ai/glm 등)에는 없음', async () => {
  const ws = 'pc2'; await createCompany(ws, '캐시', '사장');
  const strict = await startStrictVendor({ vendor: 'anthropic' });
  process.env.OPENROUTER_BASE_URL = strict.base;
  try {
    await turn(ws, strict.base, 'anthropic/claude-sonnet-5');
    assert.ok(marks(strict.calls[0].body).length >= 3, 'anthropic/* 는 표지');
    await turn(ws, strict.base, 'z-ai/glm-5.3');
    assert.equal(marks(strict.calls[1].body).length, 0, '비 Anthropic 모델은 표지 없음');
    assert.equal(typeof strict.calls[1].body.system, 'string', 'system 모양도 종전 그대로(문자열)');
  } finally { delete process.env.OPENROUTER_BASE_URL; await strict.close(); }
});

test('PC3. xAI(Grok)·GLM·Kimi 엔드포인트 — 표지 0(모르는 필드 거절 벤더 규칙을 통과), 모델 이름이 claude여도 엔드포인트로 판정', async () => {
  for (const vendor of ['xai', 'zai', 'moonshot']) {
    const ws = `pc3-${vendor}`; await createCompany(ws, '캐시', '사장');
    const strict = await startStrictVendor({ vendor });
    try {
      const out = await turn(ws, strict.base, vendor === 'xai' ? 'grok-4' : 'claude-sonnet-5');
      assert.equal(out.at(-1).subtype, 'success', `${vendor}: 엄격 규칙 통과`);
      assert.equal(marks(strict.calls[0].body).length, 0, `${vendor}: 표지 없음`);
    } finally { await strict.close(); }
  }
});

test('PC4. 엄격 서버 자체 핀 — xai 규칙은 cache_control을 400으로, anthropic 규칙은 5곳 이상을 400으로 거절한다', async () => {
  const xai = await startStrictVendor({ vendor: 'xai' });
  const an = await startStrictVendor({ vendor: 'anthropic' });
  try {
    const post = (base, body) => fetch(`${base}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'k' }, body: JSON.stringify(body) });
    const blk = (n) => Array.from({ length: n }, (_, i) => ({ type: 'text', text: `t${i}`, cache_control: { type: 'ephemeral' } }));
    assert.equal((await post(xai.base, { model: 'grok-4', max_tokens: 10, messages: [{ role: 'user', content: blk(1) }] })).status, 400);
    assert.equal((await post(an.base, { model: 'c', max_tokens: 10, messages: [{ role: 'user', content: blk(5) }] })).status, 400, '5곳은 거절');
    assert.equal((await post(an.base, { model: 'c', max_tokens: 10, messages: [{ role: 'user', content: blk(4) }] })).status, 200, '4곳은 통과');
  } finally { await xai.close(); await an.close(); }
});

test('PC5. 구독 토큰 거절은 그대로 — 캐시 대상 엔드포인트여도 네이티브 엔진은 구독 OAuth로 부르지 않는다', async () => {
  process.env.ARGO_CLAUDE_BASE_URL = 'https://api.anthropic.com';
  try {
    assert.throws(() => authFromEnv({ ANTHROPIC_BASE_URL: 'https://api.anthropic.com', CLAUDE_CODE_OAUTH_TOKEN: 'o' }), (e) => e.code === 'native_oauth_unsupported');
    const ws = 'pc5'; await createCompany(ws, '구독', '사장');
    await assert.rejects(collect(nativeQuery({ wsId: ws, slug: 'c', prompt: 'x', cwd: paths(ws).root, systemPrompt: '', env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com', CLAUDE_CODE_OAUTH_TOKEN: 'o' }, model: 'claude-sonnet-5', saveSession: false })),
      (e) => e.code === 'native_oauth_unsupported');
  } finally { delete process.env.ARGO_CLAUDE_BASE_URL; }
});

// 검수 changes_needed #5(LOW) — Gemini(generateContent)·OpenAI Responses 와이어에도 표지가 0곳인지 엄격 가짜 서버로 잠근다(ARGO_WIRE — runnerCredEnv가 찍는 기존 방식).
// 같은 주소를 ARGO_CLAUDE_BASE_URL로도 잡아 둔다 — 판정이 주소만 보고 와이어를 놓치면 표지가 실려 엄격 서버가 400을 낸다.
test('PC6. Gemini·Responses 와이어 — 두 턴(앞 지시가 있는 전사) 모두 cache_control 0곳, 엄격 서버 통과', async () => {
  for (const [vendor, model, wireEnv] of [
    ['gemini', 'gemini-2.5-pro', (base) => ({ ARGO_WIRE: 'gemini', GEMINI_API_KEY: 'gk-fake-1234567890', GEMINI_BASE_URL: base })],
    ['responses', 'gpt-5.6-sol', (base) => ({ ARGO_WIRE: 'responses', RESPONSES_BASE_URL: base, RESPONSES_TOKEN: 'rt-fake-1234567890' })],
  ]) {
    const ws = `pc6-${vendor}`; await createCompany(ws, '캐시', '사장');
    const strict = await startStrictVendor({ vendor });
    process.env.ARGO_CLAUDE_BASE_URL = strict.base;
    try {
      const run = (prompt, resume) => collect(nativeQuery({ wsId: ws, slug: 'crew', prompt, cwd: paths(ws).root, systemPrompt: '페르소나 SYS', env: wireEnv(strict.base), model, resume, browser: false }));
      const out1 = await run('첫 지시');
      assert.equal(out1.at(-1).subtype, 'success', `${vendor}: 엄격 서버 통과(첫 턴)`);
      const out2 = await run('둘째 지시', out1[0].session_id);
      assert.equal(out2.at(-1).subtype, 'success', `${vendor}: 엄격 서버 통과(둘째 턴)`);
      assert.equal(strict.calls.length, 2, `${vendor}: 그 와이어 경로로 2번`);
      for (const c of strict.calls) assert.equal(marks(c.body).length, 0, `${vendor}: 표지 없음(${c.url})`);
      // 판정 층도 따로 — 와이어 변환기(toGeminiRequest·toResponsesRequest)가 새 객체를 만들어 표지를 옮기지 않으므로 본문 단언만으로는 판정 회귀가 안 보인다
      const { cacheEligible } = await import('../src/engine/prompt-cache.mjs');
      assert.equal(cacheEligible({ wire: vendor, base: strict.base, model }), false, `${vendor}: 주소가 Anthropic 기준과 같아도 와이어가 다르면 표지를 싣지 않는다`);
      assert.ok(JSON.stringify(strict.calls[1].body).includes('첫 지시'), `${vendor}: 둘째 요청에 앞 지시(표지가 붙을 자리)가 있다`);
    } finally { delete process.env.ARGO_CLAUDE_BASE_URL; await strict.close(); }
  }
});

test('PC7. 엄격 서버 자체 핀 — gemini·responses 규칙은 cache_control을 400으로 거절한다', async () => {
  const gem = await startStrictVendor({ vendor: 'gemini' });
  const rsp = await startStrictVendor({ vendor: 'responses' });
  try {
    const g = (body) => fetch(`${gem.base}/models/gemini-2.5-pro:generateContent`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': 'k' }, body: JSON.stringify(body) });
    const r = (body) => fetch(`${rsp.base}/responses`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer k' }, body: JSON.stringify(body) });
    assert.equal((await g({ contents: [{ role: 'user', parts: [{ text: 'x', cache_control: { type: 'ephemeral' } }] }] })).status, 400);
    assert.equal((await g({ contents: [{ role: 'user', parts: [{ text: 'x' }] }] })).status, 200);
    assert.equal((await r({ model: 'm', input: [{ role: 'user', content: [{ type: 'input_text', text: 'x', cache_control: { type: 'ephemeral' } }] }] })).status, 400);
    assert.equal((await r({ model: 'm', input: [{ role: 'user', content: [{ type: 'input_text', text: 'x' }] }] })).status, 200);
  } finally { await gem.close(); await rsp.close(); }
});
