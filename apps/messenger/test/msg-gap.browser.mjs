// 같은 사람이 이어 보낸 글(턴) 안·턴 사이의 '보이는' 간격, 턴 복사 버튼, 데스크톱 도구 막대가 다른 글을 덮지 않고 레이아웃을 밀지 않는지 잰다(유건 2026-10-02).
// 바깥 상자가 아니라 보이는 경계로 잰다: 배경·테두리가 있는 상자(말풍선·시트·구분선 알약)는 상자 위아래, 배경 없는 글(.text·이름 줄)은 텍스트 노드 줄 상자(Range.getClientRects),
// 아이콘은 svg 상자. 실수 기록: 옛 측정은 요소 상자(줄 높이 포함)를 다른 방에서 재서 숨긴 아바타(28px)가 둘째 글부터 행을 6.4px 늘린 것을 못 봤다.
// 서버: UF_TEST_PORT=5211 node node_modules/vite/bin/vite.js --config test/msgr-ui-feedback.config.mjs --port 5211 --strictPort
// 실행: PLAYWRIGHT_MODULE=/절대경로/playwright/index.mjs node test/msg-gap.browser.mjs
// measureGaps는 바깥 변수를 쓰지 않는다 — 다른 브라우저(ego 등)에서 문자열로 evaluate해도 같은 값이 나온다.
export function measureGaps() {
  const glyph = (el) => {
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.textContent.trim() && !n.parentElement.closest('.msgr-hovbar, .msgr-turncopy') ? 1 : 3) });
    let top = Infinity, bottom = -Infinity, n;
    while ((n = w.nextNode())) { const r = document.createRange(); r.selectNodeContents(n); for (const b of r.getClientRects()) { if (b.height) { top = Math.min(top, b.top); bottom = Math.max(bottom, b.bottom); } } }
    return top === Infinity ? null : { top, bottom };
  };
  const boxed = (el) => { const cs = getComputedStyle(el); return !/rgba\(0, 0, 0, 0\)|transparent/.test(cs.backgroundColor) || parseFloat(cs.borderTopWidth) > 0; };
  const shown = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const box = (el) => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; };
  const seen = (el) => (boxed(el) ? box(el) : glyph(el));
  const r1 = (x) => Math.round(x * 10) / 10;
  const out = { pairs: [], bars: [], copies: 0 };
  const blocks = []; let prev = null;
  for (const row of document.querySelectorAll('.msgr-spine > *')) {
    const mid = row.dataset.mid ?? row.className.split(' ')[0];
    const body = row.querySelector(':scope > .msgr-col > .text, :scope > .msgr-col > .msgr-sheet, :scope > .bubble');
    const push = (kind, el, b) => { if (!el || !shown(el)) return; const v = b ?? seen(el); if (v) blocks.push({ mid, kind, ...v }); };
    if (row.matches('.msgr-newline')) push('newline', row.querySelector('span'));
    else if (row.matches('.msgr-tnode')) push('day', row, glyph(row));
    else {
      push('who', row.querySelector(':scope > .msgr-col > .who'));
      push('body', body);
      const copy = row.querySelector('.msgr-turncopy svg'); if (copy) { out.copies += 1; push('copy', copy, box(copy)); }
    }
    if (body && shown(body) && row.classList.contains('cont') && prev) {
      const a = seen(prev), b = seen(body);
      out.pairs.push({ mid, mine: row.classList.contains('msgr-mine'), visible: r1(b.top - a.bottom), box: r1(body.getBoundingClientRect().top - prev.getBoundingClientRect().bottom) });
    }
    prev = body;
    const bar = row.querySelector('.msgr-hovbar');
    if (shown(bar)) out.bars.push({ mid, ...box(bar) });
  }
  blocks.sort((a, b) => a.top - b.top);
  // 턴 복사 아이콘 위아래의 보이는 간격(위 = 그 턴 마지막 글, 아래 = 다음 턴의 이름 줄·말풍선·구분선)
  out.turns = blocks.flatMap((k, i) => (k.kind === 'copy' ? [{ mid: k.mid, above: r1(k.top - blocks[i - 1].bottom), below: blocks[i + 1] ? r1(blocks[i + 1].top - k.bottom) : null, next: blocks[i + 1]?.kind ?? null }] : []));
  // 열린 도구 막대가 '다른' 글·구분선·날짜 줄·복사 아이콘과 겹치는지(자기 글 위에 겹치는 것은 설계)
  out.overlaps = out.bars.flatMap((bar) => blocks.filter((k) => k.mid !== bar.mid && k.top < bar.bottom - 0.5 && k.bottom > bar.top + 0.5).map((k) => `${bar.mid}↔${k.mid}:${k.kind}`));
  out.layout = blocks.map((k) => r1(k.top)).join(',');
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
  for (const [w, h, theme] of [[1440, 900, 'graphite-light'], [1440, 900, 'graphite-dark'], [390, 844, 'graphite-light'], [390, 844, 'graphite-dark']]) {
    const tag = `${w}-${theme}`;
    const page = await browser.newPage({ viewport: { width: w, height: h } });
    await page.route('**/*', (rt) => (new URL(rt.request().url()).hostname === '127.0.0.1' ? rt.continue() : rt.abort()));
    await page.addInitScript((th) => { localStorage.setItem('argo-lang', 'ko'); localStorage.setItem('argo-theme', th); localStorage.setItem('argo-msgr-last-org', 'org-fixture'); localStorage.setItem('argo-msgr-last-ch', JSON.stringify({ 'org-fixture': 'general' }));
      window.__copied = []; Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (s) => { window.__copied.push(s); } } }); }, theme);
    await page.goto(`http://127.0.0.1:${PORT}/test/instant-delivery.fixture.html?gap=1`);
    if (w < 720) await page.locator('.item', { hasText: 'Fixture General' }).first().click(); // 폰은 목록에서 시작한다
    await page.locator('.msgr-spine').getByText('마케팅 뱃지 점검 9').first().waitFor();
    await page.mouse.move(w - 2, 2); await page.waitForTimeout(400);
    const closed = await page.evaluate(measureGaps);
    const theirs = closed.pairs.filter((p) => !p.mine), mine = closed.pairs.filter((p) => p.mine);
    check(`${tag} 남의 글 턴 안 간격 같음`, equal(theirs), theirs);
    check(`${tag} 내 글 턴 안 간격 같음`, equal(mine), mine);
    check(`${tag} 상자 간격 = --msg-gap-in`, closed.pairs.every((p) => Math.abs(p.box - closed.gapIn) <= 0.5), closed.pairs);
    // '새 메시지' 줄에서 끊긴 crystal 두 턴 + 내 글 한 턴 → 그 세 턴 끝에 아이콘(앞의 글들도 각자 턴)
    const copied = await page.evaluate(async () => { const b = [...document.querySelectorAll('.msgr-turncopy button')]; const want = [...document.querySelectorAll('.msgr-spine > *')].filter((r) => r.querySelector('.msgr-turncopy') && /점검 5|점검 9|확인했어요 3/.test(r.textContent)).map((r) => r.querySelector('.msgr-turncopy button')); for (const x of want) x.click(); await new Promise((r) => setTimeout(r, 50)); return { n: b.length, texts: window.__copied }; });
    check(`${tag} 턴 복사 = 턴 본문 전체`, JSON.stringify(copied.texts) === JSON.stringify([
      [1, 2, 3, 4, 5].map((i) => `마케팅 뱃지 점검 ${i}`).join('\n\n'), [6, 7, 8, 9].map((i) => `마케팅 뱃지 점검 ${i}`).join('\n\n'), [1, 2, 3].map((i) => `확인했어요 ${i}`).join('\n\n')]), copied);
    if (w > 720) {
      for (const text of ['마케팅 뱃지 점검 2', '마케팅 뱃지 점검 5', '확인했어요 2']) { // 가운데 글 · '새 메시지' 구분선 바로 위 글(읽음 커서 114) · 내 글
        await page.locator('.msgr-spine').getByText(text).first().hover(); await page.waitForTimeout(300);
        const open = await page.evaluate(measureGaps);
        check(`${tag} ${text} 올리면 도구 막대가 보인다`, open.bars.length === 1, open.bars);
        check(`${tag} ${text} 막대가 다른 글·구분선을 덮지 않는다`, open.overlaps.length === 0, open.overlaps);
        check(`${tag} ${text} 올려도 레이아웃이 그대로`, open.layout === closed.layout, { open: open.layout, closed: closed.layout });
      }
    }
    await page.close();
  }
  await browser.close();
  if (fails.length) { console.error(fails.join('\n')); process.exit(1); }
  console.log('msg-gap ok');
}
