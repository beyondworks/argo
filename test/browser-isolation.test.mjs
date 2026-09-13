import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { BrowserSession, browserRunners, closeAllBrowsers, findChrome, createBrowserStatusReader } from '../src/engine/browser-tools.mjs';
import { createBrowserMcpBridge } from '../src/engine/browser-mcp.mjs';

test('company and agent scopes cannot alias or escape the profile root', () => {
  const env = { ARGO_ROOT: join(tmpdir(), 'scope-test', 'workspaces') };
  const path = (ws, slug) => BrowserSession.profileDir(ws, env, slug);
  assert.notEqual(path('a', 'crew'), path('b', 'crew'));
  assert.notEqual(path('a', 'crew'), path('a', 'other'));
  assert.notEqual(path('a/b', 'c'), path('a', 'b/c'));
  assert.match(path('../outside', '../../other'), /agents[/\\][a-f0-9]{64}$/);
  assert.ok(!path('a', 'crew').startsWith(env.ARGO_ROOT));
});

test('real Chromium: agent cookies/storage isolated; concurrent work tabs independent; credentials persist', { skip: !findChrome() && 'No Chromium installed' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'argo-browser-isolation-'));
  const env = { ...process.env, ARGO_ROOT: join(root, 'workspaces'), ARGO_BROWSER_HEADLESS: '1' };
  const http = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<title>${req.url}</title><input id="name"><div>${req.url}</div>`); });
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${http.address().port}`;
  const make = (wsId, slug, runId) => browserRunners({ wsId, slug, runId, env, headless: true });
  const a = make('company', 'shuri', 'work1'); const b = make('company', 'carmack', 'work1'); const a2 = make('company', 'shuri', 'work2'); const other = make('other', 'shuri', 'work1');
  const evalJs = (r, js) => r.browser_eval({ js });
  try {
    await Promise.all([a.browser_navigate({ url: origin + '/a' }), b.browser_navigate({ url: origin + '/b' }), a2.browser_navigate({ url: origin + '/a2' }), other.browser_navigate({ url: origin + '/other' })]);
    await evalJs(a, 'document.cookie="account=shuri; path=/; max-age=3600"; localStorage.setItem("account","shuri"); "ok"');
    assert.equal(await evalJs(b, 'document.cookie'), '');
    assert.equal(await evalJs(b, 'localStorage.getItem("account")'), 'null');
    assert.equal(await evalJs(other, 'document.cookie'), '');
    assert.equal(await evalJs(other, 'localStorage.getItem("account")'), 'null');
    assert.equal(await evalJs(a2, 'document.cookie'), 'account=shuri', 'same agent intentionally retains account across work tabs');
    await Promise.all([a.browser_type({ ref: '#name', text: 'A' }), b.browser_type({ ref: '#name', text: 'B' }), a2.browser_type({ ref: '#name', text: 'A2' })]);
    assert.equal(await evalJs(a, 'document.title + ":" + document.querySelector("input").value'), '/a:A');
    assert.equal(await evalJs(a2, 'document.title + ":" + document.querySelector("input").value'), '/a2:A2');
    assert.equal(await evalJs(b, 'document.title + ":" + document.querySelector("input").value'), '/b:B');
    await a.close();
    await assert.rejects(evalJs(a, 'document.title'), /closed/);
    assert.equal(await evalJs(a2, 'document.title'), '/a2', 'closing work1 does not close work2');
    const ac = new AbortController(); ac.abort();
    await assert.rejects(a2.browser_eval({ js: 'document.title="changed"' }, { signal: ac.signal }));
    assert.equal(await evalJs(a2, 'document.title'), '/a2');
    const a3 = make('company', 'shuri', 'work3'); await a3.browser_navigate({ url: origin + '/a3' });
    const runningAbort = new AbortController();
    const slow = a2.browser_eval({ js: 'new Promise(r => setTimeout(() => r("late"), 60000))' }, { signal: runningAbort.signal });
    const abortTimer = setTimeout(() => runningAbort.abort(), 100);
    await assert.rejects(slow); clearTimeout(abortTimer);
    assert.equal(await evalJs(b, 'document.title'), '/b', 'mid-command cancellation preserves other agent');
    assert.equal(await evalJs(a3, 'document.title'), '/a3', 'mid-command cancellation preserves another run of the same agent');
    await Promise.all([a2.close(), a3.close(), b.close(), other.close()]); await closeAllBrowsers();
    const resumed = make('company', 'shuri', 'new-work');
    try { await resumed.browser_navigate({ url: origin }); assert.equal(await evalJs(resumed, 'localStorage.getItem("account")'), 'shuri'); assert.equal(await evalJs(resumed, 'document.cookie'), 'account=shuri'); }
    finally { await resumed.close(); }
  } finally { await closeAllBrowsers(); await new Promise((resolve) => http.close(resolve)); await rm(root, { recursive: true, force: true }); }
});

