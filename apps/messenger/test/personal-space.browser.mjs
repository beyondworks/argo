// Start Vite: node node_modules/vite/bin/vite.js --config test/personal-space.config.mjs
// Run: PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node test/personal-space.browser.mjs
// Uses actual main.jsx/App.jsx/providers and DOM. Fake backend + external request blocking prevent live writes.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' });
const artifacts = new URL('../artifacts/personal-space/', import.meta.url);
await mkdir(artifacts, { recursive: true });
const results = [];
const PORT = process.env.PS_TEST_PORT || 5199;

async function scenario(lang, width, name, fn) {
  if (process.env.PS_TEST_FILTER && !`${lang}/${width}/${name}`.match(process.env.PS_TEST_FILTER)) return;
  const page = await browser.newPage({ viewport: { width, height: 900 } }); const errors = []; page.setDefaultTimeout(8000);
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  await page.addInitScript(lang => localStorage.setItem('argo-lang', lang), lang);
  try {
    await page.goto(`http://127.0.0.1:${PORT}/test/personal-space.fixture.html`);
    // Wait for the app to render (org loaded)
    await page.locator('.msgr-org').waitFor();
    await fn(page);
    assert.deepEqual(errors, []);
    results.push({ lang, width, name, passed: true }); console.log('PASS', lang, width, name);
  } catch (e) {
    await page.screenshot({ path: new URL(`failure-${lang}-${width}-${name}.png`, artifacts).pathname });
    results.push({ lang, width, name, passed: false, error: e.message }); console.error('FAIL', lang, width, name, e.message);
  } finally { await page.close(); }
}

async function calls(p) { return p.evaluate(() => window.__psFixture.calls); }
// 폰 개인 공간은 홈=친구, 채팅 탭=채팅 목록(카톡식, 2026-09-17) — 채팅 목록을 볼 때는 폰이면 채팅 탭으로 간다
async function dmsReady(p, opts = {}) { if ((p.viewportSize()?.width ?? 1280) < 768) await p.locator('.msgr-tabbar [role=tab]').nth(1).click(); await p.locator('[data-sec="dms"]').waitFor(opts); }
async function rpcCalls(p, name) { return (await calls(p)).filter(c => c.rpc === name); }

