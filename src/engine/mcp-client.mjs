// 외부 MCP 서버 접속(네이티브 엔진) — SDK가 직접 띄우던 것을 @modelcontextprotocol/sdk Client로 우리가 띄운다.
// 도구 이름은 SDK와 같은 `mcp__<서버>__<도구>` — permission-gate의 mcp 분기(경로 인자 검사)·turn-status 단계 매핑이 그대로 맞는다.
// 접속 실패는 던지지 않고 status로 남긴다(SDK system/init의 mcp_servers 형태 — chat.mjs mcpFailures가 소비).
// 실패한 접속의 transport·client는 반드시 닫는다(분리 검수 MEDIUM-3: 무응답 stdio 서버가 턴마다 고아 프로세스를 남겼다).
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { shellEnv } from './builtin-tools.mjs';

const safe = (s) => String(s).replace(/[^A-Za-z0-9_-]/g, '_');

function withTimeout(p, ms, label) {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${label} timeout ${ms}ms`)), ms); })]).finally(() => clearTimeout(t));
}

/** transport 하나로 접속 시도 — 실패하면 client·transport를 닫고 던진다(자식 프로세스·소켓 정리). */
async function attempt(name, makeTransport, timeoutMs) {
  const client = new Client({ name: 'argo-native-engine', version: '1.0.0' });
  const transport = makeTransport();
  try {
    await withTimeout(client.connect(transport), timeoutMs, `${name} connect`);
    const list = await withTimeout(client.listTools(), timeoutMs, `${name} listTools`);
    return { client, transport, list };
  } catch (e) {
    await client.close().catch(() => {});
    await transport.close?.().catch(() => {});
    throw e;
  }
}

async function connectOne(name, def, { env, cwd, timeoutMs }) {
  let conn;
  if (def.command) {
    // 자식 env는 여기서도 세척한다(호출부 세척과 2중 — 러너 자격이 임의 MCP 서버 프로세스로 새지 않게, 분리 검수 R4)
    conn = await attempt(name, () => new StdioClientTransport({ command: def.command, args: def.args ?? [], env: { ...shellEnv(env), ...(def.env ?? {}) }, cwd, stderr: 'ignore' }), timeoutMs);
  } else if (def.url) {
    const u = new URL(def.url); const init = def.headers ? { requestInit: { headers: def.headers } } : {};
    if (def.type === 'sse') conn = await attempt(name, () => new SSEClientTransport(u, init), timeoutMs);
    else { try { conn = await attempt(name, () => new StreamableHTTPClientTransport(u, init), timeoutMs); } catch { conn = await attempt(name, () => new SSEClientTransport(u, init), timeoutMs); } }
  } else throw new Error('unsupported MCP server definition');
  const { client, list } = conn;
  const tools = (list?.tools ?? []).map((t) => ({
    name: `mcp__${safe(name)}__${safe(t.name)}`, description: t.description || `${name}: ${t.name}`,
    input_schema: t.inputSchema ?? { type: 'object', properties: {} },
    gated: true, // 사장이 연결한 임의 서버(파일 쓰기 도구 포함) — SDK와 같이 permission-gate의 mcp 분기를 지난다
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
