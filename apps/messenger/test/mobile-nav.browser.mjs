// 폰 화면 스택 행동 검사(실제 App + 가짜 백엔드, work-panel 픽스처) — 유건 제보 2026-09-15 "DM에서 대화 열고 뒤로 가면 홈으로".
// 실행: (1) node node_modules/vite/bin/vite.js --config test/work-panel.config.mjs  (2) PLAYWRIGHT_MODULE=<playwright index.mjs> node test/mobile-nav.browser.mjs
// 검사: DM 탭→대화→뒤로 버튼=DM · history.back(안드로이드 하드웨어 뒤로)=DM · 대화→검색→뒤로→대화→뒤로=DM(깊이 이중 계산 없음)
//       루트 탭이 스택을 접어 depth 0 · 폭 전환(폰↔데스크톱)이 깊이를 지우지 않음 · 루트 탭엔 상단 뒤로 버튼 없음 · 상단 뒤로 라벨 "뒤로".
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import assert from 'node:assert/strict';
const port = process.env.WORK_TEST_PORT || 5217;
const b = await chromium.launch({ headless: true, channel: process.env.WORK_CHANNEL || 'chrome' });
const p = await b.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
await p.route('**/*', (r) => (new URL(r.request().url()).hostname === '127.0.0.1' ? r.continue() : r.abort()));
await p.addInitScript(() => { localStorage.setItem('argo-lang', 'ko'); });
await p.goto(`http://127.0.0.1:${port}/test/work-panel.fixture.html`);
await p.locator('.msgr-shell.msgr-phone').waitFor();
await p.waitForFunction(() => history.state && history.state.depth !== undefined);
const st = () => p.evaluate(() => ({ page: history.state?.page ?? null, depth: history.state?.depth, dm: document.querySelector('.msgr-shell').classList.contains('phone-dm'), home: document.querySelector('.msgr-shell').classList.contains('phone-home') }));
const tab = (re) => p.evaluate((s) => { [...document.querySelectorAll('.msgr-tabbar [role=tab]')].find((x) => new RegExp(s, 'i').test(x.textContent))?.click(); }, re);
const settle = () => p.waitForTimeout(400);
const openDm = async () => { await p.locator('[data-sec="dms"] .item').first().click(); await settle(); };
const back = async () => { await p.evaluate(() => { const el = [...document.querySelectorAll('.msgr-menu')].find((b) => b.getBoundingClientRect().width > 0); el?.click(); }); await settle(); }; // 상단 뒤로(폰 NavButton) — 화면 전환 애니메이션 중 포인터 판정이 흔들려 JS 클릭으로
const hwBack = async () => { await p.evaluate(() => history.back()); await settle(); };
const checks = [];
const ok = (name, cond, got) => { checks.push([name, !!cond]); assert.ok(cond, `${name}: ${JSON.stringify(got)}`); };
let s = await st(); ok('시작=홈 depth0', s.page === 'home' && s.depth === 0, s);
await tab('DM|1:1'); await settle(); s = await st(); ok('DM 탭', s.page === 'dm' && s.dm, s);
await openDm(); s = await st(); ok('DM→대화 depth1', s.page === 'chat' && s.depth === 1, s);
const label = await p.evaluate(() => [...document.querySelectorAll('.msgr-menu')].find((b) => b.getBoundingClientRect().width > 0)?.getAttribute('aria-label')); ok('상단 뒤로 라벨(대화 화면)', label === '뒤로', label);
await back(); s = await st(); ok('뒤로 버튼=DM', s.page === 'dm' && s.dm && s.depth === 0, s);
await openDm(); await hwBack(); s = await st(); ok('하드웨어 뒤로=DM', s.page === 'dm' && s.dm, s);
await openDm(); await p.locator('.msgr-tabsearch').click(); await settle(); s = await st(); ok('대화→검색 depth2', s.page === 'search' && s.depth === 2, s);
await hwBack(); s = await st(); ok('검색→뒤로=대화 depth1', s.page === 'chat' && s.depth === 1, s);
await hwBack(); s = await st(); ok('대화→뒤로=DM', s.page === 'dm' && s.dm && s.depth === 0, s);
await openDm(); await tab('홈|home'); await p.waitForTimeout(700); s = await st(); ok('루트 탭이 스택을 접음(depth0)', s.page === 'home' && s.depth === 0, s);
await p.evaluate(() => history.back()); await p.waitForTimeout(700); // 접힌 뒤 하드웨어 뒤로 = 앱 밖(이전 문서)으로 나가야지 옛 대화로 내려가면 안 된다(검수 N-2)
const left = await p.evaluate(() => !document.querySelector('.msgr-shell') || (history.state?.page !== 'chat')); ok('접기 뒤 하드웨어 뒤로는 옛 대화로 내려가지 않는다', left, await p.evaluate(() => ({ url: location.href.slice(-40), state: history.state })));
await p.goto(`http://127.0.0.1:${port}/test/work-panel.fixture.html`); await p.locator('.msgr-shell.msgr-phone').waitFor(); await p.waitForFunction(() => history.state && history.state.depth !== undefined);
await tab('DM|1:1'); await settle(); await openDm(); await p.setViewportSize({ width: 1280, height: 800 }); await p.waitForTimeout(700);
ok('데스크톱 전환에도 depth 유지', (await st()).depth === 1, await st());
await p.setViewportSize({ width: 390, height: 844 }); await p.waitForTimeout(700); await back(); s = await st(); ok('폰 복귀 뒤 뒤로=DM', s.page === 'dm' && s.dm, s);
await tab('알림|inbox'); await settle(); s = await st(); ok('알림함 탭 = 루트 depth0', s.page === 'inbox' && s.depth === 0, s);
const rootBack = await p.evaluate(() => [...document.querySelectorAll('.msgr-menu')].filter((b) => b.getBoundingClientRect().width > 0).length); ok('루트 탭에는 상단 뒤로 버튼이 없다(하드웨어 뒤로만 = 앱 종료)', rootBack === 0, rootBack);
await b.close();
console.log(`${checks.length} phone navigation checks passed`);
