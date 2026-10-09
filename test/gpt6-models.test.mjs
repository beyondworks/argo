import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from './helpers/tmp.mjs';
import { RUNNERS, CODEX_DEFAULT_MODEL } from '../src/runners/catalog.mjs';
import { isKnownModel, effectiveModels, normalizeModelId } from '../src/runners/catalog-remote.mjs';
import { effortLevels, normalizeCrewEffort, codexModelEffort } from '../src/model-effort.mjs';
import { codexEffortArgs } from '../src/runners/codex.mjs';
import { toResponsesRequest } from '../src/engine/responses-wire.mjs';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-gpt6-models-'));
process.env.ARGO_MODEL_CATALOG = 'off';
const { updateAgentMeta, readAgentCard } = await import('../src/persona.mjs');
const { paths } = await import('../src/workspace.mjs');
const { visionCapable, imageToolResult } = await import('../src/engine/native-query.mjs');

test('API catalog and validation expose Sol/Luna/6.1 Sol without changing defaults', () => {
  for (const id of ['gpt-6-sol', 'gpt-6-luna', 'gpt-6.1-sol']) {
    assert.ok(effectiveModels('codex', null).some((m) => m.id === id));
    assert.equal(isKnownModel('codex', id, null), true);
    assert.equal(isKnownModel('claude', id, null), false);
  }
  assert.equal(CODEX_DEFAULT_MODEL, 'gpt-5.6-sol');
  assert.equal(RUNNERS.codex.models[0].id, CODEX_DEFAULT_MODEL);
});

test('shared editor/storage effort contract is model-specific', () => {
  assert.deepEqual(effortLevels('codex', 'gpt-6-sol'), ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  assert.deepEqual(effortLevels('codex', 'gpt-6-luna'), ['low', 'medium', 'high', 'xhigh', 'max']);
  // 서버 모델 목록(supported_reasoning_levels, 2026-10-07): 6.1 Sol·Astra도 low~ultra. Astra가 빠져 max가 xhigh로 낮아지고 ultra가 버려졌다(#744 검수 LOW).
  for (const model of ['gpt-6.1-sol', 'gpt-6-astra']) assert.deepEqual(effortLevels('codex', model), ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], model);
  for (const [runner, model] of [['codex', 'gpt-6-luna'], ['codex', 'gpt-5.6-sol'], ['claude', 'gpt-6-sol'], ['', 'gpt-6-sol']]) {
    assert.equal(normalizeCrewEffort('ultra', runner, model), '');
  }
  assert.equal(normalizeCrewEffort(' MAX ', 'codex', 'gpt-6-luna'), 'max');
  assert.equal(codexModelEffort('max', 'gpt-5.6-sol'), 'xhigh');
  assert.equal(codexModelEffort('ultra', 'toString'), null);
});

test('card save/reopen retains Sol ultra and Luna max, clears ultra on model/runner switch', async () => {
  const ws = 'models', slug = 'tester';
  await mkdir(paths(ws).agents, { recursive: true });
  await writeFile(join(paths(ws).agents, `${slug}.md`), '---\nname: Tester\nslug: tester\nrole: Tester\n---\n\n# Tester\n');
  await updateAgentMeta(ws, slug, { runner: 'codex', model: 'gpt-6-sol', effort: 'ultra' });
  let saved = await readAgentCard(ws, slug);
  assert.equal(saved.meta.model, 'gpt-6-sol'); assert.equal(saved.meta.effort, 'ultra');
  await updateAgentMeta(ws, slug, { model: 'gpt-6-luna' });
  saved = await readAgentCard(ws, slug);
  assert.equal(saved.meta.model, 'gpt-6-luna'); assert.equal(saved.meta.effort || '', '');
  await updateAgentMeta(ws, slug, { effort: 'max' });
  assert.equal((await readAgentCard(ws, slug)).meta.effort, 'max');
  await updateAgentMeta(ws, slug, { model: 'gpt-6-sol', effort: 'ultra' });
  await updateAgentMeta(ws, slug, { runner: 'claude', model: 'claude-opus-5-5' });
  assert.equal((await readAgentCard(ws, slug)).meta.effort || '', '');
});

