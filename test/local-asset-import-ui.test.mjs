import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from 'espree';

// Execute the actual event handler, not a duplicated routing implementation.
const source = readFileSync(new URL('../app/page.jsx', import.meta.url), 'utf8');
const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module', range: true, ecmaFeatures: { jsx: true } });
function find(node, name) {
  if (!node || typeof node !== 'object') return null;
  if (node.type === 'FunctionDeclaration' && node.id.name === name) return node;
  for (const value of Object.values(node)) {
    const found = Array.isArray(value) ? value.map((child) => find(child, name)).find(Boolean) : find(value, name);
    if (found) return found;
  }
  return null;
}
const createNode = find(ast, 'create');
const createSource = source.slice(...createNode.range);
function harness({ optedIn = false, firstCrew = 'editor', fail = false, onboarding = true } = {}) {
  const calls = [];
  const scope = {
    name: 'My company', creating: false, preset: 'studio', lang: 'en', onboarding, importLocalAssets: optedIn,
    setCreating: (value) => calls.push(['creating', value]), setError: (value) => calls.push(['error', value]),
    api: async (path, data) => { calls.push(['api', path, JSON.parse(JSON.stringify(data))]); if (fail) throw new Error('offline'); return { company: { id: 'new-company' }, firstCrew }; },
    router: { push: (path) => calls.push(['push', path]), replace: (path) => calls.push(['replace', path]) },
  };
  const handler = vm.runInNewContext(`(${createSource})`, scope);
  return { calls, run: () => handler({ preventDefault() {} }) };
}

test('existing first-company creation preserves preset/lang payload and first crew navigation', async () => {
  const h = harness(); await h.run();
  assert.deepEqual(h.calls.find(([kind]) => kind === 'api'), ['api', '/api/companies', { name: 'My company', preset: 'studio', lang: 'en' }]);
  assert.deepEqual(h.calls.at(-1), ['push', '/c/new-company/crew/editor']);
});

test('explicit import opt-in creates once and continues with the created company and first crew', async () => {
  const h = harness({ optedIn: true }); await h.run();
  assert.equal(h.calls.filter(([kind]) => kind === 'api').length, 1);
  assert.deepEqual(h.calls.at(-1), ['replace', '/c/new-company/import?firstCrew=editor']);
});

test('empty preset and existing-company flows keep their original destination', async () => {
  for (const opts of [{ firstCrew: null }, { optedIn: true, onboarding: false }]) {
    const h = harness(opts); await h.run();
    assert.deepEqual(h.calls.at(-1), ['push', opts.firstCrew === null ? '/c/new-company' : '/c/new-company/crew/editor']);
  }
  const h = harness({ optedIn: true, firstCrew: null }); await h.run();
  assert.deepEqual(h.calls.at(-1), ['replace', '/c/new-company/import']);
});

test('failed company creation does not enter import or replay creation', async () => {
  const h = harness({ optedIn: true, fail: true }); await h.run();
  assert.equal(h.calls.filter(([kind]) => kind === 'api').length, 1);
  assert.equal(h.calls.some(([kind]) => ['push', 'replace'].includes(kind)), false);
  assert.deepEqual(h.calls.at(-1), ['creating', false]);
});

test('bulk selection excludes memory, conflicts, setup requirements, and successful items', () => {
  const text = readFileSync(new URL('../app/components/LocalAssetImport.jsx', import.meta.url), 'utf8');
  const tree = parse(text, { ecmaVersion: 'latest', sourceType: 'module', range: true, ecmaFeatures: { jsx: true } });
  const node = find(tree, 'bulkSelectable');
  const selectable = vm.runInNewContext(`(${text.slice(...node.range)})`);
  const skill = { kind: 'skill', compatibility: 'available', conflict: false };
  assert.equal(selectable(skill), true);
  for (const status of ['failed', 'planned', 'staged']) assert.equal(selectable({ ...skill, status }), true);
  for (const overrides of [{ kind: 'memory' }, { conflict: true }, { compatibility: 'needs-setup' }, { status: 'imported' }, { status: 'needs-setup' }, { status: 'skipped' }]) {
    assert.equal(selectable({ ...skill, ...overrides }), false);
  }
});

test('restoring failed and interrupted imports retains server-confirmed names without replaying successful items', () => {
  const text = readFileSync(new URL('../app/components/LocalAssetImport.jsx', import.meta.url), 'utf8');
  const tree = parse(text, { ecmaVersion: 'latest', sourceType: 'module', range: true, ecmaFeatures: { jsx: true } });
  const node = find(tree, 'restoredNames');
  const restore = vm.runInNewContext(`(${text.slice(...node.range)})`);
  const names = restore([{ id: 'failed', name: 'my-new-name', status: 'failed' }, { id: 'planned', name: 'planned-new-name', status: 'planned' }, { id: 'staged', name: 'staged-new-name', status: 'staged' }, { id: 'done', name: 'done', status: 'imported' }, { id: 'preview', name: 'original' }]);
  assert.deepEqual(JSON.parse(JSON.stringify(names)), { failed: 'my-new-name', planned: 'planned-new-name', staged: 'staged-new-name' });
});
