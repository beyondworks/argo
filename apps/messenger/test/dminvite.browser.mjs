// 대화방에 사람·에이전트를 부르고, 에이전트 묶음을 접는다(유건 2026-09-16).
// 소스 핀만으로는 화면이 죽은 것을 못 잡는다(실측 2026-09-16: isPersonal 미전달로 개인 공간 전멸) — 실제 화면에서 눌러 본다.
// 실행: node node_modules/vite/bin/vite.js --config test/dminvite.config.mjs (포트 5202) 뒤
//       PLAYWRIGHT_MODULE=<playwright index.mjs> node test/dminvite.browser.mjs
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' });
const URL_BASE = `http://127.0.0.1:${process.env.DMINVITE_TEST_PORT || 5202}/test/dminvite.fixture.html`;
const results = []; const failures = [];

async function scenario(width, name, run, query = '') {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 160)));
  try {
    await page.goto(URL_BASE + query, { waitUntil: 'load' });
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
  assert.match(await sheet.locator('.note').first().innerText(), /참여한 사람/, '안내가 참여 기준을 말한다');
  await sheet.locator('.msgr-addwrap button', { hasText: '추가' }).first().click();
  await sheet.locator('.msgr-addmenu button', { hasText: '사람 추가' }).click();
  await sheet.locator('.msgr-chips .msgr-chan', { hasText: 'Third Person' }).click(); await p.waitForTimeout(700);
  const calls = () => p.evaluate(() => window.__dmInviteFixture.calls);
  assert.ok((await calls()).some((c) => c.table === 'msgr_channel_members' && c.op === 'upsert' && [].concat(c.values).some((v) => v.channel_id === 'general' && v.member_kind === 'user' && v.member_id === 'user-third')), '공개 채널에 초대한다');
  assert.ok((await people()).includes('Third Person'), '초대한 사람이 목록에 들어온다');
  const row = sheet.locator('.msgr-rows .row', { hasText: 'Third Person' }).first();
  await row.locator('button[aria-label]').first().click();
  await p.locator('.msgr-ctxmenu button.danger').first().click(); await p.waitForTimeout(700);
  const cs = await calls();
  assert.ok(cs.some((c) => c.table === 'msgr_channels' && c.op === 'update' && (c.values?.excluded_user_ids ?? []).includes('user-third')), '내보내면 제외 목록에 든다');
  assert.ok(cs.some((c) => c.table === 'msgr_channel_members' && c.op === 'delete'), '참여 행도 지운다(목록에 남아 안 열리는 채널이 되지 않게)');
  // D30: 되돌리기는 참여 행까지 되살린다 — 종전에는 제외 목록만 비우고 "다시 들어왔습니다"라고 했으나 목록에는 없었다
  const restoreBtn = () => sheet.locator('.row', { hasText: 'Third Person' }).locator('button', { hasText: '되돌리기' });
  const memberRow = () => p.evaluate(() => window.__dmInviteFixture.tables.msgr_channel_members.some((r) => r.channel_id === 'general' && r.member_kind === 'user' && r.member_id === 'user-third'));
  const excluded = () => p.evaluate(() => window.__dmInviteFixture.tables.msgr_channels.find((c) => c.id === 'general').excluded_user_ids ?? []);
  assert.equal(await memberRow(), false, '내보낸 뒤에는 참여 행이 없다');
  // 되살리기가 실패하면 성공 알림도, 제외 해제도 없다
  await p.evaluate(() => { window.__dmInviteFixture.failNext = 'msgr_channel_members:upsert'; });
  await restoreBtn().click(); await p.waitForTimeout(700);
  const toastFail = await p.locator('.msgr-toast').innerText().catch(() => '');
  assert.ok(!toastFail.includes('다시 들어왔습니다'), `실패하면 성공 알림이 없다 (실제: ${toastFail})`);
  assert.ok((await excluded()).includes('user-third'), '실패하면 제외 목록도 그대로');
  await p.locator('.msgr-toast').click().catch(() => {});
  await restoreBtn().click(); await p.waitForTimeout(700);
  assert.equal(await memberRow(), true, '되돌리면 참여 행이 다시 생긴다');
  assert.ok(!(await excluded()).includes('user-third'), '제외 목록에서 빠진다');
  assert.ok((await people()).includes('Third Person'), '참여자 목록으로 돌아온다');
  assert.ok((await p.evaluate(() => window.__dmInviteFixture.tables.msgr_channel_members.some((r) => r.channel_id === 'general' && r.member_id === 'user-me'))), '다른 참여 행을 덮어쓰지 않는다');
});

