'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ScrollTrigger, prefersReducedMotion } from '@/lib/gsap';
import { useLang } from '@/lib/i18n';
import CrewFace from '@/components/family/CrewFace';
import ScrollSequence from '@/components/ScrollSequence';
import { FACES } from '@/components/family/MsgrScenes';

// 장면 1 "Your agent talks to theirs" — 블렌더로 렌더한 폰 두 대(180프레임)를 스크롤 진행률에 맞춰 넘긴다(되감기 가능).
// 서연 폰 가까이 → 두 폰 → 주노의 @아틀라스 줄이 튀어나와 도윤 폰으로 → 아틀라스의 답 → 도윤이 끼어듦.
// 왼쪽 세 줄은 그 박자(프레임 74·128·148)에 맞춰 밝아진다. 움직임을 줄인 환경에선 마지막 프레임 한 장.
const FRAMES = 180;
const LIT = [74, 128, 148].map((f) => f / FRAMES);

// 제목 속 {juno}·{atlas} 자리에 얼굴을 넣는다(문장 안의 인라인 얼굴)
function FaceTitle({ text }) {
  return text.split(/(\{juno\}|\{atlas\})/).map((part, i) => {
    const m = part.match(/^\{(juno|atlas)\}$/);
    if (!m) return <span key={i}>{part}</span>;
    return <span key={i} className="talk-face"><CrewFace id={`title-${m[1]}`} pick={FACES[m[1]]} size={48} /></span>;
  });
}

export default function AgentTalk() {
  const { t, lang } = useLang();
  const root = useRef(null);
  const progress = useRef(0);
  const [lit, setLit] = useState(0);
  const [still, setStill] = useState(false);
  // 언어가 바뀔 때만 새로 만든다 — 렌더마다 새 객체면 재생기가 받은 프레임을 버리고 처음부터 다시 받는다(첫 프레임이 끼어 보임)
  const manifest = useMemo(() => ({ basePath: `/assets/talk-${lang}`, count: FRAMES, ext: 'webp', pad: 4 }), [lang]);

  useEffect(() => {
    if (prefersReducedMotion()) { progress.current = 1; setLit(3); setStill(true); return undefined; }
    const el = root.current;
    const st = ScrollTrigger.create({
      trigger: el,
      start: () => `top top+=${parseFloat(getComputedStyle(el).getPropertyValue('--nav-h')) || 58}`, // 고정 내비 아래에서 멈춘다
      end: '+=300%',
      pin: el.querySelector('.talk-pin'),
      onUpdate: (self) => {
        progress.current = self.progress;
        setLit(LIT.filter((p) => self.progress >= p).length);
      },
    });
    return () => st.kill();
  }, [lang]);

  return (
    <section className={`talk${still ? ' still' : ''}`} ref={root} aria-label={t('msgr.talk.kicker')}>
      <div className="talk-pin">
        <div className="talk-copy">
          <span className="mono-label">{t('msgr.talk.kicker')}</span>
          <h2 className="fam-title talk-title"><FaceTitle text={t('msgr.talk.title')} /></h2>
          <ol className="talk-steps">
            {[1, 2, 3].map((n) => <li key={n} className={n <= lit ? 'on' : ''}>{t(`msgr.talk.s${n}`)}</li>)}
          </ol>
        </div>
        <div className="talk-stage" aria-hidden="true">
          <ScrollSequence key={lang} manifest={manifest} progressRef={progress} className="talk-canvas" />
        </div>
      </div>
    </section>
  );
}
