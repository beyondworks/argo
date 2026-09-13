// The host owns browser profiles; per-turn stdio children only forward scoped tool calls.
import { createServer } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { browserRunners, BROWSER_SPECS, BROWSER_LOGIN_ERRORS } from './browser-tools.mjs';

export function browserMcpWorkerPath({ cwd = process.cwd(), argv1 = process.argv[1] } = {}) {
  const rel = ['src', 'engine', 'browser-mcp-stdio.mjs'];
  const candidates = [resolve(cwd, ...rel), argv1 ? resolve(dirname(argv1), ...rel) : null,
    (() => { try { return fileURLToPath(new URL('./browser-mcp-stdio.mjs', import.meta.url)); } catch { return null; } })()];
  const file = candidates.find((p) => p && existsSync(p));
  if (!file) throw new Error('Browser worker is missing from this installation');
  return file;
}

export function browserMcpDirective(lang = 'ko') {
  return lang === 'en'
    ? '\nBrowser: use mcp__argo_browser__browser_status/request_login/navigate/snapshot/click/type/press/scroll/back/screenshot/eval. This agent has its own persistent login profile and this work run has a separate tab. For sign-in, navigate to the service then call browser_request_login to reserve the tab for the user and stop this run; continue with a new run after the user signs in on the execution device (mobile remote control unavailable). Connect only accounts needed for the task; never copy personal or another agent\'s browser profile. Ask for approval before external sends or purchases.\n'
    : '\n브라우저: mcp__argo_browser__browser_status/request_login/navigate/snapshot/click/type/press/scroll/back/screenshot/eval 도구를 사용한다. 크루별 로그인 프로필과 이번 작업의 탭이 분리된다. 로그인이 필요하면 서비스 페이지를 연 뒤 browser_request_login으로 탭을 사용자에게 넘기고 이번 실행을 멈춘다. 실행 기기에서 로그인한 뒤 새 실행으로 이어간다(모바일 원격 제어 미지원). 필요한 계정만 연결하고 개인·다른 크루의 브라우저 프로필을 복사하지 않는다. 외부 발송·구매는 실행 전에 결재를 올린다.\n';
}

const safeBrowserError = (e) => {
  if (Object.hasOwn(BROWSER_LOGIN_ERRORS, e?.code ?? '')) return BROWSER_LOGIN_ERRORS[e.code];
  const message = String(e?.message || '');
  if (/Chrome\/Chromium\/Edge\/Brave/.test(message)) return 'No supported browser found. Install Chrome, Chromium or Edge on the execution device.';
  if (/Singleton|ProcessSingleton|뜨자마자 종료/.test(message)) return 'The agent browser could not start. Another Argo instance may be using its profile; close that instance and retry.';
  if (/timeout|timed out|초 안에/.test(message)) return 'The browser did not respond in time. Reconnect it and retry.';
  return 'Browser action failed. Check the page or reconnect the browser and retry.';
};

export async function createBrowserMcpBridge({ wsId, slug, runId = randomUUID(), env = process.env, canUseTool, headless }) {
  if (![wsId, slug, runId].every((v) => typeof v === 'string' && v.length > 0 && v.length <= 200) || typeof canUseTool !== 'function') throw new Error('Browser scope and permission gate required');
  const worker = browserMcpWorkerPath();
  const token = randomBytes(32).toString('hex');
  const runners = browserRunners({ wsId, slug, runId, env, headless });
  const names = new Set(BROWSER_SPECS.map((s) => s.name));
  const controller = new AbortController();
  const server = createServer(async (req, res) => {
    const requestController = new AbortController();
    res.on('close', () => { if (!res.writableEnded) requestController.abort(); });
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
    const supplied = Buffer.from(String(req.headers.authorization ?? ''));
    const expected = Buffer.from(`Bearer ${token}`);
    if (req.method !== 'POST' || req.url !== '/' || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return send(403, { error: 'Forbidden' });
    let size = 0; const chunks = [];
    try {
      for await (const chunk of req) { size += chunk.length; if (size > 100_000) return send(413, { error: 'Tool input too large' }); chunks.push(chunk); }
      const { name, arguments: input = {} } = JSON.parse(Buffer.concat(chunks).toString());
      if (!names.has(name) || !input || typeof input !== 'object' || Array.isArray(input)) return send(400, { error: 'Invalid browser tool' });
      controller.signal.throwIfAborted();
      const gate = await canUseTool(name, input);
      if (gate?.behavior !== 'allow') return send(200, { isError: true, content: [{ type: 'text', text: gate?.message || 'Browser action denied' }] });
      const out = await runners[name](gate.updatedInput ?? input, { signal: AbortSignal.any([controller.signal, requestController.signal]) });
      send(200, { content: out?.image ? [{ type: 'image', data: out.image.toString('base64'), mimeType: out.mime }] : [{ type: 'text', text: String(out ?? '') }] });
    } catch (e) { send(200, { isError: true, content: [{ type: 'text', text: controller.signal.aborted ? 'Browser task closed' : safeBrowserError(e) }] }); }
  });
  server.requestTimeout = 120_000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  server.unref();
  let closing;
  return {
    server: { command: process.execPath, args: [worker], env: { ARGO_BROWSER_RELAY_URL: `http://127.0.0.1:${server.address().port}/`, ARGO_BROWSER_RELAY_TOKEN: token } },
    close: () => closing ??= (async () => {
      controller.abort();
      try { await runners.close(); } catch { /* Cleanup must not interrupt the parent turn's finally. */ }
      finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
    })(),
  };
}