// D16. 참여한 공개 채널에서도 나갈 수 있다(정비사 원장 P1-23 — 종전엔 비공개만 '채널 나가기')
await scenario(1280, 'leave-public-channel', async (p) => {
  await p.locator('.msgr-list button.item', { hasText: 'Fixture General' }).first().click({ button: 'right' });
  const menu = p.locator('.msgr-ctxmenu'); await menu.waitFor({ timeout: 5000 });
  const items = await menu.locator('[role=menuitem]').allInnerTexts();
  assert.ok(items.some((x) => x.includes('채널 나가기')), `공개 채널 메뉴에 나가기 (실제: ${items})`);
  await menu.locator('[role=menuitem]', { hasText: '채널 나가기' }).click();
  const dlg = p.locator('.msgr-action-dialog'); await dlg.waitFor({ timeout: 5000 });
  assert.match(await dlg.innerText(), /찾아보기/, '공개 채널 안내 — 찾아보기로 다시 들어올 수 있다(초대가 필요하다고 하지 않는다)');
  assert.doesNotMatch(await dlg.innerText(), /초대가 필요/, '비공개용 문구가 아니다');
  await dlg.locator('button', { hasText: '채널 나가기' }).last().click(); await p.waitForTimeout(900);
  const calls = await p.evaluate(() => window.__dmInviteFixture.calls);
  assert.ok(calls.some((c) => c.table === 'msgr_channel_members' && c.op === 'delete'), '내 참여 행을 지운다');
  assert.ok(!(await p.locator('[data-sec="channels"]').innerText()).includes('Fixture General'), '목록에서 빠진다');
});
// D35. 상대(사람)가 모두 빠진 대화 — 새 1:1·에이전트 DM과 같은 이름으로 보이지 않는다(정비사 원장 P6-3, 검수 R1~R6)
await scenario(1280, 'vacated-dm-label', async (p) => {
  const rows = await p.locator('[data-sec="dms"] button.item').evaluateAll((bs) => bs.map((b) => ({ name: b.querySelector('.name')?.innerText.trim(), tag: !!b.querySelector('.msgr-vacated') })));
  const tagOf = (name) => { const r = rows.find((x) => x.name === name); assert.ok(r, `행 ${name} 있음 (실제: ${JSON.stringify(rows)})`); return r.tag; };
  assert.equal(tagOf('Gone Person'), true, 'R1 사람이 빠진 1:1 — 표지');
  assert.equal(tagOf('Gone Person With A Rather Long Display Name, Fixture Agent'), true, 'R2 사람이 빠지고 에이전트만 남은 그룹 — 표지');
  const third = rows.filter((x) => x.name === 'Third Person').map((x) => x.tag).sort();
  assert.deepEqual(third, [false, true], `R6(1:1에 에이전트를 더한 뒤 사람이 빠진 방)는 표지, R5(사람 그룹에서 한 명만 빠져 남은 사람 이름으로 보이는 방)는 표지 없음 (실제: ${third})`);
  assert.equal(tagOf('Colleague Agent'), true, '남의 에이전트만 남은 방 = 그 주인이 빠짐 — 표지');
  assert.equal(tagOf('Departed Person'), true, 'R6 변형 — 상대가 재가입하지 않고 조직을 떠나 멤버 이름이 없어도, 크루가 나중에 들어온 방이면 표지');
  assert.equal(tagOf('Fixture Agent'), false, 'R3 에이전트 1:1 — 표지 없음');
  assert.equal(tagOf('Second Agent'), false, '내 에이전트 이름이 바뀐 1:1 — 표지 없음(새 이름)');
  // 데스크톱 폭에서 긴 이름은 말줄임되어도 표지는 온전히 보인다(검수 조건 1)
  const fit = await p.locator('[data-sec="dms"] button.item', { hasText: 'Rather Long' }).first().evaluate((b) => { const tag = b.querySelector('.msgr-vacated').getBoundingClientRect(); const box = b.getBoundingClientRect(); const name = b.querySelector('.name'); return { tagW: tag.width, inside: tag.right <= box.right + 0.5, clipped: name.scrollWidth > name.clientWidth }; });
  assert.ok(fit.tagW > 20 && fit.inside, `표지가 행 안에 보인다 ${JSON.stringify(fit)}`);
  assert.ok(fit.clipped, '이름만 말줄임된다');
  await p.locator('[data-sec="dms"] button.item', { hasText: 'Gone Person' }).first().click(); await p.waitForTimeout(500);
  assert.match(await p.locator('.msgr-top').first().innerText(), /나간 대화/, '열어도 제목에 표지가 있다');
}, '?vacated=1');