test('stdio relay cannot change scope, requires secret and gate, and closes its capability', async () => {
  const root = await mkdtemp(join(tmpdir(), 'argo-browser-relay-'));
  let calls = 0;
  const bridge = await createBrowserMcpBridge({ wsId: 'test', slug: 'crew', env: { ...process.env, ARGO_ROOT: join(root, 'workspaces') }, canUseTool: async (name, input) => { calls++; assert.equal(name, 'browser_navigate'); assert.equal(input.url, 'http://127.0.0.1/'); return { behavior: 'deny', message: 'Test approval required' }; } });
  const client = new Client({ name: 'browser-scope-test', version: '1' });
  const transport = new StdioClientTransport({ command: bridge.server.command, args: bridge.server.args, env: { ...process.env, ...bridge.server.env }, stderr: 'pipe' });
  try {
    assert.ok(!bridge.server.args.some((a) => a.includes(bridge.server.env.ARGO_BROWSER_RELAY_TOKEN)));
    const denied = await fetch(bridge.server.env.ARGO_BROWSER_RELAY_URL, { method: 'POST', body: '{}' }); assert.equal(denied.status, 403);
    await client.connect(transport);
    const tools = await client.listTools(); assert.equal(tools.tools.length, 11);
    assert.ok(tools.tools.every((t) => !('wsId' in t.inputSchema.properties) && !('slug' in t.inputSchema.properties)));
    const result = await client.callTool({ name: 'browser_navigate', arguments: { url: 'http://127.0.0.1/' } });
    assert.equal(result.isError, true); assert.equal(result.content[0].text, 'Test approval required'); assert.equal(calls, 1);
    await bridge.close();
    await assert.rejects(fetch(bridge.server.env.ARGO_BROWSER_RELAY_URL));
  } finally { await client.close(); await transport.close(); await bridge.close(); await rm(root, { recursive: true, force: true }); }
});

test('browser status opens no browser/profile and probes Ego only on explicit preference with bounded cache', async () => {
  const root = await mkdtemp(join(tmpdir(), 'argo-browser-status-'));
  let probes = 0; let clock = 0;
  const statusReader = createBrowserStatusReader({ now: () => clock, ttlMs: 100, probe: async ({ env, timeoutMs }) => {
    probes++; assert.equal(timeoutMs, 5000); assert.equal(env.ANTHROPIC_API_KEY, undefined);
    return { available: false, reason: 'ego_unavailable' };
  } });
  const env = { ARGO_ROOT: join(root, 'workspaces'), ANTHROPIC_API_KEY: 'test-only' };
  const regular = browserRunners({ wsId: 'test', slug: 'crew', env, statusReader });
  const ego = browserRunners({ wsId: 'test', slug: 'crew', env: { ...env, ARGO_BROWSER_PROVIDER: 'ego' }, statusReader });
  try {
    const status = JSON.parse(await regular.browser_status());
    assert.equal(probes, 0); assert.equal(status.provider, 'chromium'); assert.equal(status.connected, false);
    assert.equal(status.agentProfileIsolated, true); assert.equal(status.workTabIsolated, true);
    assert.equal(typeof status.supportedBrowserAvailable, 'boolean'); assert.equal(status.fallbackReason, null);
    assert.match(status.accountConnection, /only needed accounts/);
    const replies = await Promise.all([ego.browser_status(), ego.browser_status()]);
    assert.equal(probes, 1); assert.ok(replies.every((r) => JSON.parse(r).fallbackReason === 'ego_unavailable'));
    clock = 101; await ego.browser_status(); assert.equal(probes, 2);
    assert.deepEqual(await readdir(root), [], 'status does not create a browser/profile directory');
    assert.ok(!replies.join('').includes(root)); assert.ok(!replies.join('').includes('test-only'));
  } finally { await regular.close(); await ego.close(); await rm(root, { recursive: true, force: true }); }
});