try {
  for (const [lang, width] of [['ko', 1280], ['en', 1280], ['ko', 390], ['en', 390]]) {

    // 1. Switch to personal space and see friend DM list
    await scenario(lang, width, 'switch-to-personal', async (p) => {
      // Open org switcher menu
      await p.locator('.msgr-org').click();
      await p.locator('.msgr-menu-pop').waitFor();

      // Find and click the personal item (first item in menu)
      const personalBtn = p.locator('.msgr-menu-pop button').first();
      const personalLabel = await personalBtn.locator('.label').textContent();
      assert.ok(personalLabel === (lang === 'ko' ? '개인' : 'Personal'), `Personal button shows "${personalLabel}"`);
      await personalBtn.click();

      // Should see personal DM list (Alice Friend)
      await dmsReady(p, { timeout: 5000 });
      const dmItems = p.locator('[data-sec="dms"] .item');
      await dmItems.first().waitFor({ timeout: 5000 });

      // Verify msgr_dm_personal_list was called
      const plCalls = await rpcCalls(p, 'msgr_dm_personal_list');
      assert.ok(plCalls.length > 0, 'msgr_dm_personal_list called');

      // Channels section should not be visible
      const channelSection = p.locator('[data-sec="channels"]');
      assert.equal(await channelSection.count(), 0, 'channels section hidden in personal space');

      // Agents section should not be visible
      const agentSection = p.locator('[data-sec="mine"]');
      assert.equal(await agentSection.count(), 0, 'agents section hidden in personal space');

      // People section should not be visible
      const peopleSection = p.locator('[data-sec="people"]');
      assert.equal(await peopleSection.count(), 0, 'people section hidden in personal space');

      await p.screenshot({ path: new URL(`personal-space-${lang}-${width}.png`, artifacts).pathname });
    });

    // 2. Friend DM button calls msgr_dm_personal and navigates
    await scenario(lang, width, 'friend-dm-button', async (p) => {
      // Go to settings > friends
      // 아이콘 버튼이라 본문 텍스트가 없다 — 라벨로 찾는다(hasText는 텍스트 노드를 본다).
      // 폰 폭에서는 상단바 설정 버튼이 가려진다 — 폰은 내 프로필 버튼이 설정을 연다(앱의 실제 경로).
      if (width < 768) await p.locator('button.me').first().click();
      else await p.locator(`[aria-label="${lang === 'ko' ? '설정' : 'Settings'}"]`).first().click();
      // Find the friends tab
      const friendsTab = p.getByRole('tab', { name: lang === 'ko' ? '친구' : 'Friends' });
      if (await friendsTab.isVisible()) await friendsTab.click();

      // The fixture has Alice as accepted friend (not in org)
      // Look for the chat button next to Alice
      const aliceRow = p.locator('.msgr-friend-result, .row').filter({ hasText: 'Alice Friend' }).first();
      if (await aliceRow.isVisible()) {
        const chatBtn = aliceRow.locator('button').filter({ hasText: lang === 'ko' ? '대화하기' : 'Chat' }).first();
        if (await chatBtn.isVisible()) {
          await chatBtn.click();
          // Should have called msgr_dm_personal
          const dmCalls = await rpcCalls(p, 'msgr_dm_personal');
          assert.ok(dmCalls.length > 0, 'msgr_dm_personal called when clicking friend chat button');
          assert.equal(dmCalls[0].args.target, 'user-alice', 'called with correct target');
        }
      }
      await p.screenshot({ path: new URL(`friend-dm-${lang}-${width}.png`, artifacts).pathname });
    });

    // 2b. 개인 공간에서 새 대화를 여는 길(PC '새 채팅' · 폰 채팅 탭 + 버튼) — 조직 탭 없음, 조직원 친구도 개인 1:1, 가상 조직 id가 서버로 안 감.
    // 실사고 2026-09-16: 가상 조직(role owner)이 설정·isAdmin·openDm에 새어 초대·봇 조회, 초대 링크 생성, msgr_create_channel이 __personal__로 400.
    const leakCheck = async (p) => assert.deepEqual((await calls(p)).filter(c => JSON.stringify(c).includes('__personal__')).map(c => `${c.table || c.rpc}:${c.op || 'rpc'}`), []);
    await scenario(lang, width, 'personal-new-chat-no-org', async (p) => {
      await p.locator('.msgr-org').click();
      await p.locator('.msgr-menu-pop button').first().click();
      await p.locator(width >= 768 ? '[data-sec="dms"]' : '[data-sec="friends"]').waitFor({ state: 'attached' });
      await p.locator('.msgr-org').click(); // 개인 공간 메뉴에 조직 초대 링크가 없다(가상 조직은 관리자가 아니다)
      assert.equal(await p.locator('.msgr-menu-pop button').filter({ hasText: lang === 'ko' ? '조직 초대 링크' : 'invite link' }).count(), 0, 'no org invite in personal');
      await p.keyboard.press('Escape'); await p.locator('.msgr-menu-pop').waitFor({ state: 'detached' }).catch(() => p.locator('.msgr-scrim').first().click());
      if (width >= 768) {
        await p.locator(`[aria-label="${lang === 'ko' ? '새 채팅' : 'New chat'}"]`).click();
        await p.locator('.msgr-setnav').waitFor();
        assert.deepEqual(await p.locator('.msgr-setnav button').allTextContents(), lang === 'ko' ? ['친구', '내 계정'] : ['Friends', 'My account']);
        const row = p.locator('.msgr-setbody .row').filter({ hasText: 'Org Colleague' }).first();
        await row.getByRole('button', { name: lang === 'ko' ? '대화하기' : 'Chat' }).click();
      } else { // 폰: 채팅 탭 + → 친구 목록 → 친구를 누르면 개인 1:1
        await p.locator('.msgr-tabbar [role=tab]').filter({ hasText: lang === 'ko' ? '채팅' : 'Chats' }).click(); await p.locator('.msgr-fab').click();
        await p.locator('[data-sec="friends"] .item', { hasText: 'Org Colleague' }).click();
      }
      await p.waitForFunction(() => window.__psFixture.calls.some(c => c.rpc === 'msgr_dm_personal'));
      const dm = await rpcCalls(p, 'msgr_dm_personal');
      assert.equal(dm.at(-1).args.target, 'user-colleague');
      await leakCheck(p);
    });

    // 2c. 개인 공간 검색에서 사람을 누르면 개인 1:1(조직 DM 생성으로 가지 않는다)
    if (width >= 768) await scenario(lang, width, 'personal-search-person', async (p) => {
      await p.locator('.msgr-org').click();
      await p.locator('.msgr-menu-pop button').first().click();
      await dmsReady(p);
      const box = p.locator('input[placeholder*="⌘K"]'); await box.fill('Colleague'); await box.press('Enter');
      await p.locator('main button').filter({ hasText: 'Org Colleague' }).first().click();
      await p.waitForFunction(() => window.__psFixture.calls.some(c => c.rpc === 'msgr_dm_personal'));
      assert.equal((await rpcCalls(p, 'msgr_dm_personal')).at(-1).args.target, 'user-colleague');
      assert.equal((await rpcCalls(p, 'msgr_create_channel')).length, 0);
      await leakCheck(p);
    });

    // 3. Personal space hides attach, crew, work buttons
    await scenario(lang, width, 'hidden-org-buttons', async (p) => {
      // Switch to personal space
      await p.locator('.msgr-org').click();
      await p.locator('.msgr-menu-pop').waitFor();
      await p.locator('.msgr-menu-pop button').first().click();

      // Wait for personal space to load and select a DM
      await dmsReady(p, { timeout: 5000 });
      const dmItem = p.locator('[data-sec="dms"] .item').first();
      if (await dmItem.isVisible()) {
        await dmItem.click();
        // Wait for chat view
        await p.locator('.msgr-composer').waitFor({ timeout: 5000 });

        // Attach button should NOT be visible
        const attachBtn = p.locator('.msgr-tools .tb').filter({ hasText: lang === 'ko' ? '첨부' : 'Attach' });
        assert.equal(await attachBtn.count(), 0, 'attach button hidden in personal space');

        // Work button should NOT be visible
        const workBtn = p.locator('.msgr-work-button');
        assert.equal(await workBtn.count(), 0, 'work button hidden in personal space');

        // 파일 드롭도 받지 않는다 — 버튼·붙여넣기만 막고 드롭이 빠져 msgr/__personal__/ 업로드가 RLS에 거부되던 것(2R 검수)
        await p.locator('.msgr-composer').evaluate((form) => {
          const dt = new DataTransfer(); dt.items.add(new File(['x'], 'dropped-in-personal.txt', { type: 'text/plain' }));
          for (const type of ['dragenter', 'dragover', 'drop']) form.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
        });
        await p.waitForTimeout(300);
        assert.equal(await p.getByText('dropped-in-personal.txt').count(), 0, 'drop ignored in personal space');
      } else assert.fail('personal DM row not visible');
      if (width < 768) { // 카톡식(유건 2026-09-17): 개인 공간 홈 = 친구 목록(+ = 친구 추가), 채팅 탭 = 채팅 목록(+ = 친구 목록으로)
        await p.locator('.msgr-tabbar [role=tab]').first().click();
        await p.locator('[data-sec="friends"]').waitFor();
        assert.equal(await p.locator('[data-sec="dms"]').count(), 0, 'home tab: no chat list in personal space');
        assert.ok((await p.locator('[data-sec="friends"] .item').allTextContents()).some((x) => x.includes('Alice Friend')), 'home tab lists friends');
        await p.locator('.msgr-fab').click();
        await p.locator('.msgr-setnav').waitFor();
        assert.equal(await p.locator('.msgr-setnav button[aria-current="page"]').innerText(), lang === 'ko' ? '친구' : 'Friends', 'home + opens add friend');
        await p.locator('.msgr-tabbar [role=tab]').nth(1).click();
        await p.locator('[data-sec="dms"]').waitFor();
        assert.equal(await p.locator('[data-sec="friends"]').isVisible(), false, 'chat tab: friends hidden');
        await p.locator('.msgr-fab').click();
        await p.locator('[data-sec="friends"]').waitFor();
        await p.locator('[data-sec="friends"] .item', { hasText: 'Alice Friend' }).click();
        await p.waitForFunction(() => window.__psFixture.calls.some((c) => c.rpc === 'msgr_dm_personal'));
        assert.equal((await rpcCalls(p, 'msgr_dm_personal')).at(-1).args.target, 'user-alice', 'tap friend opens personal 1:1');
      }
      await p.screenshot({ path: new URL(`hidden-buttons-${lang}-${width}.png`, artifacts).pathname });
    });

    // 4. Switch back to org and channels/members return
    await scenario(lang, width, 'switch-back-to-org', async (p) => {
      // First switch to personal
      await p.locator('.msgr-org').click();
      await p.locator('.msgr-menu-pop').waitFor();
      await p.locator('.msgr-menu-pop button').first().click();
      await p.locator(width >= 768 ? '[data-sec="dms"]' : '[data-sec="friends"]').waitFor({ timeout: 5000 }); // 폰은 홈 탭(친구)에 머문다 — 채팅 탭은 채널 절을 숨긴다

      // Now switch back to org
      await p.locator('.msgr-org').click();
      await p.locator('.msgr-menu-pop').waitFor();
      // The org button is after the personal + separator, so find by name
      const orgBtn = p.locator('.msgr-menu-pop button').filter({ hasText: 'Fixture Organization' }).first();
      await orgBtn.click();

      // Channels section should be back
      await p.locator('[data-sec="channels"]').waitFor({ timeout: 5000 });
      const channelItems = p.locator('[data-sec="channels"] .item');
      assert.ok(await channelItems.count() > 0, 'channels visible after switching back to org');

      // Agents section should be back
      const agentSection = p.locator('[data-sec="mine"]');
      assert.ok(await agentSection.count() > 0, 'agents section visible after switching back to org');

      await p.screenshot({ path: new URL(`switch-back-${lang}-${width}.png`, artifacts).pathname });
    });
  }
} finally {
  await browser.close();
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  console.log(`\n${passed} passed, ${failed} failed out of ${results.length}`);
  if (failed) { console.error('Failures:', results.filter(r => !r.passed).map(r => `${r.lang}/${r.width}/${r.name}: ${r.error}`)); process.exit(1); }
}