// D14·D42. 방 밖 에이전트를 @로 부르면 글은 평문으로 가고 안내가 뜬다 — 남의 에이전트는 [1:1로 시키기]가 주인과의 1:1을 열어 본문을 옮긴다
// (종전: 무안내 40초 침묵 / 남의 에이전트 1:1은 msgr_bad_member 원문). 내 에이전트는 [이 방에 추가 요청]도.
await scenario(1280, 'outside-mention-notice', async (p) => {
  await p.locator('.msgr-list button.item', { hasText: 'Fixture General' }).first().click(); await p.waitForTimeout(500);
  const ta = p.locator('.msgr-composer textarea');
  await ta.fill('@Colleague Agent 표 정리 부탁'); await ta.press('Escape'); await ta.press('Enter'); await p.waitForTimeout(800);
  const chip = p.locator('.msgr-outsidechip'); await chip.waitFor({ timeout: 3000 });
  assert.match(await chip.innerText(), /Colleague Agent은\(는\) 이 방에 없어요/);
  assert.equal(await chip.locator('button', { hasText: '1:1로 시키기' }).count(), 1, '허용 all → 1:1로 시키기');
  assert.equal(await chip.locator('button', { hasText: '이 방에 추가 요청' }).count(), 0, '남의 에이전트는 추가 요청 없음(주인만 데려온다)');
  const sent = await p.evaluate(() => window.__dmInviteFixture.calls.filter((c) => c.table === 'msgr_messages' && c.op === 'insert').map((c) => [].concat(c.values)[0]).at(-1));
  assert.deepEqual(sent?.mentions ?? [], [], '글은 평문(멘션 없음) — 방 밖 에이전트에게 배달하지 않는다');
  await chip.locator('button', { hasText: '1:1로 시키기' }).click(); await p.waitForTimeout(900);
  assert.match(await p.locator('.msgr-top').first().innerText(), /Org Colleague/, '주인(Org Colleague)과의 1:1이 열린다(크루를 DM에 넣지 않는다)');
  assert.equal(await p.locator('.msgr-composer textarea').inputValue(), '@Colleague Agent 표 정리 부탁', '보낸 본문이 입력창에 옮겨져 있다');
  const created = await p.evaluate(() => window.__dmInviteFixture.calls.filter((c) => c.rpc === 'msgr_create_channel'));
  assert.equal(created.length, 0, '기존 1:1을 쓴다 — 크루 동반 DM 생성(msgr_bad_member 경로)을 부르지 않는다');
  // 내 에이전트: 1:1 + 이 방에 추가 요청
  await p.locator('.msgr-list button.item', { hasText: 'Fixture General' }).first().click(); await p.waitForTimeout(500);
  await ta.fill('@Fixture Agent 여기서도'); await ta.press('Escape'); await ta.press('Enter'); await p.waitForTimeout(800);
  assert.equal(await chip.locator('button', { hasText: '이 방에 추가 요청' }).count(), 1, '내 에이전트는 추가 요청');
  await chip.locator('button', { hasText: '이 방에 추가 요청' }).click(); await p.waitForTimeout(700);
  const joins = await p.evaluate(() => window.__dmInviteFixture.calls.filter((c) => c.rpc === 'msgr_crew_join'));
  assert.ok(joins.some((c) => c.args?.crew === 'crew-1' && c.args?.ch === 'general'), '기존 에이전트 참여 경로(msgr_crew_join)로 요청');
});

