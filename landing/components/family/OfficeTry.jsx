'use client';

import { useEffect, useRef, useState } from 'react';
import { useLang } from '@/lib/i18n';

// 직접 체험 — 실제 Argo Office 앱(체험 전용 배포: apps/office를 VITE_OFFICE_DEMO=1·서버 설정 없이 빌드, 예시 데이터)을 창으로 넣는다.
// 방문자가 모듈을 옮기고 크기·테마를 바꿔 본다. 열 때마다 처음 상태(체험판이 저장소를 비우고 시작). 서버·DB 호출 없음.
// 폰(760px 이하)은 앱을 불러오지 않고 정지 화면만 — 페이지 스크롤과 모듈 끌기가 부딪힌다(유건 10/1 승인).
export const OFFICE_DEMO = process.env.NEXT_PUBLIC_OFFICE_DEMO_URL || 'https://argo-office-demo.vercel.app';
// 앱은 1440px 화면으로 그린 뒤 창 폭에 맞춰 줄인다 — 좁게 그리면 앱이 좁은 배치(현황 카드 두 줄)로 바뀐다. 70% 아래로는 줄이지 않고 그리는 폭을 줄인다
const VIEW = 1440, MIN_SCALE = 0.7;
const STILL = { ko: '/assets/office-try-ko.webp', en: '/assets/office-try-en.webp' };

export default function OfficeTry() {
  const { t, lang } = useLang();
  const [wide, setWide] = useState(false);
  const [run, setRun] = useState(0); // 처음 배치로 = 창을 다시 불러온다
  const box = useRef(null);
  const [fit, setFit] = useState({ w: VIEW, s: 1 });
  useEffect(() => {
    if (!wide || !box.current) return;
    const ro = new ResizeObserver(([e]) => {
      const cw = e.contentRect.width, s = Math.max(MIN_SCALE, Math.min(1, cw / VIEW));
      setFit({ w: Math.round(cw / s), s });
    });
    ro.observe(box.current);
    return () => ro.disconnect();
  }, [wide]);
  useEffect(() => {
    const mq = matchMedia('(min-width: 761px)');
    const on = () => setWide(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);

  return (
    <div className="ot rise">
      <div className="ot-bar">
        <span className="lights" aria-hidden="true"><i /><i /><i /></span>
        <span className="ttl">{t('office.try.badge')}</span>
        {wide && <button type="button" className="ot-reset" onClick={() => setRun((n) => n + 1)}>{t('office.try.reset')}</button>}
      </div>
      {wide ? (
        <div className="ot-view" ref={box}>
          <iframe key={`${lang}-${run}`} className="ot-frame" src={`${OFFICE_DEMO}/o/beyondworks?lang=${lang}`} title={t('office.try.frame')} loading="lazy"
            style={{ width: fit.w, height: Math.round((fit.w * 10) / 16), transform: `scale(${fit.s})` }} />
        </div>
      ) : (
        <>
          <img className="ot-still" src={STILL[lang] ?? STILL.en} alt={t('office.try.frame')} loading="lazy" />
          <p className="ot-note">{t('office.try.phone')}</p>
        </>
      )}
    </div>
  );
}
