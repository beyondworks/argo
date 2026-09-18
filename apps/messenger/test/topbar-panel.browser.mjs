// 상단 바가 두 줄로 접혀도 우측 패널·크루 시트가 상단 바를 덮지 않는다(검수 #603 MEDIUM) + 패널 아래 입력창·전송 버튼도 안 가린다(#600).
// 서버: UF_TEST_PORT=5211 node node_modules/vite/bin/vite.js --config test/msgr-ui-feedback.config.mjs
// 실행: PLAYWRIGHT_MODULE=/절대경로/playwright/index.mjs node test/topbar-panel.browser.mjs
// 수정 전 비교: 서버를 UF_BASELINE_REF=<커밋>으로 띄우면 그 커밋의 App.jsx로 잰다(상단 바 높이 관찰이 없으면 패널이 72px에 고정).
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const PORT = process.env.UF_TEST_PORT || 5211;
const CHANNELS = ['디자인 비공개', '2026 하반기 제품 출시 준비와 파트너 협업 채널'];
const WIDTHS = [1312, 1100, 900, 820];
const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' });
const fails = []; const rows = [];

// 페이지 안에서: 패널과 상단 바의 보이는 요소들, 입력창·전송 버튼의 교차를 요소 단위로 센다.
const inspect = () => {
  const r = (e) => e.getBoundingClientRect();
  const hit = (a, b) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
  const shown = (e) => { const b = r(e); return b.width > 0 && b.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
  const panel = document.querySelector('.msgr-sheetwrap > .msgr-crewsheet'); const P = r(panel);
  const top = document.querySelector('.msgr-main > .msgr-top');
  const topEls = [...top.querySelectorAll('button, [role=tab], .msgr-scope-badge, .topic')].filter(shown);
  const topHits = topEls.filter((e) => hit(r(e), P)).map((e) => (e.getAttribute('aria-label') || e.textContent || e.className).trim().slice(0, 24));
  const comp = document.querySelector('.msgr-composer'); const send = comp?.querySelector('button.send');
  return { topH: Math.round(r(top).height), panelTop: Math.round(P.top), topBottom: Math.round(r(top).bottom), topEls: topEls.length, topHits,
    composerHit: comp ? hit(r(comp), P) : null, sendHit: send ? hit(r(send), P) : null,
    overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth };
};

async function openByText(page, text) {
  await page.evaluate((text) => { const leaf = [...document.querySelectorAll('*')].find((e) => e.children.length === 0 && e.textContent.trim() === text && e.closest('button, a, [role=button]')); leaf.closest('button, a, [role=button]').click(); }, text);
}

for (const lang of ['ko', 'en']) for (const theme of ['linen-light', 'linen-dark']) for (const width of WIDTHS) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  page.setDefaultTimeout(15000);
  await page.route('**/*', (rt) => new URL(rt.request().url()).hostname === '127.0.0.1' ? rt.continue() : rt.abort());
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(([l, th]) => { localStorage.setItem('argo-lang', l); localStorage.setItem('argo-theme', th); }, [lang, theme]);
  await page.goto(`http://127.0.0.1:${PORT}/test/instant-delivery.fixture.html`);
  await page.waitForFunction((n) => [...document.querySelectorAll('*')].some((e) => e.children.length === 0 && e.textContent.trim() === n), CHANNELS[0]);
  for (const ch of CHANNELS) {
    if (process.env.UF_DEBUG) console.error('open', lang, theme, width, ch);
    await openByText(page, ch);
    await page.waitForFunction((n) => document.querySelector('.msgr-main > .msgr-top .title')?.textContent.includes(n.slice(0, 8)), ch);
    for (const kind of ['channel', 'crew']) {
      if (process.env.UF_DEBUG) console.error(' sheet', kind);
      if (kind === 'channel') await page.locator('.msgr-main > .msgr-top button.members').click();
      else await openByText(page, '카맥');
      await page.locator('.msgr-sheetwrap > .msgr-crewsheet').waitFor();
      await page.waitForTimeout(150);
      const m = await page.evaluate(inspect);
      const row = { lang, theme: theme.replace('linen-', ''), width, ch: ch.slice(0, 8), kind, ...m };
      rows.push(row);
      if (m.topHits.length || m.sendHit || m.overflowX > 0 || m.panelTop < m.topBottom) fails.push(row);
      if (kind === 'channel' && width <= 900 && ch === CHANNELS[1]) await page.screenshot({ path: new URL(`../artifacts/topbar-panel-${lang}-${theme}-${width}.png`, import.meta.url).pathname }).catch(() => {});
      await page.keyboard.press('Escape');
      await page.evaluate(() => document.querySelector('.msgr-crewsheet .head button[aria-label]')?.click());
      await page.waitForFunction(() => !document.querySelector('.msgr-sheetwrap > .msgr-crewsheet'));
    }
  }
  await page.close();
}
await browser.close();
for (const r of rows) console.log(JSON.stringify({ l: r.lang, t: r.theme, w: r.width, ch: r.ch, k: r.kind, topH: r.topH, panelTop: r.panelTop, topBottom: r.topBottom, els: r.topEls, hits: r.topHits, send: r.sendHit, comp: r.composerHit, ovX: r.overflowX }));
console.log(fails.length ? `FAIL ${fails.length}/${rows.length}` : `PASS ${rows.length}/${rows.length}`);
process.exit(fails.length ? 1 : 0);