// D31(원장 P2-8). 파견을 해제했다가 다시 파견하면 허용 범위가 조직 기본값으로 조용히 바뀌었다(「모두」→「에이전트 주인만」).
// available = 소유자가 해제한 상태이므로 다시 파견은 복귀 — status만 바꾸고 허용 범위는 그대로. 레일의 [파견]과 에이전트 시트의 [파견하기] 두 경로.
for (const via of ['rail', 'sheet']) await scenario(1280, `redispatch-keeps-allow-${via}`, async (p) => {
  const row = p.locator('.msgr-list .item', { hasText: 'Second Agent' }).first(); await row.waitFor({ timeout: 5000 });
  if (via === 'rail') await p.locator('.msgr-list button.dispatch').first().click();
  else {
    await row.click(); const sheet = p.locator('.msgr-sheet, [role=dialog]').filter({ hasText: 'Second Agent' }).first(); await sheet.waitFor({ timeout: 5000 });
    await sheet.getByRole('button', { name: '파견하기', exact: true }).click();
  }
  await p.waitForFunction(() => window.__dmInviteFixture.tables.msgr_crews.find((c) => c.id === 'crew-3').status === 'active', undefined, { timeout: 5000 });
  const crew = await p.evaluate(() => window.__dmInviteFixture.tables.msgr_crews.find((c) => c.id === 'crew-3'));
  assert.deepEqual([crew.allow, crew.allow_users], ['list', ['user-colleague']], '허용 범위와 지정한 사람이 그대로');
  const upd = await p.evaluate(() => window.__dmInviteFixture.calls.filter((c) => c.table === 'msgr_crews' && c.op === 'update').map((c) => Object.keys(c.values ?? {})));
  assert.deepEqual(upd.at(-1), ['status'], `파견은 status만 바꾼다 (실제: ${JSON.stringify(upd)})`);
  assert.deepEqual(await p.evaluate(() => window.__dmInviteFixture.tables.msgr_crews.filter((c) => c.id !== 'crew-3').map((c) => c.status)), ['active', 'active', 'active'], '다른 에이전트는 건드리지 않는다');
  if (via === 'sheet') assert.match(await p.locator('body').innerText(), /허용 범위는 그대로이고, 채널에는 채널의 "\+ 추가"에서 다시 넣으세요/, '다시 넣어야 하는 채널을 안내');
}, '?recalled=1');

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

// ── 에이전트 참여 = 초대된 것만, 참여자는 방장 승인(유건 2026-09-16) ──
const openGeneralSheet = async (p) => {
  await p.locator('.msgr-list button.item', { hasText: 'Fixture General' }).first().click(); await p.waitForTimeout(500);
  await p.locator('.msgr-top button.members').click();
  const sheet = p.locator('.msgr-crewsheet'); await sheet.waitFor({ timeout: 5000 }); return sheet;
};
const crewRows = (sheet) => sheet.locator('.msgr-rows .row:not(.req)').evaluateAll((rs) => rs.filter((r) => r.querySelector('.msgr-av.crew')).map((r) => r.querySelector('.name')?.innerText));

