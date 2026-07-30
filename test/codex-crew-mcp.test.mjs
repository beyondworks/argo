import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createCodexCrewMcpServer } from '../src/codex-crew-mcp.mjs';
import { normalizeCrewContext } from '../src/crew-actions.mjs';

const context = normalizeCrewContext({
  wsId: 'company-1',
  fromSlug: 'master',
  fromName: '마스터',
  colleagues: [{ slug: 'sw-cto', name: 'SW CTO' }],
  hop: 0,
  chain: [],
  lang: 'ko',
});

test('Codex stdio MCP 표면은 Argo delegate/send_to_crew만 노출하고 호출을 전달한다', async () => {
  const calls = [];
  const server = createCodexCrewMcpServer(context, {
    delegate: async (input) => { calls.push(['delegate', input]); return '위임 결과'; },
    sendToCrew: async (input) => { calls.push(['send', input]); return '쪽지 결과'; },
  });
  const client = new Client({ name: 'argo-crew-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), ['delegate', 'send_to_crew']);
    assert.match(listed.tools.find((tool) => tool.name === 'delegate').description, /Argo/);

    const delegated = await client.callTool({
      name: 'delegate',
      arguments: { to: 'sw-cto', task: '상태 확인' },
    });
    const mailed = await client.callTool({
      name: 'send_to_crew',
      arguments: { to: 'sw-cto', message: '비동기 확인' },
    });
    assert.equal(delegated.content[0].text, '위임 결과');
    assert.equal(mailed.content[0].text, '쪽지 결과');
    assert.deepEqual(calls, [
      ['delegate', { to: 'sw-cto', task: '상태 확인' }],
      ['send', { to: 'sw-cto', message: '비동기 확인' }],
    ]);
  } finally {
    await client.close();
    await server.close();
  }
});
