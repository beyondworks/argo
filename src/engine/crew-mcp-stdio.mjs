import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

// CLI 러너(codex·gemini)의 턴별 크루 도구 중계(K94) — 도구 목록·실행은 전부 호스트(chat.mjs 턴)가 가진다. 이 자식은 전달만.
const url = new URL(process.env.ARGO_CREW_RELAY_URL || 'http://invalid/');
const token = process.env.ARGO_CREW_RELAY_TOKEN;
if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !token) throw new Error('Scoped crew relay unavailable');
const relay = (body, signal) => fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
const server = new Server({ name: 'argo-crew', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => {
  const r = await relay({ op: 'list' }, AbortSignal.timeout(15_000));
  if (!r.ok) throw new Error('Relay rejected tool list');
  return r.json();
});
server.setRequestHandler(CallToolRequestSchema, async ({ params }, extra) => {
  try {
    // 동기 위임은 동료 턴 끝까지 기다린다 — CLI 턴 상한(30분)과 같은 상한. 러너 쪽 도구 제한은 설정으로 맞춘다(codex tool_timeout_sec·gemini timeout).
    const r = await relay({ op: 'call', name: params.name, arguments: params.arguments ?? {} }, AbortSignal.any([extra.signal, AbortSignal.timeout(30 * 60_000)]));
    if (!r.ok) throw new Error('Relay rejected crew call');
    return await r.json();
  } catch { return { isError: true, content: [{ type: 'text', text: 'Crew tool disconnected or cancelled.' }] }; }
});
await server.connect(new StdioServerTransport());
