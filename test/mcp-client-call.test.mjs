// K59·K60·K61 — 네이티브 엔진의 외부 MCP 도구 호출: 정지 신호·호출 상한 전달, 64자 도구 이름·치환 충돌, HTTP→SSE 폴백 원래 오류, 텍스트 아닌 결과 파트.
// 실제 @modelcontextprotocol/sdk McpServer(stdio)와 가짜 HTTP 서버로 돈다 — 실벤더 호출 0.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { mkdtemp } from './helpers/tmp.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const { connectMcpServers, MCP_CONNECT_TIMEOUT_MS } = await import('../src/engine/mcp-client.mjs');

const LONG = 'fetch_the_quarterly_revenue_breakdown_for_every_region_and_product_line';
async function probeServer() {
  const dir = await mkdtemp(join(tmpdir(), 'argo-mcp-call-'));
  const file = join(dir, 'probe.mjs');
  await writeFile(file, `import { createRequire } from 'node:module';
const require = createRequire(${JSON.stringify(join(ROOT, 'package.json'))});
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const s = new McpServer({ name: 'probe', version: '1.0.0' });
s.tool(${JSON.stringify(LONG)}, 'long', async () => ({ content: [{ type: 'text', text: 'long-ok' }] }));
s.tool('a.b', 'dot', async () => ({ content: [{ type: 'text', text: 'dot' }] }));
s.tool('a_b', 'underscore', async () => ({ content: [{ type: 'text', text: 'underscore' }] }));
s.tool('sleepy', 'slow', async () => { await new Promise((r) => setTimeout(r, 30000)); return { content: [{ type: 'text', text: 'late' }] }; });
s.tool('pic', 'mixed parts', async () => ({ content: [
  { type: 'text', text: 'caption' },
  { type: 'image', data: Buffer.alloc(3000, 7).toString('base64'), mimeType: 'image/png' },
  { type: 'resource', resource: { uri: 'file:///notes.txt', mimeType: 'text/plain', text: 'resource body' } },
  { type: 'resource', resource: { uri: 'file:///blob.bin', mimeType: 'application/octet-stream', blob: Buffer.alloc(3000, 9).toString('base64') } },
] }));
await s.connect(new StdioServerTransport());
`);
  return { command: process.execPath, args: [file] };
}

test('K60. 도구 이름은 64자 이하·중복 없음, 줄인 이름으로 불러도 원래 도구가 돈다', async () => {
  const mcp = await connectMcpServers({ 'company-analytics-warehouse': await probeServer() }, { timeoutMs: MCP_CONNECT_TIMEOUT_MS });
  try {
    assert.equal(mcp.statuses[0].status, 'connected');
    const names = mcp.tools.map((t) => t.name);
    assert.ok(names.every((n) => n.length <= 64 && /^[A-Za-z0-9_-]+$/.test(n)), `벤더 규격(64자·문자 집합): ${names.join(', ')}`);
    assert.equal(new Set(names).size, names.length, `중복 이름 없음: ${names.join(', ')}`);
    assert.ok(names.every((n) => n.startsWith('mcp__company-analytics-warehouse__')), '게이트·상태 표시가 쓰는 mcp__<서버>__ 접두 유지');
    const long = mcp.tools.find((t) => t.description === 'long');
    assert.ok(long, '긴 이름 도구가 빠지지 않는다');
    assert.equal(await long.run({}), 'long-ok', '줄인 이름이 원래 도구 이름으로 호출된다');
    assert.equal(mcp.tools.filter((t) => t.name === 'mcp__company-analytics-warehouse__a_b').length, 1, '치환 충돌은 하나만 남긴다');
    assert.equal(mcp.tools.find((t) => t.name === 'mcp__company-analytics-warehouse__a_b').description, 'dot', '먼저 온 도구가 남는다(결정적)');
  } finally { await mcp.close(); }
});

test('K59. 도구 호출에 정지 신호와 넉넉한 상한이 전달된다 — 정지하면 곧바로 끊긴다(SDK 기본 60초를 기다리지 않는다)', async () => {
  const mcp = await connectMcpServers({ probe: await probeServer() }, { timeoutMs: MCP_CONNECT_TIMEOUT_MS });
  const orig = Client.prototype.callTool; const seen = [];
  Client.prototype.callTool = function (params, schema, options) { seen.push(options); return orig.call(this, params, schema, options); };
  try {
    const sleepy = mcp.tools.find((t) => t.name === 'mcp__probe__sleepy');
    const ac = new AbortController(); setTimeout(() => ac.abort(), 300);
    const t0 = Date.now();
    await assert.rejects(Promise.race([sleepy.run({}, { signal: ac.signal }), new Promise((_, rej) => setTimeout(() => rej(new Error('stop ignored for 5s')), 5000))]), (e) => !/stop ignored/.test(e.message));
    assert.ok(Date.now() - t0 < 3000, '정지 뒤 3초 안에 끊긴다');
    assert.ok(seen[0]?.signal, '신호 전달');
    assert.ok(Number(seen[0]?.timeout) >= 30 * 60_000, `호출 상한이 SDK 기본 60초가 아니라 턴 상한 수준: ${seen[0]?.timeout}`);
  } finally { Client.prototype.callTool = orig; await mcp.close(); }
});

test('K61a. 텍스트가 아닌 결과 파트는 base64째 문맥에 싣지 않고 자리표시로 — 텍스트 리소스는 본문을 싣는다', async () => {
  const mcp = await connectMcpServers({ probe: await probeServer() }, { timeoutMs: MCP_CONNECT_TIMEOUT_MS });
  try {
    const out = await mcp.tools.find((t) => t.name === 'mcp__probe__pic').run({});
    assert.match(out, /caption/);
    assert.match(out, /resource body/);
    assert.match(out, /image\/png/, '이미지 자리표시에 형식');
    assert.ok(!out.includes(Buffer.alloc(3000, 7).toString('base64').slice(0, 100)), '이미지 base64 원문 없음');
    assert.ok(!out.includes(Buffer.alloc(3000, 9).toString('base64').slice(0, 100)), '바이너리 리소스 base64 원문 없음');
    assert.ok(out.length < 1000, `결과 길이 ${out.length}`);
  } finally { await mcp.close(); }
});

test('K61b. HTTP 접속이 401이고 SSE 폴백도 실패하면 원래(HTTP) 오류가 상태에 남는다', async () => {
  const srv = createServer((req, res) => {
    req.resume(); req.on('end', () => {
      if (req.method === 'POST') { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'invalid_token' })); }
      else { res.writeHead(404); res.end('not found'); }
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const mcp = await connectMcpServers({ remote: { url: `http://127.0.0.1:${srv.address().port}/mcp` } }, { timeoutMs: 3000 });
    await mcp.close();
    assert.equal(mcp.statuses[0].status, 'failed');
    assert.match(mcp.statuses[0].error, /401/, `원래 오류: ${mcp.statuses[0].error}`);
  } finally { await new Promise((r) => srv.close(r)); }
});
