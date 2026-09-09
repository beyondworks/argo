import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, stat, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { mkdtemp } from './helpers/tmp.mjs';

const root = await mkdtemp(join(tmpdir(), 'argo-mcp-update-'));
process.env.ARGO_ROOT = root;
process.env.HOME = await mkdtemp(join(tmpdir(), 'argo-mcp-home-'));
process.env.USERPROFILE = process.env.HOME;
process.env.ARGO_STANDALONE = '1';
delete process.env.ARGO_TENANT_OWNER;
const market = await import('../src/market.mjs');
const { installRemoteMcp } = await import('../src/remote-market.mjs');
const { paths } = await import('../src/workspace.mjs');

async function seed(id, value) {
  await mkdir(join(root, id), { recursive: true });
  await writeFile(paths(id).mcp, typeof value === 'string' ? value : JSON.stringify(value));
}

test('MCP import-style update and all existing writers preserve concurrent changes', async () => {
  const ws = 'concurrent';
  await seed(ws, { label: 'preserve-metadata', servers: { keep: { command: 'keep' }, remove: { command: 'remove' } } });
  await writeFile(join(process.env.HOME, '.claude.json'), JSON.stringify({ mcpServers: { host: { command: 'host' } } }));
  await Promise.all([
    ...Array.from({ length: 12 }, (_, i) => market.updateMcp(ws, cfg => { cfg.servers[`import-${i}`] = { command: `import-${i}` }; })),
    market.installMcp(ws, market.MCP_CATALOG[0].id),
    market.addCustomMcp(ws, { name: 'custom', command: 'custom' }),
    market.removeMcp(ws, 'remove'),
    market.importHostMcp(ws, 'host'),
    installRemoteMcp(ws, { name: 'remote', install: { kind: 'http', url: 'https://example.com/mcp' } }),
  ]);
  const cfg = JSON.parse(await readFile(paths(ws).mcp, 'utf8'));
  assert.equal(cfg.label, 'preserve-metadata');
  assert.equal(cfg.servers.keep.command, 'keep');
  assert.equal(cfg.servers.remove, undefined);
  for (let i = 0; i < 12; i++) assert.equal(cfg.servers[`import-${i}`].command, `import-${i}`);
  for (const name of ['custom', 'host', 'remote', market.MCP_CATALOG[0].id]) assert.ok(cfg.servers[name]);
});

test('MCP writers fail closed on damaged configuration without renaming or replacing it', async () => {
  for (const [id, body] of [['bad-json', '{invalid'], ['bad-shape', '{"servers":[]}']]) {
    await seed(id, body);
    await assert.rejects(market.addCustomMcp(id, { name: 'new', command: 'unused' }));
    assert.equal(await readFile(paths(id).mcp, 'utf8'), body);
    assert.deepEqual(await readdir(join(root, id)), ['mcp.json']);
  }
});

test('MCP atomic replacement tightens existing permissions, including remote installs', async () => {
  const ws = 'mode';
  await seed(ws, { servers: {} });
  await chmod(paths(ws).mcp, 0o644);
  await installRemoteMcp(ws, { name: 'remote', install: { kind: 'http', url: 'https://example.com/mcp' } });
  if (process.platform !== 'win32') assert.equal((await stat(paths(ws).mcp)).mode & 0o777, 0o600);
});

test('failed MCP update does not persist partial edits and releases its lock', async () => {
  const ws = 'rollback';
  await seed(ws, { servers: { keep: { command: 'keep' } } });
  await assert.rejects(market.updateMcp(ws, cfg => { cfg.servers.partial = {}; throw new Error('abort'); }));
  await market.updateMcp(ws, cfg => { cfg.servers.next = { command: 'next' }; });
  const { servers } = JSON.parse(await readFile(paths(ws).mcp, 'utf8'));
  assert.deepEqual(Object.keys(servers).sort(), ['keep', 'next']);
});

test('MCP updates serialize across Node processes', async () => {
  const ws = 'processes';
  await seed(ws, { servers: { keep: { command: 'keep' } } });
  const moduleUrl = new URL('../src/market.mjs', import.meta.url).href;
  await Promise.all(Array.from({ length: 3 }, (_, worker) => new Promise((resolve, reject) => {
    const source = `import { updateMcp } from ${JSON.stringify(moduleUrl)}; for (let i=0;i<8;i++) await updateMcp('processes', cfg => { cfg.servers['p${worker}-'+i] = {command:'unused'}; });`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], { env: process.env, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', d => { stderr += d; });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`child failed (${code}): ${stderr}`)));
  })));
  const { servers } = JSON.parse(await readFile(paths(ws).mcp, 'utf8'));
  assert.equal(Object.keys(servers).length, 25);
  assert.equal(servers.keep.command, 'keep');
});
