// 같은 사람이 이어 보낸 글(턴) 안·턴 사이의 '보이는' 간격과 턴 끝 동작 줄(복사·답글·반응·더보기)의 자리·정렬·대상을 잰다(유건 2026-10-02).
// 바깥 상자가 아니라 보이는 경계로 잰다: 배경·테두리가 있는 상자(말풍선·카드·사진·구분선 알약)는 상자 위아래, 배경 없는 글(이름 줄·시각)은 텍스트 노드 줄 상자(Range.getClientRects),
// 동작 줄은 아이콘(svg) 상자. 실수 기록: 옛 측정은 요소 상자(줄 높이 포함)를 다른 방에서 재서 숨긴 아바타(28px)가 둘째 글부터 행을 6.4px 늘린 것을 못 봤다.
// 서버: UF_TEST_PORT=5211 node node_modules/vite/bin/vite.js --config test/msgr-ui-feedback.config.mjs --port 5211 --strictPort
// 실행: PLAYWRIGHT_MODULE=/절대경로/playwright/index.mjs node test/msg-gap.browser.mjs
// measureGaps·checkTurnBar는 바깥 변수를 쓰지 않는다 — 다른 브라우저(ego 등)에서 그대로 불러 써도 같은 값이 나온다(page.click·page.evaluate·page.waitForTimeout만 쓴다).
export const FIXTURE_PATH = '/test/instant-delivery.fixture.html?gap=1&mix=1'; // 사람 글·내 글·에이전트 카드·사진 첨부가 섞인 방

