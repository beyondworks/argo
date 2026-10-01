'use client';

import Link from 'next/link';
import { useEffect } from 'react';
import { useLang } from '@/lib/i18n';
import { PRODUCTS } from '@/lib/products';
import BrandMark from '@/components/BrandMark';
import Icon from '@/components/family/Icon';

const TONE = { argo: 'gold', messenger: 'signal', office: 'pencil' };

/** 스크롤로 들어오는 .rise 요소에 한 번만 .in을 붙인다(패밀리 페이지 공용). */
export function useRise() {
  useEffect(() => {
    const els = [...document.querySelectorAll('.rise:not(.in)')];
    const io = new IntersectionObserver(
      (entries) => entries.forEach((e) => {
        if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
      }),
      { rootMargin: '0px 0px -12% 0px' }
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);
}

// 페이지 끝 "패밀리" — 세 제품이 서로 어떻게 이어지는지(지금 페이지는 표시만, 나머지 둘은 이동).
export default function FamilyCards({ here }) {
  const { t } = useLang();
  return (
    <section className="fam-section" id="family">
      <div className="fam-head">
        <span className="mono-label">{t('family.kicker')}</span>
        <span className="mono-label mono-dim">ARGO · MESSENGER · OFFICE</span>
      </div>
      <h2 className="fam-title rise" style={{ marginBottom: 'clamp(28px, 5svh, 56px)' }}>{t('family.title')}</h2>
      <div className="family-grid">
        {PRODUCTS.map((p, i) => {
          const inner = (
            <>
              {/* 입체 그림 — 오피스 히어로와 같은 종이 디오라마 세계(블렌더) */}
              <img className="fc-art" src={`/assets/office-art/${p.id}.webp`} alt="" loading="lazy" />
              <div className="fc-top">
                <span className="fc-name">{p.name}</span>
                <BrandMark tone={TONE[p.id]} size={22} />
              </div>
              <p className="fc-body">{t(`family.${p.id}`)}</p>
              <span className="fc-link">{p.id === here ? t('family.here') : <>{t('family.go')}<Icon name="arrow" size={13} /></>}</span>
            </>
          );
          return p.id === here ? (
            <div key={p.id} className="family-card here rise" style={{ '--d': `${i * 60}ms` }}>{inner}</div>
          ) : (
            <Link key={p.id} href={p.href} className="family-card rise" style={{ '--d': `${i * 60}ms` }}>{inner}</Link>
          );
        })}
      </div>
    </section>
  );
}
