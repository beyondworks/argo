import test from 'node:test';
import assert from 'node:assert/strict';
import { addModuleItem, appendPageModule, canEditModulePage, createModuleItem } from '../src/core/module-placement-model.js';
import { mergeLayout, mergePages } from '../src/core/layout.js';
import { LIBRARY_MODULES } from '../src/core/module-registry.js';

test('library restores an existing functional module without changing its identity or width', () => {
  const existing = [{ id: 'mail', size: 's', hidden: true, cfg: { count: 3 } }];
  const next = addModuleItem(existing, createModuleItem('mail', {}, () => 'new'));
  assert.deepEqual(next, [{ ...existing[0], hidden: false }]);
  assert.equal(existing[0].hidden, true);
});

test('multiple chart instances and their metrics survive a home layout reload', () => {
  const first = createModuleItem('chart-kpi', { metric: 'sales' }, () => 'first');
  const second = createModuleItem('chart-kpi', { metric: 'paid' }, () => 'second');
  const items = addModuleItem([first], second);
  const restored = mergeLayout(JSON.parse(JSON.stringify({ items })), LIBRARY_MODULES, 'me', []);
  assert.deepEqual(restored.filter(item => item.moduleId === 'chart-kpi'), items);
  assert.equal(restored.some(item => item.id === 'chart-line'), false);
});

test('page module addition retains headings, rich text and existing module configuration', () => {
  const original = { type: 'doc', content: [
    { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Quarterly plan' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'Keep this text', marks: [{ type: 'bold' }] }] },
  ] };
  const before = structuredClone(original);
  const mail = createModuleItem('mail', {}, () => 'mail-instance');
  const withMail = appendPageModule(original, mail);
  const withChart = appendPageModule(withMail, createModuleItem('chart-kpi', {}, () => 'chart-instance'));
  assert.deepEqual(original, before);
  assert.deepEqual(withChart.content.slice(0, 2), before.content);
  assert.equal(withChart.content.filter(node => node.type === 'moduleGrid').length, 1);
  assert.deepEqual(withChart.content[2].attrs.items[0], mail);
  assert.equal(withChart.content[2].attrs.items.length, 2);
});

test('missing document is rejected rather than overwritten by an empty module page', () => {
  for (const doc of [undefined, null, {}, { type: 'doc' }]) {
    assert.throws(() => appendPageModule(doc, createModuleItem('mail')), /library.loadFailed/);
  }
});

test('library destination excludes read-only, other-space, trash and template pages', () => {
  const page = { space: 'me', access: 'full' };
  assert.equal(canEditModulePage(page, 'me'), true);
  assert.equal(canEditModulePage({ ...page, access: 'edit' }, 'me'), true);
  for (const patch of [{ access: 'view' }, { access: undefined }, { template: true }, { trashedAt: '2026-09-28' }, { space: 'org' }]) {
    assert.equal(canEditModulePage({ ...page, ...patch }, 'me'), false);
  }
});

test('unknown module and incompatible chart metric are rejected', () => {
  assert.throws(() => createModuleItem('unknown'), /library.invalid/);
  assert.throws(() => createModuleItem('chart-line', { metric: 'unknown' }), /library.invalid/);
});

test('same-version page refresh preserves the editor snapshot identity; newer content invalidates it', () => {
  const local = [{ id: 'page', version: 3, loadedAt: 123, content: { type: 'doc', content: [] } }];
  const options = { before: new Set(), pendingNow: new Set(), spaceOf: () => 'me' };
  const same = mergePages([{ id: 'page', version: 3, access: 'full' }], local, options).pages[0];
  assert.equal(same.loadedAt, 123);
  assert.deepEqual(same.content, local[0].content);
  const newer = mergePages([{ id: 'page', version: 4, access: 'full' }], local, options).pages[0];
  assert.equal(newer.loadedAt, undefined);
  assert.equal(newer.content, undefined);
});
