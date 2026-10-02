// 같은 사람이 이어 보낸 글 사이의 '보이는' 간격이 첫 쌍과 나머지 쌍 모두 같은지, 동작 줄이 다른 글·구분선을 덮지 않는지 잰다(유건 제보 2026-10-02).
// 바깥 상자가 아니라 보이는 경계로 잰다: 배경·테두리가 있는 상자(말풍선·시트·사진·파일·카드)는 상자 위아래, 배경 없는 글(.text)은 텍스트 노드 줄 상자(Range.getClientRects).
// 실수 기록: 옛 측정은 .who·.text 같은 요소 상자(줄 높이 포함)를 잼 → 숨긴 아바타(28px)가 둘째 글부터 행을 6.4px 늘린 것을 못 봤다.
// 서버: UF_TEST_PORT=5211 node node_modules/vite/bin/vite.js --config test/msgr-ui-feedback.config.mjs --port 5211 --strictPort
// 실행: PLAYWRIGHT_MODULE=/절대경로/playwright/index.mjs node test/msg-gap.browser.mjs
// measureGaps는 바깥 변수를 쓰지 않는다 — 다른 브라우저(ego 등)에서 문자열로 evaluate해도 같은 값이 나온다.
export function measureGaps() {
  const glyph = (el) => {
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.textContent.trim() ? 1 : 3) });
    let top = Infinity, bottom = -Infinity, n;
    while ((n = w.nextNode())) { const r = document.createRange(); r.selectNodeContents(n); for (const b of r.getClientRects()) { if (b.height) { top = Math.min(top, b.top); bottom = Math.max(bottom, b.bottom); } } }
    return top === Infinity ? null : { top, bottom };
  };
  const boxed = (el) => { const cs = getComputedStyle(el); return !/rgba\(0, 0, 0, 0\)|transparent/.test(cs.backgroundColor) || parseFloat(cs.borderTopWidth) > 0; };
  const shown = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const seen = (el) => (boxed(el) ? (({ top, bottom }) => ({ top, bottom }))(el.getBoundingClientRect()) : glyph(el));
  const r1 = (x) => Math.round(x * 10) / 10;
  const rows = [...document.querySelectorAll('.msgr-spine > *')];
  const out = { pairs: [], bars: [], blocks: [] };
  let prev = null;
  for (const row of rows) {
    const body = row.querySelector(':scope > .msgr-col > .text, :scope > .msgr-col > .msgr-sheet, :scope > .bubble');
    const block = row.matches('.msgr-newline') ? row.querySelector('span') : row.matches('.msgr-tnode') ? row : body;
    if (block && shown(block)) out.blocks.push({ mid: row.dataset.mid ?? row.className, ...seen(block), el: block });
    if (body && shown(body) && row.classList.contains('cont') && prev?.body) {
      const a = seen(prev.body), b = seen(body);
      out.pairs.push({ mid: row.dataset.mid, mine: row.classList.contains('msgr-mine'), visible: r1(b.top - a.bottom), box: r1(body.getBoundingClientRect().top - prev.body.getBoundingClientRect().bottom) });
    }
    prev = body ? { body } : null;
    const bar = row.querySelector('.msgr-acts.bar');
    if (shown(bar)) { const b = bar.getBoundingClientRect(); out.bars.push({ mid: row.dataset.mid, top: b.top, bottom: b.bottom, left: b.left, right: b.right }); }
  }
  // 열린 동작 줄이 다른 글·구분선·날짜 줄의 보이는 경계와 겹치는지
  out.overlaps = out.bars.flatMap((bar) => out.blocks.filter((k) => k.top < bar.bottom - 0.5 && k.bottom > bar.top + 0.5).map((k) => `${bar.mid}↔${k.mid}`));
  out.blocks = out.blocks.map(({ el, ...k }) => ({ ...k, top: r1(k.top), bottom: r1(k.bottom) }));
  out.bars = out.bars.map((b) => ({ ...b, top: r1(b.top), bottom: r1(b.bottom) }));
  out.gapIn = parseFloat(getComputedStyle(document.querySelector('.msgr-shell')).getPropertyValue('--msg-gap-in'));
  return out;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
  const PORT = process.env.UF_TEST_PORT || 5211;
  const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' });
  const fails = [];
  const check = (name, ok, detail) => { if (!ok) fails.push(`${name}: ${JSON.stringify(detail)}`); };
  const equal = (pairs) => pairs.length > 1 && Math.max(...pairs.map((p) => p.visible)) - Math.min(...pairs.map((p) => p.visible)) <= 0.5;
  for (const [w, h, theme, mode] of [[1440, 900, 'graphite-light', 'a'], [1440, 900, 'graphite-dark', 'a'], [1440, 900, 'graphite-light', 'b'], [1440, 900, 'graphite-dark', 'b'], [390, 844, 'graphite-light', 'a']]) {
    const tag = `${w}-${theme}-${mode}`;
    const page = await browser.newPage({ viewport: { width: w, height: h } });
    await page.route('**/*', (rt) => (new URL(rt.request().url()).hostname === '127.0.0.1' ? rt.continue() : rt.abort()));
    await page.addInitScript(([th, md]) => { localStorage.setItem('argo-lang', 'ko'); localStorage.setItem('argo-theme', th); localStorage.setItem('argo-msgr-acts', md); localStorage.setItem('argo-msgr-last-org', 'org-fixture'); localStorage.setItem('argo-msgr-last-ch', JSON.stringify({ 'org-fixture': 'general' })); }, [theme, mode]);
    await page.emulateMedia({ reducedMotion: 'reduce' }); // 열림 전환이 끝나기 전에 재지 않게
    await page.goto(`http://127.0.0.1:${PORT}/test/instant-delivery.fixture.html?gap=1`);
    if (w < 720) await page.locator('.item', { hasText: 'Fixture General' }).first().click(); // 폰은 목록에서 시작한다
    await page.locator('.msgr-spine').getByText('마케팅 뱃지 점검 9').first().waitFor();
    await page.mouse.move(w - 2, 2); await page.waitForTimeout(400);
    const closed = await page.evaluate(measureGaps);
    const theirs = closed.pairs.filter((p) => !p.mine), mine = closed.pairs.filter((p) => p.mine);
    check(`${tag} 남의 글 보이는 간격 같음`, equal(theirs), theirs);
    check(`${tag} 내 글 보이는 간격 같음`, equal(mine), mine);
    check(`${tag} 상자 간격 = --msg-gap-in`, closed.pairs.every((p) => Math.abs(p.box - closed.gapIn) <= 0.5), closed.pairs);
    if (w > 720) {
      for (const text of ['마케팅 뱃지 점검 2', '마케팅 뱃지 점검 5', '확인했어요 2']) { // 가운데 글 · '새 메시지' 구분선 바로 위 글(읽음 커서 114) · 내 글
        await page.locator('.msgr-spine').getByText(text).first().hover(); await page.waitForTimeout(400);
        const open = await page.evaluate(measureGaps);
        check(`${tag} ${text} 올리면 줄이 보인다`, open.bars.length === 1, open.bars);
        check(`${tag} ${text} 줄이 다른 글·구분선을 덮지 않는다`, open.overlaps.length === 0, open.overlaps);
      }
    }
    await page.close();
  }
  await browser.close();
  if (fails.length) { console.error(fails.join('\n')); process.exit(1); }
  console.log('msg-gap ok');
}
