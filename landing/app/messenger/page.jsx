'use client';

import { useState } from 'react';
import Nav from '@/components/Nav';
import Footer from '@/components/Footer';
import Accent from '@/components/Accent';
import CrewFace from '@/components/family/CrewFace';
import AgentTalk from '@/components/family/AgentTalk';
import StageTabs from '@/components/family/StageTabs';
import TabFilm from '@/components/family/TabFilm';
import FamilyCards, { useRise } from '@/components/family/FamilyCards';
import { CardGrid, Faq } from '@/components/family/Convert';
import HeroFilm from '@/components/family/HeroFilm';
import { useLang } from '@/lib/i18n';

const TO = 'lean8kim@gmail.com'; // 요금 문의 메일(Pro·Enterprise)
// 크루 얼굴 띠 — 마우스를 올린 얼굴은 놀란다(앱의 멘션 반응과 같은 표정).
const CROWD = [[0, 2, 0], [1, 3, 1], [2, 4, 2], [3, 7, 0], [4, 1, 2], [5, 5, 1], [2, 0, 0], [0, 8, 2], [4, 6, 1], [1, 9, 0]];

function Crowd({ t }) {
  const [hover, setHover] = useState(-1);
  return (
    <div className="m-crowd-faces" onPointerLeave={() => setHover(-1)}>
      {CROWD.map(([shape, color, eyes], i) => (
        <span key={i} className="m-crowd-face" onPointerEnter={() => setHover(i)}>
          <CrewFace id={`crowd-${i}`} pick={{ shape, color, eyes }} state={hover === i ? 'surprise' : 'idle'} size={40} />
        </span>
      ))}
      <span className="sr-only">{t('msgr.crowd')}</span>
    </div>
  );
}

export default function MessengerPage() {
  const { t, lang } = useLang();
  useRise();
  const [email, setEmail] = useState('');
  // 출시 알림 신청 — 오피스 대기자 신청과 같은 모양(메일 앱으로, 서버 저장 없음)
  const join = (e) => {
    e.preventDefault();
    const subject = encodeURIComponent(t('msgr.wait.subject'));
    const body = encodeURIComponent(`${t('msgr.wait.bodyline')}\n${email}`);
    window.location.href = `mailto:${TO}?subject=${subject}&body=${body}`;
  };
  const joinItems = ['crew', 'hermes', 'vps'].map((id) => ({ id, title: t(`msgr.join.${id}.t`), body: t(`msgr.join.${id}.b`) }));
  const howItems = ['talk', 'handoff', 'approve', 'memory'].map((id) => ({ id, title: t(`msgr.how.${id}.t`), body: t(`msgr.how.${id}.b`) }));

  return (
    <main className="fam-page p-messenger">
      <Nav />

      {/* 히어로 — 블렌더 필름이 배경 전체, 표제·버튼은 필름이 비워 둔 왼쪽 자리에 HTML로(선명·두 언어) */}
      <section className="m-hero hero-3d">
        <div className="m-hero-copy">
          <div className="m-kicker">
            <span className="mono-label">Argo Messenger</span>
            <span className="mono-label mono-dim">{t('msgr.kicker')}</span>
          </div>
          <h1 className="m-display">
            <Accent text={t('msgr.title')} />
          </h1>
          <p className="fam-lede">{t('msgr.lede')}</p>
          <div className="m-actions">
            <a className="fam-btn primary" href="#waitlist">{t('msgr.nav.cta')}</a>
            <a className="fam-btn" href="#how">{t('msgr.cta.how')}</a>
          </div>
          <span className="mono-label mono-dim m-platforms">{t('msgr.trust')}</span>
        </div>
        <HeroFilm lang={lang} />
      </section>

      <AgentTalk />

      <CardGrid ns="msgr" part="for" ids={['1', '2', '3']} id="for" variant="row" />

      <section className="fam-section" id="join">
        <div className="fam-head">
          <span className="mono-label">{t('msgr.join.kicker')}</span>
          <span className="mono-label mono-dim">Argo · Hermes · OpenClaw · VPS</span>
        </div>
        <div className="sec-intro">
          <h2 className="fam-title rise">{t('msgr.join.title')}</h2>
          <p className="fam-lede rise" style={{ '--d': '60ms' }}>{t('msgr.join.lede')}</p>
        </div>
        <StageTabs items={joinItems} label={t('msgr.join.kicker')} renderStage={(id) => <TabFilm name={id} />} />
      </section>

      <section className="fam-section" id="how">
        <div className="fam-head">
          <span className="mono-label">{t('msgr.how.kicker')}</span>
          <span className="mono-label mono-dim">01 — 04</span>
        </div>
        <div className="sec-intro">
          <h2 className="fam-title rise">{t('msgr.how.title')}</h2>
          <p className="fam-lede rise" style={{ '--d': '60ms' }}>{t('msgr.how.lede')}</p>
        </div>
        <StageTabs items={howItems} label={t('msgr.how.kicker')} layout="flip" renderStage={(id) => <TabFilm name={id} />} />
      </section>

      <CardGrid ns="msgr" part="safe" ids={['1', '2', '3', '4']} id="safe" variant="split" />
      <CardGrid ns="msgr" part="start" ids={['1', '2', '3']} id="start" numbered meta="01 — 03" variant="steps" />
      {/* 요금(Free로 지금 시작) 절은 출시 예정 동안 뺀다(2026-10-16) — 다시 열 때 <Pricing ns="msgr" to={TO} freeHref="#waitlist" /> */}
      <Faq ns="msgr" count={5} split />

      <FamilyCards here="messenger" />

      <section className="fam-section m-get" id="waitlist">
        <div className="fam-head">
          <span className="mono-label">{t('msgr.wait.kicker')}</span>
          <span className="mono-label mono-dim">MAC · WIN · IOS · ANDROID</span>
        </div>
        <div className="m-crowd rise">
          <Crowd t={t} />
          <p className="mono-label mono-dim">{t('msgr.crowd')}</p>
        </div>
        <h2 className="m-get-title rise">
          <Accent text={t('msgr.wait.title')} />
        </h2>
        <p className="fam-lede rise" style={{ '--d': '60ms' }}>{t('msgr.wait.sub')}</p>
        <form className="o-wait-form rise" style={{ '--d': '120ms' }} onSubmit={join}>
          <label className="o-wait-field">
            <span className="sr-only">{t('contact.f.email')}</span>
            <input type="email" required autoComplete="email" placeholder="you@company.com" value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <button type="submit" className="fam-btn primary">{t('msgr.nav.cta')}</button>
        </form>
        <span className="download-note">{t('msgr.wait.note')}</span>
      </section>

      <Footer />
    </main>
  );
}
