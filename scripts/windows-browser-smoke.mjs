#!/usr/bin/env node
// Run from an isolated copy; no SDK, cloud credentials, external site, or user profile.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir, release } from 'node:os';
import { join } from 'node:path';
import { BrowserSession, browserRunners, closeAllBrowsers, findChrome } from '../src/engine/browser-tools.mjs';

const scratch = await mkdtemp(join(tmpdir(), 'argo-browser-scope-qa-'));
const env = { ...process.env, ARGO_ROOT: join(scratch, 'workspaces'), ARGO_BROWSER_HEADLESS: '1', ARGO_BROWSER_PROVIDER: 'chromium' };
delete env.ARGO_CHROME_PATH;
const fixture = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(`<title>${req.url}</title><input id="name">`);
});
let assertions = 0;
const equal = (actual, expected, message) => { assert.equal(actual, expected, message); assertions++; };
const make = (slug, runId, wsId = 'qa-company') => browserRunners({ wsId, slug, runId, env, headless: true });
const read = (runner, js) => runner.browser_eval({ js });
const runners = [];
try {
  assert.ok(findChrome(env), 'Windows system browser discovery'); assertions++;
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${fixture.address().port}`;
  const a = make('shuri', 'one'), b = make('carmack', 'one'), a2 = make('shuri', 'two'), other = make('shuri', 'one', 'other-company');
  runners.push(a, b, a2, other);
  await Promise.all([a.browser_navigate({url:origin+'/a'}), b.browser_navigate({url:origin+'/b'}), a2.browser_navigate({url:origin+'/a2'}), other.browser_navigate({url:origin+'/other'})]);
  await read(a, 'document.cookie="account=shuri; path=/; max-age=3600"; localStorage.setItem("account","shuri"); "ok"');
  equal(await read(b, 'document.cookie'), '', 'other agent cookies isolated');
  equal(await read(b, 'localStorage.getItem("account")'), 'null', 'other agent storage isolated');
  equal(await read(other, 'document.cookie'), '', 'other company cookies isolated');
  equal(await read(other, 'localStorage.getItem("account")'), 'null', 'other company storage isolated');
  equal(await read(a2, 'document.cookie'), 'account=shuri', 'same agent account retained across tabs');
  await Promise.all([a.browser_type({ref:'#name',text:'A'}), a2.browser_type({ref:'#name',text:'A2'}), b.browser_type({ref:'#name',text:'B'})]);
  equal(await read(a, 'document.title+":"+document.querySelector("input").value'), '/a:A', 'first task input independent');
  equal(await read(a2, 'document.title+":"+document.querySelector("input").value'), '/a2:A2', 'second task input independent');
  equal(await read(b, 'document.title+":"+document.querySelector("input").value'), '/b:B', 'other agent input independent');
  await a.close();
  await assert.rejects(read(a, 'document.title'), /closed/); assertions++;
  equal(await read(a2, 'document.title'), '/a2', 'closing first task preserves second');
  await assert.rejects(a2.browser_request_login({}), { code: 'BROWSER_LOGIN_HEADLESS' }); assertions++;
  equal(await read(a2, 'document.title'), '/a2', 'rejected headless login does not stop task');
  const session = await BrowserSession.get('qa-company', { env, slug:'shuri', headless:true });
  const browser = (await session.cdp.send('Browser.getVersion')).product;
  await Promise.all(runners.map(runner=>runner.close()));
  await closeAllBrowsers();
  const resumed = make('shuri', 'resumed'); runners.push(resumed);
  await resumed.browser_navigate({url:origin+'/resumed'});
  equal(await read(resumed, 'document.cookie'), 'account=shuri', 'agent cookie persists after restart');
  equal(await read(resumed, 'localStorage.getItem("account")'), 'shuri', 'agent storage persists after restart');
  console.log(JSON.stringify({ok:true,platform:process.platform,os:release(),node:process.version,browser,assertions,scope:'headless local HTTP fixture; no installed app or visible login verification'}));
} finally {
  await Promise.allSettled(runners.map(runner=>runner.close()));
  await closeAllBrowsers();
  await new Promise(resolve=>fixture.close(resolve));
  await rm(scratch,{recursive:true,force:true,maxRetries:10,retryDelay:200});
}