// 12. 공개 채널에 파견된 에이전트가 저절로 들어와 있지 않다(종전: 조직 에이전트 전원)
await scenario(1280, 'public-no-auto-crews', async (p) => {
  const sheet = await openGeneralSheet(p);
  assert.deepEqual(await crewRows(sheet), [], `초대된 에이전트만 — 아무도 초대하지 않았다 (실제: ${await crewRows(sheet)})`);
  assert.equal(await p.locator('.msgr-top button.members .msgr-av.crew').count(), 0, '채널 머리에도 에이전트 얼굴이 없다');
  await sheet.locator('button', { hasText: '채널 설정' }).first().click(); await p.waitForTimeout(300); // 정책 칸은 접힌 설정 안에 있다
  const seg = await sheet.locator('[role="radio"]').allInnerTexts();
  for (const w of ['바로 추가', '방장 승인', '못 데려옴']) assert.ok(seg.some((x) => x.includes(w)), `정책 칸 '${w}' (실제: ${seg})`);
  assert.equal(await sheet.locator('[role="radio"][aria-checked="true"]').innerText(), '방장 승인', '기본은 방장 승인');
});

// 13. 방장 — 에이전트를 바로 넣고, 멤버의 요청을 허락한다
await scenario(1280, 'host-adds-and-approves', async (p) => {
  const sheet = await openGeneralSheet(p);
  const req = sheet.locator('.row.req', { hasText: 'Colleague Agent' });
  assert.match(await req.innerText(), /Org Colleague님이 데려오려 합니다/, '들어오려는 에이전트와 요청한 사람');
  await req.locator('button', { hasText: '허락' }).click(); await p.waitForTimeout(700);
  const calls = () => p.evaluate(() => window.__dmInviteFixture.calls);
  assert.ok((await calls()).some((c) => c.rpc === 'msgr_crew_join_decide' && c.args.req === 'req-1' && c.args.approve === true), '허락을 서버에 보낸다');
  assert.ok((await crewRows(sheet)).includes('Colleague Agent'), '허락하면 구성에 들어온다');
  assert.equal(await sheet.locator('.row.req').count(), 0, '요청 행이 사라진다');
  await sheet.locator('.msgr-addwrap button', { hasText: '추가' }).first().click();
  await sheet.locator('.msgr-addmenu button', { hasText: '에이전트 추가' }).click();
  // 칩이 아니라 목록 + 여러 명 선택(유건 2026-09-17)
  const list = sheet.locator('.msgr-picklist'); await list.waitFor();
  assert.equal(await sheet.locator('.msgr-chips .msgr-chan').count(), 0, '에이전트 칩은 없다(사람 추가는 별개)');
  const chip = list.locator('.pickrow', { hasText: 'Fixture Agent' });
  // 방장이어도 후보는 내 에이전트와 회사 에이전트만 — 동료의 에이전트(External Bot)는 주인이 데려온다(유건 2026-09-17: 친구 에이전트까지 전부 떠 목록이 두 배)
  assert.equal(await list.locator('.pickrow', { hasText: 'External Bot' }).count(), 0, '남의 에이전트는 추가 후보가 아니다');
  assert.doesNotMatch(await chip.innerText(), /승인 필요/, '방장에게는 승인 필요 표시가 없다');
  const submit = sheet.locator('.msgr-addwrap .acts .btn-primary');
  assert.ok(await submit.isDisabled(), '고르기 전에는 추가 버튼이 꺼져 있다');
  const rowsAll = list.locator('.pickrow'); const n = await rowsAll.count();
  assert.ok(n >= 2, `일괄 선택을 보려면 후보가 둘 이상이어야 한다 (${n})`);
  for (let i = 0; i < n; i++) await rowsAll.nth(i).locator('input').check(); // 보이는 후보를 전부 한 번에
  assert.match(await submit.innerText(), new RegExp(`${n}명 추가`), '고른 수가 버튼에 보인다');
  const before = (await calls()).filter((c) => c.rpc === 'msgr_crew_join').length;
  await submit.click(); await p.waitForTimeout(900);
  const joins = (await calls()).filter((c) => c.rpc === 'msgr_crew_join').slice(before);
  assert.equal(joins.length, n, `고른 수만큼 서버 규칙(msgr_crew_join)을 한 명씩 부른다 (${joins.length}/${n})`);
  assert.ok(joins.some((c) => c.args.crew === 'crew-1'), '내 에이전트가 들어간다');
  assert.ok((await crewRows(sheet)).includes('Fixture Agent'), '바로 들어온다');
});