export function measureGaps() {
  const glyph = (el) => {
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.textContent.trim() ? 1 : 3) });
    let top = Infinity, bottom = -Infinity, n;
    while ((n = w.nextNode())) { const r = document.createRange(); r.selectNodeContents(n); for (const b of r.getClientRects()) { if (b.height) { top = Math.min(top, b.top); bottom = Math.max(bottom, b.bottom); } } }
    return top === Infinity ? null : { top, bottom };
  };
  const boxed = (el) => { const cs = getComputedStyle(el); return !/rgba\(0, 0, 0, 0\)|transparent/.test(cs.backgroundColor) || parseFloat(cs.borderTopWidth) > 0; };
  const shown = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const rect = (el) => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }; };
  const union = (els) => { const rs = els.map(rect); return rs.length ? { top: Math.min(...rs.map((r) => r.top)), bottom: Math.max(...rs.map((r) => r.bottom)), left: Math.min(...rs.map((r) => r.left)), right: Math.max(...rs.map((r) => r.right)) } : null; };
  const r1 = (x) => Math.round(x * 10) / 10;
  const kindOf = (el) => (el.matches('.msgr-turnacts') ? 'bar' : el.matches('.who') ? 'who' : el.matches('.text, .msgr-sheet, .bubble') ? 'body' : el.matches('.msgr-media') ? 'media' : el.matches('.meta') ? 'meta' : 'other');
  const out = { pairs: [], bars: [], rows: [] };
  const blocks = []; let prevRow = null;
  for (const row of document.querySelectorAll('.msgr-spine > *')) {
    const mid = row.dataset.mid ?? row.className.split(' ')[0];
    const mine = row.classList.contains('msgr-mine');
    const own = [];
    if (row.matches('.msgr-newline')) { const s = row.querySelector('span'); if (shown(s)) own.push({ kind: 'newline', el: s, ...rect(s) }); }
    else if (row.matches('.msgr-tnode')) { const g = glyph(row); if (g) own.push({ kind: 'day', el: row, ...g }); }
    else if (row.matches('.msgr-row, .msgr-mine')) {
      const parts = mine ? [...row.children] : [...(row.querySelector(':scope > .msgr-col')?.children ?? [])];
      for (const el of parts) {
        if (!shown(el)) continue;
        const kind = kindOf(el);
        if (kind === 'other' && !el.matches('.msgr-reacts, .msgr-link, .msgr-sys')) continue; // 포털 자리표시·모달 등
        const v = kind === 'bar' ? union([...el.querySelectorAll('svg')]) : boxed(el) || kind === 'media' ? rect(el) : glyph(el);
        if (v) own.push({ kind, el, ...v });
        if (kind === 'bar') {
          const btns = [...el.querySelectorAll('button')];
          const anchor = [...parts].reverse().find((x) => shown(x) && x !== el && ['body', 'media'].includes(kindOf(x))); // 줄을 맞출 말풍선·카드·사진
          const a = anchor && (anchor.matches('.msgr-media') ? union([...anchor.querySelectorAll('.msgr-thumb, .msgr-file, .msgr-mgrid')].filter(shown)) ?? rect(anchor) : rect(anchor));
          const cx = [...el.querySelectorAll('svg')].map((s) => { const r = s.getBoundingClientRect(); return r.left + r.width / 2; });
          const hb = btns.map((x) => x.getBoundingClientRect());
          out.bars.push({ mid, mine, slot: r1(el.getBoundingClientRect().height), acts: btns.map((b) => b.dataset.act), hit: r1(btns[0]?.getBoundingClientRect().height ?? 0),
            hitW: r1(hb[0]?.width ?? 0), pitch: cx.slice(1).map((c, i) => r1(c - cx[i])), overlap: hb.slice(1).map((r, i) => r1(hb[i].right - r.left)),
            alignL: a && !mine ? r1(v.left - a.left) : null, alignR: a && mine ? r1(a.right - v.right) : null, anchor: anchor ? kindOf(anchor) : null });
        }
      }
      out.rows.push({ mid, mine, cont: row.classList.contains('cont'), tail: !row.classList.contains('notail'), bar: !!row.querySelector('.msgr-turnacts') });
    }
    // 턴 안 간격: 이어 보낸 글의 첫 보이는 것 ↔ 윗글의 마지막 보이는 것(말풍선·카드·사진 — 같은 턴 안에는 동작 줄이 없다)
    const firstOwn = own[0];
    if (row.classList.contains('cont') && prevRow?.own.length && firstOwn) {
      const a = prevRow.own.at(-1), b = firstOwn;
      out.pairs.push({ mid, mine, kinds: `${a.kind}→${b.kind}`, visible: r1(b.top - a.bottom), box: r1(b.el.getBoundingClientRect().top - a.el.getBoundingClientRect().bottom) });
    }
    if (own.length) prevRow = { mid, own };
    for (const k of own) blocks.push({ mid, kind: k.kind, top: k.top, bottom: k.bottom });
  }
  blocks.sort((a, b) => a.top - b.top);
  // 동작 줄 위아래 보이는 간격(위 = 그 턴 마지막 말풍선·카드·사진·시각, 아래 = 다음 턴의 이름 줄·말풍선·구분선)
  out.turns = blocks.flatMap((k, i) => (k.kind === 'bar' ? [{ mid: k.mid, above: r1(k.top - blocks[i - 1].bottom), aboveKind: blocks[i - 1].kind, icon: r1(k.bottom - k.top), below: blocks[i + 1] ? r1(blocks[i + 1].top - k.bottom) : null, next: blocks[i + 1]?.kind ?? null,
    contentToNext: blocks[i + 1] ? r1(blocks[i + 1].top - blocks[i - 1].bottom) : null }] : []));
  const top0 = document.querySelector('.msgr-spine').getBoundingClientRect().top; // 스크롤과 무관하게 비교한다(올리기가 대상을 화면 안으로 스크롤한다)
  out.layout = blocks.map((k) => r1(k.top - top0)).join(',');
  out.phone = !!document.querySelector('.msgr-phone');
  out.gapIn = parseFloat(getComputedStyle(document.querySelector('.msgr-shell')).getPropertyValue('--msg-gap-in'));
  out.hovbars = document.querySelectorAll('.msgr-hovbar').length;
  const any = document.querySelector('.msgr-spine > .msgr-row');
  out.rowBefore = any ? getComputedStyle(any, '::before').content : null; // 올린 글 회색 바탕(::before)이 없어야 'none'
  const other = document.querySelector('.msgr-row > .msgr-col > .text');
  out.colors = other ? { other: getComputedStyle(other).backgroundColor, page: getComputedStyle(document.body).backgroundColor, mine: getComputedStyle(document.querySelector('.msgr-mine .bubble')).backgroundColor, radius: getComputedStyle(other).borderRadius } : null;
  return out;
}

