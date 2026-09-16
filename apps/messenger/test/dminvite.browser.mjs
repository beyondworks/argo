// 대화방에 사람·에이전트를 부르고, 에이전트 묶음을 접는다(유건 2026-09-16).
// 소스 핀만으로는 화면이 죽은 것을 못 잡는다(실측 2026-09-16: isPersonal 미전달로 개인 공간 전멸) — 실제 화면에서 눌러 본다.
// 실행: node node_modules/vite/bin/vite.js --config test/dminvite.config.mjs (포트 5202) 뒤
//       PLAYWRIGHT_MODULE=<playwright index.mjs> node test/dminvite.browser.mjs
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' });
const URL_BASE = `http://127.0.0.1:${process.env.DMINVITE_TEST_PORT || 5202}/test/dminvite.fixture.html`;
const results = []; const failures = [];

async function scenario(width, name, run) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 160)));
  try {
    await page.goto(URL_BASE, { waitUntil: 'load' });
    await page.waitForSelector('.msgr-rail, .msgr-shell', { timeout: 10_000 });
    await page.waitForTimeout(900);
    await run(page);
    assert.deepEqual(errors, [], `페이지 오류 없음: ${errors.join(' | ')}`);
    results.push(`${width} ${name} PASS`);
  } catch (e) { failures.push(`${width}/${name}: ${String(e.message).slice(0, 220)}`); } finally { await page.close(); }
}

const openDmSheet = async (p) => {
  await p.locator('.msgr-list').locator('button', { hasText: 'Org Colleague' }).first().click();
  await p.waitForTimeout(500);
  await p.locator('.msgr-top .title, .msgr-top button.title').first().click(); // 제목을 누르면 방 설정
  await p.locator('.msgr-crewsheet').waitFor({ timeout: 5000 });
};

// 1. 1:1 대화방에서도 '추가'가 열린다 — 종전에는 항목 자체가 없었다
await scenario(1280, 'dm-add-menu', async (p) => {
  await openDmSheet(p);
  await p.locator('.msgr-addwrap button', { hasText: '추가' }).first().click();
  const menu = await p.locator('.msgr-addmenu').innerText();
  assert.ok(menu.includes('사람 더 부르기'), `사람 초대 항목 (실제: ${menu})`);
  assert.ok(menu.includes('에이전트'), `에이전트 초대 항목 (실제: ${menu})`);
});

// 2. 사람을 고르면 지금 방에 끼워 넣지 않고 새 방을 연다
await scenario(1280, 'dm-widen-opens-new-room', async (p) => {
  await openDmSheet(p);
  await p.locator('.msgr-addwrap button', { hasText: '추가' }).first().click();
  await p.locator('.msgr-addmenu button', { hasText: '사람 더 부르기' }).click();
  await p.locator('.msgr-chips .msgr-chan', { hasText: 'Third Person' }).click();
  await p.waitForTimeout(800);
  const calls = await p.evaluate(() => window.__dmInviteFixture.calls);
  const created = calls.filter((c) => c.rpc === 'msgr_create_channel');
  assert.equal(created.length, 1, `새 방을 여는 호출 한 번 (실제: ${created.length})`);
  const pushed = calls.filter((c) => c.table === 'msgr_channel_members' && (c.op === 'upsert' || c.op === 'insert') && [].concat(c.values ?? []).some((v) => v.member_kind === 'user' && v.channel_id === 'org-dm'));
  assert.equal(pushed.length, 0, '옛 방에 사람을 밀어 넣지 않는다');
});

// 3. 에이전트 묶음은 접힌다
await scenario(1280, 'agent-groups-fold', async (p) => {
  const fold = p.locator('.msgr-fold').first();
  await fold.waitFor({ timeout: 5000 });
  assert.ok(await fold.evaluate((el) => el.open), '처음에는 펼쳐져 있다');
  const firstRow = fold.locator('.msgr-folder .item').first();
  assert.ok(await firstRow.isVisible(), '묶음 안의 에이전트가 보인다');
  await fold.locator('summary').click();
  await p.waitForTimeout(300);
  assert.equal(await fold.evaluate((el) => el.open), false, '머리를 누르면 접힌다');
  assert.equal(await firstRow.isVisible(), false, '접으면 목록이 사라진다');
  await p.reload({ waitUntil: 'load' });
  await p.waitForTimeout(900);
  assert.equal(await p.locator('.msgr-fold').first().evaluate((el) => el.open), false, '다시 열어도 접어 둔 대로 남는다');
});

// 4. PC에서도 '새 대화'로 시작할 수 있다 — 종전에는 폰에만 있었다
await scenario(1280, 'new-conversation-button', async (p) => {
  await p.locator('[aria-label="새 채팅"]').first().click();
  await p.waitForTimeout(400);
  const sheet = await p.locator('.msgr-sheetwrap, .msgr-crewsheet').first().innerText();
  assert.ok(/사람|크루|고르/.test(sheet), `상대를 고르는 화면이 열린다 (실제: ${sheet.slice(0, 120)})`);
});

