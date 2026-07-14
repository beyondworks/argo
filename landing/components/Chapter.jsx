'use client';

import { useRef } from 'react';
import Image from 'next/image';
import { useGSAP } from '@gsap/react';
import { gsap } from '@/lib/gsap';
import { useLang } from '@/lib/i18n';
import { TOTAL_FEATURES } from '@/lib/chapters';
import FeatureBlock from '@/components/FeatureBlock';

// 범용 핀 씬 — 마스터 타임라인 1개, [인트로 1슬라이스 + 기능 n슬라이스].
// 각 슬라이스: enter 22% / hold 58% / exit 20%.
export default function Chapter({ chapter, orderOffset }) {
  const { t } = useLang();
  const stageRef = useRef(null);
  const introRef = useRef(null);
  const numeralRef = useRef(null);
  const vignetteRef = useRef(null);
  const railRef = useRef(null);
  const featureRefs = useRef([]);

  const units = chapter.features.length + 1;

  useGSAP(
    () => {
      const mm = gsap.matchMedia();

      mm.add('(prefers-reduced-motion: no-preference)', () => {
        const features = featureRefs.current.filter(Boolean);
        gsap.set(features, { opacity: 0 });

        const tl = gsap.timeline({
          defaults: { ease: 'none' },
          scrollTrigger: {
            trigger: stageRef.current,
            start: 'top top',
            end: `+=${units * 90}%`,
            pin: true,
            scrub: 0.6,
            anticipatePin: 1,
            onUpdate: (self) => {
              // 진행 레일 — 활성 기능 틱 표시
              const slot = Math.floor(self.progress * units) - 1;
              railRef.current?.querySelectorAll('.tick').forEach((el, i) => {
                el.classList.toggle('on', i === slot);
              });
            },
          },
        });

        // 배경 숫자 — 챕터 전체에 걸쳐 느리게 부유
        tl.fromTo(
          numeralRef.current,
          { opacity: 0, scale: 0.97 },
          { opacity: 1, scale: 1.05, duration: units },
          0
        );

        // 비네트 도판 — 인트로에서 떠올랐다가 기능 구간에선 배경으로 물러난다
        if (vignetteRef.current) {
          gsap.set(vignetteRef.current, { xPercent: -50, yPercent: -50 });
          tl.fromTo(
            vignetteRef.current,
            { opacity: 0, scale: 1.05, yPercent: -46 },
            { opacity: 0.9, scale: 1, yPercent: -50, ease: 'power1.out', duration: 0.5 },
            0.08
          )
            .to(vignetteRef.current, { yPercent: -54, duration: units - 1, ease: 'none' }, 0.6)
            .to(vignetteRef.current, { opacity: 0.13, duration: 0.3 }, 0.82);
        }

        // 인트로 슬라이스
        tl.fromTo(
          introRef.current,
          { opacity: 0, y: 46 },
          { opacity: 1, y: 0, duration: 0.24, ease: 'power2.out' },
          0.04
        ).to(introRef.current, { opacity: 0, y: -30, duration: 0.2, ease: 'power1.in' }, 0.78);

        // 기능 슬라이스
        features.forEach((el, i) => {
          const at = i + 1;
          const media = el.querySelector('.feature-media');
          tl.addLabel(`feat${i}`, at)
            .fromTo(
              el,
              { opacity: 0, yPercent: 9 },
              { opacity: 1, yPercent: 0, duration: 0.22, ease: 'power2.out' },
              at
            )
            .fromTo(
              media,
              { scale: 1.05, yPercent: 3 },
              { scale: 1, yPercent: 0, duration: 0.26, ease: 'power2.out' },
              at
            )
            .to(media, { yPercent: -2, duration: 0.52 }, at + 0.28)
            .to(el, { opacity: 0, yPercent: -7, duration: 0.2, ease: 'power1.in' }, at + 0.8);
        });
      });
    },
    { scope: stageRef, dependencies: [units] }
  );

  return (
    <section className="chapter" id={chapter.id}>
      <div className="chapter-stage" ref={stageRef}>
        <div className="chapter-bg" />
        <div className="chapter-numeral" ref={numeralRef} aria-hidden>
          {chapter.numeral}
        </div>
        {chapter.vignette && (
          <div className="chapter-vignette" ref={vignetteRef} aria-hidden>
            <Image
              src={chapter.vignette}
              alt=""
              width={1536}
              height={1024}
              sizes="(max-width: 860px) 92vw, 54vw"
              style={{ width: '100%', height: 'auto' }}
            />
          </div>
        )}

        <div className="chapter-intro" ref={introRef}>
          <div className="rule-top" />
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <span className="mono-label">{t(`${chapter.id}.num`)}</span>
            <span className="mono-label mono-dim">{chapter.features.length} / {TOTAL_FEATURES}</span>
          </div>
          <h2 className="chapter-title">{t(`${chapter.id}.short`)}</h2>
          <p className="chapter-sub">{t(`${chapter.id}.sub`)}</p>
          <p className="chapter-tagline">{t(`${chapter.id}.tagline`)}</p>
        </div>

        {chapter.features.map((feature, i) => (
          <FeatureBlock
            key={feature.id}
            feature={feature}
            chapterId={chapter.id}
            order={orderOffset + i + 1}
            mirror={(orderOffset + i) % 2 === 1}
            ref={(el) => {
              featureRefs.current[i] = el;
            }}
          />
        ))}

        <div className="chapter-rail" ref={railRef} aria-hidden>
          {chapter.features.map((f) => (
            <span key={f.id} className="tick" />
          ))}
        </div>
      </div>
    </section>
  );
}
