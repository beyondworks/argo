// 폰 반응 시트(이모지 격자)가 칸마다 옆으로 넘치지 않는지, 누르는 영역이 44px 아래로 줄지 않는지를 실제 레이아웃으로 잰다(H73, 2026-10-08 발행본 점검).
// 원인: 격자 칸 최소 폭 40px(.msgr-emojipop.phone .grid)이 단추 최소 폭 44px(.argo-messenger :is(… .msgr-emojipop .grid button …))보다 작아
//       390 폭에서 칸 42.5px 안에 단추 44px가 들어가 칸마다 1.5px씩 넘쳤다(오른쪽 끝 단추는 시트 밖으로, 이웃 단추와는 겹침).
// 서버: UF_TEST_PORT=5231 node node_modules/vite/bin/vite.js --config test/msgr-ui-feedback.config.mjs --port 5231 --strictPort
// 실행: PLAYWRIGHT_MODULE=/절대경로/playwright/index.mjs node test/emoji-sheet-phone.browser.mjs
// measureEmojiSheet·verifyEmojiSheet는 바깥 변수를 쓰지 않는다 — 다른 브라우저(ego 등)에서 page.evaluate로 그대로 불러 써도 같은 값이 나온다.
export const FIXTURE_PATH = '/test/instant-delivery.fixture.html?gap=1&mix=1';
export const TOUCH = 44; // 최소 누름 크기(styles.css 44px 목록과 같다)

/** 열린 폰 반응 시트의 격자를 잰다. 시트가 없으면 null. 칸(grid track)과 단추를 같은 순서로 맞춰 칸 밖으로 나간 양을 구한다. */
export function measureEmojiSheet() {
  const pop = document.querySelector('.msgr-emojipop.phone');
  if (!pop) return null;
  const r2 = (x) => Math.round(x * 100) / 100;
  const body = pop.querySelector('.body');
  const popRect = pop.getBoundingClientRect();
  let cellOverflow = 0; let minW = Infinity; let minH = Infinity; let gridScroll = 0; let outsideSheet = 0; let buttons = 0; let overlap = 0;
  const cols = [];
  for (const g of pop.querySelectorAll('.grid')) {
    const tracks = getComputedStyle(g).gridTemplateColumns.split(' ').map(parseFloat).filter((x) => x > 0);
    if (!tracks.length) continue;
    cols.push(tracks.length);
    gridScroll = Math.max(gridScroll, g.scrollWidth - g.clientWidth);
    const btns = [...g.querySelectorAll('button')];
    btns.forEach((b, i) => {
      const r = b.getBoundingClientRect(); const trackW = tracks[i % tracks.length];
      cellOverflow = Math.max(cellOverflow, r.width - trackW);
      minW = Math.min(minW, r.width); minH = Math.min(minH, r.height); buttons++;
      outsideSheet = Math.max(outsideSheet, r.right - popRect.right);
      const next = btns[i + 1];
      if (next && (i + 1) % tracks.length !== 0) overlap = Math.max(overlap, r.right - next.getBoundingClientRect().left);
    });
  }
  return {
    viewport: document.documentElement.clientWidth,
    bodyScroll: body.scrollWidth, bodyClient: body.clientWidth, gridScroll,
    columns: [...new Set(cols)], buttons,
    cellOverflow: r2(cellOverflow), neighborOverlap: r2(overlap), outsideSheet: r2(outsideSheet),
    minButtonW: r2(minW), minButtonH: r2(minH),
  };
}

/** measureEmojiSheet 결과 판정 — 실패 문장 목록(빈 배열 = 통과). */
export function verifyEmojiSheet(m) {
  const fails = [];
  const check = (name, ok, detail) => { if (!ok) fails.push(`${name}: ${JSON.stringify(detail)}`); };
  if (!m) return ['반응 시트가 열려 있지 않다'];
  check('시트 본문이 가로로 넘치지 않는다(scrollWidth ≤ clientWidth)', m.bodyScroll <= m.bodyClient, [m.bodyScroll, m.bodyClient]);
  check('격자도 가로로 넘치지 않는다', m.gridScroll <= 0, m.gridScroll);
  check('단추가 자기 칸을 넘지 않는다', m.cellOverflow <= 0.01, m.cellOverflow);
  check('이웃 단추와 겹치지 않는다', m.neighborOverlap <= 0.01, m.neighborOverlap);
  check('시트 오른쪽 밖으로 나가지 않는다', m.outsideSheet <= 0.01, m.outsideSheet);
  check(`누르는 영역 ${TOUCH}px 이상(가로·세로)`, m.minButtonW >= TOUCH - 0.01 && m.minButtonH >= TOUCH - 0.01, [m.minButtonW, m.minButtonH]);
  return fails;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
  const PORT = process.env.UF_TEST_PORT || 5231;
  const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' });
  const fails = [];
  for (const [w, h, theme] of [[390, 844, 'graphite-light'], [390, 844, 'graphite-dark'], [360, 780, 'graphite-light'], [320, 640, 'graphite-light'], [720, 900, 'graphite-light']]) {
    const tag = `${w}-${theme}`;
    const page = await browser.newPage({ viewport: { width: w, height: h }, hasTouch: true });
    await page.route('**/*', (rt) => (new URL(rt.request().url()).hostname === '127.0.0.1' ? rt.continue() : rt.abort()));
    await page.addInitScript((th) => { localStorage.setItem('argo-lang', 'ko'); localStorage.setItem('argo-theme', th); localStorage.setItem('argo-msgr-last-org', 'org-fixture'); localStorage.setItem('argo-msgr-last-ch', JSON.stringify({ 'org-fixture': 'general' })); }, theme);
    await page.goto(`http://127.0.0.1:${PORT}${FIXTURE_PATH}`);
    await page.locator('.item', { hasText: 'Fixture General' }).first().click(); // 폰은 목록에서 시작한다
    await page.locator('.msgr-spine').getByText('A안으로 가죠').first().waitFor();
    await page.evaluate(() => document.getAnimations().forEach((a) => { try { a.finish(); } catch { /* 끝없는 애니메이션은 끝낼 수 없다 */ } }));
    await page.click('.msgr-spine > [data-mid="118"] .msgr-turnacts [data-act="react"]');
    await page.waitForSelector('.msgr-emojipop.phone');
    await page.evaluate(() => document.getAnimations().forEach((a) => { try { a.finish(); } catch { /* 끝없는 애니메이션은 끝낼 수 없다 */ } }));
    fails.push(...verifyEmojiSheet(await page.evaluate(measureEmojiSheet)).map((f) => `${tag} ${f}`));
    await page.close();
  }
  await browser.close();
  if (fails.length) { console.error(fails.join('\n')); process.exit(1); }
  console.log('emoji-sheet-phone ok');
}
