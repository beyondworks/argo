'use client';

import { useEffect, useRef, useState } from 'react';
import { prefersReducedMotion } from '@/lib/gsap';
import { useLang } from '@/lib/i18n';

// "데려오기"·"사용법" 탭 무대 — 블렌더 클립(4초, 폰 하나 + 떠오르는 카드)을 한 번 재생하고 마지막 장면에서 멈춘다.
// StageTabs가 탭이 바뀔 때마다 key로 다시 붙이므로 매번 처음부터 재생된다. 화면에 들어올 때 재생하고(페이지를 열 때
// 미리 끝나 버리지 않게), 벗어났다 돌아오면 다시 처음부터. 움직임을 줄인 환경에선 마지막 장면 사진만.
export default function TabFilm({ name }) {
  const { lang } = useLang();
  const ref = useRef(null);
  const [still, setStill] = useState(false);
  const src = `/assets/tabs/${name}-${lang}`;

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
  }, [src]);

  if (still) return <img className="tab-film" src={`${src}-end.jpg`} alt="" />;
  return <video className="tab-film" key={src} ref={ref} src={`${src}.mp4`} muted playsInline preload="auto" aria-hidden="true" />;
}
