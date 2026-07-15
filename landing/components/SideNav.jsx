'use client';

import { useEffect, useState } from 'react';
import { useLang } from '@/lib/i18n';
import { useLenis } from '@/components/SmoothScroll';
import { CHAPTERS } from '@/lib/chapters';

function StarMark() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 1 L14.2 9.8 L23 12 L14.2 14.2 L12 23 L9.8 14.2 L1 12 L9.8 9.8 Z"
        fill="currentColor"
      />
    </svg>
  );
}

// 데스크톱 좌측 컴팩트 섹션 내비게이터 — 현재 섹션 하이라이트 + 클릭 시 내용이 보이는 지점으로 스크롤.
export default function SideNav() {
  const { t } = useLang();
  const { lenis } = useLenis();
  const [active, setActive] = useState('top');

  const items = [
    { id: 'top', label: t('side.top'), selector: '.hero-section' },
    ...CHAPTERS.map((c) => ({ id: c.id, label: t(`${c.id}.short`), selector: `#${c.id}` })),
    { id: 'download', label: t('nav.cta'), selector: '#download' },
    { id: 'contact', label: t('nav.contact'), selector: '#contact' },
  ];

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    let marks = [];
    const compute = () => {
      marks = items
        .map((it) => {
          const el = document.querySelector(it.selector);
          return el ? { id: it.id, top: el.getBoundingClientRect().top + window.scrollY } : null;
        })
        .filter(Boolean)
        .sort((a, b) => a.top - b.top);
    };
    const update = () => {
      if (!marks.length) return;
      const y = (lenis ? lenis.animatedScroll : window.scrollY) + window.innerHeight * 0.4;
      let cur = marks[0].id;
      for (const m of marks) if (y >= m.top - 4) cur = m.id;
      setActive(cur);
    };
    const onScroll = () => update();
    const onResize = () => {
      compute();
      update();
    };
    compute();
    update();
    const settle = setTimeout(() => {
      compute();
      update();
    }, 500);
    if (lenis) lenis.on('scroll', onScroll);
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onResize);
    return () => {
      clearTimeout(settle);
      if (lenis) lenis.off('scroll', onScroll);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onResize);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lenis]);

  const go = (item) => {
    // 핀 챕터는 인트로(내용 보이는) 지점으로 — 검정 핀-시작 착지 방지
    const targets = window.__navTargets ? window.__navTargets() : null;
    const y = targets && typeof targets[item.id] === 'number' ? targets[item.id] : null;
    if (y !== null) {
      if (lenis) lenis.scrollTo(y, { duration: 1.4 });
      else window.scrollTo({ top: y, behavior: 'smooth' });
      return;
    }
    // 폴백 — 요소 상단
    const el = document.querySelector(item.selector);
    if (item.selector === '.hero-section') {
      if (lenis) lenis.scrollTo(0, { duration: 1.4 });
      else window.scrollTo({ top: 0, behavior: 'smooth' });
    } else if (el) {
      if (lenis) lenis.scrollTo(el, { duration: 1.4 });
      else el.scrollIntoView({ behavior: 'smooth' });
    }
  };

  return (
    <nav className="side-nav" aria-label="섹션 내비게이션">
      <ul>
        {items.map((it) => (
          <li key={it.id}>
            <button
              type="button"
              className={`side-nav-item${active === it.id ? ' on' : ''}`}
              onClick={() => go(it)}
            >
              <span className="side-nav-star" aria-hidden>
                <StarMark />
              </span>
              <span className="side-nav-label">{it.label}</span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
