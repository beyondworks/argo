// 기억 탭 "최근 일지" 행동 검사(실제 App + 픽스처 5217) — 검수 #551: 같은 날짜 일지 2채널 → 각 행이 자기 채널 본문을 연다(HIGH-1),
// 일지가 많아도 규칙집이 보이고 최근 일지가 최신순(HIGH-2·조회 분리), DM 라벨은 상대 이름(# 없음), 헤더 카운트 = 보이는 개수, 목록 제거 변이는 red(M-3).
// 실행: (1) node node_modules/vite/bin/vite.js --config test/work-panel.config.mjs  (2) PLAYWRIGHT_MODULE=<playwright index.mjs> node test/memory-journal.browser.mjs
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import assert from 'node:assert/strict';
const port = process.env.WORK_TEST_PORT || 5217;
const b = await chromium.launch({ headless: true, channel: process.env.WORK_CHANNEL || 'chrome' });
const p = await b.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
await p.route('**/*', (r) => (new URL(r.request().url()).hostname === '127.0.0.1' ? r.continue() : r.abort()));
await p.addInitScript(() => { localStorage.setItem('argo-lang', 'ko'); });
await p.goto(`http://127.0.0.1:${port}/test/work-panel.fixture.html`);
await p.locator('.msgr-shell.msgr-phone').waitFor(); await p.waitForTimeout(600);
const checks = []; const ok = (name, cond, got) => { checks.push([name, !!cond]); assert.ok(cond, `${name}: ${JSON.stringify(got)}`); };
const seed = () => p.evaluate(() => {
  const st = window.__dmFixture; const chs = st.tables.msgr_channels ?? [];
  const pub = chs.find((c) => c.kind !== 'dm'); const dm = chs.find((c) => c.kind === 'dm'); const org = pub.org_id;
  const docs = [
    { id: 'r1', org_id: org, channel_id: null, path: 'rules/handbook.md', title: '규칙집', body: '- 답은 존댓말로', version: 1, updated_by: 'user-me', updated_at: '2026-09-01T00:00:00Z' },
    { id: 'j-pub', org_id: org, channel_id: pub.id, path: 'journal/2026-09-16.md', title: '2026-09-16', body: '- 10:00 · **크루** ← 유건: 채널 질문 → 채널 답(공개 채널 일지)', version: 1, updated_by: 'user-me', updated_at: '2026-09-16T01:00:00Z' },
    { id: 'j-dm', org_id: org, channel_id: dm.id, path: 'journal/2026-09-16.md', title: '2026-09-16', body: '- 09:00 · **크루** ← 유건: DM 질문 → DM 답(1:1 일지)', version: 1, updated_by: 'user-me', updated_at: '2026-09-16T02:00:00Z' },
  ];
  for (let i = 0; i < 420; i++) { const d = new Date(Date.UTC(2025, 0, 1) + i * 86400000).toISOString().slice(0, 10); docs.push({ id: `j-old-${i}`, org_id: org, channel_id: pub.id, path: `journal/${d}.md`, title: d, body: `- 옛 일지 ${d}`, version: 1, updated_by: 'user-me', updated_at: `${d}T00:00:00Z` }); }
  st.tables.msgr_org_docs = docs;
  return { pub: pub.name, dmId: dm.id, total: docs.length };
});
const openMemoryTab = async () => { await p.evaluate(() => { [...document.querySelectorAll('.msgr-tabbar [role=tab]')].find((x) => /기억|memory/i.test(x.textContent))?.click(); }); await p.locator('.msgr-memlist').waitFor({ timeout: 60_000 }); await p.waitForTimeout(1200); };
const reload = async () => { await p.goto(`http://127.0.0.1:${port}/test/work-panel.fixture.html`); await p.locator('.msgr-shell.msgr-phone').waitFor(); await p.waitForTimeout(600); await seed(); await openMemoryTab(); };
const seeded = await seed();
await openMemoryTab();
const items = await p.locator('.msgr-memlist .folder').first().locator('.memitem').evaluateAll((els) => els.map((e) => ({ name: e.querySelector('.name')?.textContent, meta: e.querySelector('.meta')?.textContent })));
ok('최근 일지 목록이 보인다(전사 문서 0이 아니어도 최상단)', items.length >= 2, items.slice(0, 3));
ok('최신순: DM 일지(02:00) → 채널 일지(01:00) → 옛 일지', items[0].meta === 'Fixture Existing Agent' && items[1].meta === '#Fixture General', items.slice(0, 3));
ok('DM 라벨에 # 없음, 채널 라벨은 #이름', !items[0].meta.startsWith('#') && items[1].meta.startsWith('#'), items.slice(0, 2));
ok('일지는 최신 30건까지만(일지 폭증이 규칙집을 밀어내지 않는다 — 조회 분리)', items.length === 30, items.length);
const rulesShown = await p.evaluate(() => [...document.querySelectorAll('.msgr-memlist .memitem .name')].some((n) => n.textContent === '규칙집'));
ok('일지 420건 옆에서도 전사 규칙집이 보인다(HIGH-2)', rulesShown, rulesShown);
const head = await p.locator('.msgr-actlist .head .sub').first().textContent(); ok('헤더 카운트 = 보이는 개수(전사 1 + 일지 30)', head.trim() === '31', head);
// HIGH-1: 같은 날짜 일지 두 행 — 각 행이 자기 채널 본문을 연다
const open = async (idx) => { await p.locator('.msgr-memlist .folder').first().locator('.memitem').nth(idx).click(); await p.waitForTimeout(500); const t = await p.evaluate(() => ({ head: document.querySelector('.msgr-actlist .msgr-klabel')?.textContent ?? '', body: document.querySelector('.msgr-actlist')?.innerText ?? '' })); return t; };
const a = await open(0); ok('DM 행 → DM 일지 본문·상대 이름 헤더(검수 HIGH-1: 경로만으론 채널이 갈리지 않는다)', /1:1 일지/.test(a.body) && a.head.startsWith('Fixture Existing Agent'), a.head);
await reload(); // 폰은 문서를 탭으로 열면 목록이 사라진다 — 두 번째 행은 새로 띄워서 본다
const c = await open(1); ok('채널 행 → 채널 일지 본문·#채널 헤더', /공개 채널 일지/.test(c.body) && c.head.startsWith('#Fixture General'), c.head);
await b.close();
console.log(`${checks.length} memory journal checks passed`);
