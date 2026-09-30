// 격자 모션 — 폭·줄이 바뀔 때 모듈이 이전 자리·크기에서 새 자리·크기로 미끄러진다(FLIP).
// 0.24초 ease-out(emil: 사용자가 보고 있는 순간에 먼저 움직인다). 동작 줄이기 설정이면 바로 바뀐다.
const EASE = 'cubic-bezier(0.23, 1, 0.32, 1)';

export function flipGrid(grid, mutate, duration = 240) {
  const play = flipPrepare(grid, duration);
  mutate();
  play();
}

/** 지금 자리를 재 두고, 돌려준 함수를 DOM이 바뀐 뒤에 부르면 그 자리에서 새 자리로 미끄러진다.
 *  React 상태로 바뀌는 순서(끌기 중 미리보기)는 flushSync가 이펙트 안에서 즉시 그리지 않으므로 layout effect에서 부른다(9/30). */
export function flipPrepare(grid, duration = 240) {
  const els = [...grid.querySelectorAll(':scope > .module')];
  const before = new Map(els.map((el) => [el, el.getBoundingClientRect()])); // 진행 중인 모션까지 포함한 "보이는" 자리
  els.forEach((el) => el.getAnimations().forEach((a) => a.cancel()));
  return () => play(els, before, duration);
}

function play(els, before, duration) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  for (const el of els) {
    if (!el.isConnected) continue;
    const a = before.get(el), b = el.getBoundingClientRect();
    if (Math.abs(a.left - b.left) + Math.abs(a.top - b.top) + Math.abs(a.width - b.width) + Math.abs(a.height - b.height) < 1) continue;
    el.animate([
      { transform: `translate(${a.left - b.left}px, ${a.top - b.top}px)`, width: `${a.width}px`, height: `${a.height}px` },
      { transform: 'translate(0, 0)', width: `${b.width}px`, height: `${b.height}px` },
    ], { duration, easing: EASE });
  }
}
