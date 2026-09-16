// 대화방에 사람·에이전트를 부르고, 에이전트 묶음을 접는다(유건 2026-09-16).
// 소스 핀만으로는 화면이 죽은 것을 못 잡는다(실측 2026-09-16: isPersonal 미전달로 개인 공간 전멸) — 실제 화면에서 눌러 본다.
// 실행: node node_modules/vite/bin/vite.js --config test/dminvite.config.mjs (포트 5202) 뒤
//       PLAYWRIGHT_MODULE=<playwright index.mjs> node test/dminvite.browser.mjs
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' });
const URL_BASE = `http://127.0.0.1:${process.env.DMINVITE_TEST_PORT || 5202}/test/dminvite.fixture.html`;
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
  } catch (e) { failures.push(`${width}/${name}: ${String(e.message).slice(0, 220)}`); } finally { await page.close(); }
}

const openDmSheet = async (p) => {
  await p.locator('.msgr-list').locator('button', { hasText: 'Org Colleague' }).first().click();
  await p.waitForTimeout(500);
  await p.locator('.msgr-top .title, .msgr-top button.title').first().click(); // 제목을 누르면 방 설정
  await p.locator('.msgr-crewsheet').waitFor({ timeout: 5000 });
};

// 1. 1:1 대화방에서도 '추가'가 열린다 — 종전에는 항목 자체가 없었다
await scenario(1280, 'dm-add-menu', async (p) => {
  await openDmSheet(p);
  await p.locator('.msgr-addwrap button', { hasText: '추가' }).first().click();
  const menu = await p.locator('.msgr-addmenu').innerText();
  assert.ok(menu.includes('사람 더 부르기'), `사람 초대 항목 (실제: ${menu})`);
  assert.ok(menu.includes('에이전트'), `에이전트 초대 항목 (실제: ${menu})`);
});

// 2. 사람을 고르면 지금 방에 끼워 넣지 않고 새 방을 연다
await scenario(1280, 'dm-widen-opens-new-room', async (p) => {
  await openDmSheet(p);
  await p.locator('.msgr-addwrap button', { hasText: '추가' }).first().click();
  await p.locator('.msgr-addmenu button', { hasText: '사람 더 부르기' }).click();
  await p.locator('.msgr-chips .msgr-chan', { hasText: 'Third Person' }).click();
  await p.waitForTimeout(800);
  const calls = await p.evaluate(() => window.__dmInviteFixture.calls);
  const created = calls.filter((c) => c.rpc === 'msgr_create_channel');
  assert.equal(created.length, 1, `새 방을 여는 호출 한 번 (실제: ${created.length})`);
  const pushed = calls.filter((c) => c.table === 'msgr_channel_members' && (c.op === 'upsert' || c.op === 'insert') && [].concat(c.values ?? []).some((v) => v.member_kind === 'user' && v.channel_id === 'org-dm'));
  assert.equal(pushed.length, 0, '옛 방에 사람을 밀어 넣지 않는다');
});

// 3. 에이전트 묶음은 접힌다
await scenario(1280, 'agent-groups-fold', async (p) => {
  const fold = p.locator('.msgr-fold').first();
  await fold.waitFor({ timeout: 5000 });
  assert.ok(await fold.evaluate((el) => el.open), '처음에는 펼쳐져 있다');
  const firstRow = fold.locator('.msgr-folder .item').first();
  assert.ok(await firstRow.isVisible(), '묶음 안의 에이전트가 보인다');
  await fold.locator('summary').click();
  await p.waitForTimeout(300);
  assert.equal(await fold.evaluate((el) => el.open), false, '머리를 누르면 접힌다');
  assert.equal(await firstRow.isVisible(), false, '접으면 목록이 사라진다');
  await p.reload({ waitUntil: 'load' });
  await p.waitForTimeout(900);
  assert.equal(await p.locator('.msgr-fold').first().evaluate((el) => el.open), false, '다시 열어도 접어 둔 대로 남는다');
});

// 4. PC에서도 '새 대화'로 시작할 수 있다 — 종전에는 폰에만 있었다
await scenario(1280, 'new-conversation-button', async (p) => {
  await p.locator('[aria-label="새 대화"]').first().click();
  await p.waitForTimeout(400);
  const sheet = await p.locator('.msgr-sheetwrap, .msgr-crewsheet').first().innerText();
  assert.ok(/사람|크루|고르/.test(sheet), `상대를 고르는 화면이 열린다 (실제: ${sheet.slice(0, 120)})`);
});

// 5. 폰 DM 탭 — 정렬과 '새 대화'가 나란히 눌린다(겹치거나 밀리지 않게)
await scenario(390, 'phone-dm-actions', async (p) => {
  await p.locator('nav button, [class*=tab] button').filter({ hasText: /^DM$/ }).first().click();
  await p.waitForTimeout(600);
  const btn = p.locator('[aria-label="새 대화"]').first();
  await btn.waitFor({ timeout: 5000 });
  const box = await btn.boundingBox();
  assert.ok(box && box.width >= 20 && box.x >= 0 && box.x + box.width <= 390, `버튼이 화면 안에 온전히 있다 (실제: ${JSON.stringify(box)})`);
  await btn.click();
  await p.waitForTimeout(400);
  assert.ok(await p.locator('.msgr-sheetwrap, .msgr-crewsheet').first().isVisible(), '눌러서 상대 고르는 화면이 열린다');
});

await browser.close();
console.log(results.join('\n'));
if (failures.length) { console.log(`${results.length} passed, ${failures.length} failed`); console.log('Failures:', failures); process.exit(1); }
console.log(`${results.length} passed, 0 failed`);
