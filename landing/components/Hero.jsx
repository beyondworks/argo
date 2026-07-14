'use client';

import { useEffect, useRef } from 'react';
import Image from 'next/image';
import { useGSAP } from '@gsap/react';
import { gsap } from '@/lib/gsap';
import { useLang } from '@/lib/i18n';
import ChartGrid from '@/components/ChartGrid';
import Accent from '@/components/Accent';
import ScrollSequence from '@/components/ScrollSequence';

// 표지 → '한 줄' 점화 → 콜라주 조립 히어로 (아르고 고유 연출)
// 0      표지: 항해 성도 그리드 + 프레임 + Set S*ai*l
// 5–26%  타이틀 퇴장
// 28–42% 황금빛 '한 줄'(프롬프트 라인)이 어둠에 그어진다
// 34–62% 그 선 아래에서 배가 떠오르고 구름·크루·파도가 사방에서 조립
// 52–76% 라인에서 별자리 선이 뻗어나가 장면을 하나로 연결
// 84–100% 카메라 푸시 → 챕터로
// 하늘·크루 레이어 — 배+파도는 구도가 절대 분리되지 않도록 sea-group(단일 좌표계)으로 별도 렌더
const LAYERS = [
  { key: 'cloudL', cls: 'l-cloud-left', src: '/assets/art/layer-cloud-left.webp', w: 1536, h: 1024 },
  { key: 'cloudR', cls: 'l-cloud-right', src: '/assets/art/layer-cloud-right.webp', w: 1536, h: 1024 },
  { key: 'figL', cls: 'l-figure-left', src: '/assets/art/layer-figure-left.webp', w: 1024, h: 1536 },
  { key: 'figR', cls: 'l-figure-right', src: '/assets/art/layer-figure-right.webp', w: 1024, h: 1536 },
];

