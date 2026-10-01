// 끄는 코드(module-move.js·module-resize.js)가 같이 쓰는 화면 읽기·알림 — 끌기를 시작할 때 불러온다(첫 화면 묶음 밖).
import { spanOf, freeOrder } from '../core/layout.js';

/**
 * 지금 화면의 격자. boxes = 보이는 모듈마다 { id, x, w, top, h }(격자 기준 px, 다른 모듈은 끄는 동안 이 자리에 그대로 있다).
 * 넓은 화면의 열은 저장값(자리 또는 옛 줄 규칙)에서 읽는다 — 화면 위치를 반올림하면 미끄러지는 중(FLIP)에 어긋난다.
 * narrow = 모든 모듈이 격자 폭을 다 쓴다(좁은 폭 한 줄에 하나) — 열은 못 바꾸고 순서만, 넓은 화면의 열(xs)은 그대로 둔다.
 */
export function readGrid(el, items) {
  const grid = el.parentElement, gap = parseFloat(getComputedStyle(grid).rowGap) || 0, width = grid.clientWidth;
  const visible = items.filter((it) => !it.hidden), xs = new Map(freeOrder(visible).map(({ it, x }) => [it.id, x]));
  const nodes = [...grid.children].filter((node) => xs.has(node.dataset.mod)), narrow = nodes.every((node) => node.offsetWidth >= width - 1);
  // 옛 배치(CSS 격자)는 같은 줄 모듈이 가장 큰 모듈 높이로 늘어나 있다 — 놓은 뒤에는 자유 격자(내용 높이)로 그리므로 내용 높이로 잰다(그리기 전에 되돌린다)
  const stretched = !grid.classList.contains('free') && !narrow;
  if (stretched) nodes.forEach((node) => { node.style.alignSelf = 'start'; });
  const boxes = nodes.map((node) => {
    const it = visible.find((v) => v.id === node.dataset.mod), w = narrow ? 12 : spanOf(it);
    return { id: it.id, x: narrow ? 0 : Math.min(xs.get(it.id), 12 - w), w, top: node.offsetTop, h: node.offsetHeight };
  });
  if (stretched) nodes.forEach((node) => { node.style.alignSelf = ''; });
  return { grid, gap, col: (width + gap) / 12, narrow, boxes, xs };
}

/** 스크린리더 알림(한 곳) — 같은 문장을 두 번 알려도 읽히게 비웠다가 잠시 뒤에 쓴다 */
let live;
export function say(text) {
  if (!live) {
    live = document.body.appendChild(document.createElement('div'));
    live.setAttribute('role', 'status'); live.setAttribute('aria-live', 'assertive');
    live.style.cssText = 'position:fixed;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap';
  }
  live.textContent = '';
  setTimeout(() => { live.textContent = text; }, 40);
}