// 5. 폰 DM 탭 — 정렬과 '새 대화'가 나란히 눌린다(겹치거나 밀리지 않게)
await scenario(390, 'phone-dm-actions', async (p) => {
  await p.locator('nav button, [class*=tab] button').filter({ hasText: /^채팅$/ }).first().click();
  await p.waitForTimeout(600);
  const btn = p.locator('[aria-label="새 채팅"]').first();
  await btn.waitFor({ timeout: 5000 });
  const box = await btn.boundingBox();
  assert.ok(box && box.width >= 20 && box.x >= 0 && box.x + box.width <= 390, `버튼이 화면 안에 온전히 있다 (실제: ${JSON.stringify(box)})`);
  await btn.click();
  await p.waitForTimeout(400);
  assert.ok(await p.locator('.msgr-sheetwrap, .msgr-crewsheet').first().isVisible(), '눌러서 상대 고르는 화면이 열린다');
});

// 6. 여럿이 있는 방은 누구 한 사람의 얼굴로 굳지 않는다 — 이름은 함께 있는 모두를 보여 준다
await scenario(1280, 'group-room-avatar', async (p) => {
  const row = p.locator('.msgr-list .item').filter({ hasText: 'Fixture Agent' }).first();
  await row.waitFor({ timeout: 5000 });
  const label = await row.innerText();
  for (const who of ['Fixture Agent', 'External Bot', 'Org Colleague', 'Third Person']) assert.ok(label.includes(who), `${who}가 이름에 있다 (실제: ${label})`);
  const cls = await row.locator('.msgr-av').first().getAttribute('class');
  assert.ok(!/\bcrew\b/.test(cls ?? ''), `한 에이전트의 얼굴로 굳지 않는다 (실제 class: ${cls})`);
});

// 7. 새 그룹 창(PC) — 제목은 한 줄, 고르는 행은 검색칸 아래로 한 줄씩(유건 제보 2026-09-16: 행이 검색칸 옆으로 흘렀다)
await scenario(1280, 'group-sheet-layout', async (p) => {
  await p.locator('[aria-label="새 채팅"]').first().click();
  const sheet = p.locator('.msgr-dmgroup'); await sheet.waitFor({ timeout: 5000 });
  const m = await sheet.evaluate((el) => { const h = el.querySelector('.head strong'); const inp = el.querySelector('input.msgr-input'); const rows = [...el.querySelectorAll('.pickrow')].map((r) => r.getBoundingClientRect()); return { titleH: h.getBoundingClientRect().height, lineH: parseFloat(getComputedStyle(h).lineHeight) || 20, inputBottom: inp.getBoundingClientRect().bottom, inputW: inp.getBoundingClientRect().width, sheetW: el.getBoundingClientRect().width, tops: rows.map((r) => r.top) }; });
  assert.ok(m.titleH < m.lineH * 1.5, `제목이 한 줄이다 (높이 ${m.titleH}, 줄 ${m.lineH})`);
  assert.ok(m.tops.length >= 3, `고를 행이 셋 이상 (실제 ${m.tops.length})`);
  assert.ok(m.tops.every((t) => t >= m.inputBottom - 1), `모든 행이 검색칸 아래에 있다 (검색칸 아래 ${m.inputBottom}, 행 ${m.tops})`);
  assert.equal(new Set(m.tops.map(Math.round)).size, m.tops.length, `행마다 줄이 다르다 (${m.tops})`);
  assert.ok(m.inputW > m.sheetW * 0.8, `검색칸이 창 폭을 쓴다 (${m.inputW} / ${m.sheetW})`);
});

// 8. 채널 그룹은 없다(유건 2026-09-16, 라이브 사용 0명) — 예전에 저장된 그룹 값이 남아 있어도 채널은 한 목록, 메뉴에 그룹 항목이 없다
await scenario(1280, 'no-channel-groups', async (p) => {
  const sec = p.locator('[data-sec="channels"]'); await sec.waitFor({ timeout: 5000 });
  const text = await sec.innerText();
  assert.ok(!/Group \d+/.test(text), `그룹 머리가 없다 (실제: ${text.slice(0, 120)})`);
  assert.ok(text.includes('Folder Room 1') && text.includes('Folder Room 12'), '채널은 모두 한 목록에 있다');
  assert.equal(await sec.locator('.msgr-folder').count(), 0, '그룹 묶음 요소가 없다');
  await p.locator('.msgr-list button.item', { hasText: 'Folder Room 1' }).first().click({ button: 'right' });
  const menu = p.locator('.msgr-ctxmenu'); await menu.waitFor({ timeout: 5000 });
  const items = await menu.locator('[role=menuitem]').allInnerTexts();
  assert.ok(!items.some((x) => /그룹/.test(x)), `메뉴에 그룹 항목이 없다 (${items})`);
  assert.ok((await menu.evaluate((el) => el.getBoundingClientRect().height)) <= 441, '메뉴는 440px 안');
});

