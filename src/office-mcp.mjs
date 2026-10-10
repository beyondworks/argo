// argo office mcp — 아르고 오피스 MCP 서버(표준 입출력). Claude Code·Codex 등이 붙어 오피스를 읽고 쓴다(유건 10/10).
//   claude mcp add argo-office -- node <저장소>/bin/argo.mjs office mcp
//   codex: ~/.codex/config.toml [mcp_servers.argo-office] command = "node", args = ["<저장소>/bin/argo.mjs", "office", "mcp"]
// 도구 = argo office CLI와 같은 정의(office-tools-cli.mjs cliSpecs — 되돌릴 수 없는 동작은 뺐다) + office_orgs(내 조직 목록).
// 도구마다 선택 인자 org(id·slug·이름 — 비우면 기본 조직). 출처 세션 이름 = ARGO_OFFICE_SOURCE 또는 붙은 클라이언트 이름(initialize의 clientInfo).
// 인증은 부를 때마다 기기 세션을 새로 받는다(만료 60초 전 회전은 getFreshDeviceSession이 잠금 안에서) — 오래 떠 있는 서버라도 토큰이 낡지 않게.
import { z } from 'zod';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { cliSpecs, checkArgs, bindSession, myOrgs, resolveOrg, runTool, inAgentTurn, agentTurnState, agentTurnRefusal } from './office-tools-cli.mjs';

const ORG_ARG = z.string().optional().describe('조직 id·slug·이름(office_orgs가 보여 준 것). 비우면 기본 조직. 일정·메일·브리핑은 비우면 개인 공간');
const CLIENT_NAMES = { 'claude-code': 'Claude Code', codex: 'Codex', 'codex-mcp-client': 'Codex' };

/** 도구 목록(JSON 스키마)과 실행기 — 서버 없이 시험할 수 있게 나눈다. send = 실행 결과 { content, isError? } */
export function officeMcp({ root, lang = 'ko', cfgOrg = null, clientName = () => null, _fresh, _mkClient, _ancestor } = {}) {
  const specs = cliSpecs(lang);
  const tools = [
    ...specs.map((s) => ({ name: s.name, description: s.description, inputSchema: z.toJSONSchema(z.object({ ...s.shape, org: ORG_ARG })) })),
    { name: 'office_orgs', description: lang === 'en' ? 'List my Argo Office organizations (id, name, slug, role, default).' : '내가 속한 아르고 오피스 조직 목록(id·이름·slug·역할·기본).', inputSchema: z.toJSONSchema(z.object({})) },
  ];
  const textOf = (t, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });
  const needLogin = lang === 'en' ? 'Not signed in to Argo Office — run: ARGO_ROOT=<data folder> argo login' : '아르고 오피스에 로그인돼 있지 않습니다 — ARGO_ROOT=<데이터 폴더> argo login 을 실행하세요.';
  let ancestry; // 조상 판정(null 사람 | 'agent')은 한 번만 — 떠 있는 동안 조상은 바뀌지 않는다. 판정 실패는 담아 두지 않고 다음 호출에 다시 본다(분리 검수 L2)
  async function call(name, rawArgs = {}) {
    // 아르고 크루가 띄운 MCP 자식이면 거절(분리 검수 MEDIUM-1) — env 표지는 부를 때마다, 조상 표지는 한 번
    if (inAgentTurn()) return textOf(agentTurnRefusal('agent', lang), true);
    if (ancestry === undefined) {
      const st = await agentTurnState({ env: {}, _ancestor });
      if (st === 'unknown') return textOf(agentTurnRefusal(st, lang), true);
      ancestry = st;
    }
    if (ancestry) return textOf(agentTurnRefusal(ancestry, lang), true);
    const c = await bindSession(root, { _fresh, _mkClient });
    if (!c) return textOf(needLogin, true);
    if (name === 'office_orgs') {
      const orgs = await myOrgs(c);
      return textOf(JSON.stringify(orgs.map((o) => ({ ...o, default: o.id === cfgOrg }))));
    }
    const spec = specs.find((s) => s.name === name);
    if (!spec) return textOf(`unknown tool: ${name}`, true);
    const { org: orgWant, ...args } = rawArgs ?? {};
    const checked = checkArgs(spec, args);
    if (!checked.ok) return textOf(checked.issues.join('\n'), true);
    const o = await resolveOrg(c, orgWant, cfgOrg);
    if (o.error) return textOf(o.error, true);
    const source = String(process.env.ARGO_OFFICE_SOURCE ?? '').trim() || CLIENT_NAMES[clientName()] || clientName() || 'MCP';
    return textOf(await runTool(spec, checked.args, { c, org: o.org, sourceName: source.slice(0, 120), lang }));
  }
  return { tools, call };
}

export async function serveMcp(opts = {}) {
  const server = new Server({ name: 'argo-office', version: '1.0.0' }, { capabilities: { tools: {} } });
  const mcp = officeMcp({ ...opts, clientName: () => server.getClientVersion()?.name ?? null });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: mcp.tools }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    try { return await mcp.call(params.name, params.arguments ?? {}); }
    catch (e) { return { isError: true, content: [{ type: 'text', text: String(e?.message ?? e).slice(0, 500) }] }; }
  });
  const closed = new Promise((resolve) => { server.onclose = resolve; });
  const transport = new StdioServerTransport();
  process.stdin.once('end', () => { transport.close().catch(() => {}); }); // 붙은 클라이언트가 끊으면 닫는다
  await server.connect(transport);
  await closed; // 연결이 닫힐 때까지 — 끝내는 것은 붙은 클라이언트
  return 0;
}
