// 초대 개편(0.1.30) 행동 테스트 — 만들기 → 링크 복사 → 붙여 넣기 → 미리보기 → 참여 → 그 채널이 열린다(설계서 2-6).
// 옛 서버(새 RPC·열 없음)에서는 만들기가 옛 insert로, 참여가 미리보기 없이 바로 수락으로 물러나는지도 본다.
// 서버: UF_TEST_PORT=5211 node node_modules/vite/bin/vite.js --config test/msgr-ui-feedback.config.mjs
// 실행: PLAYWRIGHT_MODULE=/절대경로/playwright/index.mjs node test/invite-flow.browser.mjs
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const PORT = process.env.UF_TEST_PORT || 5211;
const JOIN_CODE = '0123456789abcdef'.repeat(3); // 픽스처(msgr-ui-feedback.supabase.mjs)와 같은 값 — 옛 서버 초대
const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: `http://127.0.0.1:${PORT}` });
const out = {}; const fails = [];
const check = (name, ok, detail) => { out[name] = ok ? true : detail ?? false; if (!ok) fails.push(name); };

async function open({ noV2 = false } = {}) {
  const page = await ctx.newPage();
  page.setDefaultTimeout(8000);
  await page.route('**/*', (rt) => new URL(rt.request().url()).hostname === '127.0.0.1' ? rt.continue() : rt.abort());
  await page.addInitScript(() => localStorage.setItem('argo-lang', 'ko'));
  await page.goto(`http://127.0.0.1:${PORT}/test/instant-delivery.fixture.html`);
  await page.waitForFunction(() => !!window.__instant && [...document.querySelectorAll('.msgr-side *')].some((e) => e.children.length === 0 && e.textContent.trim() === 'Fixture General'));
  if (noV2) await page.evaluate(() => { window.__instant.noV2 = true; });
  return page;
}
const inSidebar = (page, name) => page.evaluate((name) => [...document.querySelectorAll('.msgr-side button, .msgr-side a')].some((b) => b.textContent.trim() === name || b.textContent.trim().endsWith(name)), name);
const SHOT = process.argv[2]; // 실패 화면 저장 경로(선택)
const menu = async (page, name) => {
  try { await page.locator('button.msgr-org').click(); await page.getByRole('menuitem', { name }).click(); }
  catch (e) { if (SHOT) await page.screenshot({ path: SHOT }); throw e; }
};
const lastInvite = (page) => page.evaluate(() => structuredClone(window.__instant.tables.msgr_invites?.at(-1) ?? null));
const joinWith = async (page, text) => { await menu(page, '초대 링크·코드로 참여'); await page.locator('.msgr-menu-pop input').fill(text); await page.getByRole('button', { name: /^확인$/ }).click(); };

