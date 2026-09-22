// CLI 러너 크루 도구 다리(K94, 유건 지시 2026-09-22 "러너마다 편차가 없어야") — 브라우저 다리(browser-mcp.mjs)와 같은 형태:
// 턴마다 127.0.0.1 릴레이 + 일회용 토큰, 러너는 stdio 자식(crew-mcp-stdio.mjs)을 MCP 서버로 띄운다.
// 도구 정의·입력 검증·처리기는 네이티브 엔진과 같은 crewToolSpecs(makeCrewServer의 sink) — SDK·네이티브·CLI가 한 원천이다.
// 권한: 크루 도구는 SDK에서도 사전 승인(게이트 밖)이고 손님·주인 판정은 처리기 안에 있다 — 여기서도 게이트를 따로 태우지 않는다.
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

export function crewMcpWorkerPath({ cwd = process.cwd(), argv1 = process.argv[1] } = {}) {
  const rel = ['src', 'engine', 'crew-mcp-stdio.mjs'];
  const candidates = [resolve(cwd, ...rel), argv1 ? resolve(dirname(argv1), ...rel) : null,
    (() => { try { return fileURLToPath(new URL('./crew-mcp-stdio.mjs', import.meta.url)); } catch { return null; } })()];
  const file = candidates.find((p) => p && existsSync(p));
  if (!file) throw new Error('Crew tool worker is missing from this installation');
  return file;
}

const PREFIX = 'mcp__crew__';

/** specs = crewToolSpecs(sink) — { name: 'mcp__crew__x', description, input_schema, run(input) }. 러너에는 접두 없는 이름으로 광고한다
    (codex·gemini가 서버 이름 crew를 붙여 SDK와 같은 mcp__crew__x 계열이 된다). 반환 server는 cliMcpServers.crew 값. */
export async function createCrewMcpBridge(specs = []) {
  const worker = crewMcpWorkerPath();
  const token = randomBytes(32).toString('hex');
  const byName = new Map(specs.map((s) => [s.name.startsWith(PREFIX) ? s.name.slice(PREFIX.length) : s.name, s]));
  const list = { tools: [...byName].map(([name, s]) => ({ name, description: s.description, inputSchema: s.input_schema })) };
  const controller = new AbortController();
  const called = []; // 이번 턴에 처리기까지 간 크루 도구 호출 { name(접두 없음), input } — 지시 블록 이중 실행 판정용
  const server = createServer(async (req, res) => {
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
    const supplied = Buffer.from(String(req.headers.authorization ?? ''));
    const expected = Buffer.from(`Bearer ${token}`);
    if (req.method !== 'POST' || req.url !== '/' || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return send(403, { error: 'Forbidden' });
    let size = 0; const chunks = [];
    try {
      for await (const chunk of req) { size += chunk.length; if (size > 1_000_000) return send(413, { error: 'Tool input too large' }); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (body?.op === 'list') return send(200, list);
      const spec = byName.get(body?.name);
      const input = body?.arguments ?? {};
      if (body?.op !== 'call' || !spec || !input || typeof input !== 'object' || Array.isArray(input)) return send(400, { error: 'Invalid crew tool' });
      controller.signal.throwIfAborted();
      const text = String(await spec.run(input) ?? '');
      called.push({ name: body.name, input }); // 턴 뒤 지시 블록이 **같은 대상·내용**을 두 번 하지 않게(cli-directives SAME_AS_TOOL)
      send(200, { content: [{ type: 'text', text }] });
    } catch (e) {
      // run은 입력 검증 실패·처리기 isError를 던진다 — 모델이 고쳐 다시 부를 수 있게 문구를 그대로 돌려준다(네이티브 엔진과 같은 동작)
      send(200, { isError: true, content: [{ type: 'text', text: controller.signal.aborted ? 'Crew task closed' : String(e?.message || 'Crew tool failed').slice(0, 2000) }] });
    }
  });
  server.requestTimeout = 0; // 동기 위임은 동료 턴 끝까지 걸린다 — 상한은 자식(30분)이 쥔다
  await new Promise((resolveP, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveP); });
  server.unref();
  let closing;
  return {
    server: { command: process.execPath, args: [worker], env: { ARGO_CREW_RELAY_URL: `http://127.0.0.1:${server.address().port}/`, ARGO_CREW_RELAY_TOKEN: token }, toolTimeoutSec: 1800 },
    called,
    close: () => closing ??= (async () => {
      controller.abort();
      server.closeAllConnections(); await new Promise((r) => server.close(r));
    })(),
  };
}
