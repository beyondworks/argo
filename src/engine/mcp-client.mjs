// 외부 MCP 서버 접속(네이티브 엔진) — SDK가 직접 띄우던 것을 @modelcontextprotocol/sdk Client로 우리가 띄운다.
// 도구 이름은 SDK와 같은 `mcp__<서버>__<도구>` — permission-gate의 mcp 분기(경로 인자 검사)·turn-status 단계 매핑이 그대로 맞는다.
// 접속 실패는 던지지 않고 status로 남긴다(SDK system/init의 mcp_servers 형태 — chat.mjs mcpFailures가 소비).
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

const safe = (s) => String(s).replace(/[^A-Za-z0-9_-]/g, '_');

function withTimeout(p, ms, label) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timeout ${ms}ms`)), ms))]);
}

async function connectOne(name, def, { env, cwd, timeoutMs }) {
  const client = new Client({ name: 'argo-native-engine', version: '1.0.0' });
  const tryTransport = async (t) => { await withTimeout(client.connect(t), timeoutMs, `${name} connect`); return t; };
  if (def.command) {
    await tryTransport(new StdioClientTransport({ command: def.command, args: def.args ?? [], env: { ...env, ...(def.env ?? {}) }, cwd, stderr: 'ignore' }));
  } else if (def.url) {
    const u = new URL(def.url); const init = def.headers ? { requestInit: { headers: def.headers } } : {};
    if (def.type === 'sse') await tryTransport(new SSEClientTransport(u, init));
    else { try { await tryTransport(new StreamableHTTPClientTransport(u, init)); } catch { await tryTransport(new SSEClientTransport(u, init)); } }
  } else throw new Error('unsupported MCP server definition');
  const list = await withTimeout(client.listTools(), timeoutMs, `${name} listTools`);
  const tools = (list?.tools ?? []).map((t) => ({
    name: `mcp__${safe(name)}__${safe(t.name)}`, description: t.description || `${name}: ${t.name}`,
    input_schema: t.inputSchema ?? { type: 'object', properties: {} },
    gated: true,
    run: async (input) => {
      const r = await client.callTool({ name: t.name, arguments: input ?? {} });
      const text = (r?.content ?? []).map((c) => (c.type === 'text' ? c.text : JSON.stringify(c))).join('\n');
      if (r?.isError) throw new Error(text || 'MCP tool error');
      return text;
    },
  }));
  return { client, tools };
}

/** 서버 맵(materializeMcpServers 산출) 전부 접속 — 실패는 status:'failed'로. close()는 전 클라이언트 종료. */
export async function connectMcpServers(servers = {}, { env = process.env, cwd = process.cwd(), timeoutMs = 15_000 } = {}) {
  const clients = []; const tools = []; const statuses = [];
  for (const [name, def] of Object.entries(servers ?? {})) {
    if (!def || typeof def !== 'object') { statuses.push({ name, status: 'failed' }); continue; }
    try {
      const c = await connectOne(name, def, { env, cwd, timeoutMs });
      clients.push(c.client); tools.push(...c.tools); statuses.push({ name, status: 'connected' });
    } catch (e) {
      statuses.push({ name, status: 'failed', error: String(e?.message || e).slice(0, 200) });
    }
  }
  return { tools, statuses, close: async () => { for (const c of clients) await c.close().catch(() => {}); } };
}
