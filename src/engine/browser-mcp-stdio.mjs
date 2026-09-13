import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { BROWSER_SPECS } from './browser-specs.mjs';

const url = new URL(process.env.ARGO_BROWSER_RELAY_URL || 'http://invalid/');
const token = process.env.ARGO_BROWSER_RELAY_TOKEN;
if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !token) throw new Error('Scoped browser relay unavailable');
const server = new Server({ name: 'argo-browser', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: BROWSER_SPECS.map(({ name, description, input_schema }) => ({ name, description, inputSchema: input_schema })) }));
server.setRequestHandler(CallToolRequestSchema, async ({ params }, extra) => {
  try {
    const response = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(params), signal: AbortSignal.any([extra.signal, AbortSignal.timeout(120_000)]) });
    if (!response.ok) throw new Error('Relay rejected browser call');
    return await response.json();
  } catch { return { isError: true, content: [{ type: 'text', text: 'Browser task disconnected or cancelled.' }] }; }
});
await server.connect(new StdioServerTransport());
