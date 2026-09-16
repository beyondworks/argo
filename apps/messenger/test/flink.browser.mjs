// 친구 링크 — 링크를 만들어 복사하고, 받은 코드를 붙여 넣으면 친구가 된다(유건 2026-09-16).
// 실행: node node_modules/vite/bin/vite.js --config test/flink.config.mjs (포트 5202) 뒤 PLAYWRIGHT_MODULE=… node test/flink.browser.mjs
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' });
const URL_BASE = `http://127.0.0.1:${process.env.FLINK_TEST_PORT || 5202}/test/flink.fixture.html`;
const results = []; const failures = [];
async function scenario(name, run) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = []; page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 160)));
  try {
    await page.goto(URL_BASE, { waitUntil: 'load' });
    await page.waitForSelector('.msgr-rail, .msgr-shell', { timeout: 10_000 });
    await page.waitForTimeout(900);
    await page.locator('[aria-label="설정"]').first().click();
    // 설정의 탭은 role="tab"이 아니라 그냥 버튼이다 — 글자로 누른다(실측).
    await page.locator('.msgr-settings.tabs button', { hasText: /^친구$/ }).first().click();
    await page.locator('.msgr-friendlink').waitFor({ timeout: 5000 });
    await run(page);
    assert.deepEqual(errors, [], `페이지 오류 없음: ${errors.join(' | ')}`);
    results.push(`${name} PASS`);
  } catch (e) { failures.push(`${name}: ${String(e.message).slice(0, 200)}`); } finally { await page.close(); }
}

await scenario('link-create-and-copy', async (p) => {
  await p.locator('.msgr-friendlink button', { hasText: '링크 만들기' }).click();
  await p.locator('.msgr-friendlink .msgr-code').waitFor({ timeout: 5000 });
  const code = await p.locator('.msgr-friendlink .msgr-code').innerText();
  assert.match(code, /^[0-9a-f]{8}…$/, `코드 앞자리를 보여 준다(실제: ${code})`);
  assert.ok(await p.locator('.msgr-friendlink button', { hasText: '복사' }).isVisible(), '복사 버튼이 생긴다');
  assert.ok(await p.locator('.msgr-friendlink button', { hasText: '끊기' }).isVisible(), '끊기 버튼이 생긴다');
});

await scenario('accept-pasted-code', async (p) => {
  const code = 'b'.repeat(48);
  await p.locator('.msgr-friendlink input').fill(`아르고에서 친구로 추가해 주세요: ${code}`);
  await p.locator('.msgr-friendlink button', { hasText: '친구 추가' }).click();
  await p.waitForTimeout(600);
  const sent = await p.evaluate(() => window.__flinkFixture?.accepted);
  assert.equal(sent, code, '안내문에서 코드만 뽑아 보낸다');
});

await scenario('org-invite-wording-separate', async (p) => {
  const text = await p.locator('.msgr-friendlink').innerText();
  assert.ok(text.includes('내 친구 링크'), '친구 링크 자리가 따로 있다');
  assert.ok(!text.includes('조직'), '친구 링크 설명에 조직 이야기가 섞이지 않는다');
});

await browser.close();
console.log(results.join('\n'));
if (failures.length) { console.log(`${results.length} passed, ${failures.length} failed`); console.log('Failures:', failures); process.exit(1); }
console.log(`${results.length} passed, 0 failed`);
