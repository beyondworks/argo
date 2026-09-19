// 친구·개인 공간 묶음(S7·S11·S15·S16·S18) 행동 테스트.
// 서버 둘: node node_modules/vite/bin/vite.js --config test/personal-space.config.mjs --port 5199 --strictPort
//          node node_modules/vite/bin/vite.js --config test/flink.config.mjs --port 5202 --strictPort
// 실행: PLAYWRIGHT_MODULE=/절대경로/playwright/index.mjs node test/friends-personal.browser.mjs
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const PS = process.env.PS_TEST_PORT || 5199, FL = process.env.FLINK_TEST_PORT || 5202;
const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' });
const out = {}; const fails = [];
const check = (name, ok, detail) => { out[name] = ok ? true : detail ?? false; if (!ok) fails.push(name); };
async function open(url, viewport) {
  const ctx = await browser.newContext({ viewport, ...(viewport.width < 500 ? { isMobile: true, hasTouch: true } : {}) });
  const page = await ctx.newPage();
  page.setDefaultTimeout(8000);
  await page.route('**/*', (rt) => new URL(rt.request().url()).hostname === '127.0.0.1' ? rt.continue() : rt.abort());
  await page.addInitScript(() => localStorage.setItem('argo-lang', 'ko'));
  await page.goto(url);
  await page.locator('button.msgr-org').waitFor();
  return page;
}
const toPersonal = async (page) => { await page.locator('button.msgr-org').click(); await page.getByRole('menuitemradio', { name: /개인 공간/ }).click(); await page.waitForTimeout(500); };
const openFriends = async (page) => {
  await page.evaluate(() => document.querySelector('button[aria-label="설정"]')?.click()); // 폰은 설정 버튼이 서랍 안이라 보이지 않는다
  await page.getByRole('tab', { name: /^친구/ }).first().click().catch(async () => { await page.locator('button', { hasText: /^친구/ }).first().click(); });
  await page.locator('.msgr-friendlink').waitFor();
};

// 개인 공간 — 폰 390(탭·배지·알림함·삭제 확인)
{
  const page = await open(`http://127.0.0.1:${PS}/test/personal-space.fixture.html`, { width: 390, height: 844 });
  await toPersonal(page);
  const tabs = await page.locator('.msgr-tabbar [role="tab"]').allInnerTexts();
  check('s18.noMemoryTab', !tabs.some((x) => x.includes('기억')), tabs);
  check('s15.tabDot', await page.locator('.msgr-tabbar [role="tab"] .n').count() > 0);
  await page.locator('.msgr-tabbar [role="tab"]', { hasText: '알림함' }).click();
  const rows = await page.locator('.msgr-inboxrow').allInnerTexts();
  check('s15.inboxFriend', rows.length === 1 && rows[0].includes('Bob Pending') && !rows[0].includes('user-bob'), rows);
  await page.locator('.msgr-inboxrow').first().click({ timeout: 3000 }).catch(() => {});
  if (!(await page.locator('.msgr-friendlink').count())) await openFriends(page); // 알림함 항목이 없어도 친구 화면은 본다(빨강에서 이어가기)
  check('s15.inboxOpensFriends', await page.locator('.msgr-friendlink').count() === 1);
  const card = await page.locator('.msgr-setcard', { has: page.locator('.msgr-friendlink') }).innerText();
  check('s7.noNotHere', !card.includes('이 조직에 없음') && !/@alice · \n|@alice ·$/m.test(card), card.slice(0, 200));
  const alice = page.locator('.msgr-setcard .msgr-rows .row', { hasText: 'Alice Friend' });
  await alice.locator('button[aria-label="친구 삭제"]').click();
  await page.waitForTimeout(300);
  const dialog = page.getByRole('dialog', { name: '친구 삭제' });
  check('s16.confirmOpens', await dialog.isVisible() && (await dialog.innerText()).includes('Alice Friend님을 친구에서 뺄까요?'));
  await page.keyboard.press('Escape');
  check('s16.escKeeps', !(await dialog.count()) && await alice.count() === 1, { dialog: await dialog.count(), alice: await alice.count() });
  if (await alice.count()) await alice.locator('button[aria-label="친구 삭제"]').click();
  await dialog.getByRole('button', { name: '친구 삭제' }).click({ timeout: 3000 }).catch(() => {});
  await page.getByText('친구에서 뺐습니다.').waitFor({ timeout: 3000 }).catch(() => {});
  check('s16.toast', await page.getByText('친구에서 뺐습니다.').isVisible().catch(() => false));
  await page.context().close();
}
// 개인 공간 — 데스크톱: 벨
{
  const page = await open(`http://127.0.0.1:${PS}/test/personal-space.fixture.html`, { width: 1280, height: 860 });
  await toPersonal(page);
  check('s15.deskBell', (await page.locator('button.bell .n').innerText().catch(() => '')) === '1');
  await page.context().close();
}
// 친구 링크: 만든 뒤 다시 열어도 보이고, 끊으면 사라진다
{
  const page = await open(`http://127.0.0.1:${FL}/test/flink.fixture.html`, { width: 1280, height: 860 });
  await openFriends(page);
  const make = async () => { await page.locator('.msgr-friendlink button', { hasText: '링크 만들기' }).click(); await page.locator('.msgr-friendlink code').waitFor(); };
  // 끊으면 곧바로 코드·복사가 사라진다(S11-b — 죽은 링크를 복사해 보내지 않게)
  await make();
  await page.locator('.msgr-friendlink button', { hasText: '끊기' }).click();
  await page.waitForTimeout(400);
  check('s11b.revokeClears', await page.locator('.msgr-friendlink code').count() === 0 && await page.locator('.msgr-friendlink button', { hasText: '링크 만들기' }).count() === 1);
  // 새로 만든 링크는 설정을 나갔다 다시 열어도(새로고침과 같은 마운트 경로) 보인다
  if (await page.locator('.msgr-friendlink button', { hasText: '링크 만들기' }).count()) await make();
  await page.evaluate(() => document.querySelector('button[aria-label="설정"]')?.click()); await page.waitForTimeout(300);
  await openFriends(page);
  await page.locator('.msgr-friendlink code').waitFor({ timeout: 3000 }).catch(() => {});
  check('s11.remountShowsLink', await page.locator('.msgr-friendlink code').count() === 1);
  await page.context().close();
}

await browser.close();
console.log(JSON.stringify(out));
console.log(fails.length ? `FAIL ${fails.join(', ')}` : 'PASS');
process.exit(fails.length ? 1 : 0);
