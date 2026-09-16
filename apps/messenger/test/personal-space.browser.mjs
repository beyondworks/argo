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
      await p.locator('[data-sec="dms"]').waitFor({ timeout: 5000 });
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

    // 2b. 개인 공간의 '새 채팅'이 여는 설정 — 조직 탭 없음, 가상 조직 id로 조회하지 않음, 조직원 친구도 개인 1:1(실사고 2026-09-16:
    // 가상 조직 객체가 설정에 넘어가 초대·봇 목록을 org_id=__personal__로 조회해 400, 친구 버튼은 조직 DM으로 갔다)
    if (width >= 768) await scenario(lang, width, 'personal-settings-no-org', async (p) => {
      await p.locator('.msgr-org').click();
      await p.locator('.msgr-menu-pop button').first().click();
      await p.locator('[data-sec="dms"]').waitFor();
      await p.locator(`[aria-label="${lang === 'ko' ? '새 채팅' : 'New chat'}"]`).click();
      await p.locator('.msgr-setnav').waitFor();
      assert.deepEqual(await p.locator('.msgr-setnav button').allTextContents(), lang === 'ko' ? ['친구', '내 계정'] : ['Friends', 'My account']);
      const row = p.locator('.msgr-setbody .row').filter({ hasText: 'Org Colleague' }).first();
      await row.getByRole('button', { name: lang === 'ko' ? '대화하기' : 'Chat' }).click();
      await p.waitForFunction(() => window.__psFixture.calls.some(c => c.rpc === 'msgr_dm_personal'));
      const dm = await rpcCalls(p, 'msgr_dm_personal');
      assert.equal(dm.at(-1).args.target, 'user-colleague');
      const leaked = (await calls(p)).filter(c => (c.eqs ?? []).some(([, v]) => v === '__personal__'));
      assert.deepEqual(leaked.map(c => `${c.table}:${c.eqs.map(e => e.join('=')).join('&')}`), []);
    });

    // 3. Personal space hides attach, crew, work buttons
    await scenario(lang, width, 'hidden-org-buttons', async (p) => {
      // Switch to personal space
      await p.locator('.msgr-org').click();
      await p.locator('.msgr-menu-pop').waitFor();
      await p.locator('.msgr-menu-pop button').first().click();

      // Wait for personal space to load and select a DM
      await p.locator('[data-sec="dms"]').waitFor({ timeout: 5000 });
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
      }
      await p.screenshot({ path: new URL(`hidden-buttons-${lang}-${width}.png`, artifacts).pathname });
    });

    // 4. Switch back to org and channels/members return
    await scenario(lang, width, 'switch-back-to-org', async (p) => {
      // First switch to personal
      await p.locator('.msgr-org').click();
      await p.locator('.msgr-menu-pop').waitFor();
      await p.locator('.msgr-menu-pop button').first().click();
      await p.locator('[data-sec="dms"]').waitFor({ timeout: 5000 });

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
