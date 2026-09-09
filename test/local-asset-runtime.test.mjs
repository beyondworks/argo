import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

const root = await mkdtemp(join(tmpdir(), 'argo-import-runtime-'));
const home = join(root, '사용자 home');
await mkdir(home);
process.env.ARGO_ROOT = join(root, 'companies');
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.ARGO_MODEL_CATALOG = 'off';
const { createCompany, paths } = await import('../src/workspace.mjs');
const { previewLocalAssets, executeLocalAssets } = await import('../src/local-asset-import.mjs');
const { loadMcp } = await import('../src/market.mjs');
const { loadSkills } = await import('../src/chat.mjs');
const { connectMcpServers } = await import('../src/engine/mcp-client.mjs');
test.after(() => rm(root, { recursive: true, force: true }));

test('imported package and MCP run through the existing runtime after explicit import', async () => {
  const ws = 'runtime-check';
  await createCompany(ws, 'Runtime check', 'Test owner');
  const skill = join(home, '.claude', 'skills', 'release-probe');
  await mkdir(join(skill, 'scripts'), { recursive: true });
  await writeFile(join(skill, 'SKILL.md'), '# Release probe\nWhen requested, run scripts/probe.mjs using Node.');
  await writeFile(join(skill, 'scripts', 'probe.mjs'), 'process.stdout.write("IMPORTED-SKILL-OK");\n');
  const marker = join(home, 'mcp-was-started');
  const serverSource = `import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
const require = createRequire(${JSON.stringify(fileURLToPath(new URL('../package.json', import.meta.url)))});
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
writeFileSync(${JSON.stringify(marker)}, 'started');
const server = new McpServer({ name: 'import-probe', version: '1.0.0' });
server.tool('probe', 'Return the import canary', async () => ({ content: [{ type: 'text', text: 'IMPORTED-MCP-OK' }] }));
await server.connect(new StdioServerTransport());
`;
  await writeFile(join(home, '.claude.json'), JSON.stringify({ mcpServers: { probe: { command: 'node', args: ['--input-type=module', '-e', serverSource] } } }));
  const context = { principal: 'local', device: 'runtime-test-device' };
  const options = { sourceOptions: { home, env: {} } };
  const preview = await previewLocalAssets(ws, context, {}, options);
  assert.equal(preview.items.length, 2);
  const result = await executeLocalAssets(ws, context, {
    scanId: preview.scanId, selectedIds: preview.items.map(i => i.id),
    consents: { tools: true, memory: false, secrets: false },
  }, options);
  assert.ok(result.items.every(i => i.status === 'imported'), JSON.stringify(result.items));
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
  const prompt = await loadSkills(ws, undefined, 'en');
  assert.match(prompt, /Base path: skills\/release-probe\//);
  const copied = join(paths(ws).skills, 'release-probe', 'scripts', 'probe.mjs');
  assert.equal(await readFile(copied, 'utf8'), await readFile(join(skill, 'scripts', 'probe.mjs'), 'utf8'));
  const ran = await promisify(execFile)(process.execPath, [copied], { timeout: 5000 });
  assert.equal(ran.stdout, 'IMPORTED-SKILL-OK');
  const cfg = await loadMcp(ws);
  const mcp = await connectMcpServers(cfg.servers, { cwd: paths(ws).root });
  try {
    assert.deepEqual(mcp.statuses, [{ name: 'probe', status: 'connected' }]);
    assert.equal(mcp.tools.length, 1);
    assert.equal(mcp.tools[0].gated, true);
    assert.equal(await mcp.tools[0].run({}), 'IMPORTED-MCP-OK');
  } finally { await mcp.close(); }
});
