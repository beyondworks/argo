// 기억 페이지 읽기 칼럼·업무 패널 시트(유건 2026-09-18 0.1.29 피드백 3·4).
// ③ 기억 문서: 가운데 읽기 칼럼(최대 820px), 첫 탭 글자·마지막 탭 버튼이 본문 좌우 선과 같다. 탭이 많아지면 탭 줄만 가로 스크롤, 칼럼은 그대로.
//    결함: .msgr-actlist max-width 1100px 왼쪽 정렬 — 넓은 창에서 오른쪽이 크게 비었다.
// ④ 업무·자동화(데스크톱): 채널 패널과 같은 시트(폭 380, 상단 바 실제 높이 아래, #600·#603 비킴 규칙) — 입력창 교차 0, 본문 1044px 이상이면 스레드도 교차 0.
//    [업무] 버튼은 열린 동안 aria-pressed, 바깥 클릭으로 닫힌다. 결함: 약 590px 오버레이가 채팅을 덮었다.
// 서버: WORK_TEST_PORT=5217 node node_modules/vite/bin/vite.js --config test/work-panel.config.mjs
// 실행: PLAYWRIGHT_MODULE=/절대경로/playwright/index.mjs node test/work-memory-layout.browser.mjs
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const PORT = process.env.WORK_TEST_PORT || 5217;
const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' });
const fails = []; let n = 0;
const check = (label, ok, got) => { n++; if (!ok) fails.push(`${label}: ${JSON.stringify(got)}`); };
const open = async (width, theme = 'linen-light') => {
  const p = await browser.newPage({ viewport: { width, height: 900 } });
  p.setDefaultTimeout(10000);
  await p.route('**/*', (rt) => new URL(rt.request().url()).hostname === '127.0.0.1' ? rt.continue() : rt.abort());
  await p.addInitScript((th) => { localStorage.setItem('argo-lang', 'ko'); localStorage.setItem('argo-theme', th); }, theme);
  await p.emulateMedia({ reducedMotion: 'reduce' });
  await p.goto(`http://127.0.0.1:${PORT}/test/work-panel.fixture.html`);
  await p.locator('.msgr-shell').waitFor(); await p.waitForTimeout(500);
  return p;
};

// ③ 기억 페이지
const DOCS = 9;
for (const width of [1920, 1400, 1100]) {
  const p = await open(width);
  await p.evaluate((count) => {
    const st = window.__dmFixture; const pub = st.tables.msgr_channels.find((c) => c.kind !== 'dm');
    st.tables.msgr_org_docs = Array.from({ length: count }, (_, i) => ({ id: `d${i}`, org_id: pub.org_id, channel_id: null, path: `rules/doc-${i}.md`, title: `문서 ${i + 1} 긴 제목으로 탭 폭을 채웁니다`, body: '본문 '.repeat(200), version: 1, updated_by: 'user-me', updated_at: '2026-09-01T00:00:00Z' }));
  }, DOCS);
  await p.click('button[title="기억"]'); await p.locator('.msgr-acttree').waitFor();
  const clickTree = (re) => p.evaluate((src) => { const r = new RegExp(src); const el = [...document.querySelectorAll('.msgr-acttree button, .msgr-acttree div')].filter((x) => r.test(x.textContent) && x.children.length < 6).pop(); el?.click(); return !!el; }, re);
  await clickTree('^.?전사 기억'); await p.waitForTimeout(250);
  await clickTree('^.?문서 1 '); await p.waitForTimeout(400);
  const measure = () => p.evaluate(() => {
    const list = document.querySelector('.msgr-actlist'); const cs = getComputedStyle(list); const L = list.getBoundingClientRect();
    const tab0 = document.querySelector('.msgr-actpane .vault-tab'); const title = tab0.querySelector('.vault-tab-title').getBoundingClientRect();
    const scroller = document.querySelector('.msgr-actpane .msgr-tabscroll');
    // 탭 묶음이 활성 탭 쪽으로 스크롤돼 있을 수 있다 — 스크롤 0일 때 첫 탭 글자가 놓일 선 = 탭 묶음 상자 왼쪽 + 탭 안 글자 들여쓰기
    const tabStart = scroller.getBoundingClientRect().left + (tab0.getBoundingClientRect().left - scroller.getBoundingClientRect().left + scroller.scrollLeft) + (title.left - tab0.getBoundingClientRect().left); // 묶음 왼쪽 + 스크롤 0일 때 첫 탭 위치 + 탭 안 글자 들여쓰기
    const acts = [...document.querySelectorAll('.msgr-actpane .vault-tabs .msgr-tabact')].at(-1)?.getBoundingClientRect();
    return { textL: Math.round(L.left + parseFloat(cs.paddingLeft)), textR: Math.round(L.right - parseFloat(cs.paddingRight)), tabL: Math.round(tabStart), actR: acts && Math.round(acts.right),
      tabsScroll: scroller ? scroller.scrollWidth - scroller.clientWidth : null, overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      paneL: Math.round(document.querySelector('.msgr-actpane').getBoundingClientRect().left), paneR: Math.round(document.querySelector('.msgr-actpane').getBoundingClientRect().right) };
  });
  const a = await measure();
  const center = (a.paneL + a.paneR) / 2;
  check(`${width} 본문 폭 ≤ 820`, a.textR - a.textL <= 820, a);
  check(`${width} 칼럼 가운데(넓을 때) 또는 28px 여백(좁을 때)`, Math.abs((a.textL + a.textR) / 2 - center) <= 1 && (a.textR - a.textL === 820 || a.textL - a.paneL === 28), a);
  check(`${width} 첫 탭 글자 = 본문 왼쪽 선`, Math.abs(a.tabL - a.textL) <= 1, a);
  check(`${width} 마지막 탭 버튼 = 본문 오른쪽 선`, a.actR == null || Math.abs(a.actR - a.textR) <= 1, a);
  // 탭을 많이 연다 — 탭 줄만 스크롤되고 칼럼 기준선은 그대로
  for (let i = 2; i <= DOCS; i++) { await clickTree(`^.?문서 ${i} `); await p.waitForTimeout(120); }
  await p.waitForTimeout(300);
  const b = await measure();
  check(`${width} 탭 ${DOCS + 1}개(그래프 등 포함) — 탭 줄이 넘치면 탭 묶음만 가로 스크롤`, b.tabsScroll > 0 && b.overflowX === 0, b);
  check(`${width} 탭이 많아도 본문 기준선 불변`, b.textL === a.textL && b.textR === a.textR, { a, b });
  await p.close();
}

