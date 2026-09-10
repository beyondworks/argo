import { useEffect, useRef, useState } from 'react';

// 폰 셸 판정 — styles.css의 모바일 미디어쿼리와 '같은 경계'(720px)를 쓴다. 경계가 갈리면 레이아웃과 동작이 어긋난다.
// 네이티브 플래그(isMobilePlatform)를 쓰지 않는 이유: 브라우저를 좁혀서 보는 검수·디자인 작업에서도 같은 셸이어야 한다.
export const PHONE_QUERY = '(max-width: 720px)';

export function useIsPhone() {
  const [phone, setPhone] = useState(() => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(PHONE_QUERY).matches : false));
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined;
    const mq = window.matchMedia(PHONE_QUERY);
    const on = () => setPhone(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return phone;
}

// 탭 페이지(알림함 거르개·설정 탭)의 좌우 스와이프 — 본문을 쓸면 옆 탭으로(유건 2026-09-10). 하단 아일랜드와는 무관하다.
// 세로 스크롤과 겹치지 않게: 가로 60px 이상 + 가로가 세로보다 확실히 클 때만. 가로 스크롤 상자(분절 컨트롤 등) 안에서 시작한 터치는 제외.
export function useSwipeTabs(order, current, pick, enabled = true) {
  const ref = useRef({ x: 0, y: 0, skip: false, dir: null, el: null }); const start = ref.current; // 터치 도중 리렌더돼도 시작점을 잃지 않게
  if (!enabled) return {};
  const unlock = () => { if (start.el && start.dir === 'x') start.el.style.overflowY = ''; start.dir = null; };
  return {
    onTouchStart: (e) => {
      const t = e.touches[0]; start.x = t.clientX; start.y = t.clientY; start.dir = null; start.el = e.currentTarget;
      start.skip = !!e.target.closest?.('input, textarea, select, [contenteditable], .msgr-seg, .msgr-setnav');
    },
    onTouchMove: (e) => { // 방향 잠금: 처음 10px에서 가로로 정해지면 놓을 때까지 세로 스크롤을 멈춘다(스와이프 중 위아래로 튀던 것)
      if (start.skip || start.dir) return;
      const t = e.touches[0]; const dx = Math.abs(t.clientX - start.x); const dy = Math.abs(t.clientY - start.y);
      if (dx < 10 && dy < 10) return;
      start.dir = dx > dy * 1.2 ? 'x' : 'y'; if (start.dir === 'x') start.el.style.overflowY = 'hidden';
    },
    onTouchCancel: unlock,
    onTouchEnd: (e) => {
      const wasX = start.dir === 'x'; unlock();
      if (start.skip || !wasX) return;
      const t = e.changedTouches[0]; const dx = t.clientX - start.x; const dy = t.clientY - start.y;
      if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      const i = order.indexOf(current); if (i < 0) return;
      const next = order[i + (dx < 0 ? 1 : -1)]; // 왼쪽으로 쓸면 다음 탭
      if (next != null) pick(next);
    },
  };
}

// 왼쪽 가장자리에서 오른쪽으로 쓸면 뒤로(홈) — iOS 내비게이션 관례(유건 2026-09-11).
// 손가락을 따라 화면이 밀리고(transform), 놓으면 100px 이상 또는 빠른 튕김일 때만 넘어간다. 아니면 제자리로(민감·불안정 지적 반영).
export function useEdgeSwipeBack(onBack, enabled = true) {
  const ref = useRef({ x: 0, y: 0, t: 0, edge: false, dx: 0, el: null }); const st = ref.current;
  if (!enabled) return {};
  const shell = () => document.querySelector('.msgr-shell');
  const settle = (el, to, then) => { el.style.transition = 'transform 220ms cubic-bezier(.2,.8,.2,1)'; el.style.transform = to; const done = () => { el.removeEventListener('transitionend', done); then?.(); requestAnimationFrame(() => { el.style.transition = ''; el.style.transform = ''; shell()?.classList.remove('swiping-back'); }); }; el.addEventListener('transitionend', done); }; // 페이지가 먼저 바뀐 뒤 스타일·표지를 지운다(잔상 방지)
  return {
    onTouchStart: (e) => { const t = e.touches[0]; st.x = t.clientX; st.y = t.clientY; st.t = e.timeStamp; st.dx = 0; st.edge = t.clientX <= 24; st.el = e.currentTarget; },
    onTouchMove: (e) => {
      if (!st.edge) return;
      const t = e.touches[0]; const dx = t.clientX - st.x; const dy = t.clientY - st.y;
      if (dx < 8 || Math.abs(dy) > Math.abs(dx)) { if (st.dx) { st.el.style.transform = ''; st.dx = 0; } return; }
      if (!st.dx) shell()?.classList.add('swiping-back'); // 첫 움직임에 홈을 밑에 깐다
      st.dx = dx; st.el.style.transition = ''; st.el.style.transform = `translateX(${Math.min(dx, st.el.clientWidth) * 0.9}px)`; // 손가락보다 살짝 덜 따라와 무게감
    },
    onTouchEnd: (e) => {
      if (!st.edge || !st.el) return;
      const el = st.el; const dx = st.dx; const v = dx / Math.max(1, e.timeStamp - st.t); // px/ms
      const go = dx >= 100 || (dx >= 48 && v > 0.55);
      if (go) settle(el, `translateX(${el.clientWidth}px)`, onBack); else if (dx) settle(el, 'translateX(0)');
    },
    onTouchCancel: () => { if (st.el && st.dx) settle(st.el, 'translateX(0)'); },
  };
}