// 14. 방장 — 알림함의 결재 칸에 요청이 오고, 누르면 그 채널의 설정이 열린다
await scenario(1280, 'host-inbox-request', async (p) => {
  await p.locator('button[aria-label*="알림"]').first().click(); await p.waitForTimeout(900);
  const item = p.locator('.msgr-inboxrow', { hasText: '데려오려 합니다' }).first();
  await item.waitFor({ timeout: 5000 });
  assert.match(await item.innerText(), /결재/, '결재 칸의 항목');
  await item.click(); await p.waitForTimeout(900);
  const sheet = p.locator('.msgr-crewsheet'); await sheet.waitFor({ timeout: 5000 });
  assert.ok(await sheet.locator('.row.req', { hasText: 'Colleague Agent' }).isVisible(), '그 채널 설정에서 바로 허락할 수 있다');
});

// 15. 참여자 — 자기 에이전트는 '승인 필요', 누르면 요청이 가고 대기로 보인다. 남의 개인 에이전트는 후보가 아니다
await scenario(1280, 'member-requests-approval', async (p) => {
  const sheet = await openGeneralSheet(p);
  await sheet.locator('.msgr-addwrap button', { hasText: '추가' }).first().click();
  await sheet.locator('.msgr-addmenu button', { hasText: '에이전트 추가' }).click();
  await sheet.locator('.msgr-picklist').waitFor();
  const chips = await sheet.locator('.msgr-picklist .pickrow').allInnerTexts();
  assert.ok(!chips.some((x) => x.includes('Colleague Agent')), `남의 개인 에이전트는 후보가 아니다 (${chips})`);
  const mine = sheet.locator('.msgr-picklist .pickrow', { hasText: 'Fixture Agent' });
  assert.match(await mine.innerText(), /승인 필요/, '내 에이전트에 승인 필요 표시');
  await mine.locator('input').check(); await sheet.locator('.msgr-addwrap .acts .btn-primary').click(); await p.waitForTimeout(700);
  assert.ok((await p.evaluate(() => window.__dmInviteFixture.calls)).some((c) => c.rpc === 'msgr_crew_join' && c.args.crew === 'crew-1'), '요청을 보낸다');
  assert.ok(!(await crewRows(sheet)).includes('Fixture Agent'), '허락 전에는 구성에 없다');
  assert.match(await sheet.locator('.row.req', { hasText: 'Fixture Agent' }).innerText(), /방장 승인 대기/, '대기로 보인다');
  assert.equal(await sheet.locator('.row.req button', { hasText: '허락' }).count(), 0, '참여자에게는 허락 버튼이 없다');
}, '?role=member');

// 16. 설정창을 열어 둔 사이 요청이 바뀌면 주기 재조회(15초)로 보인다 — 방장이 창을 닫았다 열 필요가 없다(검수 M-3)
await scenario(1280, 'open-sheet-refreshes-requests', async (p) => {
  const sheet = await openGeneralSheet(p);
  assert.ok(await sheet.locator('.row.req', { hasText: 'Colleague Agent' }).isVisible(), '처음 요청');
  await p.evaluate(() => { const t = window.__dmInviteFixture.tables.msgr_channel_crew_requests; t[0].status = 'approved'; t.push({ id: 'req-2', channel_id: 'general', crew_id: 'crew-bot', requested_by: 'user-third', status: 'pending', created_at: new Date().toISOString() }); });
  await p.waitForTimeout(16500);
  const rows = await sheet.locator('.row.req').allInnerTexts();
  assert.ok(rows.some((x) => x.includes('External Bot')), `새 요청이 보인다 (${rows})`);
  assert.ok(!rows.some((x) => x.includes('Colleague Agent')), '처리된 요청은 사라진다');
  assert.ok(await sheet.isVisible(), '설정창은 열린 채로');
});

await browser.close();
console.log(results.join('\n'));
if (failures.length) { console.log(`${results.length} passed, ${failures.length} failed`); console.log('Failures:', failures); process.exit(1); }
console.log(`${results.length} passed, 0 failed`);
