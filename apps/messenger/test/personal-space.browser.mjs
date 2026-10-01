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

// 전환기 — 데스크톱은 레일 머리(.msgr-org), 폰은 홈 큰 제목(.msgr-bigtitle, 폰 셸은 레일 머리를 숨긴다)
const switcher = (p) => p.locator(p.viewportSize().width < 768 ? '.msgr-bigtitle' : '.msgr-org');

async function scenario(lang, width, name, fn) {
  if (process.env.PS_TEST_FILTER && !`${lang}/${width}/${name}`.match(process.env.PS_TEST_FILTER)) return;
  const phone = width < 768; // 폰 폭은 모바일 기기로 연다(personal-space-mark.browser.mjs와 같다 — 폭만 줄이면 전환기가 숨는다)
  const page = await browser.newPage({ viewport: { width, height: phone ? 844 : 900 }, isMobile: phone, hasTouch: phone }); const errors = []; page.setDefaultTimeout(8000);
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  await page.addInitScript(lang => localStorage.setItem('argo-lang', lang), lang);
  try {
    await page.goto(`http://127.0.0.1:${PORT}/test/personal-space.fixture.html`);
    // Wait for the app to render (org loaded)
    await page.locator('.msgr-org').waitFor({ state: phone ? 'attached' : 'visible' });
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

    // 0. 친구 추가 팝업(유건 2026-09-30) — 개인 공간 친구 옆 +(폰은 홈 +)로 설정에 가지 않고 팝업에서 이메일·아이디로 찾아 요청
    await scenario(lang, width, 'friend-add-popup', async (p) => {
      await switcher(p).click(); await p.locator('.msgr-menu-pop').waitFor();
      await p.locator('.msgr-menu-pop button').first().click();
      if (width < 768) await p.locator('.msgr-fab').click();
      else await p.locator('[data-sec="friends"] summary .right button').click();
      const sheet = p.locator('.msgr-friendadd'); await sheet.waitFor();
      assert.equal(await p.locator('.msgr-setcard').count(), 0, '설정 화면으로 가지 않는다');
      await sheet.locator('input').fill('newbie@example.com');
      await sheet.locator('button[type=submit]').click();
      await sheet.locator('.msgr-friend-result', { hasText: 'New Person' }).waitFor();
      await p.screenshot({ path: new URL(`friend-add-popup-${lang}-${width}.png`, artifacts).pathname });
      await sheet.locator('.msgr-friend-result .btn-primary').click();
      await p.waitForFunction(() => window.__psFixture.calls.some((c) => c.rpc === 'msgr_friend_request' && c.args?.target === 'user-newbie'));
      const found = (await rpcCalls(p, 'msgr_find_user')).map((c) => c.args?.q); assert.ok(found.length >= 1 && found.every((v) => v === 'newbie@example.com'), '입력한 이메일로 찾는다(요청 뒤 결과를 한 번 다시 읽는다): ' + JSON.stringify(found));
      await p.keyboard.press('Escape');
      await sheet.waitFor({ state: 'detached' });
    });

    // 0b. 개인 공간 에이전트(유건 2026-09-30) — 내 에이전트는 보이고 친구 에이전트는 내 목록·추가 후보에 안 나온다, 크루 1:1, 친구 방에 내 에이전트 넣기, 무료 한도 안내
    await scenario(lang, width, 'personal-agents', async (p) => {
      await switcher(p).click(); await p.locator('.msgr-menu-pop').waitFor(); await p.locator('.msgr-menu-pop button').first().click();
      const mine = p.locator('[data-sec="mine"]'); await mine.waitFor();
      assert.ok((await mine.innerText()).includes('My Agent'), '내 에이전트가 개인 공간 레일에 보인다');
      assert.ok(!(await mine.innerText()).includes("Alice's Agent"), '친구 에이전트는 내 목록에 안 나온다');
      await p.screenshot({ path: new URL(`personal-agents-rail-${lang}-${width}.png`, artifacts).pathname });
      await mine.locator('.item', { hasText: 'My Agent' }).click();
      await p.waitForFunction(() => window.__psFixture.calls.some((c) => c.rpc === 'msgr_dm_personal_crew' && c.args?.crew === 'pcrew-mine'));
      await p.locator('.msgr-composer').waitFor();
      if (width < 768) return; // 폰: 레일·크루 1:1까지(방 설정은 데스크톱에서 본다)
      await p.locator('[data-sec="dms"] .item', { hasText: 'Alice Friend' }).click();
      await p.locator('.msgr-titlebtn').click();
      const sheet = p.locator('.msgr-crewsheet').last(); await sheet.waitFor();
      assert.ok((await sheet.innerText()).includes("Alice's Agent"), '방 안의 친구 에이전트는 방 구성원으로 보인다');
      await sheet.locator('.msgr-addwrap .btn-primary').click();
      await sheet.locator('.msgr-addmenu [role=menuitem]', { hasText: lang === 'ko' ? '에이전트 추가' : 'Add agent' }).click();
      const names = await sheet.locator('.msgr-picklist .pickrow .name').allInnerTexts();
      assert.deepEqual(names, ['My Agent'], '추가 후보는 내 에이전트만: ' + JSON.stringify(names));
      await sheet.locator('.msgr-picklist .pickrow input').first().check();
      await p.evaluate(() => { window.__psFixture.roomLimit = true; });
      await sheet.locator('.msgr-addwrap .acts .btn-primary').click();
      await p.getByText(lang === 'ko' ? '4명(에이전트 포함)까지' : 'up to 4 members').first().waitFor();
      await p.screenshot({ path: new URL(`personal-agents-limit-${lang}-${width}.png`, artifacts).pathname });
      await p.evaluate(() => { window.__psFixture.roomLimit = false; });
      if (!(await sheet.locator('.msgr-picklist').count())) { await sheet.locator('.msgr-addwrap .btn-primary').click(); await sheet.locator('.msgr-addmenu [role=menuitem]', { hasText: lang === 'ko' ? '에이전트 추가' : 'Add agent' }).click(); }
      const box = sheet.locator('.msgr-picklist .pickrow input').first(); if (!(await box.isChecked())) await box.check();
      await sheet.locator('.msgr-addwrap .acts .btn-primary').click();
      await p.waitForFunction(() => window.__psFixture.calls.filter((c) => c.rpc === 'msgr_crew_join' && c.args?.crew === 'pcrew-mine').length >= 2);
      await p.screenshot({ path: new URL(`personal-agents-joined-${lang}-${width}.png`, artifacts).pathname });
    });

    // 0c. AI 이용 동의 전 — 에이전트를 부르려는 순간에만 묻는다(조직처럼 공간 전체를 막지 않는다)
    await scenario(lang, width, 'personal-agents-consent', async (p) => {
      await p.evaluate(() => localStorage.setItem('psFixtureAiConsent', 'none')); await p.reload(); await p.locator('.msgr-org').waitFor({ state: 'attached' });
      await switcher(p).click(); await p.locator('.msgr-menu-pop').waitFor(); await p.locator('.msgr-menu-pop button').first().click();
      await p.locator('[data-sec="mine"] .item', { hasText: 'My Agent' }).click();
      await p.getByRole('heading', { name: lang === 'ko' ? '에이전트를 쓰려면 AI 이용 동의가 필요합니다' : 'AI use consent is needed to use agents' }).waitFor();
      assert.equal(await p.getByText(lang === 'ko' ? '조직 공간은 쓸 수 없고' : 'can’t use this organization space').count(), 0, '개인 공간에 조직 문구가 나오지 않는다');
      assert.equal((await rpcCalls(p, 'msgr_dm_personal_crew')).length, 0, '동의 전에는 크루 1:1을 만들지 않는다');
      await p.screenshot({ path: new URL(`personal-agents-consent-${lang}-${width}.png`, artifacts).pathname });
      await p.getByRole('button', { name: lang === 'ko' ? '지금은 안 함' : 'Not now' }).click();
      await p.getByRole('heading', { name: lang === 'ko' ? '에이전트를 쓰려면 AI 이용 동의가 필요합니다' : 'AI use consent is needed to use agents' }).waitFor({ state: 'detached' });
      assert.equal((await rpcCalls(p, 'msgr_set_ai_consent')).length, 0, '"지금은 안 함"은 거부로 기록하지 않는다(조직 글까지 문맥에서 빠지므로)');
      await p.evaluate(() => localStorage.removeItem('psFixtureAiConsent'));
    });

    // 0d. 개인 방 보조 줄(분리 검수 M6·H3) — 승인자에게 친구 에이전트 참여 요청, 동의 전인 사람에게 동의 안내
    if (width >= 768) await scenario(lang, width, 'personal-room-bar', async (p) => {
      await p.evaluate(() => localStorage.setItem('psFixtureAiConsent', 'none')); await p.reload(); await p.locator('.msgr-org').waitFor({ state: 'attached' });
      await switcher(p).click(); await p.locator('.msgr-menu-pop').waitFor(); await p.locator('.msgr-menu-pop button').first().click();
      await p.locator('[data-sec="dms"] .item', { hasText: 'Alice Friend' }).click();
      const req = p.locator('.msgr-joinbar', { hasText: 'Alice Friend' }); await req.waitFor();
      await p.locator('.msgr-joinbar', { hasText: lang === 'ko' ? '동의한 사람의 글만' : 'only read messages from people who agreed' }).waitFor();
      await p.screenshot({ path: new URL(`personal-room-bar-${lang}-${width}.png`, artifacts).pathname });
      await req.getByRole('button', { name: lang === 'ko' ? '허락' : 'Approve' }).click();
      await p.waitForFunction(() => window.__psFixture.calls.some((c) => c.rpc === 'msgr_crew_join_decide' && c.args?.req === 'req-alice' && c.args?.approve === true));
      await req.waitFor({ state: 'detached' });
      await p.evaluate(() => localStorage.removeItem('psFixtureAiConsent'));
    });

    // 1. Switch to personal space and see friend DM list
    await scenario(lang, width, 'switch-to-personal', async (p) => {
      // Open org switcher menu
      await switcher(p).click();
      await p.locator('.msgr-menu-pop').waitFor();

      // Find and click the personal item (first item in menu)
      const personalBtn = p.locator('.msgr-menu-pop button').first();
      const personalLabel = await personalBtn.locator('.label').textContent();
      assert.ok(personalLabel === (lang === 'ko' ? '개인 공간' : 'Personal space'), `Personal button shows "${personalLabel}"`); // 라벨 "개인 공간"(유건 2026-09-18 — 조직과 한눈에 구분)
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

      // 에이전트 절: 개인 공간은 내 개인 에이전트만(2026-09-30) — 조직 크루(Fixture Agent)는 섞이지 않는다
      const agentSection = p.locator('[data-sec="mine"]');
      if (width < 768) assert.equal(await agentSection.isVisible(), false, '폰 채팅 탭에는 에이전트 절이 보이지 않는다(홈 탭에서 본다 — personal-agents 시나리오)');
      else {
        await agentSection.waitFor(); const agentText = await agentSection.innerText();
        assert.ok(agentText.includes('My Agent') && !agentText.includes('Fixture Agent'), 'personal agents only in personal space: ' + agentText);
      }

      // People section should not be visible
      const peopleSection = p.locator('[data-sec="people"]');
      assert.equal(await peopleSection.count(), 0, 'people section hidden in personal space');

      await p.screenshot({ path: new URL(`personal-space-${lang}-${width}.png`, artifacts).pathname });
    });

    if (lang === 'ko' && width === 1280) await scenario(lang, width, 'space-transition-keeps-last-channel-scoped', async (p) => {
      await switcher(p).click();
      await p.locator('.msgr-menu-pop button').first().click();
      await dmsReady(p);
      await p.locator('[data-sec="dms"] .item').first().click();
      const personalChannel = await p.evaluate(() => JSON.parse(localStorage.getItem('argo-msgr-last-ch') || '{}').__personal__);
      assert.ok(personalChannel, 'personal last channel recorded');
      await p.evaluate(() => {
        window.__lastChWrites = [];
        const original = localStorage.setItem.bind(localStorage);
        localStorage.setItem = (key, value) => { if (key === 'argo-msgr-last-ch') window.__lastChWrites.push(value); original(key, value); };
      });
      await switcher(p).click();
      await p.locator('.msgr-menu-pop button').filter({ hasText: 'Fixture Organization' }).first().click();
      await p.locator('[data-sec="channels"] .item').first().waitFor();
      const polluted = await p.evaluate(({ org, personalChannel }) => window.__lastChWrites.some((value) => JSON.parse(value)[org] === personalChannel), { org: 'org-fixture', personalChannel });
      assert.equal(polluted, false, 'personal channel is never written under the organization key during transition');
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
      await switcher(p).click();
      await p.locator('.msgr-menu-pop button').first().click();
      await p.locator(width >= 768 ? '[data-sec="dms"]' : '[data-sec="friends"]').waitFor({ state: 'attached' });
      await switcher(p).click(); // 개인 공간 메뉴에 조직 초대 링크가 없다(가상 조직은 관리자가 아니다)
      assert.equal(await p.locator('.msgr-menu-pop button').filter({ hasText: lang === 'ko' ? '멤버 초대' : 'Invite members' }).count(), 0, 'no org invite in personal'); // 조직 초대 항목 라벨(#611: inv.org). 옛 'invite link'는 참여 항목("Join with invite link or code")에 걸려 영어에서 가짜 실패가 났다
      await p.keyboard.press('Escape'); await p.locator('.msgr-menu-pop').waitFor({ state: 'detached' }).catch(() => p.locator('.msgr-scrim').first().click());
      if (width >= 768) {
        await p.locator(`[aria-label="${lang === 'ko' ? '새 채팅' : 'New chat'}"]`).click();
      } else { // 폰: 채팅 탭 + → 새 채팅 시트(조직과 같은 문법, 유건 2026-09-17)
        await p.locator('.msgr-tabbar [role=tab]').filter({ hasText: lang === 'ko' ? '채팅' : 'Chats' }).click(); await p.locator('.msgr-fab').click();
      }
      const sheet = p.locator('.msgr-dmgroup'); await sheet.waitFor(); // 친구 한 명 고르면 개인 1:1
      await sheet.locator('.pickrow', { hasText: 'Org Colleague' }).locator('input').check();
      await sheet.locator('.foot .btn-primary').click();
      await p.waitForFunction(() => window.__psFixture.calls.some(c => c.rpc === 'msgr_dm_personal'));
      const dm = await rpcCalls(p, 'msgr_dm_personal');
      assert.equal(dm.at(-1).args.target, 'user-colleague');
      assert.ok((await rpcCalls(p, 'msgr_dm_personal_list')).every((c) => c.args?.include_groups === true), 'new app asks for groups');
      if (width >= 768) { // 검수 HIGH-2: 개인 방 설정에 나·상대가 보이고 '사람 더 부르기'(새 그룹)가 나온다 — 종전엔 친구 목록만 봐 인원 1·추가 버튼 없음
        await p.locator('.msgr-top button.members').first().click();
        const sheet = p.locator('.msgr-crewsheet'); await sheet.waitFor();
        assert.equal(await sheet.locator('.msgr-rows .row').count(), 2, 'me + the other person');
        assert.ok(await sheet.locator('.msgr-addwrap button').first().isVisible(), 'add button visible in personal 1:1');
        await sheet.locator('.msgr-addwrap button').first().click();
        assert.equal(await sheet.locator('.msgr-addmenu button', { hasText: lang === 'ko' ? '사람 더 부르기' : 'Add people' }).count(), 1, 'widen into a group');
      }
      await leakCheck(p);
    });

    // 2c. 개인 공간 검색에서 사람을 누르면 개인 1:1(조직 DM 생성으로 가지 않는다)
    if (width >= 768) await scenario(lang, width, 'personal-search-person', async (p) => {
      await switcher(p).click();
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
      await switcher(p).click();
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
        await p.evaluate(() => history.back()); await p.locator('.msgr-tabbar').waitFor(); // 폰 대화는 전체 화면이라 탭바가 없다 — 목록으로 나온다
        await p.locator('.msgr-tabbar [role=tab]').first().click();
        await p.locator('[data-sec="friends"]').waitFor();
        assert.equal(await p.locator('[data-sec="dms"]').count(), 0, 'home tab: no chat list in personal space');
        assert.ok((await p.locator('[data-sec="friends"] .item').allTextContents()).some((x) => x.includes('Alice Friend')), 'home tab lists friends');
        await p.locator('.msgr-fab').click(); // 홈 + = 친구 추가 팝업(유건 2026-09-30: 설정으로 가지 않는다)
        await p.locator('.msgr-friendadd').waitFor();
        assert.equal(await p.locator('.msgr-setnav').count(), 0, 'home + opens the add-friend popup, not settings');
        await p.keyboard.press('Escape'); await p.locator('.msgr-friendadd').waitFor({ state: 'detached' });
        await p.locator('.msgr-tabbar [role=tab]').nth(1).click();
        await p.locator('[data-sec="dms"]').waitFor();
        assert.equal(await p.locator('[data-sec="friends"]').isVisible(), false, 'chat tab: friends hidden');
        await p.locator('.msgr-fab').click(); // 채팅 탭 + = 새 채팅 시트 — 친구 둘을 고르면 개인 그룹(유건 2026-09-17: 개인 쪽에 그룹을 맺는 기능이 없다)
        const sheet = p.locator('.msgr-dmgroup'); await sheet.waitFor();
        for (const who of ['Alice Friend', 'Org Colleague']) await sheet.locator('.pickrow', { hasText: who }).locator('input').check();
        await sheet.locator('.foot .btn-primary').click();
        await p.waitForFunction(() => window.__psFixture.calls.some((c) => c.rpc === 'msgr_dm_personal_group'));
        const g = (await rpcCalls(p, 'msgr_dm_personal_group')).at(-1).args;
        assert.deepEqual([...g.targets].sort(), ['user-alice', 'user-colleague'], 'group of two friends');
        assert.equal((await rpcCalls(p, 'msgr_create_channel')).length, 0, 'not an org channel');
        await p.locator('.msgr-composer').waitFor(); // 새 방이 열린다
        await p.evaluate(() => history.back()); await p.locator('.msgr-tabbar').waitFor(); // 전체 화면 대화에서 목록으로
        await p.locator('.msgr-tabbar [role=tab]').nth(1).click();
        const groupRow = p.locator('[data-sec="dms"] .item', { hasText: 'Alice Friend' }).filter({ hasText: 'Org Colleague' });
        await groupRow.first().waitFor(); // 목록에 구성원 이름으로 보인다
      }
      await p.screenshot({ path: new URL(`hidden-buttons-${lang}-${width}.png`, artifacts).pathname });
    });

    // 4. Switch back to org and channels/members return
    await scenario(lang, width, 'switch-back-to-org', async (p) => {
      // First switch to personal
      await switcher(p).click();
      await p.locator('.msgr-menu-pop').waitFor();
      await p.locator('.msgr-menu-pop button').first().click();
      await p.locator(width >= 768 ? '[data-sec="dms"]' : '[data-sec="friends"]').waitFor({ timeout: 5000 }); // 폰은 홈 탭(친구)에 머문다 — 채팅 탭은 채널 절을 숨긴다

      // Now switch back to org
      await switcher(p).click();
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
