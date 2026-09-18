// 서버: node node_modules/vite/bin/vite.js --config test/instant-delivery.config.mjs
// 실행: PLAYWRIGHT_MODULE=/절대경로/playwright/index.mjs node test/instant-delivery.browser.mjs
// 실제 main.jsx/App.jsx/DOM을 쓴다. 가짜 백엔드 + 외부 요청 차단으로 라이브에 쓰지 않는다.
import { mkdir, writeFile } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const PORT = process.env.IN_TEST_PORT || 5201;
const VARIANT = process.env.IN_VARIANT || 'fixed';
const LAT = Number(process.env.IN_LATENCY || 120);
const artifacts = new URL(`../artifacts/instant-delivery-${VARIANT}/`, import.meta.url);
await mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' });

async function open() {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(15000);
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/*', (r) => new URL(r.request().url()).hostname === '127.0.0.1' ? r.continue() : r.abort());
  await page.addInitScript(() => localStorage.setItem('argo-lang', 'ko'));
  await page.goto(`http://127.0.0.1:${PORT}/test/instant-delivery.fixture.html`);
  await page.locator('.msgr-spine').getByText('먼저 있던 글').first().waitFor();
  await page.evaluate((lat) => { window.__instant.latency = lat; }, LAT);
  await quiesce(page); // 시작 시 쿼리 폭풍이 끝난 뒤에 잰다 — 겹치면 방송 지연이 아니라 시작 지연을 재게 된다
  return { page, errors };
}

// 쿼리가 일정 시간 새로 걸리지 않을 때까지 기다린다(측정 구간을 깨끗하게).
async function quiesce(page, idleMs = 1500, capMs = 30000) {
  const deadline = Date.now() + capMs;
  let last = -1, stableSince = Date.now();
  for (;;) {
    const n = await page.evaluate(() => window.__instant.queries.length);
    if (n !== last) { last = n; stableSince = Date.now(); }
    else if (Date.now() - stableSince >= idleMs) return;
    if (Date.now() > deadline) return;
    await page.waitForTimeout(150);
  }
}

// 받는 쪽 — 방송이 나간 시각부터 글이 화면에 보이기까지.
async function receive(page, { withChannelTopic }) {
  await page.evaluate(() => { window.__instant.queries.length = 0; });
  const body = `받은 글 ${Date.now()}`;
  const sent = await page.evaluate(([b, ch]) => window.__instant.post({ body: b, withChannelTopic: ch }), [body, withChannelTopic]);
  await page.locator('.msgr-row').filter({ hasText: body }).first().waitFor(); // 남이 보낸 글 = 척추 왼쪽 행
  const shownAt = await page.evaluate(() => performance.now());
  const queries = await page.evaluate(() => [...window.__instant.queries]);
  return { ms: Math.round(shownAt - sent.at), queries };
}

// 보내는 쪽 — 전송 누른 시각부터 내 글이 화면에 보이기까지.
async function send(page) {
  await page.evaluate(() => { window.__instant.queries.length = 0; });
  const body = `보낸 글 ${Date.now()}`;
  const box = page.locator('.msgr-composer textarea');
  await box.fill(body);
  const started = await page.evaluate(() => performance.now());
  await box.press('Enter');
  await page.locator('.msgr-mine').filter({ hasText: body }).first().waitFor(); // 내 글 = 반대편 차콜 버블
  const shownAt = await page.evaluate(() => performance.now());
  const queries = await page.evaluate(() => [...window.__instant.queries]);
  return { ms: Math.round(shownAt - started), queries };
}

const out = { variant: VARIANT, latencyPerQueryMs: LAT, runs: {}, pageErrors: [] };
// 시나리오마다 새 창에서 잰다. 한 창에서 잇따라 재면 앞 시나리오가 남긴 상태(본문 방송을 받은
// 기록 등)가 다음 시나리오의 판정을 바꾼다 — 실제로는 서버가 둘 중 한 쪽으로 고정돼 있다.
async function scenario(name, fn, shot = false) {
  const { page, errors } = await open();
  try { out.runs[name] = await fn(page); if (shot) await page.screenshot({ path: new URL('feed.png', artifacts).pathname }); }
  catch (e) { out.runs[name] = { error: e.message }; out.error ??= `${name}: ${e.message}`;
    await page.screenshot({ path: new URL(`failure-${name}.png`, artifacts).pathname }).catch(() => {}); }
  finally { out.pageErrors.push(...errors); await page.close(); }
}
// 서버가 본문 방송을 보내는 경우(마이그레이션 적용 후)와 안 보내는 경우(적용 전)를 각각 잰다.
await scenario('receiveWithChannelTopic', (p) => receive(p, { withChannelTopic: true }));
await scenario('receiveLeanOnly', (p) => receive(p, { withChannelTopic: false }));
await scenario('send', (p) => send(p), true);
await browser.close();

await writeFile(new URL('results.json', artifacts), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
if (out.error) process.exit(1);
