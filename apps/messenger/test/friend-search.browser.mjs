// Actual App + providers + DOM, isolated fake RPCs. Not database / native-app proof.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
const { chromium, webkit } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const engine = process.env.FRIEND_TEST_ENGINE || 'chromium';
const browser = await (engine === 'webkit' ? webkit : chromium).launch({ headless: true, ...(engine === 'chromium' ? { channel: 'chrome' } : {}) });
const artifacts = new URL(`../artifacts/friend-search-${engine}${process.env.FRIEND_TEST_VARIANT ? `-${process.env.FRIEND_TEST_VARIANT}` : ''}/`, import.meta.url); await mkdir(artifacts, { recursive: true });
const results = [];
const text = {
  ko: { settings: '설정', friends: '친구', input: '이메일 또는 아이디', find: '찾기', member: '이미 등록된 멤버', request: '친구 요청', sent: '요청 보냄', accept: '수락', dm: '1:1 대화' },
  en: { settings: 'Settings', friends: 'Friends', input: 'Email or handle', find: 'Find', member: 'Already a member', request: 'Send request', sent: 'Request sent', accept: 'Accept', dm: 'Direct message' },
};
const found = p => p.locator('.msgr-friend-results');
async function search(p, l, value) { await p.getByRole('textbox', { name: l.input }).fill(value); await p.getByRole('button', { name: l.find, exact: true }).click(); await found(p).waitFor(); }
async function scenario(lang, width, theme, name, action) {
  const page = await browser.newPage({ viewport: { width, height: width < 720 ? 844 : 900 }, colorScheme: theme }); page.setDefaultTimeout(7000);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  await page.addInitScript(({ lang, theme }) => { localStorage.setItem('argo-lang', lang); localStorage.setItem('argo-theme', `linen-${theme}`); }, { lang, theme });
  try {
    if (name === 'relationship-refresh') await page.clock.install();
    await page.goto(`http://127.0.0.1:${process.env.FRIEND_TEST_PORT || 5213}/test/friend-search.fixture.html`);
    await page.locator('[data-sec="mine"] .item').filter({ hasText: 'Fixture New Agent' }).waitFor();
    if (width < 720) await page.locator('button.me:not(.item)').click(); else await page.getByRole('button', { name: text[lang].settings, exact: true }).click();
    await page.locator('.msgr-setnav').getByRole('button', { name: text[lang].friends, exact: true }).click();
    await action(page, text[lang]);
    assert.deepEqual(errors, []);
    results.push({ lang, width, theme, name, passed: true }); console.log('PASS', lang, width, theme, name);
  } catch (error) {
    await page.screenshot({ path: new URL(`failure-${lang}-${width}-${theme}-${name}.png`, artifacts).pathname });
    results.push({ lang, width, theme, name, passed: false, error: error.message }); console.error('FAIL', lang, width, theme, name, error.message);
  } finally { await page.close(); }
}
try {
  for (const [lang, width, theme] of [['ko', 320, 'light'], ['en', 320, 'dark'], ['ko', 390, 'dark'], ['en', 390, 'light'], ['ko', 1280, 'light'], ['en', 1280, 'dark']]) {
    await scenario(lang, width, theme, 'member-request-and-dm', async (p, l) => {
      await search(p, l, 'COLLEAGUE@example.invalid');
      await found(p).getByText(l.member, { exact: true }).waitFor();
      assert.equal(await found(p).getByRole('button', { name: l.request, exact: true }).count(), 1);
      assert.equal(await found(p).getByRole('button', { name: l.dm, exact: true }).count(), 1);
      await p.screenshot({ path: new URL(`member-${lang}-${width}-${theme}.png`, artifacts).pathname });
      const box = await found(p).boundingBox(); assert.ok(box.x >= 0 && box.x + box.width <= width, JSON.stringify(box));
      if (width < 720) for (const b of await found(p).getByRole('button').all()) { const r = await b.boundingBox(); assert.ok(r.height >= 44 && r.x >= 0 && r.x + r.width <= width, JSON.stringify(r)); }
      await p.evaluate(() => { window.__friendFixture.holdRpc = 'msgr_friend_request'; });
      await found(p).getByRole('button', { name: l.request, exact: true }).click();
      await p.waitForFunction(() => !!window.__friendFixture.release);
      assert.equal(await found(p).getByRole('button', { name: l.request, exact: true }).isDisabled(), true);
      assert.equal(await p.getByRole('textbox', { name: l.input }).isDisabled(), true);
      await p.evaluate(() => window.__friendFixture.release());
      await found(p).getByText(l.sent, { exact: true }).waitFor();
      assert.equal(await found(p).getByRole('button', { name: l.request, exact: true }).count(), 0);
      assert.equal(await p.evaluate(() => window.__friendFixture.friendCalls.filter(c => c.name === 'msgr_friend_request').length), 1);
      await found(p).getByRole('button', { name: l.dm, exact: true }).click();
      await p.waitForFunction(() => window.__dmFixture.calls.some(c => c.rpc === 'msgr_create_channel' && c.args.others.some(m => m.id === 'user-other')));
    });
    await scenario(lang, width, theme, 'relations-and-accept', async (p, l) => {
      await search(p, l, '@newperson'); await found(p).getByRole('button', { name: l.request, exact: true }).waitFor();
      assert.equal(await found(p).getByText(l.member, { exact: true }).count(), 0); assert.equal(await found(p).getByRole('button', { name: l.dm, exact: true }).count(), 0);
      await p.screenshot({ path: new URL(`long-name-${lang}-${width}-${theme}.png`, artifacts).pathname });
      assert.equal(await found(p).evaluate(el => el.scrollWidth <= el.clientWidth + 1), true);
      await search(p, l, '@sentperson'); await found(p).getByText(l.sent, { exact: true }).waitFor(); assert.equal(await found(p).getByRole('button', { name: l.request, exact: true }).count(), 0);
      await search(p, l, '@friendperson'); await found(p).getByText(l.friends, { exact: true }).waitFor(); assert.equal(await found(p).getByRole('button', { name: l.request, exact: true }).count(), 0);
      await search(p, l, '@receivedperson'); await found(p).getByRole('button', { name: l.accept, exact: true }).click();
      await found(p).getByText(l.friends, { exact: true }).waitFor(); assert.equal(await found(p).getByRole('button', { name: l.accept, exact: true }).count(), 0);
      assert.equal(await p.evaluate(() => window.__friendFixture.friendCalls.filter(c => c.name === 'msgr_friend_decide').length), 1);
    });
    await scenario(lang, width, theme, 'empty-error-and-retry', async (p, l) => {
      const input = p.getByRole('textbox', { name: l.input }); await input.fill('@ab'); assert.equal(await p.getByRole('button', { name: l.find, exact: true }).isDisabled(), true);
      assert.equal(await p.evaluate(() => window.__friendFixture.friendCalls.filter(c => c.name === 'msgr_find_user').length), 0);
      await search(p, l, 'missing@example.invalid'); assert.equal(await found(p).locator('.empty').count(), 1);
      await p.evaluate(() => { window.__friendFixture.failRpc = 'msgr_find_user'; });
      await input.fill('@colleague'); await p.getByRole('button', { name: l.find, exact: true }).click(); await p.getByRole('alert').filter({ hasText: 'Fixture search failure' }).waitFor(); assert.equal(await found(p).count(), 0);
      await search(p, l, '@colleague'); await found(p).getByText(l.member, { exact: true }).waitFor(); assert.equal(await p.getByRole('alert').filter({ hasText: 'Fixture search failure' }).count(), 0);
    });
    await scenario(lang, width, theme, 'relationship-refresh', async (p, l) => {
      for (const [handle, id, label] of [['@sentperson', 'user-sent', l.sent], ['@friendperson', 'user-friend', l.friends]]) {
        await search(p, l, handle); await found(p).getByText(label, { exact: true }).waitFor();
        const searches = await p.evaluate(() => window.__friendFixture.friendCalls.filter(c => c.name === 'msgr_find_user').length);
        await p.evaluate(id => { window.__friendFixture.friends = window.__friendFixture.friends.filter(f => f.user_id !== id);  }, id);
        await p.clock.fastForward(16000);
        await found(p).getByRole('button', { name: l.request, exact: true }).waitFor();
        assert.equal(await found(p).getByText(label, { exact: true }).count(), 0);
        assert.equal(await p.evaluate(() => window.__friendFixture.friendCalls.filter(c => c.name === 'msgr_find_user').length), searches);
      }
    });
    await scenario(lang, width, theme, 'stale-response', async (p, l) => {
      const input = p.getByRole('textbox', { name: l.input }); await p.evaluate(() => { window.__friendFixture.holdRpc = 'msgr_find_user'; });
      await input.fill('@colleague'); await p.getByRole('button', { name: l.find, exact: true }).click(); await p.waitForFunction(() => !!window.__friendFixture.release);
      await input.fill('@newperson'); await p.getByRole('button', { name: l.find, exact: true }).click(); await found(p).getByText('Fixture New Person With A Long Display Name', { exact: true }).waitFor();
      await p.evaluate(() => window.__friendFixture.release());
      // A subsequent animation frame lets the resolved stale promise and React render settle.
      await p.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await found(p).getByText('Fixture Colleague', { exact: true }).count(), 0); assert.equal(await found(p).getByText('Fixture New Person With A Long Display Name', { exact: true }).count(), 1);
    });
  }
} finally { await writeFile(new URL('results.json', artifacts), JSON.stringify(results, null, 2)); await browser.close(); }
assert.ok(results.every(r => r.passed), `${results.filter(r => !r.passed).length} browser scenarios failed`);
