#!/usr/bin/env node
// Interactive QA: only a newly created local fixture profile, never a user's accounts.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { BrowserSession, browserRunners, closeAllBrowsers } from '../src/engine/browser-tools.mjs';

const scratch = await mkdtemp(join(tmpdir(), 'argo-headed-login-profile-'));
const output = process.env.ARGO_HEADED_QA_OUTPUT || join(tmpdir(), 'argo-headed-login-qa-evidence');
await mkdir(output, { recursive: true });
const env = { ...process.env, ARGO_ROOT: join(scratch, 'workspaces'), ARGO_BROWSER_HEADLESS: '0', ARGO_BROWSER_PROVIDER: 'chromium' };
const fixture = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(`<!doctype html><title>Argo Login Handoff QA</title><style>body{font:20px system-ui;margin:70px;max-width:740px;background:#f5f6f8;color:#171a22}button{font:inherit;padding:18px;border-radius:12px;border:1px solid #6977b5;background:#273566;color:white}section{background:white;border-radius:20px;padding:36px}small{display:block;margin-top:30px;color:#555}</style><section><h1>Argo Login Handoff QA</h1><p>This is a local test account. No personal account or external service is used.</p><button onclick="document.cookie='account=fixture-connected; path=/; max-age=3600';localStorage.setItem('account','fixture-connected');document.getElementById('result').textContent='Test account connected';this.disabled=true">Connect test account</button><h2 id="result">Waiting for test sign-in</h2><small>After connecting, the next agent run should see this test account in its own separate tab.</small></section>`);
});
await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${fixture.address().port}`;
const login = browserRunners({ wsId: 'headed-qa-company', slug: 'qa-agent', runId: 'login', env, headless: false });
const next = browserRunners({ wsId: 'headed-qa-company', slug: 'qa-agent', runId: 'next', env, headless: false });
const input = createInterface({ input: process.stdin, output: process.stdout });
const lines = [];
input.on('line', (line) => { lines.push(line.trim()); });
const waitFor = async (value) => {
  const started = Date.now();
  while (!lines.includes(value)) { if (Date.now() - started > 5 * 60_000) throw new Error('QA operator timed out'); await new Promise((resolve) => setTimeout(resolve, 200)); }
};
let owner;
try {
  await login.browser_navigate({ url: origin + '/login' });
  owner = BrowserSession.peek('headed-qa-company', { slug: 'qa-agent', env });
  assert.equal(owner.headless, false);
  const loginTarget = owner.pages.get('login').targetId;
  const note = await login.browser_request_login();
  await login.close();
  assert.ok((await owner.cdp.send('Target.getTargets')).targetInfos.some((target) => target.targetId === loginTarget));
  console.log(JSON.stringify({ stage: 'waiting_for_native_click', origin, title: 'Argo Login Handoff QA', note, browserPid: owner.child.pid, output }));
  await waitFor('verify');
  await next.browser_navigate({ url: origin + '/next' });
  const nextTarget = owner.pages.get('next').targetId;
  assert.notEqual(nextTarget, loginTarget);
  assert.equal(await next.browser_eval({ js: 'document.cookie' }), 'account=fixture-connected');
  assert.equal(await next.browser_eval({ js: 'localStorage.getItem("account")' }), 'fixture-connected');
  assert.ok((await owner.cdp.send('Target.getTargets')).targetInfos.some((target) => target.targetId === loginTarget));
  const shot = await next.browser_screenshot(); await writeFile(join(output, 'next-run.jpg'), shot.image);
  const result = { ok: true, headless: owner.headless, browser: (await owner.cdp.send('Browser.getVersion')).product, assertions: ['headed browser', 'human tab retained after turn close', 'native UI test sign-in cookie visible in next run', 'localStorage visible in next run', 'new run has separate target', 'original human target remains open'], loginTarget, nextTarget };
  await writeFile(join(output, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ stage: 'verified_waiting_for_cleanup', ...result }));
  await waitFor('cleanup');
} finally {
  input.close();
  await Promise.allSettled([login.close(), next.close()]); await closeAllBrowsers();
  const cleanup = { browserExited: owner ? owner.child.exitCode !== null || owner.child.signalCode !== null : true };
  assert.equal(cleanup.browserExited, true);
  await new Promise((resolve) => fixture.close(resolve)); await rm(scratch, { recursive: true, force: true });
  await writeFile(join(output, 'cleanup.json'), JSON.stringify(cleanup, null, 2));
  console.log(JSON.stringify({ stage: 'cleaned', ...cleanup }));
}