/** 턴 끝 동작 줄의 대상 — 답글·반응·더보기는 턴의 마지막 글, 턴 중간 글은 우클릭(데스크톱)·길게 누르기(폰). 실패 목록을 돌려준다(빈 배열 = 통과). */
export async function checkTurnBar(page, { phone = false } = {}) {
  const fails = [];
  const check = (name, ok, detail) => { if (!ok) fails.push(`${name}: ${JSON.stringify(detail)}`); };
  const state = () => page.evaluate(() => ({
    open: document.querySelector('[data-acts="open"]')?.dataset.mid ?? null,
    menu: !!document.querySelector('.msgr-acts.ctx'), sheet: !!document.querySelector('.msgr-actsheet'), picker: !!document.querySelector('.msgr-emojipop'),
    reply: document.querySelector('.msgr-replychip .q')?.textContent ?? null,
    reacts: (window.__instant.tables.msgr_reactions ?? []).map((r) => r.message_id),
  }));
  const close = () => page.evaluate(() => { document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); const w = document.querySelector('.msgr-actsheetwrap'); if (w) w.click(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
  // crystal이 '새 메시지' 줄 뒤에 이어 보낸 턴: 115(점검 6)·116·117·118(점검 9) — 줄은 118에만
  const rows = await page.evaluate(() => [115, 116, 117, 118].map((id) => !!document.querySelector(`.msgr-spine > [data-mid="${id}"] .msgr-turnacts`)));
  check('줄은 턴 마지막 글(118)에만', JSON.stringify(rows) === JSON.stringify([false, false, false, true]), rows);
  // 턴의 줄 버튼 — crystal 턴(115~118)에서 줄이 있는 행의 버튼을 누른다(줄이 엉뚱한 글에 붙으면 그 글이 대상이 되어 아래 검사가 잡는다)
  const press = async (act) => {
    const mid = await page.evaluate((a) => [115, 116, 117, 118].find((id) => document.querySelector(`.msgr-spine > [data-mid="${id}"] .msgr-turnacts [data-act="${a}"]`)) ?? null, act);
    if (mid == null) { fails.push(`crystal 턴에 ${act} 버튼이 없다`); return false; }
    await page.click(`.msgr-spine > [data-mid="${mid}"] .msgr-turnacts [data-act="${act}"]`); return true;
  };
  let s;
  if (await press('reply')) { await page.waitForTimeout(250); s = await state();
    check('답글 → 턴 마지막 글(점검 9)', /점검 9/.test(s.reply ?? '') && !/점검 6/.test(s.reply ?? ''), s.reply);
    await page.evaluate(() => document.querySelector('.msgr-replychip .x')?.click()); }
  if (await press('react')) { await page.waitForTimeout(300); s = await state(); check('반응 → 피커가 열린다', s.picker, s);
    if (s.picker) { await page.click('.msgr-emojipop .grid button >> nth=0'); await page.waitForTimeout(400); s = await state(); check('반응 → 턴 마지막 글(118)에 달린다', s.reacts.at(-1) === 118, s.reacts); } }
  if (await press('more')) { await page.waitForTimeout(300); s = await state();
    check(`더보기 → 턴 마지막 글(118)의 ${phone ? '시트' : '메뉴'}`, s.open === '118' && (phone ? s.sheet : s.menu), s);
    await page.waitForTimeout(500); await close(); await page.waitForTimeout(300); }
  // 턴 중간 글(116) — 데스크톱 우클릭, 폰 길게 누르기 → 그 글의 메뉴·시트
  await page.evaluate((ph) => {
    const el = document.querySelector('.msgr-spine > [data-mid="116"] .text'); const r = el.getBoundingClientRect(); const at = { bubbles: true, cancelable: true, clientX: r.left + 10, clientY: r.top + 10 };
    if (ph) el.dispatchEvent(new PointerEvent('pointerdown', { ...at, pointerType: 'touch', pointerId: 7, isPrimary: true }));
    else el.dispatchEvent(new MouseEvent('contextmenu', { ...at, button: 2 }));
  }, phone);
  await page.waitForTimeout(phone ? 700 : 300);
  if (phone) await page.evaluate(() => document.querySelector('.msgr-spine > [data-mid="116"] .text').dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'touch', pointerId: 7 })));
  s = await state(); check(`턴 중간 글(116) ${phone ? '길게 누르기 → 시트' : '우클릭 → 메뉴'}`, s.open === '116' && (phone ? s.sheet : s.menu), s);
  await page.waitForTimeout(500); await close(); await page.waitForTimeout(300);
  return fails;
}

