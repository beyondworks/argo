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
export const SWIPE_BACK_EDGE = 40; // 뒤로가기는 왼쪽 끝 40px에서만 시작(유건 승인 2026-09-29 — 카카오톡·왓츠앱·라인·아이메시지의 iOS 기본 방식. 목록 줄 밀기·밀어서 답장과 겹치지 않게)
export function canStartSwipeBack(target, x, width) { // eslint-disable-line no-unused-vars
  if (x > SWIPE_BACK_EDGE) return false;
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
/** 임계 감쇠 스프링 한 단계(반응 0.35초, 넘침 없음) — x·v는 px·px/s. 손을 뗀 속도를 그대로 이어받고, 도중에 다시 잡아도 현재 값에서 출발한다(유건 승인 초안 2026-09-29) */
export function springStep(x, v, target, dt, response = 0.35) {
  const k = (2 * Math.PI / response) ** 2, c = 4 * Math.PI / response;
  for (let i = 0; i < 4; i++) { const a = -k * (x - target) - c * v; v += a * dt / 4; x += v * dt / 4; }
  return [x, v];
}
/** 폰 큰 제목 접힘 정도 — 스크롤 8px부터 28px 동안 0→1(머리의 재질·작은 제목이 드러난다) */
export const headerCollapse = (y) => Math.min(1, Math.max(0, (y - 8) / 28));
export function useEdgeSwipeBack(onBack, enabled = true, { underlay = () => 'home', onStart = null, onEnd = null } = {}) {
  const ref = useRef({ x: 0, y: 0, base: 0, armed: false, dir: null, dx: 0, el: null, underlayEl: null, tabbarEl: null, classes: [], samples: [], raf: 0 }); const st = ref.current;
  const cb = useRef({}); cb.current = { onBack, underlay, onStart, onEnd };
  const [node, setNode] = useState(null);
  const shell = () => document.querySelector('.msgr-shell');
  // 스와이프 매 프레임에 셸의 상속 CSS 변수를 바꾸면 전체 화면 자식의 스타일이 다시 계산된다.
  // 실제로 변하는 밑 화면에만 값을 두어 긴 대화 목록에서도 드래그가 가볍게 유지되게 한다.
  const setP = (p) => { const v = String(Math.max(0, Math.min(1, p))); st.underlayEl?.style.setProperty('--swipe-p', v); st.tabbarEl?.style.setProperty('--swipe-p', v); }; // 탭바도 밑 화면과 함께 들어온다(초안 승인)
  const underlay_ = () => cb.current.underlay();
  const onEnd_ = () => cb.current.onEnd?.();
  const cleanup = (arrived = false) => { const sh = shell(); if (sh) { const to = arrived ? underlay_() : null; const keep = new Set(to === 'dm' ? ['phone-home', 'phone-dm'] : to === 'home' ? ['phone-home'] : []); /* 취소(제자리)면 전부 뗀다 */ sh.classList.remove('swiping-back', 'settling', ...st.classes.filter((k) => !keep.has(k))); } if (st.underlayEl) { st.underlayEl.style.removeProperty('--swipe-p'); st.underlayEl.style.removeProperty('--swipe-ms'); } st.tabbarEl?.style.removeProperty('--swipe-p'); st.underlayEl = null; st.tabbarEl = null; st.classes = []; if (st.el) st.el.style.willChange = ''; onEnd_(); };
  const paint = (el, x) => { el.style.transform = `translateX(${x}px)`; setP(x / (el.clientWidth || 1)); };
  // 놓은 뒤 마무리 — 스프링이 손을 뗀 속도(px/s)에서 출발한다. 끝나기 전에 다시 잡으면 start()가 멈추고 그 자리부터 따라간다
  const settle = (el, target, v0, then) => {
    cancelAnimationFrame(st.raf); let x = st.dx, v = v0, last = 0;
    const done = () => {
      st.raf = 0; // st.el은 cleanup이 will-change를 지울 때까지 둔다
      const finish = (arrived) => requestAnimationFrame(() => { el.style.transition = ''; el.style.transform = ''; cleanup(arrived); });
      if (!then) { finish(false); return; }
      // 뒤로: 밀린 상태를 유지한 채 history.back() → 화면이 실제로 바뀐 뒤(popstate) 정리. 400ms 안에 안 오면 그냥 정리(안전망)
      let ended = false; const onPop = () => { if (ended) return; ended = true; window.removeEventListener('popstate', onPop); finish(true); };
      window.addEventListener('popstate', onPop); setTimeout(onPop, 400); then();
    };
    if (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches) { st.dx = target; paint(el, target); done(); return; }
    const step = (now) => {
      const dt = Math.min(0.032, last ? (now - last) / 1000 : 1 / 60); last = now;
      [x, v] = springStep(x, v, target, dt);
      if (Math.abs(x - target) < 0.5 && Math.abs(v) < 10) { st.dx = target; paint(el, target); done(); return; }
      st.dx = x; paint(el, x); st.raf = requestAnimationFrame(step);
    };
    st.raf = requestAnimationFrame(step);
  };
  useEffect(() => {
    if (!enabled || !node) return undefined;
    const start = (e) => {
      const t = e.touches[0];
      if (st.raf && st.el === node && e.touches.length === 1) { // 마무리 중에 다시 잡음 — 그 자리부터 손가락을 따라간다(도중에 잡기)
        cancelAnimationFrame(st.raf); st.raf = 0; st.armed = true; st.dir = 'x'; st.base = t.clientX - st.dx; st.samples = []; return;
      }
      st.armed = e.touches.length === 1 && canStartSwipeBack(e.target, t.clientX, window.innerWidth);
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
        const sh = shell(); sh?.classList.add('swiping-back', ...st.classes); st.underlayEl = sh?.querySelector('.msgr-side') ?? null; st.tabbarEl = sh?.querySelector('.msgr-tabbar') ?? null; cb.current.onStart?.(to);
        st.el.style.willChange = 'transform'; st.el.style.transition = '';
      }
      e.preventDefault(); // 가로로 잠긴 뒤에는 세로 스크롤·바운스를 멈춘다
      const w = st.el.clientWidth || 1; st.dx = Math.max(0, Math.min(t.clientX - st.base, w));
      st.samples.push([e.timeStamp, t.clientX]); while (st.samples.length > 2 && e.timeStamp - st.samples[0][0] > 100) st.samples.shift();
      paint(st.el, st.dx);
    };
    const end = (e) => {
      if (!st.armed || !st.el || st.dir !== 'x') { st.armed = false; return; }
      const el = st.el; const w = el.clientWidth || 1;
      const [t0, x0] = st.samples[0] ?? [e.timeStamp, st.base]; const [t1, x1] = st.samples[st.samples.length - 1] ?? [e.timeStamp, st.base];
      const v = t1 > t0 ? (x1 - x0) / (t1 - t0) : 0;
      const vr = e.timeStamp - t1 > 120 ? 0 : v; // 멈춘 채 놓으면 속도 0
      const { go } = swipeRelease(st.dx, w, vr);
      settle(el, go ? w : 0, vr * 1000, go ? cb.current.onBack : null); // 손을 뗀 속도 그대로 이어서(px/ms → px/s)
      st.armed = false;
    };
    const cancel = () => { if (st.el && st.dx) settle(st.el, 0, 0); else if (st.dir === 'x') cleanup(); st.armed = false; };
    node.addEventListener('touchstart', start, { passive: true });
    node.addEventListener('touchmove', move, { passive: false });
    node.addEventListener('touchend', end, { passive: true });
    node.addEventListener('touchcancel', cancel, { passive: true });
    return () => { node.removeEventListener('touchstart', start); node.removeEventListener('touchmove', move); node.removeEventListener('touchend', end); node.removeEventListener('touchcancel', cancel); };
  }, [enabled, node]); // 콜백은 cb ref로 최신값을 읽으므로 의존성은 enabled·node뿐이다(이 레포 eslint에는 react-hooks 규칙이 없어 disable 주석을 쓰면 '규칙 없음' 오류가 난다)
  return { ref: setNode };
}
