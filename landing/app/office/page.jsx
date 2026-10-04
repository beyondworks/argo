'use client';

import { useState } from 'react';
import Nav from '@/components/Nav';
import Footer from '@/components/Footer';
import Accent from '@/components/Accent';
import { CardGrid } from '@/components/family/Convert';
import { FeatureBento } from '@/components/family/OfficeScenes';
import OfficeTry from '@/components/family/OfficeTry';
import HeroFilm from '@/components/family/HeroFilm';
import FamilyCards, { useRise } from '@/components/family/FamilyCards';
import { useLang } from '@/lib/i18n';

const TO = 'lean8kim@gmail.com';
// "세 가지" 칸 그림(블렌더, 히어로와 같은 종이 사무실 세계)
const ART = { data: '/assets/office-art/data.webp', ai: '/assets/office-art/ai.webp', team: '/assets/office-art/team.webp' };

export default function OfficePage() {
  const { t, lang } = useLang();
  useRise();
  const [email, setEmail] = useState('');

  const join = (e) => {
    e.preventDefault();
    const subject = encodeURIComponent(t('office.wait.subject'));
    const body = encodeURIComponent(`${t('office.wait.bodyline')}\n${email}`);
    window.location.href = `mailto:${TO}?subject=${subject}&body=${body}`;
  };

  return (
    <main className="fam-page p-office">
      <Nav />

      <section className="m-hero center o-hero-center">
        <div className="m-kicker">
          <span className="mono-label">Argo Office</span>
          <span className="mono-label mono-dim">{t('office.kicker')}</span>
        </div>
        <h1 className="m-display">
          <Accent text={t('office.title')} />
        </h1>
        <p className="fam-lede">{t('office.lede')}</p>
        <div className="m-actions">
          <a className="fam-btn primary" href="#waitlist">{t('office.nav.cta')}</a>
          <a className="fam-btn" href="#try">{t('office.cta.look')}</a>
        </div>
        {/* 히어로 필름(블렌더) — 흩어진 앱 창 다섯 개가 오피스 한 화면의 칸으로 모인다 */}
        <HeroFilm lang={lang} base="office-hero" className="o-hero-film" />
      </section>

      <CardGrid ns="office" part="pillar" ids={['data', 'ai', 'team']} id="pillars" art={ART} />

      {/* 직접 체험 — 실제 오피스 앱(예시 데이터)을 창으로(유건 10/1: 직무판 연출 대신 실제 화면을 직접 만져 보게) */}
      <section className="fam-section" id="try">
        <div className="fam-head">
          <span className="mono-label">{t('office.try.kicker')}</span>
          <span className="mono-label mono-dim">PWA · macOS</span>
        </div>
        <div className="sec-intro">
          <h2 className="fam-title rise">{t('office.try.title')}</h2>
          <p className="fam-lede rise" style={{ '--d': '60ms' }}>{t('office.try.lede')}</p>
        </div>
        <OfficeTry />
      </section>

      <section className="fam-section" id="features">
        <div className="fam-head">
          <span className="mono-label">{t('office.feat.kicker')}</span>
        </div>
        <div className="sec-intro">
          <h2 className="fam-title rise">{t('office.feat.title')}</h2>
        </div>
        <FeatureBento />
      </section>

      <FamilyCards here="office" />

      <section className="fam-section o-wait" id="waitlist">
        <div className="fam-head">
          <span className="mono-label">{t('office.wait.kicker')}</span>
          <span className="mono-label mono-dim">{t('office.kicker')}</span>
        </div>
        <img className="o-wait-art rise" src="/assets/office-art/wait.webp" alt="" loading="lazy" />
        <h2 className="m-get-title rise">
          <Accent text={t('office.wait.title')} />
        </h2>
        <p className="fam-lede rise" style={{ '--d': '60ms' }}>{t('office.wait.sub')}</p>
        <form className="o-wait-form rise" style={{ '--d': '120ms' }} onSubmit={join}>
          <label className="o-wait-field">
            <span className="sr-only">{t('contact.f.email')}</span>
            <input
              type="email"
              required
              autoComplete="email"
              placeholder="you@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <button type="submit" className="fam-btn primary">{t('office.nav.cta')}</button>
        </form>
        <span className="download-note">{t('office.wait.note')}</span>
      </section>

      <Footer />
    </main>
  );
}
