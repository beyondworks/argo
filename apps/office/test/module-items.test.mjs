import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeModuleItems, moduleAllowedInSpace } from '../src/core/module-items.js';
import { LIBRARY_MODULES } from '../src/core/module-registry.js';
import { rowsOf } from '../src/core/layout.js';

test('pasted modules receive supported widths without losing their configuration', () => {
  const input = [{ id: 'x', moduleId: 'chart-kpi', cfg: { metric: 'paid' } }, { id: 'stats', size: 's' }, { id: 'unknown', size: 'huge', hidden: true }];
  const before = structuredClone(input);
  const next = normalizeModuleItems(input);
  assert.deepEqual(next.map((item) => item.size), ['s', 'full', 'm']);
  assert.deepEqual(next[0].cfg, { metric: 'paid' });
  assert.equal(next[2].hidden, true);
  assert.doesNotThrow(() => rowsOf(next));
  assert.deepEqual(input, before);
});

test('duplicate pasted instances retain module identity with stable unique ids', () => {
  const input = [{ id: 'mail' }, { id: 'mail', cfg: { count: 5 } }, { id: 'mail-copy-1' }, { id: 2 }, { id: 'module-3' }, null];
  const next = normalizeModuleItems(input);
  assert.equal(next.length, 5);
  assert.equal(new Set(next.map((item) => item.id)).size, 5);
  assert.equal(next[1].moduleId, 'mail');
  assert.deepEqual(next[1].cfg, { count: 5 });
  assert.deepEqual(normalizeModuleItems(next), next);
  assert.deepEqual(normalizeModuleItems(null), []);
});

test('personal-only modules cannot render after paste into an organization page', () => {
  const mail = LIBRARY_MODULES.find((module) => module.id === 'mail');
  const work = LIBRARY_MODULES.find((module) => module.id === 'work');
  assert.equal(moduleAllowedInSpace(mail, 'me'), true);
  assert.equal(moduleAllowedInSpace(mail, 'organization'), false);
  assert.equal(moduleAllowedInSpace(work, 'organization'), true);
  assert.equal(moduleAllowedInSpace(mail, 'shared'), false);
  assert.equal(moduleAllowedInSpace(undefined, 'me'), false);
});
