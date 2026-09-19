// Esc·바깥 누름 묶음(D18) 행동 테스트 — 내 계정·레일 정렬 메뉴(K6·S63), 두 메뉴 겹침, Esc 뒤 초점 복귀(K7), / 목록 Esc(S95), 검색 결과 Esc(S101).
// 서버: node node_modules/vite/bin/vite.js --config test/msgr-ui-feedback.config.mjs --port 5211 --strictPort
// 실행: PLAYWRIGHT_MODULE=/절대경로/playwright/index.mjs node test/esc.browser.mjs
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const PORT = process.env.UF_TEST_PORT || 5211;
const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const out = {}; const fails = [];
const check = (name, ok, detail) => { out[name] = ok ? true : detail ?? false; if (!ok) fails.push(name); };
const page = await ctx.newPage();
page.setDefaultTimeout(8000);
await page.route('**/*', (rt) => new URL(rt.request().url()).hostname === '127.0.0.1' ? rt.continue() : rt.abort());
await page.addInitScript(() => localStorage.setItem('argo-lang', 'ko'));
await page.goto(`http://127.0.0.1:${PORT}/test/instant-delivery.fixture.html`);
await page.locator('.msgr-sortbtn').waitFor();
await page.locator('.msgr-spine').getByText('먼저 있던 글').first().waitFor();
const has = (s) => page.evaluate((s) => !!document.querySelector(s), s);
const menus = [['me', 'button.me:not(.item)', '.msgr-rowmenu.me'], ['sort', '.msgr-sortbtn', '.msgr-sortwrap .msgr-rowmenu']];

for (const [name, btn, menu] of menus) {
  await page.locator(btn).click();
  check(`${name}.opens`, await has(menu));
  await page.keyboard.press('Escape');
  check(`${name}.escCloses`, !(await has(menu)));
  check(`${name}.focusBack`, await page.evaluate((b) => document.activeElement === document.querySelector(b), btn));
  if (await has(menu)) await page.locator(btn).click();
  await page.locator(btn).click();
  await page.mouse.click(900, 420); // 스레드 빈 곳
  check(`${name}.outsideCloses`, !(await has(menu)));
  if (await has(menu)) await page.locator(btn).click();
}
// 두 메뉴 겹침: 정렬을 연 채 내 계정을 누르면 정렬은 닫힌다
await page.locator('.msgr-sortbtn').click();
await page.locator('button.me:not(.item)').click();
check('menus.noOverlap', !(await has('.msgr-sortwrap .msgr-rowmenu')) && await has('.msgr-rowmenu.me'));
await page.keyboard.press('Escape');
if (await has('.msgr-rowmenu.me')) await page.locator('button.me:not(.item)').click();
if (await has('.msgr-sortwrap .msgr-rowmenu')) await page.locator('.msgr-sortbtn').click();

// / 목록: Esc로 닫히고 쓴 글은 그대로, 다시 쓰면 다시 뜬다
const composer = page.locator('.msgr-composer textarea');
await composer.click(); await page.keyboard.type('/');
const slashOpen = () => page.evaluate(() => !!document.querySelector('.msgr-slashpop'));
check('slash.opens', await slashOpen());
await page.keyboard.press('ArrowDown'); await page.keyboard.press('Escape');
check('slash.escCloses', !(await slashOpen()) && (await composer.inputValue()) === '/', { open: await slashOpen(), text: await composer.inputValue() });
await page.keyboard.press('Backspace'); await page.keyboard.type('/');
check('slash.reopens', await slashOpen());
await page.keyboard.press('Escape'); await composer.fill('');

// 검색: 결과 화면에서 Esc면 대화로(칸 안·칸 밖 모두)
const title = () => page.evaluate(() => document.querySelector('.msgr-top .title')?.textContent ?? '');
for (const where of ['input', 'outside']) {
  await page.locator('.msgr-search input').fill('먼저'); await page.keyboard.press('Enter');
  await page.waitForFunction(() => /검색/.test(document.querySelector('.msgr-top .title')?.textContent ?? ''));
  if (where === 'outside') await page.evaluate(() => document.activeElement?.blur());
  else await page.locator('.msgr-search input').focus();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  check(`search.esc.${where}`, !/검색/.test(await title()) && (await page.locator('.msgr-search input').inputValue()) === '', await title());
}

await browser.close();
console.log(JSON.stringify(out));
console.log(fails.length ? `FAIL ${fails.join(', ')}` : 'PASS');
process.exit(fails.length ? 1 : 0);
