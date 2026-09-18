// 폰 홈의 조직 전환 버튼 — 다른 공간 안 읽음 배지(99+)가 붙어도 버튼이 자리(orgwrap 내용 끝) 안에서 멈추고 이름만 말줄임된다(검수 #605).
// 결함: .msgr-org가 flex 항목 기본값 min-width:auto라 줄지 않아, 한글 9자 이름부터 프로필 알약과 겹치고 긴 이름은 배지·화살표가 화면 밖으로 나갔다.
// 서버: UF_TEST_PORT=5211 node node_modules/vite/bin/vite.js --config test/msgr-ui-feedback.config.mjs
// 실행: PLAYWRIGHT_MODULE=/절대경로/playwright/index.mjs node test/org-badge-phone.browser.mjs
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const PORT = process.env.UF_TEST_PORT || 5211;
const NAMES = ['조직', '가나다라마바사아자', '가나다라마바사아자차카타파하가나다라마바사아자'];
const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' });
const fails = []; let n = 0;
for (const width of [390, 360]) {
  const page = await browser.newPage({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true });
  await page.route('**/*', (rt) => new URL(rt.request().url()).hostname === '127.0.0.1' ? rt.continue() : rt.abort());
  await page.goto(`http://127.0.0.1:${PORT}/test/instant-delivery.fixture.html`);
  await page.waitForSelector('.msgr-phone.phone-home .msgr-side .msgr-org');
  for (const name of NAMES) {
    // 이름과 배지는 앱이 그리는 자리(이름 뒤·화살표 앞)에 넣는다 — 픽스처에는 다른 공간 안 읽음이 없다
    const m = await page.evaluate((name) => {
      const o = document.querySelector('.msgr-phone.phone-home .msgr-side .msgr-org');
      o.querySelector('.name').textContent = name;
      if (!o.querySelector('.msgr-badge')) { const s = document.createElement('span'); s.className = 'msgr-badge mark'; s.textContent = '99+'; o.querySelector('.name').after(s); }
      const w = o.closest('.msgr-orgwrap'); const W = w.getBoundingClientRect(); const R = o.getBoundingClientRect();
      const end = W.right - parseFloat(getComputedStyle(w).paddingRight);
      const b = o.querySelector('.msgr-badge').getBoundingClientRect(); const c = o.querySelector('.caret').getBoundingClientRect(); const nm = o.querySelector('.name');
      return { btnRight: R.right, end, badgeIn: b.width > 0 && b.right <= R.right + 0.5, caretIn: c.width > 0 && c.right <= innerWidth, shortFits: nm.scrollWidth <= nm.clientWidth };
    }, name);
    n++;
    const row = { width, name: name.length, btnRight: Math.round(m.btnRight), end: Math.round(m.end) };
    console.log(JSON.stringify(row));
    if (m.btnRight > m.end + 0.5) fails.push(`${width}/${name.length}자: 버튼 오른쪽 ${row.btnRight} > 자리 끝 ${row.end}`);
    if (!m.badgeIn || !m.caretIn) fails.push(`${width}/${name.length}자: 배지·화살표가 버튼·화면 밖`);
    if (name.length === 2 && !m.shortFits) fails.push(`${width}/짧은 이름이 말줄임됨`);
  }
  await page.close();
}
await browser.close();
if (fails.length) { console.error(`FAIL ${fails.length}\n${fails.join('\n')}`); process.exit(1); }
console.log(`PASS ${n}/${n}`);
