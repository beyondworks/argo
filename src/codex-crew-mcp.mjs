#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { decodeCrewContext, makeCrewActions } from './crew-actions.mjs';

const INSTRUCTIONS = `This server coordinates crew inside the current Argo company.
Use delegate for a synchronous subtask and send_to_crew for an asynchronous message.
The listed slugs are the complete authorization boundary. Never use Orca, orca-ide,
orca-cli, or a host orchestration skill for Argo crew coordination.`;

const text = (value) => ({ content: [{ type: 'text', text: String(value) }] });

export function createCodexCrewMcpServer(context, actions) {
  const roster = context.colleagues.map((agent) => `${agent.name} (${agent.slug})`).join(', ');
  const server = new McpServer(
    { name: 'argo-crew', version: '1.0.0' },
    { instructions: `${INSTRUCTIONS}\nAuthorized colleagues: ${roster}` },
  );
  server.registerTool('delegate', {
    title: 'Delegate to Argo crew',
    description: 'Delegate one concrete subtask to an authorized Argo colleague and wait for the result. This acts only inside Argo; it does not use Orca.',
    inputSchema: {
      to: z.string().min(1).max(128).describe('Authorized colleague slug'),
      task: z.string().min(1).max(50_000).describe('Self-contained concrete task'),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  }, async (input) => text(await actions.delegate(input)));
  server.registerTool('send_to_crew', {
    title: 'Message Argo crew',
    description: 'Send an asynchronous internal message to an authorized Argo colleague. Use delegate instead when an immediate result is required.',
    inputSchema: {
      to: z.string().min(1).max(128).describe('Authorized colleague slug'),
      cc: z.array(z.string().min(1).max(128)).max(10).optional(),
      message: z.string().min(1).max(50_000).describe('Self-contained message'),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  }, async (input) => text(await actions.sendToCrew(input)));
  return server;
}

async function main() {
  const context = decodeCrewContext(process.env.ARGO_CREW_CONTEXT);
  // 이 값은 MCP 자식에게만 필요한 일회성 권한 범위다. 하위 Codex 턴 환경으로 재상속하지 않는다.
  delete process.env.ARGO_CREW_CONTEXT;
  const { chat } = await import('./chat.mjs');
  const actions = makeCrewActions(context, { runChat: chat });
  const server = createCodexCrewMcpServer(context, actions);
  await server.connect(new StdioServerTransport());
}

const direct = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (direct) {
  main().catch((error) => {
    console.error(`[argo-crew-mcp] ${String(error?.message || error)}`);
    process.exit(1);
  });
}
