// 유건 제보(2026-09-23): 에이전트 답변 뒤에 '입력 중' 창이 하나 더 떴다가 사라진다.
// 서버: IN_TEST_PORT=5201 node node_modules/vite/bin/vite.js --config test/instant-delivery.config.mjs
//   (수정 전 재현: IN_BASELINE_REF=<커밋>을 서버에 주면 그 커밋의 App.jsx를 불러온다)
// 실행: PLAYWRIGHT_MODULE=/절대경로/playwright/index.mjs node test/typing-ghost.browser.mjs
// 실제 main.jsx/App.jsx/DOM, 가짜 백엔드(instant-delivery.supabase.mjs) — 라이브에 쓰지 않는다.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const PORT = process.env.IN_TEST_PORT || 5201;
const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.setDefaultTimeout(15000);
const errors = []; page.on('pageerror', (e) => errors.push(e.message));
await page.route('**/*', (r) => new URL(r.request().url()).hostname === '127.0.0.1' ? r.continue() : r.abort());
await page.addInitScript(() => { localStorage.setItem('argo-lang', 'ko'); window.__instant && (window.__instant.latency = 20); });
await page.goto(`http://127.0.0.1:${PORT}/test/instant-delivery.fixture.html`);
await page.locator('.msgr-spine').getByText('먼저 있던 글').first().waitFor();

// 크루 방송 흉내 — 서버 startTyping이 org 토픽으로 보내는 것과 같은 모양
await page.evaluate(() => {
  const s = window.__instant; const org = 'org-fixture';
  s.crewSignal = () => {
    const base = { channel_id: 'general', crew_id: 'crew-x' };
    s.topics[`org:${org}`]?.typing?.forEach((h) => h({ payload: base }));
    s.topics[`org:${org}`]?.progress?.forEach((h) => h({ payload: { ...base, stage: '기억을 살피는 중', detail: '', steps: [], thought: '', partial: '', startedAt: Date.now() - 5900 } }));
  };
  s.crewReply = (body) => {
    const row = { id: s.nextId++, org_id: org, channel_id: 'general', author_kind: 'crew', author_user_id: null, crew_id: 'crew-x', kind: 'text', body,
      created_at: new Date().toISOString(), edited_at: null, deleted_at: null, mentions: [], reply_to: null, meta: null, client_msg_id: null };
    s.tables.msgr_messages.push(row);
    s.topics[`org:${org}`]?.message?.forEach((h) => h({ payload: { id: row.id, channel_id: 'general', author_kind: 'crew', author_user_id: null, crew_id: 'crew-x', kind: 'text', mentions: [], reply_to: null } }));
  };
});
const indicator = () => page.evaluate(() => ({
  typing: [...document.querySelectorAll('.msgr-typing, .typing-line')].some((e) => e.textContent.includes('탐침 크루')),
  card: document.body.innerText.includes('기억을 살피는 중'),
}));

for (let i = 0; i < 3; i++) { await page.evaluate(() => window.__instant.crewSignal()); await page.waitForTimeout(700); }
const during = await indicator();
const body = `답변 ${Date.now()}`;
await page.evaluate((b) => { window.__instant.crewReply(b); setTimeout(() => window.__instant.crewSignal(), 150); }, body); // 답글 직후 늦게 도착한 방송 하나
await page.locator('.msgr-row').filter({ hasText: body }).first().waitFor();
await page.waitForTimeout(400);
const after400 = await indicator();
await page.waitForTimeout(600);
const after1000 = await indicator();
await page.screenshot({ path: new URL('../artifacts/typing-ghost.png', import.meta.url).pathname });
await browser.close();
const out = { during, after400, after1000, pageErrors: errors };
console.log(JSON.stringify(out));
const ok = (during.typing || during.card) && !after400.typing && !after400.card && !after1000.typing && !after1000.card && !errors.length;
process.exit(ok ? 0 : 1);
