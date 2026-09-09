import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp } from './helpers/tmp.mjs';

const root = await mkdtemp(join(tmpdir(), 'argo-import-sync-'));
process.env.ARGO_ROOT = root;
process.env.HOME = await mkdtemp(join(tmpdir(), 'argo-import-sync-home-'));
process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://selfhost.local';
process.env.SUPABASE_SERVICE_ROLE_KEY = randomBytes(20).toString('hex');
delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
delete process.env.ARGO_TENANT_OWNER;
const { syncCompany, _setSyncClientForTest } = await import('../src/sync.mjs');
const { updateMcp } = await import('../src/market.mjs');
const { ensureAccountKey } = await import('../src/accountkey.mjs');
const { openSecretCompat } = await import('../src/secretbox.mjs');
await ensureAccountKey({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { key_b64: randomBytes(32).toString('base64') } }) }) }) }) }, 'owner-import-sync');
const meta = (buf, m = 1000) => ({ m, s: buf.length, h: createHash('sha1').update(buf).digest('hex').slice(0, 16) });
const body = (servers) => Buffer.from(JSON.stringify({ servers }));

async function setup(ws, { local = {}, state = {}, remote = {}, hook = async () => {} } = {}) {
  await mkdir(join(root, ws), { recursive: true });
  for (const [rel, buf] of Object.entries(local)) {
    await mkdir(dirname(join(root, ws, rel)), { recursive: true });
    await writeFile(join(root, ws, rel), buf);
  }
  await writeFile(join(root, ws, '.sync-state.json'), JSON.stringify({ files: state }));
  const manifestKey = `owner/${ws}/__manifest__.json`;
  const store = new Map([[manifestKey, Buffer.from(JSON.stringify({ files: Object.fromEntries(Object.entries(remote).map(([rel, buf]) => [rel, meta(buf, Date.now() + 100000)])) }))]]);
  for (const [rel, buf] of Object.entries(remote)) store.set(`owner/${ws}/${rel}`, buf);
  const bucket = {
    async download(key) {
      await hook(key);
      const data = store.get(key);
      return data ? { data: { arrayBuffer: async () => Uint8Array.from(data).buffer } } : { error: { message: 'not found', status: 404 } };
    },
    async upload(key, blob) { store.set(key, Buffer.from(await blob.arrayBuffer())); return {}; },
    async remove(keys) { for (const key of keys) store.delete(key); return {}; },
  };
  _setSyncClientForTest({ storage: { from: () => bucket } });
  return { store, manifestKey };
}

test('sync keeps machine-local import state out of upload, pull and deletion', async () => {
  const ws = 'private-state';
  const note = Buffer.from('# ordinary note');
  const privateData = randomBytes(32);
  const { store, manifestKey } = await setup(ws, {
    local: { '.local-assets/staging/private': privateData, 'vault/notes/ordinary.md': note },
    remote: { '.local-assets/remote-private': privateData },
  });
  const result = await syncCompany(ws, 'owner');
  assert.equal(result.failed, 0);
  assert.deepEqual(await readFile(join(root, ws, '.local-assets/staging/private')), privateData);
  await assert.rejects(access(join(root, ws, '.local-assets/remote-private')));
  assert.equal(store.has(`owner/${ws}/.local-assets/staging/private`), false);
  assert.deepEqual(store.get(`owner/${ws}/.local-assets/remote-private`), privateData);
  const manifest = JSON.parse(openSecretCompat(store.get(manifestKey)));
  assert.ok(manifest.files['vault/notes/ordinary.md']);
});

test('ordinary MCP remote updates still apply', async () => {
  const ws = 'ordinary-pull', before = body({ before: { command: 'node' } }), after = body({ after: { command: 'node' } });
  await setup(ws, { local: { 'mcp.json': before }, state: { 'mcp.json': meta(before) }, remote: { 'mcp.json': after } });
  assert.equal((await syncCompany(ws, 'owner')).failed, 0);
  assert.deepEqual(JSON.parse(await readFile(join(root, ws, 'mcp.json'))), JSON.parse(after));
});

test('MCP edit during a remote pull survives instead of being overwritten by a stale snapshot', async () => {
  const ws = 'racing-pull', before = body({ before: { command: 'node' } }), after = body({ remote: { command: 'node' } });
  let changed = false;
  await setup(ws, { local: { 'mcp.json': before }, state: { 'mcp.json': meta(before) }, remote: { 'mcp.json': after }, hook: async key => {
    if (key.endsWith('/mcp.json') && !changed) { changed = true; await updateMcp(ws, cfg => { cfg.servers.imported = { command: 'node' }; }); }
  } });
  const result = await syncCompany(ws, 'owner');
  assert.equal(result.failed, 1);
  assert.deepEqual(Object.keys(JSON.parse(await readFile(join(root, ws, 'mcp.json'))).servers).sort(), ['before', 'imported']);
});

test('MCP edit during remote deletion survives the stale deletion decision', async () => {
  const ws = 'racing-delete', before = body({ before: { command: 'node' } });
  let changed = false;
  await setup(ws, { local: { 'mcp.json': before }, state: { 'mcp.json': meta(before) }, hook: async key => {
    if (key.endsWith('/mcp.json') && !changed) { changed = true; await updateMcp(ws, cfg => { cfg.servers.imported = { command: 'node' }; }); }
  } });
  const result = await syncCompany(ws, 'owner');
  assert.equal(result.failed, 1);
  assert.ok(JSON.parse(await readFile(join(root, ws, 'mcp.json'))).servers.imported);
});
