// Actual App and notification module with an isolated backend; no user data or push permission changes.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
const pw = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const artifacts = new URL('../artifacts/sound-settings/', import.meta.url); await mkdir(artifacts, { recursive: true });
const results = [];
for (const engine of ['chromium', 'webkit']) {
  const browser = await pw[engine].launch({ headless: true, ...(engine === 'chromium' ? { channel: 'chrome' } : {}) });
  for (const width of [320, 390, 1280]) for (const theme of ['light', 'dark']) for (const lang of ['ko', 'en']) {
    const page = await browser.newPage({ viewport: { width, height: 844 }, colorScheme: theme }); page.setDefaultTimeout(8000);
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', r => new URL(r.request().url()).hostname === '127.0.0.1' ? r.continue() : r.abort());
    await page.addInitScript(({ theme, lang }) => { localStorage.setItem('argo-theme', `linen-${theme}`); localStorage.setItem('argo-lang', lang); }, { theme, lang });
    const name = `${engine}-${width}-${theme}-${lang}`;
    try {
      await page.goto(`http://127.0.0.1:${process.env.SOUND_TEST_PORT || 5183}/`);
      if (width < 720) await page.locator('.msgr-foot > button.me').click(); else await page.getByRole('button', { name: lang === 'ko' ? '설정' : 'Settings', exact: true }).click();
      await page.getByRole('button', { name: lang === 'ko' ? '내 계정' : 'My account', exact: true }).click();
      const select = page.getByRole('combobox', { name: lang === 'ko' ? '알림 소리' : 'Notification sound' });
      await select.scrollIntoViewIfNeeded(); assert.equal(await select.inputValue(), 'wood-knock');
      const metrics = await page.locator('.msgr-sound').evaluate(el => {
        const select = el.querySelector('select'), button = el.querySelector('button');
        const s = select.getBoundingClientRect(), b = button.getBoundingClientRect(), r = el.getBoundingClientRect();
        return { select: { x: s.x, right: s.right, top: s.top, bottom: s.bottom, width: s.width, height: s.height }, button: { x: b.x, right: b.right, top: b.top, bottom: b.bottom, height: b.height }, right: r.right, appearance: getComputedStyle(select).appearance, fontSize: getComputedStyle(select).fontSize, overflow: document.documentElement.scrollWidth > innerWidth };
      });
      assert.ok(metrics.select.height >= 44 && metrics.button.height >= 44, 'Touch target smaller than 44');
      assert.ok(Math.abs(metrics.select.top - metrics.button.top) <= 1, 'Preview wrapped below picker');
      assert.ok(metrics.select.right <= metrics.button.x && metrics.button.right <= width, 'Controls overlap or overflow');
      assert.equal(metrics.appearance, 'none'); assert.equal(metrics.overflow, false);
      await select.focus(); await page.keyboard.press(engine === 'webkit' ? 'Alt+Tab' : 'Tab'); assert.equal(await page.locator('.msgr-sound button').evaluate(el => el === document.activeElement), true);
      await select.selectOption('seatbelt-single');
      assert.equal(await page.evaluate(() => localStorage.getItem('msgr-sound')), 'seatbelt-single');
      await page.locator('.msgr-sound button').click();
      await page.screenshot({ path: new URL(`${name}.png`, artifacts).pathname });
      const behavior = await page.evaluate(async () => {
        const sound = await import('/src/notify.js');
        const explicit = sound.getSound(); sound.setSound('not-a-sound'); const invalidWrite = sound.getSound();
        localStorage.removeItem('msgr-sound'); const unset = sound.getSound();
        localStorage.setItem('msgr-sound', 'obsolete'); const invalidSaved = sound.getSound();
        return { explicit, invalidWrite, unset, invalidSaved };
      });
      assert.deepEqual(behavior, { explicit: 'seatbelt-single', invalidWrite: 'seatbelt-single', unset: 'wood-knock', invalidSaved: 'wood-knock' });
      assert.deepEqual(errors, []); results.push({ name, passed: true, metrics }); console.log('PASS', name);
    } catch (e) { results.push({ name, passed: false, error: e.message }); console.error('FAIL', name, e.message); await page.screenshot({ path: new URL(`${name}-failure.png`, artifacts).pathname }); }
    finally { await page.close(); }
  }
  await browser.close();
}
await writeFile(new URL('results.json', artifacts), JSON.stringify(results, null, 2));
if (results.some(r => !r.passed)) process.exitCode = 1;