test('two stdio children use one agent profile without profile lock contention or tab collision', { skip: !findChrome() && 'No Chromium installed' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'argo-browser-two-clients-'));
  const env = { ...process.env, ARGO_ROOT: join(root, 'workspaces'), ARGO_BROWSER_HEADLESS: '1' };
  const http = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<title>${req.url}</title>`); });
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${http.address().port}`;
  const clients = []; const bridges = [];
  try {
    for (const runId of ['one', 'two']) {
      const bridge = await createBrowserMcpBridge({ wsId: 'company', slug: 'same-agent', runId, env, canUseTool: async (_, input) => ({ behavior: 'allow', updatedInput: input }) });
      bridges.push(bridge);
      const client = new Client({ name: `browser-${runId}`, version: '1' }); clients.push(client);
      await client.connect(new StdioClientTransport({ command: bridge.server.command, args: bridge.server.args, env: { ...process.env, ...bridge.server.env }, stderr: 'ignore' }));
    }
    const call = (index, name, input) => clients[index].callTool({ name, arguments: input });
    const nav = await Promise.all([call(0, 'browser_navigate', { url: origin + '/one' }), call(1, 'browser_navigate', { url: origin + '/two' })]);
    assert.ok(nav.every((r) => !r.isError), 'both child processes can navigate');
    await call(0, 'browser_eval', { js: 'document.cookie="account=shared-agent; path=/"; "ok"' });
    assert.equal((await call(1, 'browser_eval', { js: 'document.cookie' })).content[0].text, 'account=shared-agent');
    assert.equal((await call(0, 'browser_eval', { js: 'document.title' })).content[0].text, '/one');
    assert.equal((await call(1, 'browser_eval', { js: 'document.title' })).content[0].text, '/two');
    await bridges[0].close();
    assert.equal((await call(1, 'browser_eval', { js: 'document.title' })).content[0].text, '/two');
  } finally {
    for (const client of clients) await client.close(); for (const bridge of bridges) await bridge.close();
    await closeAllBrowsers(); await new Promise((resolve) => http.close(resolve)); await rm(root, { recursive: true, force: true });
  }
});

test('login handoff retains only its owned tab through turn cleanup and shares completed login with a new run', { skip: !findChrome() && 'No Chromium installed' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'argo-browser-login-'));
  const env = { ...process.env, ARGO_ROOT: join(root, 'workspaces'), ARGO_BROWSER_HEADLESS: '1' };
  const http = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>Test account sign-in</title><button onclick="document.cookie=\'account=connected; path=/; max-age=3600\';localStorage.setItem(\'account\',\'connected\')">Connect test account</button>'); });
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${http.address().port}/`;
  const a = browserRunners({ wsId: 'company', slug: 'shuri', runId: 'login', env });
  const other = browserRunners({ wsId: 'company', slug: 'carmack', env });
  const next = browserRunners({ wsId: 'company', slug: 'shuri', runId: 'next', env });
  try {
    await assert.rejects(a.browser_request_login(), (e) => e.code === 'BROWSER_LOGIN_PAGE_REQUIRED');
    await Promise.all([a.browser_navigate({ url }), other.browser_navigate({ url })]);
    await assert.rejects(a.browser_request_login(), (e) => e.code === 'BROWSER_LOGIN_HEADLESS');
    const owner = BrowserSession.peek('company', { slug: 'shuri', env });
    // Exercise real CDP ownership/lifecycle without opening a GUI during automated tests.
    // Only the visibility capability is simulated; this is not proof of human GUI sign-in.
    owner.headless = false;
    const loginPage = owner.pages.get('login'); const targetId = loginPage.targetId;
    assert.match(await a.browser_request_login(), /remain open after this turn/);
    await assert.rejects(a.browser_eval({ js: 'document.title="wrong"' }), (e) => e.code === 'BROWSER_LOGIN_PAUSED');
    assert.equal(JSON.parse(await a.browser_status()).automationPausedForLogin, true);
    await a.close();
    assert.ok((await owner.cdp.send('Target.getTargets')).targetInfos.some((t) => t.targetId === targetId), 'routine turn cleanup retains sign-in target');
    owner.idleMs = 5; owner.touch(); await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(owner.alive, true, 'idle cleanup must not kill human login tab');
    assert.equal(JSON.parse(await next.browser_status()).humanLoginPending, true, 'future run reports the pending tab without opening one');
    assert.equal(owner.pages.size, 0);
    await next.browser_navigate({ url });
    assert.notEqual(owner.pages.get('next').targetId, targetId);
    await assert.rejects(next.browser_request_login(), (e) => e.code === 'BROWSER_LOGIN_PENDING');
    assert.equal(await other.browser_eval({ js: 'document.cookie' }), '');
    // The test fixture plays the human only here, through the retained page handle.
    await loginPage.evaluate('document.querySelector("button").click()');
    assert.equal(await next.browser_eval({ js: 'document.cookie' }), 'account=connected');
    assert.equal(await next.browser_eval({ js: 'localStorage.getItem("account")' }), 'connected');
    assert.equal(await other.browser_eval({ js: 'document.cookie' }), '', 'other agent does not inherit connected account');
    owner.idleMs = 60_000;
    const removed = new Promise((resolve) => { const off = owner.cdp.on('', 'Target.targetDestroyed', ({ targetId: closedId }) => { if (closedId === targetId) { off(); resolve(); } }); });
    await owner.cdp.send('Target.closeTarget', { targetId }); await removed;
    assert.equal(JSON.parse(await next.browser_status()).humanLoginPending, false, 'human closing the tab releases the keepalive pin');
  } finally { await Promise.all([a.close(), other.close(), next.close()]); await closeAllBrowsers(); await new Promise((resolve) => http.close(resolve)); await rm(root, { recursive: true, force: true }); }
});
