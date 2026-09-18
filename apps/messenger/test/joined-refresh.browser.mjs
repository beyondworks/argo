// 내가 참여한 공개 채널이 새로고침 없이 사이드바에 뜬다(검수 재현 2026-09-18 — joinedRef를 로그인 때 한 번만 읽어 안 뜨던 것).
// (1) 초대 코드로 가입해 공개 채널에 들어간 경우 (2) 다른 사람이 나를 공개 채널에 넣은 경우 — 둘 다 18초(15초 재조회 + 여유) 안에.
// 서버: UF_TEST_PORT=5211 node node_modules/vite/bin/vite.js --config test/msgr-ui-feedback.config.mjs
// 실행: PLAYWRIGHT_MODULE=/절대경로/playwright/index.mjs node test/joined-refresh.browser.mjs
// 수정 전 비교: 서버를 UF_BASELINE_REF=<커밋>으로 띄우면 그 커밋의 App.jsx로 잰다.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const PORT = process.env.UF_TEST_PORT || 5211;
const JOIN_CODE = '0123456789abcdef'.repeat(3); // 픽스처(msgr-ui-feedback.supabase.mjs)와 같은 값
const LIMIT = 18_000;
const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' });
const results = {};

async function open() {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(15000);
  await page.route('**/*', (rt) => new URL(rt.request().url()).hostname === '127.0.0.1' ? rt.continue() : rt.abort());
  await page.addInitScript(() => localStorage.setItem('argo-lang', 'ko'));
  await page.goto(`http://127.0.0.1:${PORT}/test/instant-delivery.fixture.html`);
  await page.waitForFunction(() => !!window.__instant && [...document.querySelectorAll('.msgr-side *, aside *')].some((e) => e.children.length === 0 && e.textContent.trim() === 'Fixture General'));
  return page;
}
// 사이드바(참여 목록)에 이름이 뜨기까지 — 찾아보기·미리보기 목록은 세지 않는다
const inSidebar = (page, name) => page.evaluate((name) => [...document.querySelectorAll('.msgr-side button, .msgr-side a')].some((b) => b.textContent.trim() === name || b.textContent.trim().endsWith(name)), name);
async function waitSidebar(page, name) {
  const t0 = Date.now();
  while (Date.now() - t0 < LIMIT) { if (await inSidebar(page, name)) return Date.now() - t0; await page.waitForTimeout(250); }
  return null;
}

// (1) 초대 코드로 가입 → 공개 채널 Lounge
{
  const page = await open();
  results.beforeCode = await inSidebar(page, 'Lounge');
  await page.locator('button.msgr-org').click();
  await page.getByRole('menuitem', { name: /초대 코드로 가입/ }).click();
  await page.locator('.msgr-menu-pop input, .msgr-inline input').first().fill(JOIN_CODE);
  const t0 = Date.now();
  await page.getByRole('button', { name: /^가입$/ }).click();
  const ms = await waitSidebar(page, 'Lounge');
  results.code = { ms, sinceSubmit: Date.now() - t0 };
  await page.close();
}
// (2) 다른 사람이 나를 공개 채널 Lounge Two에 넣음(앱을 거치지 않는 서버 쪽 변경)
{
  const page = await open();
  results.beforeAdded = await inSidebar(page, 'Lounge Two');
  await page.evaluate(() => window.__instant.addMember('lounge2'));
  results.added = { ms: await waitSidebar(page, 'Lounge Two') };
  await page.close();
}
await browser.close();
console.log(JSON.stringify(results));
const ok = results.beforeCode === false && results.beforeAdded === false && results.code.ms !== null && results.added.ms !== null;
console.log(ok ? `PASS code=${results.code.ms}ms added=${results.added.ms}ms` : 'FAIL');
process.exit(ok ? 0 : 1);
