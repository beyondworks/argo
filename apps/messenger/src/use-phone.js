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

// 왼쪽 가장자리에서 오른쪽으로 쓸면 뒤로 — iOS 내비게이션 관례(유건 2026-09-11). 2026-09-15 유건 제보("인터랙션이 어색하고 부자연스럽다") 뒤 손질:
//  · 밑에 까는 화면 = 실제로 돌아갈 루트(홈/DM). 전에는 늘 홈을 깔아 DM으로 돌아갈 때 화면이 튀었다.
//  · 손가락을 1:1로 따라간다(전엔 0.9배). 밑 화면은 -28%에서 따라 들어오고 어둡기가 걷힌다(styles.css .swiping-back).
//  · 처음 8px에서 방향을 잠근다: 세로면 제스처 포기, 가로면 세로 스크롤을 멈춘다(위아래로 튀던 것).
//  · 놓을 때 남은 거리·속도로 길이를 정한다(140~280ms). 화면 폭 35% 이상 또는 빠른 튕김이면 넘어가고, 아니면 제자리.
export function useEdgeSwipeBack(onBack, enabled = true, { underlay = () => 'home' } = {}) {
  const ref = useRef({ x: 0, y: 0, t: 0, edge: false, dir: null, dx: 0, el: null, classes: [] }); const st = ref.current;
  if (!enabled) return {};
  const shell = () => document.querySelector('.msgr-shell');
  const setP = (p) => shell()?.style.setProperty('--swipe-p', String(Math.max(0, Math.min(1, p))));
  const cleanup = () => { const sh = shell(); if (sh) { sh.classList.remove('swiping-back', 'settling', ...st.classes); sh.style.removeProperty('--swipe-p'); sh.style.removeProperty('--swipe-ms'); } st.classes = []; if (st.el) { st.el.style.overflowY = ''; st.el.style.willChange = ''; } };
  const settle = (el, to, ms, then) => {
    const sh = shell(); sh?.classList.add('settling'); sh?.style.setProperty('--swipe-ms', `${ms}ms`);
    el.style.transition = `transform ${ms}ms cubic-bezier(.2,.8,.2,1)`; el.style.transform = to;
    let fired = false;
    const done = () => { if (fired) return; fired = true; el.removeEventListener('transitionend', done); then?.(); requestAnimationFrame(() => { el.style.transition = ''; el.style.transform = ''; cleanup(); }); };
    el.addEventListener('transitionend', done); setTimeout(done, ms + 80); // transitionend가 안 오는 경우(탭 전환·리렌더)의 안전망
  };
  return {
    onTouchStart: (e) => { const t = e.touches[0]; st.x = t.clientX; st.y = t.clientY; st.t = e.timeStamp; st.dx = 0; st.dir = null; st.edge = t.clientX <= 28; st.el = e.currentTarget; },
    onTouchMove: (e) => {
      if (!st.edge) return;
      const t = e.touches[0]; const dx = t.clientX - st.x; const dy = t.clientY - st.y;
      if (!st.dir) {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        st.dir = dx > 0 && dx > Math.abs(dy) * 1.2 ? 'x' : 'y';
        if (st.dir === 'y') { st.edge = false; return; }
        st.classes = underlay() === 'dm' ? ['phone-home', 'phone-dm'] : ['phone-home'];
        shell()?.classList.add('swiping-back', ...st.classes);
        st.el.style.willChange = 'transform'; st.el.style.transition = ''; st.el.style.overflowY = 'hidden';
      }
      const w = st.el.clientWidth || 1; st.dx = Math.max(0, Math.min(dx, w));
      st.el.style.transform = `translateX(${st.dx}px)`; setP(st.dx / w);
    },
    onTouchEnd: (e) => {
      if (!st.edge || !st.el || st.dir !== 'x') { st.edge = false; return; }
      const el = st.el; const w = el.clientWidth || 1; const dx = st.dx; const v = dx / Math.max(1, e.timeStamp - st.t); // px/ms
      const go = dx >= w * 0.35 || (dx >= 40 && v > 0.5);
      const remain = go ? w - dx : dx; const ms = Math.round(Math.min(280, Math.max(140, remain / Math.max(v, 0.9))));
      setP(go ? 1 : 0);
      if (go) settle(el, `translateX(${w}px)`, ms, onBack); else settle(el, 'translateX(0)', ms);
      st.edge = false;
    },
    onTouchCancel: () => { if (st.el && st.dx) { setP(0); settle(st.el, 'translateX(0)', 180); } else cleanup(); st.edge = false; },
  };
}