// 9. '1:1 대화' → '채팅'(유건 2026-09-16) — 여럿이 있는 방도 담는 자리의 이름
await scenario(1280, 'chats-label', async (p) => {
  assert.equal((await p.locator('[data-sec="dms"] > summary .lbl').innerText()).trim(), '채팅');
});

// 10. 공개 채널 설정 — 참여한 사람만 보이고, 초대하고, 내보내면 참여도 끝난다(유건 제보 2026-09-16: 참여 안 한 사람까지 떴고 초대가 없었다)
await scenario(1280, 'public-channel-people', async (p) => {
  await p.locator('.msgr-list button.item', { hasText: 'Fixture General' }).first().click(); await p.waitForTimeout(500);
  await p.locator('.msgr-top button.members').click();
  const sheet = p.locator('.msgr-crewsheet'); await sheet.waitFor({ timeout: 5000 });
  const people = () => sheet.locator('.msgr-rows .row').evaluateAll((rs) => rs.filter((r) => !r.querySelector('.msgr-av.crew') && !r.closest('.msgr-excluded')).map((r) => r.querySelector('.name')?.innerText));
  assert.deepEqual(await people(), ['Fixture Owner'], '참여한 사람만 — 조직원 전원이 아니다');
  assert.match(await sheet.locator('.note').first().innerText(), /참여한 사람만/, '안내가 참여 기준을 말한다');
  await sheet.locator('.msgr-addwrap button', { hasText: '추가' }).first().click();
  await sheet.locator('.msgr-addmenu button', { hasText: '사람 추가' }).click();
  await sheet.locator('.msgr-chips .msgr-chan', { hasText: 'Third Person' }).click(); await p.waitForTimeout(700);
  const calls = () => p.evaluate(() => window.__dmInviteFixture.calls);
  assert.ok((await calls()).some((c) => c.table === 'msgr_channel_members' && c.op === 'upsert' && [].concat(c.values).some((v) => v.channel_id === 'general' && v.member_kind === 'user' && v.member_id === 'user-third')), '공개 채널에 초대한다');
  assert.ok((await people()).includes('Third Person'), '초대한 사람이 목록에 들어온다');
  const row = sheet.locator('.msgr-rows .row', { hasText: 'Third Person' }).first();
  await row.locator('button[aria-label]').first().click();
  await sheet.locator('.msgr-rowmenu button.danger').first().click(); await p.waitForTimeout(700);
  const cs = await calls();
  assert.ok(cs.some((c) => c.table === 'msgr_channels' && c.op === 'update' && (c.values?.excluded_user_ids ?? []).includes('user-third')), '내보내면 제외 목록에 든다');
  assert.ok(cs.some((c) => c.table === 'msgr_channel_members' && c.op === 'delete'), '참여 행도 지운다(목록에 남아 안 열리는 채널이 되지 않게)');
});

// 11. 참여하지 않은 공개 채널을 열면 미리보기 — 입력창 자리에 참여 버튼, 참여하면 목록에 들어온다(유건 검수 2026-09-16: 알림함에서 열면 안내 화면이 떴다)
await scenario(1280, 'unjoined-preview', async (p) => {
  const rail = () => p.locator('[data-sec="channels"]').innerText();
  assert.ok(!(await rail()).includes('Open Lounge'), '처음에는 목록에 없다');
  await p.locator('.msgr-search input').fill('Lounge'); await p.keyboard.press('Enter'); await p.waitForTimeout(700);
  await p.locator('.msgr-inboxrow', { hasText: 'Lounge note' }).first().click(); await p.waitForTimeout(700);
  assert.match(await p.locator('.msgr-top .title').first().innerText(), /Open Lounge/, '그 채널이 열린다(안내 화면이 아니다)');
  assert.ok((await p.locator('main, .msgr-main').first().innerText()).includes('Lounge note'), '글이 보인다');
  const bar = p.locator('.msgr-joinbar'); await bar.waitFor({ timeout: 3000 });
  assert.equal(await p.locator('.msgr-composer textarea, .msgr-compose textarea').count(), 0, '참여 전에는 입력창이 없다');
  await p.waitForTimeout(16000); // 주기 재조회(15초)가 지나도 첫 채널로 튕기지 않는다
  assert.match(await p.locator('.msgr-top .title').first().innerText(), /Open Lounge/, '재조회 뒤에도 그 채널에 머문다');
  await bar.locator('button').click(); await p.waitForTimeout(900);
  const calls = await p.evaluate(() => window.__dmInviteFixture.calls);
  assert.ok(calls.some((c) => c.rpc === 'msgr_join_channel' && c.args?.ch === 'open-2'), '참여를 요청한다');
  assert.equal(await p.locator('.msgr-joinbar').count(), 0, '참여하면 참여 바가 사라진다');
  assert.ok((await rail()).includes('Open Lounge'), '목록에 들어온다');
});

await browser.close();
console.log(results.join('\n'));
if (failures.length) { console.log(`${results.length} passed, ${failures.length} failed`); console.log('Failures:', failures); process.exit(1); }
console.log(`${results.length} passed, 0 failed`);
