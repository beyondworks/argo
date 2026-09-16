// 유건 제보 3건(2026-09-16) 행동 테스트 — 이미지 확대 · 다른 멤버 에이전트 숨김 · 배너 알림 본문.
// 실행: node node_modules/vite/bin/vite.js --config test/ux3.config.mjs (포트 5200) 뒤
//       PLAYWRIGHT_MODULE=<playwright index.mjs> node test/ux3.browser.mjs
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' });
const URL_BASE = `http://127.0.0.1:${process.env.UX3_TEST_PORT || 5200}/test/ux3.fixture.html`;
const results = []; const failures = [];

async function scenario(width, name, run) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 160)));
  try {
    await page.addInitScript(() => { // 배너 알림 가로채기 — 실제 OS 알림 대신 기록만 한다
      window.__notes = [];
      class FakeNotification { constructor(title, opts) { window.__notes.push({ title, body: opts?.body ?? '' }); } close() {} }
      FakeNotification.permission = 'granted';
      FakeNotification.requestPermission = async () => 'granted';
      Object.defineProperty(window, 'Notification', { value: FakeNotification, configurable: true });
      Object.defineProperty(document, 'hasFocus', { value: () => false, configurable: true }); // 앱이 뒤에 있을 때만 OS 알림이 나간다
    });
    await page.goto(URL_BASE, { waitUntil: 'load' });
    await page.waitForSelector('.msgr-rail, .msgr-shell', { timeout: 10_000 });
    await page.waitForTimeout(900);
    await run(page);
    assert.deepEqual(errors, [], `페이지 오류 없음: ${errors.join(' | ')}`);
    results.push(`${width} ${name} PASS`);
  } catch (e) {
    failures.push(`${width}/${name}: ${String(e.message).slice(0, 200)}`);
  } finally { await page.close(); }
}

// 1. 다른 멤버의 에이전트는 레일에 없다(내 것·외부는 남는다)
await scenario(1280, 'hide-other-member-agents', async (p) => {
  const rail = await p.locator('.msgr-rail, aside').first().innerText();
  assert.ok(rail.includes('Fixture Agent'), '내 에이전트는 보인다');
  assert.ok(rail.includes('External Bot'), '외부 에이전트는 보인다');
  assert.ok(!rail.includes('Colleague Agent'), '다른 멤버의 에이전트는 보이지 않는다');
  assert.ok(!/다른 멤버의 크루|Other members/.test(rail), '그 묶음 제목도 사라진다');
});

// 2. 이미지를 누르면 그 자리에서 확대되고 Esc로 닫힌다
await scenario(1280, 'image-lightbox', async (p) => {
  await p.locator('.msgr-imgprev').first().waitFor({ timeout: 8000 });
  assert.equal(await p.locator('.msgr-lightbox').count(), 0, '처음에는 확대가 없다');
  await p.locator('.msgr-imgprev').first().click();
  await p.locator('.msgr-lightbox img').waitFor({ timeout: 5000 });
  // 스텁 이미지는 1×1이라 크기 비교로는 확대를 못 본다 — 덮개가 화면을 덮는지로 판정한다.
  const over = await p.locator('.msgr-lightbox').boundingBox();
  const view = p.viewportSize();
  assert.ok(over.width >= view.width * 0.9 && over.height >= view.height * 0.9, `덮개가 화면을 덮는다(${Math.round(over.width)}×${Math.round(over.height)})`);
  assert.equal(await p.locator('.msgr-lightbox .acts button').count(), 2, '원본 열기·닫기 버튼이 있다');
  await p.keyboard.press('Escape');
  await p.waitForTimeout(200);
  assert.equal(await p.locator('.msgr-lightbox').count(), 0, 'Esc로 닫힌다');
  await p.locator('.msgr-imgprev').first().click();
  await p.locator('.msgr-lightbox').waitFor({ timeout: 5000 });
  await p.locator('.msgr-lightbox').click({ position: { x: 5, y: 5 } }); // 바깥을 눌러도 닫힌다
  await p.waitForTimeout(200);
  assert.equal(await p.locator('.msgr-lightbox').count(), 0, '바깥을 눌러도 닫힌다');
});

// 3. 배너 알림에 본문이 실린다 — 방송에는 본문이 없으니 앱이 그 글을 읽어 채운다
await scenario(1280, 'notification-body', async (p) => {
  await p.evaluate(() => window.__ux3Broadcast('message', { id: 11, channel_id: 'general', author_kind: 'user', author_user_id: 'user-colleague', crew_id: null, kind: 'text', mentions: [], reply_to: null }));
  await p.waitForFunction(() => (window.__notes ?? []).length > 0, null, { timeout: 8000 });
  await p.waitForTimeout(400); // 본문 보충(조회) 뒤 한 번 더 확인
  const notes = await p.evaluate(() => window.__notes);
  const last = notes[notes.length - 1];
  assert.ok(last.title, '제목이 있다');
  assert.equal(last.body, '스크린샷 붙입니다', '본문이 실린다(종전에는 방송에 본문이 없어 늘 비었다)');
});

await browser.close();
console.log(results.join('\n'));
if (failures.length) { console.log(`${results.length} passed, ${failures.length} failed`); console.log('Failures:', failures); process.exit(1); }
console.log(`${results.length} passed, 0 failed`);
