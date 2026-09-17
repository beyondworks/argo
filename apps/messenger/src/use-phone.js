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
// 2026-09-15 유건 제보 2("깜빡이고 잔상이 남고 렉 걸린 것처럼"): ① 끝까지 밀린 뒤 history.back()을 부르고 바로 transform을 지워 화면 전환(popstate)이
// 오기 전 몇 프레임 동안 대화 화면이 제자리로 튀어 보였다 → popstate(또는 400ms)까지 밀린 상태를 유지한 뒤 정리. ② 밑 화면이 '대화 중의 레일'이라
// DM 탭 모양(필터·두 줄 행)이 아니어서 전환 순간 다시 그려졌다 → onStart(underlay)로 App이 미리 DM 탭 모양으로 그린다.
// 2026-09-17 유건 제보 3("왼쪽 끄트머리에서만 된다 / 천천히 밀면 화면이 튀거나 깜빡이고, 놓으면 어중간하게 멈추고, 뒤 화면이 비거나 겹친다"):
//  · 시작 영역 = 화면 왼쪽 절반(유건 결정). 입력창·가로 스크롤 중인 내용(코드·넓은 표) 위에서 시작하면 그 동작이 우선이다.
//  · 방향이 잠긴 지점을 기준점으로 삼아 따라간다 — 전에는 잠금 전 8px가 잠기는 순간 한꺼번에 반영돼 화면이 튀었다.
//  · 놓을 때는 전체 평균이 아니라 최근 100ms 속도로 판정한다 — 천천히 밀다 튕기면 넘어가고, 되돌리며 놓으면 제자리(평균은 방향을 몰랐다).
//  · 세로 스크롤은 네이티브 touchmove(passive:false)의 preventDefault로 막는다 — 스와이프 도중 대화 영역 overflow를 켰다 끄면 WebKit이 스크롤 층을 다시 그린다.
export const SWIPE_LOCK_PX = 10;
/** 시작 가능 여부 — 왼쪽 절반, 입력창 아님, 가로로 스크롤 가능한 조상 위가 아님 */
export function canStartSwipeBack(target, x, width) {
  if (x > width / 2) return false;
  for (let el = target; el && el.nodeType === 1; el = el.parentElement) {
    if (el.matches?.('input, textarea, select, [contenteditable="true"], .msgr-composer')) return false; // 입력줄(첨부·멘션 버튼 포함) 위에서는 뒤로가기 아님
    const ox = typeof getComputedStyle === 'function' ? getComputedStyle(el).overflowX : '';
    if ((ox === 'auto' || ox === 'scroll') && el.scrollWidth > el.clientWidth + 1) return false; // 가로로 스크롤되는 내용(코드·넓은 표) 위에서는 그 스크롤이 먼저(유건 결정)
  }
  return true;
}
/** 놓을 때 판정 — dx: 밀린 거리, w: 화면 폭, v: 최근 속도(px/ms, +는 뒤로 가는 방향). 반환 { go, ms } */
export function swipeRelease(dx, w, v) {
  const p = dx / Math.max(1, w);
  const go = v > 0.3 ? true : v < -0.3 ? false : p >= 0.35; // 멈춘 채 놓으면 35%(종전 기준 유지)
  const remain = go ? w - dx : dx;
  const ms = Math.round(Math.min(320, Math.max(160, remain / Math.max(Math.abs(v), 0.8))));
  return { go, ms };
}
export function useEdgeSwipeBack(onBack, enabled = true, { underlay = () => 'home', onStart = null, onEnd = null } = {}) {
  const ref = useRef({ x: 0, y: 0, base: 0, armed: false, dir: null, dx: 0, el: null, classes: [], samples: [] }); const st = ref.current;
  const cb = useRef({}); cb.current = { onBack, underlay, onStart, onEnd };
  const [node, setNode] = useState(null);
  const shell = () => document.querySelector('.msgr-shell');
  const setP = (p) => shell()?.style.setProperty('--swipe-p', String(Math.max(0, Math.min(1, p))));
  const underlay_ = () => cb.current.underlay();
  const onEnd_ = () => cb.current.onEnd?.();
  const cleanup = (arrived = false) => { const sh = shell(); if (sh) { const to = arrived ? underlay_() : null; const keep = new Set(to === 'dm' ? ['phone-home', 'phone-dm'] : to === 'home' ? ['phone-home'] : []); /* 취소(제자리)면 전부 뗀다 */ sh.classList.remove('swiping-back', 'settling', ...st.classes.filter((k) => !keep.has(k))); sh.style.removeProperty('--swipe-p'); sh.style.removeProperty('--swipe-ms'); } st.classes = []; if (st.el) st.el.style.willChange = ''; onEnd_(); };
  const settle = (el, to, ms, then) => {
    const sh = shell(); sh?.classList.add('settling'); sh?.style.setProperty('--swipe-ms', `${ms}ms`);
    el.style.transition = `transform ${ms}ms cubic-bezier(.2,.8,.2,1)`; el.style.transform = to;
    let fired = false;
    const done = () => { if (fired) return; fired = true; el.removeEventListener('transitionend', done);
      const finish = (arrived) => requestAnimationFrame(() => { el.style.transition = ''; el.style.transform = ''; cleanup(arrived); });
      if (!then) { finish(false); return; }
      // 뒤로: 밀린 상태를 유지한 채 history.back() → 화면이 실제로 바뀐 뒤(popstate) 정리. 400ms 안에 안 오면 그냥 정리(안전망)
      let ended = false; const onPop = () => { if (ended) return; ended = true; window.removeEventListener('popstate', onPop); finish(true); };
      window.addEventListener('popstate', onPop); setTimeout(onPop, 400); then(); };
    el.addEventListener('transitionend', done); setTimeout(done, ms + 80); // transitionend가 안 오는 경우(탭 전환·리렌더)의 안전망
  };
  useEffect(() => {
    if (!enabled || !node) return undefined;
    const start = (e) => {
      const t = e.touches[0]; st.armed = e.touches.length === 1 && canStartSwipeBack(e.target, t.clientX, window.innerWidth);
      st.x = t.clientX; st.y = t.clientY; st.dx = 0; st.dir = null; st.el = node; st.samples = [];
    };
    const move = (e) => {
      if (!st.armed) return;
      const t = e.touches[0]; const dx = t.clientX - st.x; const dy = t.clientY - st.y;
      if (!st.dir) {
        if (Math.abs(dx) < SWIPE_LOCK_PX && Math.abs(dy) < SWIPE_LOCK_PX) return;
        st.dir = dx > 0 && dx > Math.abs(dy) * 1.2 ? 'x' : 'y';
        if (st.dir === 'y') { st.armed = false; return; }
        st.base = t.clientX; // 잠긴 지점부터 따라간다(튐 방지)
        const to = underlay_(); st.classes = to === 'dm' ? ['phone-home', 'phone-dm'] : ['phone-home'];
        shell()?.classList.add('swiping-back', ...st.classes); cb.current.onStart?.(to);
        st.el.style.willChange = 'transform'; st.el.style.transition = '';
      }
      e.preventDefault(); // 가로로 잠긴 뒤에는 세로 스크롤·바운스를 멈춘다
      const w = st.el.clientWidth || 1; st.dx = Math.max(0, Math.min(t.clientX - st.base, w));
      st.samples.push([e.timeStamp, t.clientX]); while (st.samples.length > 2 && e.timeStamp - st.samples[0][0] > 100) st.samples.shift();
      st.el.style.transform = `translateX(${st.dx}px)`; setP(st.dx / w);
    };
    const end = (e) => {
      if (!st.armed || !st.el || st.dir !== 'x') { st.armed = false; return; }
      const el = st.el; const w = el.clientWidth || 1;
      const [t0, x0] = st.samples[0] ?? [e.timeStamp, st.base]; const [t1, x1] = st.samples[st.samples.length - 1] ?? [e.timeStamp, st.base];
      const v = t1 > t0 ? (x1 - x0) / (t1 - t0) : 0;
      const { go, ms } = swipeRelease(st.dx, w, e.timeStamp - t1 > 120 ? 0 : v); // 멈춘 채 놓으면 속도 0
      setP(go ? 1 : 0);
      if (go) settle(el, `translateX(${w}px)`, ms, cb.current.onBack); else settle(el, 'translateX(0)', ms);
      st.armed = false;
    };
    const cancel = () => { if (st.el && st.dx) { setP(0); settle(st.el, 'translateX(0)', 180); } else if (st.dir === 'x') cleanup(); st.armed = false; };
    node.addEventListener('touchstart', start, { passive: true });
    node.addEventListener('touchmove', move, { passive: false });
    node.addEventListener('touchend', end, { passive: true });
    node.addEventListener('touchcancel', cancel, { passive: true });
    return () => { node.removeEventListener('touchstart', start); node.removeEventListener('touchmove', move); node.removeEventListener('touchend', end); node.removeEventListener('touchcancel', cancel); };
  }, [enabled, node]); // eslint-disable-line react-hooks/exhaustive-deps
  return { ref: setNode };
}
