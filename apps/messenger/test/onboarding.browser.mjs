// 조직 시작 단계(D1·D3·D4·D6, #626) 행동 테스트 — 새 채널 기본값, 공개 채널 만든 사람 참여, 남은 단계 카드, DM엔 카드 없음, 멤버 사이드바, 초대 참여 입력칸.
// 서버: node node_modules/vite/bin/vite.js --config test/msgr-ui-feedback.config.mjs --port 5211 --strictPort
// 실행: PLAYWRIGHT_MODULE=/절대경로/playwright/index.mjs node test/onboarding.browser.mjs
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const PORT = process.env.UF_TEST_PORT || 5211;
const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const out = {}; const fails = [];
const check = (name, ok, detail) => { out[name] = ok ? true : detail ?? false; if (!ok) fails.push(name); };
async function open(q = '') {
  const page = await ctx.newPage();
  page.setDefaultTimeout(8000);
  await page.route('**/*', (rt) => new URL(rt.request().url()).hostname === '127.0.0.1' ? rt.continue() : rt.abort());
  await page.addInitScript(() => { localStorage.setItem('argo-lang', 'ko'); for (const k of Object.keys(localStorage)) if (k.startsWith('argo-onboard-hide')) localStorage.removeItem(k); });
  await page.goto(`http://127.0.0.1:${PORT}/test/instant-delivery.fixture.html${q}`);
  await page.waitForFunction(() => !!window.__instant && document.querySelector('button.msgr-org'));
  return page;
}
const formKind = (page) => page.evaluate(() => [...document.querySelectorAll('form.msgr-inline [role="radio"]')].find((b) => b.getAttribute('aria-checked') === 'true')?.textContent);
const sideItems = (page) => page.evaluate(() => [...document.querySelectorAll('.msgr-side .msgr-list .item')].map((b) => b.textContent.trim()));

// (1) 막 만든 조직: 기본 공개 → 만든 사람 참여(서버는 공개 채널에 참여 행을 안 넣는다) → 남은 단계 카드 → 둘째 채널 기본 비공개 → 다시 불러와도 참여
{
  const page = await open('?empty=1');
  await page.locator('.msgr-empty .msgr-step').first().waitFor();
  check('empty.step1Public', (await page.locator('.msgr-empty .msgr-step').first().innerText()).includes('새 채널은 공개로 시작해요'));
  await page.locator('.msgr-empty .msgr-step .btn-primary').first().click();
  check('form.defaultPublic', (await formKind(page)) === '공개', await formKind(page));
  await page.locator('form.msgr-inline input').fill('general');
  await page.locator('form.msgr-inline button[type="submit"]').click();
  await page.locator('.msgr-onboard').waitFor();
  const st = await page.evaluate(() => { const T = window.__instant.tables; const ch = T.msgr_channels.find((c) => c.name === 'general');
    return { kind: ch.kind, rows: T.msgr_channel_members.filter((m) => m.channel_id === ch.id && m.member_kind === 'user' && m.member_id === 'user-me').length,
      head: document.querySelector('.msgr-top').innerText, composer: !!document.querySelector('.msgr-composer textarea'), joinBtn: [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === '참여') }; });
  check('create.creatorJoined', st.kind === 'public' && st.rows === 1, st);
  check('create.headOnePerson', /1명/.test(st.head) && st.composer && !st.joinBtn, st);
  const marks = await page.evaluate(() => [...document.querySelectorAll('.msgr-onboard .msgr-step .num')].map((n) => n.className.replace('num', '').trim()));
  check('card.remaining', JSON.stringify(marks) === JSON.stringify(['done', 'mark', '']), marks);
  await page.locator('.msgr-side button[aria-label="새 채널"]').first().click();
  check('form.secondPrivate', (await formKind(page)) === '비공개', await formKind(page));
  await page.locator('form.msgr-inline button[type="button"].btn.sm').click();
  // 다시 불러오기(개인 공간 → 조직) — 조직 데이터를 표에서 새로 읽는다(새로고침과 같은 경로)
  await page.locator('button.msgr-org').click(); await page.getByRole('menuitemradio', { name: '개인 공간' }).click();
  await page.locator('button.msgr-org').click(); await page.getByRole('menuitemradio', { name: /Fixture Organization/ }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('.msgr-side .msgr-list .item')].some((b) => b.textContent.trim() === 'general'), undefined, { timeout: 3000 }).catch(() => {});
  check('reload.sidebarJoined', (await sideItems(page)).includes('general'), await sideItems(page));
  await page.locator('.msgr-onboard header button').click({ timeout: 3000 }).catch(() => {});
  check('card.hideRemembered', !(await page.locator('.msgr-onboard').count()) && await page.evaluate(() => Object.keys(localStorage).some((k) => k.startsWith('argo-onboard-hide') && localStorage.getItem(k) === '1')));
  await page.close();
}

// (2) DM 스레드에는 카드가 없고, 조직 채널에는 있다(에이전트 0이라 카드가 뜨는 조건)
{
  const page = await open('?nocrews=1');
  await page.locator('.msgr-onboard').waitFor();
  await page.locator('.msgr-side .msgr-list button', { hasText: 'crystal' }).first().click();
  await page.waitForFunction(() => document.querySelector('.msgr-top .title')?.textContent === 'crystal' && !document.querySelector('.msgr-skel')); // 글을 받은 뒤(카드는 그 뒤에 그려진다)
  await page.waitForTimeout(300);
  check('dm.noCard', !(await page.locator('.msgr-onboard').count()));
  await page.close();
}

// (3) 멤버·참여 채널 0·공개 채널 있음: 사이드바가 본문과 같은 말 + 둘러보기
{
  const page = await open('?role=member&nochannels=1');
  await page.locator('.msgr-side .msgr-hint button').waitFor({ timeout: 4000 }).catch(() => {}); // 공개 채널 목록이 온 뒤의 문구를 본다
  const hint = (await page.locator('.msgr-side .msgr-hint').allInnerTexts()).join(' / ');
  check('member.sidebarHint', hint.includes('아직 참여한 채널이 없어요') && hint.includes('공개 채널 둘러보기') && !hint.includes('첫 채널을 만드세요'), hint);
  await page.close();
}

// (4) 조직 없음: 안내가 실제 메뉴 이름을 말하고, 버튼이 그 입력칸을 열어 초점을 준다(D4)
{
  const page = await open('?noorg=1');
  await page.locator('.msgr-empty .msgr-step').nth(1).waitFor();
  check('noorg.menuName', (await page.locator('.msgr-empty .msgr-step').nth(1).innerText()).includes("'초대 링크·코드로 참여'"));
  await page.locator('.msgr-empty .msgr-step').nth(1).locator('button').click();
  check('noorg.joinInputFocused', await page.evaluate(() => document.activeElement === document.querySelector('.msgr-menu-pop form.msgr-inline input')));
  await page.close();
}

await browser.close();
console.log(JSON.stringify(out));
console.log(fails.length ? `FAIL ${fails.join(', ')}` : 'PASS');
process.exit(fails.length ? 1 : 0);
