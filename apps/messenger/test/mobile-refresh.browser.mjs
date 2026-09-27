import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE } : {}) });
const artifacts = new URL('../artifacts/mobile-refresh/', import.meta.url);
await mkdir(artifacts, { recursive: true });
const results = [];
try {
  for (const width of [320, 390, 430]) {
    const page = await browser.newPage({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    await page.addInitScript(() => {
      let state;
      Object.defineProperty(window, '__dmFixture', { configurable: true, get: () => state, set: value => {
        state = value;
        const seed = value.tables.msgr_messages[0];
        for (let n = 1; n <= 60; n++) value.tables.msgr_messages.push({ ...seed, id: 101 + n, body: `History ${n}`, created_at: new Date(Date.parse(seed.created_at) + n * 1000).toISOString() });
      } });
    });
    await page.goto('http://127.0.0.1:5219/test/dm-lifecycle.fixture.html');
    await page.locator('[data-sec="dms"] .item').first().click();
    await page.locator('.msgr-composer textarea').fill('새로고침 후에도 남을 초안');
    await page.locator('input[type="file"]').setInputFiles([
      { name: 'IMG_5716.jpeg', mimeType: 'image/jpeg', buffer: Buffer.from('fixture image') },
      { name: 'very-long-project-document-name-without-spaces-for-mobile-width-validation.pdf', mimeType: 'application/pdf', buffer: Buffer.from('fixture document') },
    ]);
    await page.locator('.msgr-filechips .filechip').nth(1).waitFor();
    await page.waitForTimeout(350);
    const rects = await page.evaluate(() => {
      const box = el => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; };
      return { form: box(document.querySelector('.msgr-composer')), chips: [...document.querySelectorAll('.msgr-filechips .filechip')].map(box), textarea: box(document.querySelector('.msgr-composer textarea')) };
    });
    console.log(JSON.stringify({ width, rects }));
    await page.screenshot({ path: new URL(`${width}-layout.png`, artifacts).pathname });
    for (const chip of rects.chips) { assert.ok(chip.bottom <= rects.form.top); assert.ok(chip.left >= 0 && chip.right <= width); }
    assert.ok(rects.textarea.right > rects.textarea.left + 100);
    await page.evaluate(() => { window.__refreshDocument = document.querySelector('.msgr-composer textarea'); document.querySelector('.msgr-thread').scrollTop = 0; });
    await page.waitForTimeout(300);
    const pull = () => page.locator('.msgr-thread').evaluate(el => {
      const event = (type, y) => { const e = new Event(type, { bubbles: true, cancelable: true }); Object.defineProperties(e, { touches: { value: [{ clientX: 30, clientY: y }] }, changedTouches: { value: [{ clientX: 30, clientY: y }] } }); el.dispatchEvent(e); };
      event('touchstart', 100); event('touchmove', 240); event('touchend', 240);
    });
    await page.evaluate(() => {
      const state = window.__dmFixture; const seed = state.tables.msgr_messages[0];
      seed.body = 'Edited old message during offline';
      state.tables.msgr_messages[1].deleted_at = new Date().toISOString();
      for (let id = 162; id <= 401; id++) state.tables.msgr_messages.push({ ...seed, id, body: `Missed message ${id}`, deleted_at: null });
      state.holdNext = 'msgr_messages:select';
    });
    await pull(); await page.locator('.msgr-pullrefresh').waitFor();
    assert.equal(await page.locator('.msgr-composer textarea').inputValue(), '새로고침 후에도 남을 초안');
    const before = await page.evaluate(() => window.__dmFixture.calls.filter(c => c.table === 'msgr_messages').length);
    await pull();
    assert.equal(await page.evaluate(() => window.__dmFixture.calls.filter(c => c.table === 'msgr_messages').length), before);
    await page.evaluate(() => window.__dmFixture.release());
    await page.locator('.msgr-pullrefresh').waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => window.__refreshDocument === document.querySelector('.msgr-composer textarea')), true);
    assert.ok(await page.locator('.msgr-thread').evaluate(el => el.scrollTop < 2));
    assert.equal(await page.locator('[data-mid]').count(), 301);
    assert.equal(await page.locator('[data-mid="101"]').innerText().then(s => s.includes('Edited old message during offline')), true);
    assert.equal(await page.locator('[data-mid="401"]').count(), 1);
    assert.deepEqual(await page.locator('[data-mid]').evaluateAll(els => els.map(el => Number(el.dataset.mid))), Array.from({ length: 301 }, (_, i) => i + 101));
    assert.equal((await page.locator('[data-mid="102"]').innerText()).includes('History 1'), false);
    assert.equal(await page.locator('.msgr-filechips .filechip').count(), 2);
    assert.equal(await page.locator('.msgr-composer textarea').inputValue(), '새로고침 후에도 남을 초안');
    await page.waitForTimeout(300);
    await page.evaluate(() => { window.__dmFixture.failNext = 'msgr_messages:select'; });
    await pull(); await page.locator('.msgr-toast.err').waitFor();
    assert.equal(await page.locator('.msgr-composer textarea').inputValue(), '새로고침 후에도 남을 초안');
    await pull(); await page.locator('.msgr-pullrefresh').waitFor({ state: 'detached' });
    assert.deepEqual(errors, []);
    await page.screenshot({ path: new URL(`${width}.png`, artifacts).pathname });
    results.push({ width, rects, passed: true }); console.log('PASS', width); await page.close();
  }
} finally { await writeFile(new URL('results.json', artifacts), JSON.stringify(results, null, 2)); await browser.close(); }
