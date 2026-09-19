// 메시지 행 키보드 잠금(검수 K8, #616) — 로빙 tabindex로 목록 전체가 Tab 한 칸, 키보드만으로 동작 메뉴를 열어 복사한다.
// (1) 상단 바 마지막 탭 정지에서 Tab 3번 이내로 입력창에 닿는다(중간에 멈추는 곳은 현재 행 하나)
// (2) 행에서 Enter → 동작 메뉴(role=menu)가 열리고 초점이 메뉴 안으로 → [복사] Enter → 클립보드에 본문 → Esc면 행으로 돌아온다. Shift+F10도 연다
// 서버: node node_modules/vite/bin/vite.js --config test/msgr-ui-feedback.config.mjs --port 5211 --strictPort
// 실행: PLAYWRIGHT_MODULE=/절대경로/playwright/index.mjs node test/row-keyboard.browser.mjs
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const PORT = process.env.UF_TEST_PORT || 5211;
const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: `http://127.0.0.1:${PORT}` });
const out = {}; const fails = [];
const check = (name, ok, detail) => { out[name] = ok ? true : detail ?? false; if (!ok) fails.push(name); };

const page = await ctx.newPage();
page.setDefaultTimeout(8000);
await page.route('**/*', (rt) => new URL(rt.request().url()).hostname === '127.0.0.1' ? rt.continue() : rt.abort());
await page.addInitScript(() => localStorage.setItem('argo-lang', 'ko'));
await page.goto(`http://127.0.0.1:${PORT}/test/instant-delivery.fixture.html`);
await page.locator('.msgr-spine').getByText('먼저 있던 글').first().waitFor();
const where = () => page.evaluate(() => { const a = document.activeElement; return { composer: !!a?.closest?.('.msgr-composer') && a.tagName === 'TEXTAREA', row: a?.dataset?.mid ?? null, menu: !!a?.closest?.('.msgr-acts.ctx'), text: a?.textContent?.trim() ?? '' }; });

// (1) 상단 바 마지막 탭 정지 → 입력창
await page.evaluate(() => { const top = document.querySelector('.msgr-top'); const f = [...top.querySelectorAll('a[href], button:not(:disabled), input, [tabindex="0"]')].filter((x) => x.getClientRects().length); f.at(-1).focus(); });
const stops = [];
for (let i = 0; i < 3; i++) { await page.keyboard.press('Tab'); const w = await where(); stops.push(w); if (w.composer) break; }
check('tab.reachesComposer', stops.at(-1)?.composer === true && stops.length <= 3, stops);
check('tab.stopsOnRow', stops.some((w) => w.row), stops);

// (2) 키보드만으로 동작 메뉴 → 복사 → Esc → Shift+F10
await page.keyboard.press('Shift+Tab'); // 입력창 → 현재 행
const row = await where();
check('row.focused', !!row.row, row);
await page.keyboard.press('Enter');
const opened = await page.waitForSelector('.msgr-acts.ctx[role="menu"]', { timeout: 3000 }).then(() => true, () => false);
let w = await where();
check('menu.opensByEnter', opened);
check('menu.focusInside', w.menu, w);
if (opened) {
for (let i = 0; i < 6 && !w.text.includes('복사'); i++) { await page.keyboard.press('ArrowDown'); w = await where(); }
check('menu.arrowToCopy', w.text.includes('복사'), w);
await page.keyboard.press('Enter');
const clip = await page.evaluate(() => navigator.clipboard.readText());
check('menu.copied', clip.includes('먼저 있던 글'), clip);
await page.keyboard.press('Escape');
await page.waitForFunction(() => !document.querySelector('.msgr-acts.ctx'));
w = await where();
check('esc.backToRow', w.row === row.row, w);
await page.keyboard.press('Shift+F10');
check('shiftF10.opens', await page.waitForSelector('.msgr-acts.ctx[role="menu"]', { timeout: 3000 }).then(() => true, () => false));
}

await browser.close();
console.log(JSON.stringify(out));
console.log(fails.length ? `FAIL ${fails.join(', ')}` : 'PASS');
process.exit(fails.length ? 1 : 0);
