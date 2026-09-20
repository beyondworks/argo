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
const chatLayout = () => p.evaluate(() => {
  const main = document.querySelector('.msgr-main').getBoundingClientRect();
  return Object.fromEntries(['.msgr-top', '.msgr-top .msgr-menu', '.msgr-top .title', '.msgr-work-button', '.msgr-thread', '.msgr-composer', '.msgr-tabbar'].map((selector) => {
    const el = document.querySelector(selector); if (!el) return [selector, null];
    const r = el.getBoundingClientRect();
    return [selector, { display: getComputedStyle(el).display, x: r.x - (selector === '.msgr-tabbar' ? 0 : main.x), y: r.y, width: r.width, height: r.height }];
  }));
});
const sameChatLayout = (a, b) => Object.keys(a).every((key) => a[key] === null ? b[key] === null : b[key] && a[key].display === b[key].display && ['x', 'y', 'width', 'height'].every((dimension) => Math.abs(a[key][dimension] - b[key][dimension]) < 1));
let s = await st(); ok('시작=홈 depth0', s.page === 'home' && s.depth === 0, s);
await tab('채팅|Chats'); await settle(); s = await st(); ok('DM 탭', s.page === 'dm' && s.dm, s);
await openDm(); s = await st(); ok('DM→대화 depth1', s.page === 'chat' && s.depth === 1, s);
const label = await p.evaluate(() => [...document.querySelectorAll('.msgr-menu')].find((b) => b.getBoundingClientRect().width > 0)?.getAttribute('aria-label')); ok('상단 뒤로 라벨(대화 화면)', label === '뒤로', label);
await p.evaluate(() => { const el = [...document.querySelectorAll('.msgr-menu')].find((b) => b.getBoundingClientRect().width > 0); el?.click(); el?.click(); }); await settle(); s = await st(); ok('뒤로를 빠르게 두 번 눌러도 한 단계만 돌아간다', s.page === 'dm' && s.dm && s.depth === 0, s);
await openDm();
await back(); s = await st(); ok('뒤로 버튼=DM', s.page === 'dm' && s.dm && s.depth === 0, s);
await openDm(); await hwBack(); s = await st(); ok('하드웨어 뒤로=DM', s.page === 'dm' && s.dm, s);
await openDm(); await p.locator('.msgr-tabsearch').click(); await settle(); s = await st(); ok('대화→검색 depth2', s.page === 'search' && s.depth === 2, s);
await hwBack(); s = await st(); ok('검색→뒤로=대화 depth1', s.page === 'chat' && s.depth === 1, s);
await hwBack(); s = await st(); ok('대화→뒤로=DM', s.page === 'dm' && s.dm && s.depth === 0, s);
await openDm(); await tab('홈|home'); await p.waitForTimeout(700); s = await st(); ok('루트 탭이 스택을 접음(depth0)', s.page === 'home' && s.depth === 0, s);
await p.evaluate(() => history.back()); await p.waitForTimeout(700); // 접힌 뒤 하드웨어 뒤로 = 앱 밖(이전 문서)으로 나가야지 옛 대화로 내려가면 안 된다(검수 N-2)
const left = await p.evaluate(() => !document.querySelector('.msgr-shell') || (history.state?.page !== 'chat')); ok('접기 뒤 하드웨어 뒤로는 옛 대화로 내려가지 않는다', left, await p.evaluate(() => ({ url: location.href.slice(-40), state: history.state })));
await p.goto(`http://127.0.0.1:${port}/test/work-panel.fixture.html`); await p.locator('.msgr-shell.msgr-phone').waitFor(); await p.waitForFunction(() => history.state && history.state.depth !== undefined);
await tab('채팅|Chats'); await settle(); await openDm(); await p.setViewportSize({ width: 1280, height: 800 }); await p.waitForTimeout(700);
ok('데스크톱 전환에도 depth 유지', (await st()).depth === 1, await st());
await p.setViewportSize({ width: 390, height: 844 }); await p.waitForTimeout(700); await back(); s = await st(); ok('폰 복귀 뒤 뒤로=DM', s.page === 'dm' && s.dm, s);
await tab('알림|inbox'); await settle(); s = await st(); ok('알림함 탭 = 루트 depth0', s.page === 'inbox' && s.depth === 0, s);
const rootBack = await p.evaluate(() => [...document.querySelectorAll('.msgr-menu')].filter((b) => b.getBoundingClientRect().width > 0).length); ok('루트 탭에는 상단 뒤로 버튼이 없다(하드웨어 뒤로만 = 앱 종료)', rootBack === 0, rootBack);
// 가장자리 스와이프 뒤로(유건 2026-09-15 "어색하다" 손질): DM에서 연 대화를 왼쪽 가장자리에서 끌면 밑에 DM 탭(홈 아님)이 깔리고 화면이 손가락을 따라오며, 놓으면 DM으로 돌아간다
await tab('채팅|Chats'); await settle(); await openDm(); s = await st(); ok('스와이프 전: 대화 depth1', s.page === 'chat' && s.depth === 1, s);
{
  const cdp = await p.context().newCDPSession(p);
  const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
  const beforeSwipeLayout = await chatLayout();
  await touch('touchStart', 10, 420); await touch('touchMove', 40, 422); await touch('touchMove', 120, 424); await p.waitForTimeout(50);
  const mid = await p.evaluate(() => { const sh = document.querySelector('.msgr-shell'); const m = document.querySelector('.msgr-main'); const side = document.querySelector('.msgr-side'); return { swiping: sh.classList.contains('swiping-back'), dm: sh.classList.contains('phone-dm'), home: sh.classList.contains('phone-home'), tx: m.style.transform, p: side.style.getPropertyValue('--swipe-p'), shellP: sh.style.getPropertyValue('--swipe-p') }; });
  ok('끄는 중: 밑에 DM 탭이 깔리고 화면이 손가락을 따라온다', mid.swiping && mid.dm && mid.home && mid.tx === 'translateX(80px)' && Number(mid.p) > 0.2 && !mid.shellP, mid); // 방향이 잠긴 지점(40px)부터 따라간다 — 잠금 전 거리가 한꺼번에 반영되던 튐 없음(유건 2026-09-17)
  const duringSwipeLayout = await chatLayout();
  ok('스와이프 중 헤더·본문·입력창 배치와 고정 탭 바가 유지된다', sameChatLayout(beforeSwipeLayout, duringSwipeLayout), { before: beforeSwipeLayout, during: duringSwipeLayout });
  await touch('touchMove', 60, 424); await touch('touchEnd'); await p.waitForTimeout(500);
  s = await st(); const after = await p.evaluate(() => ({ swiping: document.querySelector('.msgr-shell').classList.contains('swiping-back'), tx: document.querySelector('.msgr-main').style.transform, sideP: document.querySelector('.msgr-side').style.getPropertyValue('--swipe-p') }));
  ok('짧게 끌다 놓으면 제자리(대화 유지)·정리됨', s.page === 'chat' && !after.swiping && !after.tx && !after.sideP, { s, after });
  const afterCancelLayout = await chatLayout();
  ok('스와이프 취소 뒤 대화 배치가 그대로다', sameChatLayout(beforeSwipeLayout, afterCancelLayout), { before: beforeSwipeLayout, after: afterCancelLayout });
  await p.evaluate(() => { const sh = document.querySelector('.msgr-shell'); const main = document.querySelector('.msgr-main'); window.__tl = []; const snap = () => window.__tl.push({ page: history.state?.page, cls: sh.className, tx: main.style.transform }); new MutationObserver(snap).observe(sh, { attributes: true, attributeFilter: ['class'] }); new MutationObserver(snap).observe(main, { attributes: true, attributeFilter: ['style'] }); window.addEventListener('popstate', () => setTimeout(snap, 0)); });
  await touch('touchStart', 10, 420); await touch('touchMove', 100, 422); await touch('touchMove', 260, 424); await p.waitForTimeout(30); await touch('touchEnd'); await p.waitForTimeout(700);
  s = await st(); ok('화면 폭 35% 넘게 끌고 놓으면 DM 탭으로', s.page === 'dm' && s.dm && s.depth === 0, s);
  // 깜빡임 제보(유건 2026-09-15)의 잠금: settling 뒤로는 화면이 바뀌기(popstate) 전에 transform을 지우는 순간이 없어야 하고, 스와이프 복귀엔 anim-pop이 붙지 않는다
  { const tl = await p.evaluate(() => window.__tl); const from = tl.findIndex((x) => /settling/.test(x.cls)); const after = from >= 0 ? tl.slice(from) : tl;
    const early = after.filter((x) => x.page === 'chat' && x.tx === '' && !/swiping-back/.test(x.cls)); ok('전환 전에 대화 화면이 제자리로 튀는 프레임이 없다(popstate 뒤 정리)', from >= 0 && early.length === 0, { from, early: early.slice(0, 3) });
    ok('스와이프 복귀에는 pop 애니메이션이 겹치지 않는다', !after.some((x) => /anim-pop/.test(x.cls)), after.filter((x) => /anim-/.test(x.cls)).slice(0, 3)); }
  ok('스와이프 뒤 클래스·transform 정리', await p.evaluate(() => !document.querySelector('.msgr-shell').classList.contains('swiping-back') && !document.querySelector('.msgr-main').style.transform));
  // 유건 2026-09-17: 화면 왼쪽 절반(중앙 근처)에서 시작해도 뒤로 / 되돌리며 놓으면 제자리 / 입력창에서 시작하면 뒤로가기 아님
  await openDm(); await touch('touchStart', 180, 420); await touch('touchMove', 200, 421); await touch('touchMove', 330, 423); await p.waitForTimeout(30); await touch('touchEnd'); await p.waitForTimeout(700);
  s = await st(); ok('중앙 근처(180px)에서 시작해도 뒤로', s.page === 'dm' && s.depth === 0, s);
  await openDm(); await touch('touchStart', 20, 420); for (const x of [40, 90, 140, 190, 220]) { await touch('touchMove', x, 421); await p.waitForTimeout(20); } for (const x of [200, 180, 160]) { await touch('touchMove', x, 421); await p.waitForTimeout(20); } await touch('touchEnd'); await p.waitForTimeout(600);
  s = await st(); ok('밀었다가 되돌리며 놓으면 제자리', s.page === 'chat' && s.depth === 1, s);
  const box = await p.locator('.msgr-composer textarea').boundingBox();
  for (const [label, x] of [['입력창 가운데', box.x + box.width / 3], ['입력줄 첨부 버튼', box.x + 10]]) { await touch('touchStart', x, box.y + box.height / 2); await touch('touchMove', x + 40, box.y + box.height / 2 + 1); await touch('touchMove', x + 200, box.y + box.height / 2 + 2); await touch('touchEnd'); await p.waitForTimeout(600); s = await st(); ok(`${label}에서 시작한 가로 끌기는 뒤로가기가 아니다`, s.page === 'chat', s); }
  if ((await st()).page === 'chat') { await back(); }
}
// 화면 전환 애니메이션(유건 2026-09-15): 대화 열기 = push, 하단 탭 전환 = tab, 뒤로 버튼 = pop. 300ms 뒤 클래스 해제
{
  await tab('채팅|Chats'); await settle();
  await p.locator('[data-sec="dms"] .item').first().click(); await p.waitForTimeout(60);
  ok('대화 열기 → anim-push', await p.evaluate(() => /(^| )anim-push-(a|b)( |$)/.test(document.querySelector('.msgr-shell').className)));
  ok('push 중 문서에 가로 스크롤 폭이 생기지 않는다(셸 overflow-x clip — iOS 가로 고무줄, 유건 2026-09-16)', await p.evaluate(() => { const d = document.scrollingElement; const sh = document.querySelector('.msgr-shell'); return d.scrollWidth <= window.innerWidth && ['clip', 'hidden'].includes(getComputedStyle(sh).overflowX) && getComputedStyle(document.body).overscrollBehaviorX === 'none'; }));
  ok('push 중 본문 자식(상단·스레드)은 따로 움직이지 않는다 — 부모 한 층만(검수 M-F: 이중 이동이 떨림)', await p.evaluate(() => [...document.querySelectorAll('.msgr-main > .msgr-top, .msgr-main > .msgr-thread')].every((el) => getComputedStyle(el).animationName === 'none')));
  await p.waitForTimeout(400); ok('300ms 뒤 해제', await p.evaluate(() => ![...document.querySelector('.msgr-shell').classList].some((c) => c.startsWith('anim-'))));
  await back(); await p.waitForTimeout(0); // back()은 400ms 대기 → 이미 해제됐을 수 있어 즉시 다시 확인 대신 결과 화면만 본다
  await p.evaluate(() => { const el = document.querySelector('.msgr-side .msgr-railbody'); el.scrollTop = 400; }); await p.waitForTimeout(50);
  await tab('홈|home'); await p.waitForTimeout(60); ok('탭 전환(DM→홈) → anim-tab-right', await p.evaluate(() => /anim-tab-right-(a|b)/.test(document.querySelector('.msgr-shell').className)));
  ok('탭 전환 도착 순간 레일 스크롤은 맨 위(이전 탭 위치가 남아 iOS 고무줄 튕김이 나던 것)', (await p.evaluate(() => document.querySelector('.msgr-side .msgr-railbody').scrollTop)) === 0);
  ok('탭 전환은 옆으로 밀지 않는다(교차 페이드)', await p.evaluate(() => getComputedStyle(document.querySelector('.msgr-side')).transform === 'none'));
  await p.waitForTimeout(400); ok('해제 뒤 레일에 다른 애니메이션이 이어지지 않는다(검수 M-E: 옛 msgrPageBack 재생)', await p.evaluate(() => getComputedStyle(document.querySelector('.msgr-side')).animationName === 'none'));
  // 연속 전환(검수 M-2): 곧바로 DM → 알림함으로 두 번 옮기면 두 번째도 새 변형(a/b)으로 재시작
  await tab('채팅|Chats'); await p.waitForTimeout(40); const c1 = await p.evaluate(() => (document.querySelector('.msgr-shell').className.match(/anim-tab-left-(a|b)/) || [])[0]); await tab('알림|inbox'); await p.waitForTimeout(40); const c2 = await p.evaluate(() => (document.querySelector('.msgr-shell').className.match(/anim-tab-left-(a|b)/) || [])[0]);
  ok('연속 전환은 a/b가 번갈아 재시작', c1 && c2 && c1 !== c2, { c1, c2 }); await p.waitForTimeout(400);
  await p.waitForTimeout(400);
  // 스와이프 뒤로 중 밑 화면은 DM 탭 모양(필터 줄) — 전환 순간 다시 그려지지 않게
  await tab('채팅|Chats'); await settle(); await openDm();
  const cdp = await p.context().newCDPSession(p);
  const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
  await touch('touchStart', 10, 420); await touch('touchMove', 40, 422); await touch('touchMove', 120, 424); await p.waitForTimeout(80);
  ok('스와이프 중 밑 화면에 DM 필터 줄이 미리 그려진다', (await p.locator('.msgr-dmfilter').count()) === 1);
  await touch('touchMove', 60, 424); await touch('touchEnd'); await p.waitForTimeout(500);
  ok('취소 뒤 대화 유지·필터 줄 없음', await p.evaluate(() => history.state?.page === 'chat' && !document.querySelector('.msgr-dmfilter')));
  // 하단 탭 바는 스와이프 뒤로 중에도 남는다(유건 2026-09-15: 사라졌다 돌아와 부자연스럽다) — 두 화면이 공유하는 고정 요소
  await touch('touchStart', 10, 420); await touch('touchMove', 40, 422); await touch('touchMove', 120, 424); await p.waitForTimeout(80);
  const barMid = await p.evaluate(() => { const sh = document.querySelector('.msgr-shell'); const bar = document.querySelector('.msgr-tabbar'); const r = bar?.getBoundingClientRect(); return { swiping: sh.classList.contains('swiping-back'), w: r?.width ?? 0, display: bar ? getComputedStyle(bar).display : null }; });
  ok('스와이프 뒤로 중 하단 탭 바가 보인다', barMid.swiping && barMid.w > 0 && barMid.display !== 'none', barMid);
  const activeMid = await p.evaluate(() => document.querySelector('.msgr-tabbar [role=tab][aria-selected="true"]')?.textContent.trim()); ok('스와이프 중 활성 탭 = 목적지(DM) — 도착 순간 튀지 않게(검수 M-4)', /채팅|Chats/i.test(activeMid || ''), activeMid);
  await touch('touchMove', 60, 424); await touch('touchEnd'); await p.waitForTimeout(500);
  // 대화 층은 스와이프 중에도 탭 바 위 여백을 유지한다(입력창이 아일랜드 밑으로 안 들어간다)
  await touch('touchStart', 10, 420); await touch('touchMove', 40, 422); await touch('touchMove', 120, 424); await p.waitForTimeout(80);
  const pad = await p.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.msgr-main')).paddingBottom)); ok('스와이프 중 대화 층 바닥 여백 유지', pad > 40, pad);
  await touch('touchMove', 60, 424); await touch('touchEnd'); await p.waitForTimeout(500);
}
// 홈에서도 길게 누르기 = 점 세 개 메뉴(유건 2026-09-15). 레일 글자는 길게 눌러도 선택되지 않는다(user-select: none)
{
  await tab('홈|home'); await settle();
  const sel = await p.evaluate(() => ['.msgr-railbody', '.msgr-tabbar', '.msgr-top'].map((q) => document.querySelector(q)).filter(Boolean).map((el) => getComputedStyle(el).userSelect)); ok('폰 화면 글자 선택 차단(레일·탭 바·상단)', sel.length >= 2 && sel.every((v) => v === 'none'), sel);
  const selIn = await p.evaluate(() => { const el = document.querySelector('input, textarea'); return el ? getComputedStyle(el).userSelect : 'text'; }); ok('입력칸은 선택 가능', selIn === 'text' || selIn === 'auto', selIn);
  const row = p.locator('[data-sec="channels"] .msgr-railrow').first(); const bx = await row.boundingBox(); const cdp = await p.context().newCDPSession(p);
  const nameBox = await row.locator('.name').boundingBox();
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: nameBox.x + 8, y: nameBox.y + nameBox.height / 2 }] }); await p.waitForTimeout(600);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await p.waitForTimeout(300);
  const menu = await p.locator('.msgr-ctxmenu [role=menuitem]').allInnerTexts(); ok('홈 채널 행을 글자 위에서 길게 누르면 메뉴(손 떼도 유지)', menu.length > 0 && menu.some((m) => /즐겨찾기/.test(m)), menu);
  const menuSel = await p.evaluate(() => getComputedStyle(document.querySelector('.msgr-ctxmenu')).userSelect); ok('손가락 밑에 뜬 메뉴(body 포털)도 글자 선택 차단 — 유건 캡처(알림 끄기 선택됨)', menuSel === 'none', menuSel);
  const focusIn = await p.evaluate(() => ({ inMenu: !!document.activeElement?.closest('.msgr-ctxmenu'), tag: document.activeElement?.tagName })); ok('터치 기기에선 메뉴 항목에 포커스를 옮기지 않는다(iOS 포커스 링 — 유건 캡처)', !focusIn.inMenu, focusIn);
  await p.keyboard.press('Escape'); await p.waitForTimeout(150);
  const focusBack = await p.evaluate(() => ({ onItem: !!document.activeElement?.closest('.msgr-railrow'), tag: document.activeElement?.tagName })); ok('닫힌 뒤 행 버튼으로 포커스를 되돌리지 않는다(행에 선이 남던 것)', !focusBack.onItem, focusBack);
  { const more = p.locator('[data-sec="channels"] .msgr-railrow:has(.item:not(.active)) .more').first(); await more.hover(); await p.waitForTimeout(50); const bg = await more.evaluate((el) => getComputedStyle(el).backgroundColor); ok('폰에서 점 세 개 hover 배경 없음(iOS 고착 hover — 캡처의 잔상, 재검수 LOW-C: 비활성 행의 .more를 잰다)', bg === 'rgba(0, 0, 0, 0)', bg); await p.mouse.move(5, 5); }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: nameBox.x + 8, y: nameBox.y + nameBox.height / 2 }] }); await p.waitForTimeout(600);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await p.waitForTimeout(300);
  const selected = await p.evaluate(() => String(getSelection()).length); ok('길게 누른 뒤 글자가 선택되지 않았다', selected === 0, selected);
  const dots = await row.locator('.more').evaluate((el) => { el.click(); return true; }).catch(() => false);
  await p.waitForTimeout(200); const menu2 = await p.locator('.msgr-ctxmenu [role=menuitem]').allInnerTexts(); ok('점 세 개 메뉴와 같은 항목', dots && JSON.stringify(menu2) === JSON.stringify(menu), { menu, menu2 });
  await p.keyboard.press('Escape'); await p.waitForTimeout(150);
  ok('홈에서 좌우 스와이프는 탭을 옮기지 않는다', await (async () => { const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] }); await touch('touchStart', 300, 420); await touch('touchMove', 250, 422); await touch('touchMove', 150, 424); await touch('touchEnd'); await p.waitForTimeout(350); return p.evaluate(() => history.state?.page === 'home'); })());
}
await b.close();
console.log(`${checks.length} phone navigation checks passed`);
