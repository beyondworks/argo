// 개인 공간 표지·순서·조직 메뉴 닫기(유건 2026-09-18 0.1.29 피드백 1·2).
// ① 조직 선택기가 개인일 때 사람 아이콘 + "개인 공간"(색만이 아니라 아이콘·라벨로 구분), 메뉴의 개인 행도 같은 표지.
// ② 데스크톱 개인 공간 사이드바는 채팅 → 친구 순서. 폰 홈은 친구만(채팅은 탭) — 그대로.
// ③ 조직 메뉴는 바깥(본문) 클릭·Esc로 닫힌다. 결함: 사이드바(.side)가 sticky라 쌓임 맥락을 만들어 안의 투명 스크림이 본문 아래에 깔렸다.
// 서버: PS_TEST_PORT=5199 node node_modules/vite/bin/vite.js --config test/personal-space.config.mjs
// 실행: PLAYWRIGHT_MODULE=/절대경로/playwright/index.mjs node test/personal-space-mark.browser.mjs
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const PORT = process.env.PS_TEST_PORT || 5199;
const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' });
const fails = []; let n = 0;
const check = (label, ok, got) => { n++; if (!ok) fails.push(`${label}: ${JSON.stringify(got)}`); };

for (const [lang, theme, width, phone] of [['ko', 'linen-light', 1312, false], ['en', 'linen-dark', 1312, false], ['ko', 'linen-light', 390, true]]) {
  const tag = `${lang}/${theme}/${width}`;
  const p = await browser.newPage({ viewport: { width, height: phone ? 844 : 820 }, isMobile: phone, hasTouch: phone });
  p.setDefaultTimeout(10000);
  await p.route('**/*', (rt) => new URL(rt.request().url()).hostname === '127.0.0.1' ? rt.continue() : rt.abort());
  await p.addInitScript(([l, th]) => { localStorage.setItem('argo-lang', l); localStorage.setItem('argo-theme', th); }, [lang, theme]);
  await p.goto(`http://127.0.0.1:${PORT}/test/personal-space.fixture.html`);
  await p.locator('.msgr-org').waitFor();
  const personalLabel = lang === 'ko' ? '개인 공간' : 'Personal space';
  // 조직에 있을 때 — 선택기는 조직 아바타, 메뉴의 개인 행은 사람 표지 + "개인 공간"
  check(`${tag} 조직일 때 선택기에 개인 표지 없음`, await p.locator('.msgr-org .msgr-av.personal').count() === 0);
  await p.click('.msgr-org'); await p.locator('.msgr-menu-pop').waitFor();
  const row = p.locator('[role=menuitemradio]').first();
  check(`${tag} 메뉴 개인 행 = 사람 아이콘 + 라벨`, await row.locator('.msgr-av.personal svg').count() === 1 && (await row.locator('.label').textContent()) === personalLabel, await row.textContent());
  await row.click(); await p.waitForTimeout(500);
  // 개인 공간 — 선택기 표지·라벨
  check(`${tag} 선택기 = 사람 아이콘`, await p.locator('.msgr-org.personal .msgr-av.personal svg').count() === 1);
  check(`${tag} 선택기 라벨`, (await p.locator('.msgr-org .name').textContent()) === personalLabel, await p.locator('.msgr-org .name').textContent());
  // 순서
  const order = await p.evaluate(() => [...document.querySelectorAll('.msgr-side [data-sec]')].map((s) => s.getAttribute('data-sec')).filter((x) => x === 'dms' || x === 'friends'));
  check(`${tag} 사이드바 순서`, JSON.stringify(order) === JSON.stringify(phone ? ['friends'] : ['dms', 'friends']), order);
  // 메뉴 닫기 — 바깥(본문) 클릭, Esc
  if (!phone) {
    await p.click('.msgr-org'); await p.locator('.msgr-menu-pop').waitFor();
    const at = { x: width - 80, y: 420 };
    check(`${tag} 본문 자리의 맨 위 요소가 스크림`, await p.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.classList.contains('msgr-scrim'), at));
    await p.mouse.click(at.x, at.y); await p.waitForTimeout(250);
    check(`${tag} 본문 클릭으로 닫힘`, await p.locator('.msgr-menu-pop').count() === 0);
  }
  await p.click('.msgr-org'); await p.locator('.msgr-menu-pop').waitFor();
  await p.keyboard.press('Escape'); await p.waitForTimeout(200);
  check(`${tag} Esc로 닫힘`, await p.locator('.msgr-menu-pop').count() === 0);
  await p.close();
}
await browser.close();
if (fails.length) { console.error(`FAIL ${fails.length}/${n}\n${fails.join('\n')}`); process.exit(1); }
console.log(`PASS ${n}/${n}`);
