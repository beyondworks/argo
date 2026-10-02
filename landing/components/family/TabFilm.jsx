'use client';

import { useEffect, useRef, useState } from 'react';
import { prefersReducedMotion } from '@/lib/gsap';
import { useLang } from '@/lib/i18n';

// "데려오기"·"사용법" 탭 무대 — 블렌더 클립(4초, 폰 하나 + 떠오르는 카드)을 한 번 재생하고 마지막 장면에서 멈춘다.
// StageTabs가 탭이 바뀔 때마다 key로 다시 붙이므로 매번 처음부터 재생된다. 화면에 들어올 때 재생하고(페이지를 열 때
// 미리 끝나 버리지 않게), 벗어났다 돌아오면 다시 처음부터. 움직임을 줄인 환경에선 마지막 장면 사진만.
// 경로는 고정 문자열로 — 빌드 전 자산 검사(scripts/check-assets.mjs)가 public에 파일이 있는지 확인한다
const CLIPS = {
  crew: { en: ['/assets/tabs/crew-en.mp4', '/assets/tabs/crew-en-end.jpg'], ko: ['/assets/tabs/crew-ko.mp4', '/assets/tabs/crew-ko-end.jpg'] },
  hermes: { en: ['/assets/tabs/hermes-en.mp4', '/assets/tabs/hermes-en-end.jpg'], ko: ['/assets/tabs/hermes-ko.mp4', '/assets/tabs/hermes-ko-end.jpg'] },
  vps: { en: ['/assets/tabs/vps-en.mp4', '/assets/tabs/vps-en-end.jpg'], ko: ['/assets/tabs/vps-ko.mp4', '/assets/tabs/vps-ko-end.jpg'] },
  talk: { en: ['/assets/tabs/talk-en.mp4', '/assets/tabs/talk-en-end.jpg'], ko: ['/assets/tabs/talk-ko.mp4', '/assets/tabs/talk-ko-end.jpg'] },
  handoff: { en: ['/assets/tabs/handoff-en.mp4', '/assets/tabs/handoff-en-end.jpg'], ko: ['/assets/tabs/handoff-ko.mp4', '/assets/tabs/handoff-ko-end.jpg'] },
  approve: { en: ['/assets/tabs/approve-en.mp4', '/assets/tabs/approve-en-end.jpg'], ko: ['/assets/tabs/approve-ko.mp4', '/assets/tabs/approve-ko-end.jpg'] },
  memory: { en: ['/assets/tabs/memory-en.mp4', '/assets/tabs/memory-en-end.jpg'], ko: ['/assets/tabs/memory-ko.mp4', '/assets/tabs/memory-ko-end.jpg'] },
};

export default function TabFilm({ name }) {
  const { lang } = useLang();
  const ref = useRef(null);
  const [still, setStill] = useState(false);
  const [src, end] = CLIPS[name][lang] || CLIPS[name].en;

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

  if (still) return <img className="tab-film" src={end} alt="" />;
  return <video className="tab-film" key={src} ref={ref} src={src} muted playsInline preload="auto" aria-hidden="true" />;
}
