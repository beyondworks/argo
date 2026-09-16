// 폰 DM 탭 정렬·고정 행동 검사(실제 App + 가짜 백엔드, work-panel 픽스처) — 유건 요청 2026-09-15.
// 실행: (1) node node_modules/vite/bin/vite.js --config test/work-panel.config.mjs  (2) PLAYWRIGHT_MODULE=<playwright index.mjs> node test/dm-sort.browser.mjs
// 검사는 "보이는가"까지 본다(검수 #541 CRITICAL-1: DOM엔 있는데 CSS로 숨어 있었다): 정렬 버튼 boundingBox 존재·클릭 가능, 메뉴 항목 3개 보임,
// 선택 → aria-checked·localStorage, 바깥 누름으로 닫힘, 즐겨찾기 뒤 DM 탭 잔류 + 별 표시, 데스크톱(1280)에서는 정렬 버튼 없음.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import assert from 'node:assert/strict';
const port = process.env.WORK_TEST_PORT || 5217;
const b = await chromium.launch({ headless: true, channel: process.env.WORK_CHANNEL || 'chrome' });
const p = await b.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
await p.route('**/*', (r) => (new URL(r.request().url()).hostname === '127.0.0.1' ? r.continue() : r.abort()));
await p.addInitScript(() => { localStorage.setItem('argo-lang', 'ko'); });
await p.goto(`http://127.0.0.1:${port}/test/work-panel.fixture.html`);
await p.locator('.msgr-shell.msgr-phone').waitFor();
const checks = [];
const ok = (name, cond, got) => { checks.push([name, !!cond]); assert.ok(cond, `${name}: ${JSON.stringify(got)}`); };
try {
await p.evaluate(() => { [...document.querySelectorAll('.msgr-tabbar [role=tab]')].find((x) => /채팅|Chats/i.test(x.textContent))?.click(); }); await p.waitForTimeout(400);
const btn = p.locator('[data-sec="dms"] .msgr-sortbtn');
const box = await btn.boundingBox(); ok('정렬 버튼이 보인다(0×0 아님)', box && box.width >= 24 && box.height >= 24, box);
await btn.click(); await p.waitForTimeout(300);
const items = p.locator('[data-sec="dms"] .msgr-rowmenu [role=menuitemradio]');
ok('메뉴 항목 3개', (await items.count()) === 3, await items.count());
const menuBox = await p.locator('[data-sec="dms"] .msgr-rowmenu').boundingBox(); ok('메뉴가 화면 안(390px)에서 잘리지 않는다', menuBox && menuBox.x >= 0 && menuBox.x + menuBox.width <= 390, menuBox);
ok('기본 = 최근 메시지순', (await items.nth(0).getAttribute('aria-checked')) === 'true' && /최근/.test(await items.nth(0).innerText()), await items.nth(0).innerText());
await items.nth(2).click(); await p.waitForTimeout(300);
ok('이름순 선택 → 저장', (await p.evaluate(() => localStorage.getItem('argo-msgr-dm-sort'))) === 'name', await p.evaluate(() => localStorage.getItem('argo-msgr-dm-sort')));
ok('선택 뒤 메뉴 닫힘', (await p.locator('[data-sec="dms"] .msgr-rowmenu').count()) === 0);
await btn.click(); await p.waitForTimeout(200); ok('다시 열면 이름순에 체크', (await items.nth(2).getAttribute('aria-checked')) === 'true');
await p.touchscreen.tap(200, 600); await p.waitForTimeout(300); ok('바깥을 누르면 닫힌다(터치)', (await p.locator('[data-sec="dms"] .msgr-rowmenu').count()) === 0);
// 최근 메시지순이 화면에 닿는가(검수 N1): 부팅 전에 픽스처 저장소에 "더 최근 글을 가진 두 번째 DM"을 심은 새 페이지에서 첫 줄인지 본다(RPC msgr_dm_latest 흉내 → lastAt → 정렬)
{
  const p2 = await b.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await p2.route('**/*', (r) => (new URL(r.request().url()).hostname === '127.0.0.1' ? r.continue() : r.abort()));
  await p2.addInitScript(() => { localStorage.setItem('argo-lang', 'ko'); localStorage.setItem('argo-msgr-dm-sort', 'recent');
    let v; Object.defineProperty(window, '__dmFixture', { configurable: true, get: () => v, set: (x) => { v = x; try { const t = x.tables; const uid = t.msgr_channel_members.find((m) => m.member_kind === 'user').member_id; const dm = t.msgr_channels.find((c) => c.kind === 'dm'); const base = t.msgr_messages.find((m) => m.channel_id === dm.id) ?? t.msgr_messages[0];
      t.msgr_channels.push({ ...dm, id: 'fixture-dm-2', name: 'dm:Fixture Second' }); t.msgr_channel_members.push({ channel_id: 'fixture-dm-2', member_kind: 'user', member_id: uid }, { channel_id: 'fixture-dm-2', member_kind: 'crew', member_id: 'crew-new' });
      t.msgr_messages.push({ ...base, id: 9999, channel_id: 'fixture-dm-2', body: '더 최근 글', created_at: new Date(Date.now() + 60_000).toISOString(), deleted_at: null });
      t.msgr_channel_members.push({ channel_id: 'fixture-dm-2', member_kind: 'user', member_id: 'user-third' }, { channel_id: 'fixture-dm-2', member_kind: 'user', member_id: 'user-fourth' }); // 사람 3명 → 그룹 DM(필터 양성 검사)
      x.unreadRows = [{ channel_id: 'fixture-dm-2', n: 2, mention: 0 }]; // 안읽음 필터 양성 검사 — msgr_unread 흉내가 이 값을 돌려준다
    } catch (e) { console.error('seed failed', e); } } }); });
  await p2.goto(`http://127.0.0.1:${port}/test/work-panel.fixture.html`); await p2.locator('.msgr-shell.msgr-phone').waitFor();
  await p2.evaluate(() => { [...document.querySelectorAll('.msgr-tabbar [role=tab]')].find((x) => /채팅|Chats/i.test(x.textContent))?.click(); });
  await p2.waitForFunction(() => document.querySelectorAll('[data-sec="dms"] .item').length >= 2, null, { timeout: 8000 }).catch(() => {});
  await p2.waitForTimeout(600);
  const names = (await p2.locator('[data-sec="dms"] .item .name').allInnerTexts()).map((x) => x.trim());
  ok('더 최근 글을 가진 DM이 첫 줄(최근순이 RPC로 화면에 닿는다)', names.length >= 2 && /New/.test(names[0]) && /Existing/.test(names[1]), names);
  // 슬랙식 행(유건 2026-09-15): 마지막 글 한 줄 + 시각, 상단 필터 4개(전체·즐겨찾기·안읽음·그룹)가 목록 위
  const rows = await p2.evaluate(() => [...document.querySelectorAll('[data-sec="dms"] .item')].map((el) => ({ snip: el.querySelector('.snip')?.textContent ?? '', when: el.querySelector('.when')?.textContent ?? '' })));
  ok('행마다 마지막 글 한 줄과 시각', rows.length >= 2 && rows.every((r) => r.snip.length > 0 && /\d/.test(r.when)), rows);
  ok('내 글은 "나: " 접두', rows.some((r) => r.snip.startsWith('나: ')), rows);
  const filt = p2.locator('.msgr-dmfilter [role=radio]'); ok('필터 4개', (await filt.count()) === 4);
  ok('DM 탭 행에는 점 세 개 버튼이 없다(길게 누르기가 대신)', (await p2.locator('[data-sec="dms"] .msgr-railrow .more').count()) === 0);
  const fBox = await p2.locator('.msgr-dmfilter').boundingBox(); const lBox = await p2.locator('[data-sec="dms"]').boundingBox(); ok('필터가 목록 위에·화면 안', fBox && lBox && fBox.y < lBox.y && fBox.x + fBox.width <= 390, { fBox, lBox });
  const namesIn = () => p2.evaluate(() => [...document.querySelectorAll('[data-sec="dms"] .item .name')].map((el) => el.textContent.trim()));
  await filt.nth(2).click(); await p2.waitForTimeout(250); { const n = await namesIn(); ok('안읽음 필터: 안읽은 DM(New, n=2)만 남는다 — 양성 단언', n.length === 1 && /New/.test(n[0]), n); }
  await filt.nth(3).click(); await p2.waitForTimeout(250); { const n = await namesIn(); ok('그룹 필터: 사람 3명 DM(New)만 남는다 — 양성 단언', n.length === 1 && /New/.test(n[0]), n); }
  await filt.nth(1).click(); await p2.waitForTimeout(250); { const n = await namesIn(); ok('즐겨찾기 필터: 고정 없는 페이지에선 빈 목록', n.length === 0, n); }
  await filt.nth(0).click(); await p2.waitForTimeout(200); { const n = await namesIn(); ok('전체로 돌아오면 둘 다', n.length === 2, n); }
  // DM 안에서 좌우 스와이프 = 상단 거르개 탭 이동(유건 2026-09-15 교정: 하단 탭 이동이 아니다). 왼쪽으로 쓸면 다음 탭(전체→즐겨찾기), 오른쪽으로 쓸면 이전. 목록이 방향대로 들어온다
  { const cdp = await p2.context().newCDPSession(p2); const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
    let bb = await p2.locator('.msgr-railbody').boundingBox(); await p2.evaluate(() => { document.querySelector('.msgr-side .msgr-railbody').scrollTop = 1; });
    await touch('touchStart', bb.x + 300, bb.y + 200); await touch('touchMove', bb.x + 250, bb.y + 202); await touch('touchMove', bb.x + 150, bb.y + 204); await touch('touchEnd'); await p2.waitForTimeout(40);
    ok('거르개 전환 뒤 레일 스크롤은 맨 위(재검수 LOW: pickDmFilter 리셋 잠금)', (await p2.evaluate(() => document.querySelector('.msgr-side .msgr-railbody').scrollTop)) === 0);
    ok('DM에서 왼쪽으로 쓸면 다음 상단 탭(즐겨찾기)·하단 탭은 그대로 DM', await p2.evaluate(() => history.state?.page === 'dm' && document.querySelector('.msgr-dmfilter [aria-checked="true"]')?.textContent === '즐겨찾기'));
    ok('목록이 오른쪽에서 들어오는 애니메이션 클래스', await p2.evaluate(() => /anim-list-left-(a|b)/.test(document.querySelector('.msgr-railbody').className)));
    await p2.waitForTimeout(350); ok('260ms 뒤 해제', await p2.evaluate(() => !/anim-list-/.test(document.querySelector('.msgr-railbody').className)));
    bb = await p2.locator('.msgr-railbody').boundingBox();
    await touch('touchStart', bb.x + 100, bb.y + 200); await touch('touchMove', bb.x + 150, bb.y + 202); await touch('touchMove', bb.x + 260, bb.y + 204); await touch('touchEnd'); await p2.waitForTimeout(350);
    ok('오른쪽으로 쓸면 이전 탭(전체)', await p2.evaluate(() => document.querySelector('.msgr-dmfilter [aria-checked="true"]')?.textContent === '전체'));
    await touch('touchStart', bb.x + 100, bb.y + 200); await touch('touchMove', bb.x + 150, bb.y + 202); await touch('touchMove', bb.x + 260, bb.y + 204); await touch('touchEnd'); await p2.waitForTimeout(350);
    ok('첫 탭에서 오른쪽으로 쓸어도 하단 탭(홈)으로 새지 않는다', await p2.evaluate(() => history.state?.page === 'dm' && document.querySelector('.msgr-dmfilter [aria-checked="true"]')?.textContent === '전체'));
  }
  // 새 그룹 대화(유건 2026-09-15): + → 시트 → 둘 고르면 "그룹 대화 만들기" → 대화 열림
  { await p2.locator('.msgr-fab').click(); await p2.waitForTimeout(300); const rows = p2.locator('.msgr-dmgroup .pickrow');
    ok('그룹 시트에 멤버·크루 목록', (await rows.count()) >= 2); ok('선택 전 버튼 비활성', await p2.locator('.msgr-dmgroup .foot .btn').isDisabled());
    await rows.nth(0).click(); await rows.nth(1).click(); await p2.waitForTimeout(150);
    ok('둘 고르면 "그룹 대화 만들기"', /그룹 대화 만들기/.test(await p2.locator('.msgr-dmgroup .foot .btn').innerText()));
    await p2.locator('.msgr-dmgroup .foot .btn').click(); await p2.waitForTimeout(1000);
    ok('만들면 대화 화면·시트 닫힘', await p2.evaluate(() => history.state?.page === 'chat' && !document.querySelector('.msgr-dmgroup')));
    await p2.evaluate(() => history.back()); await p2.waitForTimeout(500);
    // 한 명만 고르면 1:1로 가고 시트는 닫힌다(검수 HIGH-1)
    await p2.locator('.msgr-fab').click(); await p2.waitForTimeout(300); await p2.locator('.msgr-dmgroup .pickrow').nth(0).click(); await p2.waitForTimeout(100);
    ok('한 명이면 버튼이 1:1', !/그룹 대화 만들기/.test(await p2.locator('.msgr-dmgroup .foot .btn').innerText()));
    await p2.locator('.msgr-dmgroup .foot .btn').click(); await p2.waitForTimeout(1000);
    ok('한 명 경로도 대화 열림·시트 닫힘', await p2.evaluate(() => history.state?.page === 'chat' && !document.querySelector('.msgr-dmgroup')));
    await p2.evaluate(() => history.back()); await p2.waitForTimeout(500);
    // 크루만 둘 고른 그룹(검수 HIGH-2): 이름은 두 크루를 나열하고 '그룹' 필터에 잡힌다
    await p2.locator('.msgr-fab').click(); await p2.waitForTimeout(300); const crewRows = p2.locator('.msgr-dmgroup .pickrow', { hasText: '내 크루' }); ok('내 크루 행 2개', (await crewRows.count()) >= 2);
    await crewRows.nth(0).click(); await crewRows.nth(1).click(); await p2.waitForTimeout(100); await p2.locator('.msgr-dmgroup .foot .btn').click(); await p2.waitForTimeout(1200);
    const gTitle = (await p2.locator('.msgr-top .title').innerText()).trim(); ok('크루 둘 그룹의 이름은 두 이름 나열', /Existing/.test(gTitle) && /New/.test(gTitle) && /,/.test(gTitle), gTitle);
    await p2.evaluate(() => history.back()); await p2.waitForTimeout(500); await filt.nth(3).click(); await p2.waitForTimeout(250);
    ok("크루만 둘인 방도 '그룹' 필터에", (await p2.locator('[data-sec="dms"] .item .name', { hasText: 'Existing' }).filter({ hasText: 'New' }).count()) === 1); await filt.nth(0).click(); await p2.waitForTimeout(200); }
  // 음소거 벨(검수 HIGH-1·재검수 L-2 — 마크업이 아니라 보이는지): 길게 눌러 '알림 끄기' → 벨이 폭을 가진다. 오래 눌렀다 떼도 메뉴가 유지된다(재검수 M-B)
  { const row = p2.locator('[data-sec="dms"] .msgr-railrow').first(); const bx = await row.boundingBox(); const cdp = await p2.context().newCDPSession(p2);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: bx.x + 60, y: bx.y + 20 }] }); await p2.waitForTimeout(2600);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await p2.waitForTimeout(300);
    ok('2.6초 눌렀다 떼도 메뉴 유지', (await p2.locator('.msgr-ctxmenu [role=menuitem]').count()) > 0);
    await p2.locator('.msgr-ctxmenu [role=menuitem]', { hasText: '알림 끄기' }).click(); await p2.waitForTimeout(500);
    const bell = await p2.locator('[data-sec="dms"] .msgr-railrow').first().locator('.item .mi').boundingBox(); ok('음소거 벨이 보인다(폰 DM 탭)', bell && bell.width > 0, bell); }
  // 길게 누르기 → 메뉴(미리보기 포함), 손을 떼도 메뉴 유지 → 미리보기 시트에 글이 보인다
  { const row = p2.locator('[data-sec="dms"] .msgr-railrow').first(); const bx = await row.boundingBox(); const cdp = await p2.context().newCDPSession(p2);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: bx.x + 60, y: bx.y + 20 }] }); await p2.waitForTimeout(600);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await p2.waitForTimeout(300);
    const menu = await p2.locator('.msgr-ctxmenu [role=menuitem]').allInnerTexts(); ok('길게 누르면 메뉴(손 떼도 유지)·첫 항목 대화 미리보기', menu[0] === '대화 미리보기' && menu.includes('즐겨찾기에 추가'), menu);
    await p2.locator('.msgr-ctxmenu [role=menuitem]', { hasText: '대화 미리보기' }).click(); await p2.waitForTimeout(800);
    const peek = await p2.evaluate(() => ({ open: !!document.querySelector('.msgr-dmpeek'), n: document.querySelectorAll('.msgr-dmpeek .pk').length })); ok('미리보기 시트에 최근 글', peek.open && peek.n >= 1, peek);
    await p2.locator('.msgr-dmpeek .btn', { hasText: '열기' }).click(); await p2.waitForTimeout(500); ok('열기 → 대화 화면', await p2.evaluate(() => history.state?.page === 'chat'));
  }
  await p2.close();
}
// 정렬 메뉴 글자가 잘리지 않는다(iOS 실측 2026-09-15: 절대 배치 메뉴가 26px 래퍼 폭에 갇혀 130px) — 항목 글자 폭 ≤ 메뉴 폭
await btn.click(); await p.waitForTimeout(200);
{ const menuW = (await p.locator('[data-sec="dms"] .msgr-rowmenu').boundingBox()).width; const textW = await items.nth(1).evaluate((el) => el.scrollWidth); ok('메뉴 폭이 가장 긴 항목보다 넓다', menuW >= 160 && textW <= menuW, { menuW, textW }); }
await p.touchscreen.tap(200, 600); await p.waitForTimeout(200);
// 즐겨찾기 → DM 탭 잔류 + "고정" 단락으로 이동(별 아이콘 없음)
const dmItem = p.locator('[data-sec="dms"] .item').first(); const name = (await dmItem.locator('.name').innerText()).trim();
await dmItem.dispatchEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 300 }); await p.waitForTimeout(300);
await p.locator('button', { hasText: '즐겨찾기에 추가' }).first().click(); await p.waitForTimeout(500);
const pinnedSec = p.locator('[data-sec="dmpin"]'); const pinnedBox = await pinnedSec.boundingBox(); ok('고정 단락이 보인다', pinnedBox && pinnedBox.height > 0, pinnedBox);
ok('즐겨찾기한 DM은 고정 단락에', (await pinnedSec.locator('.item .name', { hasText: name }).count()) === 1);
ok('1:1 대화 단락에서는 빠진다', (await p.locator('[data-sec="dms"] .item .name', { hasText: name }).count()) === 0);
ok('별 아이콘 없음', (await p.locator('.msgr-dmpin').count()) === 0);
// 홈에서 1:1 대화를 접어도 DM 탭에서는 펼쳐져 있다(유건 제보 2026-09-15)
await p.evaluate(() => { localStorage.setItem('argo-msgr-rail-fold', JSON.stringify({ dms: true })); document.querySelector('[data-sec="dms"]').open = false; });
await p.waitForTimeout(200);
ok('DM 탭의 1:1 대화 단락은 접히지 않는다', await p.evaluate(() => document.querySelector('[data-sec="dms"]').open === true));
await p.evaluate(() => { [...document.querySelectorAll('.msgr-tabbar [role=tab]')][0].click(); }); await p.waitForTimeout(400);
ok('홈 즐겨찾기에도 있다', (await p.locator('[data-sec="fav"] .item .name', { hasText: name }).count()) === 1);
await p.setViewportSize({ width: 1280, height: 800 }); await p.waitForTimeout(600);
ok('데스크톱에는 정렬 버튼 없음', (await p.locator('[data-sec="dms"] .msgr-sortbtn').count()) === 0);
} finally { await b.close(); }
console.log(`${checks.length} dm sort/pin checks passed`);
