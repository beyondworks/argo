// 방을 옮길 때 dm:<채널> 구독이 쌓이지 않는다(검수 #607 MEDIUM).
// 결함: 구독 효과가 await setAuth 뒤에 채널을 만들어, 방을 빠르게 옮기면 정리(remove)가 채널을 모른 채 먼저 끝나 고아 dm: 구독이 남았다.
// 측정: 가짜 백엔드의 setAuth를 늦춰(authDelay) 그 경쟁을 만들고, 옮긴 뒤 살아 있는 채널(getChannels)의 dm: 토픽을 센다.
// 서버: UF_TEST_PORT=5211 node node_modules/vite/bin/vite.js --config test/msgr-ui-feedback.config.mjs
// 실행: PLAYWRIGHT_MODULE=/절대경로/playwright/index.mjs node test/room-topic-leak.browser.mjs
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const PORT = process.env.UF_TEST_PORT || 5211;
const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' });
const fails = [];
const page = await browser.newPage({ viewport: { width: 1312, height: 900 } });
page.setDefaultTimeout(15000);
await page.route('**/*', (rt) => new URL(rt.request().url()).hostname === '127.0.0.1' ? rt.continue() : rt.abort());
await page.addInitScript(() => { localStorage.setItem('argo-lang', 'ko'); });
await page.goto(`http://127.0.0.1:${PORT}/test/instant-delivery.fixture.html`);
await page.waitForFunction(() => [...document.querySelectorAll('*')].some((e) => e.children.length === 0 && e.textContent.trim() === '디자인 비공개'));

const open = (text) => page.evaluate((text) => {
  const leaf = [...document.querySelectorAll('.msgr-side *')].find((e) => e.children.length === 0 && e.textContent.trim() === text && e.closest('button, a, [role=button]'));
  leaf.closest('button, a, [role=button]').click();
}, text);
const dmTopics = () => page.evaluate(() => window.__instant.live && [...window.__instant.live].map((c) => c.__topic).filter((t) => t.startsWith('dm:')));
const settle = () => page.waitForTimeout(1200);
const check = async (label, want) => {
  const got = await dmTopics();
  console.log(JSON.stringify({ label, dm: got }));
  if (JSON.stringify(got) !== JSON.stringify(want)) fails.push(`${label}: dm: 구독 ${JSON.stringify(got)} ≠ 기대 ${JSON.stringify(want)}`);
};

await page.evaluate(() => { window.__instant.authDelay = 400; }); // 정리가 setAuth보다 먼저 끝나는 경쟁을 만든다
// 1) 천천히: 비공개 방 → 공개 방 → 비공개 방. 비공개 방에서는 그 방의 dm: 하나, 공개 방에서는 0.
await open('디자인 비공개'); await settle(); await check('비공개 방(priv)', ['dm:priv']);
await open('Fixture General'); await settle(); await check('공개 방(general)', []);
await open('2026 하반기 제품 출시 준비와 파트너 협업 채널'); await settle(); await check('비공개 방(long)', ['dm:long']);
// 2) 빠르게: setAuth(400ms)가 끝나기 전에 방을 계속 옮긴다 — 마지막 방의 dm: 하나만 남아야 한다.
for (let round = 1; round <= 3; round++) {
  for (const name of ['디자인 비공개', 'Fixture General', '2026 하반기 제품 출시 준비와 파트너 협업 채널', '디자인 비공개']) { await open(name); await page.waitForTimeout(60); }
  await settle(); await check(`빠른 전환 ${round}회 뒤(priv)`, ['dm:priv']);
}
await browser.close();
if (fails.length) { console.error(`FAIL ${fails.length}\n${fails.join('\n')}`); process.exit(1); }
console.log('PASS');