// (1) 새 서버: 조직 메뉴 → 멤버 초대 → Lounge만 → 복사 → 붙여 넣기 → 미리보기 → 참여 → Lounge가 열린다
{
  const page = await open();
  check('before.notJoined', !(await inSidebar(page, 'Lounge')));
  await menu(page, '멤버 초대');
  const copy = page.locator('.inv-copy');
  await page.waitForFunction(() => { const b = document.querySelector('.inv-copy'); return b && !b.disabled; });
  check('focus.onCopy', await page.evaluate(() => document.activeElement?.classList.contains('inv-copy')));
  const chips = await page.locator('.inv-chip[aria-checked="true"]').allTextContents();
  check('preselect.publicAll', ['Fixture General', 'Lounge', 'Lounge Two'].every((n) => chips.some((c) => c.includes(n))) && !chips.some((c) => c.includes('비공개')), chips);
  await page.locator('.inv-chip', { hasText: 'Fixture General' }).click();
  await page.locator('.inv-chip', { hasText: 'Lounge Two' }).click();
  await page.waitForFunction(() => { const inv = window.__instant.tables.msgr_invites?.at(-1); const b = document.querySelector('.inv-copy');
    return inv && JSON.stringify(inv.channel_ids) === '["lounge"]' && b && !b.disabled; });
  const inv = await lastInvite(page);
  const days = Math.round((Date.parse(inv.expires_at) - Date.now()) / 86_400_000);
  check('row.shape', inv.role === 'member' && inv.max_uses === null && days === 7 && inv.created_by === 'user-me', inv);
  check('sub.oneChannel', (await page.locator('.inv-sub').textContent()).includes('#Lounge'));
  await copy.click();
  await page.waitForFunction(() => document.querySelector('.inv-copy')?.textContent.includes('복사됨'));
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  check('clipboard.hasCode', clip.includes(inv.code), clip);
  const lines = clip.split('\n');
  check('clipboard.plain3', lines.length === 3 && lines[0].includes('#Lounge') && lines[0].includes('Fixture Organization') && lines[1].endsWith(`?invite=${inv.code}`)
    && lines[2].includes("'초대 링크·코드로 참여'") && lines[2].includes('7일 안에') && !/\*\*/.test(clip), clip); // 공유 문구 3줄 평문(유건 2026-09-18)
  await page.keyboard.press('Escape');
  check('esc.closes', (await page.locator('.inv-dialog').count()) === 0);

  await joinWith(page, clip);
  await page.locator('.inv-preview').waitFor();
  const card = await page.locator('.inv-preview').textContent();
  check('preview.card', card.includes('Fixture Organization') && card.includes('Lounge') && card.includes('나님이 초대했습니다'), card);
  await page.getByRole('button', { name: '참여하기' }).click();
  await page.waitForFunction(() => !document.querySelector('.inv-preview'));
  const t0 = Date.now();
  await page.waitForFunction(() => document.querySelector('.msgr-top .title')?.textContent.includes('Lounge'), undefined, { timeout: 8000 }).catch(() => {});
  check('opens.channel', (await page.locator('.msgr-top .title').first().textContent()).includes('Lounge'), await page.locator('.msgr-top .title').first().textContent());
  out.openMs = Date.now() - t0;
  check('sidebar.lounge', await inSidebar(page, 'Lounge'));
  check('note.joined', (await page.textContent('body')).includes('#Lounge에 참여했어요.'));

  // 이미 참여한 뒤 같은 링크 → "이미 참여 중" + 열기
  await joinWith(page, clip);
  await page.locator('.inv-preview').waitFor();
  check('preview.already', (await page.locator('.inv-preview').textContent()).includes('이미 참여 중'));
  await page.keyboard.press('Escape');

  // 틀린 코드 → 코드 오류 문구
  await joinWith(page, 'f'.repeat(48));
  await page.waitForFunction(() => document.body.textContent.includes('초대 코드를 찾지 못했습니다'), undefined, { timeout: 5000 }).catch(() => {});
  check('err.notFound', (await page.textContent('body')).includes('초대 코드를 찾지 못했습니다'));

  // 설정 → 멤버: 초대 관리 목록에 채널 칩·사용 횟수·남은 날, 취소하면 지난 초대로
  if (await page.locator('.msgr-menu-pop').count()) await page.mouse.click(130, 600); // 코드 오류 뒤에는 고쳐 넣도록 메뉴가 열린 채다 — 레일 안 덮개(msgr-scrim clear)를 눌러 닫는다
  await menu(page, '멤버 초대');
  await page.getByRole('button', { name: '만든 초대 링크 관리' }).click();
  await page.locator('.inv-row-m').first().waitFor();
  const rowLoc = page.locator('.inv-row-m').filter({ has: page.locator('.inv-chip', { hasText: /^Lounge$/ }) }).filter({ hasNot: page.locator('.inv-chip', { hasText: 'Lounge Two' }) }).first(); // 창을 다시 열며 만든 새 초대(공개 전부)와 구분
  const row = await rowLoc.textContent();
  check('manage.row', row.includes('Lounge') && row.includes('1회 사용 · 제한 없음') && /[67]일 남음/.test(row), row);
  const liveBefore = await page.locator('.msgr-rows > .inv-row-m').count();
  await rowLoc.getByRole('button', { name: /취소/ }).click();
  await page.waitForFunction((n) => document.querySelectorAll('.msgr-setcard > .msgr-rows > .inv-row-m').length < n, liveBefore).catch(() => {});
  check('manage.revoked', (await page.locator('details.inv-past summary').textContent().catch(() => '')).includes('지난 초대'));
  await page.close();
}

