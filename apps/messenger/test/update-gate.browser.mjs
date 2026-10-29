// 업데이트 필요 전체 화면 행동 시험 — 서버 최소 버전에 걸리면 셸을 내리고 안내만 보이며, 그 뒤 가짜 서버로 가는 요청이 0이다(유건 2026-10-27 "막힌 앱에서 업데이트 하라는 안내만 보이게해").
// 서버: (apps/messenger에서) node node_modules/vite/bin/vite.js --config test/v2-shell.config.mjs   (기본 :5291, V2_SHELL_TEST_PORT로 바꿈)
// 실행: PLAYWRIGHT_MODULE=/절대경로/playwright-core/index.mjs PLAYWRIGHT_EXECUTABLE=/절대경로/chrome-headless-shell node test/update-gate.browser.mjs
// 기다림 WAIT_MS(기본 20초) = 셸의 가장 긴 주기(작업 패널 15초)보다 길게 — 대조군(막히지 않은 셸)은 같은 시간에 요청이 늘어야 시험이 의미가 있다.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const PORT = process.env.V2_SHELL_TEST_PORT || 5291;
const WAIT_MS = Number(process.env.WAIT_MS || 20_000);
const base = `http://127.0.0.1:${PORT}/test/v2-shell.fixture.html?lang=ko&still=1`;
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE } : { channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' }) });
const out = {}; const fails = [];
const check = (name, ok, detail) => { out[name] = ok ? true : detail ?? false; if (!ok) fails.push(name); };
const calls = (page) => page.evaluate(() => window.__v2Fixture.calls.length);
const topics = (page) => page.evaluate(() => [...window.__v2Fixture.topics.keys()]);
// 셸이 반응하는 사건 — 창 초점·화면 보임·온라인(앞으로 올 때 따라잡기, 따라잡기·심박). 막히지 않은 셸은 이 사건마다 조회를 낸다
const nudge = (page) => page.evaluate(() => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('online')); });
const rpcNames = (page, from = 0) => page.evaluate((n) => window.__v2Fixture.calls.slice(n).map((c) => c.rpc ?? c.table ?? c.storage), from);

const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
page.setDefaultTimeout(10_000);
await page.route('**/*', (rt) => (new URL(rt.request().url()).hostname === '127.0.0.1' ? rt.continue() : rt.abort()));

// 대조군 — 최소 버전 없음: 셸이 뜨고, 같은 시간 동안 요청이 늘어난다(측정이 살아 있음)
await page.goto(base);
await page.locator('button.msgr-org').waitFor();
await page.waitForTimeout(1500);
const c0 = await calls(page);
check('control.realtime', (await topics(page)).length > 0, '막히지 않은 셸은 실시간 토픽에 가입한다');
await nudge(page); await page.waitForTimeout(WAIT_MS); await nudge(page); await page.waitForTimeout(1500);
const c1 = await calls(page);
check('control.shellRequests', c1 > c0, { before: c0, after: c1 });
check('control.noGate', (await page.locator('[data-update-gate]').count()) === 0);

// 1) 최소 버전에 걸림 → 전체 화면 안내만, 셸 요소 없음, 실시간 토픽 0, 그 뒤 요청 0
await page.goto(`${base}&min=9.9.9`);
await page.locator('[data-update-gate]').waitFor();
await page.waitForTimeout(1500); // 셸 내림(언마운트 정리)이 끝날 때까지
const g0 = await calls(page);
const t0 = await topics(page);
const text = await page.locator('[data-update-gate]').innerText();
check('gate.title', text.includes('업데이트가 필요합니다'), text);
check('gate.minShown', text.includes('9.9.9'), text);
check('gate.button', (await page.getByRole('button', { name: '업데이트' }).count()) === 1);
check('gate.noShell', (await page.locator('button.msgr-org, .msgr-rail, .msgr-composer, textarea').count()) === 0);
check('gate.noTopBar', (await page.locator('.msgr-updbar, .msgr-offline-bar').count()) === 0, '같은 안내를 두 번 띄우지 않는다');
check('gate.noRealtime', t0.length === 0, t0);
await nudge(page); await page.waitForTimeout(WAIT_MS); await nudge(page); await page.waitForTimeout(1500);
const g1 = await calls(page);
check('gate.zeroRequests', g1 === g0, { before: g0, after: g1, extra: await rpcNames(page, g0) });
check('gate.stillNoRealtime', (await topics(page)).length === 0);
check('gate.marker', await page.evaluate(() => !!localStorage.getItem('argo-msgr-update-gate')));

// 2) 다시 켬(표지 있음) → 셸을 올리지 않고 바로 안내. 요청은 최소 버전 확인 1회뿐
await page.reload();
await page.locator('[data-update-gate]').waitFor();
await nudge(page); await page.waitForTimeout(WAIT_MS); await nudge(page); await page.waitForTimeout(1500);
const r = await rpcNames(page);
check('relaunch.onlyMinCheck', r.length === 1 && r[0] === 'argo_min_app_version', r);
check('relaunch.noRealtime', (await topics(page)).length === 0);

// 3) 서버가 최소 버전을 내림(min 없음) → 표지를 지우고 셸로 돌아간다
await page.goto(base);
await page.locator('button.msgr-org').waitFor();
check('cleared.shellBack', (await page.locator('[data-update-gate]').count()) === 0);
check('cleared.marker', await page.evaluate(() => !localStorage.getItem('argo-msgr-update-gate')));

// 4) 영어
await page.evaluate(() => localStorage.setItem('argo-lang', 'en'));
await page.goto(`${base.replace('lang=ko', 'lang=en')}&min=9.9.9`);
await page.locator('[data-update-gate]').waitFor();
check('en.title', (await page.locator('[data-update-gate]').innerText()).includes('Update required'));

await browser.close();
console.log(JSON.stringify(out, null, 1));
if (fails.length) { console.error(`FAIL ${fails.join(', ')}`); process.exit(1); }
console.log('PASS update-gate');
