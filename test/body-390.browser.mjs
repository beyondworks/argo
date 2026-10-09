// 본체 폰 폭(390) 세 화면을 실제 레이아웃으로 잰다(H21, 10/6 실제 계정 점검에서 찾은 것):
//  ① 쪽지함 — 대기 중·배달 기록·실패함 표가 카드 안에서 가로로 스크롤되고, 시간·버튼이 카드 밖에 있었다.
//  ② 회의실 — 입력 안내(placeholder)가 한 줄 입력창에서 둘째 줄이 잘렸고, 고정 폴더 줄은 폴더 이름(마지막 칸)이 말줄임에 먹혔다.
//  ③ 기억 그래프 — 라벨 겹침 판정이 실제 글자 폭 없이 시작점 거리(170px)만 봐서 긴 라벨끼리 겹치고, 캔버스 오른쪽 밖으로 잘렸다.
// measure*·verify*는 바깥 변수를 쓰지 않는다 — ego-browser에서 page.evaluate(measureMail)처럼 그대로 넘겨 쓴다.
// 실행(격리 서버 — 임시 ARGO_ROOT·별도 포트, 상주 :3001 금지):
//   ARGO_ROOT=<임시 폴더> node node_modules/next/dist/bin/next dev -p <포트>
//   ego-browser nodejs 안에서: const m = await import('<이 파일 절대 경로>');
//     m.verifyMail(await page.evaluate(m.measureMail))          // /c/<ws>/mail — 세 표에 행이 있게
//     m.verifyRoom(await page.evaluate(m.measureRoom))          // /c/<ws>/room — 회의 작업 폴더를 고정한 상태
//     await page.evaluate(m.startGraphProbe); await page.waitForTimeout(2500);   // /c/<ws>/vault — 링크된 기억이 충분히 많게
//     m.verifyGraph(await page.evaluate(m.readGraphProbe))
// CI에서는 test/body-390.test.mjs가 판정 함수(verify*)와 라벨 배치 순수 함수(graph2d-labels.mjs placeLabels)를 잠근다.
/* global document, window, getComputedStyle, NodeFilter, CanvasRenderingContext2D -- measure·probe 함수는 페이지 안(page.evaluate)에서 돈다 */

/** 쪽지함 — 표마다 가로 스크롤 양, 카드 밖으로 나간 칸·버튼 수. */
export function measureMail() {
  const doc = document.documentElement;
  const cards = [...document.querySelectorAll('table.table')].map((table) => {
    const card = table.closest('.card');
    const cr = card.getBoundingClientRect();
    const out = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && (r.right > cr.right + 0.5 || r.left < cr.left - 0.5); };
    const cells = [...table.querySelectorAll('tbody td')].filter((td) => td.getClientRects().length);
    const controls = [...table.querySelectorAll('tbody button, tbody a')].filter((el) => el.getClientRects().length);
    let scroll = 0;
    for (let el = table; el && el !== card; el = el.parentElement) scroll = Math.max(scroll, el.scrollWidth - el.clientWidth);
    return {
      title: card.querySelector('.card-title')?.textContent ?? '',
      rows: table.querySelectorAll('tbody tr').length,
      scroll,
      cellsOutside: cells.filter(out).length,
      controls: controls.length,
      controlsOutside: controls.filter(out).length,
    };
  });
  return { viewport: doc.clientWidth, docOverflow: doc.scrollWidth - doc.clientWidth, cards };
}

/** measureMail 판정 — 실패 문장 목록(빈 배열 = 통과). */
export function verifyMail(m) {
  const fails = [];
  const check = (name, ok, detail) => { if (!ok) fails.push(`${name}: ${JSON.stringify(detail)}`); };
  check('문서가 가로로 넘치지 않는다', m.docOverflow <= 0, m.docOverflow);
  check('표 셋을 모두 행이 있는 상태로 쟀다', m.cards.length === 3 && m.cards.every((c) => c.rows > 0), m.cards.map((c) => c.rows));
  for (const c of m.cards) {
    check(`${c.title}: 카드 안 가로 스크롤 없음(scrollWidth ≤ clientWidth)`, c.scroll <= 0, c.scroll);
    check(`${c.title}: 받는 사람·상태·시간 칸이 카드 안에 있다`, c.cellsOutside === 0, c.cellsOutside);
    check(`${c.title}: 버튼이 카드 안에 있다`, c.controlsOutside === 0, [c.controlsOutside, c.controls]);
  }
  return fails;
}

/** 회의실 — 입력 안내가 한 줄에 들어가는지, 고정 폴더 줄에서 폴더 이름(경로 마지막 칸)이 다 보이는지. */
export function measureRoom() {
  const doc = document.documentElement;
  const ta = document.querySelector('.input-bar textarea');
  const cs = getComputedStyle(ta);
  const ctx = document.createElement('canvas').getContext('2d');
  ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  const placeholder = {
    text: ta.placeholder,
    width: Math.ceil(ctx.measureText(ta.placeholder).width),
    avail: Math.floor(ta.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)),
  };
  const row = document.querySelector('.composer-stack .row');
  let folder = null;
  if (row) {
    const name = row.querySelector('.name');
    const act = row.querySelector('.act');
    const leaf = String(row.title || '').split(/[\\/]/).filter(Boolean).pop() ?? '';
    const nr = name.getBoundingClientRect();
    let leafRight = Infinity; let leafClipped = true;
    const walker = document.createTreeWalker(name, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const at = leaf ? n.data.lastIndexOf(leaf) : -1;
      if (at < 0) continue;
      const range = document.createRange(); range.setStart(n, at); range.setEnd(n, at + leaf.length);
      leafRight = range.getBoundingClientRect().right;
      const host = n.parentElement;
      // 글자 끝이 보이는 칸(자기 칸·.name 중 좁은 쪽) 오른쪽을 넘으면 잘림 — scrollWidth는 정수로 반올림돼 소수점 말줄임(0.2px)을 놓친다
      leafClipped = leafRight > Math.min(nr.right, host.getBoundingClientRect().right) + 0.05;
    }
    const ar = act.getBoundingClientRect(); const rr = row.getBoundingClientRect();
    folder = { leaf, leafRight: Math.round(leafRight * 100) / 100, nameRight: Math.round(nr.right * 100) / 100, leafClipped, actInside: ar.width > 0 && ar.left >= rr.left - 0.5 && ar.right <= rr.right + 0.5 };
  }
  return { viewport: doc.clientWidth, docOverflow: doc.scrollWidth - doc.clientWidth, placeholder, folder };
}

