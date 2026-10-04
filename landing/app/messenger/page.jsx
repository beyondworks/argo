'use client';

import { useState } from 'react';
import Nav from '@/components/Nav';
import Footer from '@/components/Footer';
import Accent from '@/components/Accent';
import CrewFace from '@/components/family/CrewFace';
import Icon from '@/components/family/Icon';
import AgentTalk from '@/components/family/AgentTalk';
import StageTabs from '@/components/family/StageTabs';
import TabFilm from '@/components/family/TabFilm';
import FamilyCards, { useRise } from '@/components/family/FamilyCards';
import { CardGrid, Pricing, Faq } from '@/components/family/Convert';
import HeroFilm from '@/components/family/HeroFilm';
import { useLang } from '@/lib/i18n';
import { MSGR_DL, detectMacTarget } from '@/lib/downloads';

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
  const macDl = (e) => { e.preventDefault(); window.location.assign(MSGR_DL[detectMacTarget()]); };
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
            <a className="fam-btn primary" href="#get">{t('msgr.cta.get')}</a>
            <a className="fam-btn" href="#pricing">{t('msgr.cta.pricing')}</a>
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
      <Pricing ns="msgr" to={TO} freeHref="#get" />
      <Faq ns="msgr" count={5} split />

      <FamilyCards here="messenger" />

      <section className="fam-section m-get" id="get">
        <div className="fam-head">
          <span className="mono-label">{t('msgr.get.kicker')}</span>
          <span className="mono-label mono-dim">MAC · WIN · IOS · ANDROID</span>
        </div>
        <div className="m-crowd rise">
          <Crowd t={t} />
          <p className="mono-label mono-dim">{t('msgr.crowd')}</p>
        </div>
        <h2 className="m-get-title rise">
          <Accent text={t('msgr.get.title')} />
        </h2>
        <p className="fam-lede rise" style={{ '--d': '60ms' }}>{t('msgr.get.sub')}</p>
        <div className="m-actions rise" style={{ '--d': '120ms' }}>
          <a className="fam-btn primary" href={MSGR_DL.silicon} onClick={macDl}><Icon name="apple" size={15} />{t('download.mac')}</a>
          <a className="fam-btn" href={MSGR_DL.win}><Icon name="windows" size={13} />{t('download.win')}</a>
          <a className="fam-btn" href={MSGR_DL.ios} target="_blank" rel="noopener noreferrer"><Icon name="apple" size={15} />{t('msgr.get.ios')}<Icon name="external" size={13} /></a>
          <a className="fam-btn" href={MSGR_DL.android} target="_blank" rel="noopener noreferrer"><Icon name="android" size={15} />{t('msgr.get.android')}<Icon name="external" size={13} /></a>
        </div>
        <span className="download-note">
          {t('msgr.get.note')}
          {' · '}
          <a href={MSGR_DL.silicon}>Apple Silicon</a>
          {' / '}
          <a href={MSGR_DL.intel}>Intel Mac</a>
          {' / '}
          <a href={MSGR_DL.win}>Windows</a>
        </span>
      </section>

      <Footer />
    </main>
  );
}
