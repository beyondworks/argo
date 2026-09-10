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
  const ref = useRef({ x: 0, y: 0, skip: false }); const start = ref.current; // 터치 도중 리렌더돼도 시작점을 잃지 않게
  if (!enabled) return {};
  return {
    onTouchStart: (e) => {
      const t = e.touches[0]; start.x = t.clientX; start.y = t.clientY;
      start.skip = !!e.target.closest?.('input, textarea, select, [contenteditable], .msgr-seg, .msgr-setnav');
    },
    onTouchEnd: (e) => {
      if (start.skip) return;
      const t = e.changedTouches[0]; const dx = t.clientX - start.x; const dy = t.clientY - start.y;
      if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      const i = order.indexOf(current); if (i < 0) return;
      const next = order[i + (dx < 0 ? 1 : -1)]; // 왼쪽으로 쓸면 다음 탭
      if (next != null) pick(next);
    },
  };
}