test('exec and native Responses retain exact new-model effort without leaking unsupported ultra', () => {
  for (const [model, effort] of [['gpt-6-sol', 'ultra'], ['gpt-6-sol', 'max'], ['gpt-6-luna', 'max'], ['gpt-6.1-sol', 'ultra'], ['gpt-6.1-sol', 'max'], ['gpt-6.1-sol', 'low'], ['gpt-6-astra', 'max'], ['gpt-6-astra', 'ultra']]) {
    assert.deepEqual(codexEffortArgs(effort, model), ['-c', `model_reasoning_effort=${effort}`]);
    const body = toResponsesRequest({ model, effort: codexModelEffort(effort, model), messages: [] });
    assert.equal(body.model, model); assert.equal(body.reasoning.effort, effort);
  }
  assert.deepEqual(codexEffortArgs('ultra', 'gpt-6-luna'), []);
});

test('Sol/Luna screenshot tool results retain image blocks; unknown models stay conservative', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
  for (const model of ['gpt-6-sol', 'gpt-6-luna', 'gpt-6.1-sol', 'gpt-6-astra']) {
    assert.equal(visionCapable(model, {}), true);
    assert.equal(visionCapable(model, { ARGO_VISION_MODELS: 'none' }), false);
    const content = await imageToolResult({ image: png, mime: 'image/png' }, { cwd: process.env.ARGO_ROOT, model, env: {} });
    assert.ok(content.some((b) => b.type === 'image'));
    const body = toResponsesRequest({ model, messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'shot', content }] }] });
    assert.ok(body.input.some((item) => item.content?.some((b) => b.type === 'input_image')));
  }
  assert.equal(visionCapable('gpt-6-unknown', {}), false);
});

// 유건 결정(2026-10-08): 6.1 Sol을 고르고 강도를 비우면 medium. 서버 기본은 low(~/.codex/models_cache.json default_reasoning_level, 2026-10-07).
// CLI 인자·app-server·네이티브 Responses가 같은 함수(codexModelEffort)를 쓰므로 세 경로가 같은 값을 보낸다. 다른 모델의 '비움'은 지금처럼 서버 기본.
test('GPT-6.1 Sol: empty or unsupported effort sends medium on every transport; other models keep the server default', () => {
  for (const effort of ['', '  ', null, undefined, 'minimal', 'toString']) {
    assert.equal(codexModelEffort(effort, 'gpt-6.1-sol'), 'medium', String(effort));
    assert.deepEqual(codexEffortArgs(effort, 'gpt-6.1-sol'), ['-c', 'model_reasoning_effort=medium'], String(effort));
  }
  assert.equal(toResponsesRequest({ model: 'gpt-6.1-sol', effort: codexModelEffort('', 'gpt-6.1-sol'), messages: [] }).reasoning.effort, 'medium');
  for (const model of ['gpt-6-sol', 'gpt-6-luna', 'gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', '']) {
    assert.equal(codexModelEffort('', model), null, model);
    assert.deepEqual(codexEffortArgs('', model), [], model);
  }
  // 저장값은 비운 그대로('') — medium은 보낼 때만 채운다(카드에 Argo 기본값을 박지 않는다)
  assert.equal(normalizeCrewEffort('', 'codex', 'gpt-6.1-sol'), '');
});

