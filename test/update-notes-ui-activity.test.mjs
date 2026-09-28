import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const swc = require('next/dist/build/swc');
await swc.loadBindings();
const previousLoader = require.extensions['.jsx'];
require.extensions['.jsx'] = (module, filename) => {
  const result = swc.transformSync(readFileSync(filename, 'utf8'), {
    filename, jsc: { target: 'es2022', parser: { syntax: 'ecmascript', jsx: true }, transform: { react: { runtime: 'automatic' } } },
    module: { type: 'commonjs' },
  });
  module._compile(result.code, filename);
};
let ui;
try { ui = require('../app/ui.jsx'); }
finally {
  if (previousLoader) require.extensions['.jsx'] = previousLoader;
  else delete require.extensions['.jsx'];
}

test('actual api helper publishes immediate overlapping work and releases it on success or failure', async t => {
  const oldFetch = globalThis.fetch, oldWindow = globalThis.window, oldStorage = globalThis.localStorage;
  globalThis.window = new EventTarget();
  globalThis.localStorage = { getItem: () => 'en' };
  t.after(() => {
    globalThis.fetch = oldFetch;
    if (oldWindow === undefined) delete globalThis.window; else globalThis.window = oldWindow;
    if (oldStorage === undefined) delete globalThis.localStorage; else globalThis.localStorage = oldStorage;
  });
  const active = [];
  globalThis.window.addEventListener(ui.UI_WORK_EVENT, () => active.push(ui.uiWorkActive()));
  const pending = [];
  globalThis.fetch = () => new Promise((resolve, reject) => pending.push({ resolve, reject }));
  const read = ui.api('/fixture-read');
  assert.equal(ui.uiWorkActive(), false);
  pending.shift().resolve({ ok: true, json: async () => ({ read: true }) });
  assert.deepEqual(await read, { read: true });
  assert.deepEqual(active, []);
  const first = ui.api('/fixture-chat', { message: 'first' });
  const second = ui.api('/fixture-room', { message: 'second' });
  assert.equal(ui.uiWorkActive(), true);
  pending.shift().resolve({ ok: true, json: async () => ({ reply: 'ok' }) });
  assert.deepEqual(await first, { reply: 'ok' });
  assert.equal(ui.uiWorkActive(), true, 'another request is still running');
  const failure = assert.rejects(second, /fixture failure/);
  pending.shift().reject(new Error('fixture failure'));
  await failure;
  assert.equal(ui.uiWorkActive(), false);
  assert.deepEqual(active, [true, true, true, false]);
  globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({ error: 'service unavailable', saved: false }) });
  await assert.rejects(ui.api('/fixture-failed', {}), e => e.message === 'service unavailable' && e.data.saved === false);
  assert.equal(ui.uiWorkActive(), false, 'HTTP failure also releases work');
});
