'use client';

import { createContext, useContext, useEffect, useRef, useState } from 'react';
import Lenis from 'lenis';
import { gsap, ScrollTrigger, prefersReducedMotion } from '@/lib/gsap';

const LenisContext = createContext({ lenis: null });

export function useLenis() {
  return useContext(LenisContext);
}

const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export default function SmoothScroll({ children }) {
  const [lenis, setLenis] = useState(null);
  const rafCb = useRef(null);

  // ── Lenis: 프로그램 스크롤 애니메이터로만 사용 (휠 스무딩 끔 — 스냅이 스크롤을 직접 몬다) ──
  useEffect(() => {
    if (prefersReducedMotion()) {
      document.documentElement.classList.add('no-motion');
      return undefined;
    }

    const instance = new Lenis({ lerp: 0.11, smoothWheel: false, syncTouch: false });
    instance.on('scroll', ScrollTrigger.update);
    rafCb.current = (time) => instance.raf(time * 1000);
    gsap.ticker.add(rafCb.current);
    gsap.ticker.lagSmoothing(0);
    setLenis(instance);
    window.__lenis = instance;
    window.__ST = ScrollTrigger;

    return () => {
      gsap.ticker.remove(rafCb.current);
      instance.destroy();
      setLenis(null);
    };
  }, []);

  // ── 스냅 컨트롤러: 한 제스처 = 한 장면, 자석처럼 정착 (풀페이지식) ──
  useEffect(() => {
    if (!lenis) return undefined;

    // 풀높이 섹션(--app-vh)을 실제 innerHeight로 고정 — 모바일 주소창 높이 변화로
    // svh가 흔들리며 핀 높이와 어긋나 콘텐츠가 아래로 쏠리는 문제 방지.
    const root = document.documentElement;
    const setVH = () => {
      const vh = window.innerHeight;
      if (vh > 0) root.style.setProperty('--app-vh', `${vh}px`); // 순간 0 보고 시 레이아웃 붕괴 방지
    };
    setVH();
    let lastW = window.innerWidth;
    // 폭이 바뀐 실제 리사이즈/회전만 반영(주소창 높이 변화는 무시 → 재계산 churn 없음)
    const onResize = () => {
      if (window.innerWidth !== lastW) {
        lastW = window.innerWidth;
        setVH();
        ScrollTrigger.refresh();
      }
    };
    const onOrient = () => {
      setVH();
      ScrollTrigger.refresh();
    };

    const maxScroll = () =>
      Math.max(0, document.documentElement.scrollHeight - window.innerHeight);

    // 스크롤 위치(px) 스냅 지점들을 계산 — 핀 챕터는 타임라인 라벨 시간을 스크롤 위치로 환산
    let snaps = [];
    const build = () => {
      const pts = [];
      const triggers = ScrollTrigger.getAll();

      const hero = triggers.find((t) => t.trigger?.classList?.contains('hero-section'));
      if (hero) {
        pts.push(hero.start); // 표지
        pts.push(hero.start + 0.72 * (hero.end - hero.start)); // 조립 완성(홀드)
      }

      // 각 핀 챕터 — 인트로 + 기능별 정지점(완전히 보이는 순간 = 라벨 + 0.4)
      document.querySelectorAll('.chapter-stage').forEach((stage) => {
        const t = triggers.find((tr) => tr.trigger === stage);
        if (!t || !t.animation) return;
        const total = t.animation.duration() || 1;
        const range = t.end - t.start;
        const at = (time) => t.start + (time / total) * range;
        pts.push(at(0.5)); // 인트로
        const labels = t.animation.labels || {};
        Object.keys(labels)
          .filter((k) => k.startsWith('feat'))
          .forEach((k) => pts.push(at(labels[k] + 0.4)));
      });

      // 핀 아닌 전체 섹션 — 상단을 뷰포트에 맞춤
      ['.core-section', '.interlude', '.download-section'].forEach((sel) => {
        const el = document.querySelector(sel);
        if (el) pts.push(el.getBoundingClientRect().top + window.scrollY);
      });

      pts.push(maxScroll()); // 마지막(가격 하단 + 푸터)

      const mx = maxScroll();
      const uniq = [...new Set(pts.map((y) => Math.round(Math.min(mx, Math.max(0, y)))))].sort(
        (a, b) => a - b
      );
      // 너무 가까운 지점 병합(40px 이내)
      snaps = uniq.filter((y, i) => i === 0 || y - uniq[i - 1] > 40);
    };

    const nearest = (y) => {
      let bi = 0;
      let bd = Infinity;
      for (let i = 0; i < snaps.length; i += 1) {
        const d = Math.abs(snaps[i] - y);
        if (d < bd) {
          bd = d;
          bi = i;
        }
      }
      return bi;
    };

    let locked = false;
    let timer = 0;
    // 타이머 기반 트윈 — 매 스텝 immediate 스크롤 적용.
    // (rAF/Lenis 애니메이션 scrollTo는 백그라운드·특정 환경에서 멈추므로 setTimeout으로 확실히 구동)
    const go = (dir) => {
      // 라이트박스 열려 있으면 스냅 내비 정지
      if (document.documentElement.classList.contains('lightbox-open')) return;
      if (locked || snaps.length < 2) return;
      const cur = lenis.animatedScroll ?? window.scrollY;
      const idx = nearest(cur);
      const target = Math.min(snaps.length - 1, Math.max(0, idx + dir));
      if (snaps[target] === undefined || Math.abs(snaps[target] - cur) < 4) return;
      const from = cur;
      const to = snaps[target];
      const dist = Math.abs(to - from);
      const dur = Math.min(1300, Math.max(650, 520 + (dist / window.innerHeight) * 160));
      locked = true;
      const t0 = performance.now();
      const step = () => {
        const p = Math.min(1, (performance.now() - t0) / dur);
        lenis.scrollTo(from + (to - from) * easeInOutCubic(p), { immediate: true });
        if (p < 1) {
          timer = setTimeout(step, 16);
        } else {
          timer = 0;
          locked = false;
        }
      };
      step();
    };

    // ── 휠: 연속 이벤트 스트림(트랙패드)을 한 스텝으로 — 쉰 뒤에만 재무장 ──
    let armed = true;
    let quiet;
    const onWheel = (e) => {
      e.preventDefault();
      if (Math.abs(e.deltaY) < 6) return;
      clearTimeout(quiet);
      quiet = setTimeout(() => {
        armed = true;
      }, 140);
      if (!armed || locked) return;
      armed = false;
      go(e.deltaY > 0 ? 1 : -1);
    };

    // ── 터치: 스와이프 한 번 = 한 스텝 ──
    let ty = 0;
    let tmoved = false;
    const onTouchStart = (e) => {
      ty = e.touches[0].clientY;
      tmoved = false;
    };
    const onTouchMove = (e) => {
      e.preventDefault();
      tmoved = true;
    };
    const onTouchEnd = (e) => {
      if (!tmoved) return;
      const dy = ty - (e.changedTouches[0]?.clientY ?? ty);
      if (Math.abs(dy) > 40) go(dy > 0 ? 1 : -1);
    };

    const onKey = (e) => {
      if (['ArrowDown', 'PageDown', ' ', 'Spacebar'].includes(e.key)) {
        e.preventDefault();
        go(1);
      } else if (['ArrowUp', 'PageUp'].includes(e.key)) {
        e.preventDefault();
        go(-1);
      } else if (e.key === 'Home') {
        e.preventDefault();
        if (snaps.length) lenis.scrollTo(snaps[0], { duration: 1, easing: easeInOutCubic });
      } else if (e.key === 'End') {
        e.preventDefault();
        if (snaps.length) lenis.scrollTo(snaps[snaps.length - 1], { duration: 1, easing: easeInOutCubic });
      }
    };

    // 스냅 지점 계산 — 동기 즉시 + 레이아웃 정착 후 재계산 + 리프레시마다 재계산
    const rebuild = () => build();
    ScrollTrigger.addEventListener('refresh', rebuild);
    window.__snaps = () => snaps;
    build(); // 자식 useGSAP가 이미 트리거를 만든 뒤라 즉시 계산 가능
    // 폰트·이미지 로드로 뷰포트/위치가 밀린 경우 보정 — 핀을 실제 높이로 재측정
    const settle = setTimeout(() => {
      setVH();
      ScrollTrigger.refresh();
    }, 300);

    window.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('touchstart', onTouchStart, { passive: true });
    window.addEventListener('touchmove', onTouchMove, { passive: false });
    window.addEventListener('touchend', onTouchEnd, { passive: true });
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onOrient);

    return () => {
      clearTimeout(settle);
      if (timer) clearTimeout(timer);
      ScrollTrigger.removeEventListener('refresh', rebuild);
      window.removeEventListener('wheel', onWheel);
      window.removeEventListener('touchstart', onTouchStart);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchend', onTouchEnd);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onOrient);
    };
  }, [lenis]);

  return <LenisContext.Provider value={{ lenis }}>{children}</LenisContext.Provider>;
}
