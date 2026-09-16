// 조직에 들어왔다고 채널이 저절로 열리지 않는다(유건 2026-09-16, 슬랙식) — 사이드바는 참여한 채널만, 찾아보기로 들어간다.
// 실행: node node_modules/vite/bin/vite.js --config test/join.config.mjs (포트 5201) 뒤
//       PLAYWRIGHT_MODULE=<playwright index.mjs> node test/join.browser.mjs
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' });
const URL_BASE = `http://127.0.0.1:${process.env.JOIN_TEST_PORT || 5201}/test/join.fixture.html`;
const results = []; const failures = [];

async function scenario(width, name, run) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 160)));
  try {
    await page.goto(URL_BASE, { waitUntil: 'load' });
    await page.waitForSelector('.msgr-rail, .msgr-shell', { timeout: 10_000 });
    await page.waitForTimeout(900);
    await run(page);
    assert.deepEqual(errors, [], `페이지 오류 없음: ${errors.join(' | ')}`);
    results.push(`${width} ${name} PASS`);
  } catch (e) { failures.push(`${width}/${name}: ${String(e.message).slice(0, 200)}`); } finally { await page.close(); }
}

const railText = (p) => p.locator('.msgr-rail, aside').first().innerText();

// 1. 참여하지 않은 공개 채널은 사이드바에 없다
await scenario(1280, 'unjoined-hidden', async (p) => {
  const rail = await railText(p);
  assert.ok(rail.includes('Fixture General'), '참여한 채널은 보인다');
  assert.ok(!rail.includes('Open Lounge'), '참여하지 않은 공개 채널은 목록에 없다(종전에는 조직원이면 전부 떴다)');
});

// 2. 찾아보기에서 참여하면 사이드바에 들어온다
await scenario(1280, 'browse-and-join', async (p) => {
  await p.locator('[aria-label="채널 찾아보기"]').first().click();
  await p.locator('.msgr-browse').waitFor({ timeout: 5000 });
  const list = await p.locator('.msgr-browse').innerText();
  assert.ok(list.includes('Open Lounge'), '안 들어간 공개 채널이 후보로 뜬다');
  assert.ok(!list.includes('Fixture General'), '이미 참여한 채널은 후보에 없다');
  await p.locator('.msgr-browse .row', { hasText: 'Open Lounge' }).locator('button').click();
  await p.waitForTimeout(800);
  assert.ok((await railText(p)).includes('Open Lounge'), '참여하면 사이드바에 들어온다');
});

// 3. 새 채널 기본은 비공개
await scenario(1280, 'new-channel-private-default', async (p) => {
  await p.locator('[aria-label="새 채널"]').first().click();
  await p.waitForTimeout(400);
  const checked = await p.locator('[role="radio"][aria-checked="true"]').first().innerText();
  assert.match(checked, /비공개/, `새 채널 기본이 비공개다(실제: ${checked})`);
});

await browser.close();
console.log(results.join('\n'));
if (failures.length) { console.log(`${results.length} passed, ${failures.length} failed`); console.log('Failures:', failures); process.exit(1); }
console.log(`${results.length} passed, 0 failed`);