test('card save/reopen retains 6.1 Sol ultra; switching to a model without ultra clears it', async () => {
  const ws = 'models61', slug = 'tester';
  await mkdir(paths(ws).agents, { recursive: true });
  await writeFile(join(paths(ws).agents, `${slug}.md`), '---\nname: Tester\nslug: tester\nrole: Tester\n---\n\n# Tester\n');
  await updateAgentMeta(ws, slug, { runner: 'codex', model: 'gpt-6.1-sol', effort: 'ultra' });
  let saved = await readAgentCard(ws, slug);
  assert.equal(saved.meta.model, 'gpt-6.1-sol'); assert.equal(saved.meta.effort, 'ultra');
  await updateAgentMeta(ws, slug, { model: 'gpt-6-luna' });
  saved = await readAgentCard(ws, slug);
  assert.equal(saved.meta.model, 'gpt-6-luna'); assert.equal(saved.meta.effort || '', '');
});

// GPT-5.5 종료 — Codex 서버 목록이 "GPT-5.5 retires on October 14, 2026"(upgrade.retirement_at 2026-10-14T19:00Z, ~/.codex/models_cache.json
// 2026-10-09 확인)라고 안내한다. 목록에서 빼고, 이미 고른 에이전트는 GPT-5.6 Sol로 옮긴다(6.1 Sol은 핀 0.157.1 옛 앱에서 400).
// 원격 카탈로그가 없어도(오프라인·첫 실행·ARGO_MODEL_CATALOG=off) 코드 대체표(RETIRED_MODEL_ALIASES)로 같은 결과 — 원격 alias가 있으면 그쪽이 먼저.
test('GPT-5.5 retired: hidden from the Codex list, old ids resolve to GPT-5.6 Sol without the remote catalog, card save rewrites it', async () => {
  assert.equal(RUNNERS.codex.models.some((m) => m.id === 'gpt-5.5'), false);
  assert.equal(effectiveModels('codex', null).some((m) => m.id === 'gpt-5.5'), false);
  assert.equal(normalizeModelId('codex', 'gpt-5.5', null), 'gpt-5.6-sol');
  assert.equal(normalizeModelId('codex', ' gpt-5.5 ', null), 'gpt-5.6-sol');
  assert.equal(isKnownModel('codex', 'gpt-5.5', null), true, '대체 모델이 목록에 있다');
  // 다른 러너는 그대로 — OpenRouter의 openai/gpt-5.5는 종료 예정이 없다(openrouter.ai/api/v1/models expiration_date null, 2026-10-09)
  assert.equal(normalizeModelId('openrouter', 'openai/gpt-5.5', null), 'openai/gpt-5.5');
  assert.equal(normalizeModelId('claude', 'gpt-5.5', null), 'gpt-5.5');
  // 표 조회가 객체 기본 속성을 모델 id로 돌려주지 않는다
  for (const id of ['toString', '__proto__', 'constructor', 'hasOwnProperty']) assert.equal(normalizeModelId('codex', id, null), id, id);
  assert.equal(normalizeModelId('toString', 'gpt-5.5', null), 'gpt-5.5');
  const ov = { schema: 1, runners: { codex: { add: [], retire: [], alias: { 'gpt-5.5': 'gpt-6-sol' } } } };
  assert.equal(normalizeModelId('codex', 'gpt-5.5', ov), 'gpt-6-sol', '원격 alias가 먼저(앱 발행 없이 목적지를 바꿀 길)');
  assert.equal(normalizeModelId('codex', 'toString', ov), 'toString');

  const ws = 'models55', slug = 'tester';
  await mkdir(paths(ws).agents, { recursive: true });
  await writeFile(join(paths(ws).agents, `${slug}.md`), '---\nname: Tester\nslug: tester\nrole: Tester\nrunner: codex\nmodel: gpt-5.5\neffort: high\n---\n\n# Tester\n');
  await updateAgentMeta(ws, slug, { model: 'gpt-5.5', effort: 'high' }); // 편집 화면은 이름만 고쳐도 model을 함께 보낸다
  const saved = await readAgentCard(ws, slug);
  assert.equal(saved.meta.model, 'gpt-5.6-sol');
  assert.equal(saved.meta.effort, 'high', '5.5와 5.6 Sol은 강도 단계가 같다(low~xhigh·max→xhigh)');
});