export default function Hero() {
  const { t } = useLang();
  const sectionRef = useRef(null);
  const gridRef = useRef(null);
  const frameRef = useRef(null);
  const copyRef = useRef(null);
  const cueRef = useRef(null);
  const collageRef = useRef(null);
  const layerRefs = useRef({});
  const videoRef = useRef(null);
  const progressRef = useRef(0);

  // 앰비언트 루프 자동재생 — 차단 시 첫 제스처에서 재시도
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return undefined;
    const tryPlay = () => v.play().catch(() => {});
    tryPlay();
    window.addEventListener('pointerdown', tryPlay, { once: true });
    window.addEventListener('wheel', tryPlay, { once: true, passive: true });
    return () => {
      window.removeEventListener('pointerdown', tryPlay);
      window.removeEventListener('wheel', tryPlay);
    };
  }, []);

  useGSAP(
    () => {
      const mm = gsap.matchMedia();

      mm.add('(prefers-reduced-motion: no-preference)', () => {
        const L = layerRefs.current;

        gsap.set(L.sea, { xPercent: -50 });

        const tl = gsap.timeline({
          defaults: { ease: 'none' },
          scrollTrigger: {
            trigger: sectionRef.current,
            start: 'top top',
            end: '+=280%',
            pin: true,
            scrub: 0.6,
            anticipatePin: 1,
            onUpdate: (self) => {
              progressRef.current = self.progress;
            },
          },
        });

        tl.to(cueRef.current, { opacity: 0, duration: 0.06 }, 0)
          .to(copyRef.current, { yPercent: -22, opacity: 0, ease: 'power1.in', duration: 0.21 }, 0.05)

          // 조립 — 바다(배+파도 단일 그룹)가 한 몸으로 떠오른다
          .fromTo(L.sea, { yPercent: 24, opacity: 0, scale: 0.97 },
            { yPercent: 0, opacity: 1, scale: 1, ease: 'power1.out', duration: 0.34 }, 0.3)
          // 하늘·크루가 사방에서 모인다
          .fromTo(L.cloudL, { xPercent: -26, yPercent: -10, opacity: 0 },
            { xPercent: 0, yPercent: 0, opacity: 1, ease: 'power1.out', duration: 0.26 }, 0.36)
          .fromTo(L.cloudR, { xPercent: 26, yPercent: -12, opacity: 0 },
            { xPercent: 0, yPercent: 0, opacity: 1, ease: 'power1.out', duration: 0.26 }, 0.39)
          .fromTo(L.figL, { xPercent: -40, rotation: -7, opacity: 0 },
            { xPercent: 0, rotation: 0, opacity: 1, ease: 'power1.out', duration: 0.26 }, 0.42)
          .fromTo(L.figR, { xPercent: 40, rotation: 7, opacity: 0 },
            { xPercent: 0, rotation: 0, opacity: 1, ease: 'power1.out', duration: 0.26 }, 0.45)

          .to(gridRef.current, { opacity: 0.3, duration: 0.3 }, 0.34)

          // 프레임은 장면 위에 남는 액자
          .to(frameRef.current, { scale: 1.06, duration: 0.3 }, 0.4)

          // 홀드 드리프트 — 배가 파도에 잔잔히 실려 흔들린다
          .to(collageRef.current, { scale: 1.03, duration: 0.28 }, 0.58)

          // 카메라 푸시 → 퇴장 (전체가 한 덩어리로 물러난다)
          .to(collageRef.current, { scale: 1.07, opacity: 0, ease: 'power1.in', duration: 0.16 }, 0.86)
          .to([frameRef.current, gridRef.current], { opacity: 0, ease: 'power1.in', duration: 0.14 }, 0.88);
      });
    },
    { scope: sectionRef }
  );

  return (
    <section className="hero-section" ref={sectionRef}>
      <div className="hero-stage">
        <div ref={gridRef} style={{ position: 'absolute', inset: 0 }}>
          <ChartGrid className="hero-grid" />
        </div>

        <div className="collage" ref={collageRef}>
          {LAYERS.map((layer) => (
            <div
              key={layer.key}
              className={`layer ${layer.cls}`}
              ref={(el) => {
                layerRefs.current[layer.key] = el;
              }}
            >
              <Image
                src={layer.src}
                alt=""
                width={layer.w}
                height={layer.h}
                sizes="(max-width: 860px) 100vw, 60vw"
                style={{ width: '100%', height: 'auto' }}
              />
            </div>
          ))}

          {/* 바다 그룹 — 배는 파도 좌표계 안에 고정되어 어떤 화면비에서도 분리되지 않는다 */}
          <div
            className="layer sea-group"
            ref={(el) => {
              layerRefs.current.sea = el;
            }}
          >
            <div className="l-ship">
              <Image
                src="/assets/art/layer-ship.webp"
                alt=""
                width={1536}
                height={1024}
                sizes="(max-width: 860px) 78vw, 46vw"
                priority
                style={{ width: '100%', height: 'auto' }}
              />
              {/* Kling 앰비언트 루프 — reduced-motion에선 CSS로 숨겨 정지 이미지 폴백 */}
              <video
                ref={videoRef}
                className="layer-video"
                src="/assets/art/ship-loop.webm"
                autoPlay
                muted
                loop
                playsInline
                // 재생 전 검은 프레임이 정지 이미지를 가리지 않도록, 실제 재생 시작 후에만 노출
                onPlaying={(e) => e.currentTarget.classList.add('is-playing')}
              />
            </div>
            <Image
              className="l-wave-img"
              src="/assets/art/layer-wave.webp"
              alt=""
              width={1877}
              height={838}
              sizes="120vw"
              style={{ width: '100%', height: 'auto' }}
            />
          </div>

          {/* Phase 2: Kling→ffmpeg 프레임 시퀀스 manifest 연결 시 스크러빙 */}
          <ScrollSequence manifest={null} progressRef={progressRef} className="hero-canvas" />
        </div>

        <div className="cover-frame" ref={frameRef}>
          <div className="cover-copy" ref={copyRef}>
            <span className="mono-label mono-dim">{t('hero.kicker')}</span>
            <h1 className="cover-display">
              <Accent text={t('hero.cover')} />
            </h1>
            <p className="cover-statement">
              <Accent text={t('hero.statement')} />
            </p>
          </div>
        </div>

        <div className="hero-scrollcue" ref={cueRef}>
          <span className="mono-label" style={{ fontSize: 10, color: 'inherit' }}>
            {t('hero.scroll')}
          </span>
          <span className="arrows" aria-hidden>
            ↓
          </span>
        </div>
      </div>
    </section>
  );
}
