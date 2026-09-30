'use client';

import { useState } from 'react';
import Nav from '@/components/Nav';
import Footer from '@/components/Footer';
import Accent from '@/components/Accent';
import Icon from '@/components/family/Icon';
import FilmLoop from '@/components/family/FilmLoop';
import { CardGrid } from '@/components/family/Convert';
import ProblemScroll from '@/components/family/ProblemScroll';
import { MergedDesk, RoleBoard, CrewDraft } from '@/components/family/OfficeScenes';
import FamilyCards, { useRise } from '@/components/family/FamilyCards';
import { useLang } from '@/lib/i18n';

const TO = 'lean8kim@gmail.com';
// 티저 영상 — 언어별 파일(에셋 검사가 볼 수 있게 경로를 고정 문자열로 둔다)
const FILM = {
  ko: { src: '/assets/office-film-ko.mp4', poster: '/assets/office-film-ko.jpg' },
  en: { src: '/assets/office-film-en.mp4', poster: '/assets/office-film-en.jpg' },
};

// 메일 · 문서 · 메신저 · 번역기 창이 흩어져 있다 → 스크롤하면 오피스 한 화면으로 모인다. [x, y, 기울기] → [x, y]
const PROB_WINDOWS = [
  { id: 'a', lines: 2, from: [-170, -135, -4], to: [0, -40] },
  { id: 'b', lines: 2, from: [165, -95, 3], to: [0, -14] },
  { id: 'c', lines: 2, from: [-150, 110, 2], to: [0, 14] },
  { id: 'd', lines: 2, from: [175, 140, -3], to: [0, 40] },
];
const TRAITS = ['save', 'history', 'command'];
const AX_POINTS = ['p1', 'p2', 'p3'];

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
          <a className="fam-btn" href="#roles">{t('office.cta.look')}</a>
        </div>
        <span className="mono-label mono-dim m-platforms">{t('office.trust')}</span>
      </section>

      {/* 티저 영상 — 모듈 조립·직무별 화면·크루 결재를 30초에 */}
      <section className="m-film" aria-label={t('office.demo.label')}>
        <FilmLoop key={lang} {...FILM[lang]} />
      </section>

      <CardGrid ns="office" part="pillar" ids={['data', 'ai', 'team']} id="pillars" />

      <ProblemScroll ns="office" windows={PROB_WINDOWS}>
        <MergedDesk />
      </ProblemScroll>

      <section className="fam-section" id="roles">
        <div className="fam-head">
          <span className="mono-label">{t('office.role.kicker')}</span>
          <span className="mono-label mono-dim">PWA · macOS</span>
        </div>
        <div className="sec-intro">
          <h2 className="fam-title rise">{t('office.role.title')}</h2>
          <p className="fam-lede rise" style={{ '--d': '60ms' }}>{t('office.role.lede')}</p>
        </div>
        <RoleBoard />
      </section>

      <section className="fam-section" id="ax">
        <div className="fam-head">
          <span className="mono-label">{t('office.ax.kicker')}</span>
          <span className="mono-label mono-dim">Office × Messenger</span>
        </div>
        <div className="o-ax">
          <div className="o-ax-copy">
            <h2 className="fam-title rise"><Accent text={t('office.ax.title')} /></h2>
            <p className="fam-lede rise" style={{ '--d': '60ms' }}>{t('office.ax.lede')}</p>
            <ul className="o-ax-points">
              {AX_POINTS.map((k, i) => (
                <li key={k} className="rise" style={{ '--d': `${120 + i * 60}ms` }}>
                  <Icon name="check" size={14} />
                  <span>{t(`office.ax.${k}`)}</span>
                </li>
              ))}
            </ul>
          </div>
          <CrewDraft />
        </div>
        <ul className="o-traits">
          {TRAITS.map((k, i) => (
            <li key={k} className="rise" style={{ '--d': `${i * 60}ms` }}>
              <b>{t(`office.trait.${k}.t`)}</b>
              <span>{t(`office.trait.${k}.b`)}</span>
            </li>
          ))}
        </ul>
      </section>

      <FamilyCards here="office" />

      <section className="fam-section o-wait" id="waitlist">
        <div className="fam-head">
          <span className="mono-label">{t('office.wait.kicker')}</span>
          <span className="mono-label mono-dim">{t('office.kicker')}</span>
        </div>
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
