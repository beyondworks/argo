// OpenAI 호환 모델용 MCP 클라이언트 브리지.
// 회사 mcp.json의 stdio/HTTP 서버를 실제 OpenAI function tool로 변환하고 턴 종료 시 닫는다.
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { scrubServerSecrets } from './runners/shared.mjs';

const MAX_MCP_TOOLS = 96;
const MAX_MCP_RESULT_CHARS = 120_000;

const safePart = (value) => String(value ?? '').toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'tool';
function openAIName(server, tool) {
  const raw = `mcp__${safePart(server)}__${safePart(tool)}`;
  if (raw.length <= 64) return raw;
  const hash = createHash('sha256').update(raw).digest('hex').slice(0, 8);
  return `${raw.slice(0, 55)}_${hash}`;
}

function uniqueOpenAIName(server, tool, usedNames) {
  const preferred = openAIName(server, tool);
  if (!usedNames.has(preferred)) {
    usedNames.add(preferred);
    return preferred;
  }
  const source = `${server}\0${tool}`;
  const hash = createHash('sha256').update(source).digest('hex').slice(0, 12);
  const unique = `${preferred.slice(0, 51)}_${hash}`;
  if (usedNames.has(unique)) throw new Error(`MCP 도구 이름 충돌: ${server}/${tool}`);
  usedNames.add(unique);
  return unique;
}

function stdioEnv(extra = {}) {
  const base = scrubServerSecrets(process.env, 'deepseeklocal');
  return { ...base, ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, String(v)])) };
}

function transportFor(def, cwd) {
  if (def?.command) {
    return new StdioClientTransport({
      command: String(def.command),
      args: Array.isArray(def.args) ? def.args.map(String) : [],
      env: stdioEnv(def.env), cwd, stderr: 'pipe', maxBufferSize: 10 * 1024 * 1024,
    });
  }
  if (def?.url) {
    const headers = Object.fromEntries(Object.entries(def.headers ?? {}).map(([k, v]) => [k, String(v)]));
    return new StreamableHTTPClientTransport(new URL(String(def.url)), { requestInit: { headers } });
  }
  throw new Error('MCP 서버에 command 또는 url이 없다.');
}

function mcpResultText(result) {
  const chunks = [];
  for (const item of result?.content ?? []) {
    if (item.type === 'text') chunks.push(item.text);
    else if (item.type === 'resource' && typeof item.resource?.text === 'string') chunks.push(item.resource.text);
    else if (item.type === 'resource_link') chunks.push(`[resource] ${item.name}: ${item.uri}`);
    else if (item.type === 'image') chunks.push(`[image ${item.mimeType || 'unknown'} — binary omitted]`);
    else if (item.type === 'audio') chunks.push(`[audio ${item.mimeType || 'unknown'} — binary omitted]`);
  }
  if (result?.structuredContent) chunks.push(JSON.stringify(result.structuredContent));
  const text = chunks.filter(Boolean).join('\n\n').slice(0, MAX_MCP_RESULT_CHARS);
  return result?.isError ? `MCP tool error: ${text || 'unknown error'}` : (text || 'MCP tool completed without text output.');
}

/** 반환 tools 항목: { definition, canonicalName, execute }. close()는 반드시 finally에서 호출한다. */
export async function connectOpenAICompatMcpTools(servers = {}, { cwd, onWarning = () => {}, signal = null } = {}) {
  const live = [];
  const tools = [];
  const usedNames = new Set();
  const closeConnections = async (connections) => {
    await Promise.allSettled(connections.map(async ({ client, transport }) => {
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
    }));
  };
  for (const [serverName, def] of Object.entries(servers ?? {})) {
    let client;
    let transport;
    try {
      client = new Client({ name: 'argo-openai-compat', version: '1.0.0' }, { capabilities: {} });
      transport = transportFor(def, cwd);
      const connectSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000);
      await client.connect(transport, { signal: connectSignal });
      const listSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000);
      const listed = await client.listTools(undefined, { signal: listSignal });
      live.push({ client, transport });
      for (const item of listed.tools ?? []) {
        if (tools.length >= MAX_MCP_TOOLS) break;
        const name = uniqueOpenAIName(serverName, item.name, usedNames);
        tools.push({
          definition: {
            type: 'function',
            function: {
              name,
              description: `[MCP ${serverName}] ${String(item.description || item.name).slice(0, 1000)}`,
              parameters: item.inputSchema && typeof item.inputSchema === 'object'
                ? item.inputSchema
                : { type: 'object', properties: {}, additionalProperties: true },
            },
          },
          canonicalName: name,
          execute: async (args, _gateArgs, { signal = null } = {}) => mcpResultText(await client.callTool(
            { name: item.name, arguments: args },
            undefined,
            { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000) },
          )),
        });
      }
    } catch (error) {
      await transport?.close().catch(() => {});
      await client?.close().catch(() => {});
      if (signal?.aborted) {
        await closeConnections(live);
        throw signal.reason || new DOMException('중단됨', 'AbortError');
      }
      onWarning(`${serverName}: ${String(error?.message || error).slice(0, 300)}`);
    }
  }
  return {
    tools,
    close: async () => closeConnections(live),
  };
}
