// 외부 MCP 서버 접속(네이티브 엔진) — SDK가 직접 띄우던 것을 @modelcontextprotocol/sdk Client로 우리가 띄운다.
// 도구 이름은 SDK와 같은 `mcp__<서버>__<도구>` — permission-gate의 mcp 분기(경로 인자 검사)·turn-status 단계 매핑이 그대로 맞는다.
// 접속 실패는 던지지 않고 status로 남긴다(SDK system/init의 mcp_servers 형태 — chat.mjs mcpFailures가 소비).
// 실패한 접속의 transport·client는 반드시 닫는다(분리 검수 MEDIUM-3: 무응답 stdio 서버가 턴마다 고아 프로세스를 남겼다).
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { createHash } from 'node:crypto';
import { shellEnv } from './builtin-tools.mjs';
import { VENDOR_HTTP_TIMEOUT_MS } from './http-errors.mjs';

const safe = (s) => String(s).replace(/[^A-Za-z0-9_-]/g, '_');
/** 벤더 도구 이름 상한 64자(^[a-zA-Z0-9_-]{1,64}$) — 넘으면 앞부분 + 원래 이름 해시 8자로 결정적으로 줄인다(K60: 한 도구가 그 회사 네이티브 턴 전부를 400으로 죽였다).
    앞부분을 남기므로 mcp__<서버>__ 접두(게이트·상태 표시가 쓰는 판정)는 서버 이름이 아주 길지 않은 한 보존된다. 호출은 원래 이름(t.name)으로 한다. */
const TOOL_NAME_MAX = 64;
const fitName = (n) => (n.length <= TOOL_NAME_MAX ? n : `${n.slice(0, TOOL_NAME_MAX - 9)}_${createHash('sha256').update(n).digest('hex').slice(0, 8)}`);
/** 결과 파트 → 문맥 텍스트. 이미지·오디오·바이너리 리소스는 base64째 싣지 않고 자리표시(K61 — 문맥을 base64로 채웠다). 텍스트 리소스는 본문.
    (스크린샷용 이미지 경로 imageToolResult는 png/jpeg 한 장을 screenshots 폴더에 저장하는 전용 — 임의 형식·여러 장의 MCP 결과엔 쓰지 않는다) */
const partText = (c) => {
  if (c?.type === 'text') return c.text;
  if (c?.type === 'resource') return typeof c.resource?.text === 'string' ? c.resource.text : `[resource ${c.resource?.uri ?? ''} (${c.resource?.mimeType ?? 'binary'}) — binary content omitted]`;
  if (c?.type === 'image' || c?.type === 'audio') return `[${c.type} ${c.mimeType ?? ''} ${Math.round((String(c.data ?? '').length * 3) / 4 / 1024)}KB — not shown]`;
  return JSON.stringify(c);
};
export const MCP_CONNECT_TIMEOUT_MS = 8_000; // 서버당 접속+목록 상한(병렬) — 죽은 서버가 턴 시작을 이 이상 밀지 않는다(3차 검수 T10: 상수 핀)

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
    else {
      try { conn = await attempt(name, () => new StreamableHTTPClientTransport(u, init), timeoutMs); }
      // 옛 SSE 서버용 폴백 — 둘 다 실패면 HTTP 쪽 원래 오류(401 등)를 남긴다(K61: 폴백 오류가 인증 실패를 덮었다)
      catch (httpErr) { try { conn = await attempt(name, () => new SSEClientTransport(u, init), timeoutMs); } catch { throw httpErr; } }
    }
  } else throw new Error('unsupported MCP server definition');
  const { client, list } = conn;
  const tools = (list?.tools ?? []).map((t) => ({
    name: fitName(`mcp__${safe(name)}__${safe(t.name)}`), description: t.description || `${name}: ${t.name}`,
    input_schema: t.inputSchema ?? { type: 'object', properties: {} },
    gated: true, // 사장이 연결한 임의 서버(파일 쓰기 도구 포함) — SDK와 같이 permission-gate의 mcp 분기를 지난다
    // 정지 신호·상한 전달(K59) — 안 넘기면 SDK 기본 60초(protocol.js DEFAULT_REQUEST_TIMEOUT_MSEC)에 긴 도구가 늘 실패하고 정지 버튼도 그만큼 안 먹었다.
    // 상한은 벤더 호출 1회와 같은 30분(VENDOR_HTTP_TIMEOUT_MS = CLI 대화 턴 상한).
    run: async (input, { signal } = {}) => {
      const r = await client.callTool({ name: t.name, arguments: input ?? {} }, undefined, { signal, timeout: VENDOR_HTTP_TIMEOUT_MS });
      const text = (r?.content ?? []).map(partText).join('\n');
      if (r?.isError) throw new Error(text || 'MCP tool error');
      return text;
    },
  }));
  return { client, tools };
}

/** 서버 맵(materializeMcpServers 산출) 전부 접속 — 실패는 status:'failed'로. close()는 전 클라이언트 종료. */
export async function connectMcpServers(servers = {}, { env = process.env, cwd = process.cwd(), timeoutMs = MCP_CONNECT_TIMEOUT_MS } = {}) {
  const clients = []; const tools = []; const statuses = [];
  // 병렬 접속 — 직렬이면 죽은 서버 하나당 상한만큼 턴 시작이 밀린다(재검수 LOW: 15s×2대 = 턴 시작 ~90초). 순서는 입력 순서로 고정.
  const entries = Object.entries(servers ?? {});
  const results = await Promise.all(entries.map(async ([name, def]) => {
    if (!def || typeof def !== 'object') return { name, status: 'failed' };
    try { const c = await connectOne(name, def, { env, cwd, timeoutMs }); return { name, status: 'connected', c }; }
    catch (e) { return { name, status: 'failed', error: `${Number.isInteger(e?.code) && e.code >= 400 ? `HTTP ${e.code} ` : ''}${String(e?.message || e)}`.slice(0, 200) }; } // 본문이 비어도 상태 코드는 남긴다(SDK StreamableHTTPError.code)
  }));
  for (const r of results) {
    if (r.c) {
      clients.push(r.c.client);
      // 치환 뒤 같은 이름(`a.b`·`a_b`, 서버 `my.srv`·`my_srv`)은 먼저 온 것만 — 중복 도구 이름은 벤더가 요청째 거절한다(K60)
      for (const t of r.c.tools) { if (tools.some((x) => x.name === t.name)) console.warn(`[argo] MCP 도구 이름 충돌로 건너뜀: ${r.name} → ${t.name}`); else tools.push(t); }
      statuses.push({ name: r.name, status: 'connected' });
    } else statuses.push({ name: r.name, status: r.status, ...(r.error ? { error: r.error } : {}) });
  }
  return { tools, statuses, close: async () => { for (const c of clients) await c.close().catch(() => {}); } };
}