// ④ 업무 패널
for (const [width, theme] of [[1600, 'linen-light'], [1600, 'linen-dark'], [1312, 'linen-light'], [900, 'linen-light']]) {
  const tag = `${width}/${theme}`;
  const p = await open(width, theme);
  await p.evaluate(() => [...document.querySelectorAll('.msgr-side .item')].find((x) => /Private/.test(x.textContent))?.click());
  await p.locator('.msgr-work-button').waitFor();
  check(`${tag} 닫힘 상태 aria-pressed=false`, await p.getAttribute('.msgr-work-button', 'aria-pressed') === 'false');
  await p.click('.msgr-work-button'); await p.locator('.msgr-worksheet').waitFor(); await p.waitForTimeout(250);
  const m = await p.evaluate(() => {
    const R = (s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width }; };
    const hit = (a, c) => !!(a && c) && a.l < c.r - 0.5 && c.l < a.r - 0.5 && a.t < c.b - 0.5 && c.t < a.b - 0.5;
    const sheet = R('.msgr-main > .msgr-sheetwrap > .msgr-worksheet'); const top = R('.msgr-main > .msgr-top'); const main = R('.msgr-main');
    return { mainW: Math.round(main.w), sheetW: Math.round(sheet.w), sheetTop: Math.round(sheet.t), topBottom: Math.round(top.b), rightGap: Math.round(main.r - sheet.r),
      composer: hit(R('.msgr-composer'), sheet), spine: hit(R('.msgr-thread .msgr-spine'), sheet), overlay: !!document.querySelector('.msgr-work-overlay'),
      pressed: document.querySelector('.msgr-work-button').getAttribute('aria-pressed'), overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth };
  });
  check(`${tag} 채널 패널과 같은 자리·폭(380, 오른쪽 24)`, m.sheetW === 380 && m.rightGap === 24 && !m.overlay, m);
  check(`${tag} 상단 바 실제 높이 아래에서 시작`, m.sheetTop >= m.topBottom, m);
  check(`${tag} 입력창 교차 0`, !m.composer, m);
  if (m.mainW >= 1044) check(`${tag} 본문 1044 이상이면 스레드 교차 0`, !m.spine, m);
  check(`${tag} 열린 동안 aria-pressed=true`, m.pressed === 'true', m);
  check(`${tag} 가로 넘침 0`, m.overflowX === 0, m);
  await p.mouse.click(420, 400); await p.waitForTimeout(250); // 바깥(스레드) 클릭
  check(`${tag} 바깥 클릭으로 닫힘 + aria-pressed=false`, await p.locator('.msgr-worksheet').count() === 0 && await p.getAttribute('.msgr-work-button', 'aria-pressed') === 'false');
  await p.click('.msgr-work-button'); await p.locator('.msgr-worksheet').waitFor();
  await p.keyboard.press('Escape'); await p.waitForTimeout(200);
  check(`${tag} Esc로 닫힘`, await p.locator('.msgr-worksheet').count() === 0);
  await p.close();
}
await browser.close();
if (fails.length) { console.error(`FAIL ${fails.length}/${n}\n${fails.join('\n')}`); process.exit(1); }
console.log(`PASS ${n}/${n}`);
