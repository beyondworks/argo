// 폰 DM 탭 정렬·고정 행동 검사(실제 App + 가짜 백엔드, work-panel 픽스처) — 유건 요청 2026-09-15.
// 실행: (1) node node_modules/vite/bin/vite.js --config test/work-panel.config.mjs  (2) PLAYWRIGHT_MODULE=<playwright index.mjs> node test/dm-sort.browser.mjs
// 검사는 "보이는가"까지 본다(검수 #541 CRITICAL-1: DOM엔 있는데 CSS로 숨어 있었다): 정렬 버튼 boundingBox 존재·클릭 가능, 메뉴 항목 3개 보임,
// 선택 → aria-checked·localStorage, 바깥 누름으로 닫힘, 즐겨찾기 뒤 DM 탭 잔류 + 별 표시, 데스크톱(1280)에서는 정렬 버튼 없음.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import assert from 'node:assert/strict';
const port = process.env.WORK_TEST_PORT || 5217;
const b = await chromium.launch({ headless: true, channel: process.env.WORK_CHANNEL || 'chrome' });
const p = await b.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
await p.route('**/*', (r) => (new URL(r.request().url()).hostname === '127.0.0.1' ? r.continue() : r.abort()));
await p.addInitScript(() => { localStorage.setItem('argo-lang', 'ko'); });
await p.goto(`http://127.0.0.1:${port}/test/work-panel.fixture.html`);
await p.locator('.msgr-shell.msgr-phone').waitFor();
const checks = [];
const ok = (name, cond, got) => { checks.push([name, !!cond]); assert.ok(cond, `${name}: ${JSON.stringify(got)}`); };
await p.evaluate(() => { [...document.querySelectorAll('.msgr-tabbar [role=tab]')].find((x) => /DM/i.test(x.textContent))?.click(); }); await p.waitForTimeout(400);
const btn = p.locator('[data-sec="dms"] .msgr-sortbtn');
const box = await btn.boundingBox(); ok('정렬 버튼이 보인다(0×0 아님)', box && box.width >= 24 && box.height >= 24, box);
await btn.click(); await p.waitForTimeout(300);
const items = p.locator('[data-sec="dms"] .msgr-rowmenu [role=menuitemradio]');
ok('메뉴 항목 3개', (await items.count()) === 3, await items.count());
const menuBox = await p.locator('[data-sec="dms"] .msgr-rowmenu').boundingBox(); ok('메뉴가 화면 안(390px)에서 잘리지 않는다', menuBox && menuBox.x >= 0 && menuBox.x + menuBox.width <= 390, menuBox);
ok('기본 = 최근 메시지순', (await items.nth(0).getAttribute('aria-checked')) === 'true' && /최근/.test(await items.nth(0).innerText()), await items.nth(0).innerText());
await items.nth(2).click(); await p.waitForTimeout(300);
ok('이름순 선택 → 저장', (await p.evaluate(() => localStorage.getItem('argo-msgr-dm-sort'))) === 'name', await p.evaluate(() => localStorage.getItem('argo-msgr-dm-sort')));
ok('선택 뒤 메뉴 닫힘', (await p.locator('[data-sec="dms"] .msgr-rowmenu').count()) === 0);
await btn.click(); await p.waitForTimeout(200); ok('다시 열면 이름순에 체크', (await items.nth(2).getAttribute('aria-checked')) === 'true');
await p.touchscreen.tap(200, 600); await p.waitForTimeout(300); ok('바깥을 누르면 닫힌다(터치)', (await p.locator('[data-sec="dms"] .msgr-rowmenu').count()) === 0);
// 즐겨찾기 → DM 탭 잔류 + 별
const dmItem = p.locator('[data-sec="dms"] .item').first(); const name = (await dmItem.locator('.name').innerText()).trim();
await dmItem.dispatchEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 300 }); await p.waitForTimeout(300);
await p.locator('button', { hasText: '즐겨찾기에 추가' }).first().click(); await p.waitForTimeout(500);
const after = p.locator('[data-sec="dms"] .item').first();
ok('즐겨찾기 뒤에도 DM 탭에 남는다', (await after.locator('.name').innerText()).trim() === name, await after.locator('.name').innerText());
const pinBox = await after.locator('.msgr-dmpin').boundingBox(); ok('고정 별이 보인다', pinBox && pinBox.width > 0, pinBox);
await p.evaluate(() => { [...document.querySelectorAll('.msgr-tabbar [role=tab]')][0].click(); }); await p.waitForTimeout(400);
ok('홈 즐겨찾기에도 있다', (await p.locator('[data-sec="fav"] .item .name', { hasText: name }).count()) === 1);
await p.setViewportSize({ width: 1280, height: 800 }); await p.waitForTimeout(600);
ok('데스크톱에는 정렬 버튼 없음', (await p.locator('[data-sec="dms"] .msgr-sortbtn').count()) === 0);
await b.close();
console.log(`${checks.length} dm sort/pin checks passed`);
