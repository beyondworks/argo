'use client';

import { useEffect, useRef } from 'react';

// 제품 영상 반복 재생(소리 없음)
export default function FilmLoop({ src, poster }) {
  const ref = useRef(null);
  // 화면에 들어올 때만 재생 — 밖에서는 멈춰 배터리·전송량을 아낀다
  useEffect(() => {
    const v = ref.current;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined;
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) v.play().catch(() => {}); else v.pause(); }, { threshold: 0.25 });
    io.observe(v);
    return () => io.disconnect();
  }, []);
  return <video ref={ref} className="m-film-video" src={src} poster={poster} muted loop playsInline preload="metadata" />;
}
