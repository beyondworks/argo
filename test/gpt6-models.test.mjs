import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from './helpers/tmp.mjs';
import { RUNNERS, CODEX_DEFAULT_MODEL } from '../src/runners/catalog.mjs';
import { isKnownModel, effectiveModels } from '../src/runners/catalog-remote.mjs';
import { effortLevels, normalizeCrewEffort, codexModelEffort } from '../src/model-effort.mjs';
import { codexEffortArgs } from '../src/runners/codex.mjs';
import { toResponsesRequest } from '../src/engine/responses-wire.mjs';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-gpt6-models-'));
process.env.ARGO_MODEL_CATALOG = 'off';
const { updateAgentMeta, readAgentCard } = await import('../src/persona.mjs');
const { paths } = await import('../src/workspace.mjs');
const { visionCapable, imageToolResult } = await import('../src/engine/native-query.mjs');

test('API catalog and validation expose Sol/Luna without changing defaults', () => {
  for (const id of ['gpt-6-sol', 'gpt-6-luna']) {
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
  for (const [model, effort] of [['gpt-6-sol', 'ultra'], ['gpt-6-sol', 'max'], ['gpt-6-luna', 'max']]) {
    assert.deepEqual(codexEffortArgs(effort, model), ['-c', `model_reasoning_effort=${effort}`]);
    const body = toResponsesRequest({ model, effort: codexModelEffort(effort, model), messages: [] });
    assert.equal(body.model, model); assert.equal(body.reasoning.effort, effort);
  }
  assert.deepEqual(codexEffortArgs('ultra', 'gpt-6-luna'), []);
});

test('Sol/Luna screenshot tool results retain image blocks; unknown models stay conservative', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
  for (const model of ['gpt-6-sol', 'gpt-6-luna']) {
    assert.equal(visionCapable(model, {}), true);
    assert.equal(visionCapable(model, { ARGO_VISION_MODELS: 'none' }), false);
    const content = await imageToolResult({ image: png, mime: 'image/png' }, { cwd: process.env.ARGO_ROOT, model, env: {} });
    assert.ok(content.some((b) => b.type === 'image'));
    const body = toResponsesRequest({ model, messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'shot', content }] }] });
    assert.ok(body.input.some((item) => item.content?.some((b) => b.type === 'input_image')));
  }
  assert.equal(visionCapable('gpt-6-unknown', {}), false);
});