// (1b) 채널 패널: [이 채널로 초대] → 비공개 채널에서 사람을 내보내면 살아 있는 초대 링크 수를 먼저 알린다(총괄 2026-09-18)
{
  const page = await open();
  await page.locator('.msgr-side button', { hasText: '2026 하반기 제품 출시 준비와 파트너 협업 채널' }).first().click();
  await page.locator('.msgr-top button', { hasText: '에이전트' }).first().click();
  await page.getByRole('button', { name: '이 채널로 초대' }).click();
  await page.waitForFunction(() => { const b = document.querySelector('.inv-copy'); return b && !b.disabled; });
  const inv = await lastInvite(page);
  check('here.channel', JSON.stringify(inv.channel_ids) === '["long"]' && inv.role === 'member', inv);
  await page.locator('.inv-copy').click(); // 복사한 링크만 남는다 — 복사하지 않고 닫으면 취소된다(아래 1c)
  await page.keyboard.press('Escape');
  await page.locator('.msgr-crewsheet .row', { hasText: 'crystal' }).getByRole('button', { name: '더 보기' }).click();
  await page.getByRole('menuitem', { name: '내보내기' }).click();
  const ask = page.locator('.msgr-crewsheet .confirm[role="alertdialog"]');
  await ask.waitFor().catch(async (e) => { if (SHOT) await page.screenshot({ path: SHOT }); throw e; });
  check('kick.notice', /내가 확인할 수 있는 초대 링크 중 .*링크가 \d+개/.test(await ask.textContent()), await ask.textContent());
  await ask.getByRole('button', { name: '링크 취소하고 내보내기', exact: true }).click(); // 관리 목록이 없는 방장도 여기서 취소할 수 있다(검수 LOW)
  await page.waitForFunction((id) => !!window.__instant.tables.msgr_invites.find((i) => i.id === id)?.revoked_at, inv.id).catch(() => {});
  check('kick.revokedLinks', await page.evaluate((id) => !!window.__instant.tables.msgr_invites.find((i) => i.id === id)?.revoked_at, inv.id));
  await page.waitForFunction(() => !window.__instant.tables.msgr_channel_members.some((m) => m.channel_id === 'long' && m.member_id === 'user-crystal')).catch(() => {});
  check('kick.done', await page.evaluate(() => !window.__instant.tables.msgr_channel_members.some((m) => m.channel_id === 'long' && m.member_id === 'user-crystal')));
  await page.close();
}

// (1c) 링크 쌓임 방지(총괄 2026-09-18): 설정을 바꿔 새 링크가 생기면 복사 안 한 이전 링크는 **삭제**(지난 초대에도 안 남김, 검수 LOW), 복사한 링크는 둔다, 닫을 때 복사 안 한 링크 삭제
{
  const page = await open();
  const codes = () => page.evaluate(() => (window.__instant.tables.msgr_invites ?? []).map((i) => i.code));
  const cur = () => page.evaluate(() => window.__instant.tables.msgr_invites.at(-1)?.code);
  const ready = (code) => page.waitForFunction((code) => { const inv = window.__instant.tables.msgr_invites?.at(-1); const b = document.querySelector('.inv-copy'); return inv && inv.code !== code && b && !b.disabled; }, code);
  await menu(page, '멤버 초대'); await ready(null); const a = await cur();
  await page.locator('.inv-chip', { hasText: 'Lounge Two' }).click(); await ready(a); const b = await cur();
  await page.waitForFunction((a) => !window.__instant.tables.msgr_invites.some((i) => i.code === a), a).catch(() => {});
  check('stack.uncopiedDeleted', !(await codes()).includes(a) && (await codes()).includes(b), await codes());
  await page.locator('.inv-copy').click(); await page.waitForFunction(() => document.querySelector('.inv-copy')?.textContent.includes('복사됨'));
  await page.locator('.inv-chip', { hasText: 'Fixture General' }).click(); await ready(b); const c = await cur();
  await page.waitForTimeout(400);
  check('stack.copiedKept', await page.evaluate((b) => { const i = window.__instant.tables.msgr_invites.find((x) => x.code === b); return !!i && !i.revoked_at; }, b));
  await page.keyboard.press('Escape');
  await page.waitForFunction((c) => !window.__instant.tables.msgr_invites.some((i) => i.code === c), c).catch(() => {});
  const left = await codes();
  check('stack.closeDeletes', !left.includes(c) && left.length === 1 && left[0] === b, left);
  await page.close();
}

