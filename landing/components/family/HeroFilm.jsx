'use client';

import { useEffect, useRef, useState } from 'react';
import { prefersReducedMotion } from '@/lib/gsap';

// 메신저 히어로 필름(블렌더 렌더, 10초) — 두 회사의 판 → 주노의 카드가 건너감 → 아틀라스의 답 → 한 채널로 합쳐짐.
// 한 번 재생하고 마지막 장면(합쳐진 채널)에서 멈춘다. 위로 벗어났다 돌아오면 다시 재생. 움직임을 줄인 환경에선 마지막 장면 사진만.
export default function HeroFilm({ lang, base = 'messenger-hero', className = 'hero-film' }) {
  const ref = useRef(null);
  const [still, setStill] = useState(false);
  const src = `/assets/${base}-${lang}.mp4`;

  useEffect(() => {
    if (prefersReducedMotion()) { setStill(true); return undefined; }
    const v = ref.current;
    let seen = false;
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting && !seen) { seen = true; v.currentTime = 0; v.play().catch(() => {}); }
      else if (!e.isIntersecting) { seen = false; v.pause(); }
    }, { threshold: 0.35 });
    io.observe(v);
    return () => io.disconnect();
  }, [lang]);

  if (still) return <img className={className} src={`/assets/${base}-${lang}-end.jpg`} alt="" />;
  return (
    <video
      key={lang}
      ref={ref}
      className={className}
      src={src}
      poster={`/assets/${base}-${lang}.jpg`}
      muted
      playsInline
      preload="auto"
      aria-hidden="true"
    />
  );
}
