import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectOpenAICompatMcpTools } from '../src/openai-compat-mcp.mjs';

const serverCode = `
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
const server = new McpServer({ name: 'fixture', version: '1.0.0' });
server.registerTool('echo', { description: 'echo text', inputSchema: { text: z.string() } }, async ({ text }) => ({ content: [{ type: 'text', text: 'echo:' + text }] }));
server.registerTool('label', { description: 'server label', inputSchema: {} }, async () => ({ content: [{ type: 'text', text: process.env.FIXTURE_LABEL || 'none' }] }));
await server.connect(new StdioServerTransport());
`;

test('OpenAI 호환 MCP 브리지 — 회사 stdio MCP의 도구 목록과 실행 결과를 function tool로 변환', async () => {
  const bridge = await connectOpenAICompatMcpTools({
    fixture: { command: process.execPath, args: ['--input-type=module', '-e', serverCode] },
  }, { cwd: process.cwd() });
  try {
    assert.equal(bridge.tools.length, 2);
    const echo = bridge.tools.find((tool) => tool.canonicalName === 'mcp__fixture__echo');
    assert.equal(echo.definition.function.name, 'mcp__fixture__echo');
    assert.equal(await echo.execute({ text: 'hello' }), 'echo:hello');
  } finally {
    await bridge.close();
  }
});

test('OpenAI 호환 MCP 브리지 — 정규화 결과가 같은 서버 이름도 고유한 function 이름을 사용', async () => {
  const bridge = await connectOpenAICompatMcpTools({
    'fixture.one': { command: process.execPath, args: ['--input-type=module', '-e', serverCode], env: { FIXTURE_LABEL: 'dot' } },
    'fixture@one': { command: process.execPath, args: ['--input-type=module', '-e', serverCode], env: { FIXTURE_LABEL: 'at' } },
  }, { cwd: process.cwd() });
  try {
    const labels = bridge.tools.filter((tool) => tool.definition.function.description.includes('server label'));
    assert.equal(labels.length, 2);
    assert.equal(new Set(labels.map((tool) => tool.definition.function.name)).size, 2);
    assert.equal(new Set(labels.map((tool) => tool.canonicalName)).size, 2);
    assert.deepEqual(new Set(await Promise.all(labels.map((tool) => tool.execute({})))), new Set(['dot', 'at']));
  } finally {
    await bridge.close();
  }
});

test('OpenAI 호환 MCP 브리지 — 턴 중단 신호가 초기 서버 연결도 즉시 끝냄', async () => {
  const controller = new AbortController();
  const started = Date.now();
  setTimeout(() => controller.abort(new DOMException('테스트 중단', 'AbortError')), 30);
  await assert.rejects(connectOpenAICompatMcpTools({
    hanging: { command: process.execPath, args: ['-e', 'setTimeout(() => {}, 30000)'] },
  }, { cwd: process.cwd(), signal: controller.signal }), (error) => error?.name === 'AbortError');
  assert.ok(Date.now() - started < 3000, '중단된 MCP 연결이 자체 제한까지 남아 있으면 안 됨');
});