// (1d) D32 옛 링크 잔존(권한 상승): 멤버 링크가 뜬 뒤 게스트로 바꾸면(채널 없음) 링크 칸이 비고 복사가 막힌다.
// 서버처럼 채널 없는 게스트 초대는 거절된다(픽스처 inviteInsert) — 옛 앱은 거절 뒤에도 멤버 링크를 복사하게 뒀다. 채널을 고르면 복사 값 = 새 게스트 코드
{
  const page = await open();
  await menu(page, '멤버 초대');
  await page.waitForFunction(() => { const b = document.querySelector('.inv-copy'); return b && !b.disabled; });
  const member = await lastInvite(page);
  await page.locator('.inv-fold').click(); await page.getByRole('radio', { name: '게스트', exact: true }).click();
  const box = () => page.evaluate(() => ({ val: document.querySelector('.inv-link input').value, disabled: document.querySelector('.inv-copy').disabled, hint: document.querySelector('.inv-hint').textContent }));
  const now = await box(); await page.waitForTimeout(600); const later = await box();
  check('stale.clearedAtOnce', !now.val.includes(member.code) && now.disabled, now);
  check('stale.guestNoChannel', later.val === '' && later.disabled && later.hint.includes('채널을 고르면'), later);
  check('stale.memberDropped', !(await page.evaluate((c) => window.__instant.tables.msgr_invites.some((i) => i.code === c), member.code)));
  await page.locator('.inv-chip', { hasText: '디자인 비공개' }).click();
  await page.waitForFunction(() => { const b = document.querySelector('.inv-copy'); return b && !b.disabled; });
  const guest = await lastInvite(page);
  await page.locator('.inv-copy').click(); await page.waitForFunction(() => document.querySelector('.inv-copy')?.textContent.includes('복사됨'));
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  check('stale.copiesGuest', guest.role === 'guest' && clip.includes(guest.code) && !clip.includes(member.code), { guest, clip });
  await page.close();
}

// (2) 옛 서버: 만들기는 옛 insert, 참여는 미리보기 없이 바로 수락 → 사이드바에 Lounge
{
  const page = await open({ noV2: true });
  await menu(page, '멤버 초대');
  await page.waitForFunction(() => { const b = document.querySelector('.inv-copy'); return b && !b.disabled; });
  const inv = await lastInvite(page);
  check('legacy.insert', inv && !('channel_ids' in inv) && inv.role === 'member', inv);
  await page.keyboard.press('Escape');
  await page.waitForFunction((code) => !window.__instant.tables.msgr_invites.some((i) => i.code === code), inv.code).catch(() => {});
  check('legacy.closeDeletes', await page.evaluate((code) => !window.__instant.tables.msgr_invites.some((i) => i.code === code), inv.code)); // 옛 서버: revoke가 없어 delete로
  await joinWith(page, JOIN_CODE);
  const t0 = Date.now(); let ms = null;
  while (Date.now() - t0 < 8000) { if (await inSidebar(page, 'Lounge')) { ms = Date.now() - t0; break; } await page.waitForTimeout(200); }
  check('legacy.joined', ms !== null);
  check('legacy.noPreview', (await page.locator('.inv-preview').count()) === 0);
  await page.waitForFunction(() => document.body.textContent.includes('조직에 들어왔습니다.'), undefined, { timeout: 5000 }).catch(() => {}); // 안내는 조직 목록을 다시 읽은 뒤에 뜬다(사이드바보다 늦을 수 있다)
  const body = await page.textContent('body');
  check('legacy.note', body.includes('조직에 들어왔습니다.'), body.slice(0, 400));
  await page.close();
}
await browser.close();
console.log(JSON.stringify(out));
console.log(fails.length ? `FAIL ${fails.join(', ')}` : 'PASS');
process.exit(fails.length ? 1 : 0);
