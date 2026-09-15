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
try {
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
// 최근 메시지순이 화면에 닿는가(검수 N1): 부팅 전에 픽스처 저장소에 "더 최근 글을 가진 두 번째 DM"을 심은 새 페이지에서 첫 줄인지 본다(RPC msgr_dm_latest 흉내 → lastAt → 정렬)
{
  const p2 = await b.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await p2.route('**/*', (r) => (new URL(r.request().url()).hostname === '127.0.0.1' ? r.continue() : r.abort()));
  await p2.addInitScript(() => { localStorage.setItem('argo-lang', 'ko'); localStorage.setItem('argo-msgr-dm-sort', 'recent');
    let v; Object.defineProperty(window, '__dmFixture', { configurable: true, get: () => v, set: (x) => { v = x; try { const t = x.tables; const uid = t.msgr_channel_members.find((m) => m.member_kind === 'user').member_id; const dm = t.msgr_channels.find((c) => c.kind === 'dm'); const base = t.msgr_messages.find((m) => m.channel_id === dm.id) ?? t.msgr_messages[0];
      t.msgr_channels.push({ ...dm, id: 'fixture-dm-2', name: 'dm:Fixture Second' }); t.msgr_channel_members.push({ channel_id: 'fixture-dm-2', member_kind: 'user', member_id: uid }, { channel_id: 'fixture-dm-2', member_kind: 'crew', member_id: 'crew-new' });
      t.msgr_messages.push({ ...base, id: 9999, channel_id: 'fixture-dm-2', body: '더 최근 글', created_at: new Date(Date.now() + 60_000).toISOString(), deleted_at: null }); } catch (e) { console.error('seed failed', e); } } }); });
  await p2.goto(`http://127.0.0.1:${port}/test/work-panel.fixture.html`); await p2.locator('.msgr-shell.msgr-phone').waitFor();
  await p2.evaluate(() => { [...document.querySelectorAll('.msgr-tabbar [role=tab]')].find((x) => /DM/i.test(x.textContent))?.click(); });
  await p2.waitForFunction(() => document.querySelectorAll('[data-sec="dms"] .item').length >= 2, null, { timeout: 8000 }).catch(() => {});
  await p2.waitForTimeout(600);
  const names = (await p2.locator('[data-sec="dms"] .item .name').allInnerTexts()).map((x) => x.trim());
  ok('더 최근 글을 가진 DM이 첫 줄(최근순이 RPC로 화면에 닿는다)', names.length >= 2 && /New/.test(names[0]) && /Existing/.test(names[1]), names);
  // 슬랙식 행(유건 2026-09-15): 마지막 글 한 줄 + 시각, 상단 필터 4개(전체·즐겨찾기·안읽음·그룹)가 목록 위
  const rows = await p2.evaluate(() => [...document.querySelectorAll('[data-sec="dms"] .item')].map((el) => ({ snip: el.querySelector('.snip')?.textContent ?? '', when: el.querySelector('.when')?.textContent ?? '' })));
  ok('행마다 마지막 글 한 줄과 시각', rows.length >= 2 && rows.every((r) => r.snip.length > 0 && /\d/.test(r.when)), rows);
  ok('내 글은 "나: " 접두', rows.some((r) => r.snip.startsWith('나: ')), rows);
  const filt = p2.locator('.msgr-dmfilter [role=radio]'); ok('필터 4개', (await filt.count()) === 4);
  ok('DM 탭 행에는 점 세 개 버튼이 없다(길게 누르기가 대신)', (await p2.locator('[data-sec="dms"] .msgr-railrow .more').count()) === 0);
  const fBox = await p2.locator('.msgr-dmfilter').boundingBox(); const lBox = await p2.locator('[data-sec="dms"]').boundingBox(); ok('필터가 목록 위에·화면 안', fBox && lBox && fBox.y < lBox.y && fBox.x + fBox.width <= 390, { fBox, lBox });
  await filt.nth(2).click(); await p2.waitForTimeout(200); ok('안읽음 필터: 안읽은 DM만(픽스처는 0 또는 unread 행)', await p2.evaluate(() => [...document.querySelectorAll('[data-sec="dms"] .item')].every((el) => el.classList.contains('unread'))));
  await filt.nth(0).click(); await p2.waitForTimeout(200);
  // 길게 누르기 → 메뉴(미리보기 포함), 손을 떼도 메뉴 유지 → 미리보기 시트에 글이 보인다
  { const row = p2.locator('[data-sec="dms"] .msgr-railrow').first(); const bx = await row.boundingBox(); const cdp = await p2.context().newCDPSession(p2);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: bx.x + 60, y: bx.y + 20 }] }); await p2.waitForTimeout(600);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await p2.waitForTimeout(300);
    const menu = await p2.locator('.msgr-ctxmenu [role=menuitem]').allInnerTexts(); ok('길게 누르면 메뉴(손 떼도 유지)·첫 항목 대화 미리보기', menu[0] === '대화 미리보기' && menu.includes('즐겨찾기에 추가'), menu);
    await p2.locator('.msgr-ctxmenu [role=menuitem]', { hasText: '대화 미리보기' }).click(); await p2.waitForTimeout(800);
    const peek = await p2.evaluate(() => ({ open: !!document.querySelector('.msgr-dmpeek'), n: document.querySelectorAll('.msgr-dmpeek .pk').length })); ok('미리보기 시트에 최근 글', peek.open && peek.n >= 1, peek);
    await p2.locator('.msgr-dmpeek .btn', { hasText: '열기' }).click(); await p2.waitForTimeout(500); ok('열기 → 대화 화면', await p2.evaluate(() => history.state?.page === 'chat'));
  }
  await p2.close();
}
// 정렬 메뉴 글자가 잘리지 않는다(iOS 실측 2026-09-15: 절대 배치 메뉴가 26px 래퍼 폭에 갇혀 130px) — 항목 글자 폭 ≤ 메뉴 폭
await btn.click(); await p.waitForTimeout(200);
{ const menuW = (await p.locator('[data-sec="dms"] .msgr-rowmenu').boundingBox()).width; const textW = await items.nth(1).evaluate((el) => el.scrollWidth); ok('메뉴 폭이 가장 긴 항목보다 넓다', menuW >= 160 && textW <= menuW, { menuW, textW }); }
await p.touchscreen.tap(200, 600); await p.waitForTimeout(200);
// 즐겨찾기 → DM 탭 잔류 + "고정" 단락으로 이동(별 아이콘 없음)
const dmItem = p.locator('[data-sec="dms"] .item').first(); const name = (await dmItem.locator('.name').innerText()).trim();
await dmItem.dispatchEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 300 }); await p.waitForTimeout(300);
await p.locator('button', { hasText: '즐겨찾기에 추가' }).first().click(); await p.waitForTimeout(500);
const pinnedSec = p.locator('[data-sec="dmpin"]'); const pinnedBox = await pinnedSec.boundingBox(); ok('고정 단락이 보인다', pinnedBox && pinnedBox.height > 0, pinnedBox);
ok('즐겨찾기한 DM은 고정 단락에', (await pinnedSec.locator('.item .name', { hasText: name }).count()) === 1);
ok('1:1 대화 단락에서는 빠진다', (await p.locator('[data-sec="dms"] .item .name', { hasText: name }).count()) === 0);
ok('별 아이콘 없음', (await p.locator('.msgr-dmpin').count()) === 0);
// 홈에서 1:1 대화를 접어도 DM 탭에서는 펼쳐져 있다(유건 제보 2026-09-15)
await p.evaluate(() => { localStorage.setItem('argo-msgr-rail-fold', JSON.stringify({ dms: true })); document.querySelector('[data-sec="dms"]').open = false; });
await p.waitForTimeout(200);
ok('DM 탭의 1:1 대화 단락은 접히지 않는다', await p.evaluate(() => document.querySelector('[data-sec="dms"]').open === true));
await p.evaluate(() => { [...document.querySelectorAll('.msgr-tabbar [role=tab]')][0].click(); }); await p.waitForTimeout(400);
ok('홈 즐겨찾기에도 있다', (await p.locator('[data-sec="fav"] .item .name', { hasText: name }).count()) === 1);
await p.setViewportSize({ width: 1280, height: 800 }); await p.waitForTimeout(600);
ok('데스크톱에는 정렬 버튼 없음', (await p.locator('[data-sec="dms"] .msgr-sortbtn').count()) === 0);
} finally { await b.close(); }
console.log(`${checks.length} dm sort/pin checks passed`);