export const EXPECTED_COPIES = [[1, 2, 3, 4, 5].map((i) => `마케팅 뱃지 점검 ${i}`).join('\n\n'), [6, 7, 8, 9].map((i) => `마케팅 뱃지 점검 ${i}`).join('\n\n'), [1, 2, 3].map((i) => `확인했어요 ${i}`).join('\n\n')];

/** measureGaps 결과 판정 — 실패 문장 목록. */
export function verifyLayout(g) {
  const fails = [];
  const check = (name, ok, detail) => { if (!ok) fails.push(`${name}: ${JSON.stringify(detail)}`); };
  const spread = (xs) => (xs.length ? Math.max(...xs) - Math.min(...xs) : 0);
  const textPairs = g.pairs.filter((p) => p.kinds === 'body→body');
  check('턴 안 말풍선 사이(보이는 간격)가 상대·내 글 모두 같다', textPairs.length > 3 && spread(textPairs.map((p) => p.visible)) <= 0.5, textPairs);
  check('턴 안 상자 간격 = --msg-gap-in', g.pairs.every((p) => Math.abs(p.box - g.gapIn) <= 0.5), g.pairs);
  check('동작 줄은 턴 마지막 글에만', g.rows.every((r) => !r.bar || r.tail) && g.rows.filter((r) => r.bar).length >= 6, g.rows.filter((r) => r.bar !== r.tail));
  check('동작 줄 자리 높이 18px', g.bars.every((b) => b.slot === 18), g.bars.map((b) => b.slot));
  // 아이콘 중심 간격 — 폰 32px·데스크톱 24px(유건 2026-10-08 '더 붙어야 해', 이전 44·28). 누르는 영역은 폰 세로 44, 이웃과 겹치지 않는다
  const pitch = g.phone ? 32 : 24;
  check(`동작 줄 아이콘 중심 간격 ${pitch}px`, g.bars.every((b) => b.pitch.length >= 2 && b.pitch.every((x) => Math.abs(x - pitch) <= 0.5)), g.bars.map((b) => [b.mid, b.pitch]));
  check(`누르는 영역 ${g.phone ? '32×44' : '24×28'}·이웃과 안 겹침`, g.bars.every((b) => b.hit === (g.phone ? 44 : 28) && b.hitW === pitch && b.overlap.every((o) => o <= 0.5)), g.bars.map((b) => [b.mid, b.hitW, b.hit, b.overlap]));
  check('동작 줄 아이콘 네 개(복사·답글·반응·더보기, 사진만 있는 턴은 복사 없음)', g.bars.every((b) => ['reply', 'react', 'more'].every((a) => b.acts.includes(a))), g.bars.map((b) => b.acts));
  check('상대 글 줄은 말풍선·카드·사진 왼쪽 선, 내 글 줄은 오른쪽 끝', g.bars.every((b) => Math.abs((b.mine ? b.alignR : b.alignL) ?? 99) <= 0.5), g.bars.map((b) => [b.mid, b.anchor, b.alignL, b.alignR]));
  check('도구 막대 없음', g.hovbars === 0, g.hovbars);
  check('올린 글 바탕(::before) 없음', g.rowBefore === 'none', g.rowBefore);
  check('상대 말풍선이 바탕과 다른 색', g.colors && g.colors.other !== g.colors.page, g.colors);
  return fails;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
  const PORT = process.env.UF_TEST_PORT || 5211;
  const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' });
  const fails = [];
  for (const [w, h, theme] of [[1440, 900, 'graphite-light'], [1440, 900, 'graphite-dark'], [390, 844, 'graphite-light'], [390, 844, 'graphite-dark']]) {
    const tag = `${w}-${theme}`;
    const page = await browser.newPage({ viewport: { width: w, height: h }, hasTouch: w < 720 });
    await page.route('**/*', (rt) => (new URL(rt.request().url()).hostname === '127.0.0.1' ? rt.continue() : rt.abort()));
    await page.addInitScript((th) => { localStorage.setItem('argo-lang', 'ko'); localStorage.setItem('argo-theme', th); localStorage.setItem('argo-msgr-last-org', 'org-fixture'); localStorage.setItem('argo-msgr-last-ch', JSON.stringify({ 'org-fixture': 'general' }));
      window.__copied = []; Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (s) => { window.__copied.push(s); } } }); }, theme);
    await page.goto(`http://127.0.0.1:${PORT}${FIXTURE_PATH}`);
    if (w < 720) await page.locator('.item', { hasText: 'Fixture General' }).first().click(); // 폰은 목록에서 시작한다
    await page.locator('.msgr-spine').getByText('A안으로 가죠').first().waitFor();
    await page.waitForFunction(() => document.querySelectorAll('.msgr-thumb.loaded').length >= 3);
    await page.evaluate(() => document.getAnimations().forEach((a) => a.finish()));
    fails.push(...verifyLayout(await page.evaluate(measureGaps)).map((f) => `${tag} ${f}`));
    const copied = await page.evaluate(async () => { const want = [...document.querySelectorAll('.msgr-spine > *')].filter((r) => r.querySelector('.msgr-turnacts [data-act="copy"]') && /점검 5|점검 9|확인했어요 3/.test(r.textContent)).map((r) => r.querySelector('.msgr-turnacts [data-act="copy"]')); for (const x of want) x.click(); await new Promise((r) => setTimeout(r, 50)); return window.__copied; });
    if (JSON.stringify(copied) !== JSON.stringify(EXPECTED_COPIES)) fails.push(`${tag} 턴 복사 = 턴 본문 전체: ${JSON.stringify(copied)}`);
    if (w > 720) { // 올려도 도구 막대·바탕이 뜨지 않고 레이아웃이 그대로
      const before = await page.evaluate(measureGaps);
      await page.locator('.msgr-spine').getByText('마케팅 뱃지 점검 2').first().hover(); await page.waitForTimeout(300);
      const after = await page.evaluate(measureGaps);
      if (after.layout !== before.layout || after.hovbars || after.rowBefore !== 'none') fails.push(`${tag} 올림 불변: ${JSON.stringify({ hovbars: after.hovbars, before: after.rowBefore })}`);
      // 데스크톱 줄은 올렸을 때만 보인다 — 숨긴 줄은 재지 않으므로(shown) 올린 턴의 줄로 아이콘 간격·누르는 영역을 판정한다
      if (!after.bars.length) fails.push(`${tag} 올린 턴의 동작 줄이 보이지 않는다`);
      fails.push(...verifyLayout(after).map((f) => `${tag} 올림 ${f}`));
    }
    fails.push(...(await checkTurnBar(page, { phone: w < 720 })).map((f) => `${tag} ${f}`));
    await page.close();
  }
  await browser.close();
  if (fails.length) { console.error(fails.join('\n')); process.exit(1); }
  console.log('msg-gap ok');
}
