import assert from 'node:assert/strict';

// Server: node node_modules/vite/bin/vite.js --config test/msgr-ui-feedback.config.mjs --port 5211 --strictPort
// Run: PLAYWRIGHT_MODULE=/absolute/path/playwright/index.mjs node test/name-prompt.browser.mjs
// The config aliases supabase.js to msgr-ui-feedback.supabase.mjs, where ?noname=empty and ?noname=1 set the member name.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const port = process.env.UF_TEST_PORT || 5211;
const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' });

async function prompt(lang, variant) {
  const page = await browser.newPage();
  await page.addInitScript((value) => localStorage.setItem('argo-lang', value), lang);
  await page.goto(`http://127.0.0.1:${port}/test/instant-delivery.fixture.html${variant ? `?noname=${variant}` : ''}`);
  const card = page.locator('.msgr-nameprompt');
  await page.locator('.msgr-spine').waitFor();
  const expectedName = variant === 'empty' ? null : variant ? 'fixture' : '나';
  assert.equal(await page.evaluate(() => window.__instant.tables.msgr_org_members[0].display_name), expectedName);
  if (variant) await card.waitFor();
  const visible = await card.isVisible();
  const text = visible ? await card.locator('.txt span').innerText() : '';
  await page.close();
  return { visible, text };
}

try {
  assert.deepEqual(await prompt('ko', ''), { visible: false, text: '' });
  assert.deepEqual(await prompt('ko', 'empty'), {
    visible: true,
    text: '아직 이름이 없어 다른 사람에게 구분되지 않아요. 이 조직에서 보일 이름을 정해 주세요.',
  });
  assert.deepEqual(await prompt('en', 'empty'), {
    visible: true,
    text: 'You don’t have a name yet, so other people can’t identify you. Choose the name shown in this organization.',
  });
  assert.deepEqual(await prompt('ko', '1'), {
    visible: true,
    text: '지금은 이메일 앞부분(fixture)으로 보여요. 이 조직 사람들에게 보일 이름입니다.',
  });
  assert.deepEqual(await prompt('en', '1'), {
    visible: true,
    text: 'You appear as your email prefix (fixture). This is the name people in this organization see.',
  });
  console.log('PASS name prompt browser states');
} finally {
  await browser.close();
}