/** measureRoom 판정. 고정 폴더 없이 쟀으면 실패 — 잘림을 못 본 측정은 통과가 아니다. */
export function verifyRoom(m) {
  const fails = [];
  const check = (name, ok, detail) => { if (!ok) fails.push(`${name}: ${JSON.stringify(detail)}`); };
  check('문서가 가로로 넘치지 않는다', m.docOverflow <= 0, m.docOverflow);
  check('입력 안내가 입력창 한 줄에 들어간다', !!m.placeholder.text && m.placeholder.width <= m.placeholder.avail, m.placeholder);
  check('고정 폴더 줄을 쟀다', !!m.folder, m.folder);
  if (m.folder) {
    check('폴더 이름(경로 마지막 칸)이 잘리지 않는다', !m.folder.leafClipped, m.folder);
    check('고정 풀기 버튼이 줄 안에 보인다', m.folder.actInside, m.folder);
  }
  return fails;
}

/** 기억 그래프 측정 시작 — 캔버스 clearRect(= 한 프레임의 시작)와 fillText를 가로채 프레임별 라벨 상자(실제 글자 폭)를 모은다.
    프레임 경계를 requestAnimationFrame이 아니라 그래프 자신의 다시 그리기로 잡는다 — 같은 Space의 다른 탭이 앞에 있으면
    rAF가 느려져 기다리는 쪽이 시간 초과로 끝났다(10/9 실측). 읽기는 readGraphProbe. */
export function startGraphProbe() {
  const cv = document.querySelector('canvas');
  const proto = CanvasRenderingContext2D.prototype;
  const probe = { frames: [], cur: null, fill: proto.fillText, clear: proto.clearRect };
  proto.clearRect = function () {
    if (this.canvas === cv) { if (probe.cur) probe.frames.push(probe.cur); probe.cur = []; if (probe.frames.length > 80) probe.frames.shift(); }
    return probe.clear.apply(this, arguments);
  };
  proto.fillText = function (txt, x, y) {
    if (this.canvas === cv && probe.cur) {
      const px = parseFloat((this.font.match(/(\d+(?:\.\d+)?)px/) || [0, 12])[1]);
      const w = this.measureText(txt).width;
      const x0 = this.textAlign === 'right' || this.textAlign === 'end' ? x - w : this.textAlign === 'center' ? x - w / 2 : x;
      probe.cur.push({ txt, x0, x1: x0 + w, y0: y - px / 2, y1: y + px / 2 });
    }
    return probe.fill.apply(this, arguments);
  };
  window.__graphProbe = probe;
  return !!cv;
}

/** 기억 그래프 측정 읽기 — 가로채기를 풀고, 모은 프레임마다 라벨끼리 겹침·캔버스 밖을 세어 가장 나쁜 프레임을 돌려준다. */
export function readGraphProbe() {
  const probe = window.__graphProbe;
  const proto = CanvasRenderingContext2D.prototype;
  proto.fillText = probe.fill; proto.clearRect = probe.clear;
  delete window.__graphProbe;
  const cv = document.querySelector('canvas');
  const W = cv.clientWidth; const H = cv.clientHeight;
  let overlaps = []; let outside = []; let maxLabels = 0;
  for (const boxes of probe.frames) {
    maxLabels = Math.max(maxLabels, boxes.length);
    const ov = [];
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]; const b = boxes[j];
      if (a.x0 < b.x1 - 0.5 && b.x0 < a.x1 - 0.5 && a.y0 < b.y1 - 0.5 && b.y0 < a.y1 - 0.5) ov.push([a.txt, b.txt]);
    }
    const out = boxes.filter((b) => b.x0 < -0.5 || b.x1 > W + 0.5 || b.y0 < -0.5 || b.y1 > H + 0.5).map((b) => b.txt);
    if (ov.length > overlaps.length) overlaps = ov;
    if (out.length > outside.length) outside = out;
  }
  return { canvas: [W, H], frames: probe.frames.length, maxLabels, overlaps, outside };
}

/** readGraphProbe 판정 — 라벨을 그린 프레임에서 겹침 0·캔버스 밖 0. */
export function verifyGraph(m) {
  const fails = [];
  const check = (name, ok, detail) => { if (!ok) fails.push(`${name}: ${JSON.stringify(detail)}`); };
  check('라벨을 그린 프레임을 쟀다', m.frames > 0 && m.maxLabels > 0, [m.frames, m.maxLabels]);
  check('라벨끼리 겹치지 않는다(실제 글자 폭 기준)', m.overlaps.length === 0, m.overlaps.slice(0, 5));
  check('라벨이 캔버스 밖으로 잘리지 않는다', m.outside.length === 0, m.outside.slice(0, 5));
  return fails;
}
